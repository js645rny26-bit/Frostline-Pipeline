/**
 * Module 09s: Statcast Preview Shadow Audit
 *
 * Computes per-game estimated projection adjustments driven by Baseball Savant
 * starter xwOBA-allowed and hitter traffic/damage shape, then writes them to the
 * STATCAST_SHADOW_AUDIT sheet.
 *
 * Shadow semantics (fail-closed to zero projection influence):
 *   - Does NOT modify live board projections.
 *   - Does NOT affect CORE/NO_CORE decisions or authorization.
 *   - Preview_Used_In_Projection = "NO" throughout Phase 3.
 *   - Any error is caught; the full pipeline continues unaffected.
 *
 * Primary shadow signal: starter xwOBA allowed
 *   xwobaQualFactor = clamp(xwoba_allowed / LEAGUE_AVG_XWOBA_ALLOWED, 0.70, 1.40)
 *   shadowQual      = currentQual × (1 − SHADOW_BLEND_WEIGHT) + xwobaQualFactor × SHADOW_BLEND_WEIGHT
 *   deltaRuns       = adjOffRate × (starterIP / 9) × (shadowQual − currentQual)
 *   total adj       = clamp(Δ, −SHADOW_ADJUSTMENT_CAP, +SHADOW_ADJUSTMENT_CAP)
 *
 * Excluded signals and full double-counting audit: see docs/statcast-shadow-mapping.md.
 */

import { writeRange, readRange, addSheet, clearRange, WORKBOOK_ID } from "../sheets/client.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type {
  StatcastPreviewResult,
  StatcastPreviewGameResult,
} from "./module02e_statcastPreview.js";

// ─── Constants (exported for tests and documentation) ─────────────────────────

/** League-average xwOBA allowed; normalises the xwOBA quality factor to a 1.0 baseline. */
export const LEAGUE_AVG_XWOBA_ALLOWED = 0.315;

/**
 * Blend weight for the xwOBA quality signal.
 * Conservative because xwOBA allowed is partially correlated with FIP (both
 * capture true pitcher quality).  At 0.25 the signal adds contact-quality
 * information without amplifying FIP a second time.
 */
export const SHADOW_BLEND_WEIGHT = 0.25;

/**
 * Maximum total shadow adjustment per game (runs).
 * Prevents a single game with extreme Statcast data from producing an
 * implausible shadow projection.
 */
export const SHADOW_ADJUSTMENT_CAP = 0.30;

/** League baselines used to turn preview hitter shape into signed run estimates. */
export const LEAGUE_AVG_HITTER_BB_PCT = 8.5;
export const LEAGUE_AVG_HITTER_K_PCT = 22.5;
export const LEAGUE_AVG_HITTER_HARD_HIT_PCT = 38.5;

/** Per-team and per-game clamps for the inexpensive tail estimates. */
export const SHADOW_TAIL_TEAM_CAP = 0.35;
export const SHADOW_TAIL_GAME_CAP = 0.60;

/**
 * Shadow-only low-center calibration regime. The 2026-08-12/13/15/17
 * prospective sample showed materially fatter upward residuals when the
 * active total was below eight runs. These values are evidence accumulators,
 * not live projection coefficients or authorization inputs.
 */
export const LOW_CENTER_VOLATILITY_THRESHOLD = 8.0;
export const LOW_CENTER_CHALLENGER_LIFT = 1.5;
export const LOW_CENTER_SENSITIVITY_LIFT = 2.0;
export const LOW_CENTER_UPPER_TAIL_RESIDUAL = 8.09;

const SHADOW_SHEET = "STATCAST_SHADOW_AUDIT";
const LOW_CENTER_HISTORY_SHEET = "LOW_CENTER_CALIBRATION_HISTORY";
const COLLISION_HISTORY_SHEET = "COLLISION_CALIBRATION_HISTORY";
const DEFAULT_STARTER_IP = 5.5;

const LOW_CENTER_HISTORY_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Projection", "Primary_Challenger_Projection", "Sensitivity_Challenger_Projection",
  "Upper_Tail_Band", "Snapshot_TS",
];

/**
 * Immutable, prospective record of the existing Statcast collision candidate.
 * The candidate is intentionally kept separate from STATCAST_SHADOW_AUDIT,
 * which is a replace-on-refresh operational view.  Settlement must read this
 * surface rather than recreating a completed game's Savant data later.
 */
export const COLLISION_CALIBRATION_HISTORY_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Away_Projection", "Base_Home_Projection", "Base_Projection",
  "Collision_Away_Evidence_Projection", "Collision_Home_Evidence_Projection",
  "xwOBA_Shadow_Projection", "Traffic_Conversion_Estimate", "HR_XBH_Damage_Estimate",
  "Combined_Tail_Adjustment", "Collision_Estimated_Projection",
  "Preview_Availability", "Tail_Estimate_Status", "Candidate_Status", "Snapshot_TS",
  // Component allocations are ledger evidence only. Appending them preserves
  // all pre-v30 records without changing the meaning of existing columns.
  "xwOBA_Away_Evidence_Projection", "xwOBA_Home_Evidence_Projection",
  "Traffic_Away_Evidence_Projection", "Traffic_Home_Evidence_Projection",
  "Damage_Away_Evidence_Projection", "Damage_Home_Evidence_Projection",
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShadowAuditRow {
  game_id: string;
  date: string;
  away_team: string;
  home_team: string;
  away_pitcher: string;
  home_pitcher: string;
  /** Preview_Availability from STATCAST_GAME_PREVIEW, or "UNAVAILABLE" when not in result set. */
  preview_availability: string;
  /** Preserved to make collision allocation evidence auditable at settlement. */
  base_away_projection: number;
  base_home_projection: number;
  current_projection: number;
  /** Uncapped xwOBA shadow adjustment (runs). Positive = more runs than current model. */
  shadow_xwoba_adjustment: number;
  /** current_projection + capped adjustment. Shadow-only — not used in any live calculation. */
  shadow_projection: number;
  /** True when |uncapped adjustment| exceeded SHADOW_ADJUSTMENT_CAP. */
  cap_applied: boolean;
  away_pitcher_xwoba: number | null;
  away_pitcher_shadow_quality: number | null;
  away_pitcher_current_quality: number;
  home_pitcher_xwoba: number | null;
  home_pitcher_shadow_quality: number | null;
  home_pitcher_current_quality: number;
  /** Run delta contributed by changing the HOME pitcher quality (affects AWAY run scoring). */
  away_starter_delta: number;
  /** Run delta contributed by changing the AWAY pitcher quality (affects HOME run scoring). */
  home_starter_delta: number;
  /** Signed run estimate from hitter walk/strikeout opportunity shape. */
  away_traffic_adjustment: number;
  home_traffic_adjustment: number;
  traffic_conversion_estimate: number;
  /** Signed run estimate from hitter hard-hit contact shape. */
  away_damage_adjustment: number;
  home_damage_adjustment: number;
  hr_xbh_damage_estimate: number;
  /** Capped sum of traffic and damage estimates. */
  combined_tail_adjustment: number;
  /** Current projection plus starter xwOBA and hitter-tail estimates. */
  estimated_projection: number;
  /** Team-level evidence overlays. These are not active team projections. */
  collision_away_evidence_projection: number;
  collision_home_evidence_projection: number;
  tail_cap_applied: boolean;
  tail_estimate_status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  /** Shadow-only flag; never consumed by Module 09, the board, or authorization. */
  low_center_volatility_flag: "LOW_CENTER_VOLATILITY" | "STANDARD_RANGE";
  /** Current projection + LOW_CENTER_CHALLENGER_LIFT when flagged; null otherwise. */
  low_center_challenger_projection: number | null;
  /** Current projection + LOW_CENTER_SENSITIVITY_LIFT when flagged; null otherwise. */
  low_center_sensitivity_projection: number | null;
  /** Current projection + observed shadow upper-tail residual when flagged; null otherwise. */
  low_center_upper_tail_band: number | null;
  /** Observed residual behind the shadow upper-tail band; null outside the low-center regime. */
  low_center_upper_tail_residual: number | null;
  /** Transparent, descriptive tags; they do not create an automated thesis. */
  low_center_reason_tags: string[];
  missing_fields: string[];
  identity_warnings: string[];
  preview_used_in_projection: "NO";
  snapshot_ts: string;
}

export interface StatcastShadowResult {
  status: "success" | "partial" | "skipped";
  write_timestamp_utc: string;
  rows_computed: number;
  rows_written: number;
  collision_history_rows_written: number;
  errors: string[];
  shadow_rows: ShadowAuditRow[];
}

/**
 * One current prospective row per Date + Game_ID. Reruns before first pitch
 * replace the candidate rather than appending a second pseudo-snapshot. This
 * preserves the most recent legitimate pregame state while keeping the
 * history surface usable for settlement joins.
 */
export function upsertLowCenterCalibrationHistory(
  existingRows: unknown[][],
  incomingRows: unknown[][],
): unknown[][] {
  const byKey = new Map<string, unknown[]>();
  const order: string[] = [];
  const add = (row: unknown[]) => {
    const rowKey = `${String(row[0] ?? "").trim()}|${String(row[1] ?? "").trim()}`;
    if (!rowKey || rowKey === "|") return;
    if (!byKey.has(rowKey)) order.push(rowKey);
    byKey.set(rowKey, [...row]);
  };
  for (const row of existingRows) add(row);
  for (const row of incomingRows) add(row);
  return order.map((rowKey) => byKey.get(rowKey)!);
}

/** One mutable prospective collision record per Date + Game_ID. */
export function upsertCollisionCalibrationHistory(
  existingRows: unknown[][],
  incomingRows: unknown[][],
): unknown[][] {
  const byKey = new Map<string, unknown[]>();
  const order: string[] = [];
  const add = (row: unknown[]) => {
    const key = `${String(row[0] ?? "").trim()}|${String(row[1] ?? "").trim()}`;
    if (key === "|") return;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, [...row]);
  };
  for (const row of existingRows) add(row);
  for (const row of incomingRows) add(row);
  return order.map((key) => byKey.get(key)!);
}

/** Name-based migration used when the prospective collision ledger gains a column. */
export function migrateCollisionCalibrationHistoryRows(
  previousHeader: unknown[],
  previousRows: unknown[][],
): unknown[][] {
  const oldIndex = new Map(previousHeader.map((name, index) => [String(name ?? ""), index]));
  return previousRows.map((row) =>
    COLLISION_CALIBRATION_HISTORY_HEADERS.map((name) => {
      const index = oldIndex.get(name);
      return index === undefined ? "" : row[index] ?? "";
    }),
  );
}

// ─── Pure computation (exported for tests) ────────────────────────────────────

function clampQual(v: number): number {
  return Math.max(0.40, Math.min(1.80, v));
}

function clampSigned(v: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, v));
}

/**
 * Estimate a signed traffic-conversion run adjustment from walk and strikeout
 * rates. Walks above the league baseline and strikeouts below it increase the
 * opportunity index. Missing or invalid inputs return null instead of inventing
 * a value.
 */
export function estimateTrafficAdjustment(
  projectedRuns: number,
  bbPct: number | null,
  kPct: number | null,
): number | null {
  if (bbPct === null || kPct === null || kPct <= 0 || projectedRuns < 0) return null;
  const opportunityIndex = (
    (bbPct / LEAGUE_AVG_HITTER_BB_PCT) +
    (LEAGUE_AVG_HITTER_K_PCT / kPct)
  ) / 2;
  return parseFloat(
    clampSigned(projectedRuns * (opportunityIndex - 1), SHADOW_TAIL_TEAM_CAP).toFixed(4),
  );
}

/** Estimate a signed HR/XBH run adjustment from hard-hit rate. */
export function estimateDamageAdjustment(
  projectedRuns: number,
  hardHitPct: number | null,
): number | null {
  if (hardHitPct === null || projectedRuns < 0) return null;
  const damageIndex = hardHitPct / LEAGUE_AVG_HITTER_HARD_HIT_PCT;
  return parseFloat(
    clampSigned(projectedRuns * (damageIndex - 1), SHADOW_TAIL_TEAM_CAP).toFixed(4),
  );
}

/**
 * Derive the xwOBA-based quality factor for a starter.
 * Factor > 1.0 means the pitcher allowed more contact quality than league average
 * → more runs; Factor < 1.0 means better-than-average contact suppression.
 * Returns null when data is unavailable or the pitcher didn't qualify.
 */
export function xwobaQualityFactor(
  xwoba: number | null,
  didNotQualify: boolean,
): number | null {
  if (xwoba === null || didNotQualify) return null;
  return clampQual(xwoba / LEAGUE_AVG_XWOBA_ALLOWED);
}

/**
 * Blend the current FIP/ERA-based quality factor with the xwOBA-based factor.
 * Returns null when the xwOBA factor is unavailable (shadow delta = 0 for that side).
 */
export function shadowStarterQuality(
  currentQual: number,
  xwobaFactor: number | null,
): number | null {
  if (xwobaFactor === null) return null;
  const blended =
    currentQual * (1 - SHADOW_BLEND_WEIGHT) + xwobaFactor * SHADOW_BLEND_WEIGHT;
  return parseFloat(clampQual(blended).toFixed(4));
}

/**
 * Compute the shadow audit row for one game.
 *
 * Run-scoring attribution:
 *   - Away runs are generated by the AWAY offense against the HOME pitcher.
 *     awayDelta = awayAdjRate × (homeIP/9) × (shadowHomeQual − currentHomeQual)
 *   - Home runs are generated by the HOME offense against the AWAY pitcher.
 *     homeDelta = homeAdjRate × (awayIP/9) × (shadowAwayQual − currentAwayQual)
 *
 * Pure function — no I/O.
 */
export function computeShadowAuditRow(
  summary: GameSummaryRow,
  preview: StatcastPreviewGameResult | null,
  snapshotTs: string,
): ShadowAuditRow {
  const missing: string[] = [];
  const identityWarnings: string[] = [];
  const previewAvailability = preview?.preview_availability ?? "UNAVAILABLE";

  // Pitcher stats are only valid when the preview page was actually AVAILABLE.
  // A NOT_PUBLISHED or FETCH_ERROR preview may carry a partial object; ignore it.
  const statsAvailable   = previewAvailability === "AVAILABLE";
  const awayPitcherStats = statsAvailable ? (preview?.away_pitcher_stats ?? null) : null;
  const homePitcherStats = statsAvailable ? (preview?.home_pitcher_stats ?? null) : null;
  const awayDidNotQual   = awayPitcherStats?.did_not_qualify ?? true;
  const homeDidNotQual   = homePitcherStats?.did_not_qualify ?? true;
  const awayXwoba        = awayPitcherStats?.xwoba ?? null;
  const homeXwoba        = homePitcherStats?.xwoba ?? null;

  // Track which fields are absent so the audit row is fully transparent.
  if (previewAvailability !== "AVAILABLE") {
    missing.push("preview_not_available");
  } else {
    if (awayXwoba === null || awayDidNotQual) missing.push("away_pitcher_xwoba");
    if (homeXwoba === null || homeDidNotQual) missing.push("home_pitcher_xwoba");
  }
  if (preview?.parse_warnings && preview.parse_warnings.length > 0) {
    identityWarnings.push(...preview.parse_warnings);
  }

  const awayXwobaFactor  = xwobaQualityFactor(awayXwoba, awayDidNotQual);
  const homeXwobaFactor  = xwobaQualityFactor(homeXwoba, homeDidNotQual);
  const awayShadowQual   = shadowStarterQuality(summary.away_starter_quality, awayXwobaFactor);
  const homeShadowQual   = shadowStarterQuality(summary.home_starter_quality, homeXwobaFactor);

  // Reconstruct lineup- and environment-adjusted offensive rates.
  // These match the awayAdjFinal / homeAdjFinal values computed in module09.
  const awayAdjRate = parseFloat(
    (summary.away_offense_rate_used * summary.combined_run_multiplier * summary.away_lineup_factor).toFixed(4),
  );
  const homeAdjRate = parseFloat(
    (summary.home_offense_rate_used * summary.combined_run_multiplier * summary.home_lineup_factor).toFixed(4),
  );

  const homeIP = summary.home_expected_innings ?? DEFAULT_STARTER_IP;
  const awayIP = summary.away_expected_innings ?? DEFAULT_STARTER_IP;

  // Away runs affected by the HOME pitcher quality:
  const awayDelta = homeShadowQual !== null
    ? parseFloat(
        (awayAdjRate * (homeIP / 9) * (homeShadowQual - summary.home_starter_quality)).toFixed(4),
      )
    : 0;

  // Home runs affected by the AWAY pitcher quality:
  const homeDelta = awayShadowQual !== null
    ? parseFloat(
        (homeAdjRate * (awayIP / 9) * (awayShadowQual - summary.away_starter_quality)).toFixed(4),
      )
    : 0;

  const totalUncapped = parseFloat((awayDelta + homeDelta).toFixed(4));
  const capApplied    = Math.abs(totalUncapped) > SHADOW_ADJUSTMENT_CAP;
  const cappedAdj     = capApplied
    ? parseFloat((Math.sign(totalUncapped) * SHADOW_ADJUSTMENT_CAP).toFixed(4))
    : totalUncapped;

  const awayTrafficRaw = statsAvailable
    ? estimateTrafficAdjustment(
        summary.projected_away_runs,
        preview?.away_hitters_bb_pct_avg ?? null,
        preview?.away_hitters_k_pct_avg ?? null,
      )
    : null;
  const homeTrafficRaw = statsAvailable
    ? estimateTrafficAdjustment(
        summary.projected_home_runs,
        preview?.home_hitters_bb_pct_avg ?? null,
        preview?.home_hitters_k_pct_avg ?? null,
      )
    : null;
  const awayDamageRaw = statsAvailable
    ? estimateDamageAdjustment(
        summary.projected_away_runs,
        preview?.away_hitters_hard_hit_avg ?? null,
      )
    : null;
  const homeDamageRaw = statsAvailable
    ? estimateDamageAdjustment(
        summary.projected_home_runs,
        preview?.home_hitters_hard_hit_avg ?? null,
      )
    : null;

  if (statsAvailable) {
    if (awayTrafficRaw === null) missing.push("away_hitter_traffic_shape");
    if (homeTrafficRaw === null) missing.push("home_hitter_traffic_shape");
    if (awayDamageRaw === null) missing.push("away_hitter_hard_hit");
    if (homeDamageRaw === null) missing.push("home_hitter_hard_hit");
  }

  const tailValues = [awayTrafficRaw, homeTrafficRaw, awayDamageRaw, homeDamageRaw];
  const availableTailValues = tailValues.filter((v): v is number => v !== null);
  const tailEstimateStatus: ShadowAuditRow["tail_estimate_status"] =
    availableTailValues.length === 4
      ? "AVAILABLE"
      : availableTailValues.length > 0
        ? "PARTIAL"
        : "UNAVAILABLE";
  const awayTraffic = awayTrafficRaw ?? 0;
  const homeTraffic = homeTrafficRaw ?? 0;
  const awayDamage = awayDamageRaw ?? 0;
  const homeDamage = homeDamageRaw ?? 0;
  const trafficEstimate = parseFloat((awayTraffic + homeTraffic).toFixed(4));
  const damageEstimate = parseFloat((awayDamage + homeDamage).toFixed(4));
  const tailUncapped = parseFloat((trafficEstimate + damageEstimate).toFixed(4));
  const tailCapApplied = Math.abs(tailUncapped) > SHADOW_TAIL_GAME_CAP;
  const combinedTailAdjustment = parseFloat(
    clampSigned(tailUncapped, SHADOW_TAIL_GAME_CAP).toFixed(4),
  );
  const shadowProjection = parseFloat((summary.projected_total_runs + cappedAdj).toFixed(2));
  // These are deliberately labelled evidence projections rather than live
  // allocations. The total candidate has an explicit game-level cap, while
  // these side views preserve which offense supplied each collision signal.
  const collisionAwayEvidenceProjection = parseFloat((
    summary.projected_away_runs + awayDelta + awayTraffic + awayDamage
  ).toFixed(2));
  const collisionHomeEvidenceProjection = parseFloat((
    summary.projected_home_runs + homeDelta + homeTraffic + homeDamage
  ).toFixed(2));

  const lowCenterVolatility = summary.projected_total_runs < LOW_CENTER_VOLATILITY_THRESHOLD;
  const lowCenterReasonTags: string[] = [];
  if (lowCenterVolatility) {
    lowCenterReasonTags.push("BASE_PROJECTION_LT_8");
    if (summary.away_starter_quality < 1 && summary.home_starter_quality < 1) {
      lowCenterReasonTags.push("BOTH_STARTERS_BELOW_LEAGUE_QUALITY");
    }
    if (summary.combined_run_multiplier < 1) {
      lowCenterReasonTags.push("SUB_NEUTRAL_ENVIRONMENT");
    }
    if (summary.roof_status === "CLOSED") {
      lowCenterReasonTags.push("CLOSED_ROOF");
    }
    if (combinedTailAdjustment <= 0) {
      lowCenterReasonTags.push("NO_POSITIVE_TAIL_ESTIMATE");
    }
    if (tailEstimateStatus !== "AVAILABLE") {
      lowCenterReasonTags.push("TAIL_ESTIMATE_INCOMPLETE");
    }
  }

  return {
    game_id:                      summary.game_id,
    date:                         summary.date,
    away_team:                    summary.away_team,
    home_team:                    summary.home_team,
    away_pitcher:                 summary.away_pitcher,
    home_pitcher:                 summary.home_pitcher,
    preview_availability:         previewAvailability,
    base_away_projection:         summary.projected_away_runs,
    base_home_projection:         summary.projected_home_runs,
    current_projection:           summary.projected_total_runs,
    shadow_xwoba_adjustment:      totalUncapped,
    shadow_projection:            shadowProjection,
    cap_applied:                  capApplied,
    away_pitcher_xwoba:           awayXwoba,
    away_pitcher_shadow_quality:  awayShadowQual,
    away_pitcher_current_quality: summary.away_starter_quality,
    home_pitcher_xwoba:           homeXwoba,
    home_pitcher_shadow_quality:  homeShadowQual,
    home_pitcher_current_quality: summary.home_starter_quality,
    away_starter_delta:           awayDelta,
    home_starter_delta:           homeDelta,
    away_traffic_adjustment:      awayTraffic,
    home_traffic_adjustment:      homeTraffic,
    traffic_conversion_estimate: trafficEstimate,
    away_damage_adjustment:       awayDamage,
    home_damage_adjustment:       homeDamage,
    hr_xbh_damage_estimate:       damageEstimate,
    combined_tail_adjustment:     combinedTailAdjustment,
    estimated_projection:         parseFloat((shadowProjection + combinedTailAdjustment).toFixed(2)),
    collision_away_evidence_projection: collisionAwayEvidenceProjection,
    collision_home_evidence_projection: collisionHomeEvidenceProjection,
    tail_cap_applied:              tailCapApplied,
    tail_estimate_status:          tailEstimateStatus,
    low_center_volatility_flag:    lowCenterVolatility ? "LOW_CENTER_VOLATILITY" : "STANDARD_RANGE",
    low_center_challenger_projection: lowCenterVolatility
      ? parseFloat((summary.projected_total_runs + LOW_CENTER_CHALLENGER_LIFT).toFixed(2))
      : null,
    low_center_sensitivity_projection: lowCenterVolatility
      ? parseFloat((summary.projected_total_runs + LOW_CENTER_SENSITIVITY_LIFT).toFixed(2))
      : null,
    low_center_upper_tail_band: lowCenterVolatility
      ? parseFloat((summary.projected_total_runs + LOW_CENTER_UPPER_TAIL_RESIDUAL).toFixed(2))
      : null,
    low_center_upper_tail_residual: lowCenterVolatility ? LOW_CENTER_UPPER_TAIL_RESIDUAL : null,
    low_center_reason_tags:        lowCenterReasonTags,
    missing_fields:               missing,
    identity_warnings:            identityWarnings,
    preview_used_in_projection:   "NO",
    snapshot_ts:                  snapshotTs,
  };
}

// ─── Sheet writer ──────────────────────────────────────────────────────────────

const SHADOW_AUDIT_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Away_Pitcher",
  "Home_Pitcher",
  "Preview_Availability",
  "Current_Projection",
  "Shadow_xwOBA_Adjustment",
  "Shadow_Projection",
  "Cap_Applied",
  "Away_Pitcher_xwOBA",
  "Away_Pitcher_Shadow_Quality",
  "Away_Pitcher_Current_Quality",
  "Home_Pitcher_xwOBA",
  "Home_Pitcher_Shadow_Quality",
  "Home_Pitcher_Current_Quality",
  "Away_Starter_Delta",
  "Home_Starter_Delta",
  "Missing_Fields",
  "Identity_Warnings",
  "Preview_Used_In_Projection",
  "Snapshot_TS",
  "Away_Traffic_Adjustment",
  "Home_Traffic_Adjustment",
  "Traffic_Conversion_Estimate",
  "Away_Damage_Adjustment",
  "Home_Damage_Adjustment",
  "HR_XBH_Damage_Estimate",
  "Combined_Tail_Adjustment",
  "Estimated_Projection",
  "Tail_Cap_Applied",
  "Tail_Estimate_Status",
  "Low_Center_Volatility_Flag",
  "Low_Center_Challenger_Projection",
  "Low_Center_Sensitivity_Projection",
  "Low_Center_Upper_Tail_Band",
  "Low_Center_Upper_Tail_Residual",
  "Low_Center_Reason_Tags",
  "Base_Away_Projection",
  "Base_Home_Projection",
  "Collision_Away_Evidence_Projection",
  "Collision_Home_Evidence_Projection",
];

async function ensureShadowAuditSheet(workbookId: string): Promise<void> {
  let sheetExists = true;
  try {
    const existing = await readRange(workbookId, `${SHADOW_SHEET}!A1:AQ1`);
    const headerRow = (existing.values?.[0] ?? []).map((c) => String(c ?? "").trim());
    const upToDate =
      headerRow.length >= SHADOW_AUDIT_HEADERS.length &&
      SHADOW_AUDIT_HEADERS.every((h, i) => headerRow[i] === h);
    if (!upToDate) {
      await writeRange(workbookId, `${SHADOW_SHEET}!A1`, [SHADOW_AUDIT_HEADERS]);
      logger.info("MODULE_09s: STATCAST_SHADOW_AUDIT headers written/refreshed");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Unable to parse range") || msg.includes("400")) {
      sheetExists = false;
    } else {
      throw err;
    }
  }
  if (!sheetExists) {
    await addSheet(workbookId, SHADOW_SHEET);
    await writeRange(workbookId, `${SHADOW_SHEET}!A1`, [SHADOW_AUDIT_HEADERS]);
    logger.info("MODULE_09s: STATCAST_SHADOW_AUDIT sheet created");
  }
}

function rowToArray(r: ShadowAuditRow): unknown[] {
  return [
    r.date,
    r.game_id,
    r.away_team,
    r.home_team,
    r.away_pitcher,
    r.home_pitcher,
    r.preview_availability,
    r.current_projection,
    r.shadow_xwoba_adjustment,
    r.shadow_projection,
    r.cap_applied ? "YES" : "NO",
    r.away_pitcher_xwoba ?? "",
    r.away_pitcher_shadow_quality ?? "",
    r.away_pitcher_current_quality,
    r.home_pitcher_xwoba ?? "",
    r.home_pitcher_shadow_quality ?? "",
    r.home_pitcher_current_quality,
    r.away_starter_delta,
    r.home_starter_delta,
    r.missing_fields.join("; "),
    r.identity_warnings.join("; "),
    r.preview_used_in_projection,
    r.snapshot_ts,
    r.away_traffic_adjustment,
    r.home_traffic_adjustment,
    r.traffic_conversion_estimate,
    r.away_damage_adjustment,
    r.home_damage_adjustment,
    r.hr_xbh_damage_estimate,
    r.combined_tail_adjustment,
    r.estimated_projection,
    r.tail_cap_applied ? "YES" : "NO",
    r.tail_estimate_status,
    r.low_center_volatility_flag,
    r.low_center_challenger_projection ?? "",
    r.low_center_sensitivity_projection ?? "",
    r.low_center_upper_tail_band ?? "",
    r.low_center_upper_tail_residual ?? "",
    r.low_center_reason_tags.join("; "),
    r.base_away_projection,
    r.base_home_projection,
    r.collision_away_evidence_projection,
    r.collision_home_evidence_projection,
  ];
}

/**
 * Append only legitimate pregame low-center candidates. This is deliberately
 * separate from the current-day audit sheet: settlement needs a durable,
 * timestamped prospective record after the daily sheet is replaced.
 */
async function appendLowCenterCalibrationHistory(
  workbookId: string,
  rows: ShadowAuditRow[],
  previewMap: Map<string, StatcastPreviewGameResult>,
  protection?: PublicationProtection,
): Promise<void> {
  const appendRows = rows
    .filter((row) => row.low_center_volatility_flag === "LOW_CENTER_VOLATILITY")
    .filter((row) => !protection?.protected_game_ids.has(row.game_id))
    .map((row) => [
      row.date,
      row.game_id,
      row.away_team,
      row.home_team,
      previewMap.get(row.game_id)?.scheduled_first_pitch ?? "",
      row.current_projection,
      row.low_center_challenger_projection ?? "",
      row.low_center_sensitivity_projection ?? "",
      row.low_center_upper_tail_band ?? "",
      row.snapshot_ts,
    ]);
  if (appendRows.length === 0) return;

  let existingRows: unknown[][];
  try {
    existingRows = (await readRange(workbookId, `${LOW_CENTER_HISTORY_SHEET}!A1:J10000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, LOW_CENTER_HISTORY_SHEET);
    existingRows = [];
  }
  const header = (existingRows[0] ?? []).map((value) => String(value ?? ""));
  if (header.join("|") !== LOW_CENTER_HISTORY_HEADERS.join("|")) {
    await writeRange(workbookId, `${LOW_CENTER_HISTORY_SHEET}!A1`, [LOW_CENTER_HISTORY_HEADERS]);
    existingRows = [LOW_CENTER_HISTORY_HEADERS];
  }
  const nextRows = upsertLowCenterCalibrationHistory(existingRows.slice(1), appendRows);
  // Clear stale duplicate tail rows before writing the canonical one-row-per-
  // game history. The reconstructed contents preserve every unique historical
  // candidate and replace only the current mutable game.
  await clearRange(workbookId, `${LOW_CENTER_HISTORY_SHEET}!A2:J10000`);
  await writeRange(workbookId, `${LOW_CENTER_HISTORY_SHEET}!A1`, [LOW_CENTER_HISTORY_HEADERS, ...nextRows]);
}

function collisionCandidateStatus(row: ShadowAuditRow): string {
  if (row.preview_availability !== "AVAILABLE") return "SOURCE_UNAVAILABLE";
  if (row.tail_estimate_status !== "AVAILABLE") return "INSUFFICIENT_INPUT";
  return "PROSPECTIVE_SHADOW_CANDIDATE";
}

/**
 * Freeze a real pre-first-pitch collision observation.  SOURCE_UNAVAILABLE
 * and INSUFFICIENT_INPUT are intentionally retained as explicit statuses;
 * their numerical zeroes must never be interpreted as neutral collision data.
 */
async function upsertCollisionCalibrationHistorySheet(
  workbookId: string,
  rows: ShadowAuditRow[],
  previewMap: Map<string, StatcastPreviewGameResult>,
  protection?: PublicationProtection,
): Promise<number> {
  const incoming = rows
    .filter((row) => !protection?.protected_game_ids.has(row.game_id))
    .flatMap((row): unknown[][] => {
      const scheduledFirstPitch = previewMap.get(row.game_id)?.scheduled_first_pitch ?? "";
      const firstPitchMs = Date.parse(scheduledFirstPitch);
      const snapshotMs = Date.parse(row.snapshot_ts);
      // Without both timestamps we cannot certify this as prospective. Do not
      // create a record that settlement might mistake for a real pregame row.
      if (!Number.isFinite(firstPitchMs) || !Number.isFinite(snapshotMs) || snapshotMs >= firstPitchMs) return [];
      return [[
        row.date, row.game_id, row.away_team, row.home_team, scheduledFirstPitch,
        row.base_away_projection, row.base_home_projection, row.current_projection,
        row.collision_away_evidence_projection, row.collision_home_evidence_projection,
        row.shadow_projection, row.traffic_conversion_estimate, row.hr_xbh_damage_estimate,
        row.combined_tail_adjustment, row.estimated_projection,
        row.preview_availability, row.tail_estimate_status, collisionCandidateStatus(row), row.snapshot_ts,
        parseFloat((row.base_away_projection + row.away_starter_delta).toFixed(2)),
        parseFloat((row.base_home_projection + row.home_starter_delta).toFixed(2)),
        parseFloat((row.base_away_projection + row.away_traffic_adjustment).toFixed(2)),
        parseFloat((row.base_home_projection + row.home_traffic_adjustment).toFixed(2)),
        parseFloat((row.base_away_projection + row.away_damage_adjustment).toFixed(2)),
        parseFloat((row.base_home_projection + row.home_damage_adjustment).toFixed(2)),
      ]];
    });
  if (incoming.length === 0) return 0;

  let existingRows: unknown[][];
  try {
    existingRows = (await readRange(workbookId, `${COLLISION_HISTORY_SHEET}!A1:Y10000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, COLLISION_HISTORY_SHEET);
    existingRows = [];
  }
  const header = (existingRows[0] ?? []).map((value) => String(value ?? ""));
  if (header.join("|") !== COLLISION_CALIBRATION_HISTORY_HEADERS.join("|")) {
    // Schema additions must not erase older legitimate prospective evidence.
    // Name-based migration retains each existing column and leaves only new
    // component-allocation fields blank; settlement will treat those as gaps.
    const migrated = migrateCollisionCalibrationHistoryRows(header, existingRows.slice(1));
    existingRows = [Array.from(COLLISION_CALIBRATION_HISTORY_HEADERS), ...migrated];
  }
  const nextRows = upsertCollisionCalibrationHistory(existingRows.slice(1), incoming);
  await clearRange(workbookId, `${COLLISION_HISTORY_SHEET}!A2:Y10000`);
  await writeRange(workbookId, `${COLLISION_HISTORY_SHEET}!A1`, [Array.from(COLLISION_CALIBRATION_HISTORY_HEADERS), ...nextRows]);
  return incoming.length;
}

/**
 * Compute Statcast xwOBA shadow adjustments for every game in the module09
 * output and write a full-replace snapshot to STATCAST_SHADOW_AUDIT.
 *
 * Fail-open: any sheet I/O error is captured; the pipeline continues normally.
 */
export async function computeAndWriteStatcastShadow(
  gameSummaryRows: GameSummaryRow[],
  statcastPreview: StatcastPreviewResult,
  workbookId = WORKBOOK_ID,
  protection?: PublicationProtection,
): Promise<StatcastShadowResult> {
  const snapshotTs = new Date().toISOString();
  const errors: string[] = [];

  // Build a game_id lookup so we can match preview data to projection rows.
  const previewMap = new Map<string, StatcastPreviewGameResult>();
  for (const g of statcastPreview.games) {
    previewMap.set(g.game_id, g);
  }

  const shadowRows: ShadowAuditRow[] = gameSummaryRows.map((summary) =>
    computeShadowAuditRow(summary, previewMap.get(summary.game_id) ?? null, snapshotTs),
  );

  if (shadowRows.length === 0) {
    logger.info("MODULE_09s: No game summary rows — shadow audit skipped");
    return {
      status: "skipped",
      write_timestamp_utc: snapshotTs,
      rows_computed: 0,
      rows_written: 0,
      collision_history_rows_written: 0,
      errors: [],
      shadow_rows: [],
    };
  }

  const withXwoba = shadowRows.filter(
    (r) => r.away_pitcher_xwoba !== null || r.home_pitcher_xwoba !== null,
  ).length;
  const adjusted = shadowRows.filter((r) => r.shadow_xwoba_adjustment !== 0).length;
  const capped   = shadowRows.filter((r) => r.cap_applied).length;

  logger.info(
    { games: shadowRows.length, withXwoba, adjusted, capped },
    "MODULE_09s: Shadow audit rows computed",
  );

  let rowsWritten = 0;
  let collisionHistoryRowsWritten = 0;
  try {
    await ensureShadowAuditSheet(workbookId);
    // Full replace: clear old data rows so a re-run with fewer games leaves no
    // stale rows behind.
    const incomingRows = shadowRows.map(rowToArray);
    const rowsToWrite = protection && protection.protected_game_ids.size > 0
      ? mergeProtectedRows(
          (await readRange(workbookId, `${SHADOW_SHEET}!A2:AQ10000`)).values ?? [],
          incomingRows, 1, protection.protected_game_ids, protection.expected_game_ids,
        )
      : incomingRows;
    await clearRange(workbookId, `${SHADOW_SHEET}!A2:AQ10000`);
    await writeRange(workbookId, `${SHADOW_SHEET}!A2`, rowsToWrite);
    rowsWritten = rowsToWrite.length;
    logger.info({ rows: rowsWritten }, "MODULE_09s: STATCAST_SHADOW_AUDIT written");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_09s: Failed to write STATCAST_SHADOW_AUDIT — continuing");
    errors.push(msg);
  }

  // Calibration surfaces are independently fail-open. A low-center history
  // problem cannot suppress the collision record that proves whether the
  // source data was actually available before first pitch.
  try {
    await appendLowCenterCalibrationHistory(workbookId, shadowRows, previewMap, protection);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_09s: Failed to write LOW_CENTER_CALIBRATION_HISTORY — continuing");
    errors.push(`LOW_CENTER_CALIBRATION_HISTORY: ${msg}`);
  }
  try {
    collisionHistoryRowsWritten = await upsertCollisionCalibrationHistorySheet(
      workbookId, shadowRows, previewMap, protection,
    );
    logger.info(
      { collision_history_rows: collisionHistoryRowsWritten },
      "MODULE_09s: COLLISION_CALIBRATION_HISTORY written",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_09s: Failed to write COLLISION_CALIBRATION_HISTORY — continuing");
    errors.push(`COLLISION_CALIBRATION_HISTORY: ${msg}`);
  }

  return {
    status: errors.length > 0 ? "partial" : "success",
    write_timestamp_utc: snapshotTs,
    rows_computed: shadowRows.length,
    rows_written: rowsWritten,
    collision_history_rows_written: collisionHistoryRowsWritten,
    errors,
    shadow_rows: shadowRows,
  };
}
