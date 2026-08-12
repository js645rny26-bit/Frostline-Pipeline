import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublicationProtection,
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
