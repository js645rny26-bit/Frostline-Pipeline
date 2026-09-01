import assert from "node:assert/strict";
import test from "node:test";

import {
  SEPARATION_GATE_AUDIT_HEADERS,
  SEPARATION_GATE_AUDIT_SUMMARY_HEADERS,
  buildSeparationGateAuditRows,
  buildSeparationGateAuditSummary,
  parseFrozenSeparationPackets,
  parseSettledSeparationGameTruth,
  wilson95,
} from "./module27_separationGateAudit.js";
import {
  buildFrozenSeparationState,
  classifyAdjacentThresholdCohort,
  classifyPriceBlindStructuralEligibility,
  classifySeparationCohort,
} from "./separationGateShared.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { GAME_TRUTH_REPLAY_HEADERS } from "./module24_postgameDiagnostics.js";
import { WORKBOOK_ROADMAP } from "../workbook/workbookRoadmap.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

const snapshot = "2026-09-01T17:00:00.000Z";
const firstPitch = "2026-09-01T19:10:00.000Z";
const allTruthChecks = [
  "STARTERS_RESOLVED=PASS",
  "EXPECTED_INNINGS_PRESENT=PASS",
  "BULLPEN_USABLE=PASS",
  "OFFENSE_SOURCE_USABLE=PASS",
  "LINEUP_DATA_USABLE=PASS",
  "PARK_SOURCE_USABLE=PASS",
].join(" | ");

function setByHeader(row: unknown[], header: readonly string[], name: string, value: unknown): void {
  const index = header.indexOf(name);
  assert.notEqual(index, -1, `missing fixture header: ${name}`);
  row[index] = value;
}

function packetRow(overrides: Record<string, unknown> = {}): unknown[] {
  const row = Array(PREGAME_PACKET_HISTORY_HEADERS.length).fill("");
  const state = buildFrozenSeparationState({
    truth_checks: allTruthChecks,
    projected_total: 9.45,
    query_line: 8.0,
    has_literal_executable_hard_rock_line: false,
  });
  const fields: Record<string, unknown> = {
    Date: "2026-09-01",
    Game_ID: "20260901_AAA_BBB",
    Scheduled_First_Pitch: firstPitch,
    Packet_Status: "FROZEN_PREGAME",
    Packet_Snapshot_TS: snapshot,
    Base_Projection: 9.45,
    Engine_Version: "test-engine",
    Schema_Version: 46,
    Separation_Pre_Registration_Version: state.pre_registration_version,
    Price_Blind_Structural_Eligibility_Status: state.price_blind_structural_eligibility_status,
    Price_Blind_Structural_Failed_Checks: state.price_blind_structural_failed_checks,
    Separation_Query_Line: state.separation_query_line,
    Separation_Market_Provenance: state.separation_market_provenance,
    Separation_Hard_Rock_Calibration_Status: state.separation_hard_rock_calibration_status,
    Separation_Continuous: state.separation_continuous,
    Separation_Cohort: state.separation_cohort,
    Separation_Adjacent_Threshold_Cohort: state.separation_adjacent_threshold_cohort,
    Separation_Research_Tag: state.separation_research_tag,
    ...overrides,
  };
  for (const [name, fieldValue] of Object.entries(fields)) {
    setByHeader(row, PREGAME_PACKET_HISTORY_HEADERS, name, fieldValue);
  }
  return row;
}

function truthRow(overrides: Record<string, unknown> = {}): unknown[] {
  const row = Array(GAME_TRUTH_REPLAY_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: "2026-09-01",
    Game_ID: "20260901_AAA_BBB",
    Frozen_Packet_Snapshot_TS: snapshot,
    Actual_Total: 10,
    Total_Error: -0.55,
    Total_Abs_Error: 0.55,
    Replay_Status: "FROZEN_PACKET_AND_FINAL_VERIFIED",
    Settlement_TS: "2026-09-02T03:00:00.000Z",
    ...overrides,
  };
  for (const [name, fieldValue] of Object.entries(fields)) {
    setByHeader(row, GAME_TRUTH_REPLAY_HEADERS, name, fieldValue);
  }
  return row;
}

test("the primary cohort is all and only fixed price-blind Truth checks", () => {
  assert.deepEqual(classifyPriceBlindStructuralEligibility(allTruthChecks), {
    status: "PRICE_BLIND_STRUCTURAL_ELIGIBLE",
    failed_or_missing_checks: "",
  });
  assert.equal(
    classifyPriceBlindStructuralEligibility(allTruthChecks.replace("BULLPEN_USABLE=PASS", "BULLPEN_USABLE=FAIL")).status,
    "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_FAILED",
  );
  assert.equal(
    classifyPriceBlindStructuralEligibility("STARTERS_RESOLVED=PASS").status,
    "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_MISSING",
  );
});

test("separation bins retain the pre-registered boundary and adjacent comparison", () => {
  assert.equal(classifySeparationCohort(0.74), "LOW_UNDER_0.75");
  assert.equal(classifySeparationCohort(0.75), "MODERATE_0.75_1.24");
  assert.equal(classifySeparationCohort(1.45), "NEAR_BOUNDARY_1.25_1.49");
  assert.equal(classifySeparationCohort(1.5), "CURRENT_QUALIFIED_1.50_1.99");
  assert.equal(classifySeparationCohort(2), "LARGE_2.00_PLUS");
  assert.equal(classifyAdjacentThresholdCohort(1.45), "NEAR_BOUNDARY_1.25_1.49");
  assert.equal(classifyAdjacentThresholdCohort(1.5), "ADJACENT_ABOVE_1.50_1.74");
  assert.equal(classifyAdjacentThresholdCohort(1.75), "OUTSIDE_ADJACENT_COMPARISON");
});

test("reference-only near-boundary evidence is visible but never Hard Rock calibration evidence", () => {
  const reference = buildFrozenSeparationState({
    truth_checks: allTruthChecks,
    projected_total: 9.45,
    query_line: 8,
    has_literal_executable_hard_rock_line: false,
  });
  assert.equal(reference.separation_continuous, 1.45);
  assert.equal(reference.separation_cohort, "NEAR_BOUNDARY_1.25_1.49");
  assert.equal(reference.separation_research_tag, "NEAR_BOUNDARY_REFERENCE");
  assert.equal(reference.separation_hard_rock_calibration_status, "REFERENCE_ONLY_NOT_HARD_ROCK_CALIBRATION");

  const literalHalf = buildFrozenSeparationState({
    truth_checks: allTruthChecks,
    projected_total: 9.45,
    query_line: 8.5,
    has_literal_executable_hard_rock_line: true,
  });
  assert.equal(literalHalf.separation_hard_rock_calibration_status, "LITERAL_HARD_ROCK_HALF_TOTAL");

  const literalWhole = buildFrozenSeparationState({
    truth_checks: allTruthChecks,
    projected_total: 9.45,
    query_line: 8,
    has_literal_executable_hard_rock_line: true,
  });
  assert.equal(literalWhole.separation_hard_rock_calibration_status, "LITERAL_HARD_ROCK_NON_HALF_TOTAL_RESEARCH_ONLY");
});

test("settlement joins only matching frozen packets and preserves reference provenance", () => {
  const packets = parseFrozenSeparationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow(),
    packetRow({ Game_ID: "20260901_OPEN", Packet_Status: "OPEN_PROSPECTIVE" }),
  ]);
  const outcomes = parseSettledSeparationGameTruth([
    Array.from(GAME_TRUTH_REPLAY_HEADERS),
    truthRow(),
    truthRow({ Game_ID: "20260901_MISMATCH", Frozen_Packet_Snapshot_TS: "2026-09-01T17:05:00.000Z" }),
  ]);
  const audit = buildSeparationGateAuditRows(packets, outcomes);
  assert.equal(packets.size, 1);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.structural_eligible_packets_seen, 1);
  assert.equal(audit.snapshot_mismatches, 0);
  assert.equal(audit.rows[0]?.[SEPARATION_GATE_AUDIT_HEADERS.indexOf("Direction_From_Queried_Line")], "OVER");
  assert.equal(audit.rows[0]?.[SEPARATION_GATE_AUDIT_HEADERS.indexOf("Directional_Result")], "WIN");
  assert.equal(audit.rows[0]?.[SEPARATION_GATE_AUDIT_HEADERS.indexOf("Separation_Research_Tag")], "NEAR_BOUNDARY_REFERENCE");
});

test("summary exposes empty bins, Wilson intervals, and Hard Rock/reference populations separately", () => {
  const packet = packetRow({
    Separation_Market_Provenance: "LITERAL_EXECUTABLE_HARD_ROCK",
    Separation_Hard_Rock_Calibration_Status: "LITERAL_HARD_ROCK_HALF_TOTAL",
    Separation_Query_Line: 8.5,
    Separation_Continuous: 1.5,
    Separation_Cohort: "CURRENT_QUALIFIED_1.50_1.99",
    Separation_Adjacent_Threshold_Cohort: "ADJACENT_ABOVE_1.50_1.74",
    Separation_Research_Tag: "HARD_ROCK_CURRENT_QUALIFIED_1.50_1.99",
  });
  const rows = buildSeparationGateAuditRows(
    parseFrozenSeparationPackets([Array.from(PREGAME_PACKET_HISTORY_HEADERS), packet]),
    parseSettledSeparationGameTruth([Array.from(GAME_TRUTH_REPLAY_HEADERS), truthRow()]),
  ).rows;
  const summary = buildSeparationGateAuditSummary(rows, "2026-09-02T03:00:00.000Z");
  assert.equal(summary.length, 21); // 3 evidence populations × (5 bins + 2 adjacent groups)
  const literal = summary.find((row) =>
    row[0] === "LITERAL_HARD_ROCK_HALF_TOTAL_CALIBRATION" && row[1] === "CURRENT_QUALIFIED_1.50_1.99",
  );
  assert.equal(literal?.[3], 1);
  assert.equal(literal?.[5], 1);
  assert.ok(Number(literal?.[9]) < Number(literal?.[10]));
  const reference = summary.find((row) =>
    row[0] === "REFERENCE_ONLY_RESEARCH" && row[1] === "CURRENT_QUALIFIED_1.50_1.99",
  );
  assert.equal(reference?.[3], 0);
  assert.equal(literal?.length, SEPARATION_GATE_AUDIT_SUMMARY_HEADERS.length);
  assert.deepEqual(wilson95(1, 1), { lower: 0.207, upper: 1 });
});

test("separation audit surfaces are schema-documented and remain research-only", () => {
  const columns = (sheet: string) => WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map((column) => column.name);
  assert.deepEqual(columns("SEPARATION_GATE_AUDIT_V1"), SEPARATION_GATE_AUDIT_HEADERS);
  assert.deepEqual(columns("SEPARATION_GATE_AUDIT_SUMMARY_V1"), SEPARATION_GATE_AUDIT_SUMMARY_HEADERS);
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "SEPARATION_GATE_AUDIT_V1"));
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "SEPARATION_GATE_AUDIT_SUMMARY_V1"));
});
