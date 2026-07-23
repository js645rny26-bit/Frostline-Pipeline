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
  final_decision: "CORE" | "NOT_CORE" | "PENDING";
  confidence: number;
  expected_roi: number;
  recommendation: string;
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
  recommendation: string;
}

export interface Module11Result {
  status: "success" | "failure";
  extraction_timestamp_utc: string;
  slate_board: SlateBoardEntry[];
  active_board_snapshot: ActiveBoardEntry[];
  core_count: number;
  not_core_count: number;
  error?: string;
}

// SLATE_INPUT column indices (0-based):
// A=0: Game_ID, B=1: Date, C=2: Matchup, D=3: Target, E=4: Opposing_Starter
// F–N = model fields (5–13), O=14: Candidate_Vehicle, P=15: Line, Q=16: Odds
const SLATE_INPUT_COLS = {
  GAME_ID:           0,
  CANDIDATE_VEHICLE: 14,
  LINE:              15,
  ODDS:              16,
};

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function computeDecision(
  projectedTotal: number,
  marketLine: number | null,
  vehicle: string,
): { decision: "CORE" | "NOT_CORE" | "PENDING"; direction: "OVER" | "UNDER" | "NONE"; confidence: number; roi: number; recommendation: string } {
  if (marketLine === null || !vehicle || vehicle === "TBD" || vehicle === "") {
    return { decision: "PENDING", direction: "NONE", confidence: 0, roi: 0, recommendation: "PENDING" };
  }

  const variance   = projectedTotal - marketLine;
  const absVar     = Math.abs(variance);
  const isCore     = absVar >= 0.5;
  const decision   = isCore ? "CORE" : "NOT_CORE";

  // Direction: positive variance → model is above the line → OVER edge
  //            negative variance → model is below the line → UNDER edge
  const direction: "OVER" | "UNDER" | "NONE" =
    variance > 0 ? "OVER" : variance < 0 ? "UNDER" : "NONE";

  const confidence = isCore
    ? parseFloat(Math.min(0.95, 0.55 + absVar * 0.08).toFixed(2))
    : parseFloat(Math.max(0.05, 0.45 - absVar * 0.05).toFixed(2));

  // ROI uses absolute variance — direction is captured separately.
  // A STRONG_BUY UNDER should show the same positive ROI as a STRONG_BUY OVER.
  const roi = isCore ? parseFloat((absVar * 0.05).toFixed(3)) : 0;

  let recommendation: string;
  if (!isCore)            recommendation = "PASS";
  else if (absVar >= 2.0) recommendation = "STRONG_BUY";
  else if (absVar >= 1.0) recommendation = "BUY";
  else                    recommendation = "HOLD";

  return { decision, direction, confidence, roi, recommendation };
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
    not_core_count: 0,
  };

  try {
    // ── Read SLATE_INPUT for operator-provided market lines ──
    const slateInputData = await readRange(workbookId, "SLATE_INPUT!A:Q");
    const slateInputRows = (slateInputData.values ?? []).slice(1); // skip header row

    const marketMap = new Map<string, { vehicle: string; line: number | null; odds: number | null }>();
    for (const row of slateInputRows) {
      const gameId = parseStr(row[SLATE_INPUT_COLS.GAME_ID]);
      if (!gameId) continue;
      marketMap.set(gameId, {
        vehicle: parseStr(row[SLATE_INPUT_COLS.CANDIDATE_VEHICLE]),
        line:    parseNum(row[SLATE_INPUT_COLS.LINE]),
        odds:    parseNum(row[SLATE_INPUT_COLS.ODDS]),
      });
    }

    // ── Compute SLATE_BOARD — 14 cols A–N, starts row 2 ──
    const sbRows: unknown[][] = [];

    for (const gs of gameSummary) {
      const market  = marketMap.get(gs.game_id) ?? { vehicle: "", line: null, odds: null };
      const variance = market.line !== null
        ? parseFloat((gs.projected_total_runs - market.line).toFixed(2))
        : null;
      const { decision, direction, confidence, roi, recommendation } = computeDecision(
        gs.projected_total_runs,
        market.line,
        market.vehicle,
      );

      const entry: SlateBoardEntry = {
        legacy_game_id: gs.game_id,
        away_team:      gs.away_team,
        home_team:      gs.home_team,
        vehicle_type:   market.vehicle || "TBD",
        projected_total: gs.projected_total_runs,
        market_line:    market.line,
        variance,
        direction,
        final_decision: decision,
        confidence,
        expected_roi:   roi,
        recommendation,
      };
      output.slate_board.push(entry);
      if (decision === "CORE")     output.core_count++;
      if (decision === "NOT_CORE") output.not_core_count++;

      sbRows.push([
        gs.date,                         // A: Date
        gs.game_id,                      // B: Game_ID
        gs.away_team,                    // C: Away_Team
        gs.home_team,                    // D: Home_Team
        market.vehicle || "TBD",         // E: Vehicle_Type
        gs.projected_total_runs,         // F: Projected_Value
        market.line ?? "",               // G: Market_Line
        variance ?? "",                  // H: Variance_from_Projection (Model − Market; + = OVER edge, − = UNDER edge)
        direction,                       // I: Direction (OVER | UNDER | NONE)
        decision,                        // J: Decision
        confidence,                      // K: Confidence
        roi,                             // L: Expected_ROI (always positive; direction tells you which side)
        recommendation,                  // M: Recommendation
        "",                              // N: Notes
      ]);
    }

    await clearRange(workbookId, "SLATE_BOARD!A2:N100");
    if (sbRows.length > 0) {
      await writeRange(workbookId, `SLATE_BOARD!A2:N${1 + sbRows.length}`, sbRows);
    }
    logger.info(
      { rows: sbRows.length, core: output.core_count, notCore: output.not_core_count },
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
        recommendation:   entry.recommendation,
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
        abEntry.recommendation,          // K: Recommendation
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
