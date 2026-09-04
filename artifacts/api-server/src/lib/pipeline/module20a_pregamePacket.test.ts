import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPregamePacketInputs,
  finalizeOpenPregamePacketRows,
  normalizePregamePacketHistoryRows,
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_COLS,
  PREGAME_PACKET_HISTORY_HEADERS,
  upsertPregamePacketRows,
  type PregamePacketInput,
} from "./module20a_pregamePacket.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";

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

test("an executable market overlay changes only market provenance, never price-blind projections", () => {
  const summary = [{
    date: "2026-08-24", game_id: "20260824_AAA_BBB", away_team: "AAA", home_team: "BBB",
    projected_away_runs: 4, projected_home_runs: 4.5, projected_total_runs: 8.5,
  }] as never;
  const board = [{
    legacy_game_id: "20260824_AAA_BBB", market_line: 8, run_id: "run", model_version: "test",
    direction: "OVER", vehicle_type: "GAME_TOTAL", final_decision: "PASS", core_blocker: "",
    confidence: 50, variance: 0,
  }] as never;
  const games = [{ legacy_game_id: "20260824_AAA_BBB", scheduled_utc_time: firstPitch }] as never;
  const reference = buildPregamePacketInputs(summary, board, games, [], [], []);
  const executable = buildPregamePacketInputs(
    summary,
    board,
    games,
    [], [], [],
    new Map([["20260824_AAA_BBB", {
      fields: new Map([
        ["CURRENT_HARD_ROCK_LINE", "10"],
        ["CURRENT_HARD_ROCK_PRICE", "-118"],
        ["CURRENT_HARD_ROCK_SOURCE", "HARD_ROCK"],
        ["CURRENT_HARD_ROCK_QUOTED_TS", "2026-08-24T22:43:00.000Z"],
      ]),
      field_supplied_ts: new Map([["CURRENT_HARD_ROCK_LINE", "2026-08-24T22:45:00.000Z"]]),
      field_sources: new Map([["CURRENT_HARD_ROCK_LINE", "MANUAL_OPERATOR"]]),
      source: "MANUAL_OPERATOR",
      supplied_ts: "2026-08-24T22:45:00.000Z",
      provenance: "explicit",
      reauthorization_status: "REAUTHORIZATION_REQUIRED",
    }]]),
  );
  const index = Object.fromEntries(PREGAME_PACKET_HISTORY_HEADERS.map((name, position) => [name, position]));
  assert.equal(reference[0]?.values[index.Base_Away_Projection], executable[0]?.values[index.Base_Away_Projection]);
  assert.equal(reference[0]?.values[index.Base_Home_Projection], executable[0]?.values[index.Base_Home_Projection]);
  assert.equal(reference[0]?.values[index.Base_Projection], executable[0]?.values[index.Base_Projection]);
  assert.equal(reference[0]?.values[index.Reference_Market_Line], 7.5);
  assert.equal(reference[0]?.values[index.Executable_Market_Line], "");
  assert.equal(reference[0]?.values[index.Executable_Market_Price], "");
  assert.equal(reference[0]?.values[index.Executable_Market_Status], "NO_LITERAL_EXECUTABLE_HARD_ROCK_LINE");
  assert.equal(executable[0]?.values[index.Executable_Market_Line], 10);
  assert.equal(executable[0]?.values[index.Executable_Market_Price], "-118");
  assert.equal(executable[0]?.values[index.Executable_Market_Source], "HARD_ROCK");
  assert.equal(executable[0]?.values[index.Executable_Market_Quoted_TS], "2026-08-24T22:43:00.000Z");
  assert.equal(executable[0]?.values[index.Executable_Market_Status], "LITERAL_EXECUTABLE_HARD_ROCK_CAPTURED");
  assert.equal(executable[0]?.values[index.Primary_Grade_Market_Line], 10);

  const partial = buildPregamePacketInputs(
    summary,
    board,
    games,
    [], [], [],
    new Map([["20260824_AAA_BBB", {
      fields: new Map([
        ["CURRENT_HARD_ROCK_PRICE", "-110"],
        ["CURRENT_HARD_ROCK_SOURCE", "Hard Rock NJ"],
        ["CURRENT_HARD_ROCK_QUOTED_TS", "2026-08-24T22:40:00.000Z"],
      ]),
      field_supplied_ts: new Map([["CURRENT_HARD_ROCK_PRICE", "2026-08-24T22:45:00.000Z"]]),
      field_sources: new Map([["CURRENT_HARD_ROCK_PRICE", "MANUAL_OPERATOR"]]),
      source: "MANUAL_OPERATOR",
      supplied_ts: "2026-08-24T22:45:00.000Z",
      provenance: "explicit partial",
      reauthorization_status: "REAUTHORIZATION_REQUIRED",
    }]]),
  );
  assert.equal(partial[0]?.values[index.Executable_Market_Line], "");
  assert.equal(partial[0]?.values[index.Executable_Market_Price], "-110");
  assert.equal(partial[0]?.values[index.Executable_Market_Source], "Hard Rock NJ");
  assert.equal(partial[0]?.values[index.Executable_Market_TS], "2026-08-24T22:45:00.000Z");
  assert.equal(partial[0]?.values[index.Executable_Market_Quoted_TS], "2026-08-24T22:40:00.000Z");
  assert.equal(partial[0]?.values[index.Executable_Market_Status], "PARTIAL_LITERAL_EXECUTABLE_HARD_ROCK_EVIDENCE_NO_LINE");
  assert.equal(partial[0]?.values[index.Primary_Grade_Market_Line], 7.5);
});

test("future frozen packets preserve component-level moderation state without changing operational outputs", () => {
  const summary = [{
    date: "2026-08-24", game_id: "20260824_AAA_BBB", away_team: "AAA", home_team: "BBB",
    projected_away_runs: 4, projected_home_runs: 4.5, projected_total_runs: 8.5,
    starter_attack_runs: 3.1, bullpen_continuation_runs: 4.2,
    away_pitcher_role: "OPENER", home_pitcher_role: "STARTER",
    away_expected_innings: 2, home_expected_innings: 6,
    environment_run_adjustment: -0.35, environment_certainty: "HIGH", weather_vehicle_status: "ACTIVE",
    away_lineup_status: "FULL", home_lineup_status: "PARTIAL",
    away_lineup_coverage: 100, home_lineup_coverage: 66.7,
  }] as never;
  const board = [{
    legacy_game_id: "20260824_AAA_BBB", market_line: 8.5, run_id: "run", model_version: "engine-test",
    direction: "UNDER", vehicle_type: "GAME_TOTAL", final_decision: "PASS", core_blocker: "", confidence: 50, variance: 0,
    truth_family: "RUNS_UNDER", truth_score: 83.33, vehicle_score: 50, stability_score: 66.67,
    composite_score: 50, confirmation_gate: false, score_decision: "NO_CORE", score_blockers: ["TEST"],
    truth_components: "truth-a=PASS; truth-b=FAIL", vehicle_components: "vehicle-a=PASS",
    stability_components: "stability-a=PASS; stability-b=FAIL",
  }] as never;
  const collision = [{
    game_id: "20260824_AAA_BBB", preview_availability: "AVAILABLE", tail_estimate_status: "AVAILABLE",
    traffic_conversion_estimate: 0.4, hr_xbh_damage_estimate: 0.3,
  }] as never;
  const packet = buildPregamePacketInputs(
    summary,
    board,
    [{ legacy_game_id: "20260824_AAA_BBB", scheduled_utc_time: firstPitch }] as never,
    collision,
    [],
    [],
  )[0]!;
  const index = Object.fromEntries(PREGAME_PACKET_HISTORY_HEADERS.map((name, position) => [name, position]));
  assert.equal(packet.values.length, PREGAME_PACKET_HISTORY_COLS);
  assert.equal(packet.values[index.Truth_Checks], "truth-a=PASS; truth-b=FAIL");
  assert.equal(packet.values[index.Stability_Checks], "stability-a=PASS; stability-b=FAIL");
  assert.equal(packet.values[index.Starter_Bullpen_Reliance_State], "BULLPEN_PHASE_RELIANT");
  assert.equal(packet.values[index.Opener_Chain_State], "OPENER_CHAIN_UNCERTAINTY");
  assert.equal(packet.values[index.Traffic_Damage_CoSign_Status], "TRAFFIC_AND_DAMAGE_COSIGNED");
  assert.equal(packet.values[index.Environment_Dependence_State], "ENVIRONMENT_MATERIAL_COMPONENT");
  assert.equal(packet.values[index.Lineup_Completeness_State], "AWAY_FULL_100|HOME_PARTIAL_66.7");
  assert.equal(packet.values[index.Engine_Version], "engine-test");
  assert.equal(packet.values[index.Schema_Version], 49);
  // Day 1 stays exactly in its broad v46 population. Current code must not
  // retrospectively classify it under the separately versioned Day-2 cohort.
  assert.equal(packet.values[index.Strict_Structural_Cohort_Version], "");
  assert.equal(packet.values[index.Strict_Structural_Verdict], "");
  assert.equal(packet.values[index.Strict_Structural_Check_Vector], "");

  const open = upsertPregamePacketRows([], [packet], "2026-08-24T22:45:00.000Z");
  const frozen = upsertPregamePacketRows(open.rows, [], "2026-08-24T23:11:00.000Z");
  const immutable = upsertPregamePacketRows(
    frozen.rows,
    [{ ...packet, values: packet.values.map(() => "post-start-change") }],
    "2026-08-24T23:12:00.000Z",
  );
  assert.deepEqual(immutable.rows[0], frozen.rows[0]);
  assert.equal(immutable.rows[0]?.[index.Base_Projection], 8.5);
});

test("Day 2 strict cohort freezes the complete vector and cannot change after first pitch", () => {
  const strictDate = "2026-09-02";
  const strictFirstPitch = "2026-09-02T23:10:00.000Z";
  const index = Object.fromEntries(PREGAME_PACKET_HISTORY_HEADERS.map((name, position) => [name, position]));
  const strictPacket = input("OPEN_PROSPECTIVE", 8.5);
  strictPacket.date = strictDate;
  strictPacket.game_id = "20260902_AAA_BBB";
  strictPacket.scheduled_first_pitch = strictFirstPitch;
  strictPacket.values = Array(PREGAME_PACKET_HISTORY_COLS).fill("");
  strictPacket.values[index.Date] = strictDate;
  strictPacket.values[index.Game_ID] = strictPacket.game_id;
  strictPacket.values[index.Scheduled_First_Pitch] = strictFirstPitch;
  strictPacket.values[index.Packet_Status] = "OPEN_PROSPECTIVE";
  strictPacket.values[index.Base_Projection] = 8.5;
  strictPacket.values[index.Strict_Structural_Cohort_Version] = "STRICT_STRUCTURAL_ELIGIBLE_V1_2026-09-02";
  strictPacket.values[index.Strict_Structural_Verdict] = "STRICT_STRUCTURAL_EXCLUDED";
  strictPacket.values[index.Strict_Structural_Exclusion_Reasons] = "LINEUPS_FULL=FAIL";
  strictPacket.values[index.Strict_Check_Core_Packet_Complete] = "PASS";
  strictPacket.values[index.Strict_Check_Lineups_Full] = "FAIL";
  strictPacket.values[index.Strict_Structural_Check_Vector] = "LINEUPS_FULL=FAIL(AWAY_FULL_1/HOME_PARTIAL_0.8888888889)";

  const open = upsertPregamePacketRows([], [strictPacket], "2026-09-02T23:05:00.000Z");
  assert.equal(open.rows[0]?.[index.Strict_Structural_Snapshot_TS], "2026-09-02T23:05:00.000Z");
  const frozen = upsertPregamePacketRows(open.rows, [], "2026-09-02T23:11:00.000Z");
  const stalePostStart = {
    ...strictPacket,
    values: strictPacket.values.map(() => "post-start-mutation"),
  };
  const rerun = upsertPregamePacketRows(frozen.rows, [stalePostStart], "2026-09-02T23:12:00.000Z");

  assert.equal(frozen.rows[0]?.[index.Packet_Status], "FROZEN_PREGAME");
  assert.equal(rerun.rows[0]?.[index.Strict_Structural_Verdict], "STRICT_STRUCTURAL_EXCLUDED");
  assert.equal(rerun.rows[0]?.[index.Strict_Structural_Snapshot_TS], "2026-09-02T23:05:00.000Z");
  assert.equal(rerun.rows[0]?.[index.Strict_Check_Lineups_Full], "FAIL");
  assert.equal(rerun.rows[0]?.[index.Strict_Structural_Check_Vector], "LINEUPS_FULL=FAIL(AWAY_FULL_1/HOME_PARTIAL_0.8888888889)");
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

test("settlement finalization is date-scoped and rejects non-prospective snapshots", () => {
  const valid = upsertPregamePacketRows(
    [],
    [input("OPEN_PROSPECTIVE", 8.5)],
    "2026-08-24T18:00:00.000Z",
  ).rows[0]!;
  const wrongDate = [...valid];
  wrongDate[0] = "2026-08-25";
  const tooLate = [...valid];
  tooLate[1] = "20260824_LATE_BBB";
  tooLate[11] = firstPitch;

  const finalized = finalizeOpenPregamePacketRows(
    [valid, wrongDate, tooLate],
    "2026-08-24",
    "2026-08-24T23:11:00.000Z",
  );
  assert.equal(finalized.rowsFrozen, 1);
  assert.equal(finalized.rowsRejected, 1);
  assert.equal(finalized.rows[0]![5], "FROZEN_PREGAME");
  assert.equal(finalized.rows[0]![11], valid[11]);
  assert.equal(finalized.rows[1]![5], "OPEN_PROSPECTIVE");
  assert.equal(finalized.rows[2]![5], "OPEN_PROSPECTIVE");
});

test("v41 packet header migration preserves old frozen fields by name", () => {
  const oldHeader = PREGAME_PACKET_HISTORY_HEADERS.filter((name) => ![
    "Reference_Market_Line", "Reference_Market_Source", "Reference_Market_TS",
    "Executable_Market_Line", "Executable_Market_Price", "Executable_Market_Source",
    "Executable_Market_TS", "Executable_Market_Quoted_TS", "Executable_Market_Status",
    "Primary_Grade_Market_Line", "Primary_Grade_Market_Source", "Primary_Grade_Market_Status",
  ].includes(name));
  const oldRow = Array(oldHeader.length).fill("");
  oldRow[oldHeader.indexOf("Game_ID")] = "20260824_AAA_BBB";
  oldRow[oldHeader.indexOf("Direction")] = "OVER";
  oldRow[oldHeader.indexOf("Away_Starter")] = "Frozen Away Starter";
  oldRow[oldHeader.indexOf("Market_Line")] = 8;
  const migrated = normalizePregamePacketHistoryRows([oldHeader, oldRow]);
  const index = Object.fromEntries(PREGAME_PACKET_HISTORY_HEADERS.map((name, position) => [name, position]));
  assert.equal(migrated.headerMigrated, true);
  assert.equal(migrated.rows[0]![index.Game_ID], "20260824_AAA_BBB");
  assert.equal(migrated.rows[0]![index.Direction], "OVER");
  assert.equal(migrated.rows[0]![index.Away_Starter], "Frozen Away Starter");
  assert.equal(migrated.rows[0]![index.Market_Line], 8);
  assert.equal(migrated.rows[0]![index.Executable_Market_Line], "");
  assert.equal(migrated.rows[0]![index.Executable_Market_Price], "");
  assert.equal(migrated.rows[0]![index.Executable_Market_Status], "");
  assert.equal(migrated.rows[0]![index.Strict_Structural_Cohort_Version], "");
  assert.equal(migrated.rows[0]![index.Strict_Structural_Verdict], "");
  assert.equal(migrated.rows[0]![index.Strict_Structural_Check_Vector], "");
});

test("packet contract preserves market and dependent shadow fields as explicit columns", () => {
  for (const required of [
    "Market_Line",
    "Market_Snapshot_Status",
    "Reference_Market_Line",
    "Executable_Market_Line",
    "Primary_Grade_Market_Line",
    "Executable_Market_Price",
    "Executable_Market_Quoted_TS",
    "Executable_Market_Status",
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
    "Truth_Checks",
    "Stability_Checks",
    "Starter_Bullpen_Reliance_State",
    "Opener_Chain_State",
    "Traffic_Damage_CoSign_Status",
    "Environment_Dependence_State",
    "Lineup_Completeness_State",
    "Engine_Version",
    "Schema_Version",
    "Separation_Pre_Registration_Version",
    "Price_Blind_Structural_Eligibility_Status",
    "Price_Blind_Structural_Failed_Checks",
    "Separation_Query_Line",
    "Separation_Market_Provenance",
    "Separation_Hard_Rock_Calibration_Status",
    "Separation_Continuous",
    "Separation_Cohort",
    "Separation_Adjacent_Threshold_Cohort",
    "Separation_Research_Tag",
    "Strict_Structural_Cohort_Version",
    "Strict_Structural_Snapshot_TS",
    "Strict_Structural_Verdict",
    "Strict_Structural_Exclusion_Reasons",
    "Strict_Check_Core_Packet_Complete",
    "Strict_Check_Starters_Resolved",
    "Strict_Check_Expected_Innings_Present",
    "Strict_Check_Opener_Chain_Clean",
    "Strict_Check_Bullpen_Usable",
    "Strict_Check_Offense_Source_Usable",
    "Strict_Check_Lineup_Data_Usable",
    "Strict_Check_Park_Source_Usable",
    "Strict_Check_Lineups_Official",
    "Strict_Check_Lineups_Full",
    "Strict_Check_Offense_Sources_Blended",
    "Strict_Check_Weather_Resolved_Or_Neutral",
    "Strict_Check_Environment_Certainty_High",
    "Strict_Check_Weather_Vehicle_Active",
    "Strict_Structural_Check_Vector",
  ])
    assert.ok(PREGAME_PACKET_HISTORY_HEADERS.includes(required as never));
});

test("packet schema and read range expand together for frozen moderation fields", () => {
  const schema = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "PREGAME_PACKET_HISTORY");
  assert.deepEqual(schema?.columns.map((column) => column.name), PREGAME_PACKET_HISTORY_HEADERS);
  assert.equal(WORKBOOK_SCHEMA_VERSION, 49);
  assert.equal(pregamePacketHistoryRange(5000), "A1:EY5000");
});
