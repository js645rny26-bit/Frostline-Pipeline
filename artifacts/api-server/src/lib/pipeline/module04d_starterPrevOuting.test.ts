import assert from "node:assert/strict";
import test from "node:test";

import { selectLatestPreviousPitchingAppearance } from "./module04d_starterPrevOuting.js";

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

test("previous-outing freshness excludes non-regular-season and same-day rows", () => {
  const latest = selectLatestPreviousPitchingAppearance([
    { date: "2026-09-20", gameType: "S", game: { gamePk: 1 }, stat: { inningsPitched: "6.0" } },
    { date: "2026-09-22", gameType: "R", game: { gamePk: 2 }, stat: { inningsPitched: "1.0" } },
    { date: "2026-09-23", gameType: "R", game: { gamePk: 3 }, stat: { inningsPitched: "2.0" } },
  ], "2026-09-23");
  assert.equal(latest?.gamePk, 2);
});
