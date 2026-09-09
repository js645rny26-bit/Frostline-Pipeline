/** Workbook persistence for BVH V1 derived evidence and current estimates. */

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
import {
  BVH_VERSION,
  type BVHDailyAggregate,
  type BVHDataset,
  type BVHHand,
} from "./module02j_batterVsHand.js";

export const BVH_DAILY_HISTORY_SHEET = "BVH_DAILY_HISTORY_V1";
export const BVH_BATTER_SPLITS_SHEET = "BVH_BATTER_SPLITS_V1";

export const BVH_DAILY_HISTORY_HEADERS = [
  "Game_Date", "Batter_MLBAM_ID", "Pitcher_Hand", "PA", "AB", "H", "BB", "IBB", "HBP", "SF", "Total_Bases",
  "Source_Snapshot_ID", "Source_Fetch_TS", "Data_Through_Date", "BVH_Version",
] as const;

export const BVH_BATTER_SPLIT_HEADERS = [
  "BVH_Version", "Batter_MLBAM_ID",
  "Raw_vs_LHP_PA", "Raw_vs_RHP_PA", "Raw_vs_LHP_OBP", "Raw_vs_RHP_OBP", "Raw_vs_LHP_SLG", "Raw_vs_RHP_SLG", "Raw_vs_LHP_OPS", "Raw_vs_RHP_OPS",
  "Prior_vs_LHP_OPS", "Prior_vs_RHP_OPS", "Prior_Source_LHP", "Prior_Source_RHP", "Shrinkage_Weight_LHP", "Shrinkage_Weight_RHP",
  "Shrunk_vs_LHP_OPS", "Shrunk_vs_RHP_OPS", "BVH_Status_LHP", "BVH_Status_RHP",
  "BVH_Requested_Through_Date", "BVH_Actual_Data_Through_Date", "BVH_Freshness_Lag_Days", "BVH_Freshness_Status",
  "BVH_League_Baseline_LHP", "BVH_League_Baseline_RHP", "BVH_Unclassified_Events", "BVH_Unclassified_Event_Values",
  "BVH_Excluded_NonPA_Events", "BVH_Excluded_NonPA_Event_Values",
  "BVH_Malformed_PA_Count", "BVH_Pitch_Rows_Inspected", "BVH_Terminal_PA_Count", "BVH_Deterministic_Hash",
] as const;

export interface BVHDailyHistoryRecord extends BVHDailyAggregate {
  source_snapshot_id: string;
  source_fetch_ts: string;
  data_through_date: string;
}

function aggregateSignature(row: BVHDailyAggregate): string {
  return [
    row.game_date, row.batter_mlbam_id, row.pitcher_hand,
    row.pa, row.ab, row.hits, row.bb, row.ibb, row.hbp, row.sf, row.total_bases,
  ].join("|");
}

export function existingBVHSnapshotState(
  existing: readonly BVHDailyHistoryRecord[],
  sourceSnapshotId: string,
  expected: readonly BVHDailyAggregate[],
): "ABSENT" | "COMPLETE" {
  const found = existing.filter((row) => row.source_snapshot_id === sourceSnapshotId);
  if (found.length === 0) return "ABSENT";
  const foundSignatures = [...new Set(found.map(aggregateSignature))].sort();
  const expectedSignatures = [...new Set(expected.map(aggregateSignature))].sort();
  if (
    found.length !== expected.length
    || foundSignatures.length !== expectedSignatures.length
    || foundSignatures.some((signature, index) => signature !== expectedSignatures[index])
  ) {
    throw new Error(
      `BVH_HISTORY_PARTIAL_SNAPSHOT: ${sourceSnapshotId} has ${found.length}/${expected.length} rows`,
    );
  }
  return "COMPLETE";
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

export function parseBVHDailyHistory(rows: unknown[][]): BVHDailyHistoryRecord[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [cell(name), position]));
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const result: BVHDailyHistoryRecord[] = [];
  for (const row of data) {
    const gameDate = cell(value(row, "Game_Date"));
    const batter = numeric(value(row, "Batter_MLBAM_ID"));
    const handText = cell(value(row, "Pitcher_Hand"));
    const hand: BVHHand | null = handText === "L" || handText === "R" ? handText : null;
    const snapshotId = cell(value(row, "Source_Snapshot_ID"));
    const fetchTs = cell(value(row, "Source_Fetch_TS"));
    if (!gameDate || batter === null || !hand || !snapshotId || !fetchTs) continue;
    result.push({
      game_date: gameDate, batter_mlbam_id: batter, pitcher_hand: hand,
      pa: numeric(value(row, "PA")) ?? 0, ab: numeric(value(row, "AB")) ?? 0,
      hits: numeric(value(row, "H")) ?? 0, bb: numeric(value(row, "BB")) ?? 0,
      ibb: numeric(value(row, "IBB")) ?? 0, hbp: numeric(value(row, "HBP")) ?? 0,
      sf: numeric(value(row, "SF")) ?? 0, total_bases: numeric(value(row, "Total_Bases")) ?? 0,
      source_snapshot_id: snapshotId, source_fetch_ts: fetchTs,
      data_through_date: cell(value(row, "Data_Through_Date")),
    });
  }
  return result;
}

/**
 * Selects one immutable source snapshot per game date. A later fetch wins; an
 * equal-timestamp collision is rejected instead of silently combining data.
 */
export function selectCanonicalBVHDailyHistory(records: readonly BVHDailyHistoryRecord[]): BVHDailyHistoryRecord[] {
  const snapshotsByDate = new Map<string, Map<string, { fetchTs: string; records: BVHDailyHistoryRecord[] }>>();
  for (const record of records) {
    const bySnapshot = snapshotsByDate.get(record.game_date) ?? new Map();
    const snapshot = bySnapshot.get(record.source_snapshot_id) ?? { fetchTs: record.source_fetch_ts, records: [] };
    snapshot.records.push(record);
    bySnapshot.set(record.source_snapshot_id, snapshot);
    snapshotsByDate.set(record.game_date, bySnapshot);
  }
  const selected: BVHDailyHistoryRecord[] = [];
  for (const [date, snapshots] of snapshotsByDate) {
    const ordered = [...snapshots.entries()].sort((a, b) =>
      b[1].fetchTs.localeCompare(a[1].fetchTs) || b[0].localeCompare(a[0]));
    const latestTs = ordered[0]?.[1].fetchTs;
    const sameTs = ordered.filter((entry) => entry[1].fetchTs === latestTs);
    if (sameTs.length > 1) throw new Error(`BVH_DAILY_SNAPSHOT_COLLISION: ${date} ${latestTs}`);
    selected.push(...(ordered[0]?.[1].records ?? []));
  }
  return selected.sort((a, b) =>
    a.game_date.localeCompare(b.game_date)
    || a.batter_mlbam_id - b.batter_mlbam_id
    || a.pitcher_hand.localeCompare(b.pitcher_hand));
}

export async function loadBVHDailyHistory(workbookId = WORKBOOK_ID): Promise<BVHDailyHistoryRecord[]> {
  try {
    const rows = (await readRange(workbookId, `${BVH_DAILY_HISTORY_SHEET}!A1:O150000`)).values ?? [];
    return parseBVHDailyHistory(rows as unknown[][]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("400") || message.includes("Unable to parse range")) return [];
    throw error;
  }
}

export async function persistBVHDailyHistory(
  aggregates: readonly BVHDailyAggregate[],
  sourceSnapshotId: string,
  sourceFetchTs: string,
  dataThroughDate: string,
  workbookId = WORKBOOK_ID,
): Promise<{ rows_written: number; errors: string[] }> {
  try {
    await ensureSheet(workbookId, BVH_DAILY_HISTORY_SHEET, BVH_DAILY_HISTORY_HEADERS);
    const existing = await loadBVHDailyHistory(workbookId);
    if (existingBVHSnapshotState(existing, sourceSnapshotId, aggregates) === "COMPLETE") {
      return { rows_written: 0, errors: [] };
    }
    if (aggregates.length > 0) {
      await appendRange(workbookId, `${BVH_DAILY_HISTORY_SHEET}!A:O`, aggregates.map((row) => [
        row.game_date, row.batter_mlbam_id, row.pitcher_hand, row.pa, row.ab, row.hits, row.bb, row.ibb, row.hbp, row.sf, row.total_bases,
        sourceSnapshotId, sourceFetchTs, dataThroughDate, BVH_VERSION,
      ]));
    }
    return { rows_written: aggregates.length, errors: [] };
  } catch (error: unknown) {
    return { rows_written: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export async function writeBVHBatterSplits(dataset: BVHDataset, workbookId = WORKBOOK_ID): Promise<void> {
  await ensureSheet(workbookId, BVH_BATTER_SPLITS_SHEET, BVH_BATTER_SPLIT_HEADERS);
  const rows = [...dataset.estimates.values()].sort((a, b) => a.batter_mlbam_id - b.batter_mlbam_id).map((estimate) => {
    const l = estimate.vs_lhp;
    const r = estimate.vs_rhp;
    return [
      dataset.version, estimate.batter_mlbam_id,
      l?.raw.pa ?? "", r?.raw.pa ?? "", l?.raw.obp ?? "", r?.raw.obp ?? "", l?.raw.slg ?? "", r?.raw.slg ?? "", l?.raw.ops ?? "", r?.raw.ops ?? "",
      l?.prior_ops ?? "", r?.prior_ops ?? "", l?.prior_source ?? "", r?.prior_source ?? "", l?.shrinkage_weight ?? "", r?.shrinkage_weight ?? "",
      l?.shrunk_ops ?? "", r?.shrunk_ops ?? "", l?.status ?? "NO_SPLIT_SAMPLE", r?.status ?? "NO_SPLIT_SAMPLE",
      dataset.requested_through_date, dataset.actual_data_through_date ?? "", dataset.freshness_lag_days ?? "", dataset.freshness_status,
      dataset.league_baseline_lhp ?? "", dataset.league_baseline_rhp ?? "", dataset.integrity.unclassified_events,
      dataset.integrity.unclassified_event_values.join(" | "), dataset.integrity.excluded_non_pa_events,
      dataset.integrity.excluded_non_pa_event_values.join(" | "), dataset.integrity.malformed_pa_count,
      dataset.integrity.pitch_rows_inspected, dataset.integrity.terminal_pa_count, dataset.deterministic_hash,
    ];
  });
  await clearRange(workbookId, `${BVH_BATTER_SPLITS_SHEET}!A2:AH5000`);
  await writeRange(workbookId, `${BVH_BATTER_SPLITS_SHEET}!A1`, [Array.from(BVH_BATTER_SPLIT_HEADERS), ...rows]);
}
