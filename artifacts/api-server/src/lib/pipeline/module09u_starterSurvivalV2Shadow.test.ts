import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateStarterFromHistory,
  computeStarterSurvivalV2Row,
  parseV1TrainingObservations,
} from "./module09u_starterSurvivalV2Shadow.js";
import type { GameSummaryRow } from "./module09_recalculation.js";

const firstPitch = "2026-08-22T23:10:00.000Z";
const pregame = "2026-08-22T16:00:00.000Z";
function summary(overrides: Partial<GameSummaryRow> = {}): GameSummaryRow {
  return {
    game_id: "20260822_AAA_BBB", date: "2026-08-22", away_team: "AAA", home_team: "BBB",
    away_pitcher: "Away", home_pitcher: "Home", away_pitcher_role: "CONVENTIONAL_STARTER", home_pitcher_role: "CONVENTIONAL_STARTER",
    away_expected_innings: 6, home_expected_innings: 6, projected_away_runs: 4.5, projected_home_runs: 4.5, projected_total_runs: 9,
    away_offense_rate_used: 4.5, home_offense_rate_used: 4.5, combined_run_multiplier: 1, away_lineup_factor: 1, home_lineup_factor: 1,
    away_starter_quality: 1, home_starter_quality: 1, ...overrides,
  } as GameSummaryRow;
}

const training = [
  { date: "2026-08-21", expected_innings: 6, actual_innings: 6, actual_total: 5, dual_survival_total: 6 },
  { date: "2026-08-21", expected_innings: 6, actual_innings: 2.67, actual_total: 11, dual_survival_total: 6 },
  { date: "2026-08-20", expected_innings: 6, actual_innings: 5, actual_total: 9, dual_survival_total: 7 },
];

test("v2 survival and failure severity are derived from settled observations, not IP divided by nine", () => {
  const calibration = calibrateStarterFromHistory(training, 6, "CONVENTIONAL_STARTER");
  assert.deepEqual(calibration, {
    survival_probability: 0.3333,
    expected_failure_shortfall: 2.17,
    expected_failure_run_cost: 3.5,
    cohort: "WORKLOAD",
    observations: 3,
    failures: 2,
  });
  assert.notEqual(calibration?.survival_probability, 6 / 9);
});

test("v2 changes only failure workload while preserving the base active projection", () => {
  const source = summary();
  const before = structuredClone(source);
  const row = computeStarterSurvivalV2Row(source, firstPitch, pregame, training);
  assert.equal(row.calibration_status, "PROSPECTIVE_SHADOW_CANDIDATE");
  assert.equal(row.base_projected_total, 9);
  assert.equal(row.away_expected_failure_innings, 3.83);
  assert.equal(row.home_expected_failure_innings, 3.83);
  assert.ok(Math.abs((row.p_ss! + row.p_fs! + row.p_sf! + row.p_ff!) - 1) < 1e-9);
  assert.deepEqual(source, before);
});

test("v2 refuses to manufacture a probability without settled failure history or after first pitch", () => {
  const empty = computeStarterSurvivalV2Row(summary(), firstPitch, pregame, []);
  assert.equal(empty.calibration_status, "INSUFFICIENT_EMPIRICAL_HISTORY");
  const late = computeStarterSurvivalV2Row(summary(), firstPitch, firstPitch, training);
  assert.equal(late.calibration_status, "POST_FIRST_PITCH_REJECTED");
});

test("v2 does not convert a one-branch cohort into a legitimate numerical zero", () => {
  const allFailures = [
    { date: "2026-08-21", expected_innings: 5.7, actual_innings: 4.33, actual_total: 8, dual_survival_total: 8 },
  ];
  assert.equal(
    calibrateStarterFromHistory(allFailures, 5.7, "CONVENTIONAL_STARTER"),
    null,
    "a failure-only cohort has no observed survival branch and must be insufficient, not 0.0000",
  );

  const broaderHistory = [
    ...allFailures,
    { date: "2026-08-20", expected_innings: 6, actual_innings: 6, actual_total: 6, dual_survival_total: 6 },
    { date: "2026-08-20", expected_innings: 6, actual_innings: 4, actual_total: 9, dual_survival_total: 6 },
  ];
  const calibration = calibrateStarterFromHistory(broaderHistory, 5.7, "CONVENTIONAL_STARTER");
  assert.equal(calibration?.cohort, "GLOBAL");
  assert.ok((calibration?.survival_probability ?? 0) > 0);
  assert.ok((calibration?.expected_failure_run_cost ?? 0) > 0);
});

test("v1 report bootstrap uses only earlier settled rows and never same-date records", () => {
  const history = Array(24).fill("");
  history[0] = "2026-08-21";
  history[1] = "20260821_AAA_BBB";
  history[5] = 6;
  history[6] = 5;
  history[13] = 7;
  history[21] = "PROSPECTIVE_SHADOW_CANDIDATE";
  history[22] = "CONVENTIONAL_STARTER";
  history[23] = "BULK";
  const report = Array(24).fill("");
  report[0] = "2026-08-21";
  report[1] = "20260821_AAA_BBB";
  report[7] = 10;
  report[14] = 3;
  report[15] = 6;
  report[22] = "2026-08-22T02:00:00.000Z";
  report[23] = "SETTLED";
  const sameDate = [...report];
  sameDate[0] = "2026-08-22";
  sameDate[1] = "20260822_CCC_DDD";
  const observations = parseV1TrainingObservations([history], [report, sameDate], "2026-08-22", "2026-08-22T16:00:00.000Z");
  assert.equal(observations.length, 2);
  assert.ok(observations.every((row) => row.date < "2026-08-22"));
  assert.deepEqual(observations.map((row) => row.role), ["CONVENTIONAL_STARTER", "BULK"]);

  const futureSettlement = [...report];
  futureSettlement[22] = "2026-08-22T18:00:00.000Z";
  assert.equal(
    parseV1TrainingObservations([history], [futureSettlement], "2026-08-22", "2026-08-22T16:00:00.000Z").length,
    0,
    "a settlement completed after the candidate snapshot is not available pregame evidence",
  );
});

test("unresolved frozen roles remain roleless training evidence", () => {
  const history = Array(24).fill("");
  history[0] = "2026-08-21";
  history[1] = "20260821_AAA_BBB";
  history[5] = 6;
  history[6] = 6;
  history[13] = 7;
  history[21] = "PROSPECTIVE_SHADOW_CANDIDATE";
  history[22] = "UNRESOLVED";
  history[23] = "UNRESOLVED";
  const report = Array(24).fill("");
  report[0] = "2026-08-21";
  report[1] = "20260821_AAA_BBB";
  report[7] = 10;
  report[14] = 3;
  report[15] = 6;
  report[22] = "2026-08-22T02:00:00.000Z";
  report[23] = "SETTLED";
  const observations = parseV1TrainingObservations([history], [report], "2026-08-22", "2026-08-22T16:00:00.000Z");
  assert.deepEqual(observations.map((row) => row.role), [undefined, undefined]);
});

test("v2 can select a genuine frozen role-and-workload cohort", () => {
  const roleTraining = [
    { date: "2026-08-21", expected_innings: 6, actual_innings: 6, actual_total: 5, dual_survival_total: 6, role: "CONVENTIONAL_STARTER" },
    { date: "2026-08-20", expected_innings: 6, actual_innings: 4, actual_total: 10, dual_survival_total: 6, role: "CONVENTIONAL_STARTER" },
    { date: "2026-08-19", expected_innings: 6, actual_innings: 1, actual_total: 12, dual_survival_total: 6, role: "BULK" },
  ];
  const calibration = calibrateStarterFromHistory(roleTraining, 6, "CONVENTIONAL_STARTER");
  assert.equal(calibration?.cohort, "ROLE_AND_WORKLOAD");
  assert.equal(calibration?.observations, 2);
  assert.equal(calibration?.failures, 1);
});
