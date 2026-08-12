/**
 * Module 12s: Shadow Validation
 * Compares the repaired projection (mod09 output) against the legacy
 * (pre-repair) projection for every game in today's slate.
 *
 * Shadow mode contract:
 *  - Does NOT affect CORE authorization, SLATE_BOARD, or any gating logic.
 *  - Writes only to SHADOW_VALIDATION sheet.
 *  - Runs after every full-pipeline publish until historical replay is
 *    complete and 65/35 blend weights are canonised.
 *
 * Legacy model definition:
 *  - Offense rate  = L30 wRC+-derived rate only (no L10 blend)
 *  - Run multiplier = weather factor only (park_multiplier treated as 1.0)
 *  - Fallback       = LEAGUE_AVG_RS when L30 absent
 *
 * The legacy projection is reconstructed from audit columns already present
 * in GameSummaryRow — no additional API calls are required.
 *
 * Reconstruction method (preserving pitching / bullpen components):
 *   repaired_away_adj = away_offense_rate_used × combined_run_multiplier
 *   legacy_away_adj   = (away_l30_rs_estimate ?? 4.5) × weather_multiplier
 *   legacy_away_runs  ≈ repaired_away_runs × (legacy_away_adj / repaired_away_adj)
 *
 * This ratio-scaling is valid because the projection formula is:
 *   runs = adj_rate × pitcher_factor × IP/9 + bullpen_component
 * and the pitcher_factor, IP, and bullpen_component are identical between
 * legacy and repaired. Only adj_rate differs.
 */

import { clearRange, expandSheetColumns, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAGUE_AVG_RS = 4.5;
const SHADOW_SHEET  = "SHADOW_VALIDATION";
const N_COLS        = 23; // A–W

const HEADER_ROW = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Away_Pitcher",
  "Home_Pitcher",
  "Repaired_Projected_Total",
  "Legacy_Projected_Total",
  "Delta_Repaired_Minus_Legacy",
  "Away_Offense_Source",
  "Home_Offense_Source",
  "Away_L30_Rate",
  "Home_L30_Rate",
  "Away_L10_Rate",
  "Home_L10_Rate",
  "Away_Offense_Rate_Used",
  "Home_Offense_Rate_Used",
  "Legacy_Multiplier",
  "Park_Multiplier",
  "Weather_Multiplier",
  "Repaired_Multiplier",
  "Park_Source_Status",
  "Snapshot_TS",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShadowComparisonRow {
  game_id: string;
  date: string;
  away_team: string;
  home_team: string;
  away_pitcher: string;
  home_pitcher: string;
  repaired_projected_total: number;
  legacy_projected_total: number;
  /** positive → repaired is higher; negative → legacy is higher */
  delta: number;
  away_offense_source: string;
  home_offense_source: string;
  away_l30_rate: number | null;
  home_l30_rate: number | null;
  away_l10_rate: number | null;
  home_l10_rate: number | null;
  away_offense_rate_used: number;
  home_offense_rate_used: number;
  /** Legacy multiplier = weather-only (park treated as 1.0) */
  legacy_multiplier: number;
  park_multiplier: number;
  weather_multiplier: number;
  /** Repaired multiplier = park × weather */
  repaired_multiplier: number;
  park_source_status: string;
}

export interface ShadowValidationResult {
  status: "success" | "failure";
  shadow_timestamp_utc: string;
  games_compared: number;
  /** Mean delta (repaired − legacy) across all games */
  avg_delta: number | null;
  /** Largest absolute delta across all games */
  max_abs_delta: number | null;
  /** Games where either team offense fell back to LEAGUE_AVG */
  fallback_count: number;
  rows: ShadowComparisonRow[];
  errors: string[];
}

// ─── Reconstruction helpers ───────────────────────────────────────────────────

/**
 * Legacy adjusted rate for one side of a game.
 * Uses L30 rate only (no L10 blend); weather modifier only (no park factor).
 */
export function legacyAdjRate(l30Rate: number | null, weatherMultiplier: number): number {
  return parseFloat(((l30Rate ?? LEAGUE_AVG_RS) * weatherMultiplier).toFixed(3));
}

/**
 * Scale repaired projected runs to the legacy projection via the rate ratio.
 *
 * Formula: legacy_runs ≈ repaired_runs × (legacy_adj / repaired_adj)
 *
 * Valid because the only difference between legacy and repaired is adj_rate;
 * pitching quality, expected innings, and bullpen component are identical.
 *
 * When repaired_adj ≤ 0 (degenerate), return legacy_adj directly as an
 * absolute estimate to avoid division by zero.
 */
export function scaleLegacyRuns(
  repairedRuns: number,
  legacyAdj: number,
  repairedAdj: number,
): number {
  if (repairedAdj <= 0) return parseFloat(legacyAdj.toFixed(2));
  return parseFloat((repairedRuns * (legacyAdj / repairedAdj)).toFixed(2));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runShadowValidation(
  gameSummaryRows: GameSummaryRow[],
  workbookId = WORKBOOK_ID,
  protection?: PublicationProtection,
): Promise<ShadowValidationResult> {
  const startTs = new Date().toISOString();
  const errors: string[] = [];

  logger.info({ games: gameSummaryRows.length }, "MODULE_12s: Shadow validation starting");

  if (gameSummaryRows.length === 0) {
    return {
      status: "success",
      shadow_timestamp_utc: startTs,
      games_compared: 0,
      avg_delta: null,
      max_abs_delta: null,
      fallback_count: 0,
      rows: [],
      errors: [],
    };
  }

  const comparisonRows: ShadowComparisonRow[] = [];

  for (const row of gameSummaryRows) {
    // ── Repaired adjusted rates (derived from audit fields) ──
    const repairedAwayAdj = parseFloat(
      (row.away_offense_rate_used * row.combined_run_multiplier).toFixed(3),
    );
    const repairedHomeAdj = parseFloat(
      (row.home_offense_rate_used * row.combined_run_multiplier).toFixed(3),
    );

    // ── Legacy adjusted rates (L30-only offense, weather-only multiplier) ──
    const legacyAwayAdj = legacyAdjRate(row.away_l30_rs_estimate, row.weather_multiplier);
    const legacyHomeAdj = legacyAdjRate(row.home_l30_rs_estimate, row.weather_multiplier);

    // ── Scale to legacy projected runs ──
    const legacyAway  = scaleLegacyRuns(row.projected_away_runs,  legacyAwayAdj, repairedAwayAdj);
    const legacyHome  = scaleLegacyRuns(row.projected_home_runs,  legacyHomeAdj, repairedHomeAdj);
    const legacyTotal = parseFloat((legacyAway + legacyHome).toFixed(2));
    const delta       = parseFloat((row.projected_total_runs - legacyTotal).toFixed(2));

    comparisonRows.push({
      game_id:                   row.game_id,
      date:                      row.date,
      away_team:                 row.away_team,
      home_team:                 row.home_team,
      away_pitcher:              row.away_pitcher,
      home_pitcher:              row.home_pitcher,
      repaired_projected_total:  row.projected_total_runs,
      legacy_projected_total:    legacyTotal,
      delta,
      away_offense_source:       row.away_offense_source_status,
      home_offense_source:       row.home_offense_source_status,
      away_l30_rate:             row.away_l30_rs_estimate,
      home_l30_rate:             row.home_l30_rs_estimate,
      away_l10_rate:             row.away_l10_rs_actual,
      home_l10_rate:             row.home_l10_rs_actual,
      away_offense_rate_used:    row.away_offense_rate_used,
      home_offense_rate_used:    row.home_offense_rate_used,
      legacy_multiplier:         row.weather_multiplier,  // park treated as 1.0
      park_multiplier:           row.park_multiplier,
      weather_multiplier:        row.weather_multiplier,
      repaired_multiplier:       row.combined_run_multiplier,
      park_source_status:        row.park_source_status,
    });
  }

  // ── Aggregate stats ──
  const deltas        = comparisonRows.map((r) => r.delta);
  const absDDeltas    = deltas.map(Math.abs);
  const avgDelta      = parseFloat((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(3));
  const maxAbsDelta   = parseFloat(Math.max(...absDDeltas).toFixed(3));
  const fallbackCount = comparisonRows.filter(
    (r) =>
      r.away_offense_source === "LEAGUE_AVG_FALLBACK" ||
      r.home_offense_source === "LEAGUE_AVG_FALLBACK",
  ).length;

  logger.info(
    { avgDelta, maxAbsDelta, fallbackCount, games: comparisonRows.length },
    "MODULE_12s: Shadow comparison computed",
  );

  // ── Compute sheet rows (shared by SHADOW_VALIDATION and SHADOW_HISTORY) ──
  const sheetRows = comparisonRows.map((r) => [
    r.date,
    r.game_id,
    r.away_team,
    r.home_team,
    r.away_pitcher,
    r.home_pitcher,
    r.repaired_projected_total,
    r.legacy_projected_total,
    r.delta,
    r.away_offense_source,
    r.home_offense_source,
    r.away_l30_rate ?? "",
    r.home_l30_rate ?? "",
    r.away_l10_rate ?? "",
    r.home_l10_rate ?? "",
    r.away_offense_rate_used,
    r.home_offense_rate_used,
    r.legacy_multiplier,
    r.park_multiplier,
    r.weather_multiplier,
    r.repaired_multiplier,
    r.park_source_status,
    startTs,
  ]);

  // ── Write to SHADOW_VALIDATION sheet (latest slate, full rewrite) ──
  try {
    await expandSheetColumns(workbookId, SHADOW_SHEET, N_COLS);
    const rowsToWrite = protection && protection.protected_game_ids.size > 0
      ? mergeProtectedRows(
          (await readRange(workbookId, `${SHADOW_SHEET}!A2:W1000`)).values ?? [],
          sheetRows, 1, protection.protected_game_ids, protection.expected_game_ids,
        )
      : sheetRows;
    await clearRange(workbookId, `${SHADOW_SHEET}!A1:W1000`);
    await writeRange(workbookId, `${SHADOW_SHEET}!A1:W1`, [HEADER_ROW]);
    await writeRange(workbookId, `${SHADOW_SHEET}!A2:W${1 + rowsToWrite.length}`, rowsToWrite);
    logger.info({ rows: rowsToWrite.length }, "MODULE_12s: Shadow validation written to sheet");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Sheets write failed: ${msg}`);
    logger.error({ err: msg }, "MODULE_12s: Shadow validation Sheets write failed — result still returned");
  }

  // ── Append to SHADOW_HISTORY (accumulation log, never cleared) ──
  const HISTORY_SHEET = "SHADOW_HISTORY";
  try {
    const histResp   = await readRange(workbookId, `${HISTORY_SHEET}!B1:B5000`);
    const histRows   = (histResp.values ?? []) as string[][];
    const existingIds = new Set(histRows.slice(1).map((r) => r[0] ?? "").filter(Boolean));
    const newRows    = sheetRows.filter((r) => !existingIds.has(String(r[1])));

    if (newRows.length > 0) {
      const currentCount = histRows.length; // includes header if present
      const needsHeader  = currentCount === 0;
      if (needsHeader) {
        await expandSheetColumns(workbookId, HISTORY_SHEET, N_COLS);
        await writeRange(workbookId, `${HISTORY_SHEET}!A1:W1`, [HEADER_ROW]);
        await writeRange(workbookId, `${HISTORY_SHEET}!A2:W${1 + newRows.length}`, newRows);
      } else {
        const startRow = currentCount + 1; // append after last existing row (header at row 1 = index 0)
        await writeRange(workbookId, `${HISTORY_SHEET}!A${startRow}:W${startRow + newRows.length - 1}`, newRows);
      }
      logger.info({ appended: newRows.length, skipped: sheetRows.length - newRows.length }, "MODULE_12s: Shadow history appended");
    } else {
      logger.info("MODULE_12s: Shadow history — all game_ids already present, nothing appended");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Shadow history append failed: ${msg}`);
    logger.warn({ err: msg }, "MODULE_12s: Shadow history append failed — validation result unaffected");
  }

  return {
    status:                  errors.length === 0 ? "success" : "failure",
    shadow_timestamp_utc:    startTs,
    games_compared:          comparisonRows.length,
    avg_delta:               avgDelta,
    max_abs_delta:           maxAbsDelta,
    fallback_count:          fallbackCount,
    rows:                    comparisonRows,
    errors,
  };
}
