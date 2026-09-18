import assert from "node:assert/strict";
import test from "node:test";

import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import {
  buildBatterDamageDataset,
  buildDamageLineupProfile,
  deriveBatterDamageDailyAggregates,
} from "./module02k_batterDamage.js";

function pitch(overrides: Partial<SavantPitchLevelEvent> = {}): SavantPitchLevelEvent {
  return {
    game_date: "2026-09-16", game_pk: 1, at_bat_number: 1, batter: 101,
    pitcher: 201, stand: "R", p_throws: "L", pitch_type: "FF",
    events: "", description: "foul", raw: new Map([
      ["pitch_number", "1"], ["launch_speed", ""], ["launch_speed_angle", ""],
    ]),
    ...overrides,
  };
}

test("damage derivation counts one batted ball per PA and uses the 95 mph boundary", () => {
  const duplicate = pitch({
    events: "home_run",
    description: "hit_into_play",
    raw: new Map([["pitch_number", "4"], ["launch_speed", "101.2"], ["launch_speed_angle", "6"]]),
  });
  const result = deriveBatterDamageDailyAggregates([
    pitch(),
    duplicate,
    { ...duplicate, raw: new Map([["pitch_number", "3"], ["launch_speed", "101.2"], ["launch_speed_angle", "6"]]) },
    pitch({
      at_bat_number: 2,
      events: "field_out",
      raw: new Map([["pitch_number", "2"], ["launch_speed", "95"], ["launch_speed_angle", "4"]]),
    }),
  ]);
  assert.equal(result.aggregates.length, 1);
  assert.deepEqual(result.aggregates[0], {
    game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 2, hard_hits: 2,
    barrels: 1, barrel_known_bbe: 2, xbh: 1, home_runs: 1,
    exit_velocity_sum: 196.2,
  });
  assert.equal(result.integrity.duplicate_batted_ball_rows, 1);
});

test("damage dataset is D-1 cutoff-safe and deterministic", () => {
  const rows = [{
    game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 4, hard_hits: 2,
    barrels: 1, barrel_known_bbe: 4, xbh: 1, home_runs: 1, exit_velocity_sum: 360,
  }];
  const a = buildBatterDamageDataset(rows, "2026-09-17");
  const b = buildBatterDamageDataset(rows, "2026-09-17");
  assert.equal(a.profiles.get(101)?.hard_hit_pct, 50);
  assert.equal(a.profiles.get(101)?.avg_exit_velocity, 90);
  assert.equal(a.deterministic_hash, b.deterministic_hash);
  assert.throws(
    () => buildBatterDamageDataset([{ ...rows[0]!, game_date: "2026-09-17" }], "2026-09-17"),
    /BATTER_DAMAGE_CUTOFF_VIOLATION/,
  );
});

test("exact-lineup profile preserves identity, samples, and batting-order weighting", () => {
  const dataset = buildBatterDamageDataset([
    { game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 10, hard_hits: 6, barrels: 1, barrel_known_bbe: 10, xbh: 2, home_runs: 1, exit_velocity_sum: 910 },
    { game_date: "2026-09-16", batter_mlbam_id: 102, bbe: 10, hard_hits: 2, barrels: 0, barrel_known_bbe: 10, xbh: 1, home_runs: 0, exit_velocity_sum: 870 },
  ], "2026-09-17");
  const profile = buildDamageLineupProfile([
    { batting_order: 1, name: "Alpha Hitter", handedness: "R", position: "CF" },
    { batting_order: 2, name: "Beta Hitter", handedness: "L", position: "1B" },
  ], new Map([["alpha hitter", 101], ["beta hitter", 102]]), dataset);
  assert.equal(profile.status, "AVAILABLE");
  assert.equal(profile.identity_coverage, 1);
  assert.equal(profile.observed_coverage, 1);
  assert.equal(profile.total_bbe, 20);
  assert.ok((profile.weighted_hard_hit_pct ?? 0) > 39);
  assert.ok((profile.weighted_hard_hit_pct ?? 0) < 41);
});
