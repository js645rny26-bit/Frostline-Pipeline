/**
 * Module 11: Slate Board Computation & Output Extraction
 * Reads SLATE_INPUT for operator market lines, computes decisions against
 * GAME_SUMMARY projections, writes SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT,
 * then returns typed results for the API response.
 */

import { readRange, clearRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";

export interface SlateBoardEntry {
  legacy_game_id: string;
  away_team: string;
  home_team: string;
  vehicle_type: string;
  projected_total: number;
  market_line: number | null;
  variance: number | null;
  direction: "OVER" | "UNDER" | "NONE";
  /** Final truth label. CORE = authorized bet; NO_CORE = blocked; PENDING = no market line. */
  final_decision: "CORE" | "NO_CORE" | "PENDING";
  confidence: number;
  expected_roi: number;
  /** Edge-strength metadata — STRONG_BUY | BUY | LEAN. Not an authorization label. */
  edge_strength: string;
  /** Named reason a game did not authorize. Empty string for CORE or PENDING. */
  core_blocker: string;
}

export interface ActiveBoardEntry {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  vehicle: string;
  model_projection: number;
  market_line: number | null;
  edge: number;
  direction: "OVER" | "UNDER" | "NONE";
  confidence: number;
  /** Edge-strength metadata — STRONG_BUY | BUY | LEAN. */
  edge_strength: string;
}

export interface Module11Result {
  status: "success" | "failure";
  extraction_timestamp_utc: string;
  slate_board: SlateBoardEntry[];
  active_board_snapshot: ActiveBoardEntry[];
  core_count: number;
  no_core_count: number;
  error?: string;
}

// SLATE_INPUT column indices (0-based):
// A=0: Game_ID, B=1: Date, C=2: Matchup, D=3: Target, E=4: Opposing_Starter
// F–N = model fields (5–13), O=14: Candidate_Vehicle, P=15: Line, Q=16: Odds
// X=23: Market_Phase, Y=24: Authoritative_Pregame_Total
// Z=25: Authoritative_Over_Odds, AA=26: Authoritative_Under_Odds, AB=27: Pregame_Line_Locked_TS
const SLATE_INPUT_COLS = {
  GAME_ID:            0,
  CANDIDATE_VEHICLE:  14,
  LINE:               15,   // live market line (may shift during day)
  ODDS:               16,
  MARKET_PHASE:       23,
  AUTH_PREGAME_TOTAL: 24,   // frozen at game-time; prefer this when set
  AUTH_OVER_ODDS:     25,
  AUTH_UNDER_ODDS:    26,
};

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Provisional commissioning threshold. Replay historical slates to calibrate. */
const CORE_THRESHOLD = 1.5;

interface GameEligibilityContext {
  awayPitcherRole: string;
  homePitcherRole: string;
  awayExpectedInnings: number | null;
  homeExpectedInnings: number | null;
  bullpenAvailable: boolean;
}

function computeDecision(
  projectedTotal: number,
  marketLine: number | null,
  vehicle: string,
  gameCtx: GameEligibilityContext,
): {
  decision: "CORE" | "NO_CORE" | "PENDING";
  direction: "OVER" | "UNDER" | "NONE";
  edgeStrength: string;
  coreBlocker: string;
  confidence: number;
  roi: number;
} {
  // Gate 1 — no market line yet
  if (marketLine === null || !vehicle || vehicle === "TBD" || vehicle === "") {
    return { decision: "PENDING", direction: "NONE", edgeStrength: "", coreBlocker: "NO_MARKET_LINE", confidence: 0, roi: 0 };
  }

  const variance  = projectedTotal - marketLine;
  const absVar    = Math.abs(variance);
  const direction: "OVER" | "UNDER" | "NONE" =
    variance > 0 ? "OVER" : variance < 0 ? "UNDER" : "NONE";

  // Edge-strength metadata (magnitude only — not an authorization label)
  const edgeStrength =
    absVar >= 3.0 ? "STRONG_BUY" :
    absVar >= 2.0 ? "BUY" :
    absVar >= CORE_THRESHOLD ? "LEAN" : "";

  const confidence = absVar >= CORE_THRESHOLD
    ? parseFloat(Math.min(0.95, 0.55 + absVar * 0.08).toFixed(2))
    : parseFloat(Math.max(0.05, 0.45 - absVar * 0.05).toFixed(2));

  const roi = absVar >= CORE_THRESHOLD ? parseFloat((absVar * 0.05).toFixed(3)) : 0;

  // Eligibility gates — checked before separation threshold so a large-variance
  // game backed by incomplete inputs does not slip into CORE.
  if (gameCtx.awayPitcherRole === "UNRESOLVED" || gameCtx.homePitcherRole === "UNRESOLVED") {
    return { decision: "NO_CORE", direction, edgeStrength, coreBlocker: "UNRESOLVED_STARTER", confidence, roi: 0 };
  }
  if (!gameCtx.awayExpectedInnings || !gameCtx.homeExpectedInnings) {
    return { decision: "NO_CORE", direction, edgeStrength, coreBlocker: "MISSING_EXPECTED_INNINGS", confidence, roi: 0 };
  }
  if (!gameCtx.bullpenAvailable) {
    return { decision: "NO_CORE", direction, edgeStrength, coreBlocker: "BULLPEN_DATA_UNAVAILABLE", confidence, roi: 0 };
  }

  // Separation gate — provisional 1.5-run threshold
  if (absVar < CORE_THRESHOLD) {
    return { decision: "NO_CORE", direction, edgeStrength, coreBlocker: "INSUFFICIENT_PROJECTION_SEPARATION", confidence, roi: 0 };
  }

  return { decision: "CORE", direction, edgeStrength, coreBlocker: "", confidence, roi };
}

export async function extractOutputBoards(
  gameSummary: GameSummaryRow[],
  workbookId = WORKBOOK_ID,
): Promise<Module11Result> {
  logger.info({ games: gameSummary.length }, "MODULE_11: Computing SLATE_BOARD + ACTIVE_BOARD_SNAPSHOT");

  const output: Module11Result = {
    status: "success",
    extraction_timestamp_utc: new Date().toISOString(),
    slate_board: [],
    active_board_snapshot: [],
    core_count: 0,
    no_core_count: 0,
  };

  try {
    // ── Read SLATE_INPUT for operator-provided market lines ──
    // Range extends to AB to cover the pregame lock fields (cols X–AB = 23–27)
    const slateInputData = await readRange(workbookId, "SLATE_INPUT!A:AB");
    const slateInputRows = (slateInputData.values ?? []).slice(1); // skip header row

    const marketMap = new Map<string, { vehicle: string; line: number | null; odds: number | null; phase: string }>();
    for (const row of slateInputRows) {
      const gameId = parseStr(row[SLATE_INPUT_COLS.GAME_ID]);
      if (!gameId) continue;

      // Prefer Authoritative_Pregame_Total (frozen at game-time) over the live
      // Line (which may have moved after the operator's board-final publish).
      // Falls back to Line when Auth is not yet set (PREGAME phase).
      const authTotal = parseNum(row[SLATE_INPUT_COLS.AUTH_PREGAME_TOTAL]);
      const liveTotal = parseNum(row[SLATE_INPUT_COLS.LINE]);
      const authOverOdds = parseNum(row[SLATE_INPUT_COLS.AUTH_OVER_ODDS]);

      marketMap.set(gameId, {
        vehicle: parseStr(row[SLATE_INPUT_COLS.CANDIDATE_VEHICLE]),
        line:    authTotal ?? liveTotal,
        odds:    authOverOdds ?? parseNum(row[SLATE_INPUT_COLS.ODDS]),
        phase:   parseStr(row[SLATE_INPUT_COLS.MARKET_PHASE]) || "PREGAME",
      });
    }

    // ── Compute SLATE_BOARD — 15 cols A–O, starts row 2 ──
    const sbRows: unknown[][] = [];

    for (const gs of gameSummary) {
      const market  = marketMap.get(gs.game_id) ?? { vehicle: "", line: null, odds: null };
      const variance = market.line !== null
        ? parseFloat((gs.projected_total_runs - market.line).toFixed(2))
        : null;

      const gameCtx: GameEligibilityContext = {
        awayPitcherRole:      gs.away_pitcher_role,
        homePitcherRole:      gs.home_pitcher_role,
        awayExpectedInnings:  gs.away_expected_innings,
        homeExpectedInnings:  gs.home_expected_innings,
        bullpenAvailable:     gs.bullpen_available,
      };
      const { decision, direction, edgeStrength, coreBlocker, confidence, roi } = computeDecision(
        gs.projected_total_runs,
        market.line,
        market.vehicle,
        gameCtx,
      );

      const entry: SlateBoardEntry = {
        legacy_game_id:  gs.game_id,
        away_team:       gs.away_team,
        home_team:       gs.home_team,
        vehicle_type:    market.vehicle || "TBD",
        projected_total: gs.projected_total_runs,
        market_line:     market.line,
        variance,
        direction,
        final_decision:  decision,
        confidence,
        expected_roi:    roi,
        edge_strength:   edgeStrength,
        core_blocker:    coreBlocker,
      };
      output.slate_board.push(entry);
      if (decision === "CORE")    output.core_count++;
      if (decision === "NO_CORE") output.no_core_count++;

      sbRows.push([
        gs.date,                         // A: Date
        gs.game_id,                      // B: Game_ID
        gs.away_team,                    // C: Away_Team
        gs.home_team,                    // D: Home_Team
        market.vehicle || "TBD",         // E: Vehicle_Type
        gs.projected_total_runs,         // F: Projected_Value
        market.line ?? "",               // G: Market_Line
        variance ?? "",                  // H: Variance_from_Projection (Model − Market)
        direction,                       // I: Direction (OVER | UNDER | NONE)
        decision,                        // J: Decision (CORE | NO_CORE | PENDING)
        confidence,                      // K: Confidence
        roi,                             // L: Expected_ROI (always positive)
        edgeStrength,                    // M: Edge_Strength (STRONG_BUY | BUY | LEAN — metadata, not auth)
        coreBlocker,                     // N: CORE_Blocker (named reason; empty for CORE)
        "",                              // O: Notes
      ]);
    }

    await clearRange(workbookId, "SLATE_BOARD!A2:O100");
    if (sbRows.length > 0) {
      await writeRange(workbookId, `SLATE_BOARD!A2:O${1 + sbRows.length}`, sbRows);
    }
    logger.info(
      { rows: sbRows.length, core: output.core_count, noCore: output.no_core_count },
      "MODULE_11: SLATE_BOARD written",
    );

    // ── Compute ACTIVE_BOARD_SNAPSHOT — CORE games only, 16 cols A–P ──
    const abRows: unknown[][] = [];
    const now = new Date().toISOString();

    for (const entry of output.slate_board) {
      if (entry.final_decision !== "CORE") continue;
      const edge = entry.variance !== null ? parseFloat(Math.abs(entry.variance).toFixed(2)) : 0;

      const abEntry: ActiveBoardEntry = {
        date:             gameSummary.find((g) => g.game_id === entry.legacy_game_id)?.date ?? "",
        game_id:          entry.legacy_game_id,
        away_team:        entry.away_team,
        home_team:        entry.home_team,
        vehicle:          entry.vehicle_type,
        model_projection: entry.projected_total,
        market_line:      entry.market_line,
        edge,
        direction:        entry.direction,
        confidence:       entry.confidence,
        edge_strength:    entry.edge_strength,
      };
      output.active_board_snapshot.push(abEntry);

      abRows.push([
        abEntry.date,                    // A: Date
        abEntry.game_id,                 // B: Game_ID
        abEntry.away_team,               // C: Away_Team
        abEntry.home_team,               // D: Home_Team
        abEntry.vehicle,                 // E: Vehicle
        abEntry.model_projection,        // F: Model_Projection
        abEntry.market_line ?? "",       // G: Market_Line
        edge,                            // H: Edge (absolute value; always positive)
        entry.direction,                 // I: Direction (OVER | UNDER | NONE)
        abEntry.confidence,              // J: Confidence
        entry.edge_strength,             // K: Edge_Strength (STRONG_BUY | BUY | LEAN — metadata)
        now,                             // L: Time_Added
        "PENDING",                       // M: Status
        "",                              // N: Placed_At
        "",                              // O: Result
        "",                              // P: Notes
      ]);
    }

    await clearRange(workbookId, "ACTIVE_BOARD_SNAPSHOT!A2:P100");
    if (abRows.length > 0) {
      await writeRange(workbookId, `ACTIVE_BOARD_SNAPSHOT!A2:P${1 + abRows.length}`, abRows);
    }
    logger.info({ rows: abRows.length }, "MODULE_11: ACTIVE_BOARD_SNAPSHOT written");

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_11: Failed");
    output.status = "failure";
    output.error = message;
  }

  return output;
}
