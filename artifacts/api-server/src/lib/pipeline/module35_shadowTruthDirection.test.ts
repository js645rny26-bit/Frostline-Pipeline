import assert from "node:assert/strict";
import test from "node:test";
import type { SettlementRow } from "./module14_shadowSettlement.js";
import {
  buildSummaryRows,
  gradeShadowTruth,
  mergeProspectiveRecords,
  packetToRecord,
  resolveOperationalDecision,
  selectLiteralShadowLine,
  settleRecords,
  SHADOW_TRUTH_DIRECTION_HEADERS,
  SHADOW_TRUTH_SUMMARY_HEADERS,
  type ShadowTruthRecord,
} from "./module35_shadowTruthDirection.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";

function record(overrides: Partial<ShadowTruthRecord> = {}): ShadowTruthRecord {
  return {
    date: "2026-09-17", game_id: "20260917_BOS_TEX", away_team: "BOS", home_team: "TEX",
    scheduled_first_pitch: "2026-09-17T23:00:00Z", packet_snapshot_ts: "2026-09-17T20:00:00Z",
    packet_freeze_ts: "", confirmation_ready: true, operational_decision: "NO_CALL",
    operational_final_decision: "NO_CORE", operational_blocker: "INSUFFICIENT_PROJECTION_SEPARATION",
    direction: "UNDER", direction_source: "MODULE_11_DIRECTION_FROM_PROJECTION_AND_LINE",
    confidence: 0.44, line: 8.5, line_source: "MLB_STARTING_NINE_CARD",
    line_status: "LITERAL_REFERENCE_RESEARCH_ONLY", frozen_ts: "", record_status: "OPEN_PROSPECTIVE",
    notes: "research", frozen_total: 8.3, frozen_variance: -0.2,
    starter_bullpen_reliance_state: "BALANCED", distribution_structure_status: "LOW_EVENT",
    distribution_risk_tags: "", actual_total: null, result: "", settlement_ts: "", integrity_status: "PASS",
    ...overrides,
  };
}

function outcome(gameId = "20260917_BOS_TEX", actualTotal = 8): SettlementRow {
  return {
    date: "2026-09-17", game_id: gameId, away_team: "BOS", home_team: "TEX",
    repaired_projected_total: 8.3, actual_away_runs: 3, actual_home_runs: actualTotal - 3,
    actual_total: actualTotal, error: 0.3, abs_error: 0.3, park_source_status: "OK",
    away_offense_source: "BLENDED", home_offense_source: "BLENDED",
    settlement_ts: "2026-09-18T05:00:00Z", frozen_published_total: 8.3,
    frozen_error: 0.3, frozen_abs_error: 0.3, frozen_projection_source: "PREGAME_PACKET_HISTORY",
    repaired_minus_frozen: 0, frozen_market_line: 8.5, settlement_market_line: 8.5,
    frozen_ticket_result: "NO_BET", settlement_ticket_result: "NO_BET",
    projection_audit_status: "PASS", projected_away_starter: "A", projected_home_starter: "B",
    actual_away_starter: "A", actual_home_starter: "B", away_starter_match_status: "MATCH",
    home_starter_match_status: "MATCH", away_bulk_pitcher: "", home_bulk_pitcher: "",
    away_pitcher_chain: "", home_pitcher_chain: "", pitcher_provenance_status: "COMPLETE",
  };
}

test("Module 35 keeps its two research surfaces through schema v71", () => {
  assert.equal(WORKBOOK_SCHEMA_VERSION, 71);
  for (const [sheet, headers] of [
    ["SHADOW_TRUTH_DIRECTION_V1", SHADOW_TRUTH_DIRECTION_HEADERS],
    ["SHADOW_TRUTH_SUMMARY_V1", SHADOW_TRUTH_SUMMARY_HEADERS],
  ] as const) {
    assert.deepEqual(
      WORKBOOK_SCHEMA.find((definition) => definition.name === sheet)?.columns.map((column) => column.name),
      Array.from(headers),
    );
  }
});

test("NO_CALL remains operational while the shadow direction is independently present", () => {
  assert.equal(resolveOperationalDecision("PASS", "NO_CORE", "NO_CALL", "PASS"), "NO_CALL");
  const row = record();
  assert.equal(row.operational_decision, "NO_CALL");
  assert.equal(row.direction, "UNDER");
});

test("literal executable line wins; reference and synthetic lines are never substituted", () => {
  assert.deepEqual(selectLiteralShadowLine({
    Executable_Market_Line: 8.5,
    Executable_Market_Status: "LITERAL_EXECUTABLE_HARD_ROCK_CAPTURED",
    Executable_Market_Source: "HARD_ROCK",
    Reference_Market_Line: 8,
    Reference_Market_Representation_Status: "LITERAL_REFERENCE",
  }), { line: 8.5, source: "HARD_ROCK", status: "LITERAL_EXECUTABLE_HARD_ROCK" });
  assert.deepEqual(selectLiteralShadowLine({
    Reference_Market_Line: 8,
    Reference_Market_Source: "MLB_STARTING_NINE_CARD",
    Reference_Market_Representation_Status: "LITERAL_REFERENCE",
    Synthetic_Normalized_Reference_Line: 7.5,
  }), { line: null, source: "", status: "MISSING_EXECUTABLE_LINE_REFERENCE_NOT_SUBSTITUTED" });
  assert.equal(selectLiteralShadowLine({ Synthetic_Normalized_Reference_Line: 7.5 }).line, null);
});

test("settlement grades independently of operational decision and retains whole-number PUSH", () => {
  assert.equal(gradeShadowTruth("OVER", 8.5, 9), "CORRECT");
  assert.equal(gradeShadowTruth("UNDER", 8.5, 9), "INCORRECT");
  assert.equal(gradeShadowTruth("OVER", 8, 8), "PUSH");
  assert.equal(gradeShadowTruth("NONE", 8.5, 9), "UNGRADABLE");
  assert.equal(gradeShadowTruth("OVER", null, 9), "UNGRADABLE");
});

test("duplicate Game_ID updates OPEN evidence but cannot overwrite a frozen record", () => {
  const open = record();
  const update = record({ direction: "OVER", line: 7.5, frozen_total: 8.3 });
  const mergedOpen = mergeProspectiveRecords([open], [update]);
  assert.equal(mergedOpen.updated, 1);
  assert.equal(mergedOpen.records[0]?.direction, "OVER");

  const frozen = record({ frozen_ts: "2026-09-17T23:00:00Z", record_status: "FROZEN_PREGAME" });
  const mergedFrozen = mergeProspectiveRecords([frozen], [update]);
  assert.equal(mergedFrozen.preserved, 1);
  assert.equal(mergedFrozen.records[0]?.direction, "UNDER");
  assert.equal(mergedFrozen.records.length, 1);

  assert.throws(
    () => mergeProspectiveRecords([open, record()], []),
    /DUPLICATE_SHADOW_TRUTH_RECORD/,
  );
  assert.throws(
    () => mergeProspectiveRecords([], [open, record()]),
    /DUPLICATE_SHADOW_TRUTH_CANDIDATE/,
  );
});

test("settlement requires the same frozen packet snapshot and never reconstructs a missing ledger row", () => {
  const packetRows = [[
    "Date", "Game_ID", "Packet_Status", "Packet_Snapshot_TS", "Freeze_TS",
  ], [
    "2026-09-17", "20260917_BOS_TEX", "FROZEN_PREGAME", "2026-09-17T20:00:00Z", "2026-09-17T23:00:00Z",
  ]];
  const settled = settleRecords([record()], packetRows, [outcome()], "2026-09-17");
  assert.equal(settled.records[0]?.result, "CORRECT");
  assert.equal(settled.records[0]?.operational_decision, "NO_CALL");
  assert.equal(settled.records[0]?.record_status, "FROZEN_PREGAME");

  const absent = settleRecords([], packetRows, [outcome()], "2026-09-17");
  assert.equal(absent.records.length, 0);
  assert.equal(absent.auditGaps, 1);
});

test("a frozen packet cannot create a missing shadow direction after first pitch", () => {
  const headers = [
    "Date", "Game_ID", "Packet_Status", "Scheduled_First_Pitch", "Packet_Snapshot_TS",
    "Freeze_TS", "Core_Packet_Status", "Final_Decision", "Base_Projection",
    "Reference_Market_Line", "Reference_Market_Source", "Reference_Market_Representation_Status",
  ];
  const index = new Map(headers.map((header, column) => [header, column]));
  const row = [
    "2026-09-17", "20260917_BOS_TEX", "FROZEN_PREGAME", "2026-09-17T23:00:00Z",
    "2026-09-17T20:00:00Z", "2026-09-17T23:00:00Z", "COMPLETE", "NO_CORE", 8.3,
    8.5, "MLB_STARTING_NINE_CARD", "LITERAL_REFERENCE",
  ];
  assert.equal(packetToRecord(row, index, "2026-09-18T05:00:00Z"), null);
});

test("missing executable evidence preserves the upstream opinion but cannot become a graded line", () => {
  const headers = [
    "Date", "Game_ID", "Packet_Status", "Scheduled_First_Pitch", "Packet_Snapshot_TS",
    "Core_Packet_Status", "Final_Decision", "Base_Projection", "Direction",
    "Reference_Market_Line", "Reference_Market_Source", "Reference_Market_Representation_Status",
  ];
  const index = new Map(headers.map((header, column) => [header, column]));
  const row = [
    "2026-09-17", "20260917_BOS_TEX", "OPEN_PROSPECTIVE", "2026-09-17T23:00:00Z",
    "2026-09-17T20:00:00Z", "COMPLETE", "NO_CORE", 8.3, "UNDER",
    8.5, "MLB_STARTING_NINE_CARD", "LITERAL_REFERENCE",
  ];
  const candidate = packetToRecord(row, index, "2026-09-17T21:00:00Z");
  assert.equal(candidate?.direction, "UNDER");
  assert.equal(candidate?.line, null);
  assert.equal(candidate?.record_status, "UNGRADABLE_MISSING_LITERAL_LINE");
  assert.equal(candidate?.line_status, "MISSING_EXECUTABLE_LINE_REFERENCE_NOT_SUBSTITUTED");
});

test("September 16 former NO_CALL-style cases can retain their proven upstream directions", () => {
  const cases = [
    record({ date: "2026-09-16", game_id: "20260916_BOS_TEX", direction: "UNDER", line: 7.5 }),
    record({ date: "2026-09-16", game_id: "20260916_MIL_PIT", direction: "UNDER", line: 7.5 }),
    record({ date: "2026-09-16", game_id: "20260916_SDP_COL", direction: "OVER", line: 11 }),
  ];
  assert.deepEqual(cases.map((value) => [value.game_id, value.direction]), [
    ["20260916_BOS_TEX", "UNDER"],
    ["20260916_MIL_PIT", "UNDER"],
    ["20260916_SDP_COL", "OVER"],
  ]);
});

test("summary excludes PUSH and UNGRADABLE from directional accuracy", () => {
  const rows = [
    record({ frozen_ts: "x", result: "CORRECT", settlement_ts: "s" }),
    record({ game_id: "g2", frozen_ts: "x", result: "INCORRECT", settlement_ts: "s" }),
    record({ game_id: "g3", frozen_ts: "x", result: "PUSH", settlement_ts: "s" }),
    record({ game_id: "g4", direction: "NONE", result: "UNGRADABLE", settlement_ts: "s" }),
  ];
  const overall = buildSummaryRows(rows, "2026-09-18T06:00:00Z")[0]!;
  assert.equal(overall[5], 1);
  assert.equal(overall[6], 1);
  assert.equal(overall[7], 1);
  assert.equal(overall[8], 1);
  assert.equal(overall[9], 2);
  assert.equal(overall[10], 0.5);
});
