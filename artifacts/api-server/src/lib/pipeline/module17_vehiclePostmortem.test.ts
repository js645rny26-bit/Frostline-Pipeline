import assert from "node:assert/strict";
import test from "node:test";
import { groupContiguousVehicleLogUpdates } from "./module17_vehiclePostmortem.js";

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
