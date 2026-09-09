/** BVH V1 starter-window integration audit and immutable pregame history. */

import {
  addSheet,
  appendRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import type { BVHLineupProfile } from "./module02j_batterVsHand.js";

export const BVH_PROJECTION_HISTORY_SHEET = "BVH_PROJECTION_HISTORY_V1";
export const BVH_PROJECTION_STATUS = "ACTIVE_PROSPECTIVE_V1" as const;
export const BVH_ACTIVE_INPUT = true;
export const BVH_HISTORICAL_REPLAY_STATUS =
  "NON_REPLAYABLE_FOR_BVH — FROZEN_PACKETS_LACK_HITTER_IDENTITY" as const;
/** Reuses the already commissioned lineup-strength blend; no new coefficient. */
export const BVH_MATCHUP_BLEND_WEIGHT = 0.4;

export function isBVHProfileUsable(profile: BVHLineupProfile): boolean {
  return profile.status === "AVAILABLE" || profile.status === "PARTIAL_IDENTITY";
}

export const BVH_PROJECTION_HISTORY_HEADERS = [
  "Date", "Game_ID", "Snapshot_TS", "BVH_Version", "Integration_Status", "Active_Input",
  "Away_Opposing_Starter_Hand", "Home_Opposing_Starter_Hand", "Away_BVH_Lineup_OPS", "Home_BVH_Lineup_OPS",
  "Away_BVH_Mean_Raw_PA", "Home_BVH_Mean_Raw_PA", "Away_BVH_NoSample_Count", "Home_BVH_NoSample_Count",
  "Away_BVH_Coverage", "Home_BVH_Coverage", "Away_BVH_Identity_Coverage", "Home_BVH_Identity_Coverage",
  "Away_BVH_Chain_Uncertainty", "Home_BVH_Chain_Uncertainty", "Away_BVH_Status", "Home_BVH_Status",
  "Away_BVH_Driver_Trace", "Home_BVH_Driver_Trace",
  "Existing_Platoon_Matchup_Factor_Away", "Existing_Platoon_Matchup_Factor_Home",
  "BVH_Performance_Matchup_Factor_Away", "BVH_Performance_Matchup_Factor_Home",
  "BVH_vs_Platoon_Delta_Away", "BVH_vs_Platoon_Delta_Home",
  "Existing_Away_Runs", "Existing_Home_Runs", "Existing_Total",
  "BVH_Away_Runs", "BVH_Home_Runs", "BVH_Total",
  "BVH_Delta_Away", "BVH_Delta_Home", "BVH_Delta_Total",
  "BVH_Requested_Through_Date", "BVH_Actual_Data_Through_Date", "BVH_Freshness_Status", "BVH_Deterministic_Hash",
] as const;

export interface BVHProjectionAuditRow {
  date: string;
  game_id: string;
  snapshot_ts: string;
  bvh_version: string;
  away_starter_hand: string | null;
  home_starter_hand: string | null;
  away_profile: BVHLineupProfile;
  home_profile: BVHLineupProfile;
  existing_platoon_factor_away: number;
  existing_platoon_factor_home: number;
  bvh_matchup_factor_away: number;
  bvh_matchup_factor_home: number;
  existing_away_runs: number;
  existing_home_runs: number;
  bvh_away_runs: number;
  bvh_home_runs: number;
  requested_through_date: string;
  actual_data_through_date: string | null;
  freshness_status: string;
  deterministic_hash: string;
}

function round(value: number, digits = 4): number { return Number(value.toFixed(digits)); }
function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }

/**
 * Maps the raw split-vs-season OPS ratio onto the exact scale already used by
 * lineup quality. Projected lineups receive the same 0.60 confidence discount.
 */
export function mapBVHStarterWindowFactor(
  profile: BVHLineupProfile,
  lineupSource: "official" | "projected" | null,
): number {
  if (profile.status === "NO_SOURCE_DATA" || profile.status === "NO_LINEUP" || profile.status === "HAND_UNRESOLVED") return 1;
  const sourceConfidence = lineupSource === "official" ? 1 : lineupSource === "projected" ? 0.6 : 0;
  const identityConfidence = clamp(profile.identity_coverage, 0, 1);
  const effect = (profile.performance_matchup_factor - 1)
    * BVH_MATCHUP_BLEND_WEIGHT * sourceConfidence * identityConfidence;
  return round(clamp(1 + effect, 0.82, 1.18));
}

function values(row: BVHProjectionAuditRow): unknown[] {
  const existingTotal = round(row.existing_away_runs + row.existing_home_runs, 2);
  const bvhTotal = round(row.bvh_away_runs + row.bvh_home_runs, 2);
  return [
    row.date, row.game_id, row.snapshot_ts, row.bvh_version, BVH_PROJECTION_STATUS, BVH_ACTIVE_INPUT ? "YES" : "NO",
    row.away_starter_hand ?? "", row.home_starter_hand ?? "", row.away_profile.weighted_shrunk_ops ?? "", row.home_profile.weighted_shrunk_ops ?? "",
    row.away_profile.mean_raw_pa, row.home_profile.mean_raw_pa, row.away_profile.no_sample_count, row.home_profile.no_sample_count,
    row.away_profile.observed_50_pa_coverage, row.home_profile.observed_50_pa_coverage,
    row.away_profile.identity_coverage, row.home_profile.identity_coverage,
    row.away_profile.chain_uncertainty ? "TRUE" : "FALSE", row.home_profile.chain_uncertainty ? "TRUE" : "FALSE",
    row.away_profile.status, row.home_profile.status,
    row.away_profile.driver_trace, row.home_profile.driver_trace,
    row.existing_platoon_factor_away, row.existing_platoon_factor_home,
    row.bvh_matchup_factor_away, row.bvh_matchup_factor_home,
    round(row.bvh_matchup_factor_away - row.existing_platoon_factor_away),
    round(row.bvh_matchup_factor_home - row.existing_platoon_factor_home),
    row.existing_away_runs, row.existing_home_runs, existingTotal,
    row.bvh_away_runs, row.bvh_home_runs, bvhTotal,
    round(row.bvh_away_runs - row.existing_away_runs, 2), round(row.bvh_home_runs - row.existing_home_runs, 2), round(bvhTotal - existingTotal, 2),
    row.requested_through_date, row.actual_data_through_date ?? "", row.freshness_status, row.deterministic_hash,
  ];
}

async function ensureSheet(workbookId: string): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((sheet) => sheet.title === BVH_PROJECTION_HISTORY_SHEET)) await addSheet(workbookId, BVH_PROJECTION_HISTORY_SHEET);
  const header = (await readRange(workbookId, `${BVH_PROJECTION_HISTORY_SHEET}!A1:AQ1`)).values?.[0] ?? [];
  if (!BVH_PROJECTION_HISTORY_HEADERS.every((name, index) => String(header[index] ?? "") === name)) {
    await writeRange(workbookId, `${BVH_PROJECTION_HISTORY_SHEET}!A1`, [Array.from(BVH_PROJECTION_HISTORY_HEADERS)]);
  }
  await expandSheetColumns(workbookId, BVH_PROJECTION_HISTORY_SHEET, BVH_PROJECTION_HISTORY_HEADERS.length);
}

/** Append-only. Protected/started games must be filtered by the caller. */
export async function appendBVHProjectionHistory(
  rows: readonly BVHProjectionAuditRow[],
  workbookId = WORKBOOK_ID,
): Promise<{ rows_written: number; errors: string[] }> {
  if (rows.length === 0) return { rows_written: 0, errors: [] };
  try {
    await ensureSheet(workbookId);
    await appendRange(workbookId, `${BVH_PROJECTION_HISTORY_SHEET}!A:AQ`, rows.map(values));
    return { rows_written: rows.length, errors: [] };
  } catch (error: unknown) {
    return { rows_written: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
