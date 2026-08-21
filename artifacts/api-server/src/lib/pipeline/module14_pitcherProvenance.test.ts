import test from "node:test";
import assert from "node:assert/strict";

import {
  comparePitcherNames,
  hasUsablePitcherProvenance,
  parseGamePitcherProvenance,
} from "./module14_pitcherProvenance.js";

function team(
  pitchers: number[],
  entries: Array<[number, string, number, string]>,
): unknown {
  return {
    pitchers,
    players: Object.fromEntries(entries.map(([id, name, gamesStarted, inningsPitched]) => [
      `ID${id}`,
      {
        person: { id, fullName: name },
        stats: { pitching: { gamesStarted, inningsPitched } },
      },
    ])),
  };
}

test("parses actual starters, bulk arms, and appearance-order chains", () => {
  const result = parseGamePitcherProvenance({
    teams: {
      away: team([1, 2, 3], [
        [1, "Away Starter", 1, "5.2"],
        [2, "Away Bulk", 0, "2.0"],
        [3, "Away Closer", 0, "1.1"],
      ]),
      home: team([4, 5], [
        [4, "Home Starter", 1, "6.0"],
        [5, "Home Reliever", 0, "3.0"],
      ]),
    },
  });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.away.actual_starter, "Away Starter");
  assert.equal(result.away.actual_starter_innings, 5.67);
  assert.equal(result.away.bulk_pitcher, "Away Bulk");
  assert.equal(
    result.away.pitcher_chain,
    "Away Starter (5.2 IP) > Away Bulk (2.0 IP) > Away Closer (1.1 IP)",
  );
});

test("preserves opener as starter and identifies the longer bulk pitcher", () => {
  const result = parseGamePitcherProvenance({
    teams: {
      away: team([10, 11], [
        [10, "Actual Opener", 1, "1.0"],
        [11, "Bulk Follower", 0, "5.1"],
      ]),
      home: team([20], [[20, "Home Starter", 1, "8.0"]]),
    },
  });

  assert.equal(result.away.actual_starter, "Actual Opener");
  assert.equal(result.away.actual_starter_innings, 1);
  assert.equal(result.away.bulk_pitcher, "Bulk Follower");
});

test("falls back to first appearance when older payload omits gamesStarted", () => {
  const result = parseGamePitcherProvenance({
    teams: {
      away: team([1, 2], [[1, "First Arm", 0, "2.0"], [2, "Second Arm", 0, "6.0"]]),
      home: team([3], [[3, "Third Arm", 0, "9.0"]]),
    },
  });
  assert.equal(result.away.actual_starter, "First Arm");
  assert.equal(result.away.actual_starter_innings, 2);
  assert.equal(result.away.bulk_pitcher, "Second Arm");
});

test("missing boxscore provenance is explicit and unavailable", () => {
  const result = parseGamePitcherProvenance(null);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.away.actual_starter, "");
  assert.equal(result.away.actual_starter_innings, null);
  assert.equal(result.home.pitcher_chain, "");
});

test("starter name comparison tolerates accents, punctuation, and suffixes", () => {
  assert.equal(comparePitcherNames("José Berríos", "Jose Berrios Jr."), "MATCH");
  assert.equal(comparePitcherNames("Projected Starter", "Different Starter"), "MISMATCH");
  assert.equal(comparePitcherNames("TBD", "Actual Starter"), "UNRESOLVED");
});

test("legacy outcome-column values cannot masquerade as pitcher provenance", () => {
  assert.equal(hasUsablePitcherProvenance("COMPLETE"), true);
  assert.equal(hasUsablePitcherProvenance("PARTIAL"), true);
  assert.equal(hasUsablePitcherProvenance("REPAIRED_DIFFERS_FROM_PUBLISHED"), false);
  assert.equal(hasUsablePitcherProvenance(""), false);
});
