/** Settlement-only replay for prospectively frozen BVH V1 counterfactuals. */

import {
  addSheet, clearRange, expandSheetColumns, getSpreadsheetSheetProperties,
  readRange, writeRange, WORKBOOK_ID,
} from "../sheets/client.js";
import { ALLOCATION_SETTLEMENT_HEADERS, ALLOCATION_SETTLEMENT_SHEET } from "./module24_postgameDiagnostics.js";
import { BVH_PROJECTION_HISTORY_HEADERS, BVH_PROJECTION_HISTORY_SHEET } from "./module09b_bvhIntegration.js";

export const BVH_PROJECTION_REPLAY_SHEET = "BVH_PROJECTION_REPLAY_V1";
export const BVH_PROJECTION_SUMMARY_SHEET = "BVH_PROJECTION_SUMMARY_V1";

export const BVH_PROJECTION_REPLAY_HEADERS = [
  "Date", "Game_ID", "BVH_Snapshot_TS", "BVH_Version", "Integration_Status",
  "Away_Opposing_Starter_Hand", "Home_Opposing_Starter_Hand",
  "Away_BVH_Coverage", "Home_BVH_Coverage", "Away_BVH_Identity_Coverage", "Home_BVH_Identity_Coverage",
  "Away_BVH_Chain_Uncertainty", "Home_BVH_Chain_Uncertainty", "Away_BVH_Status", "Home_BVH_Status",
  "Away_BVH_Driver_Trace", "Home_BVH_Driver_Trace",
  "Away_BVH_vs_Platoon_Delta", "Home_BVH_vs_Platoon_Delta", "Max_Abs_BVH_vs_Platoon_Delta",
  "Existing_Away_Runs", "Existing_Home_Runs", "Existing_Total",
  "BVH_Away_Runs", "BVH_Home_Runs", "BVH_Total",
  "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total",
  "Existing_Total_Error", "Existing_Total_Abs_Error", "BVH_Total_Error", "BVH_Total_Abs_Error",
  "BVH_Minus_Existing_Abs_Error", "Existing_Away_Abs_Error", "Existing_Home_Abs_Error",
  "BVH_Away_Abs_Error", "BVH_Home_Abs_Error", "Existing_Allocation_MAE", "BVH_Allocation_MAE",
  "BVH_Minus_Existing_Allocation_MAE", "BVH_Delta_Away", "BVH_Delta_Home", "BVH_Delta_Total",
  "Material_Manual_Review", "Settlement_TS", "Replay_TS", "Replay_Status",
] as const;

export const BVH_PROJECTION_SUMMARY_HEADERS = [
  "BVH_Version", "Population", "Eligible_N", "Existing_Total_MAE", "BVH_Total_MAE",
  "Mean_Abs_Error_Delta_BVH_Minus_Existing", "Existing_Median_AE", "BVH_Median_AE",
  "Existing_Bias", "BVH_Bias", "Existing_4Plus_Misses", "BVH_4Plus_Misses",
  "Existing_4Plus_Overprojection", "BVH_4Plus_Overprojection", "Existing_4Plus_Underprojection", "BVH_4Plus_Underprojection",
  "Existing_Away_MAE", "BVH_Away_MAE", "Existing_Home_MAE", "BVH_Home_MAE",
  "Existing_Allocation_MAE", "BVH_Allocation_MAE", "Mean_Abs_BVH_Total_Delta", "Median_Abs_BVH_Total_Delta",
  "Max_Abs_BVH_Total_Delta", "Mean_Abs_Away_Delta", "Mean_Abs_Home_Delta", "Games_Total_Delta_GTE_0_5",
  "Games_Total_Delta_GTE_1_0", "Material_Manual_Review_N", "Replay_TS", "Research_Status",
] as const;

type NamedRow = Record<string, unknown>;

export interface BVHReplayRow {
  date: string; game_id: string; snapshot_ts: string; version: string; integration_status: string;
  away_hand: string; home_hand: string; away_coverage: number; home_coverage: number;
  away_identity_coverage: number; home_identity_coverage: number;
  away_chain_uncertainty: boolean; home_chain_uncertainty: boolean;
  away_status: string; home_status: string; away_driver_trace: string; home_driver_trace: string;
  away_factor_delta: number; home_factor_delta: number;
  existing_away: number; existing_home: number; existing_total: number;
  bvh_away: number; bvh_home: number; bvh_total: number;
  actual_away: number; actual_home: number; actual_total: number; settlement_ts: string;
}

export interface BVHReplaySummary {
  version: string; population: string; n: number;
  existing_total_mae: number | null; bvh_total_mae: number | null; mean_abs_error_delta: number | null;
  existing_median_ae: number | null; bvh_median_ae: number | null;
  existing_bias: number | null; bvh_bias: number | null;
  existing_4plus: number; bvh_4plus: number; existing_4plus_over: number; bvh_4plus_over: number;
  existing_4plus_under: number; bvh_4plus_under: number;
  existing_away_mae: number | null; bvh_away_mae: number | null;
  existing_home_mae: number | null; bvh_home_mae: number | null;
  existing_allocation_mae: number | null; bvh_allocation_mae: number | null;
  mean_abs_total_delta: number | null; median_abs_total_delta: number | null; max_abs_total_delta: number | null;
  mean_abs_away_delta: number | null; mean_abs_home_delta: number | null;
  games_delta_gte_0_5: number; games_delta_gte_1_0: number; manual_review_n: number;
}

export interface BVHReplayResult {
  status: "success" | "failure"; replay_ts: string; frozen_candidates_seen: number;
  eligible_games: number; replay_rows_written: number; summary_rows_written: number;
  warnings: string[]; errors: string[];
}

function text(value: unknown): string { return String(value ?? "").trim(); }
function numericValue(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function boolValue(value: unknown): boolean { return ["TRUE", "YES", "1"].includes(text(value).toUpperCase()); }
function round(value: number, digits = 4): number { return Number(value.toFixed(digits)); }
function namedRows(rows: readonly unknown[][]): NamedRow[] {
  const [header = [], ...data] = rows;
  return data.map((row) => Object.fromEntries((header as unknown[]).map((name, index) => [text(name), row[index]])));
}

export function selectLatestBVHCandidates(rows: readonly NamedRow[]): NamedRow[] {
  const grouped = new Map<string, NamedRow[]>();
  for (const row of rows) {
    const date = text(row.Date);
    const game = text(row.Game_ID);
    const snapshot = text(row.Snapshot_TS);
    if (!date || !game || !snapshot) continue;
    const key = `${date}|${game}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const selected: NamedRow[] = [];
  for (const [key, group] of grouped) {
    const ordered = [...group].sort((a, b) => text(b.Snapshot_TS).localeCompare(text(a.Snapshot_TS)));
    const latestTs = text(ordered[0]?.Snapshot_TS);
    const latest = ordered.filter((row) => text(row.Snapshot_TS) === latestTs);
    const signatures = new Set(latest.map((row) =>
      BVH_PROJECTION_HISTORY_HEADERS.map((header) => text(row[header])).join("|"),
    ));
    if (signatures.size > 1) throw new Error(`BVH_PROJECTION_SNAPSHOT_COLLISION: ${key} ${latestTs}`);
    selected.push(ordered[0]!);
  }
  return selected.sort((a, b) => text(a.Date).localeCompare(text(b.Date)) || text(a.Game_ID).localeCompare(text(b.Game_ID)));
}

export function buildBVHReplay(candidateSheetRows: readonly unknown[][], allocationSheetRows: readonly unknown[][]): BVHReplayRow[] {
  const candidates = selectLatestBVHCandidates(namedRows(candidateSheetRows));
  const allocations = namedRows(allocationSheetRows);
  const allocationMap = new Map<string, NamedRow>();
  for (const row of allocations.sort((a, b) => text(a.Settlement_TS).localeCompare(text(b.Settlement_TS)))) {
    const date = text(row.Date);
    const game = text(row.Game_ID);
    if (date && game) allocationMap.set(`${date}|${game}`, row);
  }
  const replay: BVHReplayRow[] = [];
  for (const row of candidates) {
    const date = text(row.Date);
    const gameId = text(row.Game_ID);
    const actual = allocationMap.get(`${date}|${gameId}`);
    if (!actual) continue;
    const values = [
      numericValue(row.Existing_Away_Runs), numericValue(row.Existing_Home_Runs), numericValue(row.Existing_Total),
      numericValue(row.BVH_Away_Runs), numericValue(row.BVH_Home_Runs), numericValue(row.BVH_Total),
      numericValue(actual.Actual_Away_Runs), numericValue(actual.Actual_Home_Runs), numericValue(actual.Actual_Total),
    ];
    if (values.some((value) => value === null)) continue;
    const [existingAway, existingHome, existingTotal, bvhAway, bvhHome, bvhTotal, actualAway, actualHome, actualTotal] = values as number[];
    replay.push({
      date, game_id: gameId, snapshot_ts: text(row.Snapshot_TS), version: text(row.BVH_Version),
      integration_status: text(row.Integration_Status),
      away_hand: text(row.Away_Opposing_Starter_Hand), home_hand: text(row.Home_Opposing_Starter_Hand),
      away_coverage: numericValue(row.Away_BVH_Coverage) ?? 0, home_coverage: numericValue(row.Home_BVH_Coverage) ?? 0,
      away_identity_coverage: numericValue(row.Away_BVH_Identity_Coverage) ?? 0,
      home_identity_coverage: numericValue(row.Home_BVH_Identity_Coverage) ?? 0,
      away_chain_uncertainty: boolValue(row.Away_BVH_Chain_Uncertainty),
      home_chain_uncertainty: boolValue(row.Home_BVH_Chain_Uncertainty),
      away_status: text(row.Away_BVH_Status), home_status: text(row.Home_BVH_Status),
      away_driver_trace: text(row.Away_BVH_Driver_Trace), home_driver_trace: text(row.Home_BVH_Driver_Trace),
      away_factor_delta: numericValue(row.BVH_vs_Platoon_Delta_Away) ?? 0,
      home_factor_delta: numericValue(row.BVH_vs_Platoon_Delta_Home) ?? 0,
      existing_away: existingAway!, existing_home: existingHome!, existing_total: existingTotal!,
      bvh_away: bvhAway!, bvh_home: bvhHome!, bvh_total: bvhTotal!,
      actual_away: actualAway!, actual_home: actualHome!, actual_total: actualTotal!,
      settlement_ts: text(actual.Settlement_TS),
    });
  }
  return replay;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return round(ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2);
}

export function summarizeBVHReplay(rows: readonly BVHReplayRow[], population = "ALL_PROSPECTIVE"): BVHReplaySummary {
  const existingErrors = rows.map((row) => row.existing_total - row.actual_total);
  const bvhErrors = rows.map((row) => row.bvh_total - row.actual_total);
  const existingAbs = existingErrors.map(Math.abs);
  const bvhAbs = bvhErrors.map(Math.abs);
  const allocation = (row: BVHReplayRow, kind: "existing" | "bvh") => {
    const predictedAway = kind === "existing" ? row.existing_away : row.bvh_away;
    const predictedHome = kind === "existing" ? row.existing_home : row.bvh_home;
    return (
      Math.abs(predictedAway - row.actual_away) + Math.abs(predictedHome - row.actual_home)
    ) / 2;
  };
  const totalDeltas = rows.map((row) => Math.abs(row.bvh_total - row.existing_total));
  return {
    version: rows[0]?.version ?? "1.0.0", population, n: rows.length,
    existing_total_mae: mean(existingAbs), bvh_total_mae: mean(bvhAbs),
    mean_abs_error_delta: mean(bvhAbs.map((value, index) => value - existingAbs[index]!)),
    existing_median_ae: median(existingAbs), bvh_median_ae: median(bvhAbs),
    existing_bias: mean(existingErrors), bvh_bias: mean(bvhErrors),
    existing_4plus: existingErrors.filter((value) => Math.abs(value) >= 4).length,
    bvh_4plus: bvhErrors.filter((value) => Math.abs(value) >= 4).length,
    existing_4plus_over: existingErrors.filter((value) => value >= 4).length,
    bvh_4plus_over: bvhErrors.filter((value) => value >= 4).length,
    existing_4plus_under: existingErrors.filter((value) => value <= -4).length,
    bvh_4plus_under: bvhErrors.filter((value) => value <= -4).length,
    existing_away_mae: mean(rows.map((row) => Math.abs(row.existing_away - row.actual_away))),
    bvh_away_mae: mean(rows.map((row) => Math.abs(row.bvh_away - row.actual_away))),
    existing_home_mae: mean(rows.map((row) => Math.abs(row.existing_home - row.actual_home))),
    bvh_home_mae: mean(rows.map((row) => Math.abs(row.bvh_home - row.actual_home))),
    existing_allocation_mae: mean(rows.map((row) => allocation(row, "existing"))),
    bvh_allocation_mae: mean(rows.map((row) => allocation(row, "bvh"))),
    mean_abs_total_delta: mean(totalDeltas), median_abs_total_delta: median(totalDeltas),
    max_abs_total_delta: totalDeltas.length > 0 ? round(Math.max(...totalDeltas)) : null,
    mean_abs_away_delta: mean(rows.map((row) => Math.abs(row.bvh_away - row.existing_away))),
    mean_abs_home_delta: mean(rows.map((row) => Math.abs(row.bvh_home - row.existing_home))),
    games_delta_gte_0_5: totalDeltas.filter((value) => value >= 0.5).length,
    games_delta_gte_1_0: totalDeltas.filter((value) => value >= 1).length,
    manual_review_n: rows.filter((row) => Math.abs(row.bvh_away - row.existing_away) >= 0.5
      || Math.abs(row.bvh_home - row.existing_home) >= 0.5 || Math.abs(row.bvh_total - row.existing_total) >= 0.75).length,
  };
}

function replayValues(row: BVHReplayRow, replayTs: string): unknown[] {
  const existingError = row.existing_total - row.actual_total;
  const bvhError = row.bvh_total - row.actual_total;
  const existingAwayAbs = Math.abs(row.existing_away - row.actual_away);
  const existingHomeAbs = Math.abs(row.existing_home - row.actual_home);
  const bvhAwayAbs = Math.abs(row.bvh_away - row.actual_away);
  const bvhHomeAbs = Math.abs(row.bvh_home - row.actual_home);
  const material = Math.abs(row.bvh_away - row.existing_away) >= 0.5
    || Math.abs(row.bvh_home - row.existing_home) >= 0.5 || Math.abs(row.bvh_total - row.existing_total) >= 0.75;
  return [
    row.date, row.game_id, row.snapshot_ts, row.version, row.integration_status, row.away_hand, row.home_hand,
    row.away_coverage, row.home_coverage, row.away_identity_coverage, row.home_identity_coverage,
    row.away_chain_uncertainty ? "TRUE" : "FALSE", row.home_chain_uncertainty ? "TRUE" : "FALSE",
    row.away_status, row.home_status, row.away_driver_trace, row.home_driver_trace,
    row.away_factor_delta, row.home_factor_delta, Math.max(Math.abs(row.away_factor_delta), Math.abs(row.home_factor_delta)),
    row.existing_away, row.existing_home, row.existing_total, row.bvh_away, row.bvh_home, row.bvh_total,
    row.actual_away, row.actual_home, row.actual_total,
    round(existingError), round(Math.abs(existingError)), round(bvhError), round(Math.abs(bvhError)),
    round(Math.abs(bvhError) - Math.abs(existingError)), existingAwayAbs, existingHomeAbs, bvhAwayAbs, bvhHomeAbs,
    round((existingAwayAbs + existingHomeAbs) / 2), round((bvhAwayAbs + bvhHomeAbs) / 2),
    round((bvhAwayAbs + bvhHomeAbs - existingAwayAbs - existingHomeAbs) / 2),
    round(row.bvh_away - row.existing_away), round(row.bvh_home - row.existing_home), round(row.bvh_total - row.existing_total),
    material ? "REVIEW_REQUIRED" : "BELOW_MATERIAL_REVIEW_THRESHOLD", row.settlement_ts, replayTs, "ACTIVE_PROSPECTIVE_COUNTERFACTUAL",
  ];
}

function summaryValues(summary: BVHReplaySummary, replayTs: string): unknown[] {
  return [
    summary.version, summary.population, summary.n, summary.existing_total_mae ?? "", summary.bvh_total_mae ?? "",
    summary.mean_abs_error_delta ?? "", summary.existing_median_ae ?? "", summary.bvh_median_ae ?? "",
    summary.existing_bias ?? "", summary.bvh_bias ?? "", summary.existing_4plus, summary.bvh_4plus,
    summary.existing_4plus_over, summary.bvh_4plus_over, summary.existing_4plus_under, summary.bvh_4plus_under,
    summary.existing_away_mae ?? "", summary.bvh_away_mae ?? "", summary.existing_home_mae ?? "", summary.bvh_home_mae ?? "",
    summary.existing_allocation_mae ?? "", summary.bvh_allocation_mae ?? "", summary.mean_abs_total_delta ?? "",
    summary.median_abs_total_delta ?? "", summary.max_abs_total_delta ?? "", summary.mean_abs_away_delta ?? "",
    summary.mean_abs_home_delta ?? "", summary.games_delta_gte_0_5, summary.games_delta_gte_1_0,
    summary.manual_review_n, replayTs, summary.n > 0 ? "ACTIVE_PROSPECTIVE_MONITORING" : "NO_PROSPECTIVE_SETTLEMENTS",
  ];
}

async function ensureSheet(workbookId: string, sheet: string, headers: readonly string[]): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((candidate) => candidate.title === sheet)) await addSheet(workbookId, sheet);
  await expandSheetColumns(workbookId, sheet, headers.length);
}

export async function runBVHProjectionReplay(workbookId = WORKBOOK_ID): Promise<BVHReplayResult> {
  const replayTs = new Date().toISOString();
  try {
    const [candidateRows, allocationRows] = await Promise.all([
      readRange(workbookId, `${BVH_PROJECTION_HISTORY_SHEET}!A1:AQ10000`).then((result) => result.values ?? []).catch(() => [Array.from(BVH_PROJECTION_HISTORY_HEADERS)]),
      readRange(workbookId, `${ALLOCATION_SETTLEMENT_SHEET}!A1:AB10000`).then((result) => result.values ?? []).catch(() => [Array.from(ALLOCATION_SETTLEMENT_HEADERS)]),
    ]);
    const replay = buildBVHReplay(candidateRows as unknown[][], allocationRows as unknown[][]);
    const summaries = [
      summarizeBVHReplay(replay),
      summarizeBVHReplay(replay.filter((row) => row.away_hand === "L" || row.home_hand === "L"), "ANY_LHP_STARTER"),
      summarizeBVHReplay(replay.filter((row) => row.away_hand === "R" || row.home_hand === "R"), "ANY_RHP_STARTER"),
      summarizeBVHReplay(replay.filter((row) => row.away_coverage >= 0.7 && row.home_coverage >= 0.7), "BOTH_LINEUPS_COVERAGE_GTE_0_70"),
      summarizeBVHReplay(replay.filter((row) => row.away_coverage < 0.7 || row.home_coverage < 0.7), "ANY_LINEUP_COVERAGE_LT_0_70"),
      summarizeBVHReplay(replay.filter((row) => row.away_chain_uncertainty || row.home_chain_uncertainty), "CHAIN_UNCERTAINTY"),
    ];
    await Promise.all([
      ensureSheet(workbookId, BVH_PROJECTION_REPLAY_SHEET, BVH_PROJECTION_REPLAY_HEADERS),
      ensureSheet(workbookId, BVH_PROJECTION_SUMMARY_SHEET, BVH_PROJECTION_SUMMARY_HEADERS),
    ]);
    await clearRange(workbookId, `${BVH_PROJECTION_REPLAY_SHEET}!A1:AV10000`);
    await writeRange(workbookId, `${BVH_PROJECTION_REPLAY_SHEET}!A1`, [Array.from(BVH_PROJECTION_REPLAY_HEADERS), ...replay.map((row) => replayValues(row, replayTs))]);
    await clearRange(workbookId, `${BVH_PROJECTION_SUMMARY_SHEET}!A1:AF100`);
    await writeRange(workbookId, `${BVH_PROJECTION_SUMMARY_SHEET}!A1`, [Array.from(BVH_PROJECTION_SUMMARY_HEADERS), ...summaries.map((summary) => summaryValues(summary, replayTs))]);
    return {
      status: "success", replay_ts: replayTs,
      frozen_candidates_seen: selectLatestBVHCandidates(namedRows(candidateRows as unknown[][])).length,
      eligible_games: replay.length, replay_rows_written: replay.length, summary_rows_written: summaries.length,
      warnings: replay.length > 0 ? [] : ["BVH_NO_PROSPECTIVE_SETTLED_COUNTERFACTUALS"], errors: [],
    };
  } catch (error: unknown) {
    return {
      status: "failure", replay_ts: replayTs, frozen_candidates_seen: 0, eligible_games: 0,
      replay_rows_written: 0, summary_rows_written: 0, warnings: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
