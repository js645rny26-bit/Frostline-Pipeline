import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSheetRowNumberMap,
  buildPublicationProtection,
  clearDecommissionedDisplayColumns,
  filterMutablePublicationGames,
  mergeProtectedRows,
} from "./module00_scopedPublication.js";

test("staggered-slate merge carries started game rows forward byte-for-byte", () => {
  const protectedId = "20260812_BAL_MIN";
  const futureId = "20260812_COL_ARI";
  const frozen = ["2026-08-12", protectedId, 8.11, "2026-08-12T17:10:00.000Z"];
  const existing = [frozen, ["2026-08-12", futureId, 9.2, "OLD"]];
  const incoming = [
    ["2026-08-12", protectedId, 99.99, "ILLEGAL_LATE_VALUE"],
    ["2026-08-12", futureId, 8.74, "2026-08-12T18:15:00.000Z"],
  ];

  const merged = mergeProtectedRows(
    existing,
    incoming,
    1,
    new Set([protectedId]),
    [protectedId, futureId],
  );

  assert.deepEqual(merged[0], frozen);
  assert.deepEqual(merged[1], incoming[1]);
  assert.notEqual(merged[0], frozen, "the preserved row is cloned, not mutated by reference");
});

test("shared team inputs preserve teams already involved in a started game", () => {
  const existing = [
    ["2026-08-12", "BAL", 4.1, "FROZEN"],
    ["2026-08-12", "ARI", 4.8, "OLD"],
  ];
  const incoming = [
    ["2026-08-12", "BAL", 7.7, "ILLEGAL_LATE_VALUE"],
    ["2026-08-12", "ARI", 5.0, "REFRESHED"],
  ];
  assert.deepEqual(
    mergeProtectedRows(existing, incoming, 1, new Set(["BAL"])),
    [existing[0], incoming[1]],
  );
});

test("decommissioned TEAM_FORM fields stay blank after protected-team preservation", () => {
  const existing = [
    ["2026-08-27", "ATL", 4.1, 3.9, 0.303, "MEDIUM", 1, "FROZEN"],
    ["2026-08-27", "ARI", 4.8, 4.2, 0.312, "MEDIUM", 1, "OLD"],
  ];
  const incoming = [
    ["2026-08-27", "ATL", 9.9, 9.9, "", "", "", "ILLEGAL_LATE_VALUE"],
    ["2026-08-27", "ARI", 5.0, 4.0, "", "", "", "REFRESHED"],
  ];

  const merged = mergeProtectedRows(existing, incoming, 1, new Set(["ATL"]));
  const cleaned = clearDecommissionedDisplayColumns(merged, [4, 5, 6]);

  assert.deepEqual(cleaned[0], ["2026-08-27", "ATL", 4.1, 3.9, "", "", "", "FROZEN"]);
  assert.deepEqual(cleaned[1], incoming[1]);
});

test("pre-write guard protects a game that could cross first pitch during the write", () => {
  const games = [
    {
      legacy_game_id: "20260812_COL_ARI",
      scheduled_utc_time: "2026-08-12T19:40:00.000Z",
      away_team: { team_abbr: "COL" },
      home_team: { team_abbr: "ARI" },
    },
    {
      legacy_game_id: "20260812_HOU_SFG",
      scheduled_utc_time: "2026-08-12T19:45:00.000Z",
      away_team: { team_abbr: "HOU" },
      home_team: { team_abbr: "SFG" },
    },
  ];
  const protection = buildPublicationProtection(
    games,
    "2026-08-12T19:39:42.000Z",
    30_000,
  );

  assert.deepEqual([...protection.protected_game_ids], ["20260812_COL_ARI"]);
  assert.deepEqual([...protection.protected_team_abbrs], ["COL", "ARI"]);
  assert.deepEqual(protection.expected_game_ids, ["20260812_COL_ARI", "20260812_HOU_SFG"]);
});

test("guarded scope keeps feed and recalculation aligned when a game enters the write window", () => {
  const games = [
    {
      legacy_game_id: "20260823_PIT_LAD",
      scheduled_utc_time: "2026-08-23T20:10:00.000Z",
      away_team: { team_abbr: "PIT" },
      home_team: { team_abbr: "LAD" },
    },
    {
      legacy_game_id: "20260823_CHC_SEA",
      scheduled_utc_time: "2026-08-23T23:10:00.000Z",
      away_team: { team_abbr: "CHC" },
      home_team: { team_abbr: "SEA" },
    },
  ];
  const protection = buildPublicationProtection(
    games,
    "2026-08-23T20:07:15.000Z",
    3 * 60_000,
  );

  const scoped = filterMutablePublicationGames(games, protection);
  assert.deepEqual(scoped.map((game) => game.legacy_game_id), ["20260823_CHC_SEA"]);
});

test("missing protected row does not shift mutable Game_ID worksheet addresses", () => {
  const protectedId = "20260814_STL_CHC";
  const firstMutableId = "20260814_MIA_CIN";
  const secondMutableId = "20260814_BOS_PIT";
  const merged = mergeProtectedRows(
    [],
    [
      ["2026-08-14", protectedId, "ILLEGAL_LATE_VALUE"],
      ["2026-08-14", firstMutableId, 0.98],
      ["2026-08-14", secondMutableId, 1.02],
    ],
    1,
    new Set([protectedId]),
    [protectedId, firstMutableId, secondMutableId],
  );

  assert.deepEqual(merged.map((row) => row[1]), [firstMutableId, secondMutableId]);
  const rowNumbers = buildSheetRowNumberMap(merged, 1);
  assert.equal(rowNumbers.has(protectedId), false);
  assert.equal(rowNumbers.get(firstMutableId), 2);
  assert.equal(rowNumbers.get(secondMutableId), 3);
});

test("worksheet identity indexing fails closed on duplicate Game_ID rows", () => {
  assert.throws(
    () => buildSheetRowNumberMap([
      ["2026-08-14", "20260814_MIA_CIN"],
      ["2026-08-14", "20260814_MIA_CIN"],
    ], 1),
    /DUPLICATE_PUBLICATION_KEY/,
  );
});
