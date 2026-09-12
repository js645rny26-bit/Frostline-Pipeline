import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLiteralFullGameTotal,
  describeFullGameTotalNormalization,
  isHalfNumberFullGameTotal,
  normalizeFullGameTotalLine,
  requiresHardRockFloridaMlbFullGameTotal,
} from "./marketLineNormalization.js";

test("synthetic display normalization maps whole-number totals to a lower half number", () => {
  assert.equal(normalizeFullGameTotalLine(10), 9.5);
  assert.equal(normalizeFullGameTotalLine("7"), 6.5);
  assert.equal(normalizeFullGameTotalLine(8.5), 8.5);
  assert.equal(normalizeFullGameTotalLine("9.5"), 9.5);
});

test("literal market provenance preserves the posted whole-or-half convention", () => {
  assert.deepEqual(describeLiteralFullGameTotal(8), {
    literal_total: 8,
    convention: "WHOLE_NUMBER",
  });
  assert.deepEqual(describeLiteralFullGameTotal(8.5), {
    literal_total: 8.5,
    convention: "HALF_NUMBER",
  });
  assert.deepEqual(describeLiteralFullGameTotal(8.25), {
    literal_total: null,
    convention: "UNSUPPORTED_OR_MISSING",
  });
});

test("normalization metadata preserves the source representation decision", () => {
  assert.deepEqual(describeFullGameTotalNormalization(10), {
    normalized_total: 9.5,
    status: "INTEGER_TO_LOWER_HALF",
  });
  assert.deepEqual(describeFullGameTotalNormalization(8.5), {
    normalized_total: 8.5,
    status: "ALREADY_HALF_NUMBER",
  });
  assert.deepEqual(describeFullGameTotalNormalization(8.25), {
    normalized_total: null,
    status: "UNSUPPORTED_OR_MISSING",
  });
});

test("unsupported fractional totals fail closed instead of inventing a Hard Rock line", () => {
  assert.equal(normalizeFullGameTotalLine(8.25), null);
  assert.equal(normalizeFullGameTotalLine(0), null);
  assert.equal(normalizeFullGameTotalLine("not a total"), null);
  assert.equal(isHalfNumberFullGameTotal(9.5), true);
  assert.equal(isHalfNumberFullGameTotal(10), false);
});

test("the Hard Rock Florida full-game-total policy has an explicit historical boundary", () => {
  assert.equal(requiresHardRockFloridaMlbFullGameTotal("2026-09-05"), false);
  assert.equal(requiresHardRockFloridaMlbFullGameTotal("2026-09-06"), true);
  assert.equal(requiresHardRockFloridaMlbFullGameTotal("2026-09-11"), true);
  assert.equal(requiresHardRockFloridaMlbFullGameTotal("not-a-date"), false);
});
