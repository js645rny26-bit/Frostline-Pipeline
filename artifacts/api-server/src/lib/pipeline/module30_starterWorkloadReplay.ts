/**
 * Module 30: Starter Workload Estimator V1 paired innings replay.
 *
 * Reads frozen packet-derived starter diagnostics after settlement. It does
 * not create a forecast or write to projection/authorization surfaces.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { STARTER_OUTCOME_HEADERS } from "./module24_postgameDiagnostics.js";

export const SWE_REPLAY_SUMMARY_SHEET = "SWE_WORKLOAD_REPLAY_SUMMARY_V1";
export const SWE_REPLAY_SUMMARY_HEADERS = [
  "SWE_Version", "Evaluation_Population", "Eligible_Starter_N", "SWE_MAE", "Legacy_MAE",
  "Mean_Abs_Error_Delta_SWE_Minus_Legacy", "SWE_Better_Count", "Legacy_Better_Count", "Tie_Count",
  "Wilcoxon_Non_Tied_N", "Wilcoxon_W_Plus", "Wilcoxon_Two_Sided_P", "Decision_Status",
  "Replay_TS",
] as const;

export interface SWEReplayObservation {
  swe_abs_error: number;
  legacy_abs_error: number;
}

export interface SWEReplaySummary {
  eligible_n: number;
  swe_mae: number | null;
  legacy_mae: number | null;
  mean_delta: number | null;
  swe_better: number;
  legacy_better: number;
  ties: number;
  wilcoxon_n: number;
  wilcoxon_w_plus: number | null;
  wilcoxon_p: number | null;
  decision_status: string;
}

function text(value: unknown): string { return String(value ?? "").trim(); }
function numeric(value: unknown): number | null {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}
function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }

function normalCdf(value: number): number {
  // Abramowitz-Stegun approximation; sufficient for a declared secondary
  // checkpoint statistic, with the paired raw errors retained beside it.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + sign * erf);
}

export function summarizeSWEReplay(observations: readonly SWEReplayObservation[]): SWEReplaySummary {
  const eligible_n = observations.length;
  const swe_better = observations.filter((row) => row.swe_abs_error < row.legacy_abs_error).length;
  const legacy_better = observations.filter((row) => row.swe_abs_error > row.legacy_abs_error).length;
  const ties = eligible_n - swe_better - legacy_better;
  const nonTied = observations
    .map((row) => row.swe_abs_error - row.legacy_abs_error)
    .filter((delta) => delta !== 0);
  const ranked = nonTied.map((delta) => ({ delta, absolute: Math.abs(delta), rank: 0 })).sort((a, b) => a.absolute - b.absolute);
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length && ranked[end]!.absolute === ranked[start]!.absolute) end++;
    const rank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) ranked[index]!.rank = rank;
    start = end;
  }
  const wilcoxon_n = ranked.length;
  const wilcoxon_w_plus = wilcoxon_n === 0 ? null : ranked.filter((row) => row.delta > 0).reduce((sum, row) => sum + row.rank, 0);
  const expected = wilcoxon_n * (wilcoxon_n + 1) / 4;
  const variance = wilcoxon_n * (wilcoxon_n + 1) * (2 * wilcoxon_n + 1) / 24;
  const wilcoxon_p = wilcoxon_w_plus === null || variance === 0
    ? null
    : round(Math.min(1, 2 * (1 - normalCdf(Math.abs((wilcoxon_w_plus - expected) / Math.sqrt(variance))))));
  const swe_mae = eligible_n === 0 ? null : round(observations.reduce((sum, row) => sum + row.swe_abs_error, 0) / eligible_n);
  const legacy_mae = eligible_n === 0 ? null : round(observations.reduce((sum, row) => sum + row.legacy_abs_error, 0) / eligible_n);
  const mean_delta = swe_mae === null || legacy_mae === null ? null : round(swe_mae - legacy_mae);
  let decision_status = "PRE_CHECKPOINT_DESCRIPTIVE";
  if (eligible_n >= 150 && wilcoxon_p !== null && wilcoxon_p < 0.05) {
    decision_status = swe_mae! < legacy_mae! ? "SWE_BETTER_PROPOSE_SEPARATE_PROMOTION_REVIEW" : "LEGACY_BETTER_RETIRE_SWE_V1";
  } else if (eligible_n >= 300) {
    decision_status = "AMBIGUOUS_AT_N300_RETIRE_SWE_V1";
  } else if (eligible_n >= 150) {
    decision_status = "NO_SIGNIFICANT_DIFFERENCE_KEEP_SHADOW_TO_N300";
  }
  return { eligible_n, swe_mae, legacy_mae, mean_delta, swe_better, legacy_better, ties, wilcoxon_n, wilcoxon_w_plus: wilcoxon_w_plus === null ? null : round(wilcoxon_w_plus), wilcoxon_p, decision_status };
}

function parseEligibleObservations(rows: unknown[][]): SWEReplayObservation[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [text(name), position]));
  const get = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  return data.flatMap((row) => {
    if (text(get(row, "SWE_Snapshot_Primary")) !== "YES") return [];
    if (text(get(row, "SWE_Status")) === "INSUFFICIENT_HISTORY" || text(get(row, "SWE_Status")) === "OUTS_UNRESOLVED") return [];
    const swe = numeric(get(row, "SWE_Abs_Error"));
    const legacy = numeric(get(row, "Legacy_Abs_Error"));
    return swe === null || legacy === null ? [] : [{ swe_abs_error: swe, legacy_abs_error: legacy }];
  });
}

async function ensureSummarySheet(workbookId: string): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((sheet) => sheet.title === SWE_REPLAY_SUMMARY_SHEET)) await addSheet(workbookId, SWE_REPLAY_SUMMARY_SHEET);
  await expandSheetColumns(workbookId, SWE_REPLAY_SUMMARY_SHEET, SWE_REPLAY_SUMMARY_HEADERS.length);
}

export async function runStarterWorkloadReplay(workbookId = WORKBOOK_ID): Promise<{ status: "success" | "failure"; summary: SWEReplaySummary; errors: string[] }> {
  const empty = summarizeSWEReplay([]);
  try {
    const rows = (await readRange(workbookId, "STARTER_OUTCOME_DIAGNOSTICS!A1:BU20000")).values ?? [];
    const summary = summarizeSWEReplay(parseEligibleObservations(rows as unknown[][]));
    await ensureSummarySheet(workbookId);
    await writeRange(workbookId, `${SWE_REPLAY_SUMMARY_SHEET}!A1`, [
      Array.from(SWE_REPLAY_SUMMARY_HEADERS),
      ["1.0.0", "FROZEN_PRIMARY_SETTLED_STARTERS", summary.eligible_n, summary.swe_mae ?? "", summary.legacy_mae ?? "", summary.mean_delta ?? "", summary.swe_better, summary.legacy_better, summary.ties, summary.wilcoxon_n, summary.wilcoxon_w_plus ?? "", summary.wilcoxon_p ?? "", summary.decision_status, new Date().toISOString()],
    ]);
    return { status: "success", summary, errors: [] };
  } catch (error: unknown) {
    return { status: "failure", summary: empty, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

// Guard the parser against header drift in unit tests and in future schema work.
export const SWE_REPLAY_REQUIRED_STARTER_HEADERS = [
  "SWE_Snapshot_Primary", "SWE_Status", "SWE_Abs_Error", "Legacy_Abs_Error",
] as const;
export const SWE_REPLAY_STARTER_HEADER_CONTRACT = SWE_REPLAY_REQUIRED_STARTER_HEADERS.every((name) => STARTER_OUTCOME_HEADERS.includes(name as never));
