/**
 * Module 20b supporting component: canonical human game-truth contract V1.
 *
 * TEST-COPY ONLY. This file is deliberately not imported by runner.ts, the
 * publisher, settlement, workbook schema, or any active projection/decision
 * consumer. It defines the deterministic contract that can be exercised in a
 * disposable workbook copy before production authorization.
 */

import { createHash } from "node:crypto";

export const HUMAN_TRUTH_CONTRACT_VERSION = "HUMAN_GAME_TRUTH_V1_TEST_ONLY";
export const MAX_MECHANISM_WORDS = 40;
export const ALLOCATION_TOLERANCE = 1e-9;

export type PrimaryCarrier = "AWAY" | "HOME" | "BALANCED";
export type PrimaryPhase = "STARTER" | "BULLPEN" | "MIXED" | "SUPPRESSION";
export type MarketExposureStatus = "PRICE_BLIND" | "MARKET_EXPOSED";
export type MarketState = "PREGAME" | "LIVE";
export type TruthDirection = "OVER" | "UNDER" | "NO_CALL";
export type MechanismGrade = "CONFIRMED" | "PARTIAL" | "FAILED" | "UNGRADABLE";

export const HUMAN_TRUTH_MECHANISM_CODES = [
  "STARTER_TRAFFIC_FAILURE",
  "STARTER_DAMAGE_FAILURE",
  "STARTER_SURVIVAL",
  "SHORT_WORKLOAD_BRIDGE_PRESSURE",
  "BULLPEN_CONTINUATION",
  "BULLPEN_SUPPRESSION",
  "TWO_SIDED_CONTACT",
  "ONE_SIDED_CARRY",
  "CONVERSION_STRENGTH",
  "CONVERSION_SHORTFALL_EXPECTED",
] as const;

export type HumanTruthMechanismCode = (typeof HUMAN_TRUTH_MECHANISM_CODES)[number];

export interface TruthReadyEvidence {
  scheduled_first_pitch: string;
  successful_refresh: boolean;
  snapshot_ts: string;
  away_lineup_status: string;
  home_lineup_status: string;
  away_starter: string;
  home_starter: string;
  away_pitching_plan_status: string;
  home_pitching_plan_status: string;
  bullpen_state_status: string;
  run_environment_status: string;
  full_game_integrity_freeze: boolean;
}

export interface TruthReadyResult {
  status: "PASS" | "FAIL";
  failed_checks: string[];
}

export interface CanonicalHumanInput {
  total_p50: number;
  total_mean: number | null;
  away_allocation: number;
  home_allocation: number;
  primary_carrier: PrimaryCarrier;
  primary_phase: PrimaryPhase;
  primary_mechanism_code: HumanTruthMechanismCode;
  secondary_mechanism_code: HumanTruthMechanismCode | "";
  primary_mechanism_text: string;
  market_exposure_status: MarketExposureStatus;
}

export interface CanonicalTruthRecord extends CanonicalHumanInput {
  date: string;
  game_id: string;
  human_truth_version: string;
  truth_version: string;
  truth_ready_gate: "PASS";
  truth_ready_ts: string;
  canonical_freeze_ts: string;
  canonical_freeze_run_id: string;
  human_freeze_status: "CANONICAL_TRUTH_FREEZE";
  allocation_margin: number;
  reason_for_refreeze: string;
  previous_record_hash: string;
  record_hash: string;
}

export interface CanonicalFreezeRequest {
  date: string;
  game_id: string;
  run_id: string;
  truth_ready_ts?: string;
  evidence: TruthReadyEvidence;
  human_input?: CanonicalHumanInput;
  existing_records?: CanonicalTruthRecord[];
  material_input_change?: boolean;
  reason_for_refreeze?: string;
}

export interface CanonicalFreezeResult {
  status:
    | "CANONICAL_TRUTH_FROZEN"
    | "ALREADY_FROZEN_UNCHANGED"
    | "TRUTH_READY_GATE_FAILED"
    | "CANONICAL_TRUTH_INPUT_PENDING"
    | "CANONICAL_TRUTH_INPUT_INVALID"
    | "REFREEZE_REJECTED"
    | "NO_CANONICAL_PREGAME_FREEZE";
  gate: TruthReadyResult;
  validation_errors: string[];
  records: CanonicalTruthRecord[];
  frozen_record: CanonicalTruthRecord | null;
}

export interface CapturedMarket {
  line: number;
  captured_ts: string;
  state: MarketState;
  game_state_when_captured?: string;
  score_when_captured?: string;
  inning_when_captured?: string;
}

export interface MarketComparison {
  market_line: number;
  market_ts: string;
  market_state: MarketState;
  captured_game_state: string;
  captured_score: string;
  captured_inning: string;
  projection_delta: number;
  direction: TruthDirection;
  exact_line_flag: boolean;
}

export interface MechanismEvidence {
  evidence_available: boolean;
  primary_carrier_correct: boolean;
  primary_phase_correct: boolean;
  primary_mechanism_occurred: boolean;
  secondary_contribution_materially_correct: boolean;
}

export interface CanonicalSettlement {
  date: string;
  game_id: string;
  truth_version: string;
  record_hash: string;
  human_total_p50: number;
  actual_total: number;
  human_signed_error: number;
  human_abs_error: number;
  human_squared_error: number;
  direction: TruthDirection | "UNAVAILABLE";
  direction_grade: "CORRECT" | "INCORRECT" | "PUSH" | "NO_CALL" | "UNGRADABLE";
  away_allocation: number;
  home_allocation: number;
  actual_away_runs: number;
  actual_home_runs: number;
  away_error: number;
  home_error: number;
  allocation_mae: number;
  projected_higher_scoring_side: "AWAY" | "HOME" | "TIE";
  actual_higher_scoring_side: "AWAY" | "HOME" | "TIE";
  allocation_sign_reversal: boolean;
  primary_mechanism_text: string;
  mechanism_grade: MechanismGrade;
  settlement_ts: string;
}

export const CANONICAL_TRUTH_TEST_HEADERS = [
  "Date", "Game_ID", "Human_Truth_Version", "Truth_Version", "Truth_Ready_Gate",
  "Truth_Ready_TS", "Canonical_Freeze_TS", "Canonical_Freeze_Run_ID",
  "Human_Freeze_Status", "Human_Total_P50", "Distribution_Total_Mean",
  "Human_Away_Allocation", "Human_Home_Allocation", "Human_Allocation_Margin",
  "Human_Primary_Carrier", "Human_Primary_Phase", "Human_Primary_Mechanism_Code",
  "Human_Secondary_Mechanism_Code", "Human_Primary_Mechanism_Text",
  "Market_Exposure_Status", "Reason_For_Refreeze", "Previous_Record_Hash", "Record_Hash",
] as const;

/** Market evidence is appended after the immutable truth object has frozen. */
export const CANONICAL_MARKET_COMPARISON_TEST_HEADERS = [
  "Captured_Market_Line", "Captured_Market_TS", "Captured_Market_State",
  "Captured_Game_State", "Captured_Score", "Captured_Inning",
  "Projection_Delta", "Direction", "Exact_Line_Flag",
] as const;

/** Ordinary truth settlement intentionally contains no distribution interval/band fields. */
export const CANONICAL_TRUTH_SETTLEMENT_TEST_HEADERS = [
  "Date", "Game_ID", "Truth_Version", "Record_Hash", "Human_Total_P50",
  "Actual_Total", "Human_Signed_Error", "Human_Abs_Error", "Human_Squared_Error",
  "Direction", "Direction_Grade", "Human_Away_Allocation", "Human_Home_Allocation",
  "Actual_Away_Runs", "Actual_Home_Runs", "Away_Error", "Home_Error",
  "Allocation_MAE", "Projected_Higher_Scoring_Side", "Actual_Higher_Scoring_Side",
  "Allocation_Sign_Reversal", "Frozen_Mechanism", "Mechanism_Grade", "Settlement_TS",
] as const;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function isOfficial(value: string): boolean {
  return /^(OFFICIAL|CONFIRMED)$/i.test(text(value));
}

function pitchingPlanResolved(value: string): boolean {
  const normalized = text(value).toUpperCase();
  if (!normalized) return false;
  return ![
    "UNRESOLVED",
    "ROLE_UNRESOLVED",
    "CHAIN_PARTIAL_NOT_PROJECTION_READY",
    "OPENER_CHAIN_UNCERTAINTY",
  ].some((blocked) => normalized.includes(blocked));
}

function usableState(value: string): boolean {
  const normalized = text(value).toUpperCase();
  return Boolean(normalized)
    && !normalized.includes("UNAVAILABLE")
    && !normalized.includes("UNKNOWN")
    && !normalized.includes("MISSING")
    && !normalized.includes("FREEZE");
}

function strictlyBefore(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs < rightMs;
}

export function evaluateTruthReadyGate(evidence: TruthReadyEvidence): TruthReadyResult {
  const failed: string[] = [];
  if (!evidence.successful_refresh) failed.push("REFRESH_NOT_SUCCESSFUL");
  if (!strictlyBefore(evidence.snapshot_ts, evidence.scheduled_first_pitch)) failed.push("NOT_PRE_FIRST_PITCH");
  if (!isOfficial(evidence.away_lineup_status)) failed.push("AWAY_LINEUP_NOT_OFFICIAL");
  if (!isOfficial(evidence.home_lineup_status)) failed.push("HOME_LINEUP_NOT_OFFICIAL");
  if (!text(evidence.away_starter)) failed.push("AWAY_STARTER_UNRESOLVED");
  if (!text(evidence.home_starter)) failed.push("HOME_STARTER_UNRESOLVED");
  if (!pitchingPlanResolved(evidence.away_pitching_plan_status)) failed.push("AWAY_PITCHING_PLAN_UNRESOLVED");
  if (!pitchingPlanResolved(evidence.home_pitching_plan_status)) failed.push("HOME_PITCHING_PLAN_UNRESOLVED");
  if (!usableState(evidence.bullpen_state_status)) failed.push("BULLPEN_STATE_NOT_CURRENT");
  if (!usableState(evidence.run_environment_status)) failed.push("RUN_ENVIRONMENT_NOT_USABLE");
  if (evidence.full_game_integrity_freeze) failed.push("FULL_GAME_INTEGRITY_FREEZE_ACTIVE");
  return { status: failed.length === 0 ? "PASS" : "FAIL", failed_checks: failed };
}

/** Round one side only; derive the other as the one-decimal residual. */
export function constructAllocation(
  totalP50: number,
  rawIndependentAllocation: number,
  independentlyRoundedSide: "AWAY" | "HOME" = "AWAY",
): { away_allocation: number; home_allocation: number } {
  const total = round(totalP50);
  const independent = round(rawIndependentAllocation);
  return independentlyRoundedSide === "AWAY"
    ? { away_allocation: independent, home_allocation: round(total - independent) }
    : { away_allocation: round(total - independent), home_allocation: independent };
}

function wordCount(value: string): number {
  const normalized = text(value);
  return normalized ? normalized.split(/\s+/).length : 0;
}

function hasAtMostOneDecimal(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value - round(value)) <= 1e-9;
}

export function validateCanonicalHumanInput(input: CanonicalHumanInput): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(input.total_p50) || input.total_p50 < 0) errors.push("TOTAL_P50_INVALID");
  else if (!hasAtMostOneDecimal(input.total_p50)) errors.push("TOTAL_P50_MORE_THAN_ONE_DECIMAL");
  if (input.total_mean !== null && (!Number.isFinite(input.total_mean) || input.total_mean < 0)) {
    errors.push("TOTAL_MEAN_INVALID");
  }
  if (!hasAtMostOneDecimal(input.away_allocation)) errors.push("AWAY_ALLOCATION_NOT_ONE_DECIMAL");
  if (!hasAtMostOneDecimal(input.home_allocation)) errors.push("HOME_ALLOCATION_NOT_ONE_DECIMAL");
  if (Math.abs(input.away_allocation + input.home_allocation - input.total_p50) > ALLOCATION_TOLERANCE) {
    errors.push("ALLOCATION_IDENTITY_FAILURE");
  }
  if (!input.primary_carrier) errors.push("PRIMARY_CARRIER_MISSING");
  if (!input.primary_phase) errors.push("PRIMARY_PHASE_MISSING");
  if (!(HUMAN_TRUTH_MECHANISM_CODES as readonly string[]).includes(input.primary_mechanism_code)) {
    errors.push("PRIMARY_MECHANISM_CODE_INVALID");
  }
  if (input.secondary_mechanism_code
    && !(HUMAN_TRUTH_MECHANISM_CODES as readonly string[]).includes(input.secondary_mechanism_code)) {
    errors.push("SECONDARY_MECHANISM_CODE_INVALID");
  }
  const mechanismWords = wordCount(input.primary_mechanism_text);
  if (mechanismWords === 0) errors.push("PRIMARY_MECHANISM_TEXT_MISSING");
  if (mechanismWords > MAX_MECHANISM_WORDS) errors.push("PRIMARY_MECHANISM_TEXT_OVER_40_WORDS");
  if (!input.market_exposure_status) errors.push("MARKET_EXPOSURE_STATUS_MISSING");
  return errors;
}

function immutableHumanPayload(input: CanonicalHumanInput): Record<string, unknown> {
  return {
    total_p50: input.total_p50,
    total_mean: input.total_mean,
    away_allocation: input.away_allocation,
    home_allocation: input.home_allocation,
    primary_carrier: input.primary_carrier,
    primary_phase: input.primary_phase,
    primary_mechanism_code: input.primary_mechanism_code,
    secondary_mechanism_code: input.secondary_mechanism_code,
    primary_mechanism_text: text(input.primary_mechanism_text),
    market_exposure_status: input.market_exposure_status,
  };
}

function sameHumanTruth(left: CanonicalHumanInput, right: CanonicalHumanInput): boolean {
  return JSON.stringify(immutableHumanPayload(left)) === JSON.stringify(immutableHumanPayload(right));
}

function recordHash(record: Omit<CanonicalTruthRecord, "record_hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function versionNumber(value: string): number {
  const parsed = Number.parseInt(value.replace(/^V/i, ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function freezeCanonicalTruth(request: CanonicalFreezeRequest): CanonicalFreezeResult {
  const existing = [...(request.existing_records ?? [])];
  const gate = evaluateTruthReadyGate(request.evidence);
  const firstPitchReached = !strictlyBefore(request.evidence.snapshot_ts, request.evidence.scheduled_first_pitch);
  if (firstPitchReached) {
    return {
      status: "NO_CANONICAL_PREGAME_FREEZE", gate, validation_errors: [],
      records: existing, frozen_record: null,
    };
  }
  if (gate.status !== "PASS") {
    return {
      status: "TRUTH_READY_GATE_FAILED", gate, validation_errors: [],
      records: existing, frozen_record: null,
    };
  }
  if (!request.human_input) {
    return {
      status: "CANONICAL_TRUTH_INPUT_PENDING", gate, validation_errors: ["HUMAN_TRUTH_OBJECT_MISSING"],
      records: existing, frozen_record: null,
    };
  }
  const validation = validateCanonicalHumanInput(request.human_input);
  if (validation.length > 0) {
    return {
      status: "CANONICAL_TRUTH_INPUT_INVALID", gate, validation_errors: validation,
      records: existing, frozen_record: null,
    };
  }

  const gameRecords = existing
    .filter((record) => record.date === request.date && record.game_id === request.game_id)
    .sort((a, b) => versionNumber(a.truth_version) - versionNumber(b.truth_version));
  const latest = gameRecords.at(-1);
  if (latest && sameHumanTruth(latest, request.human_input)) {
    return {
      status: "ALREADY_FROZEN_UNCHANGED", gate, validation_errors: [],
      records: existing, frozen_record: latest,
    };
  }
  if (latest && (!request.material_input_change || !text(request.reason_for_refreeze))) {
    return {
      status: "REFREEZE_REJECTED", gate,
      validation_errors: [
        !request.material_input_change ? "MATERIAL_INPUT_CHANGE_NOT_DECLARED" : "REFREEZE_REASON_MISSING",
      ],
      records: existing, frozen_record: null,
    };
  }

  const truthVersion = `V${latest ? versionNumber(latest.truth_version) + 1 : 1}`;
  const withoutHash: Omit<CanonicalTruthRecord, "record_hash"> = {
    ...request.human_input,
    primary_mechanism_text: text(request.human_input.primary_mechanism_text),
    date: request.date,
    game_id: request.game_id,
    human_truth_version: HUMAN_TRUTH_CONTRACT_VERSION,
    truth_version: truthVersion,
    truth_ready_gate: "PASS",
    truth_ready_ts: request.truth_ready_ts ?? request.evidence.snapshot_ts,
    canonical_freeze_ts: request.evidence.snapshot_ts,
    canonical_freeze_run_id: request.run_id,
    human_freeze_status: "CANONICAL_TRUTH_FREEZE",
    allocation_margin: round(request.human_input.home_allocation - request.human_input.away_allocation),
    reason_for_refreeze: latest ? text(request.reason_for_refreeze) : "",
    previous_record_hash: latest?.record_hash ?? "",
  };
  const frozen: CanonicalTruthRecord = { ...withoutHash, record_hash: recordHash(withoutHash) };
  return {
    status: "CANONICAL_TRUTH_FROZEN", gate, validation_errors: [],
    records: [...existing, frozen], frozen_record: frozen,
  };
}

export function compareFrozenTruthToMarket(
  frozen: CanonicalTruthRecord,
  market: CapturedMarket,
): MarketComparison {
  if (!Number.isFinite(market.line) || market.line < 0) throw new Error("MARKET_LINE_INVALID");
  if (!text(market.captured_ts)) throw new Error("MARKET_TS_MISSING");
  const delta = round(frozen.total_p50 - market.line);
  return {
    market_line: market.line,
    market_ts: market.captured_ts,
    market_state: market.state,
    captured_game_state: text(market.game_state_when_captured),
    captured_score: text(market.score_when_captured),
    captured_inning: text(market.inning_when_captured),
    projection_delta: delta,
    direction: delta > 0 ? "OVER" : delta < 0 ? "UNDER" : "NO_CALL",
    exact_line_flag: delta === 0,
  };
}

function higherSide(away: number, home: number): "AWAY" | "HOME" | "TIE" {
  if (Math.abs(away - home) <= ALLOCATION_TOLERANCE) return "TIE";
  return away > home ? "AWAY" : "HOME";
}

export function gradeMechanism(evidence: MechanismEvidence): MechanismGrade {
  if (!evidence.evidence_available) return "UNGRADABLE";
  if (!evidence.primary_phase_correct || !evidence.primary_mechanism_occurred) return "FAILED";
  if (evidence.primary_carrier_correct && evidence.secondary_contribution_materially_correct) return "CONFIRMED";
  return "PARTIAL";
}

function gradeDirection(
  market: MarketComparison | null,
  actualTotal: number,
): CanonicalSettlement["direction_grade"] {
  if (!market) return "UNGRADABLE";
  if (market.direction === "NO_CALL") return "NO_CALL";
  if (actualTotal === market.market_line) return "PUSH";
  const correct = market.direction === "OVER"
    ? actualTotal > market.market_line
    : actualTotal < market.market_line;
  return correct ? "CORRECT" : "INCORRECT";
}

export function settleCanonicalTruth(args: {
  record: CanonicalTruthRecord;
  market: MarketComparison | null;
  actual_away_runs: number;
  actual_home_runs: number;
  mechanism_evidence: MechanismEvidence;
  settlement_ts: string;
}): CanonicalSettlement {
  const { record } = args;
  if (![args.actual_away_runs, args.actual_home_runs].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("ACTUAL_TEAM_RUNS_INVALID");
  }
  const actualTotal = args.actual_away_runs + args.actual_home_runs;
  const signed = round(record.total_p50 - actualTotal);
  const awayError = round(record.away_allocation - args.actual_away_runs);
  const homeError = round(record.home_allocation - args.actual_home_runs);
  const projectedHigher = higherSide(record.away_allocation, record.home_allocation);
  const actualHigher = higherSide(args.actual_away_runs, args.actual_home_runs);
  return {
    date: record.date,
    game_id: record.game_id,
    truth_version: record.truth_version,
    record_hash: record.record_hash,
    human_total_p50: record.total_p50,
    actual_total: actualTotal,
    human_signed_error: signed,
    human_abs_error: round(Math.abs(signed)),
    human_squared_error: round(signed ** 2, 2),
    direction: args.market?.direction ?? "UNAVAILABLE",
    direction_grade: gradeDirection(args.market, actualTotal),
    away_allocation: record.away_allocation,
    home_allocation: record.home_allocation,
    actual_away_runs: args.actual_away_runs,
    actual_home_runs: args.actual_home_runs,
    away_error: awayError,
    home_error: homeError,
    allocation_mae: round((Math.abs(awayError) + Math.abs(homeError)) / 2),
    projected_higher_scoring_side: projectedHigher,
    actual_higher_scoring_side: actualHigher,
    allocation_sign_reversal: projectedHigher !== "TIE" && actualHigher !== "TIE" && projectedHigher !== actualHigher,
    primary_mechanism_text: record.primary_mechanism_text,
    mechanism_grade: gradeMechanism(args.mechanism_evidence),
    settlement_ts: args.settlement_ts,
  };
}

export function canonicalTruthRow(record: CanonicalTruthRecord): unknown[] {
  return [
    record.date, record.game_id, record.human_truth_version, record.truth_version,
    record.truth_ready_gate, record.truth_ready_ts, record.canonical_freeze_ts,
    record.canonical_freeze_run_id, record.human_freeze_status, record.total_p50,
    record.total_mean ?? "", record.away_allocation, record.home_allocation,
    record.allocation_margin, record.primary_carrier, record.primary_phase,
    record.primary_mechanism_code, record.secondary_mechanism_code,
    record.primary_mechanism_text, record.market_exposure_status,
    record.reason_for_refreeze, record.previous_record_hash, record.record_hash,
  ];
}

export function canonicalMarketComparisonRow(market: MarketComparison): unknown[] {
  return [
    market.market_line, market.market_ts, market.market_state,
    market.captured_game_state, market.captured_score, market.captured_inning,
    market.projection_delta, market.direction, market.exact_line_flag,
  ];
}

export function canonicalSettlementRow(record: CanonicalSettlement): unknown[] {
  return [
    record.date, record.game_id, record.truth_version, record.record_hash,
    record.human_total_p50, record.actual_total, record.human_signed_error,
    record.human_abs_error, record.human_squared_error, record.direction,
    record.direction_grade, record.away_allocation, record.home_allocation,
    record.actual_away_runs, record.actual_home_runs, record.away_error,
    record.home_error, record.allocation_mae, record.projected_higher_scoring_side,
    record.actual_higher_scoring_side, record.allocation_sign_reversal ? "TRUE" : "FALSE",
    record.primary_mechanism_text, record.mechanism_grade, record.settlement_ts,
  ];
}

export interface PointMetrics {
  n: number;
  mae: number | null;
  median_ae: number | null;
  rmse: number | null;
  bias: number | null;
  miss_3plus_pct: number | null;
  miss_4plus_pct: number | null;
  miss_5plus_pct: number | null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function pointMetrics(rows: Array<{ forecast: number; actual: number }>): PointMetrics {
  const errors = rows.map((row) => row.forecast - row.actual);
  const absolute = errors.map(Math.abs);
  const n = rows.length;
  const percentage = (threshold: number): number | null => n
    ? round(100 * absolute.filter((value) => value >= threshold).length / n, 4)
    : null;
  return {
    n,
    mae: n ? round(mean(absolute)!, 4) : null,
    median_ae: n ? round(median(absolute)!, 4) : null,
    rmse: n ? round(Math.sqrt(mean(errors.map((value) => value ** 2))!), 4) : null,
    bias: n ? round(mean(errors)!, 4) : null,
    miss_3plus_pct: percentage(3),
    miss_4plus_pct: percentage(4),
    miss_5plus_pct: percentage(5),
  };
}

export function exactLineAudit(
  observations: Array<{ exact_line_flag: boolean; market_exposure_status: MarketExposureStatus }>,
): {
  exact_line_count: number;
  exact_line_rate: number | null;
  exact_line_rate_price_blind: number | null;
  exact_line_rate_market_exposed: number | null;
} {
  const rate = (rows: typeof observations): number | null => rows.length
    ? round(100 * rows.filter((row) => row.exact_line_flag).length / rows.length, 4)
    : null;
  const priceBlind = observations.filter((row) => row.market_exposure_status === "PRICE_BLIND");
  const marketExposed = observations.filter((row) => row.market_exposure_status === "MARKET_EXPOSED");
  return {
    exact_line_count: observations.filter((row) => row.exact_line_flag).length,
    exact_line_rate: rate(observations),
    exact_line_rate_price_blind: rate(priceBlind),
    exact_line_rate_market_exposed: rate(marketExposed),
  };
}

/**
 * Historical compatibility is allowed only when the operator provenance proves
 * that the center itself was supplied pregame. Automatic Base_Projection
 * fallback in legacy FULL_LADDER_AUDIT rows is not human evidence.
 */
export function recoverLegacyHumanP50(args: {
  run_band_center: unknown;
  operator_evidence_provenance: unknown;
}): { status: "AVAILABLE" | "NOT_AVAILABLE"; legacy_human_p50: number | null } {
  const provenance = text(args.operator_evidence_provenance).toUpperCase();
  const parsed = Number.parseFloat(text(args.run_band_center));
  if (!provenance.includes("RUN_BAND_CENTER=") || !Number.isFinite(parsed)) {
    return { status: "NOT_AVAILABLE", legacy_human_p50: null };
  }
  return { status: "AVAILABLE", legacy_human_p50: parsed };
}
