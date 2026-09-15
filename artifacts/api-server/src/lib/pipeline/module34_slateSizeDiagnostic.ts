/**
 * Module 34: Slate-Size Diagnostic V1 + operator postmortem audit.
 *
 * Settlement-only research. It summarizes the already-settled, immutable
 * GAME_TRUTH_SLATE_DIAG_V2 corpus and preserves explicitly supplied human
 * truth/execution notes in a separate append-only audit. Nothing here is an
 * input to ACTIVE_GAME_FORECAST, GAME_SUMMARY, SLATE_BOARD, market grading,
 * or packet publication.
 */

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
import { logger } from "../../lib/logger.js";
import {
  GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS,
  GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET,
} from "./module29_gameTruthDistributionResearch.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { RUN_LOG_HEADERS } from "./module12_archival.js";

export const SLATE_SIZE_DIAGNOSTIC_SHEET = "SLATE_SIZE_DIAGNOSTIC_V1";
export const SLATE_SIZE_SUMMARY_SHEET = "SLATE_SIZE_SUMMARY_V1";
export const HUMAN_GAME_TRUTH_AUDIT_SHEET = "HUMAN_GAME_TRUTH_AUDIT_V1";
export const SLATE_SIZE_DIAGNOSTIC_VERSION = "SLATE_SIZE_DIAGNOSTIC_V1_2026-09-15";

export type SlateSizeVerdict = "FAIL" | "HOLD" | "CONTINUE_SHADOW" | "CANDIDATE_FOR_COMMISSIONING";

export const SLATE_SIZE_DIAGNOSTIC_HEADERS = [
  "Date", "Diagnostic_Version", "Research_Status", "Frozen_Games", "Slate_Size_Bucket",
  "Frozen_Projected_Run_Sum", "Actual_Run_Sum", "Signed_Error", "Per_Game_MAE",
  "Per_Game_RMSE", "Median_Absolute_Error", "Misses_GE_3", "Misses_GE_4", "Misses_GE_5",
  "Projected_Actual_Spearman_Rho", "Higher_Scoring_Side_Correct_Rate",
  "Allocation_Sign_Reversals", "Full_Pregame_Scope_Rate", "Partial_Pregame_Scope_Rate",
  "Confirmed_Lineup_Rate", "Partial_Lineup_Rate", "Unresolved_Starter_Rate",
  "Opener_Bulk_Rate", "Day_Game_Share", "Day_Game_Share_Status",
  "Doubleheader_Game_Count", "Doubleheader_Status", "Weather_Freeze_Count",
  "Starter_Role_Uncertainty_Count", "Bullpen_Data_Available_Rate",
  "Statcast_Preview_Coverage", "Projection_Writable_Game_Count", "Protected_Game_Count",
  "Frozen_Packet_Game_Count", "Composition_Data_Status", "Diagnostic_Notes", "Replay_TS",
] as const;

export const SLATE_SIZE_SUMMARY_HEADERS = [
  "Summary_Dimension", "Cohort", "Slates_N", "Games_N", "Cell_Status",
  "Slate_Size_Min", "Slate_Size_Max", "Weighted_Game_MAE", "Weighted_MAE_CI_Lower",
  "Weighted_MAE_CI_Upper", "Mean_Slate_MAE", "Median_Slate_MAE", "Pooled_RMSE",
  "Per_Game_Signed_Bias", "Large_Miss_Rate_GE_3", "Mean_Spearman_Rho",
  "Allocation_Side_Accuracy", "Slate_Size_MAE_Pearson_R", "Adjusted_Complete_Case_N",
  "Adjusted_Slate_Size_Std_Coefficient", "Adjusted_Model_R2", "Adjustment_Status",
  "Observable_Adjustment_Features", "Research_Verdict", "Summary_Notes", "Replay_TS",
] as const;

export const HUMAN_GAME_TRUTH_AUDIT_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Frozen_Projection", "Actual_Total",
  "Projection_Error", "Frozen_Pipeline_Market_Line", "Operator_Execution_Market_Line",
  "Operator_Market_Source", "Operator_Market_TS", "Operator_Market_TS_Status",
  "Human_Truth", "Human_Execution", "Human_Settlement", "Case_Level_Diagnosis",
  "Structural_Finding_Status", "Market_Provenance", "Notes", "Record_Status", "Recorded_TS",
] as const;

interface SlateDiagnostic {
  date: string;
  frozen_games: number;
  projected_sum: number;
  actual_sum: number;
  signed_error: number;
  mae: number;
  rmse: number;
  median_ae: number;
  misses_ge_3: number;
  misses_ge_4: number;
  misses_ge_5: number;
  spearman: number | null;
  allocation_eligible: number;
  higher_side_correct: number;
  allocation_reversals: number;
  full_scope_rate: number | null;
  partial_scope_rate: number | null;
  confirmed_lineup_rate: number | null;
  partial_lineup_rate: number | null;
  unresolved_starter_rate: number | null;
  opener_bulk_rate: number | null;
  weather_freeze_count: number | null;
  starter_role_uncertainty_count: number | null;
  bullpen_available_rate: number | null;
  statcast_coverage: number | null;
  projection_writable: number | null;
  protected_games: number | null;
  packet_games: number;
  composition_status: string;
}

export interface SlateSizeDiagnosticResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  slate_rows_seen: number;
  diagnostic_rows_written: number;
  summary_rows_written: number;
  human_rows_appended: number;
  human_rows_preserved: number;
  verdict: SlateSizeVerdict;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match ? `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : "";
}

function indexOfHeaders(header: unknown[]): Map<string, number> {
  return new Map(header.map((value, index) => [text(value), index]));
}

function field(row: unknown[], index: Map<string, number>, name: string): unknown {
  return row[index.get(name) ?? -1];
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function blank(value: number | null, digits = 6): number | "" {
  return value === null || !Number.isFinite(value) ? "" : round(value, digits);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left)!;
  const rightMean = mean(right)!;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean), 0);
  const denominator = Math.sqrt(
    left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0)
      * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
  );
  return denominator > 0 ? numerator / denominator : null;
}

export function slateSizeBucket(games: number): "<=10" | "11-12" | "13-16" | "17+" {
  return games <= 10 ? "<=10" : games <= 12 ? "11-12" : games <= 16 ? "13-16" : "17+";
}

interface PacketComposition {
  games: number;
  confirmed_lineup_rate: number | null;
  partial_lineup_rate: number | null;
  unresolved_starter_rate: number | null;
  opener_bulk_rate: number | null;
  weather_freeze_count: number | null;
  starter_uncertainty_count: number | null;
  bullpen_available_rate: number | null;
  status: string;
}

function packetCompositionByDate(rows: unknown[][]): Map<string, PacketComposition> {
  const [header = [], ...data] = rows;
  const index = indexOfHeaders(header);
  const unique = new Map<string, unknown[]>();
  for (const row of data) {
    if (text(field(row, index, "Packet_Status")) !== "FROZEN_PREGAME") continue;
    const date = canonicalDate(field(row, index, "Date"));
    const gameId = text(field(row, index, "Game_ID"));
    if (date && gameId) unique.set(`${date}|${gameId}`, row);
  }
  const grouped = new Map<string, unknown[][]>();
  for (const [key, row] of unique) {
    const date = key.slice(0, 10);
    const bucket = grouped.get(date) ?? [];
    bucket.push(row);
    grouped.set(date, bucket);
  }
  const result = new Map<string, PacketComposition>();
  for (const [date, packetRows] of grouped) {
    let lineupKnown = 0;
    let lineupConfirmed = 0;
    let rolesKnown = 0;
    let unresolved = 0;
    let openerBulk = 0;
    let weatherKnown = 0;
    let weatherFreeze = 0;
    let bullpenKnown = 0;
    let bullpenAvailable = 0;
    for (const row of packetRows) {
      const awayCoverage = numeric(field(row, index, "Away_Lineup_Coverage"));
      const homeCoverage = numeric(field(row, index, "Home_Lineup_Coverage"));
      const awayLineup = text(field(row, index, "Away_Lineup_Status"));
      const homeLineup = text(field(row, index, "Home_Lineup_Status"));
      if (awayCoverage !== null && homeCoverage !== null && awayLineup && homeLineup) {
        lineupKnown += 1;
        if (awayCoverage >= 0.95 && homeCoverage >= 0.95
          && /FULL|CONFIRMED/.test(awayLineup) && /FULL|CONFIRMED/.test(homeLineup)) lineupConfirmed += 1;
      }
      for (const role of [text(field(row, index, "Away_Starter_Role")), text(field(row, index, "Home_Starter_Role"))]) {
        if (!role) continue;
        rolesKnown += 1;
        if (role === "UNRESOLVED") unresolved += 1;
        if (role === "OPENER" || role === "BULK") openerBulk += 1;
      }
      const weather = text(field(row, index, "Weather_Vehicle_Status"));
      if (weather) {
        weatherKnown += 1;
        if (weather === "ACTIVE") weatherFreeze += 1;
      }
      const bullpen = text(field(row, index, "Bullpen_Data_Status"));
      if (bullpen) {
        bullpenKnown += 1;
        if (bullpen === "AVAILABLE") bullpenAvailable += 1;
      }
    }
    const complete = lineupKnown > 0 && rolesKnown > 0 && weatherKnown > 0 && bullpenKnown > 0;
    result.set(date, {
      games: packetRows.length,
      confirmed_lineup_rate: lineupKnown ? lineupConfirmed / lineupKnown : null,
      partial_lineup_rate: lineupKnown ? 1 - lineupConfirmed / lineupKnown : null,
      unresolved_starter_rate: rolesKnown ? unresolved / rolesKnown : null,
      opener_bulk_rate: rolesKnown ? openerBulk / rolesKnown : null,
      weather_freeze_count: weatherKnown ? weatherFreeze : null,
      starter_uncertainty_count: rolesKnown ? unresolved : null,
      bullpen_available_rate: bullpenKnown ? bullpenAvailable / bullpenKnown : null,
      status: complete ? "AVAILABLE_FROM_FROZEN_PACKETS" : "PARTIAL_HISTORICAL_COVERAGE",
    });
  }
  return result;
}

interface RunComposition {
  full_rate: number | null;
  partial_rate: number | null;
  statcast_coverage: number | null;
  projection_writable: number | null;
  protected_games: number | null;
}

function runCompositionByDate(rows: unknown[][]): Map<string, RunComposition> {
  const [header = [], ...data] = rows;
  const index = indexOfHeaders(header);
  const grouped = new Map<string, unknown[][]>();
  for (const row of data) {
    const date = canonicalDate(field(row, index, "Date"));
    if (!date) continue;
    const bucket = grouped.get(date) ?? [];
    bucket.push(row);
    grouped.set(date, bucket);
  }
  const output = new Map<string, RunComposition>();
  for (const [date, runRows] of grouped) {
    const scopes = runRows.map((row) => text(field(row, index, "Publication_Scope"))).filter(Boolean);
    const coverages = runRows.flatMap((row) => {
      const expected = numeric(field(row, index, "Statcast_Preview_Games_Expected"));
      const parsed = numeric(field(row, index, "Statcast_Preview_Games_Parsed"));
      return expected !== null && expected > 0 && parsed !== null ? [parsed / expected] : [];
    });
    const writable = runRows.map((row) => numeric(field(row, index, "Projection_Writable_Games"))).filter((v): v is number => v !== null);
    const protectedCounts = runRows.map((row) => numeric(field(row, index, "Protected_Games_At_Start"))).filter((v): v is number => v !== null);
    output.set(date, {
      full_rate: scopes.length ? scopes.filter((scope) => scope === "FULL_PREGAME_SCOPE").length / scopes.length : null,
      partial_rate: scopes.length ? scopes.filter((scope) => scope === "PARTIAL_PREGAME_SCOPE").length / scopes.length : null,
      statcast_coverage: coverages.length ? Math.max(...coverages) : null,
      projection_writable: writable.length ? Math.max(...writable) : null,
      protected_games: protectedCounts.length ? Math.min(...protectedCounts) : null,
    });
  }
  return output;
}

export function parseSlateDiagnostics(
  slateRows: unknown[][],
  packetRows: unknown[][] = [],
  runRows: unknown[][] = [],
): SlateDiagnostic[] {
  const [header = [], ...data] = slateRows;
  const index = indexOfHeaders(header);
  const packets = packetCompositionByDate(packetRows);
  const runs = runCompositionByDate(runRows);
  const output: SlateDiagnostic[] = [];
  for (const row of data) {
    const date = canonicalDate(field(row, index, "Date"));
    const required = [
      "Frozen_Games", "Frozen_Projected_Run_Sum", "Actual_Run_Sum",
      "Aggregate_Error_Model_Minus_Actual", "Per_Game_MAE", "Per_Game_RMSE",
      "Median_Absolute_Error", "Misses_GE_3", "Misses_GE_4", "Misses_GE_5",
      "Allocation_Eligible_Games", "Higher_Scoring_Side_Correct", "Allocation_Sign_Reversals",
    ].map((name) => numeric(field(row, index, name)));
    if (!date || required.some((value) => value === null)) continue;
    const packet = packets.get(date);
    const run = runs.get(date);
    const spearman = numeric(field(row, index, "Projected_Actual_Spearman_Rho"));
    output.push({
      date, frozen_games: required[0]!, projected_sum: required[1]!, actual_sum: required[2]!,
      signed_error: required[3]!, mae: required[4]!, rmse: required[5]!, median_ae: required[6]!,
      misses_ge_3: required[7]!, misses_ge_4: required[8]!, misses_ge_5: required[9]!,
      spearman, allocation_eligible: required[10]!, higher_side_correct: required[11]!,
      allocation_reversals: required[12]!, full_scope_rate: run?.full_rate ?? null,
      partial_scope_rate: run?.partial_rate ?? null,
      confirmed_lineup_rate: packet?.confirmed_lineup_rate ?? null,
      partial_lineup_rate: packet?.partial_lineup_rate ?? null,
      unresolved_starter_rate: packet?.unresolved_starter_rate ?? null,
      opener_bulk_rate: packet?.opener_bulk_rate ?? null,
      weather_freeze_count: packet?.weather_freeze_count ?? null,
      starter_role_uncertainty_count: packet?.starter_uncertainty_count ?? null,
      bullpen_available_rate: packet?.bullpen_available_rate ?? null,
      statcast_coverage: run?.statcast_coverage ?? null,
      projection_writable: run?.projection_writable ?? null,
      protected_games: run?.protected_games ?? null,
      packet_games: packet?.games ?? 0,
      composition_status: packet?.status ?? "UNAVAILABLE_HISTORICALLY",
    });
  }
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * probability);
  return sorted[index]!;
}

function bootstrapWeightedMae(rows: SlateDiagnostic[], iterations = 2000): [number | null, number | null] {
  if (!rows.length) return [null, null];
  const rng = mulberry32(20260915 + rows.length);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[Math.floor(rng() * rows.length)]!;
      numerator += row.mae * row.frozen_games;
      denominator += row.frozen_games;
    }
    estimates.push(numerator / denominator);
  }
  return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}

function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let pivot = 0; pivot < matrix.length; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < matrix.length; row += 1) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[best]![pivot]!)) best = row;
    }
    if (Math.abs(augmented[best]![pivot]!) < 1e-10) return null;
    [augmented[pivot], augmented[best]] = [augmented[best]!, augmented[pivot]!];
    const divisor = augmented[pivot]![pivot]!;
    for (let column = pivot; column <= matrix.length; column += 1) augmented[pivot]![column] /= divisor;
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = pivot; column <= matrix.length; column += 1) {
        augmented[row]![column] -= factor * augmented[pivot]![column]!;
      }
    }
  }
  return augmented.map((row) => row[matrix.length]!);
}

function zscore(values: number[]): number[] | null {
  const center = mean(values)!;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
  return sd > 1e-12 ? values.map((value) => (value - center) / sd) : null;
}

function adjustedCompositionModel(rows: SlateDiagnostic[]): {
  n: number; coefficient: number | null; r2: number | null; status: string; features: string;
} {
  const candidates = [
    ["Confirmed_Lineup_Rate", (row: SlateDiagnostic) => row.confirmed_lineup_rate],
    ["Unresolved_Starter_Rate", (row: SlateDiagnostic) => row.unresolved_starter_rate],
    ["Opener_Bulk_Rate", (row: SlateDiagnostic) => row.opener_bulk_rate],
    ["Statcast_Preview_Coverage", (row: SlateDiagnostic) => row.statcast_coverage],
  ] as const;
  // Feature eligibility depends only on historical observability and variance,
  // never on its relationship with the outcome. Zero-variance covariates carry
  // no adjustment information and are reported as excluded rather than making
  // the full descriptive model singular.
  const eligible = candidates.filter(([, getter]) => {
    const values = rows.flatMap((row) => {
      const value = getter(row);
      return value !== null && Number.isFinite(value) ? [value] : [];
    });
    if (values.length < 15) return false;
    const center = mean(values)!;
    return values.some((value) => Math.abs(value - center) > 1e-12);
  });
  const features = eligible.map(([name]) => name).join(" + ");
  if (!eligible.length) return { n: 0, coefficient: null, r2: null, status: "NO_OBSERVABLE_VARIABLE_COMPOSITION_FEATURE", features: "NONE" };
  const complete = rows.filter((row) => eligible.every(([, getter]) => {
    const value = getter(row);
    return value !== null && Number.isFinite(value);
  }));
  if (complete.length < 15) return { n: complete.length, coefficient: null, r2: null, status: "INSUFFICIENT_COMPLETE_CASE_SLATES", features };
  const rawColumns = [
    complete.map((row) => row.frozen_games),
    ...eligible.map(([, getter]) => complete.map((row) => getter(row)!)),
  ];
  const standardized = rawColumns.map(zscore);
  if (standardized.some((column) => column === null)) {
    return { n: complete.length, coefficient: null, r2: null, status: "ZERO_VARIANCE_SLATE_SIZE_OR_COMPOSITION_FEATURE", features };
  }
  const y = complete.map((row) => row.mae);
  const design = complete.map((_, rowIndex) => [1, ...standardized.map((column) => column![rowIndex]!)]);
  const dimension = design[0]!.length;
  const xtx = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) => design.reduce((sum, row) => sum + row[i]! * row[j]!, 0)));
  const xty = Array.from({ length: dimension }, (_, i) => design.reduce((sum, row, index) => sum + row[i]! * y[index]!, 0));
  const coefficients = solveLinear(xtx, xty);
  if (!coefficients) return { n: complete.length, coefficient: null, r2: null, status: "SINGULAR_COMPOSITION_MODEL", features };
  const predictions = design.map((row) => row.reduce((sum, value, index) => sum + value * coefficients[index]!, 0));
  const yMean = mean(y)!;
  const sse = y.reduce((sum, value, index) => sum + (value - predictions[index]!) ** 2, 0);
  const sst = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  return {
    n: complete.length,
    coefficient: coefficients[1]!,
    r2: sst > 0 ? 1 - sse / sst : null,
    status: complete.length < 30 ? "DESCRIPTIVE_UNDERPOWERED" : "DESCRIPTIVE_COMPLETE_CASE",
    features,
  };
}

function weightedMae(rows: SlateDiagnostic[]): number | null {
  const games = rows.reduce((sum, row) => sum + row.frozen_games, 0);
  return games ? rows.reduce((sum, row) => sum + row.mae * row.frozen_games, 0) / games : null;
}

function summaryRow(
  dimension: string,
  cohort: string,
  rows: SlateDiagnostic[],
  allRows: SlateDiagnostic[],
  verdict: SlateSizeVerdict,
  timestamp: string,
): unknown[] {
  const games = rows.reduce((sum, row) => sum + row.frozen_games, 0);
  const [ciLower, ciUpper] = bootstrapWeightedMae(rows);
  const overallCorrelation = pearson(allRows.map((row) => row.frozen_games), allRows.map((row) => row.mae));
  const adjusted = dimension === "OVERALL" ? adjustedCompositionModel(allRows) : { n: 0, coefficient: null, r2: null, status: "NOT_APPLICABLE_TO_BUCKET_ROW", features: "" };
  const allocationEligible = rows.reduce((sum, row) => sum + row.allocation_eligible, 0);
  const cellStatus = rows.length < 5 ? "SMALL_SAMPLE_DESCRIPTIVE" : "DESCRIPTIVE";
  return [
    dimension, cohort, rows.length, games, cellStatus,
    rows.length ? Math.min(...rows.map((row) => row.frozen_games)) : "",
    rows.length ? Math.max(...rows.map((row) => row.frozen_games)) : "",
    blank(weightedMae(rows)), blank(ciLower), blank(ciUpper), blank(mean(rows.map((row) => row.mae))),
    blank(median(rows.map((row) => row.mae))),
    blank(games ? Math.sqrt(rows.reduce((sum, row) => sum + row.rmse ** 2 * row.frozen_games, 0) / games) : null),
    blank(games ? rows.reduce((sum, row) => sum + row.signed_error, 0) / games : null),
    blank(games ? rows.reduce((sum, row) => sum + row.misses_ge_3, 0) / games : null),
    blank(mean(rows.flatMap((row) => row.spearman === null ? [] : [row.spearman]))),
    blank(allocationEligible ? rows.reduce((sum, row) => sum + row.higher_side_correct, 0) / allocationEligible : null),
    blank(dimension === "OVERALL" ? overallCorrelation : null), adjusted.n || "", blank(adjusted.coefficient),
    blank(adjusted.r2), adjusted.status,
    adjusted.features,
    verdict,
    rows.length < 5
      ? "Descriptive only; no significance or causal claim from a sparse slate-size cell."
      : "Research only; frozen game forecasts are unchanged and slate size is not an active input.",
    timestamp,
  ];
}

export function selectSlateSizeVerdict(rows: SlateDiagnostic[]): SlateSizeVerdict {
  if (rows.some((row) => !Number.isFinite(row.mae) || row.frozen_games <= 0)) return "FAIL";
  // Twenty-two slates do not support causal regime commissioning, especially
  // with only two 11-12 slates and one 17+ slate. Keep accumulating.
  if (rows.length < 50) return "CONTINUE_SHADOW";
  return "HOLD";
}

export function buildSlateSizeSummaryRows(rows: SlateDiagnostic[], timestamp: string): unknown[][] {
  const verdict = selectSlateSizeVerdict(rows);
  const groups: Array<[string, string, SlateDiagnostic[]]> = [
    ["OVERALL", "ALL_SLATES", rows],
    ...(["<=10", "11-12", "13-16", "17+"] as const).map((bucket) => [
      "SLATE_SIZE_BUCKET", bucket, rows.filter((row) => slateSizeBucket(row.frozen_games) === bucket),
    ] as [string, string, SlateDiagnostic[]]),
    ["REPRODUCTION", "13+", rows.filter((row) => row.frozen_games >= 13)],
  ];
  return groups.map(([dimension, cohort, grouped]) => summaryRow(dimension, cohort, grouped, rows, verdict, timestamp));
}

export function slateDiagnosticRow(row: SlateDiagnostic, timestamp: string): unknown[] {
  const allocationAccuracy = row.allocation_eligible ? row.higher_side_correct / row.allocation_eligible : null;
  return [
    row.date, SLATE_SIZE_DIAGNOSTIC_VERSION, "RESEARCH_ONLY", row.frozen_games,
    slateSizeBucket(row.frozen_games), row.projected_sum, row.actual_sum, row.signed_error,
    row.mae, row.rmse, row.median_ae, row.misses_ge_3, row.misses_ge_4, row.misses_ge_5,
    blank(row.spearman), blank(allocationAccuracy), row.allocation_reversals,
    blank(row.full_scope_rate), blank(row.partial_scope_rate), blank(row.confirmed_lineup_rate),
    blank(row.partial_lineup_rate), blank(row.unresolved_starter_rate), blank(row.opener_bulk_rate),
    "", "UNAVAILABLE_DEFINITION_NOT_COMMISSIONED", "", "UNAVAILABLE_FROZEN_PACKET_LACKS_DOUBLEHEADER_FLAG",
    blank(row.weather_freeze_count), blank(row.starter_role_uncertainty_count),
    blank(row.bullpen_available_rate), blank(row.statcast_coverage), blank(row.projection_writable, 0),
    blank(row.protected_games, 0), row.packet_games, row.composition_status,
    "Slate size is observational only; no multiplier, recentering, truth, ranking, or BET/PASS consumer.", timestamp,
  ];
}

interface HumanAuditSeed {
  game: string; away: string; home: string; projection: number; actual: number; error: number;
  frozenLine: number; operatorLine: number; truth: string; execution: string; settlement: string;
  diagnosis: string; notes: string;
}

export const SEPT14_HUMAN_AUDIT: readonly HumanAuditSeed[] = [
  { game: "20260914_LAD_CIN", away: "LAD", home: "CIN", projection: 8.79, actual: 5, error: 3.79, frozenLine: 7.5, operatorLine: 7.5, truth: "OVER", execution: "BET", settlement: "INCORRECT", diagnosis: "LAD-CIN: INCORRECT, miss severity 2.5 runs. Center 8.79 against an actual 5. Skubal did what the model said; Lodolo didn't. That's the whole entry.", notes: "No vehicle-capture label, Dodgers team-total retrofit, or one-sided-total structural claim." },
  { game: "20260914_CHW_CLE", away: "CHW", home: "CLE", projection: 6.39, actual: 10, error: -3.61, frozenLine: 6.5, operatorLine: 6.5, truth: "NO_CALL", execution: "PASS", settlement: "NO_CALL", diagnosis: "NO_CALL preserved because frozen separation from literal 6.5 was -0.11; projection still missed actual scoring materially low.", notes: "The fixed +/-0.25 NO_CALL rule survives the result." },
  { game: "20260914_DET_TOR", away: "DET", home: "TOR", projection: 8.70, actual: 11, error: -2.30, frozenLine: 7.5, operatorLine: 7.5, truth: "OVER", execution: "BET", settlement: "CORRECT", diagnosis: "Human Over truth was correct; no new structural mechanism established from this game alone.", notes: "Execution and truth remain separate." },
  { game: "20260914_BAL_NYM", away: "BAL", home: "NYM", projection: 9.07, actual: 3, error: 6.07, frozenLine: 7.5, operatorLine: 7.5, truth: "OVER", execution: "BET", settlement: "INCORRECT", diagnosis: "Major high-side center miss; mechanism unresolved unless existing diagnostics isolate it.", notes: "No causal mechanism inferred from the final score alone." },
  { game: "20260914_ATL_CHC", away: "ATL", home: "CHC", projection: 8.92, actual: 10, error: -1.08, frozenLine: 9.5, operatorLine: 9.5, truth: "UNDER", execution: "PASS", settlement: "INCORRECT", diagnosis: "Under direction was incorrect; no wager was reported.", notes: "PASS is not converted into a wager." },
  { game: "20260914_NYY_MIN", away: "NYY", home: "MIN", projection: 8.86, actual: 11, error: -2.14, frozenLine: 7.5, operatorLine: 8.5, truth: "OVER", execution: "PASS", settlement: "CORRECT", diagnosis: "Direction was correct; PASS was due to weather/environment uncertainty, not price.", notes: "Manual Hard Rock 8.5 is preserved separately and does not overwrite frozen workbook 7.5." },
  { game: "20260914_SFG_STL", away: "SFG", home: "STL", projection: 8.40, actual: 3, error: 5.40, frozenLine: 7.5, operatorLine: 7.5, truth: "OVER", execution: "PASS", settlement: "INCORRECT", diagnosis: "Large high-side center miss; mechanism unresolved.", notes: "No wager was reported." },
  { game: "20260914_SDP_COL", away: "SDP", home: "COL", projection: 9.12, actual: 15, error: -5.88, frozenLine: 10.5, operatorLine: 11.5, truth: "UNDER", execution: "BET", settlement: "INCORRECT", diagnosis: "Major low-side center miss and failed Under at the final executable 11.5; mechanism unresolved pending legitimate phase diagnostics.", notes: "Manual Hard Rock 11.5 remains separate from frozen workbook 10.5." },
  { game: "20260914_SEA_LAA", away: "SEA", home: "LAA", projection: 8.56, actual: 10, error: -1.44, frozenLine: 7.5, operatorLine: 7.5, truth: "OVER", execution: "PASS", settlement: "CORRECT", diagnosis: "Over direction was correct; no wager was reported.", notes: "PASS is not converted into a wager." },
  { game: "20260914_MIA_ARI", away: "MIA", home: "ARI", projection: 7.61, actual: 15, error: -7.39, frozenLine: 8.5, operatorLine: 8.5, truth: "UNDER", execution: "BET", settlement: "INCORRECT", diagnosis: "Largest slate low-side center miss; mechanism unresolved pending legitimate starter and bullpen phase diagnostics.", notes: "No component failure inferred from the total alone." },
] as const;

export function humanAuditRows(timestamp: string): unknown[][] {
  return SEPT14_HUMAN_AUDIT.map((seed) => [
    "2026-09-14", seed.game, seed.away, seed.home, seed.projection, seed.actual, seed.error,
    seed.frozenLine, seed.operatorLine, "MANUALLY_SUPPLIED_HARD_ROCK", "",
    "UNAVAILABLE_NOT_SUPPLIED", seed.truth, seed.execution, seed.settlement,
    seed.diagnosis, "CASE_ONLY / NOT_ESTABLISHED",
    seed.frozenLine === seed.operatorLine
      ? "MANUAL_LITERAL_LINE_RECORDED_SEPARATELY"
      : "MANUAL_LITERAL_LINE_DIFFERS_FROM_FROZEN_PIPELINE_LINE",
    seed.notes, "APPEND_ONLY_OPERATOR_POSTMORTEM", timestamp,
  ]);
}

function columnLabel(columnCount: number): string {
  let value = columnCount;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

async function ensureSheets(workbookId: string): Promise<void> {
  const specs = [
    [SLATE_SIZE_DIAGNOSTIC_SHEET, SLATE_SIZE_DIAGNOSTIC_HEADERS.length],
    [SLATE_SIZE_SUMMARY_SHEET, SLATE_SIZE_SUMMARY_HEADERS.length],
    [HUMAN_GAME_TRUTH_AUDIT_SHEET, HUMAN_GAME_TRUTH_AUDIT_HEADERS.length],
  ] as const;
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const [name] of specs) if (!existing.has(name)) await addSheet(workbookId, name);
  await Promise.all(specs.map(([name, columns]) => expandSheetColumns(workbookId, name, columns)));
}

async function readOptional(workbookId: string, range: string, warnings: string[]): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message)) throw error;
    warnings.push(`MISSING_SLATE_SIZE_SOURCE: ${range}`);
    return [];
  }
}

export async function runSlateSizeDiagnosticV1(options: { workbookId?: string } = {}): Promise<SlateSizeDiagnosticResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const timestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [slateRows, packetRows, runRows] = await Promise.all([
      readOptional(workbookId, `${GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET}!A1:U1000`, warnings),
      readOptional(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`, warnings),
      readOptional(workbookId, "RUN_LOG!A1:AV10000", warnings),
    ]);
    const rows = parseSlateDiagnostics(slateRows, packetRows, runRows);
    const verdict = selectSlateSizeVerdict(rows);
    const summaryRows = buildSlateSizeSummaryRows(rows, timestamp);
    await ensureSheets(workbookId);
    await clearRange(workbookId, `${SLATE_SIZE_DIAGNOSTIC_SHEET}!A1:${columnLabel(SLATE_SIZE_DIAGNOSTIC_HEADERS.length)}1000`);
    await clearRange(workbookId, `${SLATE_SIZE_SUMMARY_SHEET}!A1:${columnLabel(SLATE_SIZE_SUMMARY_HEADERS.length)}1000`);
    await writeRange(workbookId, `${SLATE_SIZE_DIAGNOSTIC_SHEET}!A1`, [
      Array.from(SLATE_SIZE_DIAGNOSTIC_HEADERS), ...rows.map((row) => slateDiagnosticRow(row, timestamp)),
    ]);
    await writeRange(workbookId, `${SLATE_SIZE_SUMMARY_SHEET}!A1`, [
      Array.from(SLATE_SIZE_SUMMARY_HEADERS), ...summaryRows,
    ]);

    const existingHuman = await readOptional(workbookId, `${HUMAN_GAME_TRUTH_AUDIT_SHEET}!A1:U1000`, warnings);
    if (!existingHuman.length) await writeRange(workbookId, `${HUMAN_GAME_TRUTH_AUDIT_SHEET}!A1`, [Array.from(HUMAN_GAME_TRUTH_AUDIT_HEADERS)]);
    const existingKeys = new Set(existingHuman.slice(1).map((row) => `${canonicalDate(row[0])}|${text(row[1])}`));
    const candidateHumanRows = humanAuditRows(timestamp);
    const missingHumanRows = candidateHumanRows.filter((row) => !existingKeys.has(`${canonicalDate(row[0])}|${text(row[1])}`));
    if (missingHumanRows.length) await appendRange(workbookId, `${HUMAN_GAME_TRUTH_AUDIT_SHEET}!A:U`, missingHumanRows);

    logger.info({ slates: rows.length, verdict, human_rows_appended: missingHumanRows.length }, "MODULE_34: slate-size and human postmortem research complete");
    return {
      status: "success", replay_timestamp_utc: timestamp, slate_rows_seen: rows.length,
      diagnostic_rows_written: rows.length, summary_rows_written: summaryRows.length,
      human_rows_appended: missingHumanRows.length,
      human_rows_preserved: candidateHumanRows.length - missingHumanRows.length,
      verdict, warnings, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    return {
      status: "failure", replay_timestamp_utc: timestamp, slate_rows_seen: 0,
      diagnostic_rows_written: 0, summary_rows_written: 0, human_rows_appended: 0,
      human_rows_preserved: 0, verdict: "FAIL", warnings, errors,
    };
  }
}

// Compile-time alignment guard: the source sheet definition must remain the
// direct Module 29 slate corpus rather than a differently ordered lookalike.
void GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS;
void RUN_LOG_HEADERS;
