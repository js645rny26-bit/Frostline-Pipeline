import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_MARKET_COMPARISON_TEST_HEADERS,
  CANONICAL_TRUTH_SETTLEMENT_TEST_HEADERS,
  canonicalMarketComparisonRow,
  compareFrozenTruthToMarket,
  constructAllocation,
  exactLineAudit,
  freezeCanonicalTruth,
  gradeMechanism,
  pointMetrics,
  recoverLegacyHumanP50,
  settleCanonicalTruth,
  validateCanonicalHumanInput,
  type CanonicalHumanInput,
  type TruthReadyEvidence,
} from "./module20b_predictionContract.js";

const evidence: TruthReadyEvidence = {
  scheduled_first_pitch: "2026-09-25T23:10:00.000Z",
  successful_refresh: true,
  snapshot_ts: "2026-09-25T22:00:00.000Z",
  away_lineup_status: "OFFICIAL",
  home_lineup_status: "OFFICIAL",
  away_starter: "Away Starter",
  home_starter: "Home Starter",
  away_pitching_plan_status: "CONVENTIONAL_STARTER",
  home_pitching_plan_status: "CONVENTIONAL_STARTER",
  bullpen_state_status: "AVAILABLE_CURRENT_D0",
  run_environment_status: "USABLE_CURRENT_STATE",
  full_game_integrity_freeze: false,
};

const allocation = constructAllocation(8.6, 3.24);
const human: CanonicalHumanInput = {
  total_p50: 8.6,
  total_mean: 8.9,
  away_allocation: allocation.away_allocation,
  home_allocation: allocation.home_allocation,
  primary_carrier: "HOME",
  primary_phase: "MIXED",
  primary_mechanism_code: "ONE_SIDED_CARRY",
  secondary_mechanism_code: "BULLPEN_CONTINUATION",
  primary_mechanism_text: "8.6 because Seattle is expected to carry through the opposing starter and relief bridge, with the away offense contributing roughly three runs.",
  market_exposure_status: "PRICE_BLIND",
};

test("allocation construction rounds one side and derives the residual", () => {
  assert.deepEqual(allocation, { away_allocation: 3.2, home_allocation: 5.4 });
  assert.equal(Number((allocation.away_allocation + allocation.home_allocation).toFixed(1)), 8.6);
  assert.deepEqual(constructAllocation(8.6, 5.36, "HOME"), {
    away_allocation: 3.2,
    home_allocation: 5.4,
  });
});

test("canonical input rejects rounding drift and a 41-word mechanism", () => {
  const fortyOneWords = Array.from({ length: 41 }, (_, index) => `w${index + 1}`).join(" ");
  const errors = validateCanonicalHumanInput({
    ...human,
    total_p50: 8.65,
    away_allocation: 3.2,
    home_allocation: 5.4,
    primary_mechanism_text: fortyOneWords,
  });
  assert.ok(errors.includes("TOTAL_P50_MORE_THAN_ONE_DECIMAL"));
  assert.ok(errors.includes("ALLOCATION_IDENTITY_FAILURE"));
  assert.ok(errors.includes("PRIMARY_MECHANISM_TEXT_OVER_40_WORDS"));
});

test("truth-ready gate fails closed on projected lineups or unresolved chain", () => {
  const result = freezeCanonicalTruth({
    date: "2026-09-25",
    game_id: "20260925_LAA_SEA",
    run_id: "run-1",
    evidence: {
      ...evidence,
      away_lineup_status: "PROJECTED",
      home_pitching_plan_status: "CHAIN_PARTIAL_NOT_PROJECTION_READY",
    },
    human_input: human,
  });
  assert.equal(result.status, "TRUTH_READY_GATE_FAILED");
  assert.deepEqual(result.gate.failed_checks, [
    "AWAY_LINEUP_NOT_OFFICIAL",
    "HOME_PITCHING_PLAN_UNRESOLVED",
  ]);
  assert.equal(result.records.length, 0);
});

test("gate pass without a complete human object stays pending and never invents truth", () => {
  const result = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence,
  });
  assert.equal(result.status, "CANONICAL_TRUTH_INPUT_PENDING");
  assert.deepEqual(result.validation_errors, ["HUMAN_TRUTH_OBJECT_MISSING"]);
});

test("atomic freeze creates one immutable hash and unchanged refreshes do not append", () => {
  const first = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  });
  assert.equal(first.status, "CANONICAL_TRUTH_FROZEN");
  assert.equal(first.frozen_record?.truth_version, "V1");
  assert.equal(first.frozen_record?.record_hash.length, 64);
  assert.equal(first.frozen_record?.canonical_freeze_ts, evidence.snapshot_ts);
  assert.equal(Number(((first.frozen_record?.away_allocation ?? 0) + (first.frozen_record?.home_allocation ?? 0)).toFixed(1)), 8.6);

  const rerun = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-2", evidence: {
      ...evidence, snapshot_ts: "2026-09-25T22:10:00.000Z",
    }, human_input: human, existing_records: first.records,
  });
  assert.equal(rerun.status, "ALREADY_FROZEN_UNCHANGED");
  assert.equal(rerun.records.length, 1);
  assert.equal(rerun.frozen_record?.record_hash, first.frozen_record?.record_hash);
});

test("material refreeze preserves V1 and links V2; discomfort alone is rejected", () => {
  const first = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  });
  const changed = { ...human, total_p50: 8.2, away_allocation: 3.0, home_allocation: 5.2 };
  const rejected = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-2", evidence: {
      ...evidence, snapshot_ts: "2026-09-25T22:15:00.000Z",
    }, human_input: changed, existing_records: first.records,
  });
  assert.equal(rejected.status, "REFREEZE_REJECTED");
  assert.equal(rejected.records.length, 1);

  const accepted = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-3", evidence: {
      ...evidence, snapshot_ts: "2026-09-25T22:20:00.000Z",
    }, human_input: changed, existing_records: first.records,
    material_input_change: true,
    reason_for_refreeze: "Confirmed starting pitcher scratched before first pitch.",
  });
  assert.equal(accepted.status, "CANONICAL_TRUTH_FROZEN");
  assert.equal(accepted.records.length, 2);
  assert.equal(accepted.frozen_record?.truth_version, "V2");
  assert.equal(accepted.frozen_record?.previous_record_hash, first.frozen_record?.record_hash);
  assert.deepEqual(accepted.records[0], first.records[0]);
});

test("no canonical pregame freeze can be manufactured at or after first pitch", () => {
  const result = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "late-run",
    evidence: { ...evidence, snapshot_ts: evidence.scheduled_first_pitch }, human_input: human,
  });
  assert.equal(result.status, "NO_CANONICAL_PREGAME_FREEZE");
  assert.equal(result.records.length, 0);
});

test("market is attached only after truth freeze and exact-line logic is deterministic", () => {
  const frozen = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  }).frozen_record!;
  const over = compareFrozenTruthToMarket(frozen, {
    line: 6.5, captured_ts: "2026-09-25T22:01:00.000Z", state: "PREGAME",
  });
  assert.equal(over.projection_delta, 2.1);
  assert.equal(over.direction, "OVER");
  assert.equal(over.exact_line_flag, false);
  const tie = compareFrozenTruthToMarket(frozen, {
    line: 8.6, captured_ts: "2026-09-25T22:02:00.000Z", state: "PREGAME",
  });
  assert.equal(tie.direction, "NO_CALL");
  assert.equal(tie.exact_line_flag, true);
  assert.deepEqual(canonicalMarketComparisonRow(over), [
    6.5, "2026-09-25T22:01:00.000Z", "PREGAME", "", "", "", 2.1, "OVER", false,
  ]);
  assert.deepEqual(CANONICAL_MARKET_COMPARISON_TEST_HEADERS, [
    "Captured_Market_Line", "Captured_Market_TS", "Captured_Market_State",
    "Captured_Game_State", "Captured_Score", "Captured_Inning",
    "Projection_Delta", "Direction", "Exact_Line_Flag",
  ]);
  assert.equal(frozen.record_hash, freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  }).frozen_record?.record_hash);
});

test("mechanism boundary grades wrong carrier/right mechanism PARTIAL and wrong mechanism FAILED", () => {
  assert.equal(gradeMechanism({
    evidence_available: true,
    primary_carrier_correct: false,
    primary_phase_correct: true,
    primary_mechanism_occurred: true,
    secondary_contribution_materially_correct: true,
  }), "PARTIAL");
  assert.equal(gradeMechanism({
    evidence_available: true,
    primary_carrier_correct: true,
    primary_phase_correct: false,
    primary_mechanism_occurred: false,
    secondary_contribution_materially_correct: true,
  }), "FAILED");
});

test("ordinary settlement grades P50 and allocation without any band containment fields", () => {
  const frozen = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  }).frozen_record!;
  const market = compareFrozenTruthToMarket(frozen, {
    line: 6.5, captured_ts: "2026-09-25T22:01:00.000Z", state: "PREGAME",
  });
  const settled = settleCanonicalTruth({
    record: frozen, market, actual_away_runs: 7, actual_home_runs: 3,
    mechanism_evidence: {
      evidence_available: true,
      primary_carrier_correct: false,
      primary_phase_correct: false,
      primary_mechanism_occurred: false,
      secondary_contribution_materially_correct: false,
    },
    settlement_ts: "2026-09-26T05:00:00.000Z",
  });
  assert.equal(settled.actual_total, 10);
  assert.equal(settled.human_signed_error, -1.4);
  assert.equal(settled.human_abs_error, 1.4);
  assert.equal(settled.direction_grade, "CORRECT");
  assert.equal(settled.allocation_sign_reversal, true);
  assert.equal(settled.mechanism_grade, "FAILED");
  assert.equal(CANONICAL_TRUTH_SETTLEMENT_TEST_HEADERS.some((header) => /band|range|p10|p20|p80|p90/i.test(header)), false);
});

test("whole-number market pushes and half-number market cannot push", () => {
  const frozen = freezeCanonicalTruth({
    date: "2026-09-25", game_id: "20260925_LAA_SEA", run_id: "run-1", evidence, human_input: human,
  }).frozen_record!;
  const whole = compareFrozenTruthToMarket(frozen, {
    line: 8, captured_ts: "2026-09-25T22:01:00.000Z", state: "PREGAME",
  });
  const pushed = settleCanonicalTruth({
    record: frozen, market: whole, actual_away_runs: 3, actual_home_runs: 5,
    mechanism_evidence: { evidence_available: false, primary_carrier_correct: false, primary_phase_correct: false, primary_mechanism_occurred: false, secondary_contribution_materially_correct: false },
    settlement_ts: "2026-09-26T05:00:00.000Z",
  });
  assert.equal(pushed.direction_grade, "PUSH");

  const half = compareFrozenTruthToMarket(frozen, {
    line: 8.5, captured_ts: "2026-09-25T22:01:00.000Z", state: "PREGAME",
  });
  const halfSettled = settleCanonicalTruth({
    record: frozen, market: half, actual_away_runs: 3, actual_home_runs: 5,
    mechanism_evidence: { evidence_available: false, primary_carrier_correct: false, primary_phase_correct: false, primary_mechanism_occurred: false, secondary_contribution_materially_correct: false },
    settlement_ts: "2026-09-26T05:00:00.000Z",
  });
  assert.notEqual(halfSettled.direction_grade, "PUSH");
});

test("point metrics and anti-anchoring exact-line audit are deterministic", () => {
  assert.deepEqual(pointMetrics([
    { forecast: 8.6, actual: 10 },
    { forecast: 7.0, actual: 5 },
  ]), {
    n: 2,
    mae: 1.7,
    median_ae: 1.7,
    rmse: 1.7263,
    bias: 0.3,
    miss_3plus_pct: 0,
    miss_4plus_pct: 0,
    miss_5plus_pct: 0,
  });
  assert.deepEqual(exactLineAudit([
    { exact_line_flag: true, market_exposure_status: "PRICE_BLIND" },
    { exact_line_flag: false, market_exposure_status: "PRICE_BLIND" },
    { exact_line_flag: true, market_exposure_status: "MARKET_EXPOSED" },
  ]), {
    exact_line_count: 2,
    exact_line_rate: 66.6667,
    exact_line_rate_price_blind: 50,
    exact_line_rate_market_exposed: 100,
  });
});

test("legacy human P50 is never inferred from an automatic band-center fallback", () => {
  assert.deepEqual(recoverLegacyHumanP50({
    run_band_center: 8.5,
    operator_evidence_provenance: "",
  }), { status: "NOT_AVAILABLE", legacy_human_p50: null });
  assert.deepEqual(recoverLegacyHumanP50({
    run_band_center: 8.6,
    operator_evidence_provenance: "RUN_BAND_CENTER=8.6; REASONING_SOURCE=MANUAL_OPERATOR",
  }), { status: "AVAILABLE", legacy_human_p50: 8.6 });
});
