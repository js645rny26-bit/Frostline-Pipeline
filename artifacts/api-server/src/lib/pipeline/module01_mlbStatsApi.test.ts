import assert from "node:assert/strict";
import test from "node:test";
import {
  assignUniqueScheduleGameIds,
  baseGameId,
  type ScheduleGameData,
} from "./module01_mlbStatsApi.js";
import { buildStartingNineMap, resolveStartingNineGameId } from "./module04c_startingNine.js";

function game(
  gamePk: number,
  gameNumber: number | null,
  legacy_game_id = "20260817_STL_CIN",
): ScheduleGameData {
  return {
    gamePk,
    legacy_game_id,
    officialDate: "2026-08-17",
    gameDateTime: gameNumber === 1 ? "2026-08-17T17:40:00Z" : "2026-08-17T22:40:00Z",
    venue: { id: 1, name: "Great American Ball Park", timeZone: "America/New_York" },
    awayTeam: { id: 138, name: "St. Louis Cardinals", abbreviation: "STL" },
    homeTeam: { id: 113, name: "Cincinnati Reds", abbreviation: "CIN" },
    awayProbablePitcher: { id: null, fullName: null, hand: null },
    homeProbablePitcher: { id: null, fullName: null, hand: null },
    status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
    doubleheaderStatus: "Y",
    gameNumber,
  };
}

test("regular games preserve the familiar date-away-home Game_ID", () => {
  const [regular] = assignUniqueScheduleGameIds([game(824000, null, "20260817_NYY_BOS")]);
  assert.equal(regular?.legacy_game_id, "20260817_NYY_BOS");
});

test("same-day doubleheader games receive separate stable Game_IDs", () => {
  const games = assignUniqueScheduleGameIds([game(824514, 1), game(824478, 2)]);
  assert.deepEqual(games.map((entry) => entry.legacy_game_id), [
    "20260817_STL_CIN__G1",
    "20260817_STL_CIN__G2",
  ]);
  assert.equal(baseGameId(games[0]!.legacy_game_id), "20260817_STL_CIN");
  assert.equal(baseGameId(games[1]!.legacy_game_id), "20260817_STL_CIN");
});

test("team-only lineup cards are withheld when a doubleheader makes them ambiguous", () => {
  const result = {
    status: "success" as const,
    date: "2026-08-17",
    games_parsed: 1,
    games_matched: 1,
    errors: [],
    team_pages: [],
    team_pages_requested: 0,
    team_pages_parsed: 0,
    team_page_status: "failure" as const,
    team_page_errors: [],
    games: [{
      game_id: "20260817_STL_CIN",
      away_abbr: "STL",
      home_abbr: "CIN",
      venue: "Great American Ball Park",
      lineup_status: "projected" as const,
      park_factors: { runs_pct: 0, hr_l_pct: 0, hr_r_pct: 0, woba_l_pct: 0, woba_r_pct: 0 },
      away_lineup: [],
      home_lineup: [],
    }],
  };
  const map = buildStartingNineMap(result, ["20260817_STL_CIN__G1", "20260817_STL_CIN__G2"]);
  assert.equal(map.size, 0);
});

test("timestamped doubleheader lineup cards bind to their exact official game", () => {
  const schedule = assignUniqueScheduleGameIds([game(824514, 1), game(824478, 2)]);
  const base = "20260817_STL_CIN";
  const g1Id = resolveStartingNineGameId(base, "2026-08-17T17:40:00Z", schedule);
  const g2Id = resolveStartingNineGameId(base, "2026-08-17T22:40:00Z", schedule);
  assert.equal(g1Id, "20260817_STL_CIN__G1");
  assert.equal(g2Id, "20260817_STL_CIN__G2");

  const sourceGame = (gameId: string, status: "official" | "projected") => ({
    game_id: gameId,
    away_abbr: "STL",
    home_abbr: "CIN",
    venue: "Great American Ball Park",
    lineup_status: status,
    park_factors: { runs_pct: 0, hr_l_pct: 0, hr_r_pct: 0, woba_l_pct: 0, woba_r_pct: 0 },
    away_lineup: [{ batting_order: 1, name: `${gameId} Away`, handedness: "R", position: "CF" }],
    home_lineup: [{ batting_order: 1, name: `${gameId} Home`, handedness: "L", position: "SS" }],
  });
  const result = {
    status: "success" as const,
    date: "2026-08-17",
    games_parsed: 2,
    games_matched: 2,
    errors: [],
    team_pages: [],
    team_pages_requested: 0,
    team_pages_parsed: 0,
    team_page_status: "failure" as const,
    team_page_errors: [],
    games: [sourceGame(g1Id, "official"), sourceGame(g2Id, "projected")],
  };
  const map = buildStartingNineMap(result, schedule.map((entry) => entry.legacy_game_id));
  assert.equal(map.size, 2);
  assert.equal(map.get("20260817_STL_CIN__G1")?.lineup_status, "official");
  assert.equal(map.get("20260817_STL_CIN__G2")?.lineup_status, "projected");
  assert.match(map.get("20260817_STL_CIN__G1")?.away_lineup[0]?.name ?? "", /__G1/);
  assert.match(map.get("20260817_STL_CIN__G2")?.away_lineup[0]?.name ?? "", /__G2/);
});

test("doubleheader lineup cards remain withheld when source time is absent or not unique", () => {
  const schedule = assignUniqueScheduleGameIds([game(824514, 1), game(824478, 2)]);
  const base = "20260817_STL_CIN";
  assert.equal(resolveStartingNineGameId(base, null, schedule), base);
  assert.equal(resolveStartingNineGameId(base, "2026-08-17T20:00:00Z", schedule), base);
});
