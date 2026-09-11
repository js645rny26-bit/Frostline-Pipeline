import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSWEDeviationRows,
  SWE_ACTUAL_DEVIATION_SD_FLOOR,
  SWE_CORRELATION_MIN_N,
  SWE_DEVIATION_HEADERS,
  SWE_REPLAY_PACKET_HEADER_CONTRACT,
  SWE_REPLAY_STARTER_HEADER_CONTRACT,
  SWE_REPLAY_SUMMARY_HEADERS,
  parseSWEReplayObservations,
  summarizeSWEReplay,
  type SWEReplayObservation,
} from "./module30_starterWorkloadReplay.js";
import { STARTER_OUTCOME_HEADERS } from "./module24_postgameDiagnostics.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { NUMERIC_WORKLOAD_VERSION } from "./module03_numericWorkload.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

function conventional(swe: number, actual: number, baseline = 6): SWEReplayObservation {
  return {
    role_state: "CONVENTIONAL_STARTER",
    swe_expected_ip: swe,
    active_baseline_ip: baseline,
    actual_ip: actual,
  };
}

test("SWE conventional replay reports deviation diagnostics but cannot interpret N=9", () => {
  const observations = [
    conventional(5.5, 6.2), conventional(5.7, 5.1), conventional(5.9, 6.8),
    conventional(6.0, 5.4), conventional(6.1, 6.0), conventional(6.2, 6.4),
    conventional(6.3, 5.7), conventional(6.4, 6.5), conventional(6.5, 6.1),
  ];
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.eligible_n, 9);
  assert.equal(summary.correlation_eligible_n, 9);
  assert.equal(summary.correlation_sample_status, "INSUFFICIENT_N");
  assert.equal(summary.correlation_score_status, "NOT_YET_INTERPRETABLE");
  assert.equal(summary.decision_status, "HOLD");
  assert.notEqual(summary.pearson_r, null);
  assert.notEqual(summary.spearman_rho, null);
  assert.equal(SWE_REPLAY_STARTER_HEADER_CONTRACT, true);
  assert.equal(SWE_REPLAY_PACKET_HEADER_CONTRACT, true);
});

function rowFromHeaders(headers: readonly string[], fields: Record<string, unknown>): unknown[] {
  return headers.map((name) => fields[name] ?? "");
}

test("SWE replay scores the commissioned numeric shadow and never the older empty SWE fields", () => {
  const date = "2026-09-10";
  const gameId = "20260910_CHW_PIT";
  const starterRows = [
    Array.from(STARTER_OUTCOME_HEADERS),
    rowFromHeaders(STARTER_OUTCOME_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Team_Side: "HOME",
      Team: "PIT",
      Starter: "Jared Jones",
      Role_State: "CONVENTIONAL_STARTER",
      Projected_IP_Shadow: 5.09,
      Shadow_IP_Abs_Error: 1.91,
      Legacy_Expected_IP: 6,
      Legacy_Abs_Error: 1,
      Actual_IP: 7,
      Settlement_TS: "2026-09-11T12:00:00.000Z",
      SWE_Expected_IP: "",
      SWE_Status: "INSUFFICIENT_HISTORY",
    }),
  ];
  const packetRows = [
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    rowFromHeaders(PREGAME_PACKET_HISTORY_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Packet_Status: "FROZEN_PREGAME",
      Workload_Candidate_Version: NUMERIC_WORKLOAD_VERSION,
      Home_Workload_Candidate_Status: "PITCHER_SPECIFIC",
      Home_Workload_Data_Through_Date: "2026-09-09",
      Home_Projected_IP_Shadow: 5.09,
    }),
  ];
  const observations = parseSWEReplayObservations(starterRows, packetRows);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.swe_expected_ip, 5.09);
  assert.equal(observations[0]!.swe_version, NUMERIC_WORKLOAD_VERSION);
  assert.equal(observations[0]!.swe_status, "PITCHER_SPECIFIC");
  assert.equal(observations[0]!.swe_data_through_date, "2026-09-09");
});

test("SWE replay fails closed when frozen candidate lineage is absent or does not reconcile", () => {
  const starterRows = [
    Array.from(STARTER_OUTCOME_HEADERS),
    rowFromHeaders(STARTER_OUTCOME_HEADERS, {
      Date: "2026-09-10", Game_ID: "G1", Team_Side: "AWAY", Role_State: "CONVENTIONAL_STARTER",
      Projected_IP_Shadow: 5.5, Legacy_Expected_IP: 6, Actual_IP: 5,
    }),
  ];
  assert.deepEqual(parseSWEReplayObservations(starterRows, [Array.from(PREGAME_PACKET_HISTORY_HEADERS)]), []);
  const packetRows = [
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    rowFromHeaders(PREGAME_PACKET_HISTORY_HEADERS, {
      Date: "2026-09-10", Game_ID: "G1", Packet_Status: "FROZEN_PREGAME",
      Workload_Candidate_Version: NUMERIC_WORKLOAD_VERSION,
      Away_Workload_Candidate_Status: "PITCHER_SPECIFIC", Away_Projected_IP_Shadow: 5.6,
    }),
  ];
  assert.deepEqual(parseSWEReplayObservations(starterRows, packetRows), []);
});

test("SWE N=149 remains below the formal correlation checkpoint", () => {
  const observations = Array.from({ length: SWE_CORRELATION_MIN_N - 1 }, (_, index) =>
    conventional(5.2 + (index % 9) / 10, 4.8 + (index % 13) / 10));
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.eligible_n, 149);
  assert.equal(summary.correlation_sample_status, "INSUFFICIENT_N");
  assert.equal(summary.decision_status, "HOLD");
});

test("SWE N=150 cannot receive a formal verdict until the historical variance floor is frozen", () => {
  assert.equal(SWE_ACTUAL_DEVIATION_SD_FLOOR, null);
  const observations = Array.from({ length: SWE_CORRELATION_MIN_N }, (_, index) =>
    conventional(5.1 + (index % 17) / 10, 4.5 + (index % 19) / 10));
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.correlation_sample_status, "VARIANCE_FLOOR_NOT_FROZEN");
  assert.equal(summary.correlation_score_status, "NOT_YET_INTERPRETABLE");
  assert.equal(summary.decision_status, "HOLD");
});

test("SWE reports insufficient predicted variance explicitly instead of a zero correlation", () => {
  const observations = Array.from({ length: SWE_CORRELATION_MIN_N }, (_, index) =>
    conventional(6, 4.5 + (index % 19) / 10));
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.predicted_deviation_sd, 0);
  assert.equal(summary.pearson_r, null);
  assert.equal(summary.spearman_rho, null);
  assert.equal(summary.correlation_sample_status, "INSUFFICIENT_PREDICTED_VARIANCE");
});

test("SWE reports insufficient actual variance explicitly instead of a zero correlation", () => {
  const observations = Array.from({ length: SWE_CORRELATION_MIN_N }, (_, index) =>
    conventional(5.1 + (index % 17) / 10, 6));
  const summary = summarizeSWEReplay(observations);
  assert.equal(summary.actual_deviation_sd, 0);
  assert.equal(summary.pearson_r, null);
  assert.equal(summary.spearman_rho, null);
  assert.equal(summary.correlation_sample_status, "INSUFFICIENT_ACTUAL_VARIANCE");
});

test("SWE keeps opener and bulk evidence out of the conventional personalization test", () => {
  const hagen: SWEReplayObservation = {
    starter: "Hagen Smith",
    role_state: "OPENER",
    swe_expected_ip: 2.25,
    active_baseline_ip: 1.2,
    actual_ip: 2,
  };
  const bulk: SWEReplayObservation = {
    role_state: "BULK",
    swe_expected_ip: 4,
    active_baseline_ip: 3,
    actual_ip: 4.1,
  };
  const conventionalSummary = summarizeSWEReplay([hagen, bulk, conventional(5.8, 6.1)]);
  const openerSummary = summarizeSWEReplay([hagen, bulk], "OPENER");
  const bulkSummary = summarizeSWEReplay([hagen, bulk], "BULK_FOLLOWER_TRANSITION");
  assert.equal(conventionalSummary.eligible_n, 1);
  assert.equal(openerSummary.eligible_n, 1);
  assert.equal(openerSummary.correlation_sample_status, "NOT_APPLICABLE_ATYPICAL_ROLE_COHORT");
  assert.equal(openerSummary.decision_status, "HOLD_SEPARATE_ATYPICAL_ROLE_EVALUATION");
  assert.equal(bulkSummary.eligible_n, 1);
});

test("SWE preserves the exact Sept. 10 all-role Wilcoxon result only as a secondary view", () => {
  const observations = [
    conventional(6.07, 6.33), conventional(4.46, 7), conventional(4.61, 6),
    conventional(5.52, 7), conventional(5.68, 6), conventional(4.9, 7),
    conventional(5.19, 5), conventional(5.07, 3.33), conventional(5.09, 7),
    { role_state: "OPENER", swe_expected_ip: 2.25, active_baseline_ip: 1.2, actual_ip: 2 },
  ];
  const conventionalSummary = summarizeSWEReplay(observations, "CONVENTIONAL_STARTER");
  const allRoles = summarizeSWEReplay(observations, "ALL_ROLES_SECONDARY");
  assert.equal(conventionalSummary.eligible_n, 9);
  assert.equal(conventionalSummary.wilcoxon_p, 0.203125);
  assert.equal(allRoles.eligible_n, 10);
  assert.equal(allRoles.wilcoxon_p, 0.322266);
  assert.equal(allRoles.correlation_sample_status, "NOT_APPLICABLE_ALL_ROLE_SECONDARY");
  assert.equal(allRoles.decision_status, "NO_DECISION_SECONDARY_ALL_ROLE_VIEW");
});

test("SWE per-starter output preserves baseline-removed values and rank direction", () => {
  const rows = buildSWEDeviationRows([
    conventional(5.5, 5),
    conventional(6.5, 7),
    { role_state: "OPENER", swe_expected_ip: 2.25, active_baseline_ip: 1.2, actual_ip: 2 },
  ]);
  assert.equal(rows[0]!.predicted_deviation, -0.5);
  assert.equal(rows[0]!.actual_deviation, -1);
  assert.equal(rows[0]!.deviation_error, 0.5);
  assert.equal(rows[0]!.predicted_rank, 1);
  assert.equal(rows[1]!.predicted_rank, 2);
  assert.equal(rows[2]!.predicted_deviation, null);
  assert.equal(rows[2]!.actual_rank, null);
});

test("SWE v62 replay headers match both documented workbook surfaces exactly", () => {
  const summary = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "SWE_WORKLOAD_REPLAY_SUMMARY_V1");
  const deviations = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "SWE_WORKLOAD_DEVIATION_V1");
  assert.deepEqual(summary?.columns.map((column) => column.name), Array.from(SWE_REPLAY_SUMMARY_HEADERS));
  assert.deepEqual(deviations?.columns.map((column) => column.name), Array.from(SWE_DEVIATION_HEADERS));
});
