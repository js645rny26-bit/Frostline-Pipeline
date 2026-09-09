import assert from "node:assert/strict";
import test from "node:test";
import type { BatterSeasonStats } from "./module02c_batterSeasonStats.js";
import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import {
  BVH_SHRINKAGE_K,
  assertBVHCutoff,
  buildBVHDatasetFromDailyAggregates,
  buildBVHLineupProfile,
  deriveBVHDailyAggregates,
  type BVHCounts,
  type BVHDailyAggregate,
} from "./module02j_batterVsHand.js";
import type { LineupPlayer } from "./module04c_startingNine.js";
import { buildTodayLineupsRows } from "./module08_feedWriter.js";

function pitch(overrides: Partial<SavantPitchLevelEvent> = {}): SavantPitchLevelEvent {
  const atBat = overrides.at_bat_number ?? 1;
  const pitchNumber = Number(overrides.raw?.get("pitch_number") ?? 1);
  return {
    game_date: "2026-09-06", game_pk: 1, at_bat_number: atBat,
    batter: 101, pitcher: 201, stand: "R", p_throws: "R", pitch_type: "FF",
    events: "", description: "ball", raw: new Map([["pitch_number", String(pitchNumber)]]),
    ...overrides,
  };
}

function agg(date: string, batter: number, hand: "L" | "R", counts: Partial<BVHCounts>): BVHDailyAggregate {
  return {
    game_date: date, batter_mlbam_id: batter, pitcher_hand: hand,
    pa: 0, ab: 0, hits: 0, bb: 0, ibb: 0, hbp: 0, sf: 0, total_bases: 0,
    ...counts,
  };
}

test("BVH reduces a nine-pitch at-bat to one terminal plate appearance", () => {
  const events = Array.from({ length: 9 }, (_, index) => pitch({
    at_bat_number: 7,
    events: index === 8 ? "double" : "",
    raw: new Map([["pitch_number", String(index + 1)]]),
  }));
  const result = deriveBVHDailyAggregates(events);
  assert.equal(result.integrity.pitch_rows_inspected, 9);
  assert.equal(result.integrity.terminal_pa_count, 1);
  assert.equal(result.aggregates[0]?.pa, 1);
  assert.equal(result.aggregates[0]?.ab, 1);
  assert.equal(result.aggregates[0]?.total_bases, 2);
});

test("BVH event classification calculates OBP, SLG, OPS, and exposes malformed and unknown PAs", () => {
  const events = [
    pitch({ at_bat_number: 1, events: "single" }),
    pitch({ at_bat_number: 2, events: "walk" }),
    pitch({ at_bat_number: 3, events: "sac_fly" }),
    pitch({ at_bat_number: 4, events: "future_event" }),
    pitch({ at_bat_number: 5, events: "" }),
    pitch({ at_bat_number: 6, events: "strikeout_double_play" }),
    pitch({ at_bat_number: 7, events: "sac_fly_double_play" }),
    pitch({ at_bat_number: 8, events: "truncated_pa" }),
  ];
  const result = deriveBVHDailyAggregates(events);
  const line = result.aggregates[0]!;
  assert.deepEqual({ pa: line.pa, ab: line.ab, hits: line.hits, bb: line.bb, sf: line.sf, total_bases: line.total_bases },
    { pa: 5, ab: 2, hits: 1, bb: 1, sf: 2, total_bases: 1 });
  assert.equal(result.integrity.unclassified_events, 1);
  assert.deepEqual(result.integrity.unclassified_event_values, ["future_event"]);
  assert.equal(result.integrity.no_terminal_event_count, 1);
  assert.equal(result.integrity.malformed_pa_count, 1);
  assert.equal(result.integrity.excluded_non_pa_events, 1);
  assert.deepEqual(result.integrity.excluded_non_pa_event_values, ["truncated_pa"]);
});

test("BVH can use an eligible player historical prior when the current-hand league baseline is absent", () => {
  const dataset = buildBVHDatasetFromDailyAggregates([
    agg("2025-08-01", 1, "L", { pa: 200, ab: 200, hits: 50, total_bases: 100 }),
    agg("2026-09-07", 2, "R", { pa: 10, ab: 10, hits: 2, total_bases: 3 }),
  ], "2026-09-08", undefined, [1]);
  const estimate = dataset.estimates.get(1)?.vs_lhp;
  assert.equal(estimate?.prior_source, "PLAYER_HISTORICAL");
  assert.equal(estimate?.status, "NO_SPLIT_SAMPLE");
  assert.equal(estimate?.shrunk_ops, estimate?.prior_ops);
});

test("BVH cutoff and freshness can never label future or stale evidence as current", () => {
  assert.throws(() => assertBVHCutoff([agg("2026-09-08", 1, "R", {})], "2026-09-07"), /BVH_CUTOFF_VIOLATION/);
  const stale = buildBVHDatasetFromDailyAggregates([
    agg("2026-09-05", 1, "L", { pa: 1, ab: 1, hits: 1, total_bases: 1 }),
    agg("2026-09-05", 2, "R", { pa: 1, ab: 1, hits: 1, total_bases: 1 }),
  ], "2026-09-08");
  assert.equal(stale.requested_through_date, "2026-09-07");
  assert.equal(stale.actual_data_through_date, "2026-09-05");
  assert.equal(stale.freshness_status, "STALE_GT_1D");
  assert.equal(stale.freshness_lag_days, 2);
});

test("BVH uses a same-hand historical player prior at 200 PA and otherwise a cutoff-specific league prior", () => {
  const rows = [
    agg("2025-08-01", 1, "R", { pa: 200, ab: 200, hits: 100, total_bases: 200 }),
    agg("2026-09-07", 1, "R", { pa: 50, ab: 50, hits: 10, total_bases: 15 }),
    agg("2026-09-07", 2, "R", { pa: 50, ab: 50, hits: 20, total_bases: 30 }),
    agg("2026-09-07", 1, "L", { pa: 0 }),
    agg("2026-09-07", 2, "L", { pa: 50, ab: 50, hits: 15, total_bases: 20 }),
  ];
  const dataset = buildBVHDatasetFromDailyAggregates(rows, "2026-09-08");
  const oneR = dataset.estimates.get(1)?.vs_rhp;
  const oneL = dataset.estimates.get(1)?.vs_lhp;
  assert.equal(oneR?.prior_source, "PLAYER_HISTORICAL");
  assert.equal(oneR?.shrinkage_weight, 50 / (50 + BVH_SHRINKAGE_K));
  assert.equal(oneL?.status, "NO_SPLIT_SAMPLE");
  assert.equal(oneL?.shrinkage_weight, 0);
  assert.equal(oneL?.shrunk_ops, oneL?.prior_ops);
  assert.equal(oneL?.prior_source, "LEAGUE_BASELINE");
  assert.equal(dataset.freshness_status, "CURRENT");
});

test("BVH build is deterministic and preserves more than 30 unrounded hitter values when composition permits", () => {
  const rows: BVHDailyAggregate[] = [];
  for (let id = 1; id <= 40; id++) {
    rows.push(agg("2026-09-07", id, "R", {
      pa: 100 + id, ab: 100 + id, hits: 20 + id, total_bases: 30 + id * 2,
    }));
    rows.push(agg("2026-09-07", id, "L", {
      pa: 100 + id, ab: 100 + id, hits: 18 + id, total_bases: 25 + id * 2,
    }));
  }
  const first = buildBVHDatasetFromDailyAggregates(rows, "2026-09-08");
  const second = buildBVHDatasetFromDailyAggregates([...rows].reverse(), "2026-09-08");
  assert.equal(first.deterministic_hash, second.deterministic_hash);
  assert.ok(new Set([...first.estimates.values()].map((value) => value.vs_rhp?.shrunk_ops)).size > 30);
});

test("BVH lineup aggregation uses exact MLBAM identity, established weights, and explicit coverage", () => {
  const rows: BVHDailyAggregate[] = [];
  const lineup: LineupPlayer[] = [];
  const names = new Map<string, number>();
  const stats = new Map<number, BatterSeasonStats>();
  for (let index = 0; index < 9; index++) {
    const id = 101 + index;
    lineup.push({ batting_order: index + 1, name: `Hitter ${index + 1}`, handedness: "R", position: "OF" });
    names.set(`hitter ${index + 1}`, id);
    stats.set(id, { batter_id: id, name: `Hitter ${index + 1}`, bat_hand: "R", obp: .3, slg: .4, ops: .7, k_pct: null, bb_pct: null, plate_appearances: 200 });
    rows.push(agg("2026-09-07", id, "R", { pa: index < 7 ? 60 : 20, ab: index < 7 ? 60 : 20, hits: 20, total_bases: 30 }));
    rows.push(agg("2026-09-07", id, "L", { pa: 10, ab: 10, hits: 3, total_bases: 4 }));
  }
  const dataset = buildBVHDatasetFromDailyAggregates(rows, "2026-09-08");
  const profile = buildBVHLineupProfile(lineup, "R", names, stats, dataset);
  assert.equal(profile.status, "AVAILABLE");
  assert.equal(profile.matched_mlbam_hitters, 9);
  assert.equal(profile.identity_coverage, 1);
  assert.equal(profile.observed_50_pa_coverage, 0.777778);
  assert.ok(profile.weighted_shrunk_ops !== null);
  assert.ok(profile.performance_matchup_factor > 0);
  assert.equal(profile.missing_hitters.length, 0);
  assert.match(profile.driver_trace, /1:101:PA=60/);
});

test("TODAY_LINEUPS materializes MLBAM identity, both shrunk splits, raw PA, status, and prior source", () => {
  const dataset = buildBVHDatasetFromDailyAggregates([
    agg("2026-09-07", 101, "R", { pa: 60, ab: 60, hits: 20, total_bases: 30 }),
    agg("2026-09-07", 101, "L", { pa: 40, ab: 40, hits: 10, total_bases: 20 }),
  ], "2026-09-08", undefined, [101]);
  const game = {
    date: "2026-09-08", legacy_game_id: "20260908_AAA_BBB",
    away_team: { team_abbr: "AAA" }, home_team: { team_abbr: "BBB" },
  } as never;
  const lineups = new Map([["20260908_AAA_BBB", {
    game_id: "20260908_AAA_BBB", away_abbr: "AAA", home_abbr: "BBB", venue: "Park",
    lineup_status: "official" as const, park_factors: { runs_pct: 0, hr_l_pct: 0, hr_r_pct: 0, woba_l_pct: 0, woba_r_pct: 0 },
    away_lineup: [{ batting_order: 1, name: "Hitter One", handedness: "R", position: "RF" }], home_lineup: [],
  }]]);
  const rows = buildTodayLineupsRows([game], lineups, dataset, new Map([["hitter one", 101]]));
  assert.equal(rows.length, 18);
  assert.equal(rows[0]?.[5], 101);
  assert.equal(rows[0]?.[7], dataset.estimates.get(101)?.vs_lhp?.shrunk_ops);
  assert.equal(rows[0]?.[8], dataset.estimates.get(101)?.vs_rhp?.shrunk_ops);
  assert.equal(rows[0]?.[14], "OBSERVED_SHRUNK");
  assert.equal(rows[0]?.[16], 40);
  assert.equal(rows[0]?.[17], 60);
  assert.equal(rows[0]?.[18], "LEAGUE_BASELINE");
  assert.equal(rows[0]?.[19], "LEAGUE_BASELINE");
});
