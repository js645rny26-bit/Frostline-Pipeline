import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkloadGameStates,
  buildWorkloadState,
} from "./module02g_workloadState.js";
import type { PitcherWorkloadData, WorkloadResult } from "./module02_pitcherWorkload.js";
import type { NormalizedGame } from "./module06_normalization.js";

function pitcher(overrides: Partial<PitcherWorkloadData> = {}): PitcherWorkloadData {
  return {
    playerId: 10,
    name: "Fixture Pitcher",
    status: "active",
    rolling_stats: {
      l30: { appearances: 5, total_pitch_count: 450, total_innings: 28, avg_pitches_per_appearance: 90 },
      l14: { appearances: 2, total_pitch_count: 180, total_innings: 11, avg_pitches_per_appearance: 90 },
      season: { appearances: 20, total_pitch_count: 1800, total_innings: 110, avg_pitches_per_appearance: 90 },
    },
    recent_games_count: 5,
    recent_appearances: [
      { date: "2026-09-05", game_pk: 1, games_started: 1, innings: 5, pitch_count: 92, batters_faced: 22 },
      { date: "2026-08-30", game_pk: 2, games_started: 1, innings: 6, pitch_count: 97, batters_faced: 24 },
      { date: "2026-08-25", game_pk: 3, games_started: 1, innings: 6, pitch_count: 95, batters_faced: 25 },
      { date: "2026-08-20", game_pk: 4, games_started: 1, innings: 7, pitch_count: 100, batters_faced: 27 },
      { date: "2026-08-15", game_pk: 5, games_started: 1, innings: 6, pitch_count: 94, batters_faced: 23 },
    ],
    ...overrides,
  };
}

test("workload state is pregame-safe, shrunk, and explicitly reports unavailable sources", () => {
  const state = buildWorkloadState("CONVENTIONAL_STARTER", 6, "2026-09-09", pitcher(), undefined);
  assert.equal(state.workload_state_status, "PARTIAL");
  assert.equal(state.projected_ip_shadow, 5.65);
  assert.equal(state.projected_bf_shadow, 24.01);
  assert.equal(state.rest_state, "STANDARD_REST");
  assert.equal(state.team_handling_state, "NOT_MODELED");
  assert.match(state.workload_source_status, /MLB_STATS_API_GAME_LOG/);
  assert.match(state.workload_notes, /transaction_rehab_role_change=UNAVAILABLE/);
});

test("same-day or future game-log rows cannot enter the frozen workload state", () => {
  const state = buildWorkloadState("CONVENTIONAL_STARTER", 6, "2026-09-09", pitcher({
    recent_appearances: [
      { date: "2026-09-09", game_pk: 999, games_started: 1, innings: 9, pitch_count: 120, batters_faced: 27 },
      ...pitcher().recent_appearances,
    ],
  }), undefined);
  assert.equal(state.projected_ip_shadow, 5.65);
  assert.doesNotMatch(state.workload_notes, /latest_pitch_count=120/);
});

test("small samples and unresolved evidence do not manufacture a workload signal", () => {
  const small = buildWorkloadState("BULK", 3, "2026-09-09", pitcher({
    recent_appearances: [{ date: "2026-09-05", game_pk: 1, games_started: 0, innings: 2, pitch_count: 39, batters_faced: 8 }],
  }), undefined);
  assert.equal(small.workload_state_status, "PARTIAL");
  assert.equal(small.workload_confidence, "LOW");

  const unavailable = buildWorkloadState("UNRESOLVED", null, "2026-09-09", undefined, undefined);
  assert.equal(unavailable.workload_state_status, "UNAVAILABLE");
  assert.equal(unavailable.projected_ip_shadow, null);
});

test("game states preserve away/home identity without touching active Expected_IP", () => {
  const workload: WorkloadResult = {
    retrieval_timestamp_utc: "2026-09-08T12:00:00.000Z",
    retrieval_source: "mlb_stats_api",
    data_through_date: "2026-09-07",
    pitchers: [pitcher(), pitcher({ playerId: 20 })],
    status: "success",
  };
  const games = [{
    legacy_game_id: "20260909_AAA_HHH", date: "2026-09-09",
    away_pitcher: { player_id: 10, role: "CONVENTIONAL_STARTER", expected_innings: 6 },
    home_pitcher: { player_id: 20, role: "BULK", expected_innings: 3 },
  }] as unknown as NormalizedGame[];
  const result = buildWorkloadGameStates(games, workload);
  assert.equal(result.get("20260909_AAA_HHH")?.away.projected_ip_shadow, 5.65);
  assert.equal(result.get("20260909_AAA_HHH")?.home.role_state, "BULK");
});
