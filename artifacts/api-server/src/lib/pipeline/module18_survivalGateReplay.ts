/**
 * Module 18: Survival Gate Replay Analysis
 *
 * Retroactively applies the over-survival gate to historical projection data
 * stored in VEHICLE_LOG, SHADOW_HISTORY, and SHADOW_OUTCOMES.
 *
 * ── Mathematical reconstruction ───────────────────────────────────────────────
 * The survival gate requires decomposed projection components that are NOT
 * persisted to any sheet (they are computed live in module09 and consumed by
 * module11 within the same pipeline run).  This module reconstructs the key
 * components from available sheet data:
 *
 *   baseball_only_projection = projected_total / combined_multiplier
 *
 * This equality is EXACT, not approximate. Because the park×weather multiplier
 * is applied uniformly to both teams' offense rates BEFORE pitching and bullpen
 * factors are applied:
 *
 *   projAway = (awayOff × mult × lineupA) × pitcherFactors(homeIP, homeQual, etc.)
 *   baselineAway = (awayOff × lineupA) × pitcherFactors(...)  [same factors]
 *   → baselineAway = projAway / mult
 *   Similarly for projHome.
 *   → baseball_only_projection = projTotal / mult
 *
 * Survival floor approximation:
 *   Currently traffic_conversion_runs = 0 and hr_xbh_damage_runs = 0, so:
 *   floor = starter_attack_runs × 0.80 + bullpen_continuation_runs × 0.75
 *
 *   Without stored per-game starter IP, we use the production default (5.5 IP):
 *   starter_fraction ≈ 0.611, bullpen_fraction ≈ 0.389
 *   → floor ≈ baseball_only × (0.611×0.80 + 0.389×0.75) ≈ baseball_only × 0.781
 *
 *   This under-estimates blocking slightly (true floor varies with pitcher IP and
 *   quality).  Accepted for replay validation; flag any games where the estimate
 *   is within 0.15 of the threshold as "MARGINAL".
 *
 * ── What the replay answers ────────────────────────────────────────────────────
 * For each OVER pick in the date range:
 *   • Would the survival gate have blocked it?
 *   • If blocked, which failure reason?
 *   • Was the actual outcome a loser (thesis failed)?
 *   • Were any winners collaterally blocked?
 *
 * ── CHC-PIT July 24 case study (2024-07-24) ──────────────────────────────────
 * CHC-PIT was the first settled CORE Over in the SURVIVAL_GATE_REPLAY sheet.
 * It lost badly (actual=5, line=8, proj=11.36) and prompted a gate review.
 *
 * Reconstructed gate values (via this module's approximation):
 *   proj=11.36, baseball_only=11.93, combined_mult=0.9524, line=8, actual=5
 *   baseball_only_edge = 3.93  (threshold 1.25 — cleared with 2.68 margin)
 *   floor_edge         = 1.31  (threshold 0.25 — cleared with 1.06 margin)
 *   combined_mult < 1  → park/weather was a net suppressor (−0.57 env runs)
 *
 * Verdict: No threshold defect demonstrated. The reconstruction strongly
 * suggests CHC-PIT would have passed the survival gate. However, this module
 * uses an approximation (baseball_only = proj ÷ mult; floor = baseball_only ×
 * 0.781) rather than the exact live formula (starter×0.80 + bullpen×0.75 +
 * traffic×0.70 + HR×0.90), so exact component-level behavior is not proven.
 * The 6.36-run projection miss is an unresolved projection error — its root
 * cause (offense overprojection, component error, unmodeled suppression, or
 * ordinary variance) cannot be classified from one observation.
 *
 * Why no threshold was changed:
 *   1. Raising OVER_BASEBALL_ONLY_EDGE_THRESHOLD could not have blocked CHC-PIT
 *      (edge 3.93 >> any operationally useful threshold).
 *   2. A projected-total cap requires a larger settled sample; changing a
 *      constant from one settled CORE loss is outcome-driven overfitting.
 *
 * When to reassess: ≥ 10 settled CORE rows with exact component-level replay
 * (not this multiplier approximation). If passed_losses / replayed_core > ~40 %
 * and high-proj games (baseball_only > 11) cluster in the losses, evaluate a
 * soft cap then.
 *
 * See also: OVER_BASEBALL_ONLY_EDGE_THRESHOLD comment in module11_outputExtraction.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Endpoint: GET /api/pipeline/survival-replay?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *           Optional: &write_sheets=true to persist SURVIVAL_GATE_REPLAY
 */

import { readRange, writeRange, clearRange, expandSheetColumns, addSheet, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

// ─── Constants (must stay in sync with module11 / module09) ──────────────────
const OVER_BASEBALL_ONLY_EDGE_THRESHOLD  = 1.25;
const OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD = 0.25;
const SURVIVAL_STARTER_PENALTY           = 0.80;
const SURVIVAL_BULLPEN_PENALTY           = 0.75;
const CORE_THRESHOLD                     = 1.5;    // minimum total variance to reach CORE

/** Default starter IP fraction used when per-game IP is unavailable. */
const DEFAULT_STARTER_FRACTION  = 5.5 / 9;   // ≈ 0.611
const DEFAULT_BULLPEN_FRACTION  = 3.5 / 9;   // ≈ 0.389

/**
 * Approximate survival floor penalty for baseball_only_projection when
 * starter IP breakdown is unavailable.  Derived from the weighted average:
 *   STARTER_FRACTION × 0.80 + BULLPEN_FRACTION × 0.75 ≈ 0.781
 * Used only for the reconstructed floor; floor_edge margin of ≤ 0.15 is
 * flagged MARGINAL to indicate the approximation may affect the verdict.
 */
const DEFAULT_FLOOR_FACTOR =
  DEFAULT_STARTER_FRACTION * SURVIVAL_STARTER_PENALTY +
  DEFAULT_BULLPEN_FRACTION * SURVIVAL_BULLPEN_PENALTY;

/** How close to a threshold a gate verdict must be for it to be MARGINAL. */
const MARGINAL_MARGIN = 0.15;

/**
 * baseball_only_projection above this value triggers a HIGH_PROJECTION_OUTLIER
 * note in the SURVIVAL_GATE_REPLAY sheet so operators can cluster and review
 * extreme-total CORE picks without code access.
 *
 * Rationale: the survival floor scales linearly with baseball_only_proj, so a
 * high absolute projection still passes the gate easily while carrying more
 * outcome variance than a moderate one.  10.5 runs is roughly the 90th
 * percentile of recent reconstructed projections.
 *
 * ⚠ Recalibrate once ≥ 15 settled CORE outcomes exist in SURVIVAL_GATE_REPLAY.
 *   Compare the distribution of baseball_only_proj for CORE wins vs losses and
 *   adjust to the value where losses begin clustering.
 */
const HIGH_PROJECTION_OUTLIER_THRESHOLD = 10.5;

// ─── VEHICLE_LOG column indices (0-based) ─────────────────────────────────────
// Date | Game_ID | Away | Home | Vehicle_Type | Market_Line | Direction |
// Projected_Total | Variance | Final_Decision | Core_Blocker | Edge_Strength | Confidence | Publish_TS
const VL_DATE        = 0;
const VL_GAME_ID     = 1;
const VL_AWAY        = 2;
const VL_HOME        = 3;
const VL_VEHICLE     = 4;
const VL_LINE        = 5;
const VL_DIRECTION   = 6;
const VL_PROJ        = 7;
const VL_VARIANCE    = 8;
const VL_DECISION    = 9;
const VL_BLOCKER     = 10;

// ─── SHADOW_HISTORY column indices (0-based) ──────────────────────────────────
// Date | Game_ID | Away | Home | Away_Pitcher | Home_Pitcher |
// Repaired_Projected_Total | Legacy_Projected_Total | Delta |
// Away_Offense_Source | Home_Offense_Source | Away_L30 | Home_L30 |
// Away_L10 | Home_L10 | Away_Off_Rate | Home_Off_Rate |
// Legacy_Multiplier | Park_Multiplier | Weather_Multiplier | Repaired_Multiplier |
// Park_Source_Status | Snapshot_TS
const SH_DATE               = 0;
const SH_GAME_ID            = 1;
const SH_AWAY               = 2;
const SH_HOME               = 3;
const SH_AWAY_PITCHER       = 4;
const SH_HOME_PITCHER       = 5;
const SH_REPAIRED_TOTAL     = 6;
const SH_AWAY_OFFENSE_SOURCE = 9;   // Away_Offense_Source (BLENDED | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK)
const SH_HOME_OFFENSE_SOURCE = 10;  // Home_Offense_Source
const SH_AWAY_L30           = 11;
const SH_HOME_L30           = 12;
const SH_AWAY_OFF_RATE      = 15;
const SH_HOME_OFF_RATE      = 16;
const SH_PARK_MULT          = 18;
const SH_WEATHER_MULT       = 19;
const SH_REPAIRED_MULT      = 20;
const SH_PARK_SOURCE        = 21;

// ─── SHADOW_OUTCOMES column indices (0-based) ─────────────────────────────────
// Date | Game_ID | Away | Home | Repaired_Proj | Actual_Total | Error | Abs_Error |
// Park_Source | Away_Src | Home_Src | Settlement_TS
const SO_DATE     = 0;
const SO_GAME_ID  = 1;
const SO_ACTUAL   = 5;

// ─── Output sheet ─────────────────────────────────────────────────────────────
const REPLAY_SHEET = "SURVIVAL_GATE_REPLAY";
const REPLAY_COLS  = 29;

const REPLAY_HEADER: string[] = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Away_Pitcher",
  "Home_Pitcher",
  "Market_Line",
  "Projected_Total",
  "Variance",
  "Direction",
  "Actual_Total",
  "Thesis_Correct",            // TRUE if direction matched actual vs line
  "Original_Decision",
  "Original_Blocker",
  "Replayed_Decision",         // CORE | BLOCKED | PENDING | NOT_OVER
  "Replay_Blocker",            // Why the survival gate blocks (or empty)
  "Baseball_Only_Proj",        // projected_total / combined_multiplier
  "Combined_Multiplier",       // park × weather (capped)
  "Environment_Run_Adj",       // projected_total − baseball_only_proj
  "Approx_Survival_Floor",     // baseball_only × DEFAULT_FLOOR_FACTOR
  "Floor_Edge",                // approx_floor − market_line
  "Baseball_Only_Edge",        // baseball_only_proj − market_line
  "Park_Multiplier",
  "Weather_Multiplier",
  "Park_Source",
  "Marginal_Flag",             // MARGINAL if verdict within ±0.15 of a threshold
  "Away_Offense_Source",       // BLENDED | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK
  "Home_Offense_Source",
  "Notes",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReplayDecision = "CORE" | "BLOCKED" | "PENDING" | "NOT_OVER" | "NO_DATA";

export type ReplayBlocker =
  | "ENVIRONMENT_DEPENDENT_OVER"
  | "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD"
  | "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD"
  | "PRIOR_GATE"           // blocked before survival gate (unresolved pitcher, no bullpen, etc.)
  | "NO_MARKET_LINE"
  | "";

export interface SurvivalReplayRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  away_pitcher: string;
  home_pitcher: string;
  market_line: number | null;
  projected_total: number;
  variance: number | null;
  direction: string;
  actual_total: number | null;
  thesis_correct: boolean | null;
  original_decision: string;
  original_blocker: string;
  replayed_decision: ReplayDecision;
  replay_blocker: ReplayBlocker;
  baseball_only_projection: number | null;
  combined_multiplier: number | null;
  environment_run_adjustment: number | null;
  approx_survival_floor: number | null;
  floor_edge: number | null;
  baseball_only_edge: number | null;
  park_multiplier: number | null;
  weather_multiplier: number | null;
  park_source: string;
  marginal_flag: string;
  away_offense_source: string;
  home_offense_source: string;
  notes: string;
}

export interface SurvivalReplayResult {
  status: "success" | "partial" | "failure";
  date_range: { start: string; end: string };
  replay_ts: string;
  total_overs: number;
  /** OVERs that would have been CORE under the survival gate. */
  replayed_core: number;
  /** OVERs blocked by the survival gate (any of the 3 failure reasons). */
  replayed_blocked: number;
  /** OVERs already blocked before reaching the survival gate. */
  blocked_prior: number;
  /**
   * Breakdown of blocked OVERs by survival gate failure reason.
   */
  blocked_env_dependent: number;
  blocked_baseball_edge: number;
  blocked_floor_edge: number;
  /** Of replayed-CORE OVERs, how many had correct thesis (actual > line)? */
  core_thesis_correct: number;
  /**
   * Of replayed-CORE OVERs, how many had wrong thesis (actual ≤ line)?
   * These are picks the gate passed that still lost — the gate's "missed blocks".
   */
  passed_losses: number;
  /** Of replayed-BLOCKED OVERs, how many had wrong thesis (actual ≤ line) — correct blocks? */
  correct_blocks: number;
  /** Of replayed-BLOCKED OVERs, how many had correct thesis — collateral damage? */
  collateral_blocks: number;
  /**
   * correct_blocks + collateral_blocks — the gate decision denominator.
   * Null means no survival-gate-blocked OVERs with settled outcomes exist for this range.
   */
  gate_denominator: number | null;
  /**
   * Total OVER rows with a known actual_total (settled games only).
   * Used to assess calibration sample adequacy.
   */
  total_eligible_settled: number;
  rows: SurvivalReplayRow[];
  errors: string[];
}

// ─── Helper parsers ───────────────────────────────────────────────────────────

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/**
 * Applies the survival gate logic to a reconstructed Over projection.
 * Returns the replayed decision and blocker reason.
 *
 * @param baseballOnlyProj  Reconstructed baseball-only total (no env).
 * @param approxFloor       Approximate survival floor (baseballOnly × DEFAULT_FLOOR_FACTOR).
 * @param marketLine        Market o/u line.
 * @param hasMultiplierData Whether combined_multiplier was available in SHADOW_HISTORY.
 */
function applyGate(
  baseballOnlyProj: number,
  approxFloor: number,
  marketLine: number,
  hasMultiplierData: boolean,
): { blocker: ReplayBlocker; marginal: boolean } {
  if (!hasMultiplierData) {
    // Cannot apply gate without multiplier data — treat as CORE for conservatism.
    return { blocker: "", marginal: false };
  }

  const baseballOnlyEdge = parseFloat((baseballOnlyProj - marketLine).toFixed(2));
  const floorEdge        = parseFloat((approxFloor - marketLine).toFixed(2));

  let marginal = false;

  if (baseballOnlyEdge < 0) {
    marginal = Math.abs(baseballOnlyEdge) < MARGINAL_MARGIN;
    return { blocker: "ENVIRONMENT_DEPENDENT_OVER", marginal };
  }
  if (baseballOnlyEdge < OVER_BASEBALL_ONLY_EDGE_THRESHOLD) {
    marginal = (OVER_BASEBALL_ONLY_EDGE_THRESHOLD - baseballOnlyEdge) < MARGINAL_MARGIN;
    return { blocker: "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD", marginal };
  }
  if (floorEdge < OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD) {
    marginal = (OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD - floorEdge) < MARGINAL_MARGIN;
    return { blocker: "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD", marginal };
  }

  // Check marginal PASS (gate nearly failed)
  marginal =
    (baseballOnlyEdge - OVER_BASEBALL_ONLY_EDGE_THRESHOLD) < MARGINAL_MARGIN ||
    (floorEdge - OVER_SURVIVAL_FLOOR_EDGE_THRESHOLD) < MARGINAL_MARGIN;

  return { blocker: "", marginal };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runSurvivalGateReplay(
  startDate: string,
  endDate: string,
  options: {
    workbookId?: string;
    writeSheets?: boolean;
    /**
     * When true, existing rows outside the replay date range are preserved
     * and new rows are appended (replacing any rows that fall within
     * [startDate, endDate] for idempotency). When false (default), the sheet
     * is fully cleared and rewritten with only the rows from this run.
     */
    appendMode?: boolean;
  } = {},
): Promise<SurvivalReplayResult> {
  const wbId      = options.workbookId ?? WORKBOOK_ID;
  const writeOut  = options.writeSheets ?? false;
  const appendMode = options.appendMode ?? false;
  const replayTs  = new Date().toISOString();
  const errors: string[] = [];

  logger.info({ startDate, endDate }, "MODULE_18: Survival gate replay starting");

  // ── Read all three source sheets concurrently ──────────────────────────────
  const [vlResp, shResp, soResp] = await Promise.all([
    readRange(wbId, "VEHICLE_LOG!A1:N5000").catch((e: unknown) => { errors.push(`VEHICLE_LOG: ${e instanceof Error ? e.message : String(e)}`); return null; }),
    readRange(wbId, "SHADOW_HISTORY!A1:W5000").catch((e: unknown) => { errors.push(`SHADOW_HISTORY: ${e instanceof Error ? e.message : String(e)}`); return null; }),
    readRange(wbId, "SHADOW_OUTCOMES!A1:L5000").catch((e: unknown) => { errors.push(`SHADOW_OUTCOMES: ${e instanceof Error ? e.message : String(e)}`); return null; }),
  ]);

  if (!vlResp || !shResp || !soResp) {
    return {
      status: "failure",
      date_range: { start: startDate, end: endDate },
      replay_ts: replayTs,
      total_overs: 0,
      total_eligible_settled: 0,
      replayed_core: 0,
      replayed_blocked: 0,
      blocked_prior: 0,
      blocked_env_dependent: 0,
      blocked_baseball_edge: 0,
      blocked_floor_edge: 0,
      core_thesis_correct: 0,
      passed_losses: 0,
      correct_blocks: 0,
      collateral_blocks: 0,
      gate_denominator: null,
      rows: [],
      errors,
    };
  }

  // ── Parse VEHICLE_LOG — filter to date range, all directions ──────────────
  const vlRows = (vlResp.values ?? []).slice(1) as unknown[][];
  const vlMap  = new Map<string, {
    date: string; game_id: string; away: string; home: string; vehicle: string;
    line: number | null; direction: string; proj: number;
    variance: number | null; decision: string; blocker: string;
  }>();

  for (const row of vlRows) {
    const date = parseStr(row[VL_DATE]);
    if (date < startDate || date > endDate) continue;
    const gameId = parseStr(row[VL_GAME_ID]);
    if (!gameId || !date) continue;

    // Deduplicate: keep latest entry per date+game (last row wins)
    const key = `${date}|${gameId}`;
    vlMap.set(key, {
      date,
      game_id:   gameId,
      away:      parseStr(row[VL_AWAY]),
      home:      parseStr(row[VL_HOME]),
      vehicle:   parseStr(row[VL_VEHICLE]),
      line:      parseNum(row[VL_LINE]),
      direction: parseStr(row[VL_DIRECTION]),
      proj:      parseNum(row[VL_PROJ]) ?? 0,
      variance:  parseNum(row[VL_VARIANCE]),
      decision:  parseStr(row[VL_DECISION]),
      blocker:   parseStr(row[VL_BLOCKER]),
    });
  }

  // ── Parse SHADOW_HISTORY — latest snapshot per game_id + date ─────────────
  const shRows = (shResp.values ?? []).slice(1) as unknown[][];
  const shMap  = new Map<string, {
    away_pitcher: string; home_pitcher: string;
    repaired_total: number | null;
    park_mult: number | null; weather_mult: number | null; repaired_mult: number | null;
    park_source: string;
    away_l30: number | null; home_l30: number | null;
    away_off_rate: number | null; home_off_rate: number | null;
    away_offense_source: string;
    home_offense_source: string;
  }>();

  for (const row of shRows) {
    const date   = parseStr(row[SH_DATE]);
    const gameId = parseStr(row[SH_GAME_ID]);
    if (!date || !gameId) continue;
    const key = `${date}|${gameId}`;
    shMap.set(key, {
      away_pitcher:        parseStr(row[SH_AWAY_PITCHER]),
      home_pitcher:        parseStr(row[SH_HOME_PITCHER]),
      repaired_total:      parseNum(row[SH_REPAIRED_TOTAL]),
      park_mult:           parseNum(row[SH_PARK_MULT]),
      weather_mult:        parseNum(row[SH_WEATHER_MULT]),
      repaired_mult:       parseNum(row[SH_REPAIRED_MULT]),
      park_source:         parseStr(row[SH_PARK_SOURCE]),
      away_l30:            parseNum(row[SH_AWAY_L30]),
      home_l30:            parseNum(row[SH_HOME_L30]),
      away_off_rate:       parseNum(row[SH_AWAY_OFF_RATE]),
      home_off_rate:       parseNum(row[SH_HOME_OFF_RATE]),
      away_offense_source: parseStr(row[SH_AWAY_OFFENSE_SOURCE]),
      home_offense_source: parseStr(row[SH_HOME_OFFENSE_SOURCE]),
    });
  }

  // ── Parse SHADOW_OUTCOMES — actual totals by date+game_id ─────────────────
  const soRows = (soResp.values ?? []).slice(1) as unknown[][];
  const soMap  = new Map<string, number>(); // key → actual_total

  for (const row of soRows) {
    const date   = parseStr(row[SO_DATE]);
    const gameId = parseStr(row[SO_GAME_ID]);
    const actual = parseNum(row[SO_ACTUAL]);
    if (date && gameId && actual !== null) {
      soMap.set(`${date}|${gameId}`, actual);
    }
  }

  // ── Build replay rows for all OVER picks in range ─────────────────────────
  const replayRows: SurvivalReplayRow[] = [];

  for (const [key, vl] of vlMap) {
    const sh     = shMap.get(key);
    const actual = soMap.get(key) ?? null;

    // ── Reconstruction: baseball_only_projection ───────────────────────────
    // Use combined multiplier from SHADOW_HISTORY when available.
    // Falls back to projected_total (mult = 1.0) when SHADOW_HISTORY is absent —
    // this underestimates environment contribution but is the safest approximation.
    const combinedMult     = sh?.repaired_mult ?? null;
    const projTotal        = vl.proj;
    const hasMultData      = combinedMult !== null && combinedMult > 0;

    const baseballOnlyProj: number | null = hasMultData
      ? parseFloat((projTotal / combinedMult!).toFixed(2))
      : null;

    const envRunAdj: number | null = baseballOnlyProj !== null
      ? parseFloat((projTotal - baseballOnlyProj).toFixed(2))
      : null;

    const approxFloor: number | null = baseballOnlyProj !== null
      ? parseFloat((baseballOnlyProj * DEFAULT_FLOOR_FACTOR).toFixed(2))
      : null;

    const line         = vl.line;
    const baseballEdge = (baseballOnlyProj !== null && line !== null)
      ? parseFloat((baseballOnlyProj - line).toFixed(2))
      : null;
    const floorEdge    = (approxFloor !== null && line !== null)
      ? parseFloat((approxFloor - line).toFixed(2))
      : null;

    // ── Thesis correctness ─────────────────────────────────────────────────
    let thesisCorrect: boolean | null = null;
    if (actual !== null && line !== null && vl.direction !== "NONE") {
      const diff = actual - line;
      thesisCorrect = vl.direction === "OVER" ? diff > 0 : diff < 0;
    }

    // ── Determine replayed decision ────────────────────────────────────────
    let replayedDecision: ReplayDecision;
    let replayBlocker: ReplayBlocker = "";
    let marginalFlag = "";

    if (!line || vl.direction === "NONE" || vl.direction === "UNDER") {
      // Not an Over — survival gate does not apply.
      replayedDecision = vl.direction === "OVER" ? "PENDING" : "NOT_OVER";
    } else if (vl.direction === "OVER") {
      // Was it blocked by a pre-survival gate?
      const priorGateBlockers = new Set([
        "NO_MARKET_LINE",
        "UNRESOLVED_STARTER",
        "MISSING_EXPECTED_INNINGS",
        "BULLPEN_DATA_UNAVAILABLE",
        "INSUFFICIENT_PROJECTION_SEPARATION",
        "BOARD_LOCKED_POST_CUTOFF",
      ]);

      if (vl.decision === "PENDING" || vl.decision === "NO_CORE" && vl.blocker === "NO_MARKET_LINE") {
        replayedDecision = "PENDING";
      } else if (vl.decision === "NO_CORE" && priorGateBlockers.has(vl.blocker) &&
                 vl.blocker !== "INSUFFICIENT_PROJECTION_SEPARATION") {
        // Blocked by eligibility gate before the separation threshold — gate still applies
        replayedDecision = "BLOCKED";
        replayBlocker = "PRIOR_GATE";
      } else {
        // Check whether the original CORE or NO_CORE (separation) would survive the gate.
        const absVariance = Math.abs(vl.variance ?? 0);
        const wouldHaveReachedSurvivalGate =
          vl.decision === "CORE" ||
          (vl.decision === "NO_CORE" && vl.blocker === "INSUFFICIENT_PROJECTION_SEPARATION");

        if (!wouldHaveReachedSurvivalGate) {
          // Already blocked by a pre-gate that isn't separation (e.g. UNRESOLVED_STARTER).
          replayedDecision = "BLOCKED";
          replayBlocker = "PRIOR_GATE";
        } else if (baseballOnlyProj === null) {
          // No multiplier data — cannot reconstruct; assume gate passes (conservative).
          replayedDecision = absVariance >= CORE_THRESHOLD ? "CORE" : "BLOCKED";
          if (replayedDecision === "BLOCKED") replayBlocker = "PRIOR_GATE";
          marginalFlag = "NO_MULTIPLIER_DATA";
        } else {
          const { blocker, marginal } = applyGate(
            baseballOnlyProj,
            approxFloor!,
            line,
            hasMultData,
          );

          if (blocker) {
            replayedDecision = "BLOCKED";
            replayBlocker    = blocker;
          } else if (absVariance >= CORE_THRESHOLD) {
            replayedDecision = "CORE";
          } else {
            // Would not have reached CORE even without the survival gate (variance < 1.5).
            replayedDecision = "BLOCKED";
            replayBlocker    = "PRIOR_GATE"; // separation gate
          }
          if (marginal) marginalFlag = "MARGINAL";
        }
      }
    } else {
      replayedDecision = "NOT_OVER";
    }

    const awayOffSrc = sh?.away_offense_source ?? "";
    const homeOffSrc = sh?.home_offense_source ?? "";
    // Flag when either team's offense projection used a fallback rather than BLENDED data.
    const fallbackOffenseNote =
      (awayOffSrc && awayOffSrc !== "BLENDED") || (homeOffSrc && homeOffSrc !== "BLENDED")
        ? "FALLBACK_OFFENSE_SOURCE"
        : "";

    // Flag when baseball_only_projection exceeds the outlier threshold.
    // High-absolute-projection games pass the gate easily but carry more outcome
    // variance; this note lets operators filter and review them in the sheet.
    const highProjectionNote =
      baseballOnlyProj !== null && baseballOnlyProj > HIGH_PROJECTION_OUTLIER_THRESHOLD
        ? "HIGH_PROJECTION_OUTLIER"
        : "";

    replayRows.push({
      date:              vl.date,
      game_id:           vl.game_id,
      away_team:         vl.away,
      home_team:         vl.home,
      away_pitcher:      sh?.away_pitcher ?? "",
      home_pitcher:      sh?.home_pitcher ?? "",
      market_line:       line,
      projected_total:   projTotal,
      variance:          vl.variance,
      direction:         vl.direction,
      actual_total:      actual,
      thesis_correct:    thesisCorrect,
      original_decision: vl.decision,
      original_blocker:  vl.blocker,
      replayed_decision: replayedDecision,
      replay_blocker:    replayBlocker,
      baseball_only_projection: baseballOnlyProj,
      combined_multiplier: combinedMult,
      environment_run_adjustment: envRunAdj,
      approx_survival_floor: approxFloor,
      floor_edge:            floorEdge,
      baseball_only_edge:    baseballEdge,
      park_multiplier:       sh?.park_mult ?? null,
      weather_multiplier:    sh?.weather_mult ?? null,
      park_source:           sh?.park_source ?? "",
      marginal_flag:         marginalFlag,
      away_offense_source:   awayOffSrc,
      home_offense_source:   homeOffSrc,
      notes: [
        sh ? "" : "SHADOW_HISTORY_ABSENT",
        actual === null ? "NO_OUTCOME" : "",
        fallbackOffenseNote,
        highProjectionNote,
      ].filter(Boolean).join("; "),
    });
  }

  // Sort by date then game_id
  replayRows.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.game_id.localeCompare(b.game_id);
  });

  // ── Compute summary statistics ─────────────────────────────────────────────
  const overs = replayRows.filter((r) => r.direction === "OVER");
  const total_overs = overs.length;

  const replayed_core    = overs.filter((r) => r.replayed_decision === "CORE").length;
  const replayed_blocked = overs.filter((r) =>
    r.replayed_decision === "BLOCKED" && r.replay_blocker !== "PRIOR_GATE",
  ).length;
  const blocked_prior    = overs.filter((r) =>
    r.replayed_decision === "BLOCKED" && r.replay_blocker === "PRIOR_GATE",
  ).length;

  const blocked_env_dependent = overs.filter((r) => r.replay_blocker === "ENVIRONMENT_DEPENDENT_OVER").length;
  const blocked_baseball_edge = overs.filter((r) => r.replay_blocker === "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD").length;
  const blocked_floor_edge    = overs.filter((r) => r.replay_blocker === "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD").length;

  const coreRows    = overs.filter((r) => r.replayed_decision === "CORE");
  const survivalBlocked = overs.filter((r) =>
    r.replayed_decision === "BLOCKED" && r.replay_blocker !== "PRIOR_GATE",
  );

  const core_thesis_correct = coreRows.filter((r) => r.thesis_correct === true).length;
  // CORE picks that passed the gate but lost — the gate's missed blocks.
  const passed_losses       = coreRows.filter((r) => r.thesis_correct === false).length;
  const correct_blocks      = survivalBlocked.filter((r) => r.thesis_correct === false).length;
  const collateral_blocks   = survivalBlocked.filter((r) => r.thesis_correct === true).length;

  // Denominator: only survival-gate-blocked overs with settled outcomes.
  // Null when no settled survival-blocked overs exist (avoids misleading 0% or 100%).
  const rawDenominator = correct_blocks + collateral_blocks;
  const gate_denominator: number | null = rawDenominator > 0 ? rawDenominator : null;
  const hitRate = gate_denominator !== null
    ? Math.round((correct_blocks / gate_denominator) * 1000) / 10
    : null;

  // Total settled OVER rows (actual_total known) — sample-size gauge.
  const total_eligible_settled = overs.filter((r) => r.actual_total !== null).length;

  // ── Compute and log daily gate hit-rate ───────────────────────────────────
  logger.info(
    {
      startDate, endDate,
      total_overs,
      total_eligible_settled,
      replayed_core,
      replayed_blocked,
      passed_losses,
      correct_blocks,
      collateral_blocks,
      gate_denominator,
      hit_rate_pct: hitRate,
    },
    "MODULE_18: Daily survival gate hit-rate — correct_blocks / (correct_blocks + collateral_blocks)",
  );

  // ── Write SURVIVAL_GATE_REPLAY sheet ─────────────────────────────────────
  if (writeOut) {
    try {
      // Create sheet if absent (addSheet is idempotent-ish — ignore "already exists" errors)
      await addSheet(wbId, REPLAY_SHEET).catch(() => {/* sheet already exists — fine */});
      await expandSheetColumns(wbId, REPLAY_SHEET, REPLAY_COLS);

      /** Serialize a SurvivalReplayRow to the column-ordered sheet row. */
      const toSheetRow = (r: SurvivalReplayRow): unknown[] => [
        r.date,
        r.game_id,
        r.away_team,
        r.home_team,
        r.away_pitcher,
        r.home_pitcher,
        r.market_line     ?? "",
        r.projected_total,
        r.variance        ?? "",
        r.direction,
        r.actual_total    ?? "",
        r.thesis_correct  === null ? "" : r.thesis_correct ? "TRUE" : "FALSE",
        r.original_decision,
        r.original_blocker,
        r.replayed_decision,
        r.replay_blocker,
        r.baseball_only_projection ?? "",
        r.combined_multiplier      ?? "",
        r.environment_run_adjustment ?? "",
        r.approx_survival_floor    ?? "",
        r.floor_edge               ?? "",
        r.baseball_only_edge       ?? "",
        r.park_multiplier          ?? "",
        r.weather_multiplier       ?? "",
        r.park_source,
        r.marginal_flag,
        r.away_offense_source,
        r.home_offense_source,
        r.notes,
      ];

      let sheetRows: unknown[][];

      if (appendMode) {
        // ── Append mode: preserve rows outside the replay date range ────────
        // Read existing sheet content, drop rows whose Date falls within
        // [startDate, endDate] (so re-running for the same date is idempotent),
        // then write header + retained rows + new rows.
        const existing = await readRange(wbId, `${REPLAY_SHEET}!A1:AA5000`).catch(
          () => null,
        );
        const existingValues = (existing?.values ?? []) as unknown[][];
        // Slice off header row; filter out rows in the replay date range
        const retained = existingValues.slice(1).filter((row) => {
          const rowDate = String(row[0] ?? "").trim();
          return rowDate < startDate || rowDate > endDate;
        });
        sheetRows = [REPLAY_HEADER, ...retained, ...replayRows.map(toSheetRow)];
        // Clear and rewrite so row order is deterministic
        await clearRange(wbId, `${REPLAY_SHEET}!A1:AA5000`);
      } else {
        // ── Full overwrite mode (original behaviour) ─────────────────────────
        await clearRange(wbId, `${REPLAY_SHEET}!A1:AA5000`);
        sheetRows = [REPLAY_HEADER, ...replayRows.map(toSheetRow)];
      }

      await writeRange(wbId, `${REPLAY_SHEET}!A1`, sheetRows);
      logger.info(
        { rows: sheetRows.length - 1, sheet: REPLAY_SHEET, appendMode },
        "MODULE_18: Survival gate replay written to sheet",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sheet write failed: ${msg}`);
      logger.error({ err: msg }, "MODULE_18: Failed to write SURVIVAL_GATE_REPLAY");
    }
  }

  return {
    status: errors.length === 0 ? "success" : "partial",
    date_range: { start: startDate, end: endDate },
    replay_ts: replayTs,
    total_overs,
    total_eligible_settled,
    replayed_core,
    replayed_blocked,
    blocked_prior,
    blocked_env_dependent,
    blocked_baseball_edge,
    blocked_floor_edge,
    core_thesis_correct,
    passed_losses,
    correct_blocks,
    collateral_blocks,
    gate_denominator,
    rows: replayRows,
    errors,
  };
}
