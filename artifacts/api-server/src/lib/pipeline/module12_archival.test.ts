import assert from "node:assert/strict";
import test from "node:test";
import { assessRunLogIntegrity, buildRunLogIssueDetails } from "./module12_archival.js";

test("run log preserves every counted validation warning and critical failure", () => {
  const details = buildRunLogIssueDetails(
    ["Missing required starter"],
    ["Weather fallback used"],
    [{ module: "08_feed_writer", error: "write partial", timestamp: "2026-09-03T12:00:01.000Z" }],
    "2026-09-03T12:00:00.000Z",
  );
  assert.equal(details.integrityStatus, "PASS");
  assert.equal(details.critical.length, 1);
  assert.equal(details.warnings.length, 1);
  assert.equal(details.moduleErrors.length, 1);
  assert.deepEqual(details.critical[0], {
    module: "07_validation", code: "VALIDATION_CRITICAL_FAILURE", message: "Missing required starter",
    timestamp: "2026-09-03T12:00:00.000Z", fallback_state: "NO_FALLBACK", usability_state: "BLOCKING",
  });
  assert.equal(details.moduleErrors[0]?.fallback_state, "NOT_DECLARED");
  assert.equal(details.moduleErrors[0]?.usability_state, "DEGRADED");
});

test("a counted critical failure without detail is explicitly a run-log integrity failure", () => {
  assert.equal(assessRunLogIntegrity(1, 0, [], []), "RUN_LOG_INTEGRITY_FAILURE");
  assert.equal(assessRunLogIntegrity(0, 1, [], []), "RUN_LOG_INTEGRITY_FAILURE");
});
