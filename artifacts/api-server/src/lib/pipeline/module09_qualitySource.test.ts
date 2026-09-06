import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTeamBullpenQuality,
  resolveStarterQuality,
} from "./module09_recalculation.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { StatcastPitcherExpectedStats } from "./module02f_statcastPitcherExpected.js";
import type { RelieverStat } from "./module04b_bullpenUsage.js";

function seasonStats(
  pitcher_id: number,
  overrides: Partial<PitcherSeasonStats> = {},
): PitcherSeasonStats {
  return {
    pitcher_id,
    name: `Pitcher ${pitcher_id}`,
    hand: "R",
    era: 4.2,
    fip: 4.1,
    k_pct: 0.22,
    bb_pct: 0.08,
    whip: 1.25,
    hr_per_9: 1.1,
    innings_pitched: "80.0",
    ...overrides,
  };
}

function expected(
  pitcher_id: number,
  xera: number | null,
  pa = 150,
): StatcastPitcherExpectedStats {
  return {
    pitcher_id,
    name: `Pitcher ${pitcher_id}`,
    pa,
    bip: 100,
    era: null,
    xera,
    xwoba_allowed: null,
    xba_allowed: null,
    xslg_allowed: null,
  };
}

function reliever(player_id: number): RelieverStat {
  return {
    player_id,
    full_name: `Reliever ${player_id}`,
    team_abbr: "AAA",
    innings_last_7: 2,
    games_last_7: 2,
    days_rest: 1,
    last_outing_date: "2026-09-05",
    role: "RELIEF",
    notes: "",
    availability_status: "AVAILABLE",
    appearances_last_5: 1,
    pitches_yesterday: 0,
    pitches_2_days_ago: 12,
    pitches_3_days_ago: 0,
    pitches_4_days_ago: 0,
    pitches_5_days_ago: 0,
    workload_source: "MLBSTARTINGNINE_BULLPEN_REPORT",
    source_snapshot_utc: "2026-09-06T16:00:00.000Z",
  };
}

test("traditional starter quality remains the sole source when it exists", () => {
  const resolution = resolveStarterQuality(
    1,
    new Map([[1, seasonStats(1, { fip: 3.2, era: 5.8 })]]),
    new Map([[1, expected(1, 6.5)]]),
  );
  assert.equal(resolution.source, "FIP");
  assert.equal(resolution.factor, 0.7619);
});

test("Savant xERA is a sample-gated fallback rather than a second starter vote", () => {
  const fallback = resolveStarterQuality(
    2,
    new Map([[2, seasonStats(2, { fip: null, era: null })]]),
    new Map([[2, expected(2, 3.6, 100)]]),
  );
  const insufficient = resolveStarterQuality(
    3,
    new Map([[3, seasonStats(3, { fip: null, era: null })]]),
    new Map([[3, expected(3, 2.4, 99)]]),
  );
  assert.deepEqual(fallback, { factor: 0.8571, source: "STATCAST_XERA_FALLBACK" });
  assert.deepEqual(insufficient, { factor: 1, source: "LEAGUE_NEUTRAL" });
});

test("available bullpen uses xERA only for an arm whose season ERA is absent", () => {
  const result = computeTeamBullpenQuality(
    "AAA",
    [reliever(10), reliever(11), reliever(12)],
    new Map([
      [10, seasonStats(10, { era: 3.0 })],
      [11, seasonStats(11, { era: null })],
      [12, seasonStats(12, { era: null })],
    ]),
    new Map([
      [10, expected(10, 8.5)],
      [11, expected(11, 4.2)],
      [12, expected(12, 5.4)],
    ]),
  );
  assert.deepEqual(result, {
    factor: 4.2 / 4.2,
    source: "MIXED_SEASON_ERA_XERA_FALLBACK",
  });
});

test("unqualified expected relievers remain an explicit unavailable-quality gap", () => {
  const result = computeTeamBullpenQuality(
    "AAA",
    [reliever(20), reliever(21)],
    new Map([
      [20, seasonStats(20, { era: null })],
      [21, seasonStats(21, { era: null })],
    ]),
    new Map([
      [20, expected(20, 3.4, 99)],
      [21, expected(21, 3.8, 99)],
    ]),
  );
  assert.equal(result, null);
});
