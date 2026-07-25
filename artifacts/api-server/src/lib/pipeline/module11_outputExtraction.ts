/**
 * Module 11: Slate Board Computation & Output Extraction
 * Reads SLATE_INPUT for operator market lines, computes decisions against
 * GAME_SUMMARY projections, writes SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT,
 * then returns typed results for the API response.
 */

import { readRange, clearRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import { computePropComparison, type RotowirePropsResult } from "./module05e_rotowireProps.js";

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
  // ── Shadow-mode prop comparison fields (no CORE impact) ──
  starter_k_market_signal: string;
  starter_er_market_signal: string;
  lineup_tb_coverage_pct: number | null;
  prop_market_direction: string;
  prop_market_agreement: string;
  prop_market_disagreement_reason: string;
  prop_snapshot_ts: string;
  // ── Side (run-line) derivative signals ──
  /** proj_run_diff + away_spread. Positive = model says away covers; negative = home covers. */
  side_edge: number | null;
  side_direction: "AWAY" | "HOME" | "NONE" | "NO_MARKET";
  side_decision: "CORE" | "NO_CORE" | "NO_MARKET";
  // ── Starter quality derivatives ──
  away_starter_quality: number | null;
  home_starter_quality: number | null;
  // ── Over survival gate audit fields (non-null for OVER games with a market line) ──
  /** starter_attack_runs + bullpen_continuation_runs: total runs on baseball grounds only, no park/weather. */
  baseball_only_projection: number | null;
  /** park × weather run contribution: projected_total − baseball_only_projection. */
  environment_run_adjustment: number | null;
  /** Low-conversion stress floor: starter × 0.80 + bullpen × 0.75 + traffic × 0.70 + HR/XBH × 0.90. */
  survival_floor: number | null;
  /** survival_floor − market_line. Must be ≥ 0.25 for CORE. */
  survival_floor_edge: number | null;
  /** PASS | FAIL | N_A. FAIL triggers NO_CORE with a specific blocker reason. */
  survival_check: "PASS" | "FAIL" | "N_A";
  /**
   * Why the survival check failed. One of:
   *   ENVIRONMENT_DEPENDENT_OVER       — baseball_only_projection < market_line (env manufactured the Over)
   *   BASEBALL_ONLY_EDGE_BELOW_THRESHOLD — baseball-only edge < 1.25 but ≥ 0
   *   SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD — floor edge < 0.25 after baseball-only edge cleared
   *   COMPONENT_DATA_UNAVAILABLE       — projection components missing from module09
   * Empty string for PASS or N_A.
   */
  survival_failure_reason: string;
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
// AC=28: Away_Spread, AD=29: Away_Spread_Odds, AE=30: Home_Spread_Odds
// AF=31: Away_ML, AG=32: Home_ML
const SLATE_INPUT_COLS = {
  GAME_ID:            0,
  CANDIDATE_VEHICLE:  14,
  LINE:               15,   // live market line (may shift during day)
  ODDS:               16,
  MARKET_PHASE:       23,
  AUTH_PREGAME_TOTAL: 24,   // frozen at game-time; prefer this when set
  AUTH_OVER_ODDS:     25,
  AUTH_UNDER_ODDS:    26,
  // ── Step 5: spread and moneyline ──
  AWAY_SPREAD:        28,   // run-line point for away team (+1.5 or -1.5)
  AWAY_SPREAD_ODDS:   29,   // American odds for away to cover
  HOME_SPREAD_ODDS:   30,   // American odds for home to cover
  AWAY_ML:            31,   // American moneyline for away outright win
  HOME_ML:            32,   // American moneyline for home outright win
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

// ── Over survival gate constants ─────────────────────────────────────────────
/**
 * Minimum edge that the baseball-only projection (no park/weather) must clear
 * above the market line for an Over to qualify as CORE.
 * If the baseball thesis alone doesn't provide ≥ 1.25 runs of edge, the Over
 * may be environment-dependent and must be blocked.
 */
const OVER_BASEBALL_ONLY_EDGE_THRESHOLD = 1.25;

/**
 * Minimum edge that the survival floor must clear above the market line.
 * The floor represents a low-conversion game scenario; the Over must survive
 * even that adverse case by at least 0.25 runs.
 */
const OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD = 0.25;

// Per-component stress penalties for the survival floor formula.
// These simulate a low-conversion game: starters outperform their season profile
// (→ fewer runs allowed), traffic doesn't convert efficiently, bullpen is clean,
// and extra-base damage is muted compared to the projection.
const SURVIVAL_STARTER_PENALTY  = 0.80;   // starters pitch better than modelled
const SURVIVAL_BULLPEN_PENALTY  = 0.75;   // bullpen continuation rate is suppressed
const SURVIVAL_TRAFFIC_PENALTY  = 0.70;   // baserunner-to-run conversion is poor
const SURVIVAL_HR_XBH_PENALTY   = 0.90;   // extra-base / HR damage is muted

export interface OverSurvivalResult {
  /** Projection excluding park/weather: starter_attack_runs + bullpen_continuation_runs. */
  baseball_only_projection: number;
  /** Park × weather run contribution (projected_total − baseball_only_projection). */
  environment_run_adjustment: number;
  /**
   * Stress-test floor:
   *   starter × 0.80 + bullpen × 0.75 + traffic × 0.70 + HR_XBH × 0.90
   * This is the minimum plausible Over total if baseball conditions are adverse.
   */
  survival_floor: number;
  /** survival_floor − market_line. Must be ≥ OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD. */
  survival_floor_edge: number;
  survival_check: "PASS" | "FAIL";
  /**
   * Specific reason for failure. One of:
   *   ENVIRONMENT_DEPENDENT_OVER         — baseball-only projection is below the market line
   *   BASEBALL_ONLY_EDGE_BELOW_THRESHOLD — baseball edge ≥ 0 but < 1.25
   *   SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD — floor edge < 0.25 (baseball edge was adequate)
   * Empty string for PASS.
   */
  survival_failure_reason: string;
}

/**
 * Component-decomposed Over survival gate.
 *
 * Tests two independent conditions before an Over can reach CORE:
 *
 * 1. Baseball-only edge ≥ 1.25:
 *    The projection must clear the market line by ≥ 1.25 runs on baseball
 *    grounds alone (starter + bullpen quality), without any contribution from
 *    park or weather factors. This prevents environment from manufacturing
 *    an Over thesis that has no baseball basis.
 *
 * 2. Survival floor edge ≥ 0.25:
 *    Even under a low-conversion scenario (starters outperform, traffic
 *    doesn't convert, bullpen is clean, extra-base damage is muted), the
 *    discounted projection must still clear the line by ≥ 0.25 runs.
 *    A legitimate Over thesis should have a margin that survives adverse
 *    baseball conditions.
 *
 * Park and weather are excluded from both tests. At most, a separately
 * bounded environment modifier may be included in future after replay.
 */
export function overSurvivalCheck(
  starterAttackRuns: number,
  bullpenContinuationRuns: number,
  trafficConversionRuns: number,
  hrXbhDamageRuns: number,
  baseballOnlyProjection: number,
  environmentRunAdjustment: number,
  marketLine: number,
): OverSurvivalResult {
  const survivalFloor = parseFloat((
    starterAttackRuns       * SURVIVAL_STARTER_PENALTY +
    bullpenContinuationRuns * SURVIVAL_BULLPEN_PENALTY +
    trafficConversionRuns   * SURVIVAL_TRAFFIC_PENALTY +
    hrXbhDamageRuns         * SURVIVAL_HR_XBH_PENALTY
  ).toFixed(2));

  const baseballOnlyEdge  = parseFloat((baseballOnlyProjection - marketLine).toFixed(2));
  const survivalFloorEdge = parseFloat((survivalFloor - marketLine).toFixed(2));

  let survivalCheck: "PASS" | "FAIL" = "PASS";
  let survivalFailureReason = "";

  if (baseballOnlyEdge < 0) {
    // Baseball alone doesn't even reach the line — environment is entirely
    // responsible for the Over thesis. Block unconditionally.
    survivalCheck = "FAIL";
    survivalFailureReason = "ENVIRONMENT_DEPENDENT_OVER";
  } else if (baseballOnlyEdge < OVER_BASEBALL_ONLY_EDGE_THRESHOLD) {
    survivalCheck = "FAIL";
    survivalFailureReason = "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD";
  } else if (survivalFloorEdge < OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD) {
    survivalCheck = "FAIL";
    survivalFailureReason = "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD";
  }

  return {
    baseball_only_projection: baseballOnlyProjection,
    environment_run_adjustment: environmentRunAdjustment,
    survival_floor: survivalFloor,
    survival_floor_edge: survivalFloorEdge,
    survival_check: survivalCheck,
    survival_failure_reason: survivalFailureReason,
  };
}

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
  propsResult: RotowirePropsResult | null = null,
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
    // Range extends to AG to cover spread/ML cols (AC–AG = 28–32)
    const slateInputData = await readRange(workbookId, "SLATE_INPUT!A:AG");
    const slateInputRows = (slateInputData.values ?? []).slice(1); // skip header row

    const marketMap = new Map<string, {
      vehicle: string;
      line: number | null;
      odds: number | null;
      phase: string;
      away_spread: number | null;
      away_spread_odds: number | null;
      home_spread_odds: number | null;
      away_ml: number | null;
      home_ml: number | null;
    }>();
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
        vehicle:          parseStr(row[SLATE_INPUT_COLS.CANDIDATE_VEHICLE]),
        line:             authTotal ?? liveTotal,
        odds:             authOverOdds ?? parseNum(row[SLATE_INPUT_COLS.ODDS]),
        phase:            parseStr(row[SLATE_INPUT_COLS.MARKET_PHASE]) || "PREGAME",
        away_spread:      parseNum(row[SLATE_INPUT_COLS.AWAY_SPREAD]),
        away_spread_odds: parseNum(row[SLATE_INPUT_COLS.AWAY_SPREAD_ODDS]),
        home_spread_odds: parseNum(row[SLATE_INPUT_COLS.HOME_SPREAD_ODDS]),
        away_ml:          parseNum(row[SLATE_INPUT_COLS.AWAY_ML]),
        home_ml:          parseNum(row[SLATE_INPUT_COLS.HOME_ML]),
      });
    }

    // ── Ensure SLATE_BOARD has at least 33 columns (A–AG) for all output fields ──
    await expandSheetColumns(workbookId, "SLATE_BOARD", 33).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not expand SLATE_BOARD columns — continuing");
    });

    // Write full SLATE_BOARD header row — A–O (indices 0–14) every publish so
    // headers stay in sync with the current schema even when column names change.
    await writeRange(workbookId, "SLATE_BOARD!A1:O1", [[
      "Date", "Game_ID", "Away_Team", "Home_Team",
      "Vehicle_Type", "Projected_Value", "Market_Line",
      "Variance_from_Projection", "Direction", "Decision",
      "Confidence", "Expected_ROI", "Edge_Strength", "CORE_Blocker", "Notes",
    ]]).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not write SLATE_BOARD A–O headers — continuing");
    });

    // Write prop signal headers on row 1, columns P–V (indices 15–21)
    await writeRange(workbookId, "SLATE_BOARD!P1:V1", [[
      "Starter_K_Market_Signal",
      "Starter_ER_Market_Signal",
      "Lineup_TB_Coverage_Pct",
      "Prop_Market_Direction",
      "Prop_Market_Agreement",
      "Prop_Market_Disagreement_Reason",
      "Prop_Snapshot_TS",
    ]]).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not write prop signal headers — continuing");
    });

    // ── Compute SLATE_BOARD — 22 cols A–V, starts row 2 ──
    const sbRows: unknown[][] = [];

    for (const gs of gameSummary) {
      const market  = marketMap.get(gs.game_id) ?? {
        vehicle: "", line: null, odds: null, phase: "PREGAME",
        away_spread: null, away_spread_odds: null, home_spread_odds: null,
        away_ml: null, home_ml: null,
      };
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
      const { decision: rawDecision, direction, edgeStrength, coreBlocker: rawCoreBlocker, confidence, roi } = computeDecision(
        gs.projected_total_runs,
        market.line,
        market.vehicle,
        gameCtx,
      );

      // ── Over survival gate ────────────────────────────────────────────────────
      // Every Over CORE candidate must pass a two-part component-decomposed stress
      // test before authorization. Park and weather cannot manufacture the thesis —
      // the Over must survive on baseball grounds alone.
      let decision = rawDecision;
      let coreBlocker = rawCoreBlocker;

      // Initialise all survival audit fields (populated for all OVERs with a line)
      let survivalBaseballOnly: number | null = null;
      let survivalEnvAdj: number | null = null;
      let survivalFloor: number | null = null;
      let survivalFloorEdge: number | null = null;
      let survivalCheck: "PASS" | "FAIL" | "N_A" = "N_A";
      let survivalFailureReason = "";

      if (direction === "OVER" && market.line !== null) {
        // Check that module09 provided the decomposed components.
        if (gs.baseball_only_projection === undefined || gs.starter_attack_runs === undefined) {
          // Data unavailable — block conservatively rather than silently passing.
          survivalCheck = "FAIL";
          survivalFailureReason = "COMPONENT_DATA_UNAVAILABLE";
          if (decision === "CORE") {
            decision = "NO_CORE";
            coreBlocker = "COMPONENT_DATA_UNAVAILABLE";
          }
        } else {
          const sr = overSurvivalCheck(
            gs.starter_attack_runs,
            gs.bullpen_continuation_runs,
            gs.traffic_conversion_runs,
            gs.hr_xbh_damage_runs,
            gs.baseball_only_projection,
            gs.environment_run_adjustment,
            market.line,
          );
          survivalBaseballOnly  = sr.baseball_only_projection;
          survivalEnvAdj        = sr.environment_run_adjustment;
          survivalFloor         = sr.survival_floor;
          survivalFloorEdge     = sr.survival_floor_edge;
          survivalCheck         = sr.survival_check;
          survivalFailureReason = sr.survival_failure_reason;

          if (decision === "CORE" && sr.survival_check === "FAIL") {
            decision    = "NO_CORE";
            coreBlocker = sr.survival_failure_reason;
            logger.info(
              {
                game: gs.game_id,
                baseballOnly: sr.baseball_only_projection,
                envAdj: sr.environment_run_adjustment,
                floor: sr.survival_floor,
                floorEdge: sr.survival_floor_edge,
                line: market.line,
                reason: sr.survival_failure_reason,
              },
              "MODULE_11: Over CORE downgraded by survival gate",
            );
          }
        }
      }

      // ── Side (run-line) derivative signal ──────────────────────────────
      const projRunDiff  = parseFloat((gs.projected_away_runs - gs.projected_home_runs).toFixed(2));
      const awaySpread   = market.away_spread;
      // side_edge: positive = model projects away to cover the spread; negative = home covers
      const sideEdge     = awaySpread !== null
        ? parseFloat((projRunDiff + awaySpread).toFixed(2))
        : null;
      const sideDirection: "AWAY" | "HOME" | "NONE" | "NO_MARKET" =
        sideEdge === null ? "NO_MARKET" :
        sideEdge > 0      ? "AWAY"      :
        sideEdge < 0      ? "HOME"      : "NONE";
      const SIDE_CORE_THRESHOLD = 1.5;
      const sideDecision: "CORE" | "NO_CORE" | "NO_MARKET" =
        sideEdge === null ? "NO_MARKET" :
        Math.abs(sideEdge) >= SIDE_CORE_THRESHOLD &&
        gameCtx.awayPitcherRole !== "UNRESOLVED" &&
        gameCtx.homePitcherRole !== "UNRESOLVED" &&
        !!gameCtx.awayExpectedInnings &&
        !!gameCtx.homeExpectedInnings &&
        gameCtx.bullpenAvailable
          ? "CORE" : "NO_CORE";

      // ── Shadow-mode prop comparison signals (no CORE impact) ────────────
      const EMPTY_PROPS = {
        starter_k_market_signal:          "INSUFFICIENT_COVERAGE",
        starter_er_market_signal:         "INSUFFICIENT_COVERAGE",
        lineup_tb_coverage_pct:           null as number | null,
        prop_market_direction:            "INSUFFICIENT_COVERAGE" as string,
        prop_market_agreement:            "INSUFFICIENT_COVERAGE" as string,
        prop_market_disagreement_reason:  "",
        prop_snapshot_ts:                 "",
      };
      const propSignals = propsResult
        ? computePropComparison(
            gs.away_team,
            gs.home_team,
            gs.away_pitcher || null,
            gs.home_pitcher || null,
            direction,
            propsResult,
          )
        : EMPTY_PROPS;

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
        side_edge:              sideEdge,
        side_direction:         sideDirection,
        side_decision:          sideDecision,
        away_starter_quality:   gs.away_starter_quality ?? null,
        home_starter_quality:   gs.home_starter_quality ?? null,
        baseball_only_projection:   survivalBaseballOnly,
        environment_run_adjustment: survivalEnvAdj,
        survival_floor:             survivalFloor,
        survival_floor_edge:        survivalFloorEdge,
        survival_check:             survivalCheck,
        survival_failure_reason:    survivalFailureReason,
        starter_k_market_signal:         propSignals.starter_k_market_signal,
        starter_er_market_signal:        propSignals.starter_er_market_signal,
        lineup_tb_coverage_pct:          propSignals.lineup_tb_coverage_pct,
        prop_market_direction:           propSignals.prop_market_direction,
        prop_market_agreement:           propSignals.prop_market_agreement,
        prop_market_disagreement_reason: propSignals.prop_market_disagreement_reason,
        prop_snapshot_ts:                propSignals.prop_snapshot_ts,
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
        "",                              // O: Notes (operator)
        propSignals.starter_k_market_signal,          // P: Starter_K_Market_Signal
        propSignals.starter_er_market_signal,         // Q: Starter_ER_Market_Signal
        propSignals.lineup_tb_coverage_pct ?? "",     // R: Lineup_TB_Coverage_Pct
        propSignals.prop_market_direction,            // S: Prop_Market_Direction
        propSignals.prop_market_agreement,            // T: Prop_Market_Agreement
        propSignals.prop_market_disagreement_reason,  // U: Prop_Market_Disagreement_Reason
        propSignals.prop_snapshot_ts,                 // V: Prop_Snapshot_TS
        sideEdge ?? "",                               // W: Side_Edge
        sideDirection,                                // X: Side_Direction
        sideDecision,                                 // Y: Side_Decision
        gs.away_starter_quality ?? "",                // Z: Away_Starter_Quality
        gs.home_starter_quality ?? "",                // AA: Home_Starter_Quality
        survivalBaseballOnly ?? "",                   // AB: Baseball_Only_Projection
        survivalEnvAdj ?? "",                         // AC: Environment_Run_Adjustment
        survivalFloor ?? "",                          // AD: Survival_Floor
        survivalFloorEdge ?? "",                      // AE: Survival_Floor_Edge
        survivalCheck,                                // AF: Survival_Check (PASS | FAIL | N_A)
        survivalFailureReason,                        // AG: Survival_Failure_Reason
      ]);
    }

    // ── Ensure SLATE_BOARD has 33 columns (A–AG) for step-5 + survival gate fields ──
    await expandSheetColumns(workbookId, "SLATE_BOARD", 33).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not expand SLATE_BOARD columns — continuing");
    });

    // Write step-5 derivative + survival gate headers (W–AG)
    await writeRange(workbookId, "SLATE_BOARD!W1:AG1", [[
      "Side_Edge",
      "Side_Direction",
      "Side_Decision",
      "Away_Starter_Quality",
      "Home_Starter_Quality",
      "Baseball_Only_Projection",
      "Environment_Run_Adjustment",
      "Survival_Floor",
      "Survival_Floor_Edge",
      "Survival_Check",
      "Survival_Failure_Reason",
    ]]).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not write step-5/survival headers — continuing");
    });

    await clearRange(workbookId, "SLATE_BOARD!A2:AG100");
    if (sbRows.length > 0) {
      await writeRange(workbookId, `SLATE_BOARD!A2:AG${1 + sbRows.length}`, sbRows);
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
