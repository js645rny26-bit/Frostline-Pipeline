import assert from "node:assert/strict";
import test from "node:test";
import {
  gradeDirectionalOutcome,
  gradeHardRockMlbFullGameTotal,
} from "./module14_settlementGrading.js";

test("Over and Under wins and losses grade directionally", () => {
  assert.equal(gradeDirectionalOutcome("OVER", 8.5, 9), "WIN");
  assert.equal(gradeDirectionalOutcome("OVER", 8.5, 8), "LOSS");
  assert.equal(gradeDirectionalOutcome("UNDER", 8.5, 8), "WIN");
  assert.equal(gradeDirectionalOutcome("UNDER", 8.5, 9), "LOSS");
});

test("Over and Under pushes remain PUSH", () => {
  assert.equal(gradeDirectionalOutcome("OVER", 9, 9), "PUSH");
  assert.equal(gradeDirectionalOutcome("UNDER", 9, 9), "PUSH");
});

test("missing lines, totals, and directions are not evaluable", () => {
  assert.equal(gradeDirectionalOutcome("OVER", null, 9), "NOT_EVALUABLE");
  assert.equal(gradeDirectionalOutcome("UNDER", 9, null), "NOT_EVALUABLE");
  assert.equal(gradeDirectionalOutcome("NONE", 9, 9), "NOT_EVALUABLE");
});

test("Hard Rock MLB full-game half totals produce only wins and losses", () => {
  assert.deepEqual(gradeHardRockMlbFullGameTotal("OVER", 8.5, 8), {
    outcome: "LOSS",
    integrity_status: "VALID_LITERAL_HALF_NUMBER",
  });
  assert.deepEqual(gradeHardRockMlbFullGameTotal("UNDER", 8.5, 8), {
    outcome: "WIN",
    integrity_status: "VALID_LITERAL_HALF_NUMBER",
  });
  assert.deepEqual(gradeHardRockMlbFullGameTotal("OVER", 8.5, 9), {
    outcome: "WIN",
    integrity_status: "VALID_LITERAL_HALF_NUMBER",
  });
  assert.deepEqual(gradeHardRockMlbFullGameTotal("UNDER", 8.5, 9), {
    outcome: "LOSS",
    integrity_status: "VALID_LITERAL_HALF_NUMBER",
  });
});

test("Hard Rock MLB full-game whole totals are integrity failures, never pushes", () => {
  assert.deepEqual(gradeHardRockMlbFullGameTotal("OVER", 8, 8), {
    outcome: "NOT_EVALUABLE",
    integrity_status: "MARKET_LINE_INTEGRITY_FAILURE",
  });
  assert.deepEqual(gradeHardRockMlbFullGameTotal("OVER", null, 8), {
    outcome: "NOT_EVALUABLE",
    integrity_status: "MISSING_LITERAL_EXECUTABLE_LINE",
  });
});
