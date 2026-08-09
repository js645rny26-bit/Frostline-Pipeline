import assert from "node:assert/strict";
import test from "node:test";
import { gradeDirectionalOutcome } from "./module14_settlementGrading.js";

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
