import assert from "node:assert/strict";
import test from "node:test";
import { pitcherProvenanceFlag } from "./module18_survivalGateReplay.js";

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
