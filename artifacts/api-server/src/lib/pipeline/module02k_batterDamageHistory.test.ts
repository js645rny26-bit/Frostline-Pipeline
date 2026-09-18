import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTER_DAMAGE_DAILY_HEADERS,
  BATTER_DAMAGE_MATURITY_HEADERS,
  BATTER_DAMAGE_PROFILE_HEADERS,
  DAMAGE_LINEUP_SHADOW_HEADERS,
  existingBatterDamageSnapshotState,
  parseBatterDamageDailyHistory,
  selectCanonicalBatterDamageHistory,
  summarizeBatterDamageMaturity,
} from "./module02k_batterDamageHistory.js";
import { buildBatterDamageDataset, buildDamageLineupProfile } from "./module02k_batterDamage.js";

const aggregate = {
  game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 2, hard_hits: 1,
  barrels: 0, barrel_known_bbe: 2, xbh: 1, home_runs: 0, exit_velocity_sum: 181,
};

test("damage history parses by header and verifies complete immutable snapshots", () => {
  const row = ["2026-09-16", 101, 2, 1, 0, 2, 1, 0, 181, "snap", "2026-09-17T01:00:00Z", "2026-09-16", "1.0.0"];
  const parsed = parseBatterDamageDailyHistory([Array.from(BATTER_DAMAGE_DAILY_HEADERS), row]);
  assert.equal(existingBatterDamageSnapshotState(parsed, "snap", [aggregate]), "COMPLETE");
  assert.throws(
    () => existingBatterDamageSnapshotState(parsed, "snap", [{ ...aggregate, hard_hits: 2 }]),
    /PARTIAL_SNAPSHOT/,
  );
});

test("damage history selects one latest source snapshot per game date", () => {
  const base = { ...aggregate, source_snapshot_id: "old", source_fetch_ts: "2026-09-17T01:00:00Z", data_through_date: "2026-09-16" };
  const selected = selectCanonicalBatterDamageHistory([
    base,
    { ...base, hard_hits: 2, source_snapshot_id: "new", source_fetch_ts: "2026-09-17T02:00:00Z" },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.source_snapshot_id, "new");
  assert.equal(selected[0]?.hard_hits, 2);
});

test("lineup shadow contract remains research-only and explicit", () => {
  assert.ok(DAMAGE_LINEUP_SHADOW_HEADERS.includes("Active_Input"));
  assert.ok(DAMAGE_LINEUP_SHADOW_HEADERS.includes("Lineup_State"));
  assert.ok(DAMAGE_LINEUP_SHADOW_HEADERS.includes("Away_Weighted_Usable_Coverage"));
  assert.ok(DAMAGE_LINEUP_SHADOW_HEADERS.includes("Collision_Ledger_Status"));
  assert.ok(BATTER_DAMAGE_PROFILE_HEADERS.includes("Sample_Status"));
  assert.ok(BATTER_DAMAGE_MATURITY_HEADERS.includes("Usable_Sample_Hitters"));
});

test("maturity summary separates observed, low, usable, no-sample, and lineup state", () => {
  const dataset = buildBatterDamageDataset([
    { game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 25, hard_hits: 10, barrels: 2, barrel_known_bbe: 25, xbh: 4, home_runs: 2, exit_velocity_sum: 2250 },
    { game_date: "2026-09-16", batter_mlbam_id: 102, bbe: 4, hard_hits: 1, barrels: 0, barrel_known_bbe: 4, xbh: 0, home_runs: 0, exit_velocity_sum: 340 },
  ], "2026-09-17", undefined, [103]);
  const players = [
    { batting_order: 1, name: "Usable", handedness: "R", position: "CF" },
    { batting_order: 2, name: "Low", handedness: "L", position: "1B" },
    { batting_order: 3, name: "None", handedness: "R", position: "SS" },
  ];
  const profile = buildDamageLineupProfile(players, new Map([
    ["usable", 101], ["low", 102], ["none", 103],
  ]), dataset);
  const result = summarizeBatterDamageMaturity([{
    date: "2026-09-17", game_id: "g", snapshot_ts: "ts", lineup_state: "PROJECTED",
    away: profile, home: profile, dataset,
  }]);
  assert.equal(result?.total_lineup_hitters, 6);
  assert.equal(result?.observed_hitters, 4);
  assert.equal(result?.low_sample_hitters, 2);
  assert.equal(result?.usable_sample_hitters, 2);
  assert.equal(result?.no_sample_hitters, 2);
  assert.equal(result?.projected_games, 1);
  assert.equal(result?.teams_zero_usable, 0);
  assert.equal(result?.teams_full_usable, 0);
  assert.ok((result?.weighted_observed_coverage ?? 0) > (result?.weighted_usable_coverage ?? 0));
});
