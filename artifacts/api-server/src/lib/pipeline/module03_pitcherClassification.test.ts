import assert from "node:assert/strict";
import test from "node:test";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";
import type { PitcherWorkloadData, WorkloadResult } from "./module02_pitcherWorkload.js";
import { classifyPitcherRoles } from "./module03_pitcherClassification.js";

function pitcher(playerId: number, status: string, innings: number[], pitches: number[]): PitcherWorkloadData {
  return {
    playerId,
    name: "Fixture",
    status,
    rolling_stats: {
      l30: {
        appearances: innings.length,
        total_pitch_count: pitches.reduce((sum, value) => sum + value, 0),
        total_innings: innings.reduce((sum, value) => sum + value, 0),
        avg_pitches_per_appearance: pitches.length === 0
          ? 0
          : Math.round(pitches.reduce((sum, value) => sum + value, 0) / pitches.length),
      },
      l14: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
      season: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
    },
    recent_games_count: innings.length,
    recent_appearances: innings.map((value, index) => ({
      date: `2026-09-0${8 - index}`,
      game_pk: 100 + index,
      games_started: 1,
      innings: value,
      pitch_count: pitches[index] ?? null,
      batters_faced: null,
    })),
  };
}

const manifest: GameScheduleResult = {
  retrieval_timestamp_utc: "2026-09-09T12:00:00.000Z",
  date: "2026-09-09",
  total_games: 1,
  status: "success",
  games: [{
    gamePk: 1,
    legacy_game_id: "20260909_AAA_BBB",
    officialDate: "2026-09-09",
    gameDateTime: "2026-09-09T23:00:00.000Z",
    venue: { id: 1, name: "Fixture Park", timeZone: "America/New_York" },
    awayTeam: { id: 1, name: "Away", abbreviation: "AAA" },
    homeTeam: { id: 2, name: "Home", abbreviation: "BBB" },
    awayProbablePitcher: { id: 10, fullName: "Pitcher Specific", hand: "R" },
    homeProbablePitcher: { id: 20, fullName: "Missing Evidence", hand: "L" },
    status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
    doubleheaderStatus: "N",
    gameNumber: 1,
  }],
};

test("Module 03 consumes pitcher-specific workload while preserving the missing-evidence fallback", () => {
  const workload: WorkloadResult = {
    retrieval_timestamp_utc: "2026-09-09T12:00:00.000Z",
    retrieval_source: "mlb_stats_api",
    data_through_date: "2026-09-08",
    status: "success",
    pitchers: [
      pitcher(10, "active", [5, 4.667, 4.333, 4, 3.667], [75, 70, 67, 64, 60]),
      pitcher(20, "no_games_in_window", [], []),
    ],
  };

  const result = classifyPitcherRoles(manifest, workload).games[0]!;
  assert.equal(result.away_pitcher.role, "CONVENTIONAL_STARTER");
  assert.equal(result.away_pitcher.expected_innings, 4.15);
  assert.equal(result.away_pitcher.expected_pitches, 63);
  assert.match(result.away_pitcher.reasoning, /rest_state=SHORT_REST/);
  assert.ok(result.away_pitcher.workload_flags.includes("PITCHER_SPECIFIC_WORKLOAD"));
  assert.equal(result.home_pitcher.expected_innings, 5.5);
  assert.equal(result.home_pitcher.expected_pitches, 85);
  assert.deepEqual(result.home_pitcher.workload_flags, ["NO_RECENT_DATA"]);
});
