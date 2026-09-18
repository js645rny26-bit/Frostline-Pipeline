import assert from "node:assert/strict";
import test from "node:test";

import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import {
  BATTER_DAMAGE_USABLE_BBE_MIN,
  buildBatterDamageDataset,
  buildDamageLineupProfile,
  classifyBatterDamageSample,
  deriveBatterDamageDailyAggregates,
  resolveDamageLineupState,
  resolvePatchBDamageIdentity,
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
  assert.equal(a.profiles.get(101)?.sample_status, "LOW_SAMPLE");
  assert.equal(a.deterministic_hash, b.deterministic_hash);
  assert.throws(
    () => buildBatterDamageDataset([{ ...rows[0]!, game_date: "2026-09-17" }], "2026-09-17"),
    /BATTER_DAMAGE_CUTOFF_VIOLATION/,
  );
});

test("sample adequacy uses the fixed ex-ante 25-BBE precision threshold", () => {
  assert.equal(BATTER_DAMAGE_USABLE_BBE_MIN, 25);
  assert.equal(classifyBatterDamageSample(0), "NO_SAMPLE");
  assert.equal(classifyBatterDamageSample(1), "LOW_SAMPLE");
  assert.equal(classifyBatterDamageSample(24), "LOW_SAMPLE");
  assert.equal(classifyBatterDamageSample(25), "USABLE_SAMPLE");
});

test("dataset accumulates immutable daily evidence without double-counting a date", () => {
  const rows = [
    { game_date: "2026-09-15", batter_mlbam_id: 101, bbe: 12, hard_hits: 5, barrels: 1, barrel_known_bbe: 12, xbh: 2, home_runs: 1, exit_velocity_sum: 1080 },
    { game_date: "2026-09-16", batter_mlbam_id: 101, bbe: 13, hard_hits: 6, barrels: 2, barrel_known_bbe: 13, xbh: 3, home_runs: 1, exit_velocity_sum: 1183 },
  ];
  const a = buildBatterDamageDataset(rows, "2026-09-17");
  const b = buildBatterDamageDataset(rows, "2026-09-17");
  const changed = buildBatterDamageDataset([{ ...rows[0]!, hard_hits: 6 }, rows[1]!], "2026-09-17");
  assert.equal(a.profiles.get(101)?.bbe, 25);
  assert.equal(a.profiles.get(101)?.sample_status, "USABLE_SAMPLE");
  assert.equal(a.deterministic_hash, b.deterministic_hash);
  assert.notEqual(a.deterministic_hash, changed.deterministic_hash);
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
  assert.equal(profile.low_sample_hitters, 2);
  assert.equal(profile.usable_sample_hitters, 0);
  assert.equal(profile.weighted_usable_coverage, 0);
  assert.equal(profile.total_bbe, 20);
  assert.ok((profile.weighted_hard_hit_pct ?? 0) > 39);
  assert.ok((profile.weighted_hard_hit_pct ?? 0) < 41);
});

test("missing and no-sample identities stay explicit and never count as observed or usable", () => {
  const dataset = buildBatterDamageDataset([
    { game_date: "2026-09-16", batter_mlbam_id: 999, bbe: 4, hard_hits: 1, barrels: 0, barrel_known_bbe: 4, xbh: 0, home_runs: 0, exit_velocity_sum: 340 },
  ], "2026-09-17", undefined, [101]);
  const profile = buildDamageLineupProfile([
    { batting_order: 1, name: "Alpha Hitter", handedness: "R", position: "CF" },
    { batting_order: 2, name: "Missing Hitter", handedness: "L", position: "1B" },
  ], new Map([["alpha hitter", 101]]), dataset);
  assert.equal(profile.observed_hitters, 0);
  assert.equal(profile.usable_sample_hitters, 0);
  assert.equal(profile.no_sample_hitters, 1);
  assert.equal(profile.weighted_observed_coverage, 0);
  assert.equal(profile.weighted_usable_coverage, 0);
  assert.match(profile.driver_trace, /SAMPLE_STATUS=NO_SAMPLE:IMPUTED=LEAGUE/);
  assert.match(profile.driver_trace, /UNRESOLVED:MISSING_IDENTITY:IMPUTED=LEAGUE/);
});

test("resolved identity without a retained profile is no-sample, not an identity miss", () => {
  const dataset = buildBatterDamageDataset([
    { game_date: "2026-09-16", batter_mlbam_id: 999, bbe: 4, hard_hits: 1, barrels: 0, barrel_known_bbe: 4, xbh: 0, home_runs: 0, exit_velocity_sum: 340 },
  ], "2026-09-17");
  const profile = buildDamageLineupProfile([
    { batting_order: 1, name: "Dansby Swanson", handedness: "R", position: "SS" },
  ], new Map(), dataset);
  assert.equal(profile.status, "AVAILABLE");
  assert.equal(profile.matched_mlbam_hitters, 1);
  assert.equal(profile.identity_coverage, 1);
  assert.equal(profile.no_sample_hitters, 1);
  assert.deepEqual(profile.missing_hitters, []);
  assert.match(profile.driver_trace, /621020:BBE=0:.*STATUS=NO_SOURCE_PROFILE:SAMPLE_STATUS=NO_SAMPLE:IMPUTED=LEAGUE/);
});

test("Patch B exact identity registry resolves only verified aliases", () => {
  assert.equal(resolvePatchBDamageIdentity("Dansby Swanson", new Map()), 621020);
  assert.equal(resolvePatchBDamageIdentity("Kiké Hernández", new Map()), 571771);
  assert.equal(resolvePatchBDamageIdentity("Unknown Hitter", new Map()), undefined);
});

test("lineup state preserves projected, confirmed, mixed, partial, and unknown source states", () => {
  const players = Array.from({ length: 9 }, (_, index) => ({
    batting_order: index + 1, name: `Hitter ${index + 1}`, handedness: "R", position: "OF",
  }));
  const base = {
    game_id: "g", away_abbr: "A", home_abbr: "H", venue: "Park",
    lineup_status: "projected" as const, park_factors: {} as never,
    away_lineup: players, home_lineup: players,
  };
  assert.equal(resolveDamageLineupState(base), "PROJECTED");
  assert.equal(resolveDamageLineupState({ ...base, lineup_status: "official", away_lineup_status: "official", home_lineup_status: "official" }), "CONFIRMED");
  assert.equal(resolveDamageLineupState({ ...base, away_lineup_status: "official", home_lineup_status: "projected" }), "PARTIAL");
  assert.equal(resolveDamageLineupState({ ...base, away_lineup: players.slice(0, 8) }), "PARTIAL");
  assert.equal(resolveDamageLineupState(undefined), "UNKNOWN");
});
