import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPostmortemOutcomeAvailability,
  groupContiguousVehicleLogUpdates,
  gradePostmortemTicket,
  gradeTicket,
  isFinalizedVehiclePublication,
  postmortemRowToValues,
  selectVerifiedDecisionPacketFallbackRows,
  selectNewImmutableVehicleRows,
  selectCanonicalVehicleRows,
  vehicleSnapshotKey,
  type PostmortemRow,
} from "./module17_vehiclePostmortem.js";
import type { SlateBoardEntry } from "./module11_outputExtraction.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";

test("vehicle postmortem preserves Over and Under pushes", () => {
  assert.deepEqual(gradeTicket("OVER", 9, 9), {
    thesis_correct: "PUSH",
    ticket_result: "PUSH",
  });
  assert.deepEqual(gradeTicket("UNDER", 9, 9), {
    thesis_correct: "PUSH",
    ticket_result: "PUSH",
  });
});

test("vehicle log updates are grouped into minimal contiguous writes", () => {
  const updates = new Map<number, unknown[]>([
    [7, ["row-7"]],
    [2, ["row-2"]],
    [4, ["row-4"]],
    [3, ["row-3"]],
    [9, ["row-9"]],
  ]);

  assert.deepEqual(groupContiguousVehicleLogUpdates(updates), [
    { start_data_row_index: 2, rows: [["row-2"], ["row-3"], ["row-4"]] },
    { start_data_row_index: 7, rows: [["row-7"]] },
    { start_data_row_index: 9, rows: [["row-9"]] },
  ]);
});

test("a full adjacent slate becomes one vehicle-log write group", () => {
  const updates = new Map<number, unknown[]>();
  for (let index = 120; index < 135; index++) updates.set(index, [`row-${index}`]);

  const groups = groupContiguousVehicleLogUpdates(updates);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.start_data_row_index, 120);
  assert.equal(groups[0]?.rows.length, 15);
});

test("published vehicle rows remain byte-for-byte immutable on later refresh", () => {
  const published = [[
    "2026-08-10", "20260810_CHC_WSN", "CHC", "WSN", "GAME_TOTAL", 8.5,
    "UNDER", 7.9, -0.6, "CORE", "", "BUY", 0.74, "2026-08-10T15:00:00.000Z",
  ]];
  const snapshot = structuredClone(published);
  const laterCalculation = [[
    "2026-08-10", "20260810_CHC_WSN", "CHC", "WSN", "GAME_TOTAL", 9,
    "OVER", 11.2, 2.2, "NO_CORE", "LATE_CALCULATION", "LEAN", 0.61,
    "2026-08-11T03:00:00.000Z",
  ]];
  const result = selectNewImmutableVehicleRows(published, laterCalculation);
  assert.deepEqual(published, snapshot);
  assert.equal(result.protectedRows, 1);
  assert.deepEqual(result.newRows, []);
});

test("postponed games are terminal skips while ordinary missing outcomes remain integrity gaps", () => {
  const terminal = new Set(["20260922_TOR_BAL", "20260923_TOR_BAL"]);
  assert.equal(
    classifyPostmortemOutcomeAvailability("20260922_TOR_BAL", false, terminal),
    "TERMINAL_NO_OUTCOME",
  );
  assert.equal(
    classifyPostmortemOutcomeAvailability("20260922_OAK_CLE", false, terminal),
    "MISSING",
  );
  assert.equal(
    classifyPostmortemOutcomeAvailability("20260922_TOR_BAL", true, terminal),
    "AVAILABLE",
  );
});

const canonicalMarket = (overrides: Partial<Parameters<typeof gradePostmortemTicket>[2]> = {}) => ({
  actual_total: 8,
  executable_market_line: 8.5,
  executable_market_source: "HARD_ROCK_FLORIDA",
  primary_market_line: 8.5,
  primary_market_source: "LITERAL_EXECUTABLE_HARD_ROCK",
  primary_market_status: "LITERAL_EXECUTABLE",
  primary_directional_result: "LOSS",
  primary_market_provenance: "LITERAL_EXECUTABLE",
  ...overrides,
});

test("coded postmortem reproduces COL-DET from literal Hard Rock 8.5, not vehicle reference 7.5", () => {
  assert.deepEqual(gradePostmortemTicket("OVER", 7.5, canonicalMarket()), {
    market_line: 8.5,
    market_status: "VALID_LITERAL_HALF_NUMBER",
    thesis_correct: false,
    ticket_result: "MISSED",
  });
});

test("coded postmortem cannot substitute a reference when Hard Rock is unavailable", () => {
  assert.deepEqual(gradePostmortemTicket("OVER", 8, canonicalMarket({
    executable_market_line: null,
    executable_market_source: "",
    primary_market_line: null,
    primary_market_source: "HARD_ROCK_FLORIDA_REQUIRED",
    primary_market_status: "NO_LITERAL_EXECUTABLE_HARD_ROCK_LINE",
    primary_directional_result: "NO_BET",
    primary_market_provenance: "HARD_ROCK_EXECUTABLE_UNAVAILABLE",
  })), {
    market_line: null,
    market_status: "NO_LITERAL_EXECUTABLE_HARD_ROCK_LINE",
    thesis_correct: null,
    ticket_result: "NO_BET",
  });
});

test("postmortem uses the standing reference benchmark when no execution line is primary", () => {
  assert.deepEqual(gradePostmortemTicket("OVER", 8, canonicalMarket({
    executable_market_line: null,
    executable_market_source: "",
    primary_market_line: 8,
    primary_market_source: "MLB_STARTING_NINE_CARD",
    primary_market_status: "LITERAL_REFERENCE",
    primary_directional_result: "PUSH",
    primary_market_provenance: "LITERAL_REFERENCE",
  }), "2026-09-11"), {
    market_line: 8,
    market_status: "REFERENCE_MARKET_STANDING_BENCHMARK",
    thesis_correct: "PUSH",
    ticket_result: "PUSH",
  });
});

test("pre-policy historical whole-number postmortem retains legitimate PUSH semantics", () => {
  assert.deepEqual(gradePostmortemTicket("OVER", 8, canonicalMarket({
    executable_market_line: null,
    executable_market_source: "",
    primary_market_line: 8,
    primary_market_source: "HISTORICAL_REFERENCE_BOOK",
    primary_market_status: "LITERAL_REFERENCE",
    primary_directional_result: "PUSH",
    primary_market_provenance: "LITERAL_REFERENCE",
  }), "2026-09-05"), {
    market_line: 8,
    market_status: "REFERENCE_MARKET_STANDING_BENCHMARK",
    thesis_correct: "PUSH",
    ticket_result: "PUSH",
  });
});

test("coded postmortem treats impossible stored Hard Rock 8.0 as integrity failure, not PUSH", () => {
  assert.deepEqual(gradePostmortemTicket("OVER", 7.5, canonicalMarket({
    executable_market_line: 8,
    primary_market_line: 8,
  })), {
    market_line: 8,
    market_status: "MARKET_LINE_INTEGRITY_FAILURE",
    thesis_correct: null,
    ticket_result: "NO_BET",
  });
});

test("a same-timestamp divergent legacy vehicle collision is rejected rather than silently selected", () => {
  const first = [
    "2026-07-29", "20260729_ATL_NYM", "ATL", "NYM", "GAME_TOTAL", 8.5,
    "OVER", 9.26, 0.76, "NO_CORE", "", "LEAN", 0.5, "2026-07-29T15:59:42.730Z",
  ];
  const second = [...first];
  second[7] = 7.39;
  const parsed = selectCanonicalVehicleRows([first, second]);
  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(parsed.rejected, [{
    date: "2026-07-29", game_id: "20260729_ATL_NYM", reason: "VEHICLE_LOG_SNAPSHOT_COLLISION",
  }]);
  assert.match(parsed.warnings[0] ?? "", /VEHICLE_LOG_SNAPSHOT_COLLISION/);
});

test("legacy refreshes with distinct publish timestamps use the documented latest-snapshot rule", () => {
  const early = [
    "2026-07-28", "20260728_CLE_CIN", "CLE", "CIN", "GAME_TOTAL", 8.5,
    "OVER", 8.2, -0.3, "NO_CORE", "", "LEAN", 0.5, "2026-07-28T15:00:00.000Z",
  ];
  const late = [...early];
  late[7] = 8.8;
  late[13] = "2026-07-28T16:00:00.000Z";
  const parsed = selectCanonicalVehicleRows([early, late]);
  assert.deepEqual(parsed.rows, [late]);
  assert.equal(parsed.rejected.length, 0);
  assert.match(parsed.warnings[0] ?? "", /VEHICLE_LOG_LEGACY_PUBLISH_TS_SELECTION/);
});

test("multiple explicitly keyed snapshots select the latest packet deterministically", () => {
  const early = [
    "2026-09-03", "20260903_AAA_BBB", "AAA", "BBB", "GAME_TOTAL", 8.5,
    "OVER", 9.1, 0.6, "NO_CORE", "", "LEAN", 0.5, "2026-09-03T17:00:00.000Z",
    "2026-09-03T16:00:00.000Z", vehicleSnapshotKey("2026-09-03", "20260903_AAA_BBB", "2026-09-03T16:00:00.000Z"), "CANONICAL_PACKET_SNAPSHOT",
  ];
  const late = [...early];
  late[7] = 8.8;
  late[14] = "2026-09-03T16:30:00.000Z";
  late[15] = vehicleSnapshotKey("2026-09-03", "20260903_AAA_BBB", "2026-09-03T16:30:00.000Z");
  const parsed = selectCanonicalVehicleRows([early, late]);
  assert.equal(parsed.rejected.length, 0);
  assert.deepEqual(parsed.rows, [late]);
});

test("only finalized board-lock states can become immutable vehicle publications", () => {
  const entry = (lock_status: SlateBoardEntry["lock_status"]) => ({ lock_status }) as SlateBoardEntry;
  assert.equal(isFinalizedVehiclePublication(entry("PRE_LOCK")), false);
  assert.equal(isFinalizedVehiclePublication(entry("LOCK_TIME_UNAVAILABLE")), false);
  assert.equal(isFinalizedVehiclePublication(entry("LOCK_DATA_UNAVAILABLE")), false);
  assert.equal(isFinalizedVehiclePublication(entry("LOCKED_IN")), true);
  assert.equal(isFinalizedVehiclePublication(entry("LOCKED_OUT")), true);
});

test("postmortem rows match the current 19-column workbook schema", () => {
  const row: PostmortemRow = {
    date: "2026-08-07",
    game_id: "20260807_OAK_BOS",
    away_team: "OAK",
    home_team: "BOS",
    active_vehicle_label: "OAK@BOS FG Over 8.5",
    vehicle_type: "FULL_GAME_OVER",
    market_line: 8.5,
    decision: "PASS",
    packet_projected_total: 9.2,
    actual_total: 14,
    signed_error: -4.8,
    abs_error: 4.8,
    game_truth_grade: "TRUTH_CONFIRMED",
    vehicle_capture_grade: "NO_AUTHORIZED_VEHICLE",
    ticket_result: "NO_WAGER_SHADOW",
    blocker_grade: "BLOCKER_RECORDED",
    failure_modes: "PROJECTION_MISS_4PLUS",
    exact_blocker: "INSUFFICIENT_PROJECTION_SEPARATION",
    graded_ts: "2026-08-09T00:00:00.000Z",
  };

  const values = postmortemRowToValues(row);
  assert.equal(values.length, 19);
  assert.equal(values[4], row.active_vehicle_label);
  assert.equal(values[8], row.packet_projected_total);
  assert.equal(values[18], row.graded_ts);
});

function rowFromHeaders(headers: readonly string[], fields: Record<string, unknown>): unknown[] {
  return headers.map((header) => fields[header] ?? "");
}

const auditHeaders = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Audit_Status", "Frozen_Projected_Total", "Frozen_Market_Line",
  "Frozen_Model_Direction", "Frozen_Model_Vehicle", "Frozen_Model_Confidence",
  "Frozen_Model_Blocker", "Frozen_Model_TS",
];

function fallbackAudit(overrides: Record<string, unknown> = {}): unknown[] {
  return rowFromHeaders(auditHeaders, {
    Date: "2026-09-21", Game_ID: "20260921_WSN_DET", Away_Team: "WSN", Home_Team: "DET",
    Scheduled_First_Pitch: "2026-09-21T22:40:00.000Z", Audit_Status: "FROZEN",
    Frozen_Projected_Total: 8.4, Frozen_Market_Line: 7.5, Frozen_Model_Direction: "OVER",
    Frozen_Model_Vehicle: "GAME_TOTAL", Frozen_Model_Confidence: 0.4,
    Frozen_Model_Blocker: "INSUFFICIENT_PROJECTION_SEPARATION",
    Frozen_Model_TS: "2026-09-21T22:06:56.904Z", ...overrides,
  });
}

function fallbackPacket(overrides: Record<string, unknown> = {}): unknown[] {
  return rowFromHeaders(PREGAME_PACKET_HISTORY_HEADERS, {
    Date: "2026-09-21", Game_ID: "20260921_WSN_DET", Away_Team: "WSN", Home_Team: "DET",
    Scheduled_First_Pitch: "2026-09-21T22:40:00.000Z", Packet_Status: "FROZEN_PREGAME",
    Projection_Generated_TS: "2026-09-21T22:06:56.904Z",
    Final_Decision_TS: "2026-09-21T22:06:56.904Z",
    Packet_Snapshot_TS: "2026-09-21T22:07:18.044Z", Base_Projection: 8.4,
    Market_Line: 8.5, Direction: "OVER", Vehicle: "GAME_TOTAL", Final_Decision: "NO_CORE",
    Final_Blocker: "INSUFFICIENT_PROJECTION_SEPARATION", Confidence: 0.4, Variance: 0.9,
    ...overrides,
  });
}

test("verified pre-lock decision and packet fill the postmortem gap without requiring market-line agreement", () => {
  const parsed = selectVerifiedDecisionPacketFallbackRows(
    "2026-09-21",
    [],
    [auditHeaders, fallbackAudit()],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), fallbackPacket()],
  );
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.[1], "20260921_WSN_DET");
  assert.equal(parsed.rows[0]?.[5], 8.5);
  assert.equal(parsed.rows[0]?.[7], 8.4);
  assert.equal(parsed.rows[0]?.[9], "NO_CORE");
  assert.equal(parsed.rows[0]?.[16], "CANONICAL_DECISION_PACKET_FALLBACK");
});

test("an existing VEHICLE_LOG row always suppresses the postmortem fallback", () => {
  const existing = [["2026-09-21", "20260921_WSN_DET"]];
  const parsed = selectVerifiedDecisionPacketFallbackRows(
    "2026-09-21",
    existing,
    [auditHeaders, fallbackAudit()],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), fallbackPacket()],
  );
  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(parsed.rejected, []);
});

test("post-first-pitch decision or packet evidence is rejected fail-closed", () => {
  const lateAudit = selectVerifiedDecisionPacketFallbackRows(
    "2026-09-21", [],
    [auditHeaders, fallbackAudit({ Frozen_Model_TS: "2026-09-21T22:40:00.000Z" })],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), fallbackPacket()],
  );
  assert.deepEqual(lateAudit.rows, []);
  assert.deepEqual(lateAudit.rejected, [{
    game_id: "20260921_WSN_DET", reason: "DECISION_AUDIT_NOT_PROSPECTIVE",
  }]);

  const latePacket = selectVerifiedDecisionPacketFallbackRows(
    "2026-09-21", [],
    [auditHeaders, fallbackAudit()],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), fallbackPacket({
      Packet_Snapshot_TS: "2026-09-21T22:40:00.000Z",
    })],
  );
  assert.deepEqual(latePacket.rows, []);
  assert.deepEqual(latePacket.rejected, [{
    game_id: "20260921_WSN_DET", reason: "PREGAME_PACKET_NOT_PROSPECTIVE",
  }, {
    game_id: "20260921_WSN_DET", reason: "MATCHING_PREGAME_PACKET_MISSING",
  }]);
});

test("decision and packet lineage disagreement cannot create a fallback row", () => {
  const parsed = selectVerifiedDecisionPacketFallbackRows(
    "2026-09-21", [],
    [auditHeaders, fallbackAudit()],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), fallbackPacket({ Base_Projection: 8.41 })],
  );
  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(parsed.rejected, [{
    game_id: "20260921_WSN_DET", reason: "DECISION_PACKET_LINEAGE_MISMATCH",
  }]);
});
