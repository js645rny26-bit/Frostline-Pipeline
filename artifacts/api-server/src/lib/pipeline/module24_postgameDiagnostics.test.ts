import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAllocationDiagnostic,
  gradeThreshold,
  parseFrozenPacketDiagnostics,
  parseHalfNumberLines,
  workloadLeashStatus,
} from "./module24_postgameDiagnostics.js";

test("allocation diagnostics expose a team-allocation reversal without inventing a threshold", () => {
  const row = buildAllocationDiagnostic({
    date: "2026-08-24", game_id: "20260824_TEX_CHW", away_team: "TEX", home_team: "CHW",
    scheduled_first_pitch: "2026-08-24T23:40:00.000Z", snapshot_ts: "2026-08-24T22:00:00.000Z",
    projected_away_runs: 2.12, projected_home_runs: 4.56, projected_total: 6.68,
    away_expected_ip: 5.5, home_expected_ip: 5.5,
  }, {
    actual_away_runs: 11, actual_home_runs: 2, actual_total: 13, settlement_ts: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(row[13], -8.88);
  assert.equal(row[15], 2.56);
  assert.equal(row[24], "TRUE");
  assert.equal(row[25], "TRUE");
});

test("full ladder accepts only executable half-number thresholds and keeps pushes explicit", () => {
  assert.deepEqual(parseHalfNumberLines("6.5, 7.5; 8.5 | 8.0"), [6.5, 7.5, 8.5]);
  assert.equal(gradeThreshold("OVER", 7.5, 8), "WIN");
  assert.equal(gradeThreshold("UNDER", 7.5, 8), "LOSS");
  assert.equal(gradeThreshold("OVER", 8, 8), "PUSH");
  assert.equal(gradeThreshold(null, 7.5, 8), "NOT_GRADABLE");
});

test("only a frozen packet with a genuine pre-first-pitch snapshot is diagnostic eligible", () => {
  const header = [
    "Date", "Game_ID", "Packet_Status", "Scheduled_First_Pitch", "Packet_Snapshot_TS",
    "Away_Team", "Home_Team", "Base_Away_Projection", "Base_Home_Projection", "Base_Projection",
    "Away_Expected_IP", "Home_Expected_IP",
  ];
  const rows: unknown[][] = [
    header,
    ["2026-08-24", "good", "FROZEN_PREGAME", "2026-08-24T23:40:00.000Z", "2026-08-24T22:00:00.000Z", "AAA", "BBB", 4, 4.5, 8.5, 5.5, 5.4],
    ["2026-08-24", "open", "OPEN_PROSPECTIVE", "2026-08-24T23:40:00.000Z", "2026-08-24T22:00:00.000Z", "AAA", "BBB", 4, 4.5, 8.5, 5.5, 5.4],
    ["2026-08-24", "late", "FROZEN_PREGAME", "2026-08-24T23:40:00.000Z", "2026-08-24T23:41:00.000Z", "AAA", "BBB", 4, 4.5, 8.5, 5.5, 5.4],
  ];
  const packets = parseFrozenPacketDiagnostics(rows, "2026-08-24");
  assert.deepEqual([...packets.keys()], ["good"]);
});

test("workload grading is explicit without treating it as generic pitcher failure", () => {
  assert.equal(workloadLeashStatus(5.5, 6), "REACHED_EXPECTED_IP");
  assert.equal(workloadLeashStatus(5.5, 5), "SHORT_OF_EXPECTED_IP");
  assert.equal(workloadLeashStatus(null, 5), "EXPECTED_IP_UNAVAILABLE");
  assert.equal(workloadLeashStatus(5.5, null), "ACTUAL_IP_UNAVAILABLE");
});
