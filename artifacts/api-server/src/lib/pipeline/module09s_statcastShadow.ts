/**
 * Module 09s: Statcast Preview Shadow Audit
 *
 * Computes per-game shadow projection adjustments driven by Baseball Savant
 * starter xwOBA-allowed data and writes them to the STATCAST_SHADOW_AUDIT sheet.
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

const SHADOW_SHEET = "STATCAST_SHADOW_AUDIT";
const DEFAULT_STARTER_IP = 5.5;

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
  errors: string[];
  shadow_rows: ShadowAuditRow[];
}

// ─── Pure computation (exported for tests) ────────────────────────────────────

function clampQual(v: number): number {
  return Math.max(0.40, Math.min(1.80, v));
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

  return {
    game_id:                      summary.game_id,
    date:                         summary.date,
    away_team:                    summary.away_team,
    home_team:                    summary.home_team,
    away_pitcher:                 summary.away_pitcher,
    home_pitcher:                 summary.home_pitcher,
    preview_availability:         previewAvailability,
    current_projection:           summary.projected_total_runs,
    shadow_xwoba_adjustment:      totalUncapped,
    shadow_projection:            parseFloat((summary.projected_total_runs + cappedAdj).toFixed(2)),
    cap_applied:                  capApplied,
    away_pitcher_xwoba:           awayXwoba,
    away_pitcher_shadow_quality:  awayShadowQual,
    away_pitcher_current_quality: summary.away_starter_quality,
    home_pitcher_xwoba:           homeXwoba,
    home_pitcher_shadow_quality:  homeShadowQual,
    home_pitcher_current_quality: summary.home_starter_quality,
    away_starter_delta:           awayDelta,
    home_starter_delta:           homeDelta,
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
];

async function ensureShadowAuditSheet(workbookId: string): Promise<void> {
  let sheetExists = true;
  try {
    const existing = await readRange(workbookId, `${SHADOW_SHEET}!A1:Z1`);
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
  ];
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
  try {
    await ensureShadowAuditSheet(workbookId);
    // Full replace: clear old data rows so a re-run with fewer games leaves no
    // stale rows behind.
    await clearRange(workbookId, `${SHADOW_SHEET}!A2:Z10000`);
    await writeRange(workbookId, `${SHADOW_SHEET}!A2`, shadowRows.map(rowToArray));
    rowsWritten = shadowRows.length;
    logger.info({ rows: rowsWritten }, "MODULE_09s: STATCAST_SHADOW_AUDIT written");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_09s: Failed to write STATCAST_SHADOW_AUDIT — continuing");
    errors.push(msg);
  }

  return {
    status: errors.length > 0 ? "partial" : "success",
    write_timestamp_utc: snapshotTs,
    rows_computed: shadowRows.length,
    rows_written: rowsWritten,
    errors,
    shadow_rows: shadowRows,
  };
}
