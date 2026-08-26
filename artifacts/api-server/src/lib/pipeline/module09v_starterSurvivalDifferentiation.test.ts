import assert from "node:assert/strict";
import test from "node:test";

import { buildStarterSurvivalDifferentiationAuditRow, parseStarterSurvivalV2History, pearsonCorrelation, type StarterSurvivalDifferentiationInput } from "./module09v_starterSurvivalDifferentiation.js";

function candidate(overrides: Partial<StarterSurvivalDifferentiationInput> = {}): StarterSurvivalDifferentiationInput {
  return {
    date: "2026-08-26",
    game_id: "20260826_AAA_BBB",
    ssat_v1_total: 9,
    ssat_v2_total: 8.95,
    calibration_status: "PROSPECTIVE_SHADOW_CANDIDATE",
    away_starter_survival_prob: 0.4286,
    home_starter_survival_prob: 0.4286,
    away_starter_quality: 0.72,
    home_starter_quality: 1.08,
    away_opponent_pressure: 4.1,
    home_opponent_pressure: 4.8,
    away_calibration_cohort: "WORKLOAD",
    home_calibration_cohort: "WORKLOAD",
    away_cohort_observations: 14,
    home_cohort_observations: 14,
    away_cohort_failures: 8,
    home_cohort_failures: 8,
    ...overrides,
  };
}

test("differentiation audit measures close v1/v2 totals and repeated probabilities without creating a decision state", () => {
  const rows = [
    candidate(),
    candidate({
      game_id: "20260826_CCC_DDD",
      ssat_v1_total: 10,
      ssat_v2_total: 9.95,
    }),
    candidate({
      game_id: "20260826_EEE_FFF",
      ssat_v1_total: 11,
      ssat_v2_total: 10.95,
      away_starter_survival_prob: 0.6,
      home_starter_survival_prob: 0.7,
      away_calibration_cohort: "ROLE",
      home_calibration_cohort: "ROLE",
      away_cohort_observations: 4,
      home_cohort_observations: 5,
      away_cohort_failures: 2,
      home_cohort_failures: 1,
    }),
  ];

  const audit = buildStarterSurvivalDifferentiationAuditRow(rows, "CURRENT_DATE", "2026-08-26", "2026-08-26T12:00:00.000Z");

  assert.equal(audit.eligible_game_count, 3);
  assert.equal(audit.v1_v2_pearson_r, 1);
  assert.equal(audit.mean_abs_v1_v2_diff, 0.05);
  assert.equal(audit.within_0_10_count, 3);
  assert.equal(audit.within_0_25_pct, 100);
  assert.equal(audit.repeated_probability_group_count, 1);
  assert.equal(audit.repeated_probability_slot_count, 4);
  assert.equal(audit.largest_probability_value, 0.4286);
  assert.equal(audit.largest_probability_starter_count, 4);
  assert.equal(audit.largest_probability_game_count, 2);
  assert.equal(audit.cohort_metadata_status, "COMPLETE");
  assert.match(audit.repeated_probability_profile_summary, /0\.4286: 4 starter slots\/2 games/);
  assert.equal(audit.analysis_status, "OBSERVATIONAL_ONLY");
  assert.match(audit.interpretation, /one SSAT evidence family/);
});

test("differentiation audit records insufficient comparisons rather than inventing a conclusion", () => {
  const audit = buildStarterSurvivalDifferentiationAuditRow([candidate({ ssat_v1_total: null, ssat_v2_total: null })], "CURRENT_DATE", "2026-08-26", "2026-08-26T12:00:00.000Z");

  assert.equal(audit.eligible_game_count, 0);
  assert.equal(audit.v1_v2_pearson_r, null);
  assert.equal(audit.mean_abs_v1_v2_diff, null);
  assert.equal(audit.analysis_status, "INSUFFICIENT_COMPARISONS");
  assert.equal(audit.cohort_metadata_status, "COMPLETE");
});

test("history parsing preserves legacy blank cohort metadata as an explicit gap", () => {
  const legacyRow = Array(40).fill("");
  legacyRow[0] = "2026-08-25";
  legacyRow[1] = "20260825_AAA_BBB";
  legacyRow[4] = 8.1;
  legacyRow[5] = 8.05;
  legacyRow[12] = 0.4286;
  legacyRow[13] = 0.4286;
  legacyRow[31] = "PROSPECTIVE_SHADOW_CANDIDATE";
  const [parsed] = parseStarterSurvivalV2History([legacyRow]);
  assert.equal(parsed?.away_cohort_observations, null);
  assert.equal(parsed?.away_calibration_cohort, "");
});

test("pearson correlation remains undefined for a constant series", () => {
  assert.equal(pearsonCorrelation([9, 9], [8.9, 9.1]), null);
});
