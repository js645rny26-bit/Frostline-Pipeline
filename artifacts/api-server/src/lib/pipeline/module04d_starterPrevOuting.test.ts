import assert from "node:assert/strict";
import test from "node:test";

import { selectLatestPreviousPitchingAppearance } from "./module04d_starterPrevOuting.js";
import { pitchingGameLogUrl, recentAppearances, rollingStats } from "./module02_pitcherWorkload.js";

test("previous-outing freshness admits a later bulk appearance after the pitcher's last start", () => {
  const latest = selectLatestPreviousPitchingAppearance([
    {
      date: "2026-09-05", gameType: "R", game: { gamePk: 1 },
      stat: { inningsPitched: "4.1", numberOfPitches: 81, gamesStarted: 1 },
    },
    {
      date: "2026-09-17", gameType: "R", game: { gamePk: 2 },
      stat: { inningsPitched: "5.2", numberOfPitches: 71, gamesStarted: 0 },
    },
    {
      date: "2026-09-23", gameType: "R", game: { gamePk: 3 },
      stat: { inningsPitched: "2.2", numberOfPitches: 51, gamesStarted: 1 },
    },
  ], "2026-09-23");

  assert.deepEqual(latest, {
    date: "2026-09-17", gamePk: 2, ip: "5.2", pitches: 71,
  });
});

test("previous-outing freshness excludes spring and same-day rows", () => {
  const latest = selectLatestPreviousPitchingAppearance([
    { date: "2026-09-20", gameType: "S", game: { gamePk: 1 }, stat: { inningsPitched: "6.0" } },
    { date: "2026-09-22", gameType: "R", game: { gamePk: 2 }, stat: { inningsPitched: "1.0" } },
    { date: "2026-09-23", gameType: "R", game: { gamePk: 3 }, stat: { inningsPitched: "2.0" } },
  ], "2026-09-23");
  assert.equal(latest?.gamePk, 2);
});

test("postseason Game 1 starter work is the latest cutoff-safe outing for Game 2", () => {
  const splits = [
    { date: "2026-09-27", gameType: "R", game: { gamePk: 10 }, stat: { inningsPitched: "5.0", numberOfPitches: 82, gamesStarted: 1 } },
    { date: "2026-10-01", gameType: "D", game: { gamePk: 11 }, stat: { inningsPitched: "6.1", numberOfPitches: 97, gamesStarted: 1 } },
    { date: "2026-10-02", gameType: "D", game: { gamePk: 12 }, stat: { inningsPitched: "1.0", numberOfPitches: 12, gamesStarted: 0 } },
    { date: "2026-09-29", gameType: "S", game: { gamePk: 13 }, stat: { inningsPitched: "8.0", numberOfPitches: 110, gamesStarted: 1 } },
  ];
  const latest = selectLatestPreviousPitchingAppearance(splits, "2026-10-02");
  assert.deepEqual(latest, { date: "2026-10-01", gamePk: 11, ip: "6.1", pitches: 97 });
  assert.equal(recentAppearances(splits, "2026-10-01")[0]?.game_pk, 11);
  assert.equal(rollingStats(splits, "2026-09-20", "2026-10-01").total_pitch_count, 179);
  assert.match(pitchingGameLogUrl(123, "2026"), /gameType=R,F,D,L,W,C,P/);
});

test("Wild Card Game 1 starter-used-as-reliever work supersedes the regular-season snapshot", () => {
  const brayanBello = [
    { date: "2026-09-25", gameType: "R", game: { gamePk: 849700 }, stat: { inningsPitched: "6.0", numberOfPitches: 91, gamesStarted: 1 } },
    { date: "2026-09-29", gameType: "F", game: { gamePk: 849851 }, stat: { inningsPitched: "0.2", numberOfPitches: 21, gamesStarted: 0 } },
  ];
  assert.deepEqual(selectLatestPreviousPitchingAppearance(brayanBello, "2026-09-30"), {
    date: "2026-09-29", gamePk: 849851, ip: "0.2", pitches: 21,
  });
  assert.deepEqual(recentAppearances(brayanBello, "2026-09-29")[0], {
    date: "2026-09-29", game_pk: 849851, games_started: 0,
    innings: 0.667, pitch_count: 21, batters_faced: null,
  });
});
