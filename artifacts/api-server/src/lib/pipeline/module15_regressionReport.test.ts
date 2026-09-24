import assert from "node:assert/strict";
import test from "node:test";
import {
  isPreservedFrozenProjectionSource,
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
