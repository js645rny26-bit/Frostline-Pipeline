import assert from "node:assert/strict";
import test from "node:test";
import {
  allocationBucketFloor,
  assessMechanismEvidence,
  auditMechanismInstrumentation,
  bucketInterpretationStatus,
  buildMarginalCenterDiagnostics,
  CENTER_ERROR_DECOMPOSITION_ACTIVE_INPUT,
  CENTER_ERROR_BUCKET_FLOORS,
  classifyTailObservation,
  decomposeCenterPhaseError,
  deriveContinuousBucketFloor,
  distributionTailBucketFloor,
  STARTER_MECHANISM_BONFERRONI_ALPHA,
  STARTER_MECHANISM_SIMULTANEOUS_CONFIDENCE,
} from "./module37_centerErrorDecomposition.js";

test("phase decomposition reconciles workload plus two rate residuals to total error", () => {
  const result = decomposeCenterPhaseError({
    frozen_total: 9,
    frozen_starter_attack_runs: 5,
    frozen_traffic_conversion_runs: 0.2,
    frozen_hr_xbh_damage_runs: 0.3,
    frozen_bullpen_continuation_runs: 3.5,
    frozen_run_multiplier: 1,
    frozen_away_expected_ip: 6,
    frozen_home_expected_ip: 6,
    actual_total: 10,
    actual_starter_window_runs: 4,
    actual_post_starter_runs: 6,
    actual_away_starter_ip: 5,
    actual_home_starter_ip: 5,
  });
  assert.equal(result.status, "USABLE");
  assert.equal(result.total_error, -1);
  assert.ok(Math.abs(result.decomposition_sum! - result.total_error) < 1e-5);
  assert.ok(Math.abs(result.reconciliation_delta!) < 1e-5);
});

test("starter mechanism audit cannot interpret an inert damage channel as no effect", () => {
  const factors = auditMechanismInstrumentation([1, 1, 1, 1], 1);
  const damageRuns = auditMechanismInstrumentation([0, 0, 0, 0], 0);
  assert.equal(factors.status, "INSTRUMENTATION_DEAD");
  assert.equal(damageRuns.status, "INSTRUMENTATION_DEAD");
  assert.equal(assessMechanismEvidence({
    instrumentation_status: damageRuns.status,
    eligible_n: 400,
    frozen_floor: 100,
    simultaneous_ci_lower: 0.2,
    simultaneous_ci_upper: 0.4,
  }), "INSTRUMENTATION_DEAD");
});

test("six mechanism claims use a familywise interval and require zero exclusion", () => {
  assert.ok(Math.abs(STARTER_MECHANISM_BONFERRONI_ALPHA - 0.05 / 6) < 1e-12);
  assert.ok(Math.abs(STARTER_MECHANISM_SIMULTANEOUS_CONFIDENCE - (1 - 0.05 / 6)) < 1e-12);
  assert.equal(assessMechanismEvidence({
    instrumentation_status: "LIVE_VARYING",
    eligible_n: 150,
    frozen_floor: 100,
    simultaneous_ci_lower: -0.1,
    simultaneous_ci_upper: 0.8,
  }), "PROVISIONAL_INTERVAL_INCLUDES_ZERO");
  assert.equal(assessMechanismEvidence({
    instrumentation_status: "LIVE_VARYING",
    eligible_n: 150,
    frozen_floor: 100,
    simultaneous_ci_lower: 0.1,
    simultaneous_ci_upper: 0.8,
  }), "SUPPORTED_DIRECTIONAL_ERROR");
});

test("phase decomposition rejects pitcher-run substitutes that do not reconcile", () => {
  const result = decomposeCenterPhaseError({
    frozen_total: 9,
    frozen_starter_attack_runs: 5,
    frozen_traffic_conversion_runs: 0,
    frozen_hr_xbh_damage_runs: 0,
    frozen_bullpen_continuation_runs: 4,
    frozen_run_multiplier: 1,
    frozen_away_expected_ip: 6,
    frozen_home_expected_ip: 6,
    actual_total: 10,
    actual_starter_window_runs: 7,
    actual_post_starter_runs: 1,
    actual_away_starter_ip: 5,
    actual_home_starter_ip: 5,
  });
  assert.equal(result.status, "NON_RECONCILING_INPUT");
  assert.equal(result.workload_allocation_error, null);
});

test("offense and environment remain non-additive marginal diagnostics", () => {
  const result = buildMarginalCenterDiagnostics({
    frozen_total: 10,
    actual_total: 8,
    frozen_away_projection: 6,
    frozen_home_projection: 4,
    frozen_away_active_offense_center: 5,
    frozen_home_active_offense_center: 4,
    frozen_environment_run_adjustment: 1,
  });
  assert.equal(result.interpretation, "NON_ADDITIVE_DIAGNOSTICS_ONLY");
  assert.equal(result.no_environment_counterfactual_total, 9);
  assert.equal(result.environment_marginal_abs_loss, 1);
  assert.notEqual(result.neutral_offense_counterfactual_total, null);
});

test("tail observation uses only the frozen distribution interval and never claims a defensible center", () => {
  assert.equal(classifyTailObservation({
    actual_total: 16,
    frozen_interval_90_low: 3,
    frozen_interval_90_high: 14,
    distribution_status: "ELIGIBLE",
  }), "HIGH_90_INTERVAL_ESCAPE");
  assert.equal(classifyTailObservation({
    actual_total: 16,
    frozen_interval_90_low: null,
    frozen_interval_90_high: null,
    distribution_status: "TRAINING_WINDOW_UNRESOLVED",
  }), "DISTRIBUTION_EVIDENCE_UNAVAILABLE");
});

test("sample governance is frozen before interpretation and does not use a one-slate result", () => {
  assert.equal(CENTER_ERROR_DECOMPOSITION_ACTIVE_INPUT, "NO");
  const floor = deriveContinuousBucketFloor([1, -1, 2, -2, 0, 1.5, -1.5]);
  assert.ok(floor !== null && floor >= 100);
  assert.equal(bucketInterpretationStatus(99, floor), "INSUFFICIENT_N");
  assert.equal(bucketInterpretationStatus(floor!, floor), "INTERPRETABLE");
  assert.equal(bucketInterpretationStatus(500, null), "FLOOR_NOT_FROZEN");
  assert.equal(allocationBucketFloor(), 171);
  assert.equal(distributionTailBucketFloor(), 139);
  assert.deepEqual(CENTER_ERROR_BUCKET_FLOORS, {
    OFFENSE_BASELINE: 100,
    STARTER_PHASE: 100,
    WORKLOAD_ALLOCATION: 100,
    BULLPEN_CONTINUATION: 100,
    ENVIRONMENT: 100,
    TEAM_ALLOCATION: 171,
    DISTRIBUTION_TAIL: 139,
  });
});
