import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRegressionAlerts,
  isPreservedFrozenProjectionSource,
  REGRESSION_ALERT_THRESHOLDS,
  selectStandingResearchMarketLine,
} from "./module15_regressionReport.js";

test("valid preserved prospective sources feed frozen regression windows", () => {
  assert.equal(isPreservedFrozenProjectionSource("FROZEN_VEHICLE_LOG"), true);
  assert.equal(isPreservedFrozenProjectionSource("PROSPECTIVE_DECISION_AUDIT"), true);
  assert.equal(isPreservedFrozenProjectionSource("MISSING_FROZEN_VEHICLE_LOG"), false);
  assert.equal(isPreservedFrozenProjectionSource("REPAIRED_CALCULATION"), false);
});

test("rolling directional research uses reference market rather than an execution/vehicle substitute", () => {
  assert.equal(selectStandingResearchMarketLine(8, 8.5), 8);
  assert.equal(selectStandingResearchMarketLine(Number.NaN, 8.5), 8.5);
});

test("Bias_Alert is a strict descriptive absolute-mean threshold, not a statistical verdict", () => {
  assert.equal(REGRESSION_ALERT_THRESHOLDS.absolute_bias, 0.20);
  assert.deepEqual(evaluateRegressionAlerts(3, 0.20, 20), []);
  assert.deepEqual(evaluateRegressionAlerts(3, -0.20, 20), []);
  assert.deepEqual(evaluateRegressionAlerts(3, 0.201, 20), ["BIAS_HIGH(0.201)"]);
  assert.deepEqual(evaluateRegressionAlerts(3, -0.201, 20), ["BIAS_HIGH(-0.201)"]);
});

test("regression alerts retain their independent strict boundaries", () => {
  assert.deepEqual(evaluateRegressionAlerts(4.2, 0, 45), []);
  assert.deepEqual(evaluateRegressionAlerts(4.201, 0, 45.1), [
    "MAE_HIGH(4.201 > 4.2)",
    "MISS_4PLUS_HIGH(45.1%)",
  ]);
});
