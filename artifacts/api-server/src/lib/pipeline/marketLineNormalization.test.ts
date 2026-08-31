import assert from "node:assert/strict";
import test from "node:test";

import {
  isHalfNumberFullGameTotal,
  normalizeFullGameTotalLine,
  normalizeFullGameTotalVehicle,
  normalizeHardRockTotalLineList,
} from "./marketLineNormalization.js";

test("whole-number full-game totals normalize to the immediately lower Hard Rock half number", () => {
  assert.equal(normalizeFullGameTotalLine(10), 9.5);
  assert.equal(normalizeFullGameTotalLine("7"), 6.5);
  assert.equal(normalizeFullGameTotalLine(8.5), 8.5);
  assert.equal(normalizeFullGameTotalLine("9.5"), 9.5);
});

test("unsupported fractional totals fail closed instead of inventing a Hard Rock line", () => {
  assert.equal(normalizeFullGameTotalLine(8.25), null);
  assert.equal(normalizeFullGameTotalLine(0), null);
  assert.equal(normalizeFullGameTotalLine("not a total"), null);
  assert.equal(isHalfNumberFullGameTotal(9.5), true);
  assert.equal(isHalfNumberFullGameTotal(10), false);
});

test("manual ladder and vehicle entries keep only executable half-number thresholds", () => {
  assert.equal(
    normalizeHardRockTotalLineList("7, 7.5 | 10"),
    "6.5, 7.5 | 9.5",
  );
  assert.equal(normalizeFullGameTotalVehicle("OVER 10"), "OVER 9.5");
  assert.equal(normalizeFullGameTotalVehicle("UNDER 7.5"), "UNDER 7.5");
});
