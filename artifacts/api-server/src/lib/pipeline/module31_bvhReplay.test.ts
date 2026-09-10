import assert from "node:assert/strict";
import test from "node:test";
import { ALLOCATION_SETTLEMENT_HEADERS } from "./module24_postgameDiagnostics.js";
import { BVH_PROJECTION_HISTORY_HEADERS } from "./module09b_bvhIntegration.js";
import {
  buildBVHReplay,
  bvhResearchStatus,
  selectLatestBVHCandidates,
  summarizeBVHReplay,
} from "./module31_bvhReplay.js";

function row(headers: readonly string[], values: Record<string, unknown>): unknown[] {
  return headers.map((header) => values[header] ?? "");
}

function candidate(overrides: Record<string, unknown> = {}): unknown[] {
  return row(BVH_PROJECTION_HISTORY_HEADERS, {
    Date: "2026-09-08", Game_ID: "20260908_AAA_BBB", Snapshot_TS: "2026-09-08T20:00:00.000Z",
    BVH_Version: "1.0.0", Integration_Status: "SHADOW_ONLY_PROSPECTIVE_V1", Active_Input: "NO",
    Away_Opposing_Starter_Hand: "R", Home_Opposing_Starter_Hand: "L",
    Away_BVH_Coverage: 0.8, Home_BVH_Coverage: 0.7, Away_BVH_Identity_Coverage: 1, Home_BVH_Identity_Coverage: 1,
    Away_BVH_Chain_Uncertainty: "FALSE", Home_BVH_Chain_Uncertainty: "FALSE",
    Away_BVH_Status: "AVAILABLE", Home_BVH_Status: "AVAILABLE",
    Away_BVH_Driver_Trace: "1:101:PA=80", Home_BVH_Driver_Trace: "1:201:PA=60",
    BVH_vs_Platoon_Delta_Away: 0.03, BVH_vs_Platoon_Delta_Home: -0.02,
    Existing_Away_Runs: 4, Existing_Home_Runs: 5, Existing_Total: 9,
    BVH_Away_Runs: 4.5, BVH_Home_Runs: 4.7, BVH_Total: 9.2,
    BVH_Deterministic_Hash: "hash", ...overrides,
  });
}

function allocation(): unknown[] {
  return row(ALLOCATION_SETTLEMENT_HEADERS, {
    Date: "2026-09-08", Game_ID: "20260908_AAA_BBB", Actual_Away_Runs: 5, Actual_Home_Runs: 4,
    Actual_Total: 9, Settlement_TS: "2026-09-09T05:00:00.000Z", Diagnostic_Status: "COMPLETE",
  });
}

test("BVH replay selects the latest prospective snapshot and grades total plus allocation", () => {
  const older = candidate({ Snapshot_TS: "2026-09-08T18:00:00.000Z", BVH_Total: 8.5 });
  const replay = buildBVHReplay(
    [Array.from(BVH_PROJECTION_HISTORY_HEADERS), older, candidate()],
    [Array.from(ALLOCATION_SETTLEMENT_HEADERS), allocation()],
  );
  assert.equal(replay.length, 1);
  assert.equal(replay[0]?.snapshot_ts, "2026-09-08T20:00:00.000Z");
  assert.equal(replay[0]?.actual_away, 5);
  const summary = summarizeBVHReplay(replay);
  assert.equal(summary.n, 1);
  assert.equal(summary.existing_total_mae, 0);
  assert.equal(summary.bvh_total_mae, 0.2);
  assert.equal(summary.existing_allocation_mae, 1);
  assert.equal(summary.bvh_allocation_mae, 0.6);
  assert.equal(summary.manual_review_n, 1);
});

test("BVH replay rejects same-timestamp candidate collisions", () => {
  const first = Object.fromEntries(BVH_PROJECTION_HISTORY_HEADERS.map((header, index) => [header, candidate()[index]]));
  const second = { ...first, BVH_Total: 12 };
  assert.throws(() => selectLatestBVHCandidates([first, second]), /BVH_PROJECTION_SNAPSHOT_COLLISION/);
});

test("BVH replay never reconstructs a candidate when no prospective row exists", () => {
  const replay = buildBVHReplay(
    [Array.from(BVH_PROJECTION_HISTORY_HEADERS)],
    [Array.from(ALLOCATION_SETTLEMENT_HEADERS), allocation()],
  );
  assert.deepEqual(replay, []);
  assert.equal(summarizeBVHReplay(replay).n, 0);
});

test("BVH governance cannot reach promotion review before 200 eligible settlements", () => {
  assert.equal(bvhResearchStatus(0), "NO_PROSPECTIVE_SETTLEMENTS");
  assert.equal(bvhResearchStatus(15), "SHADOW_ONLY_PRECHECKPOINT");
  assert.equal(bvhResearchStatus(199), "SHADOW_ONLY_PRECHECKPOINT");
  assert.equal(bvhResearchStatus(200), "PROMOTION_REVIEW_DUE_PAIRED_TEST_REQUIRED");
});
