import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTRIBUTION_BENCHMARK_HEADERS,
  DISTRIBUTION_BENCHMARK_PAIR_HEADERS,
  DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS,
  MIN_PRIOR_SETTLED_GAMES,
  buildDistributionBenchmarkPairs,
  buildDistributionBenchmarkRows,
  buildDistributionBenchmarkSummary,
  evaluateDistributionBenchmarkWalkForward,
  fitNegativeBinomialAlpha,
  joinDistributionBenchmarkObservations,
  pairedSignTestTwoSidedP,
  parseFrozenDistributionBenchmarkPackets,
  parseSettledDistributionBenchmarkTruth,
} from "./module28_distributionBenchmark.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { GAME_TRUTH_REPLAY_HEADERS } from "./module24_postgameDiagnostics.js";
import { WORKBOOK_ROADMAP } from "../workbook/workbookRoadmap.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

function setByHeader(row: unknown[], header: readonly string[], name: string, value: unknown): void {
  const index = header.indexOf(name);
  assert.notEqual(index, -1, `missing fixture header: ${name}`);
  row[index] = value;
}

function packetRow(
  date: string,
  gameId: string,
  snapshotTs: string,
  overrides: Record<string, unknown> = {},
): unknown[] {
  const row = Array(PREGAME_PACKET_HISTORY_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: date,
    Game_ID: gameId,
    Scheduled_First_Pitch: `${date}T23:30:00.000Z`,
    Packet_Status: "FROZEN_PREGAME",
    Packet_Snapshot_TS: snapshotTs,
    Base_Projection: 8,
    Primary_Grade_Market_Line: 7.5,
    Primary_Grade_Market_Source: "REFERENCE_MARKET",
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) setByHeader(row, PREGAME_PACKET_HISTORY_HEADERS, name, value);
  return row;
}

function truthRow(
  date: string,
  gameId: string,
  snapshotTs: string,
  actualTotal: number,
  overrides: Record<string, unknown> = {},
): unknown[] {
  const row = Array(GAME_TRUTH_REPLAY_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: date,
    Game_ID: gameId,
    Frozen_Packet_Snapshot_TS: snapshotTs,
    Actual_Total: actualTotal,
    Replay_Status: "FROZEN_PACKET_AND_FINAL_VERIFIED",
    Settlement_TS: `${date}T23:45:00.000Z`,
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) setByHeader(row, GAME_TRUTH_REPLAY_HEADERS, name, value);
  return row;
}

function observationsWithTraining(): ReturnType<typeof joinDistributionBenchmarkObservations>["observations"] {
  const packetRows: unknown[][] = [Array.from(PREGAME_PACKET_HISTORY_HEADERS)];
  const truthRows: unknown[][] = [Array.from(GAME_TRUTH_REPLAY_HEADERS)];
  for (let index = 0; index < MIN_PRIOR_SETTLED_GAMES; index++) {
    const gameId = `20260801_AAA_${String(index).padStart(3, "0")}`;
    const snapshotTs = `2026-08-01T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
    packetRows.push(packetRow("2026-08-01", gameId, snapshotTs));
    truthRows.push(truthRow("2026-08-01", gameId, snapshotTs, index % 2 === 0 ? 6 : 10));
  }
  for (const suffix of ["A", "B"]) {
    const gameId = `20260802_AAA_${suffix}`;
    const snapshotTs = `2026-08-02T17:00:0${suffix === "A" ? "0" : "1"}.000Z`;
    packetRows.push(packetRow("2026-08-02", gameId, snapshotTs));
    truthRows.push(truthRow("2026-08-02", gameId, snapshotTs, suffix === "A" ? 9 : 7));
  }
  return joinDistributionBenchmarkObservations(
    parseFrozenDistributionBenchmarkPackets(packetRows),
    parseSettledDistributionBenchmarkTruth(truthRows),
  ).observations;
}

test("distribution benchmark uses only matching frozen pre-first-pitch packet truth", () => {
  const date = "2026-08-01";
  const packets = parseFrozenDistributionBenchmarkPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow(date, "20260801_AAA_BBB", "2026-08-01T20:00:00.000Z"),
    packetRow(date, "20260801_OPEN", "2026-08-01T20:00:00.000Z", { Packet_Status: "OPEN_PROSPECTIVE" }),
    packetRow(date, "20260801_LATE", "2026-08-01T23:30:00.000Z"),
  ]);
  const truth = parseSettledDistributionBenchmarkTruth([
    Array.from(GAME_TRUTH_REPLAY_HEADERS),
    truthRow(date, "20260801_AAA_BBB", "2026-08-01T20:00:00.000Z", 9),
    truthRow(date, "20260801_MISMATCH", "2026-08-01T20:01:00.000Z", 9),
  ]);
  const joined = joinDistributionBenchmarkObservations(packets, truth);
  assert.equal(packets.size, 1);
  assert.equal(joined.observations.length, 1);
  assert.equal(joined.snapshot_mismatches, 0);
  assert.equal(joined.observations[0]?.mean, 8);
});

test("walk-forward distribution benchmark requires 100 earlier settled games and never trains within the same slate", () => {
  const evaluations = evaluateDistributionBenchmarkWalkForward(observationsWithTraining());
  const early = evaluations.filter((evaluation) => evaluation.observation.date === "2026-08-01");
  const nextSlate = evaluations.filter((evaluation) => evaluation.observation.date === "2026-08-02");
  assert.equal(early.length, MIN_PRIOR_SETTLED_GAMES);
  assert.ok(early.every((evaluation) => evaluation.status === "INSUFFICIENT_PRIOR_SETTLED_GAMES"));
  assert.equal(nextSlate.length, 2);
  assert.ok(nextSlate.every((evaluation) => evaluation.status === "WALK_FORWARD_ELIGIBLE"));
  assert.ok(nextSlate.every((evaluation) => evaluation.prior_settled_games === MIN_PRIOR_SETTLED_GAMES));
  assert.ok(nextSlate.every((evaluation) => evaluation.training_through_date === "2026-08-01"));
});

test("negative-binomial dispersion is MLE-fit from earlier residual evidence and can exceed the Poisson floor", () => {
  const training = Array.from({ length: 120 }, (_, index) => ({
    date: "2026-08-01",
    game_id: `G${index}`,
    snapshot_ts: "2026-08-01T17:00:00.000Z",
    mean: 8,
    actual_total: index % 2 === 0 ? 1 : 18,
    queried_threshold: null,
    threshold_source: "",
    settlement_ts: "2026-08-02T03:00:00.000Z",
  }));
  const fit = fitNegativeBinomialAlpha(training);
  assert.ok(fit.alpha > 0.01);
  assert.match(fit.status, /^NB_ALPHA_MLE/);
});

test("changing a frozen market query does not change price-blind alpha, CRPS, PIT, or interval coverage", () => {
  const baseline = observationsWithTraining();
  const changedQuery = baseline.map((observation) => observation.game_id.endsWith("_A")
    ? { ...observation, queried_threshold: 10.5 }
    : observation);
  const baselineEvaluation = evaluateDistributionBenchmarkWalkForward(baseline).find((evaluation) => evaluation.observation.game_id.endsWith("_A"));
  const changedEvaluation = evaluateDistributionBenchmarkWalkForward(changedQuery).find((evaluation) => evaluation.observation.game_id.endsWith("_A"));
  assert.ok(baselineEvaluation?.nb && changedEvaluation?.nb);
  assert.equal(baselineEvaluation?.alpha, changedEvaluation?.alpha);
  assert.equal(baselineEvaluation?.nb?.crps, changedEvaluation?.nb?.crps);
  assert.equal(baselineEvaluation?.nb?.mid_pit, changedEvaluation?.nb?.mid_pit);
  assert.deepEqual(baselineEvaluation?.nb?.interval_90, changedEvaluation?.nb?.interval_90);
  assert.notEqual(baselineEvaluation?.nb?.brier, changedEvaluation?.nb?.brier);
});

test("benchmark rows persist comparator metrics, interval coverage, threshold-specific Brier summaries, and paired tests", () => {
  const rows = buildDistributionBenchmarkRows(evaluateDistributionBenchmarkWalkForward(observationsWithTraining()));
  const firstEligible = rows.find((row) => row[DISTRIBUTION_BENCHMARK_HEADERS.indexOf("Distribution_Status")] === "WALK_FORWARD_ELIGIBLE");
  assert.ok(firstEligible);
  assert.notEqual(firstEligible?.[DISTRIBUTION_BENCHMARK_HEADERS.indexOf("NB_Alpha")], "");
  assert.notEqual(firstEligible?.[DISTRIBUTION_BENCHMARK_HEADERS.indexOf("NB_90_Low")], "");
  assert.notEqual(firstEligible?.[DISTRIBUTION_BENCHMARK_HEADERS.indexOf("Empirical_Residual_Mid_PIT")], "");
  const summary = buildDistributionBenchmarkSummary(rows, "2026-08-03T03:00:00.000Z");
  const brier = summary.find((row) => row[2] === "BRIER_AT_QUERIED_THRESHOLD" && row[3] === 7.5);
  assert.ok(brier);
  assert.equal(brier?.length, DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS.length);
  const pairs = buildDistributionBenchmarkPairs(rows, "2026-08-03T03:00:00.000Z");
  assert.ok(pairs.some((row) => row[1] === "CRPS" && row[3] === "NB" && row[4] === "POISSON"));
  assert.equal(pairs[0]?.length, DISTRIBUTION_BENCHMARK_PAIR_HEADERS.length);
  assert.equal(pairedSignTestTwoSidedP(4, 0), 0.125);
});

test("distribution benchmark sheets are documented research-only workbook surfaces", () => {
  const columns = (sheet: string) => WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map((column) => column.name);
  assert.deepEqual(columns("DISTRIBUTION_BENCHMARK_V1"), DISTRIBUTION_BENCHMARK_HEADERS);
  assert.deepEqual(columns("DISTRIBUTION_BENCHMARK_SUMMARY"), DISTRIBUTION_BENCHMARK_SUMMARY_HEADERS);
  assert.deepEqual(columns("DISTRIBUTION_BENCHMARK_PAIRS"), DISTRIBUTION_BENCHMARK_PAIR_HEADERS);
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "DISTRIBUTION_BENCHMARK_V1"));
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "DISTRIBUTION_BENCHMARK_SUMMARY"));
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "DISTRIBUTION_BENCHMARK_PAIRS"));
});
