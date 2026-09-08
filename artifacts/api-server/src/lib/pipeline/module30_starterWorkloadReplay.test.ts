import assert from "node:assert/strict";
import test from "node:test";
import {
  SWE_REPLAY_STARTER_HEADER_CONTRACT,
  summarizeSWEReplay,
} from "./module30_starterWorkloadReplay.js";

test("SWE paired replay stays descriptive until the declared N=150 checkpoint", () => {
  const summary = summarizeSWEReplay(Array.from({ length: 149 }, () => ({ swe_abs_error: 1, legacy_abs_error: 2 })));
  assert.equal(summary.eligible_n, 149);
  assert.equal(summary.swe_mae, 1);
  assert.equal(summary.legacy_mae, 2);
  assert.equal(summary.decision_status, "PRE_CHECKPOINT_DESCRIPTIVE");
  assert.equal(SWE_REPLAY_STARTER_HEADER_CONTRACT, true);
});

test("SWE paired replay has a declared retirement outcome when legacy wins significantly", () => {
  const summary = summarizeSWEReplay(Array.from({ length: 150 }, (_, index) => ({ swe_abs_error: 2 + index / 10_000, legacy_abs_error: 1 })));
  assert.equal(summary.decision_status, "LEGACY_BETTER_RETIRE_SWE_V1");
  assert.ok((summary.wilcoxon_p ?? 1) < 0.05);
});

test("SWE ambiguous N=300 result retires instead of inviting post-result tuning", () => {
  const observations = Array.from({ length: 300 }, (_, index) => index % 2 === 0
    ? { swe_abs_error: 1, legacy_abs_error: 2 }
    : { swe_abs_error: 2, legacy_abs_error: 1 });
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.decision_status, "AMBIGUOUS_AT_N300_RETIRE_SWE_V1");
});
