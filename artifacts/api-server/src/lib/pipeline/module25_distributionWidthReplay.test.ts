import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTRIBUTION_WIDTH_REPLAY_HEADERS,
  DISTRIBUTION_WIDTH_SUMMARY_HEADERS,
  buildDistributionWidthReplayRows,
  buildDistributionWidthSummary,
  parseFrozenDistributionPackets,
  parseSettledGameTruth,
} from "./module25_distributionWidthReplay.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";
import { WORKBOOK_ROADMAP } from "../workbook/workbookRoadmap.js";

function packetRow(gameId: string, snapshotTs: string): unknown[] {
  const header = [
    "Date",
    "Game_ID",
    "Scheduled_First_Pitch",
    "Packet_Status",
    "Packet_Snapshot_TS",
    "Base_Away_Projection",
    "Base_Home_Projection",
    "Base_Projection",
    "Away_Expected_IP",
    "Home_Expected_IP",
    "Away_Pitcher_Effective_IP",
    "Home_Pitcher_Effective_IP",
    "Starter_Attack_Runs",
    "Bullpen_Continuation_Runs",
    "Away_Bullpen_Exposure_IP",
    "Home_Bullpen_Exposure_IP",
    "SSAT_V1_Total",
    "SSAT_V2_Total",
    "Collision_Status",
    "Collision_Traffic_Estimate",
    "Collision_Damage_Estimate",
    "Collision_Tail_Adjustment",
    "Low_Center_Status",
    "Low_Center_Upper_Band",
  ];
  const values = new Map<string, unknown>([
    ["Date", "2026-08-27"],
    ["Game_ID", gameId],
    ["Scheduled_First_Pitch", "2026-08-27T23:40:00.000Z"],
    ["Packet_Status", "FROZEN_PREGAME"],
    ["Packet_Snapshot_TS", snapshotTs],
    ["Base_Away_Projection", 5],
    ["Base_Home_Projection", 4],
    ["Base_Projection", 9],
    ["Away_Expected_IP", 6],
    ["Home_Expected_IP", 6],
    ["Away_Pitcher_Effective_IP", 5.5],
    ["Home_Pitcher_Effective_IP", 5.75],
    ["Starter_Attack_Runs", 4],
    ["Bullpen_Continuation_Runs", 4],
    ["Away_Bullpen_Exposure_IP", 3.5],
    ["Home_Bullpen_Exposure_IP", 3.25],
    ["SSAT_V1_Total", 8.8],
    ["SSAT_V2_Total", 8.6],
    ["Collision_Status", "PROSPECTIVE_SHADOW_CANDIDATE"],
    ["Collision_Traffic_Estimate", 0.3],
    ["Collision_Damage_Estimate", 0.4],
    ["Collision_Tail_Adjustment", 0.5],
    ["Low_Center_Status", "NOT_APPLICABLE"],
    ["Low_Center_Upper_Band", ""],
  ]);
  return header.map((name) => values.get(name) ?? "");
}

function gameTruthRow(
  gameId: string,
  snapshotTs: string,
  totalError: number,
): unknown[] {
  const header = [
    "Date",
    "Game_ID",
    "Frozen_Packet_Snapshot_TS",
    "Actual_Total",
    "Total_Error",
    "Total_Abs_Error",
    "Allocation_MAE",
    "Allocation_Sign_Reversal",
    "Starter_Window_Runs_Total",
    "Bullpen_Window_Runs_Total",
    "Primary_Scoring_Mechanism",
    "Away_Conversion_Outcome",
    "Home_Conversion_Outcome",
    "Replay_Status",
    "Settlement_TS",
  ];
  const values = new Map<string, unknown>([
    ["Date", "2026-08-27"],
    ["Game_ID", gameId],
    ["Frozen_Packet_Snapshot_TS", snapshotTs],
    ["Actual_Total", 9 - totalError],
    ["Total_Error", totalError],
    ["Total_Abs_Error", Math.abs(totalError)],
    ["Allocation_MAE", 2],
    ["Allocation_Sign_Reversal", "FALSE"],
    ["Starter_Window_Runs_Total", 3],
    ["Bullpen_Window_Runs_Total", 4],
    ["Primary_Scoring_Mechanism", "BULLPEN_TRANSITION_PRIMARY"],
    ["Away_Conversion_Outcome", "NO_FROZEN_TRAFFIC_CANDIDATE"],
    ["Home_Conversion_Outcome", "NO_FROZEN_TRAFFIC_CANDIDATE"],
    ["Replay_Status", "FROZEN_PACKET_VERIFIED"],
    ["Settlement_TS", "2026-08-28T03:00:00.000Z"],
  ]);
  return header.map((name) => values.get(name) ?? "");
}

test("distribution-width replay uses only frozen pre-first-pitch packet evidence", () => {
  const packetHeader = [
    "Date", "Game_ID", "Scheduled_First_Pitch", "Packet_Status",
    "Packet_Snapshot_TS", "Base_Away_Projection", "Base_Home_Projection",
    "Base_Projection", "Away_Expected_IP", "Home_Expected_IP",
    "Away_Pitcher_Effective_IP", "Home_Pitcher_Effective_IP",
    "Starter_Attack_Runs", "Bullpen_Continuation_Runs",
    "Away_Bullpen_Exposure_IP", "Home_Bullpen_Exposure_IP", "SSAT_V1_Total",
    "SSAT_V2_Total", "Collision_Status", "Collision_Traffic_Estimate",
    "Collision_Damage_Estimate", "Collision_Tail_Adjustment", "Low_Center_Status",
    "Low_Center_Upper_Band",
  ];
  const valid = packetRow("20260827_AAA_BBB", "2026-08-27T20:00:00.000Z");
  const open = [...valid];
  open[1] = "20260827_OPEN";
  open[3] = "OPEN_PROSPECTIVE";
  const late = [...valid];
  late[1] = "20260827_LATE";
  late[4] = "2026-08-27T23:40:00.000Z";

  const packets = parseFrozenDistributionPackets([packetHeader, valid, open, late]);
  assert.deepEqual([...packets.keys()], ["2026-08-27|20260827_AAA_BBB"]);
  const packet = packets.get("2026-08-27|20260827_AAA_BBB");
  assert.equal(packet?.away_starter_pressure_shortfall_ip, 0.5);
  assert.equal(packet?.home_starter_pressure_shortfall_ip, 0.25);
  assert.equal(packet?.ssat_family_base_spread, 0.4);
});

test("distribution-width replay joins frozen inputs to settled truth without producing a projection", () => {
  const packetHeader = [
    "Date", "Game_ID", "Scheduled_First_Pitch", "Packet_Status",
    "Packet_Snapshot_TS", "Base_Away_Projection", "Base_Home_Projection",
    "Base_Projection", "Away_Expected_IP", "Home_Expected_IP",
    "Away_Pitcher_Effective_IP", "Home_Pitcher_Effective_IP",
    "Starter_Attack_Runs", "Bullpen_Continuation_Runs",
    "Away_Bullpen_Exposure_IP", "Home_Bullpen_Exposure_IP", "SSAT_V1_Total",
    "SSAT_V2_Total", "Collision_Status", "Collision_Traffic_Estimate",
    "Collision_Damage_Estimate", "Collision_Tail_Adjustment", "Low_Center_Status",
    "Low_Center_Upper_Band",
  ];
  const truthHeader = [
    "Date", "Game_ID", "Frozen_Packet_Snapshot_TS", "Actual_Total", "Total_Error",
    "Total_Abs_Error", "Allocation_MAE", "Allocation_Sign_Reversal",
    "Starter_Window_Runs_Total", "Bullpen_Window_Runs_Total",
    "Primary_Scoring_Mechanism", "Away_Conversion_Outcome", "Home_Conversion_Outcome",
    "Replay_Status", "Settlement_TS",
  ];
  const snapshot = "2026-08-27T20:00:00.000Z";
  const packets = parseFrozenDistributionPackets([
    packetHeader,
    packetRow("20260827_AAA_BBB", snapshot),
  ]);
  const truth = parseSettledGameTruth([
    truthHeader,
    gameTruthRow("20260827_AAA_BBB", snapshot, -3),
  ]);
  const replay = buildDistributionWidthReplayRows(packets, truth);
  assert.equal(replay.snapshot_mismatches, 0);
  assert.equal(replay.rows.length, 1);
  const row = replay.rows[0]!;
  const at = (name: (typeof DISTRIBUTION_WIDTH_REPLAY_HEADERS)[number]) =>
    row[DISTRIBUTION_WIDTH_REPLAY_HEADERS.indexOf(name)];
  assert.equal(at("Frozen_Projected_Total"), 9);
  assert.equal(at("Actual_Total"), 12);
  assert.equal(at("Total_Abs_Error"), 3);
  assert.equal(at("Frozen_Combined_Bullpen_Exposure_IP"), 6.75);
  assert.equal(at("Bullpen_Window_Abs_Error"), 0);
  assert.equal(at("Replay_Status"), "FROZEN_PACKET_RESEARCH_ONLY");
});

test("distribution-width summary reports sample size and correlation without creating a threshold", () => {
  const rows = [
    Array(DISTRIBUTION_WIDTH_REPLAY_HEADERS.length).fill(""),
    Array(DISTRIBUTION_WIDTH_REPLAY_HEADERS.length).fill(""),
  ];
  const set = (row: unknown[], name: (typeof DISTRIBUTION_WIDTH_REPLAY_HEADERS)[number], value: unknown) => {
    row[DISTRIBUTION_WIDTH_REPLAY_HEADERS.indexOf(name)] = value;
  };
  set(rows[0]!, "Frozen_Combined_Bullpen_Exposure_IP", 5);
  set(rows[1]!, "Frozen_Combined_Bullpen_Exposure_IP", 7);
  set(rows[0]!, "Total_Abs_Error", 1);
  set(rows[1]!, "Total_Abs_Error", 3);
  set(rows[0]!, "Total_Squared_Error", 1);
  set(rows[1]!, "Total_Squared_Error", 9);
  const summary = buildDistributionWidthSummary(rows, "2026-08-28T03:00:00.000Z");
  const target = summary.find(
    (row) => row[0] === "Frozen_Combined_Bullpen_Exposure_IP" && row[1] === "Total_Abs_Error",
  );
  assert.ok(target);
  assert.equal(target?.[2], 2);
  assert.equal(target?.[3], 1);
  assert.equal(target?.[7], "RESEARCH_ONLY_NO_PROMOTION");
  assert.equal(DISTRIBUTION_WIDTH_SUMMARY_HEADERS.length, target?.length);
});

test("distribution-width replay and summary remain documented workbook surfaces", () => {
  const columns = (sheet: string) =>
    WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map(
      (column) => column.name,
    );
  assert.deepEqual(
    columns("DISTRIBUTION_WIDTH_REPLAY_V1"),
    DISTRIBUTION_WIDTH_REPLAY_HEADERS,
  );
  assert.deepEqual(
    columns("DISTRIBUTION_WIDTH_REPLAY_SUMMARY"),
    DISTRIBUTION_WIDTH_SUMMARY_HEADERS,
  );
  assert.ok(
    WORKBOOK_ROADMAP.some((entry) => entry.sheet === "DISTRIBUTION_WIDTH_REPLAY_V1"),
  );
  assert.ok(
    WORKBOOK_ROADMAP.some((entry) => entry.sheet === "DISTRIBUTION_WIDTH_REPLAY_SUMMARY"),
  );
});
