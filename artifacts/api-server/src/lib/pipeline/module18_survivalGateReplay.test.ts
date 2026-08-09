import assert from "node:assert/strict";
import test from "node:test";
import {
  gradeReplayThesis,
  pitcherProvenanceFlag,
  summarizeThesisOutcomes,
} from "./module18_survivalGateReplay.js";

test("survival replay preserves Over and Under pushes", () => {
  assert.equal(gradeReplayThesis("OVER", 9, 9), "PUSH");
  assert.equal(gradeReplayThesis("UNDER", 9, 9), "PUSH");
});

test("pushes are excluded from survival-gate win/loss denominators", () => {
  assert.deepEqual(summarizeThesisOutcomes([
    { thesis_correct: true },
    { thesis_correct: false },
    { thesis_correct: "PUSH" },
    { thesis_correct: null },
  ]), { wins: 1, losses: 1, pushes: 1 });
});

test("complete matched pitcher provenance is explicit", () => {
  assert.equal(pitcherProvenanceFlag({
    provenance_status: "COMPLETE",
    away_match_status: "MATCH",
    home_match_status: "MATCH",
  }), "COMPLETE_MATCH");
});

test("unresolved pregame starter cannot be labeled complete", () => {
  assert.equal(pitcherProvenanceFlag({
    provenance_status: "PARTIAL",
    away_match_status: "UNRESOLVED",
    home_match_status: "MATCH",
  }), "PARTIAL_PREGAME_STARTER_UNRESOLVED");
});

test("missing settlement provenance is explicitly unavailable", () => {
  assert.equal(pitcherProvenanceFlag(undefined), "UNAVAILABLE");
});
