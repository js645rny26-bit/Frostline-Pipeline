/**
 * Module 11: Slate Board Computation & Output Extraction
 * Reads SLATE_INPUT for operator market lines, computes decisions against
 * GAME_SUMMARY projections, writes SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT,
 * then returns typed results for the API response.
 */

import { readRange, clearRange, writeRange, expandSheetColumns, addSheet, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import { computePropComparison, type RotowirePropsResult } from "./module05e_rotowireProps.js";
import { BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH, BOARD_LOCK_LATE_GRACE_MS } from "./config.js";
import type { NormalizedGame } from "./module06_normalization.js";

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
  /**
   * Board-lock state for this game.
   *   PRE_LOCK              — before this game's own cutoff; normal promotion allowed.
   *   LOCKED_IN             — was CORE when the cutoff fired; still downgradable.
   *   LOCKED_OUT            — was not CORE at cutoff; no new promotion (operator exception required).
   *   LOCK_TIME_UNAVAILABLE — game has no scheduled_utc_time; no new CORE promotion until time is known.
   *   LOCK_DATA_UNAVAILABLE — ≥ 50 % of slate games have no time; entire slate lock suppressed, no new CORE.
   */
  lock_status: "PRE_LOCK" | "LOCKED_IN" | "LOCKED_OUT" | "LOCK_TIME_UNAVAILABLE" | "LOCK_DATA_UNAVAILABLE";
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
// AF=31: Away_ML, AG=32: Home_ML, AH=33: Board_Lock_Status
const SLATE_INPUT_COLS = {
  GAME_ID:             0,
  CANDIDATE_VEHICLE:   14,
  LINE:                15,   // live market line (may shift during day)
  ODDS:                16,
  MARKET_PHASE:        23,
  AUTH_PREGAME_TOTAL:  24,   // frozen at game-time; prefer this when set
  AUTH_OVER_ODDS:      25,
  AUTH_UNDER_ODDS:     26,
  // ── Step 5: spread and moneyline ──
  AWAY_SPREAD:         28,   // run-line point for away team (+1.5 or -1.5)
  AWAY_SPREAD_ODDS:    29,   // American odds for away to cover
  HOME_SPREAD_ODDS:    30,   // American odds for home to cover
  AWAY_ML:             31,   // American moneyline for away outright win
  HOME_ML:             32,   // American moneyline for home outright win
  // ── Board lock (finalized by module11; persists across refreshes) ──
  BOARD_LOCK_STATUS:   33,   // PRE_LOCK | LOCKED_IN | LOCKED_OUT
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

export interface GameEligibilityContext {
  awayPitcherRole: string;
  homePitcherRole: string;
  awayExpectedInnings: number | null;
  homeExpectedInnings: number | null;
  bullpenAvailable: boolean;
}

export function computeDecision(
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

// ── BOARD_LOCK_STATE column indices (0-based) ─────────────────────────────────
// A=0: Date, B=1: Game_ID, C=2: Scheduled_First_Pitch, D=3: Lock_Cutoff_TS
// E=4: Lock_Status, F=5: Pre_Lock_Decision, G=6: Locked_TS
// H=7: Late_Change_Reason (operator), I=8: Late_Change_Source (operator)
// J=9: Late_Change_TS (operator), K=10: Late_Promotion_Authorized (operator)
// L=11: Last_Updated_TS
const BLS_COLS = {
  DATE:                      0,
  GAME_ID:                   1,
  SCHEDULED_FIRST_PITCH:     2,
  LOCK_CUTOFF_TS:            3,
  LOCK_STATUS:               4,
  PRE_LOCK_DECISION:         5,
  LOCKED_TS:                 6,
  LATE_CHANGE_REASON:        7,
  LATE_CHANGE_SOURCE:        8,
  LATE_CHANGE_TS:            9,
  LATE_PROMOTION_AUTHORIZED: 10,
  LAST_UPDATED_TS:           11,
} as const;

/** Authoritative board-lock record for one game, stored in BOARD_LOCK_STATE sheet. */
interface BLSRecord {
  date: string;
  game_id: string;
  scheduled_first_pitch: string;  // ISO UTC
  lock_cutoff_ts: string;          // ISO UTC
  /** PRE_LOCK | LOCKED_IN | LOCKED_OUT */
  lock_status: string;
  /** CORE | NO_CORE | PENDING — decision at the moment the board locked for this game. */
  pre_lock_decision: string;
  /** ISO UTC; set once on first lock transition; blank while PRE_LOCK. */
  locked_ts: string;
  // ── Operator-editable late-change fields ──────────────────────────────────────
  /** Named baseball reason for a post-lock CORE exception (e.g. "Starter scratch - Cole out"). */
  late_change_reason: string;
  /** Source of the update (e.g. "beat reporter", "team announcement"). */
  late_change_source: string;
  /** ISO UTC timestamp of the late change. */
  late_change_ts: string;
  /**
   * Must be explicitly set to TRUE by the operator alongside Late_Change_Reason.
   * When true AND Late_Change_Reason is non-blank, a LOCKED_OUT game may be promoted.
   * Odds movement, line movement, or recalculation never satisfy this check.
   */
  late_promotion_authorized: boolean;
  last_updated_ts: string;
}

function parseBLSRow(row: unknown[]): BLSRecord {
  return {
    date:                      parseStr(row[BLS_COLS.DATE]),
    game_id:                   parseStr(row[BLS_COLS.GAME_ID]),
    scheduled_first_pitch:     parseStr(row[BLS_COLS.SCHEDULED_FIRST_PITCH]),
    lock_cutoff_ts:            parseStr(row[BLS_COLS.LOCK_CUTOFF_TS]),
    lock_status:               parseStr(row[BLS_COLS.LOCK_STATUS]) || "PRE_LOCK",
    pre_lock_decision:         parseStr(row[BLS_COLS.PRE_LOCK_DECISION]),
    locked_ts:                 parseStr(row[BLS_COLS.LOCKED_TS]),
    late_change_reason:        parseStr(row[BLS_COLS.LATE_CHANGE_REASON]),
    late_change_source:        parseStr(row[BLS_COLS.LATE_CHANGE_SOURCE]),
    late_change_ts:            parseStr(row[BLS_COLS.LATE_CHANGE_TS]),
    late_promotion_authorized: String(row[BLS_COLS.LATE_PROMOTION_AUTHORIZED] ?? "").toUpperCase() === "TRUE",
    last_updated_ts:           parseStr(row[BLS_COLS.LAST_UPDATED_TS]),
  };
}

/**
 * Result returned by buildGameLockCutoffs.
 *
 * Consumers must inspect lockDataStatus and missingGameIds rather than
 * treating an absent cutoff entry as equivalent to PRE_LOCK.
 */
export interface GameLockCutoffResult {
  /** Per-game cutoff Date objects — present only for games that have a valid scheduled_utc_time. */
  cutoffs: Map<string, Date>;
  /**
   * Game IDs whose scheduled_utc_time was null/blank/unparseable.
   * These games must be treated as LOCK_TIME_UNAVAILABLE, not PRE_LOCK.
   */
  missingGameIds: Set<string>;
  /**
   * OK          — all games have a scheduled time; lock proceeds normally.
   * PARTIAL     — some games are missing a time (< 50 %); timed games lock normally,
   *               untimed games are individually flagged as LOCK_TIME_UNAVAILABLE.
   * UNAVAILABLE — ≥ 50 % of games have no time; the entire slate lock is suppressed
   *               and every game is flagged as LOCK_DATA_UNAVAILABLE.
   */
  lockDataStatus: "OK" | "PARTIAL" | "UNAVAILABLE";
}

/**
 * Build a per-game board-lock cutoff map.
 * Each game locks BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH hours before its own
 * scheduled first pitch.  A 1:05 PM game does not lock a 9:40 PM game.
 *
 * Warning behaviour:
 *   - A warning is logged for every game missing a scheduled_utc_time so
 *     operators know which games have an uncertain lock window.
 *   - If ≥ 50 % of slate games have no scheduled time the entire slate lock is
 *     suppressed (lockDataStatus = UNAVAILABLE) rather than silently shifting
 *     the window earlier; a slate-level warning is logged.
 *
 * Callers MUST use missingGameIds and lockDataStatus to distinguish:
 *   • a game that is genuinely before its cutoff (PRE_LOCK), from
 *   • a game whose start time is unknown (LOCK_TIME_UNAVAILABLE / LOCK_DATA_UNAVAILABLE).
 * An absent entry in `cutoffs` alone is NOT sufficient to determine lock state.
 */
export function buildGameLockCutoffs(normalizedGames?: NormalizedGame[]): GameLockCutoffResult {
  const cutoffs      = new Map<string, Date>();
  const missingGameIds = new Set<string>();

  if (!normalizedGames || normalizedGames.length === 0) {
    return { cutoffs, missingGameIds, lockDataStatus: "OK" };
  }

  const total = normalizedGames.length;

  // Identify and warn about every game missing a scheduled time.
  for (const g of normalizedGames) {
    const t = g.scheduled_utc_time ? new Date(g.scheduled_utc_time).getTime() : NaN;
    if (!g.scheduled_utc_time || isNaN(t)) {
      missingGameIds.add(g.legacy_game_id);
      logger.warn(
        { game: g.legacy_game_id, away: g.away_team?.team_abbr, home: g.home_team?.team_abbr },
        "MODULE_11: Game has no scheduled_utc_time — will be treated as LOCK_TIME_UNAVAILABLE",
      );
    }
  }

  const missing = missingGameIds.size;

  // ≥ 50 % missing: the lock window is untrustworthy for the whole slate.
  // Return without populating cutoffs so callers see UNAVAILABLE everywhere.
  if (missing / total >= 0.5) {
    logger.warn(
      { total, missing, pct: Math.round((missing / total) * 100) },
      "MODULE_11: ≥ 50 % of slate games have no scheduled_utc_time — board lock suppressed for entire slate (LOCK_DATA_UNAVAILABLE)",
    );
    return { cutoffs, missingGameIds, lockDataStatus: "UNAVAILABLE" };
  }

  // < 50 % missing: build cutoffs for timed games only.
  for (const g of normalizedGames) {
    if (missingGameIds.has(g.legacy_game_id)) continue;
    const t = new Date(g.scheduled_utc_time!).getTime();
    cutoffs.set(
      g.legacy_game_id,
      new Date(t - BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH * 60 * 60 * 1000),
    );
  }

  const lockDataStatus: GameLockCutoffResult["lockDataStatus"] = missing > 0 ? "PARTIAL" : "OK";
  return { cutoffs, missingGameIds, lockDataStatus };
}

export async function extractOutputBoards(
  gameSummary: GameSummaryRow[],
  workbookId = WORKBOOK_ID,
  propsResult: RotowirePropsResult | null = null,
  normalizedGames?: NormalizedGame[],
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
    const nowMs = Date.now();

    // ── Per-game lock cutoffs (each game locks independently) ─────────────────
    const gameLockCutoffResult = buildGameLockCutoffs(normalizedGames);
    const { cutoffs: gameLockCutoffs, missingGameIds: lockTimeMissingIds, lockDataStatus } = gameLockCutoffResult;

    // ── Read SLATE_INPUT and BOARD_LOCK_STATE concurrently ──
    // BOARD_LOCK_STATE may not exist on first publish after the schema update — treat
    // a 400 / INVALID_ARGUMENT (sheet missing) as an empty result so we can create it.
    const [slateInputData, blsData] = await Promise.all([
      readRange(workbookId, "SLATE_INPUT!A:AH"),
      readRange(workbookId, "BOARD_LOCK_STATE!A:L").catch(() => ({ values: [] as unknown[][] })),
    ]);
    const slateInputRows = (slateInputData.values ?? []).slice(1);

    // Ordered list of game IDs as they appear in SLATE_INPUT (for AH mirror write-back)
    const slateInputGameIds = slateInputRows.map((r) => parseStr(r[SLATE_INPUT_COLS.GAME_ID]));

    // ── Parse BOARD_LOCK_STATE — authoritative lock records ──
    const blsAllRows = blsData.values ?? [];
    const blsDataRows: unknown[][] = blsAllRows.slice(1).map((r) => [...(r as unknown[])]);
    const blsIndexByGameId = new Map<string, number>(); // gameId → index in blsDataRows
    const blsParsedMap    = new Map<string, BLSRecord>();
    blsDataRows.forEach((row, i) => {
      const gid = parseStr(row[BLS_COLS.GAME_ID]);
      if (gid) {
        blsIndexByGameId.set(gid, i);
        blsParsedMap.set(gid, parseBLSRow(row));
      }
    });

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
      const authTotal    = parseNum(row[SLATE_INPUT_COLS.AUTH_PREGAME_TOTAL]);
      const liveTotal    = parseNum(row[SLATE_INPUT_COLS.LINE]);
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

    // Collects lock-status for SLATE_INPUT!AH mirror write-back.
    const lockStatusUpdates = new Map<string, string>();
    // Collects BOARD_LOCK_STATE row updates (index → updated row).
    const blsRowUpdates = new Map<number, unknown[]>();
    const blsNewRows: unknown[][] = [];

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

      // ── Board-lock gate (per-game, keyed by this game's own first pitch) ──────
      // Each game locks BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH hours before its own
      // scheduled first pitch.  A 1:05 PM game does not lock a 9:40 PM game.
      // A LOCKED_OUT game can be promoted only when the operator documents a named
      // baseball reason (Late_Change_Reason) and sets Late_Promotion_Authorized=TRUE
      // in BOARD_LOCK_STATE.  Odds/line movement never satisfies this check.
      //
      // Games with no scheduled_utc_time receive LOCK_TIME_UNAVAILABLE — no new CORE
      // promotion is allowed until a time is known, though existing CORE can still be
      // downgraded by the survival gate and other post-lock checks that follow.
      // When ≥ 50 % of slate games have no time the entire slate gets
      // LOCK_DATA_UNAVAILABLE and all new CORE promotions are suppressed.
      let decision = rawDecision;
      let coreBlocker = rawCoreBlocker;

      const gameLockCutoff       = gameLockCutoffs.get(gs.game_id) ?? null;
      const gameLocked           = gameLockCutoff !== null && nowMs >= gameLockCutoff.getTime();
      const existingBLS          = blsParsedMap.get(gs.game_id);
      const persistedLockStatus  = existingBLS?.lock_status ?? "PRE_LOCK";
      const lateReasonPresent    = (existingBLS?.late_change_reason?.trim() ?? "") !== "";
      const latePromotionAuth    = existingBLS?.late_promotion_authorized === true && lateReasonPresent;
      let lockStatus: "PRE_LOCK" | "LOCKED_IN" | "LOCKED_OUT" | "LOCK_TIME_UNAVAILABLE" | "LOCK_DATA_UNAVAILABLE";
      let isFirstLock = false;
      let preLockDecision = existingBLS?.pre_lock_decision ?? "";

      if (lockDataStatus === "UNAVAILABLE") {
        // ≥ 50 % of slate games have no scheduled time — entire slate lock suppressed.
        // No new CORE promotion is allowed; survival and other downgrade gates still run.
        lockStatus = "LOCK_DATA_UNAVAILABLE";
        if (decision === "CORE") {
          decision    = "NO_CORE";
          coreBlocker = "LOCK_DATA_UNAVAILABLE";
          logger.warn({ game: gs.game_id }, "MODULE_11: CORE blocked — LOCK_DATA_UNAVAILABLE (slate-wide lock suppressed)");
        }
      } else if (lockTimeMissingIds.has(gs.game_id)) {
        // This specific game has no scheduled time — cannot establish a lock window.
        // Block new CORE promotion; downgrade gates still apply after this block.
        lockStatus = "LOCK_TIME_UNAVAILABLE";
        if (decision === "CORE") {
          decision    = "NO_CORE";
          coreBlocker = "LOCK_TIME_UNAVAILABLE";
          logger.warn({ game: gs.game_id }, "MODULE_11: CORE blocked — LOCK_TIME_UNAVAILABLE (no scheduled_utc_time)");
        }
      } else if (!gameLocked) {
        // Before this game's own cutoff — no restriction.
        lockStatus = "PRE_LOCK";
      } else if (persistedLockStatus === "LOCKED_OUT") {
        if (latePromotionAuth) {
          // Named baseball exception: operator supplied a reason and authorized.
          // Let rawDecision stand; survival gate and other gates still apply.
          lockStatus = "LOCKED_IN";
          logger.info(
            { game: gs.game_id, reason: existingBLS!.late_change_reason, source: existingBLS!.late_change_source },
            "MODULE_11: LOCKED_OUT overridden — named baseball exception authorized",
          );
        } else {
          // No exception — block promotion.
          decision    = "NO_CORE";
          coreBlocker = "BOARD_LOCKED_POST_CUTOFF";
          lockStatus  = "LOCKED_OUT";
          logger.info({ game: gs.game_id }, "MODULE_11: CORE blocked — LOCKED_OUT, no exception");
        }
      } else if (persistedLockStatus === "LOCKED_IN") {
        // Was CORE at lock; let all remaining gates run (still downgradable).
        lockStatus = "LOCKED_IN";
      } else {
        // First publish at or after this game's cutoff.
        // If the first lock fires significantly after the cutoff there is no valid
        // pre-cutoff decision snapshot — default LOCKED_OUT rather than retroactively
        // stamping the current (post-cutoff) decision as "pre-lock."
        isFirstLock = true;
        const msLate = nowMs - (gameLockCutoff?.getTime() ?? nowMs);
        if (msLate > BOARD_LOCK_LATE_GRACE_MS) {
          lockStatus      = "LOCKED_OUT";
          preLockDecision = "UNKNOWN_LATE_FIRST_RUN";
          logger.warn(
            {
              game: gs.game_id,
              cutoff: gameLockCutoff?.toISOString(),
              minutesLate: Math.round(msLate / 60000),
            },
            "MODULE_11: Board lock fired late — no valid pre-cutoff snapshot, defaulting LOCKED_OUT",
          );
        } else if (rawDecision === "CORE") {
          preLockDecision = rawDecision;
          lockStatus      = "LOCKED_IN";
          logger.info({ game: gs.game_id, cutoff: gameLockCutoff?.toISOString() }, "MODULE_11: Board lock fired — LOCKED_IN");
        } else {
          preLockDecision = rawDecision;
          lockStatus      = "LOCKED_OUT";
          logger.info({ game: gs.game_id, cutoff: gameLockCutoff?.toISOString(), rawDecision, rawCoreBlocker }, "MODULE_11: Board lock fired — LOCKED_OUT");
        }
      }

      // Mirror to SLATE_INPUT!AH.
      lockStatusUpdates.set(gs.game_id, lockStatus);

      // ── Stage BOARD_LOCK_STATE update for this game ──────────────────────────
      {
        const nowIso        = new Date(nowMs).toISOString();
        const cutoffIso     = gameLockCutoff?.toISOString() ?? "";
        const normalizedGame = normalizedGames?.find((g) => g.legacy_game_id === gs.game_id);
        const scheduledFP   = normalizedGame?.scheduled_utc_time ?? "";
        const lockedTs      = isFirstLock ? nowIso : (existingBLS?.locked_ts ?? "");

        const newBLSRow: unknown[] = [
          gs.date,                                                   // A: Date
          gs.game_id,                                                // B: Game_ID
          scheduledFP,                                               // C: Scheduled_First_Pitch
          cutoffIso,                                                 // D: Lock_Cutoff_TS
          lockStatus,                                                // E: Lock_Status
          preLockDecision,                                           // F: Pre_Lock_Decision
          lockedTs,                                                  // G: Locked_TS
          existingBLS?.late_change_reason  ?? "",                    // H: Late_Change_Reason (operator-preserved)
          existingBLS?.late_change_source  ?? "",                    // I: Late_Change_Source (operator-preserved)
          existingBLS?.late_change_ts      ?? "",                    // J: Late_Change_TS (operator-preserved)
          existingBLS?.late_promotion_authorized ? true : false,    // K: Late_Promotion_Authorized (operator-preserved)
          nowIso,                                                    // L: Last_Updated_TS
        ];

        if (blsIndexByGameId.has(gs.game_id)) {
          blsRowUpdates.set(blsIndexByGameId.get(gs.game_id)!, newBLSRow);
        } else {
          blsNewRows.push(newBLSRow);
          // Register in the index so a second occurrence of the same game_id (doubleheader)
          // doesn't create a second append entry — the second occurrence will update the first.
          blsIndexByGameId.set(gs.game_id, blsDataRows.length + blsNewRows.length - 1);
        }
      }

      // ── Over survival gate ────────────────────────────────────────────────────
      // Every Over CORE candidate must pass a two-part component-decomposed stress
      // test before authorization. Park and weather cannot manufacture the thesis —
      // the Over must survive on baseball grounds alone.

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
        lock_status:     lockStatus,
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
        lockStatus,                                   // AH: Lock_Status (PRE_LOCK | LOCKED_IN | LOCKED_OUT)
      ]);
    }

    // ── Ensure SLATE_BOARD has 34 columns (A–AH) for lock_status field ──
    await expandSheetColumns(workbookId, "SLATE_BOARD", 34).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not expand SLATE_BOARD columns — continuing");
    });

    // Write step-5 derivative + survival gate + lock status headers (W–AH)
    await writeRange(workbookId, "SLATE_BOARD!W1:AH1", [[
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
      "Lock_Status",
    ]]).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not write step-5/survival/lock headers — continuing");
    });

    await clearRange(workbookId, "SLATE_BOARD!A2:AH100");
    if (sbRows.length > 0) {
      await writeRange(workbookId, `SLATE_BOARD!A2:AH${1 + sbRows.length}`, sbRows);
    }
    logger.info(
      { rows: sbRows.length, core: output.core_count, noCore: output.no_core_count },
      "MODULE_11: SLATE_BOARD written",
    );

    // ── Ensure BOARD_LOCK_STATE sheet exists (creates it on first publish) ──────
    await addSheet(workbookId, "BOARD_LOCK_STATE").catch(() => {
      // addSheet throws if the sheet already exists — that is the normal case; swallow it.
    });

    // ── Write BOARD_LOCK_STATE header (written every publish so it stays in sync) ──
    await writeRange(workbookId, "BOARD_LOCK_STATE!A1:L1", [[
      "Date", "Game_ID", "Scheduled_First_Pitch", "Lock_Cutoff_TS",
      "Lock_Status", "Pre_Lock_Decision", "Locked_TS",
      "Late_Change_Reason", "Late_Change_Source", "Late_Change_TS",
      "Late_Promotion_Authorized", "Last_Updated_TS",
    ]]).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_11: Could not write BOARD_LOCK_STATE headers — continuing");
    });

    // ── Write BOARD_LOCK_STATE — authoritative per-game lock records ──────────
    // Apply in-place updates then append new rows; old-day rows stay untouched.
    {
      for (const [rowIdx, updatedRow] of blsRowUpdates) {
        blsDataRows[rowIdx] = updatedRow;
      }
      const allBLSRows = [...blsDataRows, ...blsNewRows];
      if (allBLSRows.length > 0) {
        await writeRange(
          workbookId,
          `BOARD_LOCK_STATE!A2:L${1 + allBLSRows.length}`,
          allBLSRows,
        ).catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "MODULE_11: Could not write BOARD_LOCK_STATE — continuing",
          );
        });
        logger.info(
          { updated: blsRowUpdates.size, appended: blsNewRows.length },
          "MODULE_11: BOARD_LOCK_STATE written",
        );
      }
    }

    // ── Mirror Board_Lock_Status to SLATE_INPUT!AH (convenience copy) ────────
    if (lockStatusUpdates.size > 0) {
      const ahValues = slateInputGameIds.map((id) => [lockStatusUpdates.get(id) ?? "PRE_LOCK"]);
      if (ahValues.length > 0) {
        await writeRange(
          workbookId,
          `SLATE_INPUT!AH2:AH${1 + ahValues.length}`,
          ahValues,
        ).catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "MODULE_11: Could not mirror Board_Lock_Status to SLATE_INPUT!AH — continuing",
          );
        });
      }
    }

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
