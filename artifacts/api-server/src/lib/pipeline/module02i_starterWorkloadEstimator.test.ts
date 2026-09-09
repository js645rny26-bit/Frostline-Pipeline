import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SWE_OPENER_BOUND_IP,
  SWE_SHRINKAGE_K,
  buildStarterWorkloadEstimatorStates,
  deriveSWEAppearances,
  estimateStarterWorkload,
  type SWEAppearance,
} from "./module02i_starterWorkloadEstimator.js";
import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import type { NormalizedGame } from "./module06_normalization.js";

function start(pitcher: number, index: number, innings: number, date = `2026-08-${String(10 + index).padStart(2, "0")}`): SWEAppearance {
  return {
    game_date: date, game_pk: pitcher * 100 + index, pitcher_id: pitcher,
    pitches_thrown: 85, batters_faced: 22, outs_recorded: Math.round(innings * 3),
    innings_pitched: innings, max_thruorder: 3, started_game: true,
    pitcher_days_since_prev_game: 5, outs_status: "AVAILABLE",
  };
}

function game(id: string, awayId: number, homeId: number): NormalizedGame {
  return {
    legacy_game_id: id,
    away_pitcher: { player_id: awayId, role: "CONVENTIONAL_STARTER" },
    home_pitcher: { player_id: homeId, role: "CONVENTIONAL_STARTER" },
  } as unknown as NormalizedGame;
}

function event(gamePk: number, pitcher: number, atBat: number, outsWhenUp: number, next: number | null, inning = 1, half = "Top"): SavantPitchLevelEvent {
  return {
    game_date: "2026-09-01", game_pk: gamePk, at_bat_number: atBat,
    batter: 500 + atBat, pitcher,
    stand: "L", p_throws: "R", pitch_type: "FF", events: "", description: "ball",
    raw: new Map([
      ["inning", String(inning)], ["inning_topbot", half], ["at_bat_number", String(atBat)],
      ["outs_when_up", String(outsWhenUp)], ["n_throughorder_pitcher", "1"],
      ["pitcher_days_since_prev_game", "5"], ["pitch_number", String(next ?? 1)],
    ]),
  };
}

test("SWE derives outs from next PA state rather than events and marks unresolved appearances", () => {
  const resolved = deriveSWEAppearances([
    event(1, 10, 1, 0, 1), event(1, 10, 2, 1, null), event(1, 11, 3, 0, null, 1, "Bot"),
  ], "2026-09-01");
  assert.equal(resolved[0]?.outs_recorded, 3);
  assert.equal(resolved[0]?.innings_pitched, 1);
  assert.equal(resolved[0]?.started_game, true);

  const unresolved = deriveSWEAppearances([
    event(2, 20, 1, 2, null), event(2, 20, 2, 1, null),
  ], "2026-09-01");
  assert.equal(unresolved[0]?.outs_status, "OUTS_UNRESOLVED");
  assert.equal(unresolved[0]?.innings_pitched, null);
});

test("SWE applies frozen L3/L5/season weights and k=4 shrinkage to a recalculated role prior", () => {
  const appearances = [
    ...[6, 5, 7, 4, 6, 5].flatMap((innings, index) => start(10, index, innings)),
    ...[5, 5, 5, 5, 5, 5].flatMap((innings, index) => start(20, index, innings)),
  ];
  const states = buildStarterWorkloadEstimatorStates([game("A", 10, 20)], appearances, "2026-09-07", "2026-09-06");
  const away = states.states.get("A")!.away;
  assert.equal(states.conventional_role_prior, 5.25);
  assert.equal(away.l3_ip, 5);
  assert.equal(away.l5_ip, 5.4);
  assert.equal(away.season_ip, 5.5);
  assert.equal(away.shrinkage_weight, 0.6);
  assert.equal(away.expected_ip, 5.232);
  assert.equal(away.data_through_date, "2026-09-06");
  assert.match(away.notes, new RegExp(`k=${SWE_SHRINKAGE_K}`));
});

test("SWE keeps designed opener/bulk behavior explicit and never invents missing history", () => {
  const starts = [4, 4, 4].flatMap((innings, index) => start(30, index, innings));
  const opener = estimateStarterWorkload(30, "OPENER", "2026-09-07", "2026-09-06", starts, 5.3);
  assert.equal(opener.status, "ROLE_BOUNDED");
  assert.equal(opener.expected_ip, SWE_OPENER_BOUND_IP);
  const bulk = estimateStarterWorkload(31, "BULK", "2026-09-07", "2026-09-06", [], 5.3);
  assert.equal(bulk.status, "INSUFFICIENT_HISTORY");
  assert.equal(bulk.expected_ip, 3);
  const conventional = estimateStarterWorkload(32, "CONVENTIONAL_STARTER", "2026-09-07", "2026-09-06", [], 5.3);
  assert.equal(conventional.status, "INSUFFICIENT_HISTORY");
  assert.equal(conventional.expected_ip, 5.3);
});

test("SWE emits exactly one deterministic source-only state per scheduled starter and does not collapse to role lookup values", () => {
  const appearances: SWEAppearance[] = [];
  const games: NormalizedGame[] = [];
  for (let i = 0; i < 11; i++) {
    const away = 100 + i * 2;
    const home = away + 1;
    games.push(game(`G${i}`, away, home));
    for (const id of [away, home]) {
      for (let outing = 0; outing < 6; outing++) appearances.push(start(id, outing, 4 + i * 0.17 + (outing % 3) * 0.2));
    }
  }
  const first = buildStarterWorkloadEstimatorStates(games, appearances, "2026-09-07", "2026-09-06");
  const second = buildStarterWorkloadEstimatorStates(games, appearances, "2026-09-07", "2026-09-06");
  assert.equal(first.states.size, games.length);
  assert.deepEqual(first, second);
  assert.equal(first.distinct_expected_ip > 10, true);
  for (const state of first.states.values()) {
    assert.equal(state.away.data_through_date, "2026-09-06");
    assert.equal(state.home.data_through_date, "2026-09-06");
    assert.notEqual(state.away.status, "INSUFFICIENT_HISTORY");
  }
});

test("SWE has no active projection, survival, collision, authorization, or board consumer", () => {
  for (const module of [
    "module09_recalculation.ts",
    "module09t_starterSurvivalShadow.ts",
    "module09u_starterSurvivalV2Shadow.ts",
    "module11_outputExtraction.ts",
    "module17_vehiclePostmortem.ts",
  ]) {
    const source = readFileSync(new URL(`./${module}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /SWE_/);
    assert.doesNotMatch(source, /starterWorkloadEstimator/);
  }
});
