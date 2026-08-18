import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_VEHICLE_REQUIRED_FROM_DATE,
  classifyFrozenVehicleGap,
  frozenProjectionReplayValues,
  normalizeOutcomeValues,
  parseProspectiveDecisionAuditSnapshots,
  selectProspectiveProjection,
  settlementRowToValues,
  type SettlementRow,
} from "./module14_shadowSettlement.js";

const vehicle = { market_line: 8.5, direction: "OVER", projected_total: 9.11 };

test("settlement fails closed on missing live prospective state without reconstructing it", () => {
  assert.equal(FROZEN_VEHICLE_REQUIRED_FROM_DATE, "2026-08-10");
  const live = classifyFrozenVehicleGap("2026-08-10", "20260810_CHC_WSN", false);
  assert.match(live.error ?? "", /PREGAME_FREEZE_MISSING\/AUDIT_GAP/);
  assert.equal(live.warning, undefined);

  const legacy = classifyFrozenVehicleGap("2026-08-09", "20260809_CIN_WSN", false);
  assert.match(legacy.warning ?? "", /LEGACY_PREGAME_FREEZE_MISSING/);
  assert.equal(legacy.error, undefined);
});

test("OPEN decision audit row is a valid prospective fallback only before first pitch", () => {
  const valid = Array(17).fill("");
  valid[0] = "2026-08-13";
  valid[1] = "20260813_BOS_TOR";
  valid[4] = "2026-08-13T19:07:00.000Z";
  valid[7] = "OPEN";
  valid[10] = 11.11;
  valid[11] = 7;
  valid[12] = "OVER";
  valid[16] = "2026-08-13T16:03:26.309Z";

  const rejected = [...valid];
  rejected[1] = "20260813_CHC_WSN";
  rejected[4] = "2026-08-13T20:05:00.000Z";
  rejected[16] = "2026-08-13T20:05:00.000Z";

  const auditGap = [...valid];
  auditGap[1] = "20260813_PHI_MIN";
  auditGap[7] = "AUDIT_GAP";

  const parsed = parseProspectiveDecisionAuditSnapshots(
    [valid, rejected, auditGap],
    "2026-08-13",
  );
  assert.deepEqual(parsed.snapshots.get("20260813_BOS_TOR"), {
    market_line: 7,
    direction: "OVER",
    projected_total: 11.11,
    source: "PROSPECTIVE_DECISION_AUDIT",
  });
  assert.equal(parsed.snapshots.has("20260813_CHC_WSN"), false);
  assert.equal(parsed.snapshots.has("20260813_PHI_MIN"), false);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0] ?? "", /non-prospective timestamp/);
});

test("vehicle log wins while validated audit evidence can repair an unresolved outcome", () => {
  const frozenVehicle = {
    market_line: 8.5,
    direction: "UNDER",
    projected_total: 8.2,
    source: "FROZEN_VEHICLE_LOG" as const,
  };
  const prospectiveAudit = {
    market_line: 8.5,
    direction: "UNDER",
    projected_total: 8.35,
    source: "PROSPECTIVE_DECISION_AUDIT" as const,
  };

  assert.equal(selectProspectiveProjection(frozenVehicle, prospectiveAudit), frozenVehicle);
  assert.equal(selectProspectiveProjection(undefined, prospectiveAudit), prospectiveAudit);
});

test("decision audit fallback is labeled and propagated into projection replay", () => {
  const prospectiveAudit = {
    market_line: 7,
    direction: "OVER",
    projected_total: 11.11,
    source: "PROSPECTIVE_DECISION_AUDIT" as const,
  };
  const v16 = [
    "2026-08-13", "20260813_BOS_TOR", "BOS", "TOR", 10.9, 8, 2.9, 2.9,
    "VENUE_FACTOR_USED", "BLENDED", "BLENDED", "2026-08-14T00:00:00.000Z",
    ...Array(11).fill(""),
  ];
  const migrated = normalizeOutcomeValues(v16, prospectiveAudit);
  assert.equal(migrated[12], 11.11);
  assert.equal(migrated[15], "PROSPECTIVE_DECISION_AUDIT");

  const replayRow = {
    date: "2026-08-13",
    game_id: "20260813_BOS_TOR",
    away_team: "BOS",
    home_team: "TOR",
    repaired_projected_total: 10.9,
    actual_away_runs: 4,
    actual_home_runs: 4,
    actual_total: 8,
    error: 2.9,
    abs_error: 2.9,
    park_source_status: "VENUE_FACTOR_USED",
    away_offense_source: "BLENDED",
    home_offense_source: "BLENDED",
    settlement_ts: "2026-08-14T00:00:00.000Z",
    frozen_published_total: 11.11,
    frozen_error: 3.11,
    frozen_abs_error: 3.11,
    frozen_projection_source: "PROSPECTIVE_DECISION_AUDIT",
    repaired_minus_frozen: -0.21,
    frozen_market_line: 7,
    settlement_market_line: 7,
    frozen_ticket_result: "WIN",
    settlement_ticket_result: "WIN",
    projection_audit_status: "REPAIRED_DIFFERS_FROM_PUBLISHED",
    projected_away_starter: "",
    projected_home_starter: "",
    actual_away_starter: "",
    actual_home_starter: "",
    away_starter_match_status: "UNRESOLVED",
    home_starter_match_status: "UNRESOLVED",
    away_bulk_pitcher: "",
    home_bulk_pitcher: "",
    away_pitcher_chain: "",
    home_pitcher_chain: "",
    pitcher_provenance_status: "PARTIAL",
  } satisfies SettlementRow;
  const replay = frozenProjectionReplayValues(replayRow, "2026-08-14T01:00:00.000Z");
  assert.ok(replay);
  assert.equal(replay[23], "PROSPECTIVE_DECISION_AUDIT");
});

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
    actual_away_runs: 8,
    actual_home_runs: 6,
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
  assert.equal(replay[1], "20260807_OAK_BOS");
  assert.equal(replay[26], 9.2);
  assert.equal(replay[27], -4.8);

  const doubleheaderReplay = frozenProjectionReplayValues(
    { ...row, game_id: "20260807_OAK_BOS__G2" },
    "2026-08-09T00:00:00.000Z",
  );
  assert.ok(doubleheaderReplay);
  assert.equal(doubleheaderReplay[1], "20260807_OAK_BOS__G2");
  assert.notEqual(replay[1], doubleheaderReplay[1]);
});
