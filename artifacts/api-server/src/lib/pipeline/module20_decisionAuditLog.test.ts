import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_AUDIT_COLS,
  DECISION_AUDIT_HEADER,
  DECISION_AUDIT_INDEX as C,
  gradeAuditTruth,
  settleDecisionAuditRows,
  upsertDecisionAuditPregameRows,
  type DecisionAuditPregameInput,
} from "./module20_decisionAuditLog.js";
import type { SettlementRow } from "./module14_shadowSettlement.js";

const TS1 = "2026-08-09T12:00:00.000Z";
const TS2 = "2026-08-09T13:00:00.000Z";
const TS3 = "2026-08-10T03:00:00.000Z";

function pregame(overrides: Partial<DecisionAuditPregameInput> = {}): DecisionAuditPregameInput {
  return {
    date: "2026-08-09",
    game_id: "20260809_CIN_WSN",
    away_team: "CIN",
    home_team: "WSN",
    scheduled_first_pitch: "2026-08-09T17:35:00.000Z",
    run_id: "20260809_CIN_WSN_run",
    model_version: "DA-1.1.0",
    lock_status: "PRE_LOCK",
    projected_away_runs: 4.7,
    projected_home_runs: 4.3,
    projected_total: 9,
    market_line: 8.5,
    direction: "OVER",
    vehicle: "GAME_TOTAL",
    model_confidence: 0.74,
    model_blocker: "",
    statcast_preview_available: "AVAILABLE",
    model_decision: "CORE",
    ...overrides,
  };
}

function outcome(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    date: "2026-08-09",
    game_id: "20260809_CIN_WSN",
    away_team: "CIN",
    home_team: "WSN",
    repaired_projected_total: 9,
    actual_away_runs: 6,
    actual_home_runs: 4,
    actual_total: 10,
    error: -1,
    abs_error: 1,
    park_source_status: "VENUE_FACTOR_USED",
    away_offense_source: "BLENDED",
    home_offense_source: "BLENDED",
    settlement_ts: TS3,
    frozen_published_total: 9,
    frozen_error: -1,
    frozen_abs_error: 1,
    frozen_projection_source: "FROZEN_VEHICLE_LOG",
    repaired_minus_frozen: 0,
    frozen_market_line: 8.5,
    settlement_market_line: 8.5,
    frozen_ticket_result: "WIN",
    settlement_ticket_result: "WIN",
    projection_audit_status: "MATCHES_PUBLISHED",
    projected_away_starter: "Away Starter",
    projected_home_starter: "Home Starter",
    actual_away_starter: "Away Starter",
    actual_home_starter: "Home Starter",
    away_starter_match_status: "MATCH",
    home_starter_match_status: "MATCH",
    away_bulk_pitcher: "Away Bulk",
    home_bulk_pitcher: "Home Bulk",
    away_pitcher_chain: "Away Starter (6.0 IP)",
    home_pitcher_chain: "Home Starter (5.0 IP)",
    pitcher_provenance_status: "COMPLETE",
    ...overrides,
  };
}

test("decision audit schema has the exact 50-column contract", () => {
  assert.equal(DECISION_AUDIT_HEADER.length, DECISION_AUDIT_COLS);
  assert.equal(DECISION_AUDIT_HEADER[0], "Date");
  assert.equal(DECISION_AUDIT_HEADER[49], "Graded_TS");
});

test("pregame replay is idempotent by Date + Game_ID with zero duplicates", () => {
  const inputs = Array.from({ length: 15 }, (_, index) => pregame({
    game_id: `20260809_A${index}_H${index}`,
    away_team: `A${index}`,
    home_team: `H${index}`,
    model_decision: index < 3 ? "CORE" : "NO_CORE",
    model_blocker: index < 3 ? "" : "INSUFFICIENT_PROJECTION_SEPARATION",
  }));
  const first = upsertDecisionAuditPregameRows([], inputs, TS1);
  assert.equal(first.rows.length, 15);
  assert.equal(first.rowsWritten, 15);
  assert.equal(new Set(first.rows.map((row) => `${row[0]}_${row[1]}`)).size, 15);

  for (let index = 0; index < 3; index++) {
    first.rows[index]![C.FINAL_REASONING_SOURCE] = "MODEL_MANUAL_AGREEMENT";
  }
  const second = upsertDecisionAuditPregameRows(first.rows, inputs, TS2);
  assert.equal(second.rows.length, 15);
  assert.equal(second.rowsWritten, 0);
  assert.equal(second.rowsUpdated, 15);
  assert.equal(second.duplicatesRemoved, 0);
  assert.equal(second.rows.filter((row) => row[C.FINAL_REASONING_SOURCE] === "MODEL_MANUAL_AGREEMENT").length, 3);
  assert.equal(second.rows.filter((row) => row[C.FINAL_DECISION] === "CORE").length, 3);
  assert.equal(second.rows.filter((row) => row[C.FINAL_DECISION] === "NO CORE").length, 12);
});

test("lock transition freezes the latest model snapshot and preserves manual overlay", () => {
  const first = upsertDecisionAuditPregameRows([], [pregame()], TS1);
  first.rows[0]![C.MANUAL_TRUTH] = "UNDER";
  first.rows[0]![C.MANUAL_CONFIDENCE] = 8;
  first.rows[0]![C.FINAL_REASONING_SOURCE] = "SPLIT_DECISION";

  const atLock = upsertDecisionAuditPregameRows(first.rows, [pregame({
    lock_status: "LOCKED_IN",
    projected_total: 9.4,
    projected_away_runs: 5,
    projected_home_runs: 4.4,
  })], TS2);
  assert.equal(atLock.rows[0]![C.AUDIT_STATUS], "FROZEN");
  assert.equal(atLock.rows[0]![C.FROZEN_TOTAL], 9.4);
  assert.equal(atLock.rows[0]![C.MANUAL_TRUTH], "UNDER");
  assert.equal(atLock.rows[0]![C.FINAL_REASONING_SOURCE], "SPLIT_DECISION");

  const frozenSnapshot = atLock.rows[0]!.slice(0, 34);
  const lateRerun = upsertDecisionAuditPregameRows(atLock.rows, [pregame({
    lock_status: "LOCKED_IN",
    projected_total: 12.2,
    direction: "UNDER",
  })], TS3);
  assert.deepEqual(lateRerun.rows[0]!.slice(0, 34), frozenSnapshot);
  assert.equal(lateRerun.rowsFrozen, 1);
});

test("settlement appends grading without changing any pregame field", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({ lock_status: "LOCKED_IN" })], TS1);
  const frozen = pre.rows[0]!.slice(0, 34);
  const settled = settleDecisionAuditRows(pre.rows, [outcome()], TS3);
  assert.deepEqual(settled.rows[0]!.slice(0, 34), frozen);
  assert.equal(settled.rows[0]![C.AUDIT_STATUS], "FROZEN");
  assert.equal(settled.rows[0]![C.ACTUAL_AWAY], 6);
  assert.equal(settled.rows[0]![C.ACTUAL_HOME], 4);
  assert.equal(settled.rows[0]![C.TICKET_RESULT], "WIN");
  assert.equal(settled.rows[0]![C.AUTHORIZATION_GRADE], "CORRECT_AUTHORIZE");
});

test("settlement rerun is idempotent and cannot rewrite frozen reasoning", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({ lock_status: "LOCKED_IN" })], TS1);
  const first = settleDecisionAuditRows(pre.rows, [outcome()], TS3);
  const snapshot = first.rows[0]!.slice();
  const second = settleDecisionAuditRows(first.rows, [outcome({ actual_total: 99 })], "2026-08-10T04:00:00.000Z");
  assert.deepEqual(second.rows[0], snapshot);
  assert.equal(second.rowsSettled, 1);
  assert.equal(second.rowsUpdated, 0);
});

test("a winning passed vehicle does not become QUESTIONABLE_PASS", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({
    lock_status: "LOCKED_OUT",
    model_decision: "NO_CORE",
    model_blocker: "UNRESOLVED_STARTER",
  })], TS1);
  pre.rows[0]![C.MANUAL_TRUTH] = "UNDER";
  pre.rows[0]![C.FINAL_REASONING_SOURCE] = "MODEL_WITH_MANUAL_DOWNGRADE";
  pre.rows[0]![C.FINAL_DECISION] = "NO CORE";
  pre.rows[0]![C.FINAL_BLOCKER] = "UNRESOLVED_STARTER";

  const settled = settleDecisionAuditRows(pre.rows, [outcome({ actual_total: 10 })], TS3);
  const row = settled.rows[0]!;
  assert.equal(row[C.MODEL_TRUTH_GRADE], "CORRECT");
  assert.equal(row[C.MANUAL_TRUTH_GRADE], "INCORRECT");
  assert.equal(row[C.TICKET_RESULT], "NO_WAGER");
  assert.equal(row[C.AUTHORIZATION_GRADE], "CORRECT_PASS");
  assert.notEqual(row[C.AUTHORIZATION_GRADE], "QUESTIONABLE_PASS");
});

test("authorization quality is not rewritten from a losing ticket", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({ lock_status: "LOCKED_IN" })], TS1);
  const settled = settleDecisionAuditRows(pre.rows, [outcome({
    actual_away_runs: 3,
    actual_home_runs: 3,
    actual_total: 6,
  })], TS3);
  const row = settled.rows[0]!;
  assert.equal(row[C.TICKET_RESULT], "LOSS");
  assert.equal(row[C.AUTHORIZATION_GRADE], "CORRECT_AUTHORIZE");
});

test("manual override grades the authorized manual direction without rewriting model truth", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({ lock_status: "LOCKED_IN" })], TS1);
  pre.rows[0]![C.MANUAL_TRUTH] = "UNDER suppression";
  pre.rows[0]![C.FINAL_REASONING_SOURCE] = "MANUAL_OVERRIDE";
  pre.rows[0]![C.FINAL_DECISION] = "CORE";
  pre.rows[0]![C.FINAL_BLOCKER] = "";

  const settled = settleDecisionAuditRows(pre.rows, [outcome({
    actual_away_runs: 3,
    actual_home_runs: 3,
    actual_total: 6,
  })], TS3);
  const row = settled.rows[0]!;
  assert.equal(row[C.MODEL_TRUTH_GRADE], "INCORRECT");
  assert.equal(row[C.MANUAL_TRUTH_GRADE], "CORRECT");
  assert.equal(row[C.TICKET_RESULT], "WIN");
  assert.equal(row[C.AUTHORIZATION_GRADE], "CORRECT_AUTHORIZE");
});

test("settlement does not manufacture a missing pregame audit row", () => {
  const settled = settleDecisionAuditRows([], [outcome()], TS3);
  assert.equal(settled.rows.length, 0);
  assert.equal(settled.rowsSettled, 0);
  assert.equal(settled.rowsUpdated, 0);
});

test("pushes remain neutral in truth, ticket, and authorization grading", () => {
  const pre = upsertDecisionAuditPregameRows([], [pregame({
    lock_status: "LOCKED_IN",
    projected_total: 8,
    market_line: 9,
    direction: "UNDER",
  })], TS1);
  const settled = settleDecisionAuditRows(pre.rows, [outcome({
    actual_away_runs: 5,
    actual_home_runs: 4,
    actual_total: 9,
  })], TS3);
  const row = settled.rows[0]!;
  assert.equal(row[C.MODEL_TRUTH_GRADE], "PUSH");
  assert.equal(row[C.TICKET_RESULT], "PUSH");
  assert.equal(row[C.AUTHORIZATION_GRADE], "NOT_GRADABLE");
  assert.equal(row[C.OUTCOME_TAG], "PUSH");
});

test("confidence is clamped to independent 1-10 fields and truth grading is monotone", () => {
  const low = upsertDecisionAuditPregameRows([], [pregame({ model_confidence: 0 })], TS1).rows[0]!;
  const high = upsertDecisionAuditPregameRows([], [pregame({ model_confidence: 99 })], TS1).rows[0]!;
  assert.equal(low[C.FROZEN_CONFIDENCE], 1);
  assert.equal(low[C.FINAL_CONFIDENCE], 1);
  assert.equal(high[C.FROZEN_CONFIDENCE], 10);
  assert.equal(high[C.FINAL_CONFIDENCE], 10);
  assert.equal(gradeAuditTruth("OVER", 8.5, 8), "INCORRECT");
  assert.equal(gradeAuditTruth("OVER", 8.5, 8.5), "PUSH");
  assert.equal(gradeAuditTruth("OVER", 8.5, 9), "CORRECT");
});
