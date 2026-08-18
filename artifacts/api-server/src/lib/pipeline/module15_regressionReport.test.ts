import assert from "node:assert/strict";
import test from "node:test";
import { isPreservedFrozenProjectionSource } from "./module15_regressionReport.js";

test("valid preserved prospective sources feed frozen regression windows", () => {
  assert.equal(isPreservedFrozenProjectionSource("FROZEN_VEHICLE_LOG"), true);
  assert.equal(isPreservedFrozenProjectionSource("PROSPECTIVE_DECISION_AUDIT"), true);
  assert.equal(isPreservedFrozenProjectionSource("MISSING_FROZEN_VEHICLE_LOG"), false);
  assert.equal(isPreservedFrozenProjectionSource("REPAIRED_CALCULATION"), false);
});
