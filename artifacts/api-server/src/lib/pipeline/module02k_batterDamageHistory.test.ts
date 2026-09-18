import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTER_DAMAGE_DAILY_HEADERS,
  DAMAGE_LINEUP_SHADOW_HEADERS,
  existingBatterDamageSnapshotState,
  parseBatterDamageDailyHistory,
  selectCanonicalBatterDamageHistory,
} from "./module02k_batterDamageHistory.js";

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
  assert.ok(DAMAGE_LINEUP_SHADOW_HEADERS.includes("Collision_Ledger_Status"));
});
