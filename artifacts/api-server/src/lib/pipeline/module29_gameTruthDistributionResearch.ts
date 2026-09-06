/**
 * Module 29: Game-Truth Distribution Research V2, validation refinement
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
 * exist in the training corpus.  Version 53 adds validation plumbing only:
 * count-correct PIT, threshold-weighted CRPS, slate-block uncertainty, CORP
 * reliability diagnostics, and a frozen-feature governance ledger.  None of
 * these diagnostics can enter projection, market, vehicle, or decision code.
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
export const GAME_TRUTH_DISTRIBUTION_CORP_SHEET = "GAME_TRUTH_DIST_CORP_V2";
export const GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_SHEET = "GAME_TRUTH_DIST_FEATURE_GOV_V2";
export const GAME_TRUTH_DISTRIBUTION_VERSION = "GAME_TRUTH_DISTRIBUTION_V2_VALIDATION_V53_2026-09-05";
export const MIN_PRIOR_SETTLED_GAMES_V2 = 100;
export const STANDARD_TOTAL_LINES = [6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5] as const;
export const POSTED_REGION_HALF_TOTAL_LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5] as const;
export const BLOCK_BOOTSTRAP_REPLICATES = 1000;

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
  "Nonrandomized_Count_PIT",
  "Nonrandomized_PIT_Interval_Low",
  "Nonrandomized_PIT_Interval_High",
  "Deterministic_Randomized_PIT",
  "Threshold_Weighted_CRPS_6_5_TO_11_5",
  "PMF_Integrity_Status",
  "Line_Portability_Status",
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
  "Line_Cutoff_Integer",
  "Over_Probability",
  "Under_Or_Push_Probability",
  "CDF_At_Line_Cutoff",
  "Line_Probability_Reconciliation_Status",
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
  "Block_Count",
  "Block_Bootstrap_95_Low",
  "Block_Bootstrap_95_High",
  "Model_Relationship",
  "HLN_DM_Statistic",
  "HLN_DM_Two_Sided_P",
  "HLN_Status",
  "Variant_Count",
  "Block_Definition",
  "Sample_Size_Status",
  "Research_Status",
  "Replay_TS",
] as const;

export const GAME_TRUTH_DISTRIBUTION_CORP_HEADERS = [
  "Evaluation_Population",
  "Model",
  "Standard_Total_Line",
  "PAV_Group",
  "Prediction_Low",
  "Prediction_High",
  "Mean_Predicted_Probability",
  "Observed_Frequency",
  "Group_N",
  "CORP_MCB_Brier",
  "Block_Bootstrap_95_Low",
  "Block_Bootstrap_95_High",
  "Block_Count",
  "Sample_Size_Status",
  "Research_Status",
  "Replay_TS",
] as const;

export const GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_HEADERS = [
  "Feature",
  "Evidence_Status",
  "Mean_Location_Governance",
  "Variance_Tail_Governance",
  "Frozen_Frostline_Data_Availability",
  "Price_Blind_Prospective_Test_Design",
  "Current_Recommendation",
  "Data_Gap_Or_Guardrail",
  "Research_Status",
  "Protocol_Version",
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
  nonrandomized_count_pit: number;
  nonrandomized_pit_interval_low: number;
  nonrandomized_pit_interval_high: number;
  randomized_pit: number;
  threshold_weighted_crps: number;
  pmf_integrity_status: "VALID_PMF" | "INVALID_PMF";
  line_portability_status: "VALID_COHERENT_LINES" | "INVALID_LINE_COHERENCE";
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
  corp_rows_written: number;
  feature_governance_rows_written: number;
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

/**
 * Czado-Gneiting-Held's non-randomized count PIT is the midpoint of the
 * outcome's CDF jump.  We retain the jump interval too: it makes the discrete
 * construction inspectable and avoids representing a count PIT as a falsely
 * continuous observation.  The randomized value is secondary only.
 */
export function nonrandomizedCountPit(distribution: Distribution, actual: number): {
  pit: number;
  interval_low: number;
  interval_high: number;
} {
  const intervalLow = cdfAt(distribution, actual - 1);
  const intervalHigh = cdfAt(distribution, actual);
  return {
    pit: round((intervalLow + intervalHigh) / 2),
    interval_low: round(intervalLow),
    interval_high: round(intervalHigh),
  };
}

/** The posted-region twCRPS is the mean Brier score at half-run cutoffs. */
export function thresholdWeightedCrpsPostedRegion(distribution: Distribution, actual: number): number {
  const brier = POSTED_REGION_HALF_TOTAL_LINES.map((line) => {
    const cutoff = Math.floor(line);
    const overProbability = 1 - cdfAt(distribution, cutoff);
    const outcome = actual > cutoff ? 1 : 0;
    return (overProbability - outcome) ** 2;
  });
  return round(brier.reduce((sum, value) => sum + value, 0) / brier.length);
}

/**
 * One PMF must answer every line.  This is a deterministic data-integrity
 * check, not a calibration result and it does not read a market line.
 */
export function validatePmfAndLinePortability(distribution: Distribution): {
  pmf_integrity_status: "VALID_PMF" | "INVALID_PMF";
  line_portability_status: "VALID_COHERENT_LINES" | "INVALID_LINE_COHERENCE";
} {
  const tolerance = 1e-9;
  const pmfSum = distribution.pmf.reduce((sum, probability) => sum + probability, 0);
  const pmfValid = distribution.pmf.length > 0
    && distribution.pmf.every((probability) => Number.isFinite(probability) && probability >= -tolerance)
    && distribution.cdf.length === distribution.pmf.length
    && distribution.cdf.every((value, index) => Number.isFinite(value)
      && value >= -tolerance
      && value <= 1 + tolerance
      && (index === 0 || value + tolerance >= distribution.cdf[index - 1]!))
    && Math.abs(pmfSum - 1) <= tolerance
    && Math.abs(distribution.cdf[distribution.cdf.length - 1]! - 1) <= tolerance;
  const overProbabilities = STANDARD_TOTAL_LINES.map((line) => 1 - cdfAt(distribution, Math.floor(line)));
  const linesValid = pmfValid && overProbabilities.every((value, index) => Number.isFinite(value)
    && value >= -tolerance
    && value <= 1 + tolerance
    && (index === 0 || value <= overProbabilities[index - 1]! + tolerance)
    && Math.abs(value - (1 - cdfAt(distribution, Math.floor(STANDARD_TOTAL_LINES[index]!)))) <= tolerance);
  return {
    pmf_integrity_status: pmfValid ? "VALID_PMF" : "INVALID_PMF",
    line_portability_status: linesValid ? "VALID_COHERENT_LINES" : "INVALID_LINE_COHERENCE",
  };
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
  const nonrandomized = nonrandomizedCountPit(distribution, actual);
  const integrity = validatePmfAndLinePortability(distribution);
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
    mid_pit: nonrandomized.pit,
    nonrandomized_count_pit: nonrandomized.pit,
    nonrandomized_pit_interval_low: nonrandomized.interval_low,
    nonrandomized_pit_interval_high: nonrandomized.interval_high,
    randomized_pit: randomizedPit(distribution, actual, identity),
    threshold_weighted_crps: thresholdWeightedCrpsPostedRegion(distribution, actual),
    pmf_integrity_status: integrity.pmf_integrity_status,
    line_portability_status: integrity.line_portability_status,
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
    model.crps, model.log_loss, model.mid_pit, model.nonrandomized_count_pit,
    model.nonrandomized_pit_interval_low, model.nonrandomized_pit_interval_high, model.randomized_pit,
    model.threshold_weighted_crps, model.pmf_integrity_status, model.line_portability_status,
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
      ...Array(34).fill(""),
      "FROZEN_PRICE_BLIND_WALK_FORWARD_RESEARCH_ONLY", observation.settlement_ts,
    ]];
  });
}

export function buildGameTruthDistributionLineRows(evaluations: readonly GameTruthDistributionEvaluation[]): unknown[][] {
  return evaluations.flatMap((evaluation) => evaluation.models.flatMap((model) => STANDARD_TOTAL_LINES.map((line) => {
    const cutoff = Math.floor(line);
    const cdfAtCutoff = round(cdfAt(model.distribution, cutoff));
    const overProbability = round(1 - cdfAtCutoff);
    const actualOver = evaluation.observation.actual_total > cutoff ? 1 : 0;
    return [
      evaluation.observation.date, evaluation.observation.game_id, evaluation.observation.snapshot_ts,
      GAME_TRUTH_DISTRIBUTION_VERSION, model.comparator, line, evaluation.observation.mean,
      cutoff, overProbability, round(1 - overProbability), cdfAtCutoff,
      Math.abs(overProbability - (1 - cdfAtCutoff)) < 1e-9 ? "VALID_CDF_RECONCILIATION" : "INVALID_CDF_RECONCILIATION",
      evaluation.observation.actual_total, actualOver,
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

function sampleSizeStatus(n: number): string {
  if (n < 50) return "N_LT_50_PLUMBING_AND_GROSS_BUG_DETECTION_ONLY";
  if (n < 150) return "N_50_TO_149_GROSS_MISCALIBRATION_OR_LARGE_SCORE_GAPS_ONLY";
  if (n < 200) return "N_150_TO_199_DIRECTIONAL_PIT_AND_EARLY_CALIBRATION_ONLY";
  if (n < 500) return "N_200_TO_499_EARLY_MODEL_RANKING_NO_FINE_CALIBRATION_CERTIFICATION";
  if (n < 1000) return "N_500_TO_999_STRONGER_CALIBRATION_EVIDENCE_SLOPE_STILL_IMPRECISE";
  return "N_GTE_1000_CALIBRATION_SLOPE_BEGINS_TO_BE_CERTIFIABLE";
}

/** Anderson-Darling statistic for the uniform diagnostic; no small-n p value is claimed. */
export function andersonDarlingUniformDiagnostic(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const epsilon = 1e-12;
  const sum = ordered.reduce((total, value, index) => {
    const low = Math.min(1 - epsilon, Math.max(epsilon, value));
    const high = Math.min(1 - epsilon, Math.max(epsilon, ordered[ordered.length - index - 1]!));
    return total + (2 * (index + 1) - 1) * (Math.log(low) + Math.log(1 - high));
  }, 0);
  return round(-ordered.length - sum / ordered.length);
}

function pitRows(
  rows: unknown[][],
  model: Comparator,
  field: "Nonrandomized_Count_PIT" | "Deterministic_Randomized_PIT",
  label: "NONRANDOMIZED_COUNT_PIT_BIN" | "RANDOMIZED_PIT_BIN_SECONDARY",
  replayTimestamp: string,
): unknown[][] {
  const values = valuesFor(rows, model, field);
  return Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const count = values.filter((value) => value >= lower && (index === 9 ? value <= upper : value < upper)).length;
    return ["ALL_WALK_FORWARD", model, label, `${lower.toFixed(1)}_${upper.toFixed(1)}`,
      values.length, "", "", count, values.length === 0 ? "" : 0.1, "", "",
      "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp];
  });
}

export function buildGameTruthDistributionSummary(rows: unknown[][], lineRows: unknown[][], replayTimestamp: string): unknown[][] {
  const eligible = scoredRows(rows);
  const currentSampleStatus = sampleSizeStatus(eligible.length / Math.max(1, uniqueModels(eligible).length));
  const summary: unknown[][] = [[
    "MODEL_SELECTION_PROTOCOL", "ALL", "PREDECLARED_DECISION", "NO_PROMOTION_WITH_CURRENT_SAMPLE",
    0, "", "", "", "", "", "",
    "A comparator needs a large, stable paired block-bootstrap CRPS and log-score advantage; ambiguity retains every research comparator. No current sample can establish fine calibration.", replayTimestamp,
  ], [
    "VALIDATION_SAMPLE_SIZE", "ALL", "SAMPLE_SIZE_STATUS", "WALK_FORWARD_PER_MODEL",
    eligible.length / Math.max(1, uniqueModels(eligible).length), "", "", "", "", "", "",
    currentSampleStatus, replayTimestamp,
  ]];
  for (const model of uniqueModels(eligible)) {
    for (const field of ["CRPS", "Log_Loss", "Threshold_Weighted_CRPS_6_5_TO_11_5", "Nonrandomized_Count_PIT", "Deterministic_Randomized_PIT"] as const) {
      const values = valuesFor(eligible, model, field);
      summary.push(["ALL_WALK_FORWARD", model, field.toUpperCase(), "", values.length, mean(values) ?? "", median(values) ?? "", "", "", "", "", "RESEARCH_ONLY_NO_PROMOTION", replayTimestamp]);
    }
    const nonrandomized = valuesFor(eligible, model, "Nonrandomized_Count_PIT");
    summary.push(["ALL_WALK_FORWARD", model, "ANDERSON_DARLING_UNIFORM_DIAGNOSTIC", "NONRANDOMIZED_COUNT_PIT", nonrandomized.length, andersonDarlingUniformDiagnostic(nonrandomized) ?? "", "", "", "", "", "", "DIAGNOSTIC_ONLY_NO_SMALL_SAMPLE_UNIFORMITY_CLAIM", replayTimestamp]);
    summary.push(coverageSummaryRow(eligible, model, 50, replayTimestamp));
    summary.push(coverageSummaryRow(eligible, model, 80, replayTimestamp));
    summary.push(coverageSummaryRow(eligible, model, 90, replayTimestamp));
    summary.push(...pitRows(eligible, model, "Nonrandomized_Count_PIT", "NONRANDOMIZED_COUNT_PIT_BIN", replayTimestamp));
    summary.push(...pitRows(eligible, model, "Deterministic_Randomized_PIT", "RANDOMIZED_PIT_BIN_SECONDARY", replayTimestamp));
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

interface DatedScoreDelta {
  date: string;
  delta: number;
}

function seededUniform(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(ordered.length - 1, probability * (ordered.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return round(ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower));
}

/** Resamples complete slate dates, retaining all within-slate score pairs. */
export function pairedSlateBlockBootstrapCi(
  records: readonly DatedScoreDelta[],
  seed: string,
): { block_count: number; low: number | null; high: number | null } {
  const byDate = new Map<string, number[]>();
  for (const record of records) {
    const block = byDate.get(record.date) ?? [];
    block.push(record.delta);
    byDate.set(record.date, block);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return { block_count: dates.length, low: null, high: null };
  const draw = seededUniform(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < BLOCK_BOOTSTRAP_REPLICATES; iteration++) {
    let total = 0;
    let count = 0;
    for (let block = 0; block < dates.length; block++) {
      const date = dates[Math.floor(draw() * dates.length)]!;
      for (const delta of byDate.get(date) ?? []) {
        total += delta;
        count++;
      }
    }
    if (count > 0) estimates.push(total / count);
  }
  return {
    block_count: dates.length,
    low: percentile(estimates, 0.025),
    high: percentile(estimates, 0.975),
  };
}

function modelRelationship(modelA: Comparator, modelB: Comparator): "NESTED" | "NON_NESTED" | "RELATED_ZERO_MODIFICATION" {
  const models = new Set([modelA, modelB]);
  if (models.has("POISSON") && (models.has("NB") || models.has("CMP"))) return "NESTED";
  if (models.has("NB") && models.has("HURDLE_NB")) return "RELATED_ZERO_MODIFICATION";
  return "NON_NESTED";
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const minimum = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < minimum) d = minimum;
  d = 1 / d;
  let h = d;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const doubled = 2 * iteration;
    let aa = iteration * (b - iteration) * x / ((a + doubled - 1) * (a + doubled));
    d = 1 + aa * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + aa / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    h *= d * c;
    aa = -(a + iteration) * (a + b + iteration) * x / ((a + doubled) * (a + doubled + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + aa / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logGamma(a) - logGamma(b) + logGamma(a + b));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x) / a
    : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function studentTCdf(value: number, degreesOfFreedom: number): number | null {
  if (!Number.isFinite(value) || degreesOfFreedom <= 0) return null;
  const x = degreesOfFreedom / (degreesOfFreedom + value ** 2);
  const beta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
  return value >= 0 ? 1 - beta / 2 : beta / 2;
}

function hlnCorrectedDm(records: readonly DatedScoreDelta[], relationship: ReturnType<typeof modelRelationship>): {
  statistic: number | null;
  p_value: number | null;
  status: string;
} {
  if (relationship === "NESTED") return { statistic: null, p_value: null, status: "NOT_APPLICABLE_NESTED_MODELS" };
  if (records.length < 3) return { statistic: null, p_value: null, status: "INSUFFICIENT_PAIRS_FOR_HLN_DM" };
  const values = records.map((record) => record.delta);
  const average = mean(values);
  if (average === null) return { statistic: null, p_value: null, status: "INSUFFICIENT_PAIRS_FOR_HLN_DM" };
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  if (variance <= 0) return { statistic: null, p_value: null, status: "ZERO_SCORE_DIFFERENCE_VARIANCE" };
  const rawStatistic = average / Math.sqrt(variance / values.length);
  const corrected = rawStatistic * Math.sqrt((values.length - 1) / values.length);
  const cdf = studentTCdf(corrected, values.length - 1);
  return {
    statistic: round(corrected),
    p_value: cdf === null ? null : round(2 * Math.min(cdf, 1 - cdf)),
    status: "HLN_DM_1_STEP_INDEPENDENCE_APPROXIMATION_SECONDARY_TO_BLOCK_BOOTSTRAP",
  };
}

function pairedMetricRows(
  rows: unknown[][],
  modelA: Comparator,
  modelB: Comparator,
  metric: "CRPS" | "Log_Loss" | "Threshold_Weighted_CRPS_6_5_TO_11_5",
  replayTimestamp: string,
  variantCount: number,
): unknown[] {
  const modelIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model");
  const gameIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Game_ID");
  const dateIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Date");
  const snapshotIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Frozen_Packet_Snapshot_TS");
  const metricIndex = GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf(metric);
  const valueByModelGame = new Map<string, number>();
  for (const row of rows) {
    const model = text(row[modelIndex]);
    if (model !== modelA && model !== modelB) continue;
    const value = Number(row[metricIndex]);
    if (Number.isFinite(value)) valueByModelGame.set(`${model}|${row[dateIndex]}|${row[gameIndex]}|${row[snapshotIndex]}`, value);
  }
  const records: DatedScoreDelta[] = [];
  for (const row of rows) {
    if (text(row[modelIndex]) !== modelA) continue;
    const date = String(row[dateIndex]);
    const gameId = String(row[gameIndex]);
    const snapshot = String(row[snapshotIndex]);
    const a = valueByModelGame.get(`${modelA}|${date}|${gameId}|${snapshot}`);
    const b = valueByModelGame.get(`${modelB}|${date}|${gameId}|${snapshot}`);
    if (a !== undefined && b !== undefined) records.push({ date, delta: a - b });
  }
  const deltas = records.map((record) => record.delta);
  const epsilon = 1e-12;
  const aBetter = deltas.filter((delta) => delta < -epsilon).length;
  const bBetter = deltas.filter((delta) => delta > epsilon).length;
  const ties = deltas.length - aBetter - bBetter;
  const relationship = modelRelationship(modelA, modelB);
  const bootstrap = pairedSlateBlockBootstrapCi(records, `${metric}|${modelA}|${modelB}`);
  const hln = hlnCorrectedDm(records, relationship);
  return [
    "ALL_WALK_FORWARD", metric.toUpperCase(), "", modelA, modelB, deltas.length,
    aBetter + bBetter, aBetter, bBetter, ties, mean(deltas) ?? "", median(deltas) ?? "",
    pairedSignTestTwoSidedP(aBetter, bBetter) ?? "", bootstrap.block_count, bootstrap.low ?? "", bootstrap.high ?? "",
    relationship, hln.statistic ?? "", hln.p_value ?? "", hln.status, variantCount,
    "SLATE_DATE_RESAMPLING_WITH_REPLACEMENT", sampleSizeStatus(deltas.length),
    "PAIRED_SCORE_RESEARCH_ONLY_NO_PROMOTION", replayTimestamp,
  ];
}

export function buildGameTruthDistributionPairs(rows: unknown[][], replayTimestamp: string): unknown[][] {
  const eligible = scoredRows(rows);
  const models = uniqueModels(eligible);
  const output: unknown[][] = [];
  for (const metric of ["CRPS", "Log_Loss", "Threshold_Weighted_CRPS_6_5_TO_11_5"] as const) {
    for (let left = 0; left < models.length; left++) {
      for (let right = left + 1; right < models.length; right++) {
        output.push(pairedMetricRows(eligible, models[left]!, models[right]!, metric, replayTimestamp, models.length));
      }
    }
  }
  return output;
}

interface CorpObservation {
  date: string;
  probability: number;
  outcome: number;
}

interface PavGroup {
  observations: CorpObservation[];
  sum_outcome: number;
}

/** Pool-adjacent-violators fit for a bin-free CORP reliability curve. */
export function poolAdjacentViolators(observations: readonly CorpObservation[]): PavGroup[] {
  const ordered = [...observations].sort((left, right) => left.probability - right.probability || left.date.localeCompare(right.date));
  const groups: PavGroup[] = [];
  for (const observation of ordered) {
    groups.push({ observations: [observation], sum_outcome: observation.outcome });
    while (groups.length >= 2) {
      const right = groups[groups.length - 1]!;
      const left = groups[groups.length - 2]!;
      const leftRate = left.sum_outcome / left.observations.length;
      const rightRate = right.sum_outcome / right.observations.length;
      if (leftRate <= rightRate) break;
      groups.splice(groups.length - 2, 2, {
        observations: [...left.observations, ...right.observations],
        sum_outcome: left.sum_outcome + right.sum_outcome,
      });
    }
  }
  return groups;
}

function blockBootstrapObservedFrequency(
  observations: readonly CorpObservation[],
  seed: string,
): { block_count: number; low: number | null; high: number | null } {
  const byDate = new Map<string, CorpObservation[]>();
  for (const observation of observations) {
    const block = byDate.get(observation.date) ?? [];
    block.push(observation);
    byDate.set(observation.date, block);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return { block_count: dates.length, low: null, high: null };
  const draw = seededUniform(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < BLOCK_BOOTSTRAP_REPLICATES; iteration++) {
    let total = 0;
    let count = 0;
    for (let block = 0; block < dates.length; block++) {
      const date = dates[Math.floor(draw() * dates.length)]!;
      for (const observation of byDate.get(date) ?? []) {
        total += observation.outcome;
        count++;
      }
    }
    if (count > 0) estimates.push(total / count);
  }
  return { block_count: dates.length, low: percentile(estimates, 0.025), high: percentile(estimates, 0.975) };
}

/**
 * CORP-style threshold reliability: PAV creates the reproducible calibration
 * curve; MCB is the mean squared change from raw to PAV-fitted probability.
 * Bootstrap bands retain whole slate dates, never independent game draws.
 */
export function buildGameTruthDistributionCorpRows(lineRows: readonly unknown[][], replayTimestamp: string): unknown[][] {
  const header = GAME_TRUTH_DISTRIBUTION_LINES_HEADERS;
  const field = (row: unknown[], name: (typeof GAME_TRUTH_DISTRIBUTION_LINES_HEADERS)[number]): unknown => row[header.indexOf(name)];
  const models = [...new Set(lineRows.map((row) => text(field(row, "Model"))))]
    .filter((model): model is Comparator => model === "POISSON" || model === "NB" || model === "HURDLE_NB" || model === "CMP" || model === "EMPIRICAL_RESIDUAL")
    .sort();
  const output: unknown[][] = [];
  for (const model of models) {
    for (const line of STANDARD_TOTAL_LINES) {
      const observations: CorpObservation[] = lineRows
        .filter((row) => text(field(row, "Model")) === model
          && Number(field(row, "Standard_Total_Line")) === line
          && text(field(row, "Research_Status")) === "WALK_FORWARD_ELIGIBLE")
        .map((row) => ({
          date: text(field(row, "Date")),
          probability: Number(field(row, "Over_Probability")),
          outcome: Number(field(row, "Actual_Over_Result")),
        }))
        .filter((row) => row.date !== "" && Number.isFinite(row.probability) && (row.outcome === 0 || row.outcome === 1));
      const groups = poolAdjacentViolators(observations);
      const mcb = observations.length === 0 ? null : groups.reduce((sum, group) => {
        const fitted = group.sum_outcome / group.observations.length;
        return sum + group.observations.reduce((groupSum, observation) => groupSum + (observation.probability - fitted) ** 2, 0);
      }, 0) / observations.length;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        const observed = group.sum_outcome / group.observations.length;
        const bootstrap = blockBootstrapObservedFrequency(group.observations, `CORP|${model}|${line}|${groupIndex}`);
        output.push([
          "ALL_WALK_FORWARD", model, line, groupIndex + 1,
          round(Math.min(...group.observations.map((row) => row.probability))),
          round(Math.max(...group.observations.map((row) => row.probability))),
          round(mean(group.observations.map((row) => row.probability))!), round(observed), group.observations.length,
          mcb === null ? "" : round(mcb), bootstrap.low ?? "", bootstrap.high ?? "", bootstrap.block_count,
          sampleSizeStatus(observations.length), "CORP_PAV_RESEARCH_ONLY_NO_RECALIBRATION", replayTimestamp,
        ]);
      }
      if (groups.length === 0) {
        output.push(["ALL_WALK_FORWARD", model, line, "", "", "", "", "", 0, "", "", "", 0,
          sampleSizeStatus(0), "INSUFFICIENT_WALK_FORWARD_EVIDENCE", replayTimestamp]);
      }
    }
  }
  return output;
}

/**
 * The ledger makes feature scope explicit before any covariate is fitted.
 * It is intentionally a research protocol, not a model-feature registry.
 */
export function gameTruthDistributionFeatureGovernanceRows(): unknown[][] {
  const version = "MODULE_29_FEATURE_GOVERNANCE_V1_2026-09-05";
  const rows: Array<[string, string, string, string, string, string, string, string]> = [
    ["STARTER_GAME_TO_GAME_BLOW_UP_PROPENSITY", "EVIDENCE_BACKED", "MEAN_SEPARATE_FROM_VARIANCE", "VARIANCE_TAIL_CANDIDATE", "PARTIAL: settled starter outcomes exist; no frozen propensity feature", "Freeze prior-only starter run-allowed variance, severe-blow-up frequency, HR and BB volatility; test upper-tail and score improvement walk-forward", "KEEP_RESEARCHING", "Must never derive a propensity from the evaluated game or let K skill erase tail risk."],
    ["STARTER_EARLY_EXIT_ROLE_FRAGILITY", "EVIDENCE_BACKED_MECHANISM_DATA_GAP", "MEAN_ROLE_ONLY", "VARIANCE_TAIL_CANDIDATE", "PARTIAL: roles freeze prospectively; Expected_IP trace is not trustworthy for width", "After a valid pitcher-specific workload source exists, compare unplanned early exits with planned opener/bulk roles and score tail calibration", "INSUFFICIENT_DATA", "Do not use placeholder Expected_IP or planned short role as an early-exit proxy."],
    ["REGRESSED_MULTIYEAR_PARK_VOLATILITY", "EVIDENCE_BACKED", "BOTH", "BOTH", "PARTIAL: frozen park mean exists; no regressed volatility input", "Materialize a weather-neutral multi-year park volatility measure prospectively; test residual variance and PIT tails conditional on center", "KEEP_RESEARCHING", "Do not use a raw single-season park factor or double count weather."],
    ["PARK_CONDITIONAL_WIND", "EVIDENCE_BACKED_PARK_SPECIFIC", "MEAN_CANDIDATE", "VARIANCE_TAIL_CANDIDATE", "PARTIAL: weather is frozen; no frozen park-sensitivity interaction", "Freeze wind vector and park sensitivity class; compare out-of-sample tail calibration against temperature-only environment", "READY_FOR_PROSPECTIVE_SHADOW", "No generic wind coefficient; enclosed parks are neutral and forecast uncertainty remains visible."],
    ["BULLPEN_FATIGUE_STATE", "MEAN_SUPPORTED_TAIL_PROSPECTIVE", "MEAN_CANDIDATE", "PROSPECTIVE_UNPROVEN", "PARTIAL: availability/feed coverage begins late and is not a standard burden metric", "Freeze back-to-back, pitches, batters faced, short-rest burden, and leverage availability; test mean and tail separately", "READY_FOR_PROSPECTIVE_SHADOW", "Fatigue must not be equated with generic bullpen variance."],
    ["BULLPEN_RELIANCE", "PROSPECTIVE_UNPROVEN", "PROSPECTIVE_UNPROVEN", "PROSPECTIVE_UNPROVEN", "UNSUPPORTED_CURRENT: exposure derives from the unresolved Expected_IP layer", "Matched role cohorts: standard starter, planned opener, bulk, and bullpen game; compare SD, tails, CRPS and PIT after 200+ qualifying games", "INSUFFICIENT_DATA", "No automatic width modifier or opener tax."],
    ["OPENER_CHAIN_UNCERTAINTY", "PROSPECTIVE_UNPROVEN", "PROSPECTIVE_UNPROVEN", "PROSPECTIVE_UNPROVEN", "PARTIAL: role/chain evidence is prospective only; settled n begins after role capture", "Compare planned resolved chains, uncertain chains, and conventional starts while controlling for center and bullpen state", "READY_FOR_PROSPECTIVE_SHADOW", "Role label alone cannot stand in for deployment uncertainty."],
    ["HIGH_TRAFFIC_ACCESS", "STRUCTURALLY_PLAUSIBLE", "MEAN_CANDIDATE", "PROSPECTIVE_UNPROVEN", "AVAILABLE: frozen collision traffic, but historical pre-cap preservation is incomplete", "Use access propensity, not sequencing gaps; test upper-tail exceedance and CRPS conditional on damage and center", "KEEP_RESEARCHING", "Preserve traffic, damage, and conversion as separate quantities; no historical LOB% modifier."],
    ["TRAFFIC_WITHOUT_DAMAGE_HISTORICAL_GAP", "UNSUPPORTED_FOR_PERSISTENT_SHAPE", "MEAN_REGRESSION_ONLY_IF_VALIDATED", "UNSUPPORTED_FOR_DISPERSION", "AVAILABLE_LABEL_ONLY", "Do not fit as a width feature; retain only as a diagnostic comparator against genuine access/damage inputs", "REJECT", "LOB%, ERA-FIP and historical sequencing are regression/noise signals, not durable tail traits."],
    ["LINEUP_TALENT_COMPLETENESS", "MEAN_SUPPORTED", "MEAN_LOCATION_CANDIDATE", "UNSUPPORTED_FOR_DISPERSION", "AVAILABLE: frozen completeness/status and lineup quality", "Evaluate missing-star/talent completeness as a center input; do not use batting-order position as shape", "KEEP_RESEARCHING", "Official full lineups are data quality, not an automatic variance modifier."],
    ["BATTING_ORDER_CONSTRUCTION", "UNSUPPORTED_MATERIAL_EFFECT", "UNSUPPORTED_FOR_MEAN_REFINEMENT", "UNSUPPORTED_FOR_DISPERSION", "AVAILABLE_BUT_NOT_GOVERNED_AS_FEATURE", "No prospective width study; hold position order outside feature candidates", "REJECT", "Talent matters; batting second versus third is not a game-distribution feature."],
    ["TEMPERATURE", "MEAN_SUPPORTED", "MEAN_LOCATION_CANDIDATE", "PROSPECTIVE_UNPROVEN", "AVAILABLE: frozen environment inputs", "Keep as environment mean input; test a width effect only in interaction with park and forecast reliability", "KEEP_RESEARCHING", "Do not create an independent generic variance switch."],
    ["HUMIDITY_AND_BAROMETRIC_PRESSURE", "WEAK_INDEPENDENT_EVIDENCE", "FOLD_INTO_ENVIRONMENT_PHYSICS", "UNSUPPORTED_FOR_DISPERSION", "PARTIAL_OR_SOURCE_DEPENDENT", "No standalone feature study before higher-value park/wind and pitcher features", "REJECT", "No separate coefficients; avoid noise mining."],
  ];
  return rows.map((row) => [...row, "RESEARCH_ONLY_NO_PRODUCTION_CONSUMER", version]);
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
    const corpRows = buildGameTruthDistributionCorpRows(lineRows, replayTimestamp);
    const featureGovernanceRows = gameTruthDistributionFeatureGovernanceRows();
    const allocation = parseFrozenAllocationOutcomes(allocationRows);
    const slateRows = buildGameTruthSlateDiagnostics(joined.observations, replayTimestamp, allocation);
    if (joined.snapshot_mismatches > 0) warnings.push(`FROZEN_PACKET_SNAPSHOT_MISMATCH: ${joined.snapshot_mismatches} observations excluded`);
    await ensureSheets(workbookId, [
      { sheet: GAME_TRUTH_DISTRIBUTION_RESEARCH_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_LINES_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_SUMMARY_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_SUMMARY_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_PAIRS_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_CORP_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_CORP_HEADERS.length },
      { sheet: GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_SHEET, column_count: GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_HEADERS.length },
      { sheet: GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET, column_count: GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS.length },
    ]);
    await Promise.all([
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_RESEARCH_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_HEADERS), ...distributionRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_LINES_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_LINES_HEADERS), ...lineRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_SUMMARY_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_SUMMARY_HEADERS), ...summaryRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_PAIRS_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS), ...pairRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_CORP_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_CORP_HEADERS), ...corpRows]),
      writeRange(workbookId, `${GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_SHEET}!A1`, [Array.from(GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_HEADERS), ...featureGovernanceRows]),
      writeRange(workbookId, `${GAME_TRUTH_SLATE_DIAGNOSTICS_SHEET}!A1`, [Array.from(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS), ...slateRows]),
    ]);
    const eligibleGames = evaluations.filter((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE").length;
    logger.info({ frozen_packets_seen: packets.size, settled_observations_seen: joined.observations.length, eligible_games: eligibleGames }, "MODULE_29: direct-total distribution research written (research-only)");
    return {
      status: "success", replay_timestamp_utc: replayTimestamp, frozen_packets_seen: packets.size,
      settled_observations_seen: joined.observations.length, eligible_games: eligibleGames,
      distribution_rows_written: distributionRows.length, line_rows_written: lineRows.length,
      summary_rows_written: summaryRows.length, pair_rows_written: pairRows.length,
      corp_rows_written: corpRows.length, feature_governance_rows_written: featureGovernanceRows.length,
      slate_rows_written: slateRows.length,
      snapshot_mismatches: joined.snapshot_mismatches, warnings, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_29: direct-total distribution research failed");
    return {
      status: "failure", replay_timestamp_utc: replayTimestamp, frozen_packets_seen: 0,
      settled_observations_seen: 0, eligible_games: 0, distribution_rows_written: 0, line_rows_written: 0,
      summary_rows_written: 0, pair_rows_written: 0, corp_rows_written: 0, feature_governance_rows_written: 0,
      slate_rows_written: 0, snapshot_mismatches: 0, warnings, errors,
    };
  }
}
