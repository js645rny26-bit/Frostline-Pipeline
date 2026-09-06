import assert from "node:assert/strict";
import test from "node:test";

import {
  andersonDarlingUniformDiagnostic,
  buildGameTruthDistributionCorpRows,
  buildGameTruthDistributionLineRows,
  buildGameTruthDistributionPairs,
  buildGameTruthDistributionRows,
  buildGameTruthDistributionSummary,
  buildGameTruthSlateDiagnostics,
  buildHurdleNegativeBinomialDistribution,
  buildMeanParameterizedCOMPoissonDistribution,
  evaluateGameTruthDistributionWalkForward,
  GAME_TRUTH_DISTRIBUTION_HEADERS,
  GAME_TRUTH_DISTRIBUTION_CORP_HEADERS,
  GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_HEADERS,
  GAME_TRUTH_DISTRIBUTION_LINES_HEADERS,
  GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS,
  gameTruthDistributionFeatureGovernanceRows,
  MIN_PRIOR_SETTLED_GAMES_V2,
  nonrandomizedCountPit,
  pairedSlateBlockBootstrapCi,
  parseFrozenAllocationOutcomes,
  poolAdjacentViolators,
  STANDARD_TOTAL_LINES,
  thresholdWeightedCrpsPostedRegion,
  validatePmfAndLinePortability,
} from "./module29_gameTruthDistributionResearch.js";
import type { DistributionBenchmarkObservation } from "./module28_distributionBenchmark.js";
import { buildPoissonDistribution } from "./module28_distributionBenchmark.js";
import { WORKBOOK_ROADMAP } from "../workbook/workbookRoadmap.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";
import { ALLOCATION_SETTLEMENT_HEADERS } from "./module24_postgameDiagnostics.js";

function observation(
  date: string,
  gameId: string,
  actualTotal: number,
  mean = 8,
): DistributionBenchmarkObservation {
  return {
    date,
    game_id: gameId,
    snapshot_ts: `${date}T18:00:00.000Z`,
    mean,
    actual_total: actualTotal,
    queried_threshold: null,
    threshold_source: "NO_MARKET_USED",
    settlement_ts: `${date}T23:30:00.000Z`,
  };
}

function observationsWithTraining(): DistributionBenchmarkObservation[] {
  return [
    ...Array.from({ length: MIN_PRIOR_SETTLED_GAMES_V2 }, (_, index) =>
      observation("2026-08-01", `20260801_AAA_${String(index).padStart(3, "0")}`, index % 2 === 0 ? 4 : 13)),
    observation("2026-08-02", "20260802_AAA_BBB", 11),
    observation("2026-08-02", "20260802_CCC_DDD", 6),
  ];
}

function distributionMean(distribution: { pmf: number[] }): number {
  return distribution.pmf.reduce((sum, probability, total) => sum + total * probability, 0);
}

test("mean-parameterized hurdle NB preserves frozen center even with an observed zero rate", () => {
  const distribution = buildHurdleNegativeBinomialDistribution(8, 0.18, 0.1, 25);
  assert.ok(Math.abs(distributionMean(distribution) - 8) < 0.0001);
  assert.ok(Math.abs(distribution.pmf[0]! - 0.1) < 1e-10);
});

test("mean-parameterized CMP retains its requested location without using a market line", () => {
  const model = buildMeanParameterizedCOMPoissonDistribution(8.25, 0.7, 30);
  assert.ok(Math.abs(distributionMean(model.distribution) - 8.25) < 0.0001);
  assert.ok(model.lambda > 0);
});

test("V2 remains expanding-window: all same-slate games use only earlier settled games", () => {
  const evaluations = evaluateGameTruthDistributionWalkForward(observationsWithTraining());
  const early = evaluations.filter((evaluation) => evaluation.observation.date === "2026-08-01");
  const scored = evaluations.filter((evaluation) => evaluation.observation.date === "2026-08-02");
  assert.ok(early.every((evaluation) => evaluation.status === "INSUFFICIENT_PRIOR_SETTLED_GAMES"));
  assert.equal(scored.length, 2);
  assert.ok(scored.every((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE"));
  assert.ok(scored.every((evaluation) => evaluation.prior_settled_games === MIN_PRIOR_SETTLED_GAMES_V2));
  assert.ok(scored.every((evaluation) => evaluation.training_through_date === "2026-08-01"));
  assert.ok(scored.every((evaluation) => evaluation.models.length === 5));
  const rows = buildGameTruthDistributionRows(evaluations);
  assert.equal(rows.filter((row) => row[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Research_Status")] === "INSUFFICIENT_PRIOR_SETTLED_GAMES").length, MIN_PRIOR_SETTLED_GAMES_V2);
  assert.ok(rows.some((row) => row[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Model")] === "NO_COMPARATOR"));
});

test("zero-total-free training leaves the hurdle comparator explicitly zero-rate unsupported rather than inventing zero evidence", () => {
  const evaluation = evaluateGameTruthDistributionWalkForward(observationsWithTraining())
    .find((candidate) => candidate.status === "WALK_FORWARD_ELIGIBLE");
  assert.equal(evaluation?.zero_total_rate, 0);
  const hurdle = evaluation?.models.find((model) => model.comparator === "HURDLE_NB");
  assert.equal(hurdle?.shape_parameter_status, "HURDLE_NB_ZERO_RATE_ZERO_RESEARCH_ONLY");
});

test("all standard-line probabilities come from one PMF and are monotone in the line", () => {
  const evaluation = evaluateGameTruthDistributionWalkForward(observationsWithTraining())
    .find((candidate) => candidate.status === "WALK_FORWARD_ELIGIBLE");
  assert.ok(evaluation);
  const lines = buildGameTruthDistributionLineRows([evaluation!]);
  const nbRows = lines.filter((row) => row[GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.indexOf("Model")] === "NB");
  assert.equal(nbRows.length, STANDARD_TOTAL_LINES.length);
  const probabilities = nbRows.map((row) => Number(row[GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.indexOf("Over_Probability")]));
  for (let index = 1; index < probabilities.length; index++) assert.ok(probabilities[index - 1]! >= probabilities[index]!);
  assert.ok(nbRows.every((row) => row[GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.indexOf("Line_Probability_Reconciliation_Status")] === "VALID_CDF_RECONCILIATION"));
  const line75 = nbRows.find((row) => Number(row[GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.indexOf("Standard_Total_Line")]) === 7.5);
  assert.equal(line75?.[GAME_TRUTH_DISTRIBUTION_LINES_HEADERS.indexOf("Line_Cutoff_Integer")], 7);
});

test("Czado-Gneiting-Held non-randomized count PIT retains its CDF-jump interval", () => {
  const distribution = { pmf: [0.2, 0.3, 0.5], cdf: [0.2, 0.5, 1] };
  const pit = nonrandomizedCountPit(distribution, 1);
  assert.deepEqual(pit, { pit: 0.35, interval_low: 0.2, interval_high: 0.5 });
  assert.equal(andersonDarlingUniformDiagnostic([0.2]), null);
  assert.ok(Number.isFinite(andersonDarlingUniformDiagnostic([0.2, 0.5, 0.8])!));
});

test("distribution rows expose count-correct PIT, posted-region twCRPS, and directional interval escapes", () => {
  const evaluations = evaluateGameTruthDistributionWalkForward(observationsWithTraining());
  const rows = buildGameTruthDistributionRows(evaluations);
  const lineRows = buildGameTruthDistributionLineRows(evaluations);
  const firstEligible = rows.find((row) => row[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Research_Status")] === "WALK_FORWARD_ELIGIBLE");
  assert.ok(firstEligible);
  assert.notEqual(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Nonrandomized_Count_PIT")], "");
  assert.notEqual(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Nonrandomized_PIT_Interval_Low")], "");
  assert.notEqual(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Threshold_Weighted_CRPS_6_5_TO_11_5")], "");
  assert.equal(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("PMF_Integrity_Status")], "VALID_PMF");
  assert.notEqual(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Deterministic_Randomized_PIT")], "");
  assert.match(String(firstEligible?.[GAME_TRUTH_DISTRIBUTION_HEADERS.indexOf("Interval_90_Escape_Side")]), /^(LOW|HIGH|INSIDE)$/);
  const summary = buildGameTruthDistributionSummary(rows, lineRows, "2026-08-03T03:00:00.000Z");
  const pairs = buildGameTruthDistributionPairs(rows, "2026-08-03T03:00:00.000Z");
  assert.ok(summary.some((row) => row[2] === "NONRANDOMIZED_COUNT_PIT_BIN"));
  assert.ok(summary.some((row) => row[2] === "RANDOMIZED_PIT_BIN_SECONDARY"));
  assert.ok(summary.some((row) => row[2] === "ANDERSON_DARLING_UNIFORM_DIAGNOSTIC"));
  assert.ok(summary.some((row) => row[2] === "INTERVAL_COVERAGE_90"));
  assert.ok(summary.some((row) => row[2] === "PREDECLARED_DECISION"));
  assert.ok(pairs.some((row) => row[1] === "CRPS"));
  assert.equal(pairs[0]?.length, GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS.length);
});

test("threshold-weighted CRPS uses coherent half-run CDF cutoffs and PMF integrity is deterministic", () => {
  const distribution = buildPoissonDistribution(8, 30);
  assert.ok(thresholdWeightedCrpsPostedRegion(distribution, 9) >= 0);
  assert.deepEqual(validatePmfAndLinePortability(distribution), {
    pmf_integrity_status: "VALID_PMF",
    line_portability_status: "VALID_COHERENT_LINES",
  });
  assert.equal(validatePmfAndLinePortability({ pmf: [0.5, 0.4], cdf: [0.5, 0.9] }).pmf_integrity_status, "INVALID_PMF");
});

test("paired block bootstrap is deterministic and resamples complete slate dates", () => {
  const records = [
    { date: "2026-08-01", delta: -0.4 },
    { date: "2026-08-01", delta: 0.1 },
    { date: "2026-08-02", delta: -0.2 },
  ];
  const first = pairedSlateBlockBootstrapCi(records, "fixture");
  const second = pairedSlateBlockBootstrapCi(records, "fixture");
  assert.deepEqual(first, second);
  assert.equal(first.block_count, 2);
  assert.ok(first.low !== null && first.high !== null && first.low <= first.high);
});

test("CORP uses PAV rather than arbitrary fixed bins and governance stays non-operational", () => {
  const pav = poolAdjacentViolators([
    { date: "2026-08-01", probability: 0.2, outcome: 1 },
    { date: "2026-08-02", probability: 0.8, outcome: 0 },
  ]);
  assert.equal(pav.length, 1);
  const evaluations = evaluateGameTruthDistributionWalkForward(observationsWithTraining());
  const corp = buildGameTruthDistributionCorpRows(buildGameTruthDistributionLineRows(evaluations), "2026-08-03T03:00:00.000Z");
  assert.ok(corp.some((row) => row.length === GAME_TRUTH_DISTRIBUTION_CORP_HEADERS.length));
  const governance = gameTruthDistributionFeatureGovernanceRows();
  assert.ok(governance.every((row) => row.length === GAME_TRUTH_DISTRIBUTION_FEATURE_GOVERNANCE_HEADERS.length));
  assert.ok(governance.some((row) => row[0] === "TRAFFIC_WITHOUT_DAMAGE_HISTORICAL_GAP" && row[6] === "REJECT"));
});

test("slate diagnostics separate aggregate error from within-slate game ranking", () => {
  const allocationRow = Array(ALLOCATION_SETTLEMENT_HEADERS.length).fill("");
  const set = (name: string, value: unknown) => { allocationRow[ALLOCATION_SETTLEMENT_HEADERS.indexOf(name as (typeof ALLOCATION_SETTLEMENT_HEADERS)[number])] = value; };
  set("Date", "2026-09-04");
  set("Game_ID", "A");
  set("Frozen_Packet_Snapshot_TS", "2026-09-04T18:00:00.000Z");
  set("Allocation_MAE", 3.25);
  set("Projected_Higher_Scoring_Team", "AAA");
  set("Actual_Higher_Scoring_Team", "BBB");
  set("Allocation_Sign_Reversal", "TRUE");
  set("Diagnostic_Status", "FROZEN_PACKET_VERIFIED");
  const allocation = parseFrozenAllocationOutcomes([Array.from(ALLOCATION_SETTLEMENT_HEADERS), allocationRow]);
  const diagnostics = buildGameTruthSlateDiagnostics([
    observation("2026-09-04", "A", 10, 8),
    observation("2026-09-04", "B", 6, 8),
  ], "2026-09-05T03:00:00.000Z", allocation);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.[4], 0);
  assert.equal(diagnostics[0]?.[6], 2);
  assert.equal(diagnostics[0]?.[15], 1);
  assert.equal(diagnostics[0]?.[16], 1);
  assert.equal(diagnostics[0]?.[17], 0);
  assert.equal(diagnostics[0]?.[18], 1);
});

test("Module 29 workbook surfaces are schema-documented research-only tabs", () => {
  const columns = (sheet: string) => WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map((column) => column.name);
  assert.deepEqual(columns("GAME_TRUTH_DISTRIBUTION_V2"), GAME_TRUTH_DISTRIBUTION_HEADERS);
  assert.deepEqual(columns("GAME_TRUTH_DIST_LINES_V2"), GAME_TRUTH_DISTRIBUTION_LINES_HEADERS);
  assert.deepEqual(columns("GAME_TRUTH_DIST_PAIRS_V2"), GAME_TRUTH_DISTRIBUTION_PAIRS_HEADERS);
  for (const sheet of ["GAME_TRUTH_DISTRIBUTION_V2", "GAME_TRUTH_DIST_LINES_V2", "GAME_TRUTH_DIST_SUMMARY_V2", "GAME_TRUTH_DIST_PAIRS_V2", "GAME_TRUTH_DIST_CORP_V2", "GAME_TRUTH_DIST_FEATURE_GOV_V2", "GAME_TRUTH_SLATE_DIAG_V2"]) {
    assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === sheet));
  }
});

test("market-query changes cannot alter any direct-total distribution research output", () => {
  const baseline = observationsWithTraining();
  const changedQuery = baseline.map((row) => row.game_id.endsWith("BBB") ? { ...row, queried_threshold: 11.5 } : row);
  const first = evaluateGameTruthDistributionWalkForward(baseline).find((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE");
  const second = evaluateGameTruthDistributionWalkForward(changedQuery).find((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE");
  assert.ok(first && second);
  assert.deepEqual(buildGameTruthDistributionRows([first!]), buildGameTruthDistributionRows([second!]));
  assert.deepEqual(buildGameTruthDistributionLineRows([first!]), buildGameTruthDistributionLineRows([second!]));
});
