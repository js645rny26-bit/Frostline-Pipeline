/**
 * Module 28: Shadow Distribution Benchmark V1
 *
 * A research-only, time-ordered evaluation of a price-blind total-runs
 * distribution. The frozen published center is the location for every
 * comparator. No market value, score, vehicle, or realized outcome is ever
 * used to make the pregame center or a board decision.
 *
 * Each slate is evaluated with a distribution fitted strictly from earlier
 * settled frozen packets. Same-slate results are deliberately unavailable to
 * one another. The module writes evaluation evidence after settlement only;
 * it is not a prospective forecast surface and cannot feed authorization.
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
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

export const SHADOW_DISTRIBUTION_BENCHMARK_SHEET = "DISTRIBUTION_BENCHMARK_V1";
export const SHADOW_DISTRIBUTION_BENCHMARK_SUMMARY_SHEET = "DISTRIBUTION_BENCHMARK_SUMMARY";
export const SHADOW_DISTRIBUTION_BENCHMARK_PAIRS_SHEET = "DISTRIBUTION_BENCHMARK_PAIRS";
export const SHADOW_DISTRIBUTION_BENCHMARK_VERSION = "SHADOW_DISTRIBUTION_V1_2026-09-04";
export const MIN_PRIOR_SETTLED_GAMES = 100;

export const DISTRIBUTION_BENCHMARK_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Distribution_Benchmark_Version",
  "Refit_Slate_Date",
  "Training_Through_Date",
  "Prior_Settled_Games",
  "Distribution_Status",
  "Frozen_Price_Blind_Mean",
  "Actual_Total",
  "NB_Alpha",
  "NB_Alpha_Fit_Status",
  "Frozen_Queried_Threshold",
  "Frozen_Threshold_Source",
  "Threshold_Status",
  "NB_CRPS",
  "NB_Log_Loss",
  "NB_Mid_PIT",
  "NB_Over_Probability",
  "NB_Brier_At_Queried_Threshold",
  "NB_50_Low",
  "NB_50_High",
  "NB_50_Covered",
  "NB_80_Low",
  "NB_80_High",
  "NB_80_Covered",
  "NB_90_Low",
  "NB_90_High",
  "NB_90_Covered",
  "Poisson_CRPS",
  "Poisson_Log_Loss",
  "Poisson_Mid_PIT",
  "Poisson_Over_Probability",
  "Poisson_Brier_At_Queried_Threshold",
  "Poisson_50_Low",
  "Poisson_50_High",
  "Poisson_50_Covered",
  "Poisson_80_Low",
  "Poisson_80_High",
  "Poisson_80_Covered",
  "Poisson_90_Low",
  "Poisson_90_High",
  "Poisson_90_Covered",
  "Empirical_Residual_CRPS",
  "Empirical_Residual_Log_Loss",
  "Empirical_Residual_Mid_PIT",
  "Empirical_Residual_Over_Probability",
  "Empirical_Residual_Brier_At_Queried_Threshold",
  "Empirical_Residual_50_Low",
  "Empirical_Residual_50_High",
  "Empirical_Residual_50_Covered",
  "Empirical_Residual_80_Low",
  "Empirical_Residual_80_High",
  "Empirical_Residual_80_Covered",
  "Empirical_Residual_90_Low",
  "Empirical_Residual_90_High",
  "Empirical_Residual_90_Covered",
  "Replay_Status",
  "Settlement_TS",
] as const;

export const DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS = [
  "Evaluation_Population",
  "Comparator",
  "Metric",
  "Queried_Threshold",
  "Eligible_N",
  "Mean_Value",
  "Median_Value",
  "Observed_Coverage",
  "Target_Coverage",
  "Mean_Mid_PIT",
  "Research_Status",
  "Replay_TS",
] as const;

export const DISTRIBUTION_BENCHMARK_PAIR_HEADERS = [
  "Evaluation_Population",
  "Metric",
  "Queried_Threshold",
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

interface FrozenBenchmarkPacket {
  date: string;
  game_id: string;
  snapshot_ts: string;
  mean: number;
  queried_threshold: number | null;
  threshold_source: string;
}

interface SettledBenchmarkTruth {
  date: string;
  game_id: string;
  snapshot_ts: string;
  actual_total: number;
  settlement_ts: string;
}

export interface DistributionBenchmarkObservation {
  date: string;
  game_id: string;
  snapshot_ts: string;
  mean: number;
  actual_total: number;
  queried_threshold: number | null;
  threshold_source: string;
  settlement_ts: string;
}

interface Distribution {
  pmf: number[];
  cdf: number[];
}

interface Interval {
  low: number;
  high: number;
  covered: boolean;
}

interface ModelEvaluation {
  crps: number;
  log_loss: number;
  mid_pit: number;
  over_probability: number | null;
  brier: number | null;
  interval_50: Interval;
  interval_80: Interval;
  interval_90: Interval;
}

interface BenchmarkEvaluation {
  observation: DistributionBenchmarkObservation;
  training_through_date: string;
  prior_settled_games: number;
  status: "WALK_FORWARD_ELIGIBLE" | "INSUFFICIENT_PRIOR_SETTLED_GAMES";
  alpha: number | null;
  alpha_fit_status: string;
  threshold_status: string;
  nb: ModelEvaluation | null;
  poisson: ModelEvaluation | null;
  empirical: ModelEvaluation | null;
}

export interface DistributionBenchmarkResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  frozen_packets_seen: number;
  settled_observations_seen: number;
  eligible_games: number;
  benchmark_rows_written: number;
  summary_rows_written: number;
  pair_rows_written: number;
  snapshot_mismatches: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function key(date: string, gameId: string): string {
  return `${date}|${gameId}`;
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((name, index) => [text(name), index]));
}

function value(row: unknown[], index: ReadonlyMap<string, number>, name: string): unknown {
  const column = index.get(name);
  return column === undefined ? undefined : row[column];
}

function isValidBeforeFirstPitch(snapshotTs: string, firstPitch: string): boolean {
  const snapshotMs = Date.parse(snapshotTs);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
}

function validTotal(value: number | null): value is number {
  return value !== null && value > 0 && Number.isFinite(value);
}

function validObservedTotal(value: number | null): value is number {
  return value !== null && value >= 0 && Number.isInteger(value);
}

/** Read only price-blind, frozen pre-first-pitch location and query provenance. */
export function parseFrozenDistributionBenchmarkPackets(rows: unknown[][]): Map<string, FrozenBenchmarkPacket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const packets = new Map<string, FrozenBenchmarkPacket>();
  const latestSnapshotMs = new Map<string, number>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const mean = numeric(value(row, index, "Base_Projection"));
    const snapshotMs = Date.parse(snapshotTs);
    const observationKey = key(date, gameId);
    if (
      !date
      || !gameId
      || !snapshotTs
      || text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME"
      || !isValidBeforeFirstPitch(snapshotTs, firstPitch)
      || !validTotal(mean)
      || !Number.isFinite(snapshotMs)
      || snapshotMs < (latestSnapshotMs.get(observationKey) ?? Number.NEGATIVE_INFINITY)
    ) continue;
    packets.set(observationKey, {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      mean,
      // This threshold is strictly an evaluation query. It does not take part
      // in the distribution fit, location, alpha, or interval construction.
      queried_threshold: numeric(value(row, index, "Primary_Grade_Market_Line")),
      threshold_source: text(value(row, index, "Primary_Grade_Market_Source")) || "NO_FROZEN_QUERY_SOURCE",
    });
    latestSnapshotMs.set(observationKey, snapshotMs);
  }
  return packets;
}

/** Module 24 is the canonical settled frozen-packet truth join. */
export function parseSettledDistributionBenchmarkTruth(rows: unknown[][]): Map<string, SettledBenchmarkTruth> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const settled = new Map<string, SettledBenchmarkTruth>();
  const latestSettlementMs = new Map<string, number>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Frozen_Packet_Snapshot_TS"));
    const actualTotal = numeric(value(row, index, "Actual_Total"));
    const settlementTs = text(value(row, index, "Settlement_TS"));
    const settlementMs = Date.parse(settlementTs);
    const observationKey = key(date, gameId);
    if (
      !date
      || !gameId
      || !snapshotTs
      || !validObservedTotal(actualTotal)
      || text(value(row, index, "Replay_Status")) !== "FROZEN_PACKET_AND_FINAL_VERIFIED"
      || !Number.isFinite(settlementMs)
      || settlementMs < (latestSettlementMs.get(observationKey) ?? Number.NEGATIVE_INFINITY)
    ) continue;
    settled.set(observationKey, {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      actual_total: actualTotal,
      settlement_ts: settlementTs,
    });
    latestSettlementMs.set(observationKey, settlementMs);
  }
  return settled;
}

export function joinDistributionBenchmarkObservations(
  packets: ReadonlyMap<string, FrozenBenchmarkPacket>,
  settled: ReadonlyMap<string, SettledBenchmarkTruth>,
): { observations: DistributionBenchmarkObservation[]; snapshot_mismatches: number } {
  let snapshotMismatches = 0;
  const observations: DistributionBenchmarkObservation[] = [];
  for (const [observationKey, packet] of packets) {
    const outcome = settled.get(observationKey);
    if (!outcome) continue;
    if (outcome.snapshot_ts !== packet.snapshot_ts) {
      snapshotMismatches++;
      continue;
    }
    observations.push({
      ...packet,
      actual_total: outcome.actual_total,
      settlement_ts: outcome.settlement_ts,
    });
  }
  return {
    observations: observations.sort((left, right) =>
      left.date.localeCompare(right.date) || left.game_id.localeCompare(right.game_id)),
    snapshot_mismatches: snapshotMismatches,
  };
}

// Lanczos approximation. It keeps the NB likelihood self-contained and avoids
// a numerical package that could make the benchmark environment-dependent.
function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993;
  const shifted = value - 1;
  for (let index = 0; index < coefficients.length; index++) x += coefficients[index]! / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function poissonLogPmf(observed: number, mean: number): number {
  return observed * Math.log(mean) - mean - logGamma(observed + 1);
}

function negativeBinomialLogPmf(observed: number, mean: number, alpha: number): number {
  if (alpha <= 1e-7) return poissonLogPmf(observed, mean);
  const shape = 1 / alpha;
  const logDenominator = Math.log1p(alpha * mean);
  return logGamma(observed + shape)
    - logGamma(shape)
    - logGamma(observed + 1)
    - shape * logDenominator
    + observed * (Math.log(alpha * mean) - logDenominator);
}

function totalLogLikelihood(training: readonly DistributionBenchmarkObservation[], alpha: number): number {
  return training.reduce(
    (sum, observation) => sum + negativeBinomialLogPmf(observation.actual_total, observation.mean, alpha),
    0,
  );
}

/**
 * Maximum-likelihood alpha for Var(Y|mu)=mu+alpha*mu^2.  The exact Poisson
 * limit is compared separately, so the NB fit never claims overdispersion
 * when its likelihood does not exceed the floor comparator.
 */
export function fitNegativeBinomialAlpha(
  training: readonly DistributionBenchmarkObservation[],
): { alpha: number; status: string } {
  const poissonLikelihood = totalLogLikelihood(training, 0);
  const minimumLogAlpha = Math.log(1e-6);
  const maximumLogAlpha = Math.log(20);
  const gridSize = 96;
  let bestIndex = 0;
  let bestLogAlpha = minimumLogAlpha;
  let bestLikelihood = Number.NEGATIVE_INFINITY;
  for (let index = 0; index <= gridSize; index++) {
    const logAlpha = minimumLogAlpha + ((maximumLogAlpha - minimumLogAlpha) * index) / gridSize;
    const likelihood = totalLogLikelihood(training, Math.exp(logAlpha));
    if (likelihood > bestLikelihood) {
      bestLikelihood = likelihood;
      bestLogAlpha = logAlpha;
      bestIndex = index;
    }
  }
  // Golden-section refinement inside the best grid cell, still in log-alpha
  // space so small values receive adequate numerical resolution.
  const gridStep = (maximumLogAlpha - minimumLogAlpha) / gridSize;
  let left = Math.max(minimumLogAlpha, bestLogAlpha - gridStep);
  let right = Math.min(maximumLogAlpha, bestLogAlpha + gridStep);
  const golden = (Math.sqrt(5) - 1) / 2;
  let c = right - golden * (right - left);
  let d = left + golden * (right - left);
  for (let iteration = 0; iteration < 80; iteration++) {
    if (totalLogLikelihood(training, Math.exp(c)) > totalLogLikelihood(training, Math.exp(d))) {
      right = d;
      d = c;
      c = right - golden * (right - left);
    } else {
      left = c;
      c = d;
      d = left + golden * (right - left);
    }
  }
  const refinedLogAlpha = (left + right) / 2;
  const refinedAlpha = Math.exp(refinedLogAlpha);
  const refinedLikelihood = totalLogLikelihood(training, refinedAlpha);
  if (refinedLikelihood <= poissonLikelihood + 1e-8) {
    return { alpha: 0, status: "POISSON_FLOOR_SELECTED" };
  }
  const atUpperBound = bestIndex === gridSize || refinedLogAlpha >= maximumLogAlpha - 1e-4;
  return {
    alpha: round(refinedAlpha, 8),
    status: atUpperBound ? "NB_ALPHA_MLE_UPPER_BOUND_RESEARCH_ONLY" : "NB_ALPHA_MLE",
  };
}

function supportLimit(mean: number, variance: number, minimumSupport: number): number {
  const candidate = Math.ceil(mean + 20 * Math.sqrt(Math.max(variance, mean)) + 50);
  return Math.max(minimumSupport, candidate, 50);
}

function buildRecursiveDistribution(
  initialPmf: number,
  nextPmf: (previous: number, index: number) => number,
  mean: number,
  variance: number,
  minimumSupport: number,
): Distribution {
  const pmf: number[] = [initialPmf];
  const cdf: number[] = [initialPmf];
  const target = 1 - 1e-12;
  const limit = Math.max(supportLimit(mean, variance, minimumSupport), minimumSupport);
  for (let index = 1; index <= 50000; index++) {
    const probability = Math.max(0, nextPmf(pmf[index - 1]!, index));
    pmf.push(probability);
    cdf.push(Math.min(1, cdf[index - 1]! + probability));
    if (index >= limit && cdf[index]! >= target) break;
  }
  return { pmf, cdf };
}

export function buildPoissonDistribution(mean: number, minimumSupport: number): Distribution {
  return buildRecursiveDistribution(
    Math.exp(-mean),
    (previous, index) => previous * mean / index,
    mean,
    mean,
    minimumSupport,
  );
}

export function buildNegativeBinomialDistribution(mean: number, alpha: number, minimumSupport: number): Distribution {
  if (alpha <= 1e-7) return buildPoissonDistribution(mean, minimumSupport);
  const shape = 1 / alpha;
  const failureProbability = (alpha * mean) / (1 + alpha * mean);
  return buildRecursiveDistribution(
    Math.exp(-shape * Math.log1p(alpha * mean)),
    (previous, index) => previous * ((index - 1 + shape) / index) * failureProbability,
    mean,
    mean + alpha * mean * mean,
    minimumSupport,
  );
}

/**
 * The empirical comparator is a discrete residual CDF, not a fitted center.
 * For future mean μ, historical residual r maps to total k when
 * k - 1 - μ < r <= k - μ.  This preserves a proper integer-run PMF without
 * choosing an arbitrary rounding rule or leaking current-slate residuals.
 */
export function buildEmpiricalResidualDistribution(
  mean: number,
  residuals: readonly number[],
  minimumSupport: number,
): Distribution {
  const ordered = [...residuals].sort((left, right) => left - right);
  const maximumResidual = ordered[ordered.length - 1] ?? 0;
  const maximum = Math.max(minimumSupport, 0, Math.ceil(mean + maximumResidual));
  const pmf: number[] = [];
  const cdf: number[] = [];
  let priorCdf = 0;
  for (let total = 0; total <= maximum; total++) {
    const boundary = total - mean;
    let upper = 0;
    while (upper < ordered.length && ordered[upper]! <= boundary) upper++;
    const currentCdf = upper / ordered.length;
    pmf.push(Math.max(0, currentCdf - priorCdf));
    cdf.push(currentCdf);
    priorCdf = currentCdf;
  }
  return { pmf, cdf };
}

function pmfAt(distribution: Distribution, total: number): number {
  return total < 0 ? 0 : distribution.pmf[total] ?? 0;
}

function cdfAt(distribution: Distribution, total: number): number {
  if (total < 0) return 0;
  return distribution.cdf[total] ?? 1;
}

function quantile(distribution: Distribution, probability: number): number {
  const index = distribution.cdf.findIndex((value) => value >= probability);
  return index === -1 ? distribution.cdf.length - 1 : index;
}

function interval(distribution: Distribution, coverage: number, actual: number): Interval {
  const lowerTail = (1 - coverage) / 2;
  const low = quantile(distribution, lowerTail);
  const high = quantile(distribution, 1 - lowerTail);
  return { low, high, covered: actual >= low && actual <= high };
}

function crps(distribution: Distribution, actual: number): number {
  let score = 0;
  const maximum = Math.max(actual, distribution.cdf.length - 1);
  for (let total = 0; total <= maximum; total++) {
    const observedCdf = total >= actual ? 1 : 0;
    score += (cdfAt(distribution, total) - observedCdf) ** 2;
  }
  return round(score);
}

function thresholdStatus(threshold: number | null): string {
  if (threshold === null) return "NO_FROZEN_QUERIED_THRESHOLD";
  return Number.isInteger(threshold)
    ? "WHOLE_NUMBER_THRESHOLD_RESEARCH_ONLY"
    : "FROZEN_THRESHOLD_AVAILABLE";
}

function evaluateModel(
  distribution: Distribution,
  actual: number,
  threshold: number | null,
): ModelEvaluation {
  const probability = threshold === null ? null : round(1 - cdfAt(distribution, Math.floor(threshold)));
  const realizedOver = threshold === null ? null : actual > threshold ? 1 : 0;
  return {
    crps: crps(distribution, actual),
    log_loss: round(-Math.log(Math.max(pmfAt(distribution, actual), 1e-15))),
    mid_pit: round(cdfAt(distribution, actual - 1) + pmfAt(distribution, actual) / 2),
    over_probability: probability,
    brier: probability === null || realizedOver === null ? null : round((probability - realizedOver) ** 2),
    interval_50: interval(distribution, 0.5, actual),
    interval_80: interval(distribution, 0.8, actual),
    interval_90: interval(distribution, 0.9, actual),
  };
}

/**
 * Expanding walk-forward evaluation. All games sharing a Date use the same
 * strictly earlier training set; same-slate outcomes are appended only after
 * every game on that slate has been scored.
 */
export function evaluateDistributionBenchmarkWalkForward(
  observations: readonly DistributionBenchmarkObservation[],
): BenchmarkEvaluation[] {
  const byDate = new Map<string, DistributionBenchmarkObservation[]>();
  for (const observation of observations) {
    const group = byDate.get(observation.date) ?? [];
    group.push(observation);
    byDate.set(observation.date, group);
  }
  const training: DistributionBenchmarkObservation[] = [];
  const evaluations: BenchmarkEvaluation[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const slate = [...(byDate.get(date) ?? [])].sort((left, right) => left.game_id.localeCompare(right.game_id));
    const trainingThroughDate = training.length === 0 ? "" : training[training.length - 1]!.date;
    if (training.length < MIN_PRIOR_SETTLED_GAMES) {
      evaluations.push(...slate.map((observation) => ({
        observation,
        training_through_date: trainingThroughDate,
        prior_settled_games: training.length,
        status: "INSUFFICIENT_PRIOR_SETTLED_GAMES" as const,
        alpha: null,
        alpha_fit_status: "INSUFFICIENT_PRIOR_SETTLED_GAMES",
        threshold_status: thresholdStatus(observation.queried_threshold),
        nb: null,
        poisson: null,
        empirical: null,
      })));
    } else {
      const alphaFit = fitNegativeBinomialAlpha(training);
      const residuals = training.map((observation) => observation.actual_total - observation.mean);
      for (const observation of slate) {
        const minimumSupport = observation.actual_total;
        const nb = buildNegativeBinomialDistribution(observation.mean, alphaFit.alpha, minimumSupport);
        const poisson = buildPoissonDistribution(observation.mean, minimumSupport);
        const empirical = buildEmpiricalResidualDistribution(observation.mean, residuals, minimumSupport);
        evaluations.push({
          observation,
          training_through_date: trainingThroughDate,
          prior_settled_games: training.length,
          status: "WALK_FORWARD_ELIGIBLE",
          alpha: alphaFit.alpha,
          alpha_fit_status: alphaFit.status,
          threshold_status: thresholdStatus(observation.queried_threshold),
          nb: evaluateModel(nb, observation.actual_total, observation.queried_threshold),
          poisson: evaluateModel(poisson, observation.actual_total, observation.queried_threshold),
          empirical: evaluateModel(empirical, observation.actual_total, observation.queried_threshold),
        });
      }
    }
    training.push(...slate);
  }
  return evaluations;
}

function modelValues(model: ModelEvaluation | null): unknown[] {
  if (!model) return Array(14).fill("");
  return [
    model.crps,
    model.log_loss,
    model.mid_pit,
    model.over_probability ?? "",
    model.brier ?? "",
    model.interval_50.low,
    model.interval_50.high,
    model.interval_50.covered ? "TRUE" : "FALSE",
    model.interval_80.low,
    model.interval_80.high,
    model.interval_80.covered ? "TRUE" : "FALSE",
    model.interval_90.low,
    model.interval_90.high,
    model.interval_90.covered ? "TRUE" : "FALSE",
  ];
}

export function buildDistributionBenchmarkRows(evaluations: readonly BenchmarkEvaluation[]): unknown[][] {
  return evaluations.map((evaluation) => {
    const { observation } = evaluation;
    return [
      observation.date,
      observation.game_id,
      observation.snapshot_ts,
      SHADOW_DISTRIBUTION_BENCHMARK_VERSION,
      observation.date,
      evaluation.training_through_date,
      evaluation.prior_settled_games,
      evaluation.status,
      observation.mean,
      observation.actual_total,
      evaluation.alpha ?? "",
      evaluation.alpha_fit_status,
      observation.queried_threshold ?? "",
      observation.threshold_source,
      evaluation.threshold_status,
      ...modelValues(evaluation.nb),
      ...modelValues(evaluation.poisson),
      ...modelValues(evaluation.empirical),
      "FROZEN_PRICE_BLIND_WALK_FORWARD_RESEARCH_ONLY",
      observation.settlement_ts,
    ];
  });
}

function at(row: unknown[], name: (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number]): unknown {
  return row[DISTRIBUTION_BENCHMARK_HEADERS.indexOf(name)];
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

type Comparator = "NB" | "POISSON" | "EMPIRICAL_RESIDUAL";

const COMPARATORS: Array<{ label: Comparator; prefix: "NB" | "Poisson" | "Empirical_Residual" }> = [
  { label: "NB", prefix: "NB" },
  { label: "POISSON", prefix: "Poisson" },
  { label: "EMPIRICAL_RESIDUAL", prefix: "Empirical_Residual" },
];

function scoredRows(rows: unknown[][]): unknown[][] {
  return rows.filter((row) => at(row, "Distribution_Status") === "WALK_FORWARD_ELIGIBLE");
}

function numericColumn(rows: unknown[][], name: (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number]): number[] {
  return rows.map((row) => numeric(at(row, name))).filter((candidate): candidate is number => candidate !== null);
}

function coverageRow(
  rows: unknown[][],
  comparator: { label: Comparator; prefix: "NB" | "Poisson" | "Empirical_Residual" },
  coverage: 50 | 80 | 90,
  replayTs: string,
): unknown[] {
  const covered = rows
    .map((row) => text(at(row, `${comparator.prefix}_${coverage}_Covered` as (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number])))
    .filter((value) => value === "TRUE" || value === "FALSE");
  return [
    "ALL_WALK_FORWARD",
    comparator.label,
    `INTERVAL_COVERAGE_${coverage}`,
    "",
    covered.length,
    "",
    "",
    covered.length === 0 ? "" : round(covered.filter((value) => value === "TRUE").length / covered.length),
    coverage / 100,
    mean(numericColumn(rows, `${comparator.prefix}_Mid_PIT` as (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number])) ?? "",
    "RESEARCH_ONLY_NO_PROMOTION",
    replayTs,
  ];
}

function scoreSummaryRow(
  population: string,
  comparator: { label: Comparator; prefix: "NB" | "Poisson" | "Empirical_Residual" },
  metric: "CRPS" | "LOG_LOSS" | "BRIER_AT_QUERIED_THRESHOLD" | "MID_PIT",
  threshold: number | "",
  rows: unknown[][],
  replayTs: string,
): unknown[] {
  const suffix = metric === "CRPS"
    ? "CRPS"
    : metric === "LOG_LOSS"
      ? "Log_Loss"
      : metric === "BRIER_AT_QUERIED_THRESHOLD"
        ? "Brier_At_Queried_Threshold"
        : "Mid_PIT";
  const values = numericColumn(rows, `${comparator.prefix}_${suffix}` as (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number]);
  return [
    population,
    comparator.label,
    metric,
    threshold,
    values.length,
    mean(values) ?? "",
    median(values) ?? "",
    "",
    "",
    mean(numericColumn(rows, `${comparator.prefix}_Mid_PIT` as (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number])) ?? "",
    "RESEARCH_ONLY_NO_PROMOTION",
    replayTs,
  ];
}

export function buildDistributionBenchmarkSummary(rows: unknown[][], replayTs: string): unknown[][] {
  const eligible = scoredRows(rows);
  const summary: unknown[][] = [];
  for (const comparator of COMPARATORS) {
    summary.push(scoreSummaryRow("ALL_WALK_FORWARD", comparator, "CRPS", "", eligible, replayTs));
    summary.push(scoreSummaryRow("ALL_WALK_FORWARD", comparator, "LOG_LOSS", "", eligible, replayTs));
    summary.push(scoreSummaryRow("ALL_WALK_FORWARD", comparator, "MID_PIT", "", eligible, replayTs));
    summary.push(coverageRow(eligible, comparator, 50, replayTs));
    summary.push(coverageRow(eligible, comparator, 80, replayTs));
    summary.push(coverageRow(eligible, comparator, 90, replayTs));
  }
  const thresholds = [...new Set(
    eligible
      .filter((row) => at(row, "Threshold_Status") !== "NO_FROZEN_QUERIED_THRESHOLD")
      .map((row) => numeric(at(row, "Frozen_Queried_Threshold")))
      .filter((candidate): candidate is number => candidate !== null),
  )].sort((left, right) => left - right);
  for (const threshold of thresholds) {
    const thresholdRows = eligible.filter((row) => numeric(at(row, "Frozen_Queried_Threshold")) === threshold);
    for (const comparator of COMPARATORS) {
      summary.push(scoreSummaryRow(
        "QUERIED_THRESHOLD_WALK_FORWARD",
        comparator,
        "BRIER_AT_QUERIED_THRESHOLD",
        threshold,
        thresholdRows,
        replayTs,
      ));
    }
  }
  return summary;
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Exact two-sided sign test, excluding ties; report only, never a gate. */
export function pairedSignTestTwoSidedP(aBetter: number, bBetter: number): number | null {
  const n = aBetter + bBetter;
  if (n === 0) return null;
  const low = Math.min(aBetter, bBetter);
  let cumulative = 0;
  for (let index = 0; index <= low; index++) cumulative += Math.exp(logChoose(n, index) - n * Math.log(2));
  return round(Math.min(1, 2 * cumulative));
}

function metricColumn(prefix: "NB" | "Poisson" | "Empirical_Residual", metric: "CRPS" | "LOG_LOSS" | "BRIER_AT_QUERIED_THRESHOLD"):
  (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number] {
  const suffix = metric === "CRPS"
    ? "CRPS"
    : metric === "LOG_LOSS"
      ? "Log_Loss"
      : "Brier_At_Queried_Threshold";
  return `${prefix}_${suffix}` as (typeof DISTRIBUTION_BENCHMARK_HEADERS)[number];
}

function pairRow(
  population: string,
  metric: "CRPS" | "LOG_LOSS" | "BRIER_AT_QUERIED_THRESHOLD",
  threshold: number | "",
  modelA: { label: Comparator; prefix: "NB" | "Poisson" | "Empirical_Residual" },
  modelB: { label: Comparator; prefix: "NB" | "Poisson" | "Empirical_Residual" },
  rows: unknown[][],
  replayTs: string,
): unknown[] {
  const values = rows.flatMap((row) => {
    const a = numeric(at(row, metricColumn(modelA.prefix, metric)));
    const b = numeric(at(row, metricColumn(modelB.prefix, metric)));
    return a === null || b === null ? [] : [{ a, b }];
  });
  const deltas = values.map(({ a, b }) => a - b);
  const epsilon = 1e-12;
  const aBetter = deltas.filter((delta) => delta < -epsilon).length;
  const bBetter = deltas.filter((delta) => delta > epsilon).length;
  const ties = deltas.length - aBetter - bBetter;
  return [
    population,
    metric,
    threshold,
    modelA.label,
    modelB.label,
    values.length,
    aBetter + bBetter,
    aBetter,
    bBetter,
    ties,
    mean(deltas) ?? "",
    median(deltas) ?? "",
    pairedSignTestTwoSidedP(aBetter, bBetter) ?? "",
    "PAIRED_SIGN_TEST_RESEARCH_ONLY_NO_PROMOTION",
    replayTs,
  ];
}

export function buildDistributionBenchmarkPairs(rows: unknown[][], replayTs: string): unknown[][] {
  const eligible = scoredRows(rows);
  const pairs = [
    [COMPARATORS[0]!, COMPARATORS[1]!],
    [COMPARATORS[0]!, COMPARATORS[2]!],
    [COMPARATORS[1]!, COMPARATORS[2]!],
  ] as const;
  const output: unknown[][] = [];
  for (const metric of ["CRPS", "LOG_LOSS"] as const) {
    for (const [modelA, modelB] of pairs) output.push(pairRow("ALL_WALK_FORWARD", metric, "", modelA, modelB, eligible, replayTs));
  }
  const thresholds = [...new Set(
    eligible.map((row) => numeric(at(row, "Frozen_Queried_Threshold"))).filter((candidate): candidate is number => candidate !== null),
  )].sort((left, right) => left - right);
  for (const threshold of thresholds) {
    const thresholdRows = eligible.filter((row) => numeric(at(row, "Frozen_Queried_Threshold")) === threshold);
    for (const [modelA, modelB] of pairs) {
      output.push(pairRow("QUERIED_THRESHOLD_WALK_FORWARD", "BRIER_AT_QUERIED_THRESHOLD", threshold, modelA, modelB, thresholdRows, replayTs));
    }
  }
  return output;
}

async function ensureSheets(
  workbookId: string,
  sheets: Array<{ sheet: string; column_count: number }>,
): Promise<void> {
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
    warnings.push(`MISSING_DISTRIBUTION_BENCHMARK_SOURCE: ${range}`);
    return [];
  }
}

export async function runDistributionBenchmark(
  options: { workbookId?: string } = {},
): Promise<DistributionBenchmarkResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTimestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetRows, truthRows] = await Promise.all([
      readOptionalSheet(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`, warnings),
      readOptionalSheet(workbookId, "GAME_TRUTH_REPLAY_V1!A1:AZ10000", warnings),
    ]);
    const packets = parseFrozenDistributionBenchmarkPackets(packetRows);
    const truth = parseSettledDistributionBenchmarkTruth(truthRows);
    const joined = joinDistributionBenchmarkObservations(packets, truth);
    const evaluations = evaluateDistributionBenchmarkWalkForward(joined.observations);
    const rows = buildDistributionBenchmarkRows(evaluations);
    const summaryRows = buildDistributionBenchmarkSummary(rows, replayTimestamp);
    const pairRows = buildDistributionBenchmarkPairs(rows, replayTimestamp);
    if (joined.snapshot_mismatches > 0) {
      warnings.push(`FROZEN_PACKET_SNAPSHOT_MISMATCH: ${joined.snapshot_mismatches} distribution benchmark joins were excluded`);
    }
    await ensureSheets(workbookId, [
      { sheet: SHADOW_DISTRIBUTION_BENCHMARK_SHEET, column_count: DISTRIBUTION_BENCHMARK_HEADERS.length },
      { sheet: SHADOW_DISTRIBUTION_BENCHMARK_SUMMARY_SHEET, column_count: DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS.length },
      { sheet: SHADOW_DISTRIBUTION_BENCHMARK_PAIRS_SHEET, column_count: DISTRIBUTION_BENCHMARK_PAIR_HEADERS.length },
    ]);
    await Promise.all([
      writeRange(workbookId, `${SHADOW_DISTRIBUTION_BENCHMARK_SHEET}!A1`, [Array.from(DISTRIBUTION_BENCHMARK_HEADERS), ...rows]),
      writeRange(workbookId, `${SHADOW_DISTRIBUTION_BENCHMARK_SUMMARY_SHEET}!A1`, [Array.from(DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS), ...summaryRows]),
      writeRange(workbookId, `${SHADOW_DISTRIBUTION_BENCHMARK_PAIRS_SHEET}!A1`, [Array.from(DISTRIBUTION_BENCHMARK_PAIR_HEADERS), ...pairRows]),
    ]);
    const eligibleGames = evaluations.filter((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE").length;
    logger.info(
      { frozen_packets_seen: packets.size, settled_observations_seen: joined.observations.length, eligible_games: eligibleGames },
      "MODULE_28: shadow distribution benchmark written (walk-forward, research-only)",
    );
    return {
      status: "success",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: packets.size,
      settled_observations_seen: joined.observations.length,
      eligible_games: eligibleGames,
      benchmark_rows_written: rows.length,
      summary_rows_written: summaryRows.length,
      pair_rows_written: pairRows.length,
      snapshot_mismatches: joined.snapshot_mismatches,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_28: shadow distribution benchmark failed");
    return {
      status: "failure",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: 0,
      settled_observations_seen: 0,
      eligible_games: 0,
      benchmark_rows_written: 0,
      summary_rows_written: 0,
      pair_rows_written: 0,
      snapshot_mismatches: 0,
      warnings,
      errors,
    };
  }
}
