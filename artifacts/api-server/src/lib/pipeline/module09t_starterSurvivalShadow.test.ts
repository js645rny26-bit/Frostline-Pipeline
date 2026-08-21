import assert from "node:assert/strict";
import test from "node:test";
import { computeStarterSurvivalRow, STARTER_FAILURE_INNINGS_DELTA, starterSurvivalBranchWorkloads, starterSurvivalProbability } from "./module09t_starterSurvivalShadow.js";
import type { GameSummaryRow } from "./module09_recalculation.js";

const firstPitch = "2026-08-21T23:10:00.000Z";
const pregame = "2026-08-21T16:00:00.000Z";
function summary(overrides: Partial<GameSummaryRow> = {}): GameSummaryRow {
  return {
    game_id: "20260821_AAA_BBB", date: "2026-08-21", away_team: "AAA", home_team: "BBB",
    away_pitcher: "Away", home_pitcher: "Home", away_pitcher_role: "CONVENTIONAL_STARTER", home_pitcher_role: "CONVENTIONAL_STARTER",
    away_expected_innings: 6, home_expected_innings: 5.5, projected_away_runs: 4.4, projected_home_runs: 4.2, projected_total_runs: 8.6,
    away_offense_rate_used: 4.5, home_offense_rate_used: 4.3, combined_run_multiplier: 1, away_lineup_factor: 1, home_lineup_factor: 1,
    away_starter_quality: 1, home_starter_quality: 1, ...overrides,
  } as GameSummaryRow;
}

test("four-state probabilities sum to one and use the documented temporary default", () => {
  const row = computeStarterSurvivalRow(summary(), firstPitch, pregame);
  assert.equal(row.away_starter_survival_prob, starterSurvivalProbability(6));
  assert.equal(row.home_starter_survival_prob, starterSurvivalProbability(5.5));
  assert.ok(Math.abs((row.p_ss! + row.p_fs! + row.p_sf! + row.p_ff!) - 1) < 1e-9);
});

test("probability extremes select the correct branch total", () => {
  const source = summary();
  const ss = computeStarterSurvivalRow(source, firstPitch, pregame, { away: 1, home: 1 });
  const fs = computeStarterSurvivalRow(source, firstPitch, pregame, { away: 0, home: 1 });
  const sf = computeStarterSurvivalRow(source, firstPitch, pregame, { away: 1, home: 0 });
  const ff = computeStarterSurvivalRow(source, firstPitch, pregame, { away: 0, home: 0 });
  assert.equal(ss.starter_survival_adjusted_total, ss.t_ss);
  assert.equal(fs.starter_survival_adjusted_total, fs.t_fs);
  assert.equal(sf.starter_survival_adjusted_total, sf.t_sf);
  assert.equal(ff.starter_survival_adjusted_total, ff.t_ff);
});

test("failure removes one starter inning, transfers it to the bullpen, and changes no active projection", () => {
  const source = summary({ away_expected_innings: 6, home_expected_innings: 5 });
  const before = structuredClone(source);
  const row = computeStarterSurvivalRow(source, firstPitch, pregame);
  const workloads = starterSurvivalBranchWorkloads(6);
  assert.equal(STARTER_FAILURE_INNINGS_DELTA, 1);
  assert.deepEqual(workloads, { survival_starter: 6, survival_bullpen: 3, failure_starter: 5, failure_bullpen: 4 });
  assert.equal(workloads.failure_starter + workloads.failure_bullpen, 9);
  assert.equal(workloads.survival_bullpen + STARTER_FAILURE_INNINGS_DELTA, workloads.failure_bullpen);
  assert.equal(row.t_ss !== null, true);
  assert.equal(row.base_projected_total, source.projected_total_runs);
  assert.equal(row.calibration_status, "PROSPECTIVE_SHADOW_CANDIDATE");
  assert.ok(row.t_fs! !== row.t_ss! || row.t_sf! !== row.t_ss!);
  assert.deepEqual(source, before, "branch calculation must not mutate non-workload game inputs");
});

test("FDS values clamp at zero and post-first-pitch records are rejected", () => {
  const row = computeStarterSurvivalRow(summary(), firstPitch, pregame);
  assert.ok(row.away_starter_fds! >= 0 && row.home_starter_fds! >= 0 && row.game_fds! >= 0);
  const rejected = computeStarterSurvivalRow(summary(), firstPitch, firstPitch);
  assert.equal(rejected.calibration_status, "POST_FIRST_PITCH_REJECTED");
  assert.equal(rejected.starter_survival_adjusted_total, null);
});
