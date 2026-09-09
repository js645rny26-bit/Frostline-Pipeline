import assert from "node:assert/strict";
import test from "node:test";
import {
  BVH_ACTIVE_INPUT,
  BVH_MATCHUP_BLEND_WEIGHT,
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

test("unavailable BVH evidence is neutral and the test copy cannot alter active projection", () => {
  assert.equal(mapBVHStarterWindowFactor({ ...profile, status: "NO_SOURCE_DATA" }, "official"), 1);
  assert.equal(BVH_ACTIVE_INPUT, false);
});

test("BVH availability is side-local so one unresolved pitching hand cannot erase the other side", () => {
  assert.equal(isBVHProfileUsable(profile), true);
  assert.equal(isBVHProfileUsable({ ...profile, status: "PARTIAL_IDENTITY" }), true);
  assert.equal(isBVHProfileUsable({ ...profile, status: "HAND_UNRESOLVED" }), false);
  assert.equal(isBVHProfileUsable({ ...profile, status: "NO_LINEUP" }), false);
});
