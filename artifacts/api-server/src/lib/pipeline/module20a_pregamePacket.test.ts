import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPregamePacketInputs,
  PREGAME_PACKET_HISTORY_COLS,
  PREGAME_PACKET_HISTORY_HEADERS,
  upsertPregamePacketRows,
  type PregamePacketInput,
} from "./module20a_pregamePacket.js";

const firstPitch = "2026-08-24T23:10:00.000Z";
const input = (
  status: "OPEN_PROSPECTIVE" | "FROZEN_PREGAME",
  total = 8.5,
): PregamePacketInput => ({
  date: "2026-08-24",
  game_id: "20260824_AAA_BBB",
  away_team: "AAA",
  home_team: "BBB",
  scheduled_first_pitch: firstPitch,
  packet_status: status,
  values: [
    "2026-08-24",
    "20260824_AAA_BBB",
    "AAA",
    "BBB",
    firstPitch,
    status,
    "run",
    "model",
    "",
    "",
    "",
    "",
    "COMPLETE",
    4,
    4.5,
    total,
  ],
});

test("pregame packet updates while OPEN then freezes atomically by Date + Game_ID", () => {
  const open = upsertPregamePacketRows(
    [],
    [input("OPEN_PROSPECTIVE", 8.5)],
    "2026-08-24T18:00:00.000Z",
  );
  assert.equal(open.rowsWritten, 1);
  assert.equal(open.rows[0]![5], "OPEN_PROSPECTIVE");
  assert.equal(open.rows[0]![15], 8.5);
  assert.equal(open.rows[0]!.length, PREGAME_PACKET_HISTORY_COLS);

  const frozen = upsertPregamePacketRows(
    open.rows,
    [input("FROZEN_PREGAME", 8.8)],
    "2026-08-24T20:00:00.000Z",
  );
  assert.equal(frozen.rowsWritten, 0);
  assert.equal(frozen.rowsUpdated, 1);
  assert.equal(frozen.rowsFrozen, 1);
  assert.equal(frozen.rows[0]![5], "FROZEN_PREGAME");
  assert.equal(frozen.rows[0]![15], 8.8);
  assert.equal(frozen.rows[0]![10], "2026-08-24T20:00:00.000Z");
});

test("a board-locked decision still permits pre-first-pitch packet refresh", () => {
  const packets = buildPregamePacketInputs(
    [{
      date: "2026-08-24",
      game_id: "20260824_AAA_BBB",
      away_team: "AAA",
      home_team: "BBB",
      projected_away_runs: 4,
      projected_home_runs: 4.5,
      projected_total_runs: 8.5,
    }] as never,
    [{
      legacy_game_id: "20260824_AAA_BBB",
      lock_status: "LOCKED_OUT",
      market_line: 8.5,
      run_id: "board-lock-run",
      model_version: "test",
      direction: "OVER",
      vehicle_type: "GAME_TOTAL",
      final_decision: "NO_CORE",
      core_blocker: "BOARD_LOCKED_POST_CUTOFF",
      confidence: 50,
      variance: 0,
    }] as never,
    [{ legacy_game_id: "20260824_AAA_BBB", scheduled_utc_time: firstPitch }] as never,
    [],
    [],
    [],
  );

  assert.equal(packets[0]?.packet_status, "OPEN_PROSPECTIVE");
  const lockedBoardSnapshot = upsertPregamePacketRows(
    [],
    packets,
    "2026-08-24T22:45:00.000Z", // 25 minutes before first pitch
  );
  const refreshedInput = {
    ...packets[0]!,
    values: [...packets[0]!.values],
  };
  refreshedInput.values[15] = 8.8;
  const refreshed = upsertPregamePacketRows(
    lockedBoardSnapshot.rows,
    [refreshedInput],
    "2026-08-24T23:05:00.000Z", // five minutes before first pitch
  );

  assert.equal(refreshed.rows[0]?.[5], "OPEN_PROSPECTIVE");
  assert.equal(refreshed.rows[0]?.[15], 8.8);
  const frozen = upsertPregamePacketRows(
    refreshed.rows,
    [],
    "2026-08-24T23:11:00.000Z",
  );
  assert.equal(frozen.rows[0]?.[5], "FROZEN_PREGAME");
  assert.equal(frozen.rows[0]?.[15], 8.8);
});

test("a frozen pregame packet remains byte-for-byte unchanged on later refresh", () => {
  const frozen = upsertPregamePacketRows(
    [],
    [input("FROZEN_PREGAME", 8.8)],
    "2026-08-24T20:00:00.000Z",
  );
  const before = [...frozen.rows[0]!];
  const rerun = upsertPregamePacketRows(
    frozen.rows,
    [input("OPEN_PROSPECTIVE", 11.2)],
    "2026-08-24T21:00:00.000Z",
  );
  assert.deepEqual(rerun.rows[0], before);
  assert.equal(rerun.rowsUpdated, 0);
  assert.equal(rerun.rowsFrozen, 0);
});

test("post-first-pitch attempts create no packet and cannot backfill history", () => {
  const late = upsertPregamePacketRows(
    [],
    [input("OPEN_PROSPECTIVE")],
    "2026-08-24T23:10:00.000Z",
  );
  assert.equal(late.rows.length, 0);
  assert.equal(late.rowsSkippedAfterFirstPitch, 1);
});

test("a legitimate OPEN packet becomes immutable after first pitch without changing its snapshot", () => {
  const open = upsertPregamePacketRows(
    [],
    [input("OPEN_PROSPECTIVE", 8.5)],
    "2026-08-24T18:00:00.000Z",
  );
  const before = [...open.rows[0]!];

  // A protected game has no fresh module inputs.  The lifecycle writer may
  // promote its stored prospective packet but must not create a new snapshot.
  const protectedRun = upsertPregamePacketRows(
    open.rows,
    [],
    "2026-08-24T23:11:00.000Z",
  );
  const after = protectedRun.rows[0]!;
  assert.equal(protectedRun.rowsFrozen, 1);
  assert.equal(protectedRun.rowsUpdated, 1);
  assert.equal(after[5], "FROZEN_PREGAME");
  assert.equal(after[10], "2026-08-24T23:11:00.000Z");
  assert.equal(after[11], before[11]);
  assert.deepEqual(
    after.map((value, index) =>
      index === 5 || index === 10 ? before[index] : value,
    ),
    before,
  );
});

test("packet contract preserves market and dependent shadow fields as explicit columns", () => {
  for (const required of [
    "Market_Line",
    "Market_Snapshot_Status",
    "Away_Expected_IP",
    "Bullpen_Data_Status",
    "Environment_Certainty",
    "Collision_Status",
    "Low_Center_Status",
    "SSAT_V2_Status",
    "Traffic_Conversion_Runs",
    "HR_XBH_Damage_Runs",
    "Away_Pitcher_Effective_IP",
    "Away_Latent_Lineup_Rate",
    "Home_Latent_Lineup_Rate",
    "Away_Recent_Form_Multiplier",
    "Home_Recent_Form_Multiplier",
    "Away_Active_Offense_Center",
    "Home_Active_Offense_Center",
  ])
    assert.ok(PREGAME_PACKET_HISTORY_HEADERS.includes(required as never));
});
