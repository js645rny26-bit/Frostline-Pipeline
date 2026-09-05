/**
 * Module 29: Game-Truth Distribution Research V2
 *
 * A settlement-only extension to the V1 distribution benchmark.  It keeps
 * Frostline's immutable, price-blind frozen center as the location for every
 * comparator and uses strictly earlier settled games to fit shape.  It writes
 * research evidence only: no current or future point projection, board score,
 * market view, vehicle, or authorization code imports this module.
 *
 * The direct-total models are intentionally compared before any team-run
 * distribution is proposed.  A zero-hurdle NB is retained as a transparent
 * comparator, but the sheet explicitly exposes its zero-rate support rather
 * than suggesting it can solve one- or two-run games when no zero-total games
 * exist in the training corpus.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import {
  cdfAt,
  crps,
  Distribution,
  DistributionBenchmarkObservation,
  fitNegativeBinomialAlpha,
  logGamma,
  parseFrozenDistributionBenchmarkPackets,
  parseSettledDistributionBenchmarkTruth,
  joinDistributionBenchmarkObservations,
  pairedSignTestTwoSidedP,
  pmfAt,
  quantile,
  buildNegativeBinomialDistribution,
  buildPoissonDistribution,
} from "./module28_distributionBenchmark.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { ALLOCATION_SETTLEMENT_HEADERS } from "./module24_postgameDiagnostics.js";
import { logger } from "../../lib/logger.js";

export const GAME_TRUTH_DISTRIBUTION_RESEARCH_SHEET = "GAME_TRUTH_DISTRIBUTION_V2";
export const GAME_TRUTH_DISTRIBUTION_LINES_SHEET = "GAME_TRUTH_DIST_LINES_V2";
export const GAME_TRUTH_DISTRIBUTION_SUMMARY_SHEET = "GAME_TRUTH_DIST_SUMMARY_V2";
export const GAME_TRUTH_DISTRIBUTION_PAIRS_SHEET = "GAME_TRUTH_DIST_PAIRS_V2";
export const GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET = "GAME_TRUTH_SLATE_DIAG_V2";
export const GAME_TRUTH_DISTRIBUTION_VERSION = "GAME_TRUTH_DISTRIBUTION_V2_2026-09-05";
export const MIN_PRIOR_SETTLED_GAMES_V2 = 100;
export const STANDARD_TOTAL_LINES = [6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5] as const;

export const GAME_TRUTH_DISTRIBUTION_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Distribution_Research_Version",
  "Model",
  "Training_Through_Date",
  "Prior_Settled_Games",
  "Research_Status",
  "Frozen_Price_Blind_Mean",
  "Actual_Total",
  "Shape_Parameter",
  "Shape_Parameter_Status",
  "Training_Zero_Total_Rate",
  "Distribution_Median",
  "Distribution_Variance",
  "Distribution_SD",
  "P_Total_LE_4",
  "P_Total_LE_6",
  "P_Total_7_TO_9",
  "P_Total_GE_10",
  "P_Total_GE_12",
  "P_Total_GE_15",
  "CRPS",
  "Log_Loss",
  "Discrete_Mid_PIT",
  "Deterministic_Randomized_PIT",
  "Interval_50_Low",
  "Interval_50_High",
  "Interval_50_Coverage",
  "Interval_50_Escape_Side",
  "Interval_80_Low",
  "Interval_80_High",
  "Interval_80_Coverage",
  "Interval_80_Escape_Side",
  "Interval_90_Low",
  "Interval_90_High",
  "Interval_90_Coverage",
  "Interval_90_Escape_Side",
  "Replay_Status",
  "Settlement_TS",
] as const;

export const GAME_TRUTH_DISTRIBUTION_LINES_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Distribution_Research_Version",
  "Model",
  "Standard_Total_Line",
  "Frozen_Price_Blind_Mean",
  "Over_Probability",
  "Under_Or_Push_Probability",
  "Actual_Total",
  "Actual_Over_Result",
  "Brier_Score",
  "Research_Status",
  "Settlement_TS",
] as const;

export const GAME_TRUTH_DISTRIBUTION_SUMMARY_HEADERS = [
  "Evaluation_Population",
  "Model",
  "Metric",
  "Metric_Bucket",
  "Eligible_N",
  "Mean_Value",
  "Median_Value",
  "Observed_Value",
  "Target_Value",
  "Low_Side_Escapes",
  "High_Side_Escapes",
  "Research_Status",
  "Replay_TS",
] as const;

export const GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS = [
  "Evaluation_Population",
  "Metric",
  "Standard_Total_Line",
  "Model_A",
  "Model_B",
  "Paired_N",
  "Non_Tied_N",
  "A_Better_Count",
  "B_Better_Count",
  "Tie_Count",
  "Mean_Delta_A_Minus_B",
  "Median_Delta_A_Minus_B",
  "Paired_Sign_Test_Two_Sided_P",
  "Research_Status",
  "Replay_TS",
] as const;

export const GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS = [
  "Date",
  "Frozen_Games",
  "Frozen_Projected_Run_Sum",
  "Actual_Run_Sum",
  "Aggregate_Error_Model_Minus_Actual",
  "Aggregate_Abs_Error",
  "Per_Game_MAE",
  "Per_Game_RMSE",
  "Median_Absolute_Error",
  "Misses_GE_3",
  "Misses_GE_4",
  "Misses_GE_5",
  "Projected_Actual_Spearman_Rho",
  "Actual_Loudest_Game_Identified",
  "Actual_Quietest_Game_Identified",
  "Total_Good_Allocation_Bad_Games",
  "Allocation_Eligible_Games",
  "Higher_Scoring_Side_Correct",
  "Allocation_Sign_Reversals",
  "Research_Status",
  "Replay_TS",
] as const;

type Comparator = "POISSON" | "NB" | "HURDLE_NB" | "CMP" | "EMPIRICAL_RESIDUAL";

interface IntervalResult {
  low: number;
  high: number;
  covered: boolean;
  escape_side: "LOW" | "HIGH" | "INSIDE";
}

interface EvaluatedModel {
  comparator: Comparator;
  shape_parameter: number | null;
  shape_parameter_status: string;
  distribution: Distribution;
  median: number;
  variance: number;
  sd: number;
  crps: number;
  log_loss: number;
  mid_pit: number;
  randomized_pit: number;
  interval_50: IntervalResult;
  interval_80: IntervalResult;
  interval_90: IntervalResult;
}

interface AllocationOutcome {
  allocation_mae: number;
  projected_higher: string;
  actual_higher: string;
  allocation_sign_reversal: boolean;
}

export interface GameTruthDistributionEvaluation {
  observation: DistributionBenchmarkObservation;
  training_through_date: string;
  prior_settled_games: number;
  status: "WALK_FORWARD_ELIGIBLE" | "INSUFFICIENT_PRIOR_SETTLED_GAMES";
  zero_total_rate: number | null;
  models: EvaluatedModel[];
}

export interface GameTruthDistributionResearchResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  frozen_packets_seen: number;
  settled_observations_seen: number;
  eligible_games: number;
  distribution_rows_written: number;
  line_rows_written: number;
  summary_rows_written: number;
  pair_rows_written: number;
  slate_rows_written: number;
  snapshot_mismatches: number;
  warnings: string[];
  errors: string[];
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function standardDeviation(values: readonly number[]): number | null {
  const average = mean(values);
  if (average === null || values.length === 0) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function pmfMoments(distribution: Distribution): { variance: number; sd: number } {
  const average = distribution.pmf.reduce((sum, probability, total) => sum + total * probability, 0);
  const variance = distribution.pmf.reduce((sum, probability, total) => sum + ((total - average) ** 2) * probability, 0);
  return { variance: round(variance), sd: round(Math.sqrt(Math.max(0, variance))) };
}

function probabilityRange(distribution: Distribution, low: number, high: number): number {
  return Math.max(0, cdfAt(distribution, high) - cdfAt(distribution, low - 1));
}

function interval(distribution: Distribution, coverage: number, actual: number): IntervalResult {
  const tail = (1 - coverage) / 2;
  const low = quantile(distribution, tail);
  const high = quantile(distribution, 1 - tail);
  return {
    low,
    high,
    covered: actual >= low && actual <= high,
    escape_side: actual < low ? "LOW" : actual > high ? "HIGH" : "INSIDE",
  };
}

/** Stable pseudo-random U(0,1) drawn from the frozen identity, not an outcome. */
function deterministicUniform(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) + 0.5) / 4294967296;
}

function randomizedPit(distribution: Distribution, actual: number, identity: string): number {
  return round(cdfAt(distribution, actual - 1) + deterministicUniform(identity) * pmfAt(distribution, actual));
}

function evaluateDistribution(
  comparator: Comparator,
  distribution: Distribution,
  actual: number,
  identity: string,
  shapeParameter: number | null,
  shapeParameterStatus: string,
): EvaluatedModel {
  const moments = pmfMoments(distribution);
  return {
    comparator,
    shape_parameter: shapeParameter,
    shape_parameter_status: shapeParameterStatus,
    distribution,
    median: quantile(distribution, 0.5),
    variance: moments.variance,
    sd: moments.sd,
    crps: crps(distribution, actual),
    log_loss: round(-Math.log(Math.max(pmfAt(distribution, actual), 1e-15))),
    mid_pit: round(cdfAt(distribution, actual - 1) + pmfAt(distribution, actual) / 2),
    randomized_pit: randomizedPit(distribution, actual, identity),
    interval_50: interval(distribution, 0.5, actual),
    interval_80: interval(distribution, 0.8, actual),
    interval_90: interval(distribution, 0.9, actual),
  };
}

function normalisePmf(pmf: number[]): Distribution {
  const sum = pmf.reduce((accumulator, probability) => accumulator + probability, 0);
  const normalized = sum > 0 ? pmf.map((probability) => probability / sum) : [1];
  const cdf: number[] = [];
  let cumulative = 0;
  for (const probability of normalized) {
    cumulative = Math.min(1, cumulative + probability);
    cdf.push(cumulative);
  }
  cdf[cdf.length - 1] = 1;
  return { pmf: normalized, cdf };
}

function expectedPositiveNbMean(baseMean: number, alpha: number): number {
  const base = buildNegativeBinomialDistribution(baseMean, alpha, 0);
  return baseMean / Math.max(1e-15, 1 - pmfAt(base, 0));
}

/**
 * Zero-hurdle NB with a separately observed zero-total rate.  The underlying
 * NB mean is solved so the final hurdle distribution retains the frozen
 * Frostline location.  It is intentionally not an ad hoc low-run adjustment.
 */
export function buildHurdleNegativeBinomialDistribution(
  meanTarget: number,
  alpha: number,
  zeroRate: number,
  minimumSupport: number,
): Distribution {
  const boundedZeroRate = Math.max(0, Math.min(0.95, zeroRate));
  const conditionalTarget = meanTarget / Math.max(1e-12, 1 - boundedZeroRate);
  let left = 1e-8;
  let right = Math.max(conditionalTarget * 2, 1);
  while (expectedPositiveNbMean(right, alpha) < conditionalTarget) right *= 2;
  for (let iteration = 0; iteration < 80; iteration++) {
    const candidate = (left + right) / 2;
    if (expectedPositiveNbMean(candidate, alpha) < conditionalTarget) left = candidate;
    else right = candidate;
  }
  const base = buildNegativeBinomialDistribution((left + right) / 2, alpha, minimumSupport);
  const p0 = pmfAt(base, 0);
  const pmf = base.pmf.map((probability, total) => total === 0
    ? boundedZeroRate
    : (1 - boundedZeroRate) * probability / Math.max(1e-15, 1 - p0));
  return normalisePmf(pmf);
}

function logSumExp(values: readonly number[]): number {
  const maximum = Math.max(...values);
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

interface COMPoissonState {
  lambda: number;
  distribution: Distribution;
}

function comPoissonDistributionForLambda(lambda: number, nu: number, minimumSupport: number): Distribution {
  const logWeights: number[] = [0];
  let maximum = 0;
  let decliningTail = 0;
  for (let total = 1; total <= 500; total++) {
    const logWeight = logWeights[total - 1]! + Math.log(lambda) - nu * Math.log(total);
    logWeights.push(logWeight);
    maximum = Math.max(maximum, logWeight);
    if (total >= minimumSupport && logWeight < maximum - 36) decliningTail++;
    else decliningTail = 0;
    if (total >= Math.max(minimumSupport, 40) && decliningTail >= 10) break;
  }
  const logNormaliser = logSumExp(logWeights);
  return normalisePmf(logWeights.map((logWeight) => Math.exp(logWeight - logNormaliser)));
}

function distributionMean(distribution: Distribution): number {
  return distribution.pmf.reduce((sum, probability, total) => sum + total * probability, 0);
}

/** Mean-parameterized COM-Poisson: solve lambda numerically for frozen mu. */
export function buildMeanParameterizedCOMPoissonDistribution(
  meanTarget: number,
  nu: number,
  minimumSupport: number,
): COMPoissonState {
  let left = -12;
  let right = 12;
  for (let iteration = 0; iteration < 34; iteration++) {
    const logLambda = (left + right) / 2;
    const lambda = Math.exp(logLambda);
    const candidate = comPoissonDistributionForLambda(lambda, nu, minimumSupport);
    if (distributionMean(candidate) < meanTarget) left = logLambda;
    else right = logLambda;
  }
  const lambda = Math.exp((left + right) / 2);
  return { lambda, distribution: comPoissonDistributionForLambda(lambda, nu, minimumSupport) };
}

function comPoissonLogLikelihood(training: readonly DistributionBenchmarkObservation[], nu: number): number {
  return training.reduce((sum, observation) => {
    const model = buildMeanParameterizedCOMPoissonDistribution(observation.mean, nu, Math.max(observation.actual_total, 30));
    return sum + Math.log(Math.max(pmfAt(model.distribution, observation.actual_total), 1e-15));
  }, 0);
}

/**
 * A deliberately bounded, fixed-grid MLE comparison in nu. nu=1 is the
 * Poisson special case. This is a research comparator, not a high-precision
 * optimization target, so daily settlement stays reproducible and practical.
 */
export function fitCOMPoissonNu(
  training: readonly DistributionBenchmarkObservation[],
): { nu: number; status: string } {
  const candidateNu = [0.5, 0.65, 0.8, 1, 1.25, 1.6, 2] as const;
  let best = 1;
  let bestIndex = candidateNu.indexOf(1);
  let bestLikelihood = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < candidateNu.length; index++) {
    const candidate = candidateNu[index]!;
    const likelihood = comPoissonLogLikelihood(training, candidate);
    if (likelihood > bestLikelihood) {
      bestLikelihood = likelihood;
      best = candidate;
      bestIndex = index;
    }
  }
  const atBoundary = bestIndex === 0 || bestIndex === candidateNu.length - 1;
  return {
    nu: best,
    status: atBoundary ? "CMP_NU_GRID_BOUND_RESEARCH_ONLY" : "CMP_NU_GRID_MLE_RESEARCH_ONLY",
  };
}

function buildEmpiricalResidualDistribution(meanTarget: number, residuals: readonly number[], minimumSupport: number): Distribution {
  const ordered = [...residuals].sort((left, right) => left - right);
  const maximum = Math.max(minimumSupport, Math.ceil(meanTarget + (ordered[ordered.length - 1] ?? 0)), 50);
  const pmf: number[] = [];
  let previous = 0;
  for (let total = 0; total <= maximum; total++) {
    const threshold = total - meanTarget;
    const current = ordered.filter((residual) => residual <= threshold).length / ordered.length;
    pmf.push(Math.max(0, current - previous));
    previous = current;
  }
  return normalisePmf(pmf);
}

/** Expanding, strictly earlier-slate walk-forward research. */
export function evaluateGameTruthDistributionWalkForward(
  observations: readonly DistributionBenchmarkObservation[],
): GameTruthDistributionEvaluation[] {
  const byDate = new Map<string, DistributionBenchmarkObservation[]>();
  for (const observation of observations) {
    const slate = byDate.get(observation.date) ?? [];
    slate.push(observation);
    byDate.set(observation.date, slate);
  }
  const training: DistributionBenchmarkObservation[] = [];
  const output: GameTruthDistributionEvaluation[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const slate = [...(byDate.get(date) ?? [])].sort((left, right) => left.game_id.localeCompare(right.game_id));
    const trainingThroughDate = training[training.length - 1]?.date ?? "";
    if (training.length < MIN_PRIOR_SETTLED_GAMES_V2) {
      output.push(...slate.map((observation) => ({
        observation,
        training_through_date: trainingThroughDate,
        prior_settled_games: training.length,
        status: "INSUFFICIENT_PRIOR_SETTLED_GAMES" as const,
        zero_total_rate: null,
        models: [],
      })));
    } else {
      const alphaFit = fitNegativeBinomialAlpha(training);
      const nuFit = fitCOMPoissonNu(training);
      const zeroRate = training.filter((observation) => observation.actual_total === 0).length / training.length;
      const residuals = training.map((observation) => observation.actual_total - observation.mean);
      for (const observation of slate) {
        const minimumSupport = observation.actual_total;
        const identity = `${observation.date}|${observation.game_id}|${observation.snapshot_ts}`;
        const poisson = buildPoissonDistribution(observation.mean, minimumSupport);
        const nb = buildNegativeBinomialDistribution(observation.mean, alphaFit.alpha, minimumSupport);
        const hurdle = buildHurdleNegativeBinomialDistribution(observation.mean, alphaFit.alpha, zeroRate, minimumSupport);
        const cmp = buildMeanParameterizedCOMPoissonDistribution(observation.mean, nuFit.nu, minimumSupport).distribution;
        const empirical = buildEmpiricalResidualDistribution(observation.mean, residuals, minimumSupport);
        output.push({
          observation,
          training_through_date: trainingThroughDate,
          prior_settled_games: training.length,
          status: "WALK_FORWARD_ELIGIBLE",
          zero_total_rate: round(zeroRate, 8),
          models: [
            evaluateDistribution("POISSON", poisson, observation.actual_total, identity, 1, "POISSON_FIXED"),
            evaluateDistribution("NB", nb, observation.actual_total, identity, alphaFit.alpha, alphaFit.status),
            evaluateDistribution(
              "HURDLE_NB",
              hurdle,
              observation.actual_total,
              identity,
              alphaFit.alpha,
              zeroRate === 0 ? "HURDLE_NB_ZERO_RATE_ZERO_RESEARCH_ONLY" : alphaFit.status,
            ),
            evaluateDistribution("CMP", cmp, observation.actual_total, identity, nuFit.nu, nuFit.status),
            evaluateDistribution("EMPIRICAL_RESIDUAL", empirical, observation.actual_total, identity, null, "EMPIRICAL_RESIDUAL_NO_PARAM"),
          ],
        });
      }
    }
    training.push(...slate);
  }
  return output;
}

function evaluationRow(evaluation: GameTruthDistributionEvaluation, model: EvaluatedModel): unknown[] {
  const { observation } = evaluation;
  return [
    observation.date, observation.game_id, observation.snapshot_ts, GAME_TRUTH_DISTRIBUTION_VERSION,
    model.comparator, evaluation.training_through_date, evaluation.prior_settled_games, evaluation.status,
    observation.mean, observation.actual_total, model.shape_parameter ?? "", model.shape_parameter_status,
    evaluation.zero_total_rate ?? "", model.median, model.variance, model.sd,
    round(cdfAt(model.distribution, 4)), round(cdfAt(model.distribution, 6)), round(probabilityRange(model.distribution, 7, 9)),
    round(1 - cdfAt(model.distribution, 9)), round(1 - cdfAt(model.distribution, 11)), round(1 - cdfAt(model.distribution, 14)),
    model.crps, model.log_loss, model.mid_pit, model.randomized_pit,
    model.interval_50.low, model.interval_50.high, model.interval_50.covered ? "TRUE" : "FALSE", model.interval_50.escape_side,
    model.interval_80.low, model.interval_80.high, model.interval_80.covered ? "TRUE" : "FALSE", model.interval_80.escape_side,
    model.interval_90.low, model.interval_90.high, model.interval_90.covered ? "TRUE" : "FALSE", model.interval_90.escape_side,
    "FROZEN_PRICE_BLIND_WALK_FORWARD_RESEARCH_ONLY", observation.settlement_ts,
  ];
}

export function buildGameTruthDistributionRows(evaluations: readonly GameTruthDistributionEvaluation[]): unknown[][] {
  return evaluations.flatMap((evaluation) => {
    if (evaluation.models.length > 0) return evaluation.models.map((model) => evaluationRow(evaluation, model));
    const { observation } = evaluation;
    // Keep the evidence gap visible. A missing 100-game training window may
    // never be replaced by a plausible distribution or a reconstructed band.
    return [[
      observation.date, observation.game_id, observation.snapshot_ts, GAME_TRUTH_DISTRIBUTION_VERSION,
      "NO_COMPARATOR", evaluation.training_through_date, evaluation.prior_settled_games, evaluation.status,
      observation.mean, observation.actual_total,
      ...Array(28).fill(""),
      "FROZEN_PRICE_BLIND_WALK_FORWARD_RESEARCH_ONLY", observation.settlement_ts,
    ]];
  });
}

export function buildGameTruthDistributionLineRows(evaluations: readonly GameTruthDistributionEvaluation[]): unknown[][] {
  return evaluations.flatMap((evaluation) => evaluation.models.flatMap((model) => STANDARD_TOTAL_LINES.map((line) => {
    const overProbability = round(1 - cdfAt(model.distribution, Math.floor(line)));
    const actualOver = evaluation.observation.actual_total > line ? 1 : 0;
    return [
      evaluation.observation.date, evaluation.observation.game_id, evaluation.observation.snapshot_ts,
      GAME_TRUTH_DISTRIBUTION_VERSION, model.comparator, line, evaluation.observation.mean,
      overProbability, round(1 - overProbability), evaluation.observation.actual_total, actualOver,
      round((overProbability - actualOver) ** 2), evaluation.status, evaluation.observation.settlement_ts,
    ];
  })));
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function packetKey(date: string, gameId: string, snapshotTs: string): string {
  return `${date}|${gameId}|${snapshotTs}`;
}

/**
 * Allocation joins are exact frozen-snapshot joins.  Missing rows are never
 * inferred from the final score, and a legacy Date/Game_ID-only row remains
 * an explicit gap rather than a convenient fallback.
 */
export function parseFrozenAllocationOutcomes(rows: unknown[][]): Map<string, AllocationOutcome> {
  const [header = [], ...data] = rows;
  const index = new Map(header.map((name, position) => [text(name), position]));
  const field = (row: unknown[], name: string): unknown => row[index.get(name) ?? -1];
  const output = new Map<string, AllocationOutcome>();
  for (const row of data) {
    const date = text(field(row, "Date"));
    const gameId = text(field(row, "Game_ID"));
    const snapshotTs = text(field(row, "Frozen_Packet_Snapshot_TS"));
    const allocationMae = Number.parseFloat(String(field(row, "Allocation_MAE")));
    const status = text(field(row, "Diagnostic_Status"));
    if (!date || !gameId || !snapshotTs || !Number.isFinite(allocationMae) || status !== "FROZEN_PACKET_VERIFIED") continue;
    output.set(packetKey(date, gameId, snapshotTs), {
      allocation_mae: allocationMae,
      projected_higher: text(field(row, "Projected_Higher_Scoring_Team")),
      actual_higher: text(field(row, "Actual_Higher_Scoring_Team")),
      allocation_sign_reversal: text(field(row, "Allocation_Sign_Reversal")) === "TRUE",
    });
  }
  return output;
}

function numberAt(row: unknown[], header: readonly string[], name: string): number | null {
  const value = row[header.indexOf(name)];
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function scoredRows(rows: unknown[][]): unknown[][] {
  return rows.filter((row) => text(row[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Research_Status")]) === "WALK_FORWARD_ELIGIBLE");
}

function uniqueModels(rows: unknown[][]): Comparator[] {
  return [...new Set(rows.map((row) => text(row[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model")]) as Comparator))].sort() as Comparator[];
}

function valuesFor(rows: unknown[][], model: Comparator, field: (typeof GAME_TRUTH_DISTRIBUTION_HEADERS)[number]): number[] {
  const modelIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model");
  const fieldIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf(field);
  return rows
    .filter((row) => text(row[modelIndex]) === model)
    .map((row) => Number.parseFloat(String(row[fieldIndex])))
    .filter((value) => Number.isFinite(value));
}

function coverageSummaryRow(rows: unknown[][], model: Comparator, coverage: 50 | 80 | 90, replayTimestamp: string): unknown[] {
  const modelIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model");
  const coverageIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf(`Interval_${coverage}_Coverage` as (typeof GAME_TRUTH_DISTRIBUTION_HEADERS)[number]);
  const escapeIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf(`Interval_${coverage}_Escape_Side` as (typeof GAME_TRUTH_DISTRIBUTION_HEADERS)[number]);
  const subset = rows.filter((row) => text(row[modelIndex]) === model);
  const covered = subset.filter((row) => text(row[coverageIndex]) === "TRUE").length;
  const lower = subset.filter((row) => text(row[escapeIndex]) === "LOW").length;
  const upper = subset.filter((row) => text(row[escapeIndex]) === "HIGH").length;
  return ["ALL_WALK_FORWARD", model, `INTERVAL_COVERAGE_${coverage}`, "", subset.length, "", "",
    subset.length === 0 ? "" : round(covered / subset.length), coverage / 100, lower, upper,
    "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp];
}

function pitRows(rows: unknown[][], model: Comparator, replayTimestamp: string): unknown[][] {
  const values = valuesFor(rows, model, "Deterministic_Randomized_PIT");
  return Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const count = values.filter((value) => value >= lower && (index === 9 ? value <= upper : value < upper)).length;
    return ["ALL_WALK_FORWARD", model, "RANDOMIZED_PIT_BIN", `${lower.toFixed(1)}_${upper.toFixed(1)}`,
      values.length, "", "", count, values.length === 0 ? "" : 0.1, "", "",
      "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp];
  });
}

export function buildGameTruthDistributionSummary(rows: unknown[][], lineRows: unknown[][], replayTimestamp: string): unknown[][] {
  const eligible = scoredRows(rows);
  const summary: unknown[][] = [[
    "MODEL_SELECTION_PROTOCOL", "ALL", "PREDECLARED_DECISION", "NO_PROMOTION_BEFORE_250_WALK_FORWARD_GAMES",
    0, "", "", "", "", "", "",
    "A comparator must improve CRPS and not worsen log loss or 90% side-balance against both NB and empirical residual; ambiguous evidence retains all research comparators.", replayTimestamp,
  ]];
  for (const model of uniqueModels(eligible)) {
    for (const field of ["CRPS", "Log_Loss", "Discrete_Mid_PIT", "Deterministic_Randomized_PIT"] as const) {
      const values = valuesFor(eligible, model, field);
      summary.push(["ALL_WALK_FORWARD", model, field.toUpperCase(), "", values.length, mean(values) ?? "", median(values) ?? "", "", "", "", "", "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp]);
    }
    summary.push(coverageSummaryRow(eligible, model, 50, replayTimestamp));
    summary.push(coverageSummaryRow(eligible, model, 80, replayTimestamp));
    summary.push(coverageSummaryRow(eligible, model, 90, replayTimestamp));
    summary.push(...pitRows(eligible, model, replayTimestamp));
  }
  const lineHeader = GAME_TRUTH_DISTRIBUTION_LINES_HEADERS;
  const modelIndex = lineHeader.indexOf("Model");
  const lineIndex = lineHeader.indexOf("Standard_Total_Line");
  const brierIndex = lineHeader.indexOf("Brier_Score");
  for (const model of uniqueModels(eligible)) {
    for (const line of STANDARD_TOTAL_LINES) {
      const brier = lineRows
        .filter((row) => text(row[modelIndex]) === model && Number(row[lineIndex]) === line)
        .map((row) => Number(row[brierIndex]))
        .filter((value) => Number.isFinite(value));
      summary.push(["STANDARD_LINES_WALK_FORWARD", model, "BRIER", line, brier.length, mean(brier) ?? "", median(brier) ?? "", "", "", "", "", "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp]);
    }
  }
  return summary;
}

function pairedMetricRows(
  rows: unknown[][],
  modelA: Comparator,
  modelB: Comparator,
  metric: "CRPS" | "Log_Loss",
  replayTimestamp: string,
): unknown[] {
  const modelIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model");
  const gameIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Game_ID");
  const dateIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Date");
  const metricIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf(metric);
  const valueByModelGame = new Map<string, number>();
  for (const row of rows) {
    const model = text(row[modelIndex]);
    if (model !== modelA && model !== modelB) continue;
    const value = Number(row[metricIndex]);
    if (Number.isFinite(value)) valueByModelGame.set(`${model}|${row[dateIndex]}|${row[gameIndex]}`, value);
  }
  const deltas: number[] = [];
  for (const row of rows) {
    if (text(row[modelIndex]) !== modelA) continue;
    const date = String(row[dateIndex]);
    const gameId = String(row[gameIndex]);
    const a = valueByModelGame.get(`${modelA}|${date}|${gameId}`);
    const b = valueByModelGame.get(`${modelB}|${date}|${gameId}`);
    if (a !== undefined && b !== undefined) deltas.push(a - b);
  }
  const epsilon = 1e-12;
  const aBetter = deltas.filter((delta) => delta < -epsilon).length;
  const bBetter = deltas.filter((delta) => delta > epsilon).length;
  const ties = deltas.length - aBetter - bBetter;
  return [
    "ALL_WALK_FORWARD", metric.toUpperCase(), "", modelA, modelB, deltas.length,
    aBetter + bBetter, aBetter, bBetter, ties, mean(deltas) ?? "", median(deltas) ?? "",
    pairedSignTestTwoSidedP(aBetter, bBetter) ?? "", "PAIRED_SCORE_RESEARCH_ONLY_NO_PROMOTION", replayTimestamp,
  ];
}

export function buildGameTruthDistributionPairs(rows: unknown[][], replayTimestamp: string): unknown[][] {
  const eligible = scoredRows(rows);
  const models = uniqueModels(eligible);
  const output: unknown[][] = [];
  for (const metric of ["CRPS", "Log_Loss"] as const) {
    for (let left = 0; left < models.length; left++) {
      for (let right = left + 1; right < models.length; right++) {
        output.push(pairedMetricRows(eligible, models[left]!, models[right]!, metric, replayTimestamp));
      }
    }
  }
  return output;
}

function spearman(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const rank = (values: readonly number[]): number[] => values.map((value) => {
    const less = values.filter((candidate) => candidate < value).length;
    const equal = values.filter((candidate) => candidate === value).length;
    return less + (equal + 1) / 2;
  });
  const a = rank(left);
  const b = rank(right);
  const aMean = mean(a);
  const bMean = mean(b);
  if (aMean === null || bMean === null) return null;
  const numerator = a.reduce((sum, value, index) => sum + (value - aMean) * (b[index]! - bMean), 0);
  const denominator = Math.sqrt(a.reduce((sum, value) => sum + (value - aMean) ** 2, 0)
    * b.reduce((sum, value) => sum + (value - bMean) ** 2, 0));
  return denominator === 0 ? null : round(numerator / denominator);
}

/**
 * Summary of the "right aggregate amount, wrong games" hypothesis.  It uses
 * frozen means and official totals only. Allocation fields deliberately stay
 * blank here until an exact key/snapshot join is supplied rather than falling
 * back to date/team joins.
 */
export function buildGameTruthSlateDiagnostics(
  observations: readonly DistributionBenchmarkObservation[],
  replayTimestamp: string,
  allocationByPacket: ReadonlyMap<string, AllocationOutcome> = new Map(),
): unknown[][] {
  const byDate = new Map<string, DistributionBenchmarkObservation[]>();
  for (const observation of observations) {
    const games = byDate.get(observation.date) ?? [];
    games.push(observation);
    byDate.set(observation.date, games);
  }
  return [...byDate.keys()].sort().map((date) => {
    const games = byDate.get(date)!;
    const errors = games.map((game) => game.mean - game.actual_total);
    const absoluteErrors = errors.map((error) => Math.abs(error));
    const projected = games.map((game) => game.mean);
    const actual = games.map((game) => game.actual_total);
    const projectedSum = projected.reduce((sum, value) => sum + value, 0);
    const actualSum = actual.reduce((sum, value) => sum + value, 0);
    const loudestActual = Math.max(...actual);
    const quietestActual = Math.min(...actual);
    const loudestPredicted = Math.max(...projected);
    const quietestPredicted = Math.min(...projected);
    const allocation = games
      .map((game) => allocationByPacket.get(packetKey(game.date, game.game_id, game.snapshot_ts)))
      .filter((outcome): outcome is AllocationOutcome => outcome !== undefined);
    const allocationComparable = allocation.filter((outcome) =>
      outcome.projected_higher !== "TIE" && outcome.actual_higher !== "TIE" && outcome.projected_higher !== "" && outcome.actual_higher !== "");
    const totalGoodAllocationBad = games.filter((game) => {
      const outcome = allocationByPacket.get(packetKey(game.date, game.game_id, game.snapshot_ts));
      return outcome !== undefined && Math.abs(game.mean - game.actual_total) <= 2 && outcome.allocation_mae >= 3;
    }).length;
    return [
      date, games.length, round(projectedSum), actualSum, round(projectedSum - actualSum), round(Math.abs(projectedSum - actualSum)),
      mean(absoluteErrors) ?? "", round(Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length)), median(absoluteErrors) ?? "",
      absoluteErrors.filter((error) => error >= 3).length, absoluteErrors.filter((error) => error >= 4).length, absoluteErrors.filter((error) => error >= 5).length,
      spearman(projected, actual) ?? "", actual.some((value, index) => value === loudestActual && projected[index] === loudestPredicted) ? "TRUE" : "FALSE",
      actual.some((value, index) => value === quietestActual && projected[index] === quietestPredicted) ? "TRUE" : "FALSE",
      allocation.length === 0 ? "" : totalGoodAllocationBad,
      allocation.length === 0 ? "" : allocation.length,
      allocation.length === 0 ? "" : allocationComparable.filter((outcome) => outcome.projected_higher === outcome.actual_higher).length,
      allocation.length === 0 ? "" : allocation.filter((outcome) => outcome.allocation_sign_reversal).length,
      "FROZEN_PRICE_BLIND_SLATE_DIAGNOSTIC_RESEARCH_ONLY", replayTimestamp,
    ];
  });
}

async function ensureSheets(workbookId: string, sheets: Array<{ sheet: string; column_count: number }>): Promise<void> {
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const { sheet } of sheets) {
    if (!existing.has(sheet)) {
      await addSheet(workbookId, sheet);
      existing.add(sheet);
    }
  }
  await Promise.all(sheets.map(({ sheet, column_count }) => expandSheetColumns(workbookId, sheet, column_count)));
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message);
}

async function readOptionalSheet(workbookId: string, range: string, warnings: string[]): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    warnings.push(`MISSING_GAME_TRUTH_DISTRIBUTION_SOURCE: ${range}`);
    return [];
  }
}

export async function runGameTruthDistributionResearch(
  options: { workbookId?: string } = {},
): Promise<GameTruthDistributionResearchResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTimestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetRows, truthRows, allocationRows] = await Promise.all([
      readOptionalSheet(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`, warnings),
      readOptionalSheet(workbookId, "GAME_TRUTH_REPLAY_V1!A1:AZ10000", warnings),
      readOptionalSheet(workbookId, "ALLOCATION_SETTLEMENT_DIAGNOSTICS!A1:AB10000", warnings),
    ]);
    const packets = parseFrozenDistributionBenchmarkPackets(packetRows);
    const truth = parseSettledDistributionBenchmarkTruth(truthRows);
    const joined = joinDistributionBenchmarkObservations(packets, truth);
    const evaluations = evaluateGameTruthDistributionWalkForward(joined.observations);
    const distributionRows = buildGameTruthDistributionRows(evaluations);
    const lineRows = buildGameTruthDistributionLineRows(evaluations);
    const summaryRows = buildGameTruthDistributionSummary(distributionRows, lineRows, replayTimestamp);
    const pairRows = buildGameTruthDistributionPairs(distributionRows, replayTimestamp);
    const allocation = parseFrozenAllocationOutcomes(allocationRows);
    const slateRows = buildGameTruthSlateDiagnostics(joined.observations, replayTimestamp, allocation);
    if (joined.snapshot_mismatches > 0) warnings.push(`FROZEN_PACKET_SNAPSHOT_MISMATCH: ${joined.snapshot_mismatches} observations excluded`);
    await ensureSheets(workbookId, [
      { sheet: GAME_TRUTH_DISTRIBUTION_RESEARCH_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_LINES_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_SUMMARY_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_SUMMARY_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_PAIRS_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS.length },
      { sheet: GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET, column_count: GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS.length },
    ]);
    await Promise.all([
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_RESEARCH_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_HEADERS), ...distributionRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_LINES_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_LINES_HEADERS), ...lineRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_SUMMARY_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_SUMMARY_HEADERS), ...summaryRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_PAIRS_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS), ...pairRows]),
      writeRange(workbookId, `${GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET}!A1`, [Array.from(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS), ...slateRows]),
    ]);
    const eligibleGames = evaluations.filter((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE").length;
    logger.info({ frozen_packets_seen: packets.size, settled_observations_seen: joined.observations.length, eligible_games: eligibleGames }, "MODULE_29: direct-total distribution research written (research-only)");
    return {
      status: "success", replay_timestamp_utc: replayTimestamp, frozen_packets_seen: packets.size,
      settled_observations_seen: joined.observations.length, eligible_games: eligibleGames,
      distribution_rows_written: distributionRows.length, line_rows_written: lineRows.length,
      summary_rows_written: summaryRows.length, pair_rows_written: pairRows.length, slate_rows_written: slateRows.length,
      snapshot_mismatches: joined.snapshot_mismatches, warnings, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_29: direct-total distribution research failed");
    return {
      status: "failure", replay_timestamp_utc: replayTimestamp, frozen_packets_seen: 0,
      settled_observations_seen: 0, eligible_games: 0, distribution_rows_written: 0, line_rows_written: 0,
      summary_rows_written: 0, pair_rows_written: 0, slate_rows_written: 0, snapshot_mismatches: 0, warnings, errors,
    };
  }
}
