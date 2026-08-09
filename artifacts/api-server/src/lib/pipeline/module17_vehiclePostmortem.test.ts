import assert from "node:assert/strict";
import test from "node:test";
import {
  groupContiguousVehicleLogUpdates,
  gradeTicket,
  postmortemRowToValues,
  type PostmortemRow,
} from "./module17_vehiclePostmortem.js";

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
