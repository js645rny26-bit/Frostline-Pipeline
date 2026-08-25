import assert from "node:assert/strict";
import test from "node:test";
import {
  PREGAME_PACKET_HISTORY_COLS,
  PREGAME_PACKET_HISTORY_HEADERS,
  upsertPregamePacketRows,
  type PregamePacketInput,
} from "./module20a_pregamePacket.js";

const firstPitch = "2026-08-24T23:10:00.000Z";
const input = (status: "OPEN_PROSPECTIVE" | "FROZEN_PREGAME", total = 8.5): PregamePacketInput => ({
  date: "2026-08-24", game_id: "20260824_AAA_BBB", away_team: "AAA", home_team: "BBB",
  scheduled_first_pitch: firstPitch, packet_status: status,
  values: ["2026-08-24", "20260824_AAA_BBB", "AAA", "BBB", firstPitch, status, "run", "model", "", "", "", "", "COMPLETE", 4, 4.5, total],
});

test("pregame packet updates while OPEN then freezes atomically by Date + Game_ID", () => {
  const open = upsertPregamePacketRows([], [input("OPEN_PROSPECTIVE", 8.5)], "2026-08-24T18:00:00.000Z");
  assert.equal(open.rowsWritten, 1);
  assert.equal(open.rows[0]![5], "OPEN_PROSPECTIVE");
  assert.equal(open.rows[0]![15], 8.5);
  assert.equal(open.rows[0]!.length, PREGAME_PACKET_HISTORY_COLS);

  const frozen = upsertPregamePacketRows(open.rows, [input("FROZEN_PREGAME", 8.8)], "2026-08-24T20:00:00.000Z");
  assert.equal(frozen.rowsWritten, 0);
  assert.equal(frozen.rowsUpdated, 1);
  assert.equal(frozen.rowsFrozen, 1);
  assert.equal(frozen.rows[0]![5], "FROZEN_PREGAME");
  assert.equal(frozen.rows[0]![15], 8.8);
  assert.equal(frozen.rows[0]![10], "2026-08-24T20:00:00.000Z");
});

test("a frozen pregame packet remains byte-for-byte unchanged on later refresh", () => {
  const frozen = upsertPregamePacketRows([], [input("FROZEN_PREGAME", 8.8)], "2026-08-24T20:00:00.000Z");
  const before = [...frozen.rows[0]!];
  const rerun = upsertPregamePacketRows(frozen.rows, [input("OPEN_PROSPECTIVE", 11.2)], "2026-08-24T21:00:00.000Z");
  assert.deepEqual(rerun.rows[0], before);
  assert.equal(rerun.rowsUpdated, 0);
  assert.equal(rerun.rowsFrozen, 0);
});

test("post-first-pitch attempts create no packet and cannot backfill history", () => {
  const late = upsertPregamePacketRows([], [input("OPEN_PROSPECTIVE")], "2026-08-24T23:10:00.000Z");
  assert.equal(late.rows.length, 0);
  assert.equal(late.rowsSkippedAfterFirstPitch, 1);
});

test("a legitimate OPEN packet becomes immutable after first pitch without changing its snapshot", () => {
  const open = upsertPregamePacketRows([], [input("OPEN_PROSPECTIVE", 8.5)], "2026-08-24T18:00:00.000Z");
  const before = [...open.rows[0]!];

  // A protected game has no fresh module inputs.  The lifecycle writer may
  // promote its stored prospective packet but must not create a new snapshot.
  const protectedRun = upsertPregamePacketRows(open.rows, [], "2026-08-24T23:11:00.000Z");
  const after = protectedRun.rows[0]!;
  assert.equal(protectedRun.rowsFrozen, 1);
  assert.equal(protectedRun.rowsUpdated, 1);
  assert.equal(after[5], "FROZEN_PREGAME");
  assert.equal(after[10], "2026-08-24T23:11:00.000Z");
  assert.equal(after[11], before[11]);
  assert.deepEqual(
    after.map((value, index) => (index === 5 || index === 10 ? before[index] : value)),
    before,
  );
});

test("packet contract preserves market and dependent shadow fields as explicit columns", () => {
  for (const required of [
    "Market_Line", "Market_Snapshot_Status", "Away_Expected_IP", "Bullpen_Data_Status",
    "Environment_Certainty", "Collision_Status", "Low_Center_Status", "SSAT_V2_Status",
  ]) assert.ok(PREGAME_PACKET_HISTORY_HEADERS.includes(required as never));
});
