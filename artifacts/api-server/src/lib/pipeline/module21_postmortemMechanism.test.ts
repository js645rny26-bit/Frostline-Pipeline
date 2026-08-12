import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPostmortemMechanism,
  formatPostmortemMechanism,
} from "./module21_postmortemMechanism.js";

test("final score alone cannot manufacture a postmortem mechanism", () => {
  const result = classifyPostmortemMechanism();
  assert.equal(result.primary, "NOT_CLASSIFIED_INSUFFICIENT_EVENT_EVIDENCE");
  assert.deepEqual(result.contributing, []);
});

test("August 11 CHW-CIN distinguishes extra-inning state change from bullpen bridge failure", () => {
  const result = classifyPostmortemMechanism({
    bullpen_bridge_failure: true,
    extra_inning_state_change: true,
  });
  assert.equal(result.primary, "EXTRA_INNING_STATE_CHANGE");
  assert.deepEqual(result.contributing, ["BULLPEN_BRIDGE_FAILURE"]);
  assert.equal(
    formatPostmortemMechanism(result),
    "EXTRA_INNING_STATE_CHANGE | BULLPEN_BRIDGE_FAILURE",
  );
});

test("starter survival and starter failure remain different classifications", () => {
  assert.equal(
    classifyPostmortemMechanism({ starter_survival_misread: true }).primary,
    "STARTER_SURVIVAL_MISREAD",
  );
  assert.equal(
    classifyPostmortemMechanism({ starter_failure_misread: true }).primary,
    "STARTER_FAILURE_MISREAD",
  );
});
