import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_VEHICLE_REQUIRED_FROM_DATE,
  COLLISION_CALIBRATION_REPORT_HEADER,
  classifyFrozenVehicleGap,
  collisionCalibrationValues,
  frozenProjectionReplayValues,
  normalizeOutcomeValues,
  parseLowCenterProspectiveSnapshots,
  parseCollisionProspectiveSnapshots,
  parseStarterSurvivalProspectiveSnapshots,
  parseStarterSurvivalV2ProspectiveSnapshots,
  parseProspectiveDecisionAuditSnapshots,
  selectProspectiveProjection,
  settlementRowToValues,
  starterSurvivalCalibrationValues,
  STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER,
  starterSurvivalV2CalibrationValues,
  type SettlementRow,
} from "./module14_shadowSettlement.js";

const vehicle = { market_line: 8.5, direction: "OVER", projected_total: 9.11 };

test("collision settlement accepts only a preserved pre-first-pitch available candidate", () => {
  const valid = Array(19).fill("");
  valid[0] = "2026-08-23";
  valid[1] = "20260823_ATL_MIL";
  valid[4] = "2026-08-23T23:10:00.000Z";
  valid[5] = 3.2;
  valid[6] = 3.8;
  valid[7] = 7;
  valid[8] = 3.5;
  valid[9] = 4.1;
  valid[11] = 0.4;
  valid[12] = 0.6;
  valid[13] = 0.6;
  valid[14] = 7.6;
  valid[15] = "AVAILABLE";
  valid[16] = "AVAILABLE";
  valid[17] = "PROSPECTIVE_SHADOW_CANDIDATE";
  valid[18] = "2026-08-23T16:00:00.000Z";
  const late = [...valid];
  late[1] = "20260823_LATE";
  late[18] = "2026-08-23T23:10:00.000Z";

  const snapshots = parseCollisionProspectiveSnapshots([valid, late], "2026-08-23");
  assert.deepEqual(snapshots.get("20260823_ATL_MIL"), {
    scheduled_first_pitch: "2026-08-23T23:10:00.000Z",
    base_away_projection: 3.2,
    base_home_projection: 3.8,
    base_projection: 7,
    collision_away_evidence_projection: 3.5,
    collision_home_evidence_projection: 4.1,
    collision_estimated_projection: 7.6,
    traffic_conversion_estimate: 0.4,
    hr_xbh_damage_estimate: 0.6,
    combined_tail_adjustment: 0.6,
    preview_availability: "AVAILABLE",
    tail_estimate_status: "AVAILABLE",
    candidate_status: "PROSPECTIVE_SHADOW_CANDIDATE",
    snapshot_ts: "2026-08-23T16:00:00.000Z",
  });
  assert.equal(snapshots.has("20260823_LATE"), false);
});

test("collision settlement leaves an unavailable preview ungradable instead of treating zeros as evidence", () => {
  const raw = Array(19).fill("");
  raw[0] = "2026-08-23";
  raw[1] = "20260823_NO_SOURCE";
  raw[4] = "2026-08-23T23:10:00.000Z";
  raw[5] = 3;
  raw[6] = 4;
  raw[7] = 7;
  raw[14] = 7; // Raw shadow default, deliberately not a candidate.
  raw[15] = "NOT_PUBLISHED";
  raw[16] = "UNAVAILABLE";
  raw[17] = "SOURCE_UNAVAILABLE";
  raw[18] = "2026-08-23T16:00:00.000Z";
  const snapshot = parseCollisionProspectiveSnapshots([raw], "2026-08-23").get("20260823_NO_SOURCE");
  assert.ok(snapshot);
  assert.equal(snapshot.collision_estimated_projection, null);
  const values = collisionCalibrationValues({
    date: "2026-08-23", game_id: "20260823_NO_SOURCE", away_team: "AAA", home_team: "BBB",
    actual_away_runs: 3, actual_home_runs: 4, actual_total: 7, settlement_ts: "2026-08-24T03:00:00.000Z",
    frozen_market_line: 7.5, collision_snapshot: snapshot,
  } as SettlementRow);
  assert.equal(values.length, COLLISION_CALIBRATION_REPORT_HEADER.length);
  assert.equal(values[10], "");
  assert.equal(values[21], "");
  assert.equal(values[27], "SETTLED_SOURCE_UNAVAILABLE");
});

test("collision settlement grades a frozen candidate without changing its snapshot", () => {
  const snapshot = {
    scheduled_first_pitch: "2026-08-23T23:10:00.000Z",
    base_away_projection: 3.2, base_home_projection: 3.8, base_projection: 7,
    collision_away_evidence_projection: 3.5, collision_home_evidence_projection: 4.1,
    collision_estimated_projection: 7.6, traffic_conversion_estimate: 0.4,
    hr_xbh_damage_estimate: 0.6, combined_tail_adjustment: 0.6,
    preview_availability: "AVAILABLE", tail_estimate_status: "AVAILABLE",
    candidate_status: "PROSPECTIVE_SHADOW_CANDIDATE", snapshot_ts: "2026-08-23T16:00:00.000Z",
  };
  const before = structuredClone(snapshot);
  const values = collisionCalibrationValues({
    date: "2026-08-23", game_id: "20260823_ATL_MIL", away_team: "ATL", home_team: "MIL",
    actual_away_runs: 5, actual_home_runs: 4, actual_total: 9, frozen_market_line: 7.5,
    settlement_ts: "2026-08-24T03:00:00.000Z", collision_snapshot: snapshot,
  } as SettlementRow);
  assert.equal(values[19], -2);
  assert.equal(values[21], -1.4);
  assert.equal(values[23], "LOSS");
  assert.equal(values[24], "WIN");
  assert.equal(values[27], "SETTLED");
  assert.deepEqual(snapshot, before);
});

test("low-center candidates retain only the latest legitimate pre-first-pitch snapshot", () => {
  const early = [
    "2026-08-19", "20260819_SEA_HOU", "SEA", "HOU", "2026-08-19T23:10:00.000Z",
    7.5, 9.0, 9.5, 15.59, "2026-08-19T16:00:00.000Z",
  ];
  const latest = [...early];
  latest[5] = 7.7;
  latest[6] = 9.2;
  latest[7] = 9.7;
  latest[9] = "2026-08-19T18:00:00.000Z";
  const afterFirstPitch = [...latest];
  afterFirstPitch[1] = "20260819_LAA_HOU";
  afterFirstPitch[9] = "2026-08-19T23:10:00.000Z";

  const parsed = parseLowCenterProspectiveSnapshots([early, afterFirstPitch, latest], "2026-08-19");
  assert.deepEqual(parsed.get("20260819_SEA_HOU"), {
    scheduled_first_pitch: "2026-08-19T23:10:00.000Z",
    base_projection: 7.7,
    primary_projection: 9.2,
    sensitivity_projection: 9.7,
    snapshot_ts: "2026-08-19T18:00:00.000Z",
  });
  assert.equal(parsed.has("20260819_LAA_HOU"), false);
});

test("starter-survival settlement accepts only a preserved pre-first-pitch candidate", () => {
  const valid = Array(22).fill("");
  valid[0] = "2026-08-21";
  valid[1] = "20260821_AAA_BBB";
  valid[2] = "2026-08-21T23:10:00.000Z";
  valid[3] = 7.5;
  valid[4] = 7.62;
  valid[5] = 6;
  valid[6] = 5.5;
  valid[17] = 0.04;
  valid[18] = 0.03;
  valid[19] = 0.02;
  valid[20] = "2026-08-21T16:00:00.000Z";
  valid[21] = "PROSPECTIVE_SHADOW_CANDIDATE";
  const postFirstPitch = [...valid];
  postFirstPitch[1] = "20260821_CCC_DDD";
  postFirstPitch[20] = "2026-08-21T23:10:00.000Z";

  const snapshots = parseStarterSurvivalProspectiveSnapshots([valid, postFirstPitch], "2026-08-21");
  assert.deepEqual(snapshots.get("20260821_AAA_BBB"), {
    scheduled_first_pitch: "2026-08-21T23:10:00.000Z",
    base_projected_total: 7.5,
    starter_survival_adjusted_total: 7.62,
    away_survival_workload: 6,
    home_survival_workload: 5.5,
    away_starter_fds: 0.04,
    home_starter_fds: 0.03,
    game_fds: 0.02,
    snapshot_ts: "2026-08-21T16:00:00.000Z",
  });
  assert.equal(snapshots.has("20260821_CCC_DDD"), false);
});

test("starter-survival settlement derives grading without mutating the preserved snapshot", () => {
  const snapshot = {
    scheduled_first_pitch: "2026-08-21T23:10:00.000Z",
    base_projected_total: 7.5,
    starter_survival_adjusted_total: 7.62,
    away_survival_workload: 6,
    home_survival_workload: 5.5,
    away_starter_fds: 0.04,
    home_starter_fds: 0.03,
    game_fds: 0.02,
    snapshot_ts: "2026-08-21T16:00:00.000Z",
  };
  const before = structuredClone(snapshot);
  const report = starterSurvivalCalibrationValues({
    date: "2026-08-21", game_id: "20260821_AAA_BBB", away_team: "AAA", home_team: "BBB",
    actual_total: 9, frozen_market_line: 8, actual_away_starter_innings: 6,
    actual_home_starter_innings: 5, settlement_ts: "2026-08-22T03:00:00.000Z",
    starter_survival_snapshot: snapshot,
  } as SettlementRow);
  assert.ok(report);
  assert.equal(report[16], "SURVIVED");
  assert.equal(report[17], "FAILED");
  assert.equal(report[23], "SETTLED");
  assert.deepEqual(snapshot, before);
});

test("SSAT v2 settlement reads only its preserved prospective snapshot and keeps v1 as a control", () => {
  const raw = Array(32).fill("");
  raw[0] = "2026-08-22";
  raw[1] = "20260822_AAA_BBB";
  raw[2] = "2026-08-22T23:10:00.000Z";
  raw[3] = 8;
  raw[4] = 8.1;
  raw[5] = 8.3;
  raw[8] = 6;
  raw[9] = 5.5;
  raw[14] = 2;
  raw[15] = 1.5;
  raw[16] = 1.2;
  raw[17] = 0.8;
  raw[26] = 0.04;
  raw[27] = 0.03;
  raw[28] = 0.02;
  raw[29] = "WORKLOAD|GLOBAL";
  raw[30] = "2026-08-22T16:00:00.000Z";
  raw[31] = "PROSPECTIVE_SHADOW_CANDIDATE";
  const snapshots = parseStarterSurvivalV2ProspectiveSnapshots([raw], "2026-08-22");
  const snapshot = snapshots.get("20260822_AAA_BBB");
  assert.ok(snapshot);
  const before = structuredClone(snapshot);
  const report = starterSurvivalV2CalibrationValues({
    date: "2026-08-22", game_id: "20260822_AAA_BBB", away_team: "AAA", home_team: "BBB",
    actual_total: 10, frozen_market_line: 8.5, actual_away_starter_innings: 3,
    actual_home_starter_innings: 6, settlement_ts: "2026-08-23T03:00:00.000Z",
    starter_survival_v2_snapshot: snapshot,
  } as SettlementRow);
  assert.equal(report.length, STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER.length);
  assert.equal(report[6], 8.1);
  assert.equal(report[7], 8.3);
  assert.equal(report[20], "FAILED");
  assert.equal(report[21], "SURVIVED");
  assert.deepEqual(snapshot, before);

  const missingSnapshotReport = starterSurvivalV2CalibrationValues({
    date: "2026-08-22", game_id: "20260822_MISSING", away_team: "AAA", home_team: "BBB",
    actual_total: 7, actual_away_starter_innings: 5, actual_home_starter_innings: 5,
    settlement_ts: "2026-08-23T03:00:00.000Z",
  } as SettlementRow);
  assert.equal(missingSnapshotReport.length, STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER.length);
  assert.equal(missingSnapshotReport.at(-1), "PREGAME_SNAPSHOT_MISSING");
});

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
