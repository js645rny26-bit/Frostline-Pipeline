import assert from "node:assert/strict";
import test from "node:test";
import type { GameScheduleResult, ScheduleGameData } from "./module01_mlbStatsApi.js";
import type { NormalizedGame } from "./module06_normalization.js";
import {
  applyStartingNineStarterFallbacks,
  parseStartingNineTeamPageHtml,
  type StartingNineResult,
  type StartingNineTeamPage,
} from "./module04c_startingNine.js";
import {
  buildStartingNineTeamPageRows,
  STARTING_NINE_TEAM_PAGE_HEADERS,
} from "./module08c_startingNineTeamPageWriter.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

const TEAM_PAGE_HTML = `
<script type="application/ld+json">
{"@type":"SportsEvent","name":"San Francisco Giants at Los Angeles Dodgers Matchup","startDate":"2026-09-20T20:10:00Z","competitor":[
  {"@type":"SportsTeam","name":"San Francisco Giants","subOrganization":{"name":"Projected Lineup"}},
  {"@type":"SportsTeam","name":"Los Angeles Dodgers","subOrganization":{"name":"Official Lineup"}}
]}
</script>
<section><h2>Starting Pitcher</h2><img src="/people/686218/headshot"><a href="/players/emmet-sheehan">Emmet Sheehan</a></section>
<h3>DFS Projections</h3>
<section>Opposing Pitcher: <a href="/players/yunior-marte">Yunior Marte</a>
vs LHB .250 .700 10 40 vs RHB .220 .650 8 50
SEASON: 120.1 IP 3.45 ERA 1.20 WHIP 130 SO</section>
<h3>Batter Splits vs RHP (OPS)</h3>
<section>Park Factors (100 = Avg) Runs: 108 HR (LHB): 112 HR (RHB): 105</section>
<section>Umpire: Pat Hoberg K Rate: 22.5% BB Rate: 7.8% Runs/Game: 8.6</section>`;

function scheduleGame(id = "20260920_SFG_LAD", homeStarterResolved = false): ScheduleGameData {
  return {
    gamePk: 999001,
    legacy_game_id: id,
    officialDate: "2026-09-20",
    gameDateTime: "2026-09-20T20:10:00Z",
    venue: { id: 22, name: "Dodger Stadium", timeZone: "America/Los_Angeles" },
    awayTeam: { id: 137, name: "San Francisco Giants", abbreviation: "SFG" },
    homeTeam: { id: 119, name: "Los Angeles Dodgers", abbreviation: "LAD" },
    awayProbablePitcher: { id: 701234, fullName: "Yunior Marte", hand: "R", source: "MLB_STATS_API" },
    homeProbablePitcher: homeStarterResolved
      ? { id: 123456, fullName: "MLB Named Starter", hand: "L", source: "MLB_STATS_API" }
      : { id: null, fullName: null, hand: null },
    status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
    doubleheaderStatus: "N",
    gameNumber: 1,
  };
}

function teamPage(): StartingNineTeamPage {
  return {
    ...parseStartingNineTeamPageHtml(
      TEAM_PAGE_HTML,
      "2026-09-20",
      "https://mlbstartingnine.com/lineups/los-angeles-dodgers/",
      "2026-09-20T13:40:00.000Z",
    ),
    starting_pitcher_hand: "R",
    starting_pitcher_identity_status: "MLB_ID_VERIFIED",
  };
}

function result(page = teamPage()): StartingNineResult {
  return {
    status: "success",
    date: "2026-09-20",
    games: [],
    games_parsed: 1,
    games_matched: 1,
    errors: [],
    team_pages: [page],
    team_pages_requested: 1,
    team_pages_parsed: 1,
    team_page_status: "success",
    team_page_errors: [],
  };
}

function manifest(...games: ScheduleGameData[]): GameScheduleResult {
  return {
    retrieval_timestamp_utc: "2026-09-20T13:39:00.000Z",
    date: "2026-09-20",
    total_games: games.length,
    games,
    status: "success",
  };
}

test("individual team page parses the requested team rather than the first competitor", () => {
  const page = teamPage();
  assert.equal(page.game_id, "20260920_SFG_LAD");
  assert.equal(page.team_abbr, "LAD");
  assert.equal(page.opponent_abbr, "SFG");
  assert.equal(page.team_side, "home");
  assert.equal(page.lineup_status, "official");
  assert.equal(page.starting_pitcher_id, 686218);
  assert.equal(page.starting_pitcher_name, "Emmet Sheehan");
  assert.equal(page.opposing_pitcher_name, "Yunior Marte");
  assert.deepEqual(page.opposing_pitcher_vs_lhb, { avg: 0.25, ops: 0.7, hr: 10, k: 40 });
  assert.deepEqual(page.opposing_pitcher_vs_rhb, { avg: 0.22, ops: 0.65, hr: 8, k: 50 });
  assert.equal(page.opposing_pitcher_ip, 120.1);
  assert.equal(page.park_runs_index, 108);
  assert.equal(page.umpire, "Pat Hoberg");
  assert.equal(page.active_input, "NO");
  assert.equal(page.mapping_status, "DISPLAY_ONLY_NOT_PROJECTION_INPUT");
});

test("verified team-page starter fills only an unresolved MLB slot", () => {
  const applied = applyStartingNineStarterFallbacks(manifest(scheduleGame()), result());
  assert.equal(applied.applied.length, 1);
  assert.deepEqual(applied.manifest.games[0]!.homeProbablePitcher, {
    id: 686218,
    fullName: "Emmet Sheehan",
    hand: "R",
    source: "MLB_STARTING_NINE_TEAM_PAGE",
    sourceObservedTs: "2026-09-20T13:40:00.000Z",
    sourceUrl: "https://mlbstartingnine.com/lineups/los-angeles-dodgers/",
  });
  assert.equal(applied.manifest.games[0]!.awayProbablePitcher.fullName, "Yunior Marte");
});

test("MLB starter authority is never overwritten and ambiguous doubleheaders fail closed", () => {
  const authoritative = applyStartingNineStarterFallbacks(manifest(scheduleGame(undefined, true)), result());
  assert.equal(authoritative.applied.length, 0);
  assert.equal(authoritative.manifest.games[0]!.homeProbablePitcher.fullName, "MLB Named Starter");

  const g1 = scheduleGame("20260920_SFG_LAD__G1");
  const g2 = { ...scheduleGame("20260920_SFG_LAD__G2"), gamePk: 999002, gameNumber: 2 };
  const doubleheader = applyStartingNineStarterFallbacks(manifest(g1, g2), result());
  assert.equal(doubleheader.applied.length, 0);
  assert.equal(doubleheader.manifest.games[0]!.homeProbablePitcher.id, null);
  assert.match(doubleheader.warnings.join(" "), /ambiguous doubleheader/i);
});

test("team-page workbook surface preserves no-input sentinels and schema parity", () => {
  const normalized = {
    legacy_game_id: "20260920_SFG_LAD",
  } as NormalizedGame;
  const rows = buildStartingNineTeamPageRows(result(), [normalized], [{
    game_id: "20260920_SFG_LAD",
    team_abbr: "LAD",
    team_side: "home",
    pitcher_id: 686218,
    pitcher_name: "Emmet Sheehan",
    pitcher_hand: "R",
    source_url: "https://mlbstartingnine.com/lineups/los-angeles-dodgers/",
    observed_ts_utc: "2026-09-20T13:40:00.000Z",
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![11], "YES");
  assert.equal(rows[0]![38], "NO");
  assert.equal(rows[0]![39], "DISPLAY_ONLY_NOT_PROJECTION_INPUT");
  const schema = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "STARTING_NINE_TEAM_PAGE_V1");
  assert.deepEqual(schema?.columns.map((column) => column.name), [...STARTING_NINE_TEAM_PAGE_HEADERS]);
});
