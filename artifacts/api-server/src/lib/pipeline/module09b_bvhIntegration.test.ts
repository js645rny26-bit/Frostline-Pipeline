import assert from "node:assert/strict";
import test from "node:test";
import {
  BVH_ACTIVE_INPUT,
  BVH_MATCHUP_BLEND_WEIGHT,
  BVH_PROJECTION_STATUS,
  BVH_PROMOTION_REVIEW_MIN_N,
  isBVHProfileUsable,
  mapBVHStarterWindowFactor,
} from "./module09b_bvhIntegration.js";
import type { BVHLineupProfile } from "./module02j_batterVsHand.js";

const profile: BVHLineupProfile = {
  opposing_pitcher_hand: "R", weighted_shrunk_ops: .8, performance_matchup_factor: 1.1,
  mean_raw_pa: 80, no_sample_count: 0, observed_50_pa_coverage: 1, identity_coverage: 1,
  matched_mlbam_hitters: 9, missing_hitters: [], chain_uncertainty: false, status: "AVAILABLE",
  driver_trace: "1:1:PA=80:SHRUNK=.8:STABLE=.7:RATIO=1.1:OBSERVED_SHRUNK",
  batting_order_weight_source: "FROSTLINE_EXISTING_V36_WEIGHTS",
};

test("BVH mapping reuses the commissioned lineup blend and attenuates projected lineups", () => {
  assert.equal(BVH_MATCHUP_BLEND_WEIGHT, .4);
  assert.equal(mapBVHStarterWindowFactor(profile, "official"), 1.04);
  assert.equal(mapBVHStarterWindowFactor(profile, "projected"), 1.024);
});

test("BVH remains a prospective shadow until its declared review checkpoint", () => {
  assert.equal(mapBVHStarterWindowFactor({ ...profile, status: "NO_SOURCE_DATA" }, "official"), 1);
  assert.equal(BVH_ACTIVE_INPUT, false);
  assert.equal(BVH_PROJECTION_STATUS, "SHADOW_ONLY_PROSPECTIVE_V1");
  assert.equal(BVH_PROMOTION_REVIEW_MIN_N, 200);
});

test("BVH availability is side-local so one unresolved pitching hand cannot erase the other side", () => {
  assert.equal(isBVHProfileUsable(profile), true);
  assert.equal(isBVHProfileUsable({ ...profile, status: "PARTIAL_IDENTITY" }), true);
  assert.equal(isBVHProfileUsable({ ...profile, status: "HAND_UNRESOLVED" }), false);
  assert.equal(isBVHProfileUsable({ ...profile, status: "NO_LINEUP" }), false);
});
