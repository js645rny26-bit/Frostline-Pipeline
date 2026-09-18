/** Workbook persistence for Patch B batter-damage evidence and lineup profiles. */

import {
  addSheet,
  appendRange,
  clearRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";
import {
  BATTER_DAMAGE_VERSION,
  type BatterDamageDailyAggregate,
  type BatterDamageDataset,
  type DamageLineupProfile,
} from "./module02k_batterDamage.js";

export const BATTER_DAMAGE_DAILY_SHEET = "BATTER_DAMAGE_DAILY_V1";
export const BATTER_DAMAGE_PROFILES_SHEET = "BATTER_DAMAGE_PROFILES_V1";
export const DAMAGE_LINEUP_SHADOW_SHEET = "DAMAGE_LINEUP_SHADOW_V1";

export const BATTER_DAMAGE_DAILY_HEADERS = [
  "Game_Date", "Batter_MLBAM_ID", "BBE", "Hard_Hits", "Barrels", "Barrel_Known_BBE",
  "XBH", "Home_Runs", "Exit_Velocity_Sum", "Source_Snapshot_ID", "Source_Fetch_TS",
  "Data_Through_Date", "Damage_Version",
] as const;

export const BATTER_DAMAGE_PROFILE_HEADERS = [
  "Damage_Version", "Batter_MLBAM_ID", "BBE", "Hard_Hits", "Hard_Hit_Pct", "Barrels",
  "Barrel_Known_BBE", "Barrel_Pct", "XBH", "XBH_Pct", "Home_Runs", "HR_Pct",
  "Avg_Exit_Velocity", "Profile_Status", "Requested_Through_Date", "Actual_Data_Through_Date",
  "Freshness_Lag_Days", "Freshness_Status", "League_Hard_Hit_Pct", "Deterministic_Hash",
] as const;

export const DAMAGE_LINEUP_SHADOW_HEADERS = [
  "Date", "Game_ID", "Snapshot_TS", "Damage_Version", "Active_Input",
  "Away_Weighted_Hard_Hit_Pct", "Home_Weighted_Hard_Hit_Pct",
  "Away_Total_BBE", "Home_Total_BBE", "Away_Matched_Hitters", "Home_Matched_Hitters",
  "Away_Observed_Hitters", "Home_Observed_Hitters", "Away_Identity_Coverage", "Home_Identity_Coverage",
  "Away_Observed_Coverage", "Home_Observed_Coverage", "Away_Profile_Status", "Home_Profile_Status",
  "Away_Missing_Hitters", "Home_Missing_Hitters", "Away_Driver_Trace", "Home_Driver_Trace",
  "Requested_Through_Date", "Actual_Data_Through_Date", "Freshness_Status", "League_Hard_Hit_Pct",
  "Deterministic_Hash", "Collision_Ledger_Status",
] as const;

export interface BatterDamageDailyHistoryRecord extends BatterDamageDailyAggregate {
  source_snapshot_id: string;
  source_fetch_ts: string;
  data_through_date: string;
}

export interface DamageLineupShadowRecord {
  date: string;
  game_id: string;
  snapshot_ts: string;
  away: DamageLineupProfile;
  home: DamageLineupProfile;
  dataset: BatterDamageDataset;
}

function cell(value: unknown): string { return String(value ?? "").trim(); }
function numeric(value: unknown): number | null {
  const parsed = Number.parseFloat(cell(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureSheet(workbookId: string, sheet: string, headers: readonly string[]): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((candidate) => candidate.title === sheet)) await addSheet(workbookId, sheet);
  const existing = (await readRange(workbookId, `${sheet}!A1:AZ1`)).values?.[0]?.map(cell) ?? [];
  if (!headers.every((name, index) => existing[index] === name)) {
    await writeRange(workbookId, `${sheet}!A1`, [Array.from(headers)]);
  }
  await expandSheetColumns(workbookId, sheet, headers.length);
}

export function parseBatterDamageDailyHistory(rows: unknown[][]): BatterDamageDailyHistoryRecord[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [cell(name), position]));
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  return data.flatMap((row): BatterDamageDailyHistoryRecord[] => {
    const gameDate = cell(value(row, "Game_Date"));
    const batter = numeric(value(row, "Batter_MLBAM_ID"));
    const snapshotId = cell(value(row, "Source_Snapshot_ID"));
    const sourceFetchTs = cell(value(row, "Source_Fetch_TS"));
    if (!gameDate || batter === null || !snapshotId || !sourceFetchTs) return [];
    return [{
      game_date: gameDate,
      batter_mlbam_id: batter,
      bbe: numeric(value(row, "BBE")) ?? 0,
      hard_hits: numeric(value(row, "Hard_Hits")) ?? 0,
      barrels: numeric(value(row, "Barrels")) ?? 0,
      barrel_known_bbe: numeric(value(row, "Barrel_Known_BBE")) ?? 0,
      xbh: numeric(value(row, "XBH")) ?? 0,
      home_runs: numeric(value(row, "Home_Runs")) ?? 0,
      exit_velocity_sum: numeric(value(row, "Exit_Velocity_Sum")) ?? 0,
      source_snapshot_id: snapshotId,
      source_fetch_ts: sourceFetchTs,
      data_through_date: cell(value(row, "Data_Through_Date")),
    }];
  });
}

function signature(row: BatterDamageDailyAggregate): string {
  return [row.game_date, row.batter_mlbam_id, row.bbe, row.hard_hits, row.barrels,
    row.barrel_known_bbe, row.xbh, row.home_runs, row.exit_velocity_sum].join("|");
}

export function existingBatterDamageSnapshotState(
  existing: readonly BatterDamageDailyHistoryRecord[],
  snapshotId: string,
  expected: readonly BatterDamageDailyAggregate[],
): "ABSENT" | "COMPLETE" {
  const found = existing.filter((row) => row.source_snapshot_id === snapshotId);
  if (found.length === 0) return "ABSENT";
  const a = [...new Set(found.map(signature))].sort();
  const b = [...new Set(expected.map(signature))].sort();
  if (found.length !== expected.length || a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw new Error(`BATTER_DAMAGE_HISTORY_PARTIAL_SNAPSHOT: ${snapshotId} has ${found.length}/${expected.length} rows`);
  }
  return "COMPLETE";
}

export function selectCanonicalBatterDamageHistory(
  records: readonly BatterDamageDailyHistoryRecord[],
): BatterDamageDailyHistoryRecord[] {
  const byDate = new Map<string, Map<string, { fetchTs: string; rows: BatterDamageDailyHistoryRecord[] }>>();
  for (const record of records) {
    const snapshots = byDate.get(record.game_date) ?? new Map();
    const entry = snapshots.get(record.source_snapshot_id) ?? { fetchTs: record.source_fetch_ts, rows: [] };
    entry.rows.push(record);
    snapshots.set(record.source_snapshot_id, entry);
    byDate.set(record.game_date, snapshots);
  }
  const selected: BatterDamageDailyHistoryRecord[] = [];
  for (const [date, snapshots] of byDate) {
    const ordered = [...snapshots.entries()].sort((a, b) =>
      b[1].fetchTs.localeCompare(a[1].fetchTs) || b[0].localeCompare(a[0]));
    const latestTs = ordered[0]?.[1].fetchTs;
    const sameTs = ordered.filter((entry) => entry[1].fetchTs === latestTs);
    if (sameTs.length > 1) throw new Error(`BATTER_DAMAGE_DAILY_SNAPSHOT_COLLISION: ${date} ${latestTs}`);
    selected.push(...(ordered[0]?.[1].rows ?? []));
  }
  return selected.sort((a, b) => a.game_date.localeCompare(b.game_date) || a.batter_mlbam_id - b.batter_mlbam_id);
}

export async function loadBatterDamageDailyHistory(workbookId = WORKBOOK_ID): Promise<BatterDamageDailyHistoryRecord[]> {
  try {
    const rows = (await readRange(workbookId, `${BATTER_DAMAGE_DAILY_SHEET}!A1:M150000`)).values ?? [];
    return parseBatterDamageDailyHistory(rows as unknown[][]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("400") || message.includes("Unable to parse range")) return [];
    throw error;
  }
}

export async function persistBatterDamageDailyHistory(
  aggregates: readonly BatterDamageDailyAggregate[],
  snapshotId: string,
  sourceFetchTs: string,
  dataThroughDate: string,
  workbookId = WORKBOOK_ID,
): Promise<{ rows_written: number; errors: string[] }> {
  try {
    await ensureSheet(workbookId, BATTER_DAMAGE_DAILY_SHEET, BATTER_DAMAGE_DAILY_HEADERS);
    const existing = await loadBatterDamageDailyHistory(workbookId);
    if (existingBatterDamageSnapshotState(existing, snapshotId, aggregates) === "COMPLETE") return { rows_written: 0, errors: [] };
    if (aggregates.length > 0) {
      await appendRange(workbookId, `${BATTER_DAMAGE_DAILY_SHEET}!A:M`, aggregates.map((row) => [
        row.game_date, row.batter_mlbam_id, row.bbe, row.hard_hits, row.barrels, row.barrel_known_bbe,
        row.xbh, row.home_runs, row.exit_velocity_sum, snapshotId, sourceFetchTs, dataThroughDate, BATTER_DAMAGE_VERSION,
      ]));
    }
    return { rows_written: aggregates.length, errors: [] };
  } catch (error: unknown) {
    return { rows_written: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export async function writeBatterDamageProfiles(dataset: BatterDamageDataset, workbookId = WORKBOOK_ID): Promise<void> {
  await ensureSheet(workbookId, BATTER_DAMAGE_PROFILES_SHEET, BATTER_DAMAGE_PROFILE_HEADERS);
  const rows = [...dataset.profiles.values()].sort((a, b) => a.batter_mlbam_id - b.batter_mlbam_id).map((profile) => [
    dataset.version, profile.batter_mlbam_id, profile.bbe, profile.hard_hits, profile.hard_hit_pct ?? "",
    profile.barrels, profile.barrel_known_bbe, profile.barrel_pct ?? "", profile.xbh, profile.xbh_pct ?? "",
    profile.home_runs, profile.hr_pct ?? "", profile.avg_exit_velocity ?? "", profile.status,
    dataset.requested_through_date, dataset.actual_data_through_date ?? "", dataset.freshness_lag_days ?? "",
    dataset.freshness_status, dataset.league_hard_hit_pct ?? "", dataset.deterministic_hash,
  ]);
  await clearRange(workbookId, `${BATTER_DAMAGE_PROFILES_SHEET}!A2:T5000`);
  await writeRange(workbookId, `${BATTER_DAMAGE_PROFILES_SHEET}!A1`, [Array.from(BATTER_DAMAGE_PROFILE_HEADERS), ...rows]);
}

function lineupRow(record: DamageLineupShadowRecord): (string | number)[] {
  return [
    record.date, record.game_id, record.snapshot_ts, record.dataset.version, "NO",
    record.away.weighted_hard_hit_pct ?? "", record.home.weighted_hard_hit_pct ?? "",
    record.away.total_bbe, record.home.total_bbe, record.away.matched_mlbam_hitters, record.home.matched_mlbam_hitters,
    record.away.observed_hitters, record.home.observed_hitters, record.away.identity_coverage, record.home.identity_coverage,
    record.away.observed_coverage, record.home.observed_coverage, record.away.status, record.home.status,
    record.away.missing_hitters.join(" | "), record.home.missing_hitters.join(" | "),
    record.away.driver_trace, record.home.driver_trace, record.dataset.requested_through_date,
    record.dataset.actual_data_through_date ?? "", record.dataset.freshness_status,
    record.dataset.league_hard_hit_pct ?? "", record.dataset.deterministic_hash,
    "NOT_MAPPED_PENDING_COMMISSIONING",
  ];
}

export async function writeDamageLineupShadow(
  records: readonly DamageLineupShadowRecord[],
  workbookId = WORKBOOK_ID,
  protection?: PublicationProtection,
): Promise<number> {
  await ensureSheet(workbookId, DAMAGE_LINEUP_SHADOW_SHEET, DAMAGE_LINEUP_SHADOW_HEADERS);
  const incoming = records.map(lineupRow);
  const rows = protection && protection.protected_game_ids.size > 0
    ? mergeProtectedRows(
        (await readRange(workbookId, `${DAMAGE_LINEUP_SHADOW_SHEET}!A2:AC10000`)).values ?? [],
        incoming,
        1,
        protection.protected_game_ids,
        protection.expected_game_ids,
      )
    : incoming;
  await clearRange(workbookId, `${DAMAGE_LINEUP_SHADOW_SHEET}!A2:AC10000`);
  await writeRange(workbookId, `${DAMAGE_LINEUP_SHADOW_SHEET}!A1`, [Array.from(DAMAGE_LINEUP_SHADOW_HEADERS), ...rows]);
  return rows.length;
}
