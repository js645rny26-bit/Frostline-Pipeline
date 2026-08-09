import assert from "node:assert/strict";
import test from "node:test";
import {
  frozenProjectionReplayValues,
  normalizeOutcomeValues,
  settlementRowToValues,
  type SettlementRow,
} from "./module14_shadowSettlement.js";

const vehicle = { market_line: 8.5, direction: "OVER", projected_total: 9.11 };

test("legacy frozen audit columns survive the combined outcome migration", () => {
  const legacy = [
    "2026-08-04", "20260804_LAA_BAL", "LAA", "BAL", 8.28, 4, 4.28, 4.28,
    "VENUE_FACTOR_USED", "BLENDED", "BLENDED", "2026-08-05T00:00:00.000Z",
    9.11, 5.11, 5.11, "FROZEN_VEHICLE_LOG", -0.83, 8.5, 8.5, "LOSS", "LOSS",
    "REPAIRED_DIFFERS_FROM_PUBLISHED",
  ];

  const migrated = normalizeOutcomeValues(legacy, vehicle);
  assert.equal(migrated.length, 33);
  assert.deepEqual(migrated.slice(12, 22), legacy.slice(12, 22));
  assert.deepEqual(migrated.slice(22), Array(11).fill(""));
});

test("v16 pitcher columns move from M:W to W:AG and gain frozen audit values", () => {
  const pitcher = [
    "Zac Thornton", "Carmen Mlodzinski", "Zac Thornton", "Carmen Mlodzinski",
    "MATCH", "MATCH", "Dedniel Nunez", "Yohan Ramirez", "away chain", "home chain", "COMPLETE",
  ];
  const v16 = [
    "2026-08-07", "20260807_NYM_PIT", "NYM", "PIT", 8.01, 10, -1.99, 1.99,
    "VENUE_FACTOR_USED", "BLENDED", "BLENDED", "2026-08-08T00:00:00.000Z",
    ...pitcher,
  ];
  const migrated = normalizeOutcomeValues(v16, { market_line: 8, direction: "NONE", projected_total: 8 });

  assert.equal(migrated[12], 8);
  assert.equal(migrated[13], -2);
  assert.equal(migrated[15], "FROZEN_VEHICLE_LOG");
  assert.equal(migrated[21], "REPAIRED_DIFFERS_FROM_PUBLISHED");
  assert.deepEqual(migrated.slice(22), pitcher);
});

test("frozen projection replay serializes the packet projection, not repaired projection", () => {
  const row = {
    date: "2026-08-07",
    game_id: "20260807_OAK_BOS",
    away_team: "OAK",
    home_team: "BOS",
    repaired_projected_total: 9.29,
    actual_total: 14,
    error: -4.71,
    abs_error: 4.71,
    park_source_status: "VENUE_FACTOR_USED",
    away_offense_source: "BLENDED",
    home_offense_source: "BLENDED",
    settlement_ts: "2026-08-08T00:00:00.000Z",
    frozen_published_total: 9.2,
    frozen_error: -4.8,
    frozen_abs_error: 4.8,
    frozen_projection_source: "FROZEN_VEHICLE_LOG",
    repaired_minus_frozen: 0.09,
    frozen_market_line: 8.5,
    settlement_market_line: 8.5,
    frozen_ticket_result: "WIN",
    settlement_ticket_result: "WIN",
    projection_audit_status: "REPAIRED_DIFFERS_FROM_PUBLISHED",
    projected_away_starter: "Jack Perkins",
    projected_home_starter: "Payton Tolle",
    actual_away_starter: "Jack Perkins",
    actual_home_starter: "Payton Tolle",
    away_starter_match_status: "MATCH",
    home_starter_match_status: "MATCH",
    away_bulk_pitcher: "Scott Blewett",
    home_bulk_pitcher: "Raymond Burgos",
    away_pitcher_chain: "away chain",
    home_pitcher_chain: "home chain",
    pitcher_provenance_status: "COMPLETE",
  } satisfies SettlementRow;

  assert.equal(settlementRowToValues(row).length, 33);
  const replay = frozenProjectionReplayValues(row, "2026-08-09T00:00:00.000Z");
  assert.ok(replay);
  assert.equal(replay[5], 9.2);
  assert.equal(replay[26], 9.2);
  assert.equal(replay[27], -4.8);
});
