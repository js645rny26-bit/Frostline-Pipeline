import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractPlayerStats,
  hasUsableStatcastHitterPayload,
  resolveStatcastPitcherRaw,
  selectStatcastHitterRows,
} from "./module02e_statcastPreview.js";

function hitter(
  playerId: number,
  battingOrder: string | null,
  xwoba = ".333",
): Record<string, unknown> {
  return {
    player_id: playerId,
    battingOrder,
    person: { fullName: `Hitter ${playerId}` },
    xwoba,
    hard_hit_percent: 42.1,
    k_percent: 21.2,
    bb_percent: 8.4,
  };
}

describe("module02e Statcast game preview source contract", () => {
  it("accepts roster-level Statcast fields when hitterPlusRows is a numeric counter", () => {
    const side = {
      hasLineup: true,
      hitterPlusRows: 0,
      roster: { hitters: [hitter(10, "100"), hitter(11, "200")] },
    };

    const selected = selectStatcastHitterRows(side);
    assert.equal(selected.source, "POSTED_BATTING_ORDER");
    assert.equal(selected.rows.length, 2);
    assert.equal(hasUsableStatcastHitterPayload(side), true);
  });

  it("uses direct Savant metrics when a generic nested stats object is present", () => {
    const liveRosterHitter = {
      player_id: 10,
      battingOrder: "100",
      person: { fullName: "Live Roster Hitter" },
      // Current Savant pages include this generic object, but the Statcast
      // fields are siblings on the player row.
      stats: { batting: {}, pitching: {}, fielding: {} },
      xwoba: ".333",
      hard_hit_percent: 42.1,
      k_percent: 21.2,
      bb_percent: 8.4,
    };
    const side = { hasLineup: true, roster: { hitters: [liveRosterHitter] } };

    assert.equal(hasUsableStatcastHitterPayload(side), true);
    const stats = extractPlayerStats(liveRosterHitter);
    assert.equal(stats?.xwoba, 0.333);
    assert.equal(stats?.hard_hit_percent, 42.1);
  });

  it("uses a roster fallback rather than inventing a batting order before lineups post", () => {
    const side = {
      hasLineup: false,
      hitterPlusRows: 0,
      roster: { hitters: [hitter(10, null), hitter(11, null)] },
    };

    const selected = selectStatcastHitterRows(side);
    assert.equal(selected.source, "ROSTER_FALLBACK");
    assert.equal(selected.rows.length, 2);
  });

  it("rejects a numeric counter with no actual Statcast fields", () => {
    const side = {
      hasLineup: true,
      hitterPlusRows: 0,
      roster: { hitters: [{ player_id: 10, battingOrder: "100" }] },
    };

    assert.equal(hasUsableStatcastHitterPayload(side), false);
  });

  it("resolves the pipeline probable pitcher from roster.pitchers by player ID", () => {
    const side = {
      roster: {
        pitchers: [
          { player_id: 1, person: { fullName: "Wrong Pitcher" }, xwoba: ".350" },
          { player_id: 2, person: { fullName: "Expected Pitcher" }, xwoba: ".290" },
        ],
      },
    };

    const stats = extractPlayerStats(resolveStatcastPitcherRaw(side, 2));
    assert.equal(stats?.player_id, 2);
    assert.equal(stats?.player_name, "Expected Pitcher");
    assert.equal(stats?.xwoba, 0.29);
  });

  it("fails closed rather than guessing a pitcher when no expected ID is available", () => {
    const side = { roster: { pitchers: [{ player_id: 1, xwoba: ".350" }] } };
    assert.equal(resolveStatcastPitcherRaw(side, null), null);
  });
});
