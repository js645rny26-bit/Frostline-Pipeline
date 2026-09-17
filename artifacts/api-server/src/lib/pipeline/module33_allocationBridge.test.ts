import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ALLOCATION_BRIDGE_DIAG_HEADERS,
  ALLOCATION_BRIDGE_HEADERS,
  ALLOCATION_BRIDGE_REPLAY_HEADERS,
  ALLOCATION_BRIDGE_SUMMARY_HEADERS,
  FIXED_TOTAL_TOLERANCE,
  buildAllocationBridgeInputs,
  buildAllocationBridgeRecord,
  selectAllocationBridgeVerdict,
} from "./module33_allocationBridge.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { ALLOCATION_SETTLEMENT_HEADERS } from "./module24_postgameDiagnostics.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";

function row(headers: readonly string[], values: Record<string, unknown>): unknown[] {
  return headers.map((header) => values[header] ?? "");
}

function packet(overrides: Record<string, unknown> = {}): unknown[] {
  return row(PREGAME_PACKET_HISTORY_HEADERS, {
    Date: "2026-09-13", Game_ID: "20260913_AAA_BBB", Away_Team: "AAA", Home_Team: "BBB",
    Scheduled_First_Pitch: "2026-09-13T23:00:00.000Z", Packet_Status: "FROZEN_PREGAME",
    Packet_Snapshot_TS: "2026-09-13T18:00:00.000Z", Base_Away_Projection: 5,
    Base_Home_Projection: 4, Base_Projection: 9, Away_Starter_Role: "CONVENTIONAL_STARTER",
    Home_Starter_Role: "CONVENTIONAL_STARTER", Away_Starter_Quality: 1.1,
    Home_Starter_Quality: 0.9, Bullpen_Data_Status: "AVAILABLE", Away_Lineup_Status: "FULL",
    Home_Lineup_Status: "FULL", Away_Lineup_Coverage: 1, Home_Lineup_Coverage: 1,
    Run_Multiplier: 1, Away_Pitcher_Effective_IP: 6, Home_Pitcher_Effective_IP: 5.5,
    Away_Traffic_Matchup_Factor: 1.01, Home_Traffic_Matchup_Factor: 0.99,
    Away_Damage_Matchup_Factor: 1.02, Home_Damage_Matchup_Factor: 0.98,
    Away_Matchup_Profile_Status: "ACTIVE", Home_Matchup_Profile_Status: "ACTIVE",
    Away_Active_Offense_Center: 3, Home_Active_Offense_Center: 6,
    Away_Starter_Quality_Source: "FIP", Home_Starter_Quality_Source: "FIP",
    Away_Bullpen_Quality_Source: "SEASON_ERA", Home_Bullpen_Quality_Source: "SEASON_ERA",
    Traffic_Conversion_Runs: 0.05, HR_XBH_Damage_Runs: 0,
    ...overrides,
  });
}

function outcome(overrides: Record<string, unknown> = {}): unknown[] {
  return row(ALLOCATION_SETTLEMENT_HEADERS, {
    Date: "2026-09-13", Game_ID: "20260913_AAA_BBB",
    Frozen_Packet_Snapshot_TS: "2026-09-13T18:00:00.000Z",
    Projected_Away_Runs: 5, Projected_Home_Runs: 4, Projected_Total: 9,
    Actual_Away_Runs: 3, Actual_Home_Runs: 6, Actual_Total: 9,
    Diagnostic_Status: "FROZEN_PACKET_VERIFIED", ...overrides,
  });
}

function build(overrides: { packet?: Record<string, unknown>; outcome?: Record<string, unknown> } = {}) {
  const inputs = buildAllocationBridgeInputs(
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), packet(overrides.packet)],
    [Array.from(ALLOCATION_SETTLEMENT_HEADERS), outcome(overrides.outcome)],
  );
  assert.equal(inputs.length, 1);
  return buildAllocationBridgeRecord(inputs[0]!);
}

test("allocation bridge schema exposes the four research surfaces", () => {
  assert.ok(ALLOCATION_BRIDGE_HEADERS.includes("Frozen_Total"));
  assert.ok(ALLOCATION_BRIDGE_REPLAY_HEADERS.includes("Bridge_Combined_Team_MAE"));
  assert.ok(ALLOCATION_BRIDGE_SUMMARY_HEADERS.includes("Research_Verdict"));
  assert.ok(ALLOCATION_BRIDGE_DIAG_HEADERS.includes("Failure_Classification"));
  assert.equal(WORKBOOK_SCHEMA_VERSION, 66);
  for (const [sheet, headers] of [
    ["ALLOCATION_BRIDGE_V1", ALLOCATION_BRIDGE_HEADERS],
    ["ALLOCATION_BRIDGE_REPLAY_V1", ALLOCATION_BRIDGE_REPLAY_HEADERS],
    ["ALLOCATION_BRIDGE_SUMMARY_V1", ALLOCATION_BRIDGE_SUMMARY_HEADERS],
    ["ALLOCATION_BRIDGE_DIAG_V1", ALLOCATION_BRIDGE_DIAG_HEADERS],
  ] as const) {
    assert.deepEqual(
      WORKBOOK_SCHEMA.find((definition) => definition.name === sheet)?.columns.map((column) => column.name),
      Array.from(headers),
    );
  }
});

test("bridge preserves the frozen total exactly and can reverse allocation sign", () => {
  const record = build();
  assert.equal(record.research_status, "ELIGIBLE");
  assert.equal(record.invariant_status, "PASS");
  assert.ok(record.bridge_away! < record.bridge_home!);
  assert.ok(Math.abs(record.bridge_away! + record.bridge_home! - 9) <= FIXED_TOTAL_TOLERANCE);
  assert.equal(record.failure_classification, "STARTER_WEIGHT_OVERREACH");
});

test("actual results cannot alter the pre-registered bridge projections", () => {
  const first = build({ outcome: { Actual_Away_Runs: 3, Actual_Home_Runs: 6 } });
  const second = build({ outcome: { Actual_Away_Runs: 8, Actual_Home_Runs: 1 } });
  assert.equal(first.bridge_away, second.bridge_away);
  assert.equal(first.bridge_home, second.bridge_home);
  assert.deepEqual(first.away, second.away);
  assert.deepEqual(first.home, second.home);
});

test("snapshot mismatch fails closed instead of joining a different frozen packet", () => {
  const record = build({ outcome: { Frozen_Packet_Snapshot_TS: "2026-09-13T17:00:00.000Z" } });
  assert.equal(record.research_status, "EXCLUDED");
  assert.equal(record.exclusion_reason, "FROZEN_PACKET_SNAPSHOT_MISMATCH");
  assert.equal(record.invariant_status, "NOT_EVALUATED");
});

test("missing active offense center remains an explicit exclusion", () => {
  const record = build({ packet: { Away_Active_Offense_Center: "" } });
  assert.equal(record.research_status, "EXCLUDED");
  assert.equal(record.exclusion_reason, "FROZEN_BRIDGE_COMPONENTS_MISSING");
});

test("geometric bridge gives offense identity full weight and opponent system half log-weight", () => {
  const record = build();
  assert.ok(record.away && record.home);
  const expectedAwaySupport = 3 * Math.sqrt(5 / 3);
  const expectedHomeSupport = 6 * Math.sqrt(4 / 6);
  assert.ok(Math.abs(record.away.support - expectedAwaySupport) < 1e-12);
  assert.ok(Math.abs(record.home.support - expectedHomeSupport) < 1e-12);
  assert.ok(Math.abs(
    record.away.offense + record.away.starter + record.away.traffic
      + record.away.damage + record.away.bullpen
      - Math.log(record.away.support / 4.5),
  ) < 1e-12);
});

test("verdict becomes candidate only when all three primary allocation measures improve", () => {
  const records = Array.from({ length: 100 }, (_, index) => build({
    packet: { Game_ID: `20260913_AAA_BBB_${index}` },
    outcome: { Game_ID: `20260913_AAA_BBB_${index}` },
  }));
  assert.equal(selectAllocationBridgeVerdict(records), "CANDIDATE_FOR_COMMISSIONING");
});

test("verdict holds below 100 eligible games", () => {
  assert.equal(selectAllocationBridgeVerdict([build()]), "HOLD");
});

test("allocation bridge has no pregame projection, board, packet, market, or ticket consumer", () => {
  for (const module of [
    "module09_recalculation.ts", "module11_outputExtraction.ts",
    "module17_vehiclePostmortem.ts", "module20a_pregamePacket.ts",
    "module20b_operatorEvidence.ts",
  ]) {
    const source = readFileSync(new URL(`./${module}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /AllocationBridge|ALLOCATION_BRIDGE/);
  }
});
