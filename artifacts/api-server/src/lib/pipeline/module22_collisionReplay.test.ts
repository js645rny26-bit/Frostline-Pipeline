import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLISION_REPLAY_V1_HEADER,
  buildCollisionReplayRows,
  parseCollisionReplayObservations,
  type CollisionReplayObservation,
} from "./module22_collisionReplay.js";

const base: CollisionReplayObservation = {
  base: 7, baseAway: 3, baseHome: 4,
  xwoba: 7.4, xwobaAway: 3.2, xwobaHome: 4.2,
  traffic: 7.5, trafficAway: 3.3, trafficHome: 4.2,
  damage: 7.6, damageAway: 3.1, damageHome: 4.5,
  combinedTail: 8.1, combinedTailAway: 3.4, combinedTailHome: 4.7,
  combined: 8.5, combinedAway: 3.6, combinedHome: 4.9,
  actual: 9, actualAway: 4, actualHome: 5,
  marketLine: 8, tailAdjustment: 1.1,
};

test("Collision Replay V1 compares candidates without mutating the source observation", () => {
  const before = structuredClone(base);
  const rows = buildCollisionReplayRows([base]);
  const allBase = rows.find((row) => row.scope === "ALL_ELIGIBLE" && row.candidate === "BASE");
  const allCombined = rows.find((row) => row.scope === "ALL_ELIGIBLE" && row.candidate === "COMBINED");
  assert.ok(allBase);
  assert.ok(allCombined);
  assert.equal(allBase.mae, 2);
  assert.equal(allBase.high_tail_underprediction_count, 0);
  assert.equal(allCombined.mae, 0.5);
  assert.equal(allCombined.directional_wins, 1);
  assert.equal(allCombined.allocation_mae, 0.25);
  assert.equal(rows.filter((row) => row.scope === "POSITIVE_TAIL").length, 6);
  assert.deepEqual(base, before);
});

test("Collision Replay V1 reports false Overs and fragile-Under reroutes independently", () => {
  const observation: CollisionReplayObservation = {
    ...base,
    combined: 9, actual: 7, actualAway: 3, actualHome: 4,
    marketLine: 8, tailAdjustment: 0.5,
  };
  const combined = buildCollisionReplayRows([observation])
    .find((row) => row.scope === "ALL_ELIGIBLE" && row.candidate === "COMBINED");
  assert.ok(combined);
  assert.equal(combined.false_over_creation_count, 1);
  assert.equal(combined.fragile_under_base_count, 0);
});

test("Collision Replay V1 accepts only settled available candidate rows and preserves legacy gaps", () => {
  const header = [
    "Base_Away_Projection", "Base_Home_Projection", "Base_Projection", "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total",
    "Combined_Tail_Adjustment", "Traffic_Only_Projection", "Damage_Only_Projection", "Combined_Tail_Only_Projection",
    "Collision_Estimated_Projection", "Preview_Availability", "Calibration_Status", "Frozen_Market_Line",
    "xwOBA_Shadow_Projection", "xwOBA_Away_Evidence_Projection", "xwOBA_Home_Evidence_Projection",
    "Traffic_Away_Evidence_Projection", "Traffic_Home_Evidence_Projection", "Damage_Away_Evidence_Projection", "Damage_Home_Evidence_Projection",
  ];
  const valid = [3, 4, 7, 4, 5, 9, 1, 7.5, 7.6, 8, 8.4, "AVAILABLE", "SETTLED", 8, 7.3, 3.1, 4.2, 3.2, 4.3, 3.2, 4.4];
  const unavailable = [...valid];
  unavailable[11] = "NOT_PUBLISHED";
  const legacyMissingVariant = [...valid];
  legacyMissingVariant[14] = "";
  const observations = parseCollisionReplayObservations([header, valid, unavailable, legacyMissingVariant]);
  assert.equal(observations.length, 2);
  assert.equal(observations[1]!.xwoba, null);
  assert.equal(COLLISION_REPLAY_V1_HEADER.length, 20);
});
