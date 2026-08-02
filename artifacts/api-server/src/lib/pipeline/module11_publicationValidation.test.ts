import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCurrentSlatePublication,
  validateCurrentSlatePublicationWithRetry,
} from "./module11_publicationValidation.js";

function boardRow(date: string, id: string): unknown[] {
  const row = Array<unknown>(49).fill("");
  row[0] = date;
  row[1] = id;
  row[35] = 100;
  row[36] = 50;
  row[37] = 83.33;
  row[38] = 50;
  row[41] = "PASS";
  row[47] = "RUN_TEST";
  row[48] = "DECISION_TRACE_V1_EXISTING_GATES";
  return row;
}

function slateRow(date: string, id: string): unknown[] {
  const row = Array<unknown>(14).fill("");
  row[0] = id;
  row[1] = date;
  row[6] = 100;
  row[7] = 50;
  row[8] = 83.33;
  row[9] = 50;
  row[11] = "PASS";
  return row;
}

function activeRow(date: string, id: string): unknown[] {
  return [date, id];
}

test("semantic publication validation accepts an exact current slate", () => {
  const result = validateCurrentSlatePublication({
    date: "2026-08-02",
    expected_game_ids: ["G1", "G2"],
    expected_active_game_ids: ["G1"],
    slate_board_rows: [boardRow("2026-08-02", "G1"), boardRow("2026-08-02", "G2")],
    slate_input_rows: [slateRow("2026-08-02", "G1"), slateRow("2026-08-02", "G2")],
    active_board_rows: [activeRow("2026-08-02", "G1")],
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.errors, []);
});

test("stale board dates fail even when row counts match", () => {
  const result = validateCurrentSlatePublication({
    date: "2026-08-02",
    expected_game_ids: ["G1"],
    expected_active_game_ids: [],
    slate_board_rows: [boardRow("2026-08-01", "G1")],
    slate_input_rows: [slateRow("2026-08-02", "G1")],
    active_board_rows: [],
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.some((error) => error.includes("SLATE_BOARD: non-current dates")));
});

test("missing, unexpected, duplicate, and wrong active IDs fail", () => {
  const result = validateCurrentSlatePublication({
    date: "2026-08-02",
    expected_game_ids: ["G1", "G2"],
    expected_active_game_ids: ["G2"],
    slate_board_rows: [boardRow("2026-08-02", "G1"), boardRow("2026-08-02", "G1"), boardRow("2026-08-02", "G3")],
    slate_input_rows: [slateRow("2026-08-02", "G1")],
    active_board_rows: [activeRow("2026-08-02", "G1")],
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.some((error) => error.includes("duplicate")));
  assert.ok(result.errors.some((error) => error.includes("missing")));
  assert.ok(result.errors.some((error) => error.includes("unexpected")));
});

test("missing scores and lineage identifiers fail closed", () => {
  const board = boardRow("2026-08-02", "G1");
  const slate = slateRow("2026-08-02", "G1");
  board[38] = "";
  board[47] = "";
  slate[8] = "";
  const result = validateCurrentSlatePublication({
    date: "2026-08-02",
    expected_game_ids: ["G1"],
    expected_active_game_ids: [],
    slate_board_rows: [board],
    slate_input_rows: [slate],
    active_board_rows: [],
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.some((error) => error.includes("incomplete score values")));
  assert.ok(result.errors.some((error) => error.includes("missing Run_ID")));
  assert.ok(result.errors.some((error) => error.includes("incomplete score bridge")));
});

test("publication validation retries a transient pre-write readback", async () => {
  let reads = 0;
  const delays: number[] = [];
  const result = await validateCurrentSlatePublicationWithRetry(
    {
      date: "2026-08-02",
      expected_game_ids: ["G1"],
      expected_active_game_ids: [],
    },
    async () => {
      reads++;
      const staleSlate = slateRow("2026-08-02", "G1");
      staleSlate[8] = "";
      return {
        slate_board_rows: [boardRow("2026-08-02", "G1")],
        slate_input_rows: [reads === 1 ? staleSlate : slateRow("2026-08-02", "G1")],
        active_board_rows: [],
      };
    },
    {
      max_attempts: 3,
      initial_delay_ms: 25,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    },
  );

  assert.equal(result.status, "PASS");
  assert.equal(reads, 2);
  assert.deepEqual(delays, [25]);
});

test("publication validation remains fail-closed after retry exhaustion", async () => {
  let reads = 0;
  const result = await validateCurrentSlatePublicationWithRetry(
    {
      date: "2026-08-02",
      expected_game_ids: ["G1"],
      expected_active_game_ids: [],
    },
    async () => {
      reads++;
      const staleSlate = slateRow("2026-08-02", "G1");
      staleSlate[9] = "";
      return {
        slate_board_rows: [boardRow("2026-08-02", "G1")],
        slate_input_rows: [staleSlate],
        active_board_rows: [],
      };
    },
    { max_attempts: 3, initial_delay_ms: 0, sleep: async () => {} },
  );

  assert.equal(result.status, "FAIL");
  assert.equal(reads, 3);
  assert.ok(result.errors.some((error) => error.includes("incomplete score bridge")));
});
