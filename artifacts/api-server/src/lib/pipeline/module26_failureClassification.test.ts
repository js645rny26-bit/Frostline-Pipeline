import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_CLASSIFICATION_REPLAY_HEADERS,
  FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS,
  FAILURE_CLASSIFICATION_SHADOW_HEADERS,
  buildFailureClassificationDiscriminationRows,
  buildFailureClassificationReplayRows,
  buildFailureClassificationShadowRow,
  parseFailureClassificationPackets,
  parseFrozenFailureClassifications,
  parseFrozenReferenceMarkets,
  parseSettledFailureClassificationGameTruth,
  upsertFailureClassificationRows,
} from "./module26_failureClassification.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { GAME_TRUTH_REPLAY_HEADERS } from "./module24_postgameDiagnostics.js";
import { WORKBOOK_ROADMAP } from "../workbook/workbookRoadmap.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";
import { computeDecision } from "./module11_outputExtraction.js";

const snapshot = "2026-08-30T16:00:00.000Z";
const firstPitch = "2026-08-30T17:10:00.000Z";

function setByHeader(
  row: unknown[],
  header: readonly string[],
  name: string,
  value: unknown,
): void {
  const index = header.indexOf(name);
  assert.notEqual(index, -1, `missing fixture header: ${name}`);
  row[index] = value;
}

function packetRow(overrides: Record<string, unknown> = {}): unknown[] {
  const row = Array(PREGAME_PACKET_HISTORY_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: "2026-08-30",
    Game_ID: "20260830_AAA_BBB",
    Away_Team: "AAA",
    Home_Team: "BBB",
    Scheduled_First_Pitch: firstPitch,
    Packet_Snapshot_TS: snapshot,
    Packet_Status: "OPEN_PROSPECTIVE",
    Base_Projection: 8.5,
    Starter_Attack_Runs: 5.2,
    Bullpen_Continuation_Runs: 2.3,
    Away_Bullpen_Exposure_IP: 3,
    Home_Bullpen_Exposure_IP: 3.5,
    Away_Starter_Role: "CONVENTIONAL_STARTER",
    Home_Starter_Role: "CONVENTIONAL_STARTER",
    Away_Expected_IP: 6,
    Home_Expected_IP: 6,
    Collision_Status: "PROSPECTIVE_SHADOW_CANDIDATE",
    Collision_Traffic_Estimate: 0.35,
    Collision_Damage_Estimate: 0.45,
    ...overrides,
  };
  for (const [name, fieldValue] of Object.entries(fields)) {
    setByHeader(row, PREGAME_PACKET_HISTORY_HEADERS, name, fieldValue);
  }
  return row;
}

function classificationRow(overrides: Record<string, unknown> = {}): unknown[] {
  const row = Array(FAILURE_CLASSIFICATION_SHADOW_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: "2026-08-30",
    Game_ID: "20260830_AAA_BBB",
    Packet_Snapshot_TS: snapshot,
    Packet_Status: "FROZEN_PREGAME",
    Classification_Status: "FROZEN_PREGAME_SHADOW",
    Opener_Chain_Status: "OPENER_CHAIN_UNCERTAINTY",
    Scoring_Path_Status: "BULLPEN_PHASE_RELIANT",
    Traffic_Conversion_Status: "TRAFFIC_DAMAGE_COSIGNED_NO_CONVERSION_INFERENCE",
    Traffic_Damage_CoSign_Status: "TRAFFIC_AND_DAMAGE_COSIGNED",
    Distribution_Structure_Status: "OPENER_CHAIN_UNCERTAINTY",
    Distribution_Risk_Tags: "OPENER_CHAIN_UNCERTAINTY; BULLPEN_CONTINUATION_DEPENDENT",
    ...overrides,
  };
  for (const [name, fieldValue] of Object.entries(fields)) {
    setByHeader(row, FAILURE_CLASSIFICATION_SHADOW_HEADERS, name, fieldValue);
  }
  return row;
}

function truthRow(overrides: Record<string, unknown> = {}): unknown[] {
  const row = Array(GAME_TRUTH_REPLAY_HEADERS.length).fill("");
  const fields: Record<string, unknown> = {
    Date: "2026-08-30",
    Game_ID: "20260830_AAA_BBB",
    Frozen_Packet_Snapshot_TS: snapshot,
    Actual_Total: 12,
    Total_Error: -3.5,
    Total_Abs_Error: 3.5,
    Starter_Window_Runs_Total: 6,
    Bullpen_Window_Runs_Total: 6,
    Primary_Scoring_Mechanism: "BALANCED_STARTER_AND_BULLPEN",
    Allocation_MAE: 2.5,
    Allocation_Sign_Reversal: "FALSE",
    Away_Conversion_Outcome: "TRAFFIC_REALIZED_ALLOCATION_MET",
    Home_Conversion_Outcome: "TRAFFIC_REALIZED_CONVERSION_SHORTFALL",
    Replay_Status: "FROZEN_PACKET_AND_FINAL_VERIFIED",
    Settlement_TS: "2026-08-31T03:00:00.000Z",
    ...overrides,
  };
  for (const [name, fieldValue] of Object.entries(fields)) {
    setByHeader(row, GAME_TRUTH_REPLAY_HEADERS, name, fieldValue);
  }
  return row;
}

function outputValue(row: unknown[], name: (typeof FAILURE_CLASSIFICATION_SHADOW_HEADERS)[number]): unknown {
  return row[FAILURE_CLASSIFICATION_SHADOW_HEADERS.indexOf(name)];
}

test("opener identification creates chain uncertainty without changing price-blind phase evidence", () => {
  const packets = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Away_Starter_Role: "OPENER", Away_Expected_IP: 1.33 }),
  ]);
  assert.equal(packets.packets_ineligible, 0);
  const row = buildFailureClassificationShadowRow(packets.packets[0]!, snapshot);
  assert.equal(outputValue(row, "Opener_Chain_Status"), "OPENER_CHAIN_UNCERTAINTY");
  assert.equal(outputValue(row, "Distribution_Structure_Status"), "OPENER_CHAIN_UNCERTAINTY");
  assert.equal(outputValue(row, "Projection_Impact_Status"), "SHADOW_ONLY_NO_PROJECTION_IMPACT");
  assert.equal(outputValue(row, "Authorization_Impact_Status"), "SHADOW_ONLY_NO_AUTHORIZATION_IMPACT");
  assert.equal(outputValue(row, "Starter_Phase_Runs"), 5.2);
});

test("clean conventional-starter suppression remains unclassified rather than receiving an opener or bullpen tax", () => {
  const packets = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({
      Collision_Status: "UNAVAILABLE",
      Collision_Traffic_Estimate: "",
      Collision_Damage_Estimate: "",
    }),
  ]);
  const row = buildFailureClassificationShadowRow(packets.packets[0]!, snapshot);
  assert.equal(outputValue(row, "Opener_Chain_Status"), "NO_OPENER_IDENTIFIED");
  assert.equal(outputValue(row, "Scoring_Path_Status"), "STARTER_PHASE_SUPPORTED");
  assert.equal(outputValue(row, "Distribution_Structure_Status"), "NO_CLASSIFIED_WIDENING_PATH");
});

test("traffic without damage explicitly declines to infer conversion", () => {
  const packets = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Collision_Traffic_Estimate: 0.4, Collision_Damage_Estimate: 0 }),
  ]);
  const row = buildFailureClassificationShadowRow(packets.packets[0]!, snapshot);
  assert.equal(outputValue(row, "Traffic_Damage_CoSign_Status"), "TRAFFIC_WITHOUT_DAMAGE_COSIGN");
  assert.equal(outputValue(row, "Traffic_Conversion_Status"), "TRAFFIC_ONLY_NO_CONVERSION_INFERENCE");
  assert.equal(outputValue(row, "CoSign_Fragility_Status"), "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY");
  assert.equal(outputValue(row, "Distribution_Structure_Status"), "ASYMMETRIC_SCORING_SUPPORT");
  assert.match(String(outputValue(row, "Distribution_Risk_Tags")), /TRAFFIC_WITHOUT_DAMAGE_FRAGILITY/);
});

test("damage without traffic is a distinct asymmetric fragility rather than a co-signed tail", () => {
  const packets = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Collision_Traffic_Estimate: 0, Collision_Damage_Estimate: 0.4 }),
  ]);
  const row = buildFailureClassificationShadowRow(packets.packets[0]!, snapshot);
  assert.equal(outputValue(row, "Traffic_Damage_CoSign_Status"), "DAMAGE_WITHOUT_TRAFFIC_COSIGN");
  assert.equal(outputValue(row, "CoSign_Fragility_Status"), "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY");
  assert.equal(outputValue(row, "Distribution_Structure_Status"), "ASYMMETRIC_SCORING_SUPPORT");
  assert.doesNotMatch(String(outputValue(row, "Distribution_Risk_Tags")), /TRAFFIC_DAMAGE_TAIL_CANDIDATE/);
});

test("traffic and damage stay a tail candidate without an automatic projection or authorization consequence", () => {
  const packets = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow(),
  ]);
  const row = buildFailureClassificationShadowRow(packets.packets[0]!, snapshot);
  assert.equal(outputValue(row, "CoSign_Fragility_Status"), "TRAFFIC_DAMAGE_TAIL_CANDIDATE");
  assert.equal(outputValue(row, "Distribution_Structure_Status"), "TRAFFIC_DAMAGE_TAIL_CANDIDATE");
  assert.equal(outputValue(row, "Projection_Impact_Status"), "SHADOW_ONLY_NO_PROJECTION_IMPACT");
  assert.equal(outputValue(row, "Authorization_Impact_Status"), "SHADOW_ONLY_NO_AUTHORIZATION_IMPACT");
});

test("market fields are absent from the classifier and cannot alter its labels", () => {
  const reference = packetRow({ Market_Line: 7.5, Primary_Grade_Market_Line: 7.5 });
  const executable = packetRow({ Market_Line: 10.5, Primary_Grade_Market_Line: 10.5 });
  const first = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    reference,
  ]).packets[0]!;
  const second = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    executable,
  ]).packets[0]!;
  assert.deepEqual(
    buildFailureClassificationShadowRow(first, snapshot),
    buildFailureClassificationShadowRow(second, snapshot),
  );
});

test("toggling any shadow-only co-sign classification leaves operational decision output identical", () => {
  const trafficOnly = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Collision_Traffic_Estimate: 0.4, Collision_Damage_Estimate: 0 }),
  ]).packets[0]!;
  const damageOnly = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Collision_Traffic_Estimate: 0, Collision_Damage_Estimate: 0.4 }),
  ]).packets[0]!;
  const trafficShadow = buildFailureClassificationShadowRow(trafficOnly, snapshot);
  const damageShadow = buildFailureClassificationShadowRow(damageOnly, snapshot);
  assert.notEqual(
    outputValue(trafficShadow, "CoSign_Fragility_Status"),
    outputValue(damageShadow, "CoSign_Fragility_Status"),
  );
  const operatingInputs = [8.5, 7.5, "FULL_GAME_TOTAL", {
    awayPitcherRole: "CONVENTIONAL_STARTER",
    homePitcherRole: "CONVENTIONAL_STARTER",
    awayExpectedInnings: 6,
    homeExpectedInnings: 6,
    bullpenAvailable: true,
  }] as const;
  const before = computeDecision(...operatingInputs);
  const after = computeDecision(...operatingInputs);
  assert.deepEqual(before, after);
});

test("frozen shadow labels remain immutable when a later packet synchronization runs", () => {
  const packet = parseFailureClassificationPackets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Packet_Status: "FROZEN_PREGAME", Away_Starter_Role: "OPENER" }),
  ]).packets[0]!;
  const frozen = classificationRow({
    Classification_TS: "2026-08-30T16:01:00.000Z",
    Distribution_Risk_Tags: "ORIGINAL_FROZEN_LABEL",
  });
  const mutation = upsertFailureClassificationRows(
    [frozen],
    [packet],
    "2026-08-30T17:20:00.000Z",
  );
  assert.equal(mutation.rows_written, 0);
  assert.equal(mutation.rows_updated, 0);
  assert.equal(mutation.rows_frozen_preserved, 1);
  assert.equal(
    mutation.rows[0]?.[FAILURE_CLASSIFICATION_SHADOW_HEADERS.indexOf("Distribution_Risk_Tags")],
    "ORIGINAL_FROZEN_LABEL",
  );
});

test("replay joins only matching frozen classifications to canonical settled game truth", () => {
  const frozen = parseFrozenFailureClassifications([
    Array.from(FAILURE_CLASSIFICATION_SHADOW_HEADERS),
    classificationRow(),
    classificationRow({ Game_ID: "20260830_OPEN", Packet_Status: "OPEN_PROSPECTIVE", Classification_Status: "OPEN_PROSPECTIVE_SHADOW" }),
  ]);
  const truth = parseSettledFailureClassificationGameTruth([
    Array.from(GAME_TRUTH_REPLAY_HEADERS),
    truthRow(),
    truthRow({ Game_ID: "20260830_MISMATCH", Frozen_Packet_Snapshot_TS: "2026-08-30T16:05:00.000Z" }),
  ]);
  const markets = parseFrozenReferenceMarkets([
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    packetRow({ Packet_Status: "FROZEN_PREGAME", Reference_Market_Line: 8 }),
  ]);
  const replay = buildFailureClassificationReplayRows(frozen, truth, markets);
  assert.equal(frozen.size, 1);
  assert.equal(replay.snapshot_mismatches, 0);
  assert.equal(replay.rows.length, 1);
  assert.equal(replay.rows[0]?.[FAILURE_CLASSIFICATION_REPLAY_HEADERS.indexOf("Replay_Status")], "FROZEN_CLASSIFICATION_RESEARCH_ONLY");
  assert.equal(replay.rows[0]?.[FAILURE_CLASSIFICATION_REPLAY_HEADERS.indexOf("Actual_Total")], 12);
  assert.equal(replay.rows[0]?.[FAILURE_CLASSIFICATION_REPLAY_HEADERS.indexOf("Reference_Directional_Result")], "WIN");
  assert.equal(replay.rows[0]?.[FAILURE_CLASSIFICATION_REPLAY_HEADERS.indexOf("Warning_Outcome_Quadrant")], "WARNED_NO_MAJOR_MISS");
});

test("discrimination report retains asymmetric co-sign buckets and all warning outcome quadrants", () => {
  const makeReplay = (overrides: Record<string, unknown>): unknown[] => {
    const row = Array(FAILURE_CLASSIFICATION_REPLAY_HEADERS.length).fill("");
    const fields: Record<string, unknown> = {
      Frozen_Traffic_Damage_CoSign_Status: "TRAFFIC_WITHOUT_DAMAGE_COSIGN",
      Frozen_CoSign_Fragility_Status: "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY",
      Frozen_Distribution_Structure_Status: "ASYMMETRIC_SCORING_SUPPORT",
      Frozen_Distribution_Risk_Tags: "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY",
      Total_Abs_Error: 4.14,
      Total_Error: 4.14,
      Actual_Starter_Window_Runs: 2,
      Actual_Bullpen_Window_Runs: 3,
      Primary_Scoring_Mechanism: "STARTER_WINDOW_PRIMARY",
      Reference_Directional_Result: "LOSS",
      Major_Center_Miss_Status: "ABS_ERROR_4_PLUS",
      Warning_Outcome_Quadrant: "WARNED_MAJOR_MISS",
      False_Negative_Distribution_Case: "FALSE",
      CoSign_Comparison_Bucket: "TRAFFIC_WITHOUT_DAMAGE_COSIGN",
      ...overrides,
    };
    for (const [name, fieldValue] of Object.entries(fields)) {
      setByHeader(row, FAILURE_CLASSIFICATION_REPLAY_HEADERS, name, fieldValue);
    }
    return row;
  };
  const summary = buildFailureClassificationDiscriminationRows([
    makeReplay({}),
    makeReplay({
      Frozen_Traffic_Damage_CoSign_Status: "DAMAGE_WITHOUT_TRAFFIC_COSIGN",
      Frozen_CoSign_Fragility_Status: "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY",
      Frozen_Distribution_Risk_Tags: "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY",
      CoSign_Comparison_Bucket: "DAMAGE_WITHOUT_TRAFFIC_COSIGN",
      Total_Abs_Error: 1,
      Total_Error: -1,
      Reference_Directional_Result: "WIN",
      Major_Center_Miss_Status: "ABS_ERROR_UNDER_4",
      Warning_Outcome_Quadrant: "WARNED_NO_MAJOR_MISS",
    }),
    makeReplay({
      Frozen_Traffic_Damage_CoSign_Status: "NO_PROSPECTIVE_COLLISION_EVIDENCE",
      Frozen_CoSign_Fragility_Status: "NO_COSIGN_FRAGILITY_CLASSIFICATION",
      Frozen_Distribution_Structure_Status: "NO_CLASSIFIED_WIDENING_PATH",
      Frozen_Distribution_Risk_Tags: "NO_CLASSIFIED_RISK_TAG",
      CoSign_Comparison_Bucket: "NEITHER_OR_UNAVAILABLE",
      Total_Abs_Error: 5,
      Total_Error: -5,
      Reference_Directional_Result: "PUSH",
      Major_Center_Miss_Status: "ABS_ERROR_4_PLUS",
      Warning_Outcome_Quadrant: "NO_WARNING_MAJOR_MISS",
      False_Negative_Distribution_Case: "TRUE",
    }),
  ], "2026-08-31T03:00:00.000Z");
  const coSignRows = summary.filter((row) => row[0] === "CO_SIGN_COMPARISON");
  assert.deepEqual(coSignRows.map((row) => row[1]).sort(), [
    "DAMAGE_WITHOUT_TRAFFIC_COSIGN",
    "NEITHER_OR_UNAVAILABLE",
    "TRAFFIC_WITHOUT_DAMAGE_COSIGN",
  ]);
  const falseNegative = summary.find(
    (row) => row[0] === "FALSE_NEGATIVE_DISTRIBUTION" && row[1] === "TRUE",
  );
  assert.equal(falseNegative?.[2], 1);
  assert.equal(falseNegative?.[6], 1);
  assert.equal(FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS.length, falseNegative?.length);
});

test("failure-classification surfaces are documented as Module 26 research-only sheets", () => {
  const columns = (sheet: string) => WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map(
    (column) => column.name,
  );
  assert.deepEqual(columns("FAILURE_CLASSIFICATION_SHADOW_V1"), FAILURE_CLASSIFICATION_SHADOW_HEADERS);
  assert.deepEqual(columns("FAILURE_CLASSIFICATION_REPLAY_V1"), FAILURE_CLASSIFICATION_REPLAY_HEADERS);
  assert.deepEqual(columns("FAILURE_CLASSIFICATION_DISCRIMINATION_V1"), FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS);
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "FAILURE_CLASSIFICATION_SHADOW_V1"));
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "FAILURE_CLASSIFICATION_REPLAY_V1"));
  assert.ok(WORKBOOK_ROADMAP.some((entry) => entry.sheet === "FAILURE_CLASSIFICATION_DISCRIMINATION_V1"));
});
