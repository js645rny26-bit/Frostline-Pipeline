/**
 * Module 30: Starter Workload Estimator V1 prospective innings diagnostics.
 *
 * Reads only frozen packet-derived starter diagnostics after settlement. It
 * does not create a forecast or write to projection/authorization surfaces.
 * Conventional-starter personalization is evaluated on deviations from the
 * commissioned 6.0-IP role baseline; atypical roles remain separate cohorts.
 */

import {
  addSheet,
  clearRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { STARTER_OUTCOME_HEADERS } from "./module24_postgameDiagnostics.js";
import { NUMERIC_WORKLOAD_VERSION } from "./module03_numericWorkload.js";
import {
  PREGAME_PACKET_HISTORY_HEADERS,
  PREGAME_PACKET_HISTORY_SHEET,
  pregamePacketHistoryRange,
} from "./module20a_pregamePacket.js";

export const SWE_REPLAY_SUMMARY_SHEET = "SWE_WORKLOAD_REPLAY_SUMMARY_V1";
export const SWE_DEVIATION_SHEET = "SWE_WORKLOAD_DEVIATION_V1";
export const SWE_CONVENTIONAL_ROLE_BASELINE_IP = 6;
export const SWE_CORRELATION_MIN_N = 150;

/**
 * Intentionally unresolved in this patch. The floor must be derived from
 * pre-cutoff historical workload outcomes, reviewed, and version-frozen
 * without reference to prospective SWE performance. Until then, even N>=150
 * is not a formal correlation verdict.
 */
export const SWE_ACTUAL_DEVIATION_SD_FLOOR: number | null = null;
export const SWE_VARIANCE_FLOOR_STATUS = "PROPOSED_METHOD_NOT_FROZEN";

export type SWERoleCohort =
  | "CONVENTIONAL_STARTER"
  | "OPENER"
  | "BULK_FOLLOWER_TRANSITION"
  | "UNRESOLVED_OTHER";

export type SWECorrelationSampleStatus =
  | "INSUFFICIENT_N"
  | "INSUFFICIENT_ACTUAL_VARIANCE"
  | "INSUFFICIENT_PREDICTED_VARIANCE"
  | "VARIANCE_FLOOR_NOT_FROZEN"
  | "INTERPRETABLE"
  | "NOT_APPLICABLE_ATYPICAL_ROLE_COHORT";

export const SWE_REPLAY_SUMMARY_HEADERS = [
  "SWE_Version", "Evaluation_Population", "Role_Cohort", "Eligible_Starter_N",
  "SWE_MAE", "Legacy_MAE", "Mean_Abs_Error_Delta_SWE_Minus_Legacy",
  "SWE_Better_Count", "Legacy_Better_Count", "Tie_Count", "Wilcoxon_Non_Tied_N",
  "Wilcoxon_W_Plus", "Wilcoxon_Two_Sided_P", "Correlation_Eligible_N",
  "Conventional_Role_Baseline_IP", "Pearson_R", "Pearson_P", "Spearman_Rho",
  "Spearman_P", "Predicted_Deviation_SD", "Actual_Deviation_SD",
  "Deviation_Calibration_Slope", "Deviation_Calibration_Intercept", "SWE_RMSE",
  "Baseline_RMSE", "SWE_Bias", "Baseline_Bias", "SWE_2Plus_Miss_Count",
  "Baseline_2Plus_Miss_Count", "Correlation_Sample_Status", "Correlation_Score_Status",
  "Variance_Floor_Status", "Actual_Deviation_SD_Floor", "Interpretation_Status",
  "Decision_Status", "Replay_TS",
] as const;

export const SWE_DEVIATION_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Team", "Starter", "Frozen_Role_State", "Role_Cohort",
  "SWE_Version", "SWE_Status", "SWE_Snapshot_Primary", "SWE_Expected_IP",
  "Active_Baseline_IP", "Conventional_Role_Baseline_IP", "Actual_IP",
  "Predicted_Deviation_From_Baseline", "Actual_Deviation_From_Baseline", "Deviation_Error",
  "Predicted_Deviation_Rank", "Actual_Deviation_Rank", "Conventional_Cohort_Flag",
  "SWE_Abs_Error", "Baseline_Abs_Error", "SWE_Better", "SWE_Data_Through_Date",
  "Settlement_TS", "Replay_TS", "Diagnostic_Status",
] as const;

export interface SWEReplayObservation {
  date?: string;
  game_id?: string;
  team_side?: string;
  team?: string;
  starter?: string;
  role_state?: string;
  role_cohort?: SWERoleCohort;
  swe_version?: string;
  swe_status?: string;
  swe_snapshot_primary?: string;
  swe_expected_ip: number;
  active_baseline_ip: number;
  actual_ip: number;
  swe_abs_error?: number;
  baseline_abs_error?: number;
  swe_data_through_date?: string;
  settlement_ts?: string;
}

export interface SWEReplaySummary {
  role_cohort: SWERoleCohort;
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
  correlation_eligible_n: number;
  pearson_r: number | null;
  pearson_p: number | null;
  spearman_rho: number | null;
  spearman_p: number | null;
  predicted_deviation_sd: number | null;
  actual_deviation_sd: number | null;
  deviation_calibration_slope: number | null;
  deviation_calibration_intercept: number | null;
  swe_rmse: number | null;
  baseline_rmse: number | null;
  swe_bias: number | null;
  baseline_bias: number | null;
  swe_2plus_miss_count: number;
  baseline_2plus_miss_count: number;
  correlation_sample_status: SWECorrelationSampleStatus;
  correlation_score_status: string;
  interpretation_status: string;
  decision_status: string;
}

interface SWEDeviationRow extends SWEReplayObservation {
  role_cohort: SWERoleCohort;
  swe_abs_error: number;
  baseline_abs_error: number;
  predicted_deviation: number | null;
  actual_deviation: number | null;
  deviation_error: number | null;
  predicted_rank: number | null;
  actual_rank: number | null;
}

function text(value: unknown): string { return String(value ?? "").trim(); }
function numeric(value: unknown): number | null {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}
function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }
function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function sampleSd(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const center = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + sign * erf);
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left)!;
  const rightMean = mean(right)!;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean), 0);
  const leftScale = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftScale === 0 || rightScale === 0 ? null : numerator / (leftScale * rightScale);
}

/** Fisher-z normal approximation. It remains descriptive until the N/variance gate passes. */
function correlationP(value: number | null, n: number): number | null {
  if (value === null || n < 4) return null;
  if (Math.abs(value) >= 1) return 0;
  const z = Math.atanh(value) * Math.sqrt(n - 3);
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

function averageRanks(values: readonly number[]): number[] {
  const ranked = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const output = new Array<number>(values.length);
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length && ranked[end]!.value === ranked[start]!.value) end++;
    const rank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) output[ranked[index]!.index] = rank;
    start = end;
  }
  return output;
}

function regression(predictor: readonly number[], outcome: readonly number[]): { slope: number | null; intercept: number | null } {
  if (predictor.length !== outcome.length || predictor.length < 2) return { slope: null, intercept: null };
  const predictorMean = mean(predictor)!;
  const outcomeMean = mean(outcome)!;
  const denominator = predictor.reduce((sum, value) => sum + (value - predictorMean) ** 2, 0);
  if (denominator === 0) return { slope: null, intercept: null };
  const slope = predictor.reduce((sum, value, index) => sum + (value - predictorMean) * (outcome[index]! - outcomeMean), 0) / denominator;
  return { slope, intercept: outcomeMean - slope * predictorMean };
}

function roleCohort(role: string): SWERoleCohort {
  const normalized = role.trim().toUpperCase();
  if (normalized === "CONVENTIONAL_STARTER") return "CONVENTIONAL_STARTER";
  if (normalized === "OPENER") return "OPENER";
  if (/BULK|FOLLOWER|TRANSITION|PIGGYBACK/.test(normalized)) return "BULK_FOLLOWER_TRANSITION";
  return "UNRESOLVED_OTHER";
}

function wilcoxon(observations: readonly SWEDeviationRow[]): { n: number; wPlus: number | null; p: number | null } {
  const nonTied = observations
    .map((row) => row.swe_abs_error - row.baseline_abs_error)
    .filter((delta) => delta !== 0);
  const ranked = nonTied.map((delta) => ({ delta, absolute: Math.abs(delta), rank: 0 })).sort((a, b) => a.absolute - b.absolute);
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length && ranked[end]!.absolute === ranked[start]!.absolute) end++;
    const rank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) ranked[index]!.rank = rank;
    start = end;
  }
  if (ranked.length === 0) return { n: 0, wPlus: null, p: null };
  const wPlus = ranked.filter((row) => row.delta > 0).reduce((sum, row) => sum + row.rank, 0);
  const expected = ranked.length * (ranked.length + 1) / 4;
  const variance = ranked.length * (ranked.length + 1) * (2 * ranked.length + 1) / 24;
  const p = variance === 0 ? null : Math.min(1, 2 * (1 - normalCdf(Math.abs((wPlus - expected) / Math.sqrt(variance)))));
  return { n: ranked.length, wPlus, p };
}

function withDerivedValues(observation: SWEReplayObservation): SWEDeviationRow {
  const cohort = observation.role_cohort ?? roleCohort(observation.role_state ?? "");
  const conventional = cohort === "CONVENTIONAL_STARTER";
  const predicted = conventional ? observation.swe_expected_ip - SWE_CONVENTIONAL_ROLE_BASELINE_IP : null;
  const actual = conventional ? observation.actual_ip - SWE_CONVENTIONAL_ROLE_BASELINE_IP : null;
  return {
    ...observation,
    role_cohort: cohort,
    swe_abs_error: observation.swe_abs_error ?? Math.abs(observation.swe_expected_ip - observation.actual_ip),
    baseline_abs_error: observation.baseline_abs_error ?? Math.abs(observation.active_baseline_ip - observation.actual_ip),
    predicted_deviation: predicted,
    actual_deviation: actual,
    deviation_error: predicted === null || actual === null ? null : predicted - actual,
    predicted_rank: null,
    actual_rank: null,
  };
}

function addConventionalRanks(rows: SWEDeviationRow[]): void {
  const conventional = rows.filter((row) => row.role_cohort === "CONVENTIONAL_STARTER");
  const predictedRanks = averageRanks(conventional.map((row) => row.predicted_deviation!));
  const actualRanks = averageRanks(conventional.map((row) => row.actual_deviation!));
  conventional.forEach((row, index) => {
    row.predicted_rank = predictedRanks[index]!;
    row.actual_rank = actualRanks[index]!;
  });
}

export function summarizeSWEReplay(
  observations: readonly SWEReplayObservation[],
  cohort: SWERoleCohort = "CONVENTIONAL_STARTER",
): SWEReplaySummary {
  const rows = observations.map(withDerivedValues).filter((row) => row.role_cohort === cohort);
  const eligible_n = rows.length;
  const sweErrors = rows.map((row) => row.swe_expected_ip - row.actual_ip);
  const baselineErrors = rows.map((row) => row.active_baseline_ip - row.actual_ip);
  const sweAbs = rows.map((row) => row.swe_abs_error);
  const baselineAbs = rows.map((row) => row.baseline_abs_error);
  const swe_mae = mean(sweAbs);
  const legacy_mae = mean(baselineAbs);
  const paired = wilcoxon(rows);
  const conventional = cohort === "CONVENTIONAL_STARTER";
  const predicted = conventional ? rows.map((row) => row.predicted_deviation!) : [];
  const actual = conventional ? rows.map((row) => row.actual_deviation!) : [];
  const predictedSd = sampleSd(predicted);
  const actualSd = sampleSd(actual);
  const pearson = correlation(predicted, actual);
  const predictedRanks = conventional ? averageRanks(predicted) : [];
  const actualRanks = conventional ? averageRanks(actual) : [];
  const spearman = correlation(predictedRanks, actualRanks);
  const calibration = regression(predicted, actual);

  let correlationSampleStatus: SWECorrelationSampleStatus;
  if (!conventional) correlationSampleStatus = "NOT_APPLICABLE_ATYPICAL_ROLE_COHORT";
  else if (eligible_n < SWE_CORRELATION_MIN_N) correlationSampleStatus = "INSUFFICIENT_N";
  else if (predictedSd === null || predictedSd === 0) correlationSampleStatus = "INSUFFICIENT_PREDICTED_VARIANCE";
  else if (actualSd === null || actualSd === 0) correlationSampleStatus = "INSUFFICIENT_ACTUAL_VARIANCE";
  else if (SWE_ACTUAL_DEVIATION_SD_FLOOR === null) correlationSampleStatus = "VARIANCE_FLOOR_NOT_FROZEN";
  else if (actualSd < SWE_ACTUAL_DEVIATION_SD_FLOOR) correlationSampleStatus = "INSUFFICIENT_ACTUAL_VARIANCE";
  else correlationSampleStatus = "INTERPRETABLE";

  const correlationScoreStatus = correlationSampleStatus === "INTERPRETABLE"
    ? "INTERPRETABLE_REVIEW_REQUIRED"
    : correlationSampleStatus === "NOT_APPLICABLE_ATYPICAL_ROLE_COHORT" ? "NOT_APPLICABLE" : "NOT_YET_INTERPRETABLE";
  const interpretationStatus = conventional
    ? correlationSampleStatus === "INTERPRETABLE"
      ? "CONVENTIONAL_DEVIATION_EVIDENCE_READY_FOR_COMMISSIONING_REVIEW"
      : "CONVENTIONAL_DEVIATION_EVIDENCE_DESCRIPTIVE_ONLY"
    : "ATYPICAL_ROLE_EVIDENCE_SEPARATE_HYPOTHESIS_DESCRIPTIVE_ONLY";
  const decisionStatus = conventional
    ? correlationSampleStatus === "INTERPRETABLE" ? "COMMISSIONING_REVIEW_REQUIRED" : "HOLD"
    : "HOLD_SEPARATE_ATYPICAL_ROLE_EVALUATION";

  const pearsonP = correlationP(pearson, eligible_n);
  const spearmanP = correlationP(spearman, eligible_n);
  const sweBias = mean(sweErrors);
  const baselineBias = mean(baselineErrors);
  return {
    role_cohort: cohort,
    eligible_n,
    swe_mae: swe_mae === null ? null : round(swe_mae),
    legacy_mae: legacy_mae === null ? null : round(legacy_mae),
    mean_delta: swe_mae === null || legacy_mae === null ? null : round(swe_mae - legacy_mae),
    swe_better: rows.filter((row) => row.swe_abs_error < row.baseline_abs_error).length,
    legacy_better: rows.filter((row) => row.swe_abs_error > row.baseline_abs_error).length,
    ties: rows.filter((row) => row.swe_abs_error === row.baseline_abs_error).length,
    wilcoxon_n: paired.n,
    wilcoxon_w_plus: paired.wPlus === null ? null : round(paired.wPlus),
    wilcoxon_p: paired.p === null ? null : round(paired.p),
    correlation_eligible_n: conventional ? eligible_n : 0,
    pearson_r: pearson === null ? null : round(pearson),
    pearson_p: pearsonP === null ? null : round(pearsonP),
    spearman_rho: spearman === null ? null : round(spearman),
    spearman_p: spearmanP === null ? null : round(spearmanP),
    predicted_deviation_sd: predictedSd === null ? null : round(predictedSd),
    actual_deviation_sd: actualSd === null ? null : round(actualSd),
    deviation_calibration_slope: calibration.slope === null ? null : round(calibration.slope),
    deviation_calibration_intercept: calibration.intercept === null ? null : round(calibration.intercept),
    swe_rmse: sweErrors.length === 0 ? null : round(Math.sqrt(mean(sweErrors.map((value) => value ** 2))!)),
    baseline_rmse: baselineErrors.length === 0 ? null : round(Math.sqrt(mean(baselineErrors.map((value) => value ** 2))!)),
    swe_bias: sweBias === null ? null : round(sweBias),
    baseline_bias: baselineBias === null ? null : round(baselineBias),
    swe_2plus_miss_count: sweErrors.filter((value) => Math.abs(value) >= 2).length,
    baseline_2plus_miss_count: baselineErrors.filter((value) => Math.abs(value) >= 2).length,
    correlation_sample_status: correlationSampleStatus,
    correlation_score_status: correlationScoreStatus,
    interpretation_status: interpretationStatus,
    decision_status: decisionStatus,
  };
}

export function buildSWEDeviationRows(observations: readonly SWEReplayObservation[]): SWEDeviationRow[] {
  const rows = observations.map(withDerivedValues);
  addConventionalRanks(rows);
  return rows;
}

interface FrozenWorkloadCandidateLineage {
  version: string;
  status: string;
  expected_ip: number;
  data_through_date: string;
}

function candidateKey(date: string, gameId: string, side: string): string {
  return `${date}|${gameId}|${side.toUpperCase()}`;
}

function parseFrozenCandidateLineage(rows: unknown[][]): Map<string, FrozenWorkloadCandidateLineage> {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [text(name), position]));
  const get = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const output = new Map<string, FrozenWorkloadCandidateLineage>();
  for (const row of data) {
    if (text(get(row, "Packet_Status")) !== "FROZEN_PREGAME") continue;
    const date = text(get(row, "Date"));
    const gameId = text(get(row, "Game_ID"));
    const version = text(get(row, "Workload_Candidate_Version"));
    if (!date || !gameId || version !== NUMERIC_WORKLOAD_VERSION) continue;
    for (const side of ["AWAY", "HOME"] as const) {
      const status = text(get(row, `${side === "AWAY" ? "Away" : "Home"}_Workload_Candidate_Status`));
      const expectedIp = numeric(get(row, `${side === "AWAY" ? "Away" : "Home"}_Projected_IP_Shadow`));
      if (status !== "PITCHER_SPECIFIC" || expectedIp === null) continue;
      output.set(candidateKey(date, gameId, side), {
        version,
        status,
        expected_ip: expectedIp,
        data_through_date: text(get(row, `${side === "AWAY" ? "Away" : "Home"}_Workload_Data_Through_Date`)),
      });
    }
  }
  return output;
}

/**
 * Bind settlement grading to the commissioned Module 03 numeric workload
 * shadow.  The older Module 02i SWE_* fields are a separate experiment and
 * must never be substituted when the numeric candidate is absent.
 */
export function parseSWEReplayObservations(
  rows: unknown[][],
  packetRows: unknown[][],
): SWEReplayObservation[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [text(name), position]));
  const get = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const candidateLineage = parseFrozenCandidateLineage(packetRows);
  return data.flatMap((row) => {
    const date = text(get(row, "Date"));
    const gameId = text(get(row, "Game_ID"));
    const side = text(get(row, "Team_Side")).toUpperCase();
    const lineage = candidateLineage.get(candidateKey(date, gameId, side));
    if (!lineage) return [];
    const diagnosticCandidate = numeric(get(row, "Projected_IP_Shadow"));
    const baseline = numeric(get(row, "Legacy_Expected_IP"));
    const actual = numeric(get(row, "Actual_IP")) ?? numeric(get(row, "SWE_Actual_IP"));
    if (diagnosticCandidate === null || baseline === null || actual === null) return [];
    if (Math.abs(diagnosticCandidate - lineage.expected_ip) > 0.000001) return [];
    const sweExpected = lineage.expected_ip;
    return [{
      date, game_id: gameId, team_side: side,
      team: text(get(row, "Team")), starter: text(get(row, "Starter")), role_state: text(get(row, "Role_State")),
      role_cohort: roleCohort(text(get(row, "Role_State"))), swe_version: lineage.version,
      swe_status: lineage.status, swe_snapshot_primary: "YES", swe_expected_ip: sweExpected,
      active_baseline_ip: baseline, actual_ip: actual,
      swe_abs_error: numeric(get(row, "Shadow_IP_Abs_Error")) ?? Math.abs(sweExpected - actual),
      baseline_abs_error: numeric(get(row, "Legacy_Abs_Error")) ?? Math.abs(baseline - actual),
      swe_data_through_date: lineage.data_through_date, settlement_ts: text(get(row, "Settlement_TS")),
    }];
  });
}

async function ensureSheet(workbookId: string, name: string, columns: number): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((sheet) => sheet.title === name)) await addSheet(workbookId, name);
  await expandSheetColumns(workbookId, name, columns);
}

function summaryValues(summary: SWEReplaySummary, replayTs: string): unknown[] {
  return [
    NUMERIC_WORKLOAD_VERSION, "FROZEN_PRIMARY_SETTLED_STARTERS_BY_ROLE", summary.role_cohort, summary.eligible_n,
    summary.swe_mae ?? "", summary.legacy_mae ?? "", summary.mean_delta ?? "", summary.swe_better,
    summary.legacy_better, summary.ties, summary.wilcoxon_n, summary.wilcoxon_w_plus ?? "",
    summary.wilcoxon_p ?? "", summary.correlation_eligible_n, SWE_CONVENTIONAL_ROLE_BASELINE_IP,
    summary.pearson_r ?? "", summary.pearson_p ?? "", summary.spearman_rho ?? "", summary.spearman_p ?? "",
    summary.predicted_deviation_sd ?? "", summary.actual_deviation_sd ?? "",
    summary.deviation_calibration_slope ?? "", summary.deviation_calibration_intercept ?? "",
    summary.swe_rmse ?? "", summary.baseline_rmse ?? "", summary.swe_bias ?? "", summary.baseline_bias ?? "",
    summary.swe_2plus_miss_count, summary.baseline_2plus_miss_count, summary.correlation_sample_status,
    summary.correlation_score_status, SWE_VARIANCE_FLOOR_STATUS, SWE_ACTUAL_DEVIATION_SD_FLOOR ?? "",
    summary.interpretation_status, summary.decision_status, replayTs,
  ];
}

function deviationValues(row: SWEDeviationRow, replayTs: string): unknown[] {
  return [
    row.date ?? "", row.game_id ?? "", row.team_side ?? "", row.team ?? "", row.starter ?? "",
    row.role_state ?? "", row.role_cohort, row.swe_version ?? NUMERIC_WORKLOAD_VERSION, row.swe_status ?? "",
    row.swe_snapshot_primary ?? "YES", round(row.swe_expected_ip), round(row.active_baseline_ip),
    row.role_cohort === "CONVENTIONAL_STARTER" ? SWE_CONVENTIONAL_ROLE_BASELINE_IP : "", round(row.actual_ip),
    row.predicted_deviation === null ? "" : round(row.predicted_deviation),
    row.actual_deviation === null ? "" : round(row.actual_deviation),
    row.deviation_error === null ? "" : round(row.deviation_error),
    row.predicted_rank === null ? "" : round(row.predicted_rank), row.actual_rank === null ? "" : round(row.actual_rank),
    row.role_cohort === "CONVENTIONAL_STARTER" ? "YES" : "NO", round(row.swe_abs_error),
    round(row.baseline_abs_error), row.swe_abs_error < row.baseline_abs_error ? "YES" : row.swe_abs_error > row.baseline_abs_error ? "NO" : "TIE",
    row.swe_data_through_date ?? "", row.settlement_ts ?? "", replayTs,
    row.role_cohort === "CONVENTIONAL_STARTER" ? "DEVIATION_DIAGNOSTIC" : "SEPARATE_ATYPICAL_ROLE_HYPOTHESIS",
  ];
}

export async function runStarterWorkloadReplay(workbookId = WORKBOOK_ID): Promise<{
  status: "success" | "failure";
  summary: SWEReplaySummary;
  summaries: SWEReplaySummary[];
  deviation_rows_written: number;
  errors: string[];
}> {
  const empty = summarizeSWEReplay([], "CONVENTIONAL_STARTER");
  try {
    const [sourceResponse, packetResponse] = await Promise.all([
      readRange(workbookId, "STARTER_OUTCOME_DIAGNOSTICS!A1:BU20000"),
      readRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`),
    ]);
    const source = sourceResponse.values ?? [];
    const packetRows = packetResponse.values ?? [];
    const observations = parseSWEReplayObservations(source as unknown[][], packetRows as unknown[][]);
    const deviations = buildSWEDeviationRows(observations);
    const cohorts: SWERoleCohort[] = ["CONVENTIONAL_STARTER", "OPENER", "BULK_FOLLOWER_TRANSITION", "UNRESOLVED_OTHER"];
    const summaries = cohorts.map((cohort) => summarizeSWEReplay(observations, cohort));
    const replayTs = new Date().toISOString();

    await ensureSheet(workbookId, SWE_REPLAY_SUMMARY_SHEET, SWE_REPLAY_SUMMARY_HEADERS.length);
    await ensureSheet(workbookId, SWE_DEVIATION_SHEET, SWE_DEVIATION_HEADERS.length);
    await clearRange(workbookId, `${SWE_REPLAY_SUMMARY_SHEET}!A1:AJ100`);
    await clearRange(workbookId, `${SWE_DEVIATION_SHEET}!A1:AA20000`);
    await writeRange(workbookId, `${SWE_REPLAY_SUMMARY_SHEET}!A1`, [
      Array.from(SWE_REPLAY_SUMMARY_HEADERS),
      ...summaries.map((summary) => summaryValues(summary, replayTs)),
    ]);
    await writeRange(workbookId, `${SWE_DEVIATION_SHEET}!A1`, [
      Array.from(SWE_DEVIATION_HEADERS),
      ...deviations.map((row) => deviationValues(row, replayTs)),
    ]);
    return { status: "success", summary: summaries[0]!, summaries, deviation_rows_written: deviations.length, errors: [] };
  } catch (error: unknown) {
    return { status: "failure", summary: empty, summaries: [empty], deviation_rows_written: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export const SWE_REPLAY_REQUIRED_STARTER_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Team", "Starter", "Role_State",
  "Projected_IP_Shadow", "Shadow_IP_Abs_Error", "Legacy_Expected_IP", "Legacy_Abs_Error",
  "Actual_IP", "Settlement_TS",
] as const;
export const SWE_REPLAY_STARTER_HEADER_CONTRACT = SWE_REPLAY_REQUIRED_STARTER_HEADERS.every((name) => STARTER_OUTCOME_HEADERS.includes(name as never));
export const SWE_REPLAY_PACKET_HEADER_CONTRACT = [
  "Date", "Game_ID", "Packet_Status", "Workload_Candidate_Version",
  "Away_Workload_Candidate_Status", "Away_Workload_Data_Through_Date", "Away_Projected_IP_Shadow",
  "Home_Workload_Candidate_Status", "Home_Workload_Data_Through_Date", "Home_Projected_IP_Shadow",
].every((name) => PREGAME_PACKET_HISTORY_HEADERS.includes(name as never));
