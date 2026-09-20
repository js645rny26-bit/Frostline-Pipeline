/**
 * Module 32: Bullpen Phase Coverage + Analysis V1
 *
 * Research-only, settlement-time instrumentation. The gate is evaluated
 * before any phase replay or inferential summary is built. Exact phase runs
 * are reconstructed from MLB play-by-play using the pitcher actually on the
 * mound when each run scores; pitcher-charged R/ER are never substituted.
 *
 * This module reads immutable frozen packets and canonical settled outcomes.
 * It cannot write or change a pregame projection, market, vehicle, decision,
 * authorization, or frozen packet.
 */

import {
  addSheet,
  clearRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

export const BULLPEN_PHASE_COVERAGE_SHEET = "BULLPEN_PHASE_COVERAGE_V1";
export const BULLPEN_PHASE_COVERAGE_SUMMARY_SHEET =
  "BULLPEN_PHASE_COVERAGE_SUMMARY_V1";
export const BULLPEN_PHASE_REPLAY_SHEET = "BULLPEN_PHASE_REPLAY_V1";
export const BULLPEN_PHASE_ANALYSIS_SHEET = "BULLPEN_PHASE_ANALYSIS_V1";

export const PHASE_INSTRUMENTATION_VERSION = "BULLPEN_PHASE_PBP_V1_2026-09-13";
export const MIN_PHASE_USABLE_GAMES = 100;
export const MIN_PHASE_COVERAGE_PCT = 50;
export const MIN_INTERPRETABLE_CELL_N = 15;
export const MATERIAL_STARTER_SHORTFALL_IP = 2;

const MLB_API = "https://statsapi.mlb.com/api/v1";

export const BULLPEN_PHASE_COVERAGE_HEADERS = [
  "Date",
  "Game_ID",
  "Allocation_Eligible",
  "Starter_Role_Away",
  "Starter_Role_Home",
  "Actual_Starter_Window_Runs_Status",
  "Actual_Starter_Window_Runs_Source",
  "Actual_Post_Starter_Runs_Status",
  "Actual_Post_Starter_Runs_Source",
  "Actual_Away_IP_Status",
  "Actual_Home_IP_Status",
  "Frozen_Expected_IP_Status",
  "Reconstruction_Required",
  "Reconstruction_Method",
  "Inherited_Runner_Ambiguity_Status",
  "Phase_Row_Usable",
  "Exclusion_Reason",
  "Game_PK",
  "Frozen_Packet_Snapshot_TS",
  "Starter_Identity_Status",
  "Actual_Starter_Window_Runs",
  "Actual_Away_Offense_Starter_Window_Runs",
  "Actual_Home_Offense_Starter_Window_Runs",
  "Actual_Post_Starter_Runs",
  "Actual_Total_Runs",
  "Actual_Away_Starter_IP",
  "Actual_Home_Starter_IP",
  "Frozen_Away_Expected_IP",
  "Frozen_Home_Expected_IP",
  "Frozen_Starter_Attack_Runs",
  "Frozen_Bullpen_Continuation_Runs",
  "Away_Starter_Shortfall_IP",
  "Home_Starter_Shortfall_IP",
  "Max_Starter_Shortfall_IP",
  "Workload_State",
  "Instrumentation_Version",
  "Coverage_TS",
] as const;

export const BULLPEN_PHASE_COVERAGE_SUMMARY_HEADERS = [
  "Metric",
  "Value",
  "Status",
  "Source",
  "Notes",
  "Coverage_TS",
] as const;

export const BULLPEN_PHASE_REPLAY_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Actual_Total_Runs",
  "Frozen_Starter_Attack_Runs",
  "Actual_Starter_Window_Runs",
  "Starter_Phase_Error",
  "Starter_Phase_Abs_Error",
  "Frozen_Bullpen_Continuation_Runs",
  "Actual_Post_Starter_Runs",
  "Bullpen_Phase_Error",
  "Bullpen_Phase_Abs_Error",
  "Paired_Bullpen_MAE_Minus_Starter_MAE",
  "Actual_Away_Starter_IP",
  "Actual_Home_Starter_IP",
  "Frozen_Away_Expected_IP",
  "Frozen_Home_Expected_IP",
  "Away_Starter_Shortfall_IP",
  "Home_Starter_Shortfall_IP",
  "Max_Starter_Shortfall_IP",
  "Workload_State",
  "Slate_Runs_Per_Game",
  "LOSO_Corpus_N_Slates",
  "LOSO_Mean_Runs_Per_Game",
  "LOSO_SD_Runs_Per_Game",
  "Slate_Z_LOSO",
  "Slate_Environment_Bucket",
  "Inherited_Runner_Ambiguity_Status",
  "Actual_Phase_Source",
  "Replay_Status",
  "Replay_TS",
] as const;

export const BULLPEN_PHASE_ANALYSIS_HEADERS = [
  "Row_Type",
  "Slate_Environment_Bucket",
  "Workload_State",
  "Eligible_N",
  "Eligible_N_Slates",
  "Starter_Phase_Signed_Bias",
  "Starter_Phase_MAE",
  "Starter_Phase_RMSE",
  "Bullpen_Phase_Signed_Bias",
  "Bullpen_Phase_MAE",
  "Bullpen_Phase_RMSE",
  "Paired_Bullpen_MAE_Minus_Starter_MAE",
  "Paired_Difference_CI_Lower",
  "Paired_Difference_CI_Upper",
  "Uncertainty_Method",
  "Cell_Status",
  "Main_Effect_Status",
  "Interaction_Status",
  "Primary_Verdict",
  "Commissioning_Consequence",
  "Notes",
  "Analysis_TS",
] as const;

export type PhaseVerdict =
  | "BULLPEN_STATE_HYPOTHESIS_SUPPORTED"
  | "GENERIC_BULLPEN_CONTINUATION_DEFECT"
  | "EXTREME_SLATE_EFFECT_DOMINANT"
  | "INCONCLUSIVE_SAMPLE_OR_EFFECT"
  | "INSUFFICIENT_PHASE_INSTRUMENTATION";

export type WorkloadState =
  "REACHED_OR_EXCEEDED" | "MODERATELY_SHORT" | "MATERIALLY_SHORT";

export type EnvironmentBucket = "LOW_NORMAL" | "HIGH" | "EXTREME";

interface FrozenPhasePacket {
  date: string;
  game_id: string;
  snapshot_ts: string;
  away_role: string;
  home_role: string;
  away_expected_ip: number | null;
  home_expected_ip: number | null;
  starter_attack_runs: number | null;
  bullpen_continuation_runs: number | null;
}

interface AllocationOutcome {
  date: string;
  game_id: string;
  actual_total: number;
}

interface StarterActual {
  actual_ip: number | null;
  status: string;
}

interface StarterIdentity {
  away: string;
  home: string;
}

export interface PhaseCorpusInput extends FrozenPhasePacket, AllocationOutcome {
  actual_away_ip: number | null;
  actual_home_ip: number | null;
  actual_away_ip_status: string;
  actual_home_ip_status: string;
  away_starter_match: string;
  home_starter_match: string;
}

export interface PhaseReconstruction {
  status:
    | "RECONSTRUCTED_VALIDATED"
    | "PLAY_BY_PLAY_UNAVAILABLE"
    | "STARTER_ON_MOUND_ID_UNRESOLVED"
    | "SCORING_PITCHER_UNRESOLVED"
    | "PLAY_BY_PLAY_TOTAL_MISMATCH";
  actual_starter_window_runs: number | null;
  actual_away_offense_starter_window_runs: number | null;
  actual_home_offense_starter_window_runs: number | null;
  actual_post_starter_runs: number | null;
  inherited_runner_crossings: number;
  actual_total_from_pbp: number | null;
}

export interface PhaseCoverageRecord extends PhaseCorpusInput {
  game_pk: number | null;
  reconstruction: PhaseReconstruction;
  phase_row_usable: boolean;
  exclusion_reason: string;
  away_shortfall_ip: number | null;
  home_shortfall_ip: number | null;
  max_shortfall_ip: number | null;
  workload_state: WorkloadState | null;
}

export interface SlateEnvironment {
  date: string;
  slate_runs_per_game: number;
  loso_corpus_n_slates: number;
  loso_mean_runs_per_game: number | null;
  loso_sd_runs_per_game: number | null;
  slate_z_loso: number | null;
  bucket: EnvironmentBucket | null;
}

export interface PhaseReplayRecord extends PhaseCoverageRecord {
  starter_phase_error: number;
  bullpen_phase_error: number;
  paired_loss_difference: number;
  environment: SlateEnvironment;
}

export interface PhaseMetrics {
  n: number;
  n_slates: number;
  starter_bias: number | null;
  starter_mae: number | null;
  starter_rmse: number | null;
  bullpen_bias: number | null;
  bullpen_mae: number | null;
  bullpen_rmse: number | null;
  paired_loss_difference: number | null;
}

export interface PhaseAnalysisRow extends PhaseMetrics {
  row_type:
    | "OVERALL"
    | "ENVIRONMENT_MAIN_EFFECT"
    | "WORKLOAD_MAIN_EFFECT"
    | "INTERACTION_CELL";
  environment_bucket: EnvironmentBucket | "ALL";
  workload_state: WorkloadState | "ALL";
  ci_lower: number | null;
  ci_upper: number | null;
  uncertainty_method: string;
  cell_status: string;
}

export interface BullpenPhaseAnalysisResult {
  status: "success" | "failure";
  analysis_timestamp_utc: string;
  allocation_eligible_games: number;
  direct_phase_games: number;
  reconstructed_phase_games: number;
  usable_phase_games: number;
  coverage_pct: number;
  instrumentation_verdict: "PASS" | "INSUFFICIENT_PHASE_INSTRUMENTATION";
  primary_verdict: PhaseVerdict;
  interaction_status:
    | "MAIN_EFFECT_EVIDENCE_AVAILABLE"
    | "INTERACTION_UNDERPOWERED"
    | "ANALYSIS_STOPPED";
  coverage_rows_written: number;
  replay_rows_written: number;
  analysis_rows_written: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 4): number {
  return Number.parseFloat(value.toFixed(digits));
}

function headerIndex(header: readonly unknown[]): Map<string, number> {
  return new Map(header.map((value, index) => [text(value), index]));
}

function value(
  row: readonly unknown[],
  index: ReadonlyMap<string, number>,
  name: string,
): unknown {
  const column = index.get(name);
  return column === undefined ? undefined : row[column];
}

function key(date: string, gameId: string): string {
  return `${date}|${gameId}`;
}

function dateFromGameId(gameId: string): string {
  const compact = gameId.slice(0, 8);
  return /^\d{8}$/.test(compact)
    ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
    : "";
}

function validBefore(snapshotTs: string, firstPitch: string): boolean {
  const snapshot = Date.parse(snapshotTs);
  const first = Date.parse(firstPitch);
  return (
    Number.isFinite(snapshot) && Number.isFinite(first) && snapshot < first
  );
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, current) => sum + current, 0) / values.length;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const center = mean(values)!;
  return Math.sqrt(
    values.reduce((sum, current) => sum + (current - center) ** 2, 0) /
      (values.length - 1),
  );
}

function parseFrozenPackets(rows: unknown[][]): Map<string, FrozenPhasePacket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const result = new Map<string, FrozenPhasePacket>();
  const latest = new Map<string, number>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const snapshotMs = Date.parse(snapshotTs);
    const identity = key(date, gameId);
    if (
      !date ||
      !gameId ||
      text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME" ||
      !validBefore(snapshotTs, firstPitch) ||
      !Number.isFinite(snapshotMs) ||
      snapshotMs < (latest.get(identity) ?? Number.NEGATIVE_INFINITY)
    )
      continue;
    result.set(identity, {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      away_role: text(value(row, index, "Away_Starter_Role")),
      home_role: text(value(row, index, "Home_Starter_Role")),
      away_expected_ip: numeric(value(row, index, "Away_Expected_IP")),
      home_expected_ip: numeric(value(row, index, "Home_Expected_IP")),
      starter_attack_runs: numeric(value(row, index, "Starter_Attack_Runs")),
      bullpen_continuation_runs: numeric(
        value(row, index, "Bullpen_Continuation_Runs"),
      ),
    });
    latest.set(identity, snapshotMs);
  }
  return result;
}

function parseAllocationOutcomes(
  rows: unknown[][],
): Map<string, AllocationOutcome> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const result = new Map<string, AllocationOutcome>();
  for (const row of data) {
    if (
      text(value(row, index, "Diagnostic_Status")) !== "FROZEN_PACKET_VERIFIED"
    )
      continue;
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const actualTotal = numeric(value(row, index, "Actual_Total"));
    if (!date || !gameId || actualTotal === null) continue;
    result.set(key(date, gameId), {
      date,
      game_id: gameId,
      actual_total: actualTotal,
    });
  }
  return result;
}

function parseStarterActuals(rows: unknown[][]): Map<string, StarterActual> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const result = new Map<string, StarterActual>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const side = text(value(row, index, "Team_Side"));
    if (!date || !gameId || (side !== "AWAY" && side !== "HOME")) continue;
    result.set(`${key(date, gameId)}|${side}`, {
      actual_ip: numeric(value(row, index, "Actual_IP")),
      status: text(value(row, index, "Diagnostic_Status")),
    });
  }
  return result;
}

function parseStarterIdentity(rows: unknown[][]): Map<string, StarterIdentity> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const result = new Map<string, StarterIdentity>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    if (!date || !gameId) continue;
    result.set(key(date, gameId), {
      away: text(value(row, index, "Away_Starter_Match_Status")),
      home: text(value(row, index, "Home_Starter_Match_Status")),
    });
  }
  return result;
}

/** Allocation eligibility is frozen packet + canonical final, not phase availability. */
export function buildPhaseCorpusInputs(
  packetRows: unknown[][],
  allocationRows: unknown[][],
  starterRows: unknown[][],
  outcomeRows: unknown[][],
): PhaseCorpusInput[] {
  const packets = parseFrozenPackets(packetRows);
  const allocations = parseAllocationOutcomes(allocationRows);
  const actuals = parseStarterActuals(starterRows);
  const identities = parseStarterIdentity(outcomeRows);
  const result: PhaseCorpusInput[] = [];
  for (const [identity, allocation] of allocations) {
    const packet = packets.get(identity);
    if (!packet) continue;
    const away = actuals.get(`${identity}|AWAY`);
    const home = actuals.get(`${identity}|HOME`);
    const starterIdentity = identities.get(identity);
    // Module 24's 448 legacy rows predate Diagnostic_Status but retain the
    // direct numeric MLB-boxscore Actual_IP value. Accept blank legacy status;
    // an explicit non-AVAILABLE status remains ineligible.
    const awayIpDirect =
      away?.actual_ip !== null &&
      away?.actual_ip !== undefined &&
      (!away.status || away.status === "AVAILABLE");
    const homeIpDirect =
      home?.actual_ip !== null &&
      home?.actual_ip !== undefined &&
      (!home.status || home.status === "AVAILABLE");
    result.push({
      ...packet,
      ...allocation,
      actual_away_ip: awayIpDirect ? away!.actual_ip : null,
      actual_home_ip: homeIpDirect ? home!.actual_ip : null,
      actual_away_ip_status: awayIpDirect
        ? "DIRECT_MLB_BOXSCORE"
        : "MISSING_ACTUAL_IP",
      actual_home_ip_status: homeIpDirect
        ? "DIRECT_MLB_BOXSCORE"
        : "MISSING_ACTUAL_IP",
      away_starter_match: starterIdentity?.away || "UNRESOLVED",
      home_starter_match: starterIdentity?.home || "UNRESOLVED",
    });
  }
  return result.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.game_id.localeCompare(right.game_id),
  );
}

interface PlayByPlayRunner {
  movement?: { end?: string };
  details?: {
    isScoringEvent?: boolean;
    responsiblePitcher?: { id?: number };
  };
}

interface PlayByPlayPlay {
  about?: { halfInning?: string };
  matchup?: { pitcher?: { id?: number } };
  runners?: PlayByPlayRunner[];
}

/**
 * Exact requested definition: count each run under the pitcher on the mound,
 * not the pitcher charged with the run. Inherited runners therefore belong to
 * the post-starter phase when they score against a reliever.
 */
export function reconstructPhaseFromPlayByPlay(
  payload: unknown,
  officialActualTotal: number,
): PhaseReconstruction {
  const plays =
    ((payload ?? {}) as { allPlays?: PlayByPlayPlay[] }).allPlays ?? [];
  if (plays.length === 0) {
    return {
      status: "PLAY_BY_PLAY_UNAVAILABLE",
      actual_starter_window_runs: null,
      actual_away_offense_starter_window_runs: null,
      actual_home_offense_starter_window_runs: null,
      actual_post_starter_runs: null,
      inherited_runner_crossings: 0,
      actual_total_from_pbp: null,
    };
  }
  const top = plays.find(
    (play) => text(play.about?.halfInning).toLowerCase() === "top",
  );
  const bottom = plays.find(
    (play) => text(play.about?.halfInning).toLowerCase() === "bottom",
  );
  const homeStarterId = numeric(top?.matchup?.pitcher?.id);
  const awayStarterId = numeric(bottom?.matchup?.pitcher?.id);
  if (homeStarterId === null || awayStarterId === null) {
    return {
      status: "STARTER_ON_MOUND_ID_UNRESOLVED",
      actual_starter_window_runs: null,
      actual_away_offense_starter_window_runs: null,
      actual_home_offense_starter_window_runs: null,
      actual_post_starter_runs: null,
      inherited_runner_crossings: 0,
      actual_total_from_pbp: null,
    };
  }
  let actualTotal = 0;
  let starterWindow = 0;
  let awayOffenseStarterWindow = 0;
  let homeOffenseStarterWindow = 0;
  let inheritedCrossings = 0;
  for (const play of plays) {
    const scoringRunners = (play.runners ?? []).filter(
      (runner) =>
        runner.details?.isScoringEvent === true ||
        runner.movement?.end === "score",
    );
    if (scoringRunners.length === 0) continue;
    const currentPitcherId = numeric(play.matchup?.pitcher?.id);
    if (currentPitcherId === null) {
      return {
        status: "SCORING_PITCHER_UNRESOLVED",
        actual_starter_window_runs: null,
        actual_away_offense_starter_window_runs: null,
        actual_home_offense_starter_window_runs: null,
        actual_post_starter_runs: null,
        inherited_runner_crossings: inheritedCrossings,
        actual_total_from_pbp: actualTotal,
      };
    }
    actualTotal += scoringRunners.length;
    if (
      currentPitcherId === homeStarterId ||
      currentPitcherId === awayStarterId
    ) {
      starterWindow += scoringRunners.length;
      const half = text(play.about?.halfInning).toLowerCase();
      if (half === "top" && currentPitcherId === homeStarterId)
        awayOffenseStarterWindow += scoringRunners.length;
      if (half === "bottom" && currentPitcherId === awayStarterId)
        homeOffenseStarterWindow += scoringRunners.length;
    }
    for (const runner of scoringRunners) {
      const responsible = numeric(runner.details?.responsiblePitcher?.id);
      if (responsible !== null && responsible !== currentPitcherId)
        inheritedCrossings++;
    }
  }
  if (actualTotal !== officialActualTotal) {
    return {
      status: "PLAY_BY_PLAY_TOTAL_MISMATCH",
      actual_starter_window_runs: null,
      actual_away_offense_starter_window_runs: null,
      actual_home_offense_starter_window_runs: null,
      actual_post_starter_runs: null,
      inherited_runner_crossings: inheritedCrossings,
      actual_total_from_pbp: actualTotal,
    };
  }
  return {
    status: "RECONSTRUCTED_VALIDATED",
    actual_starter_window_runs: starterWindow,
    actual_away_offense_starter_window_runs: awayOffenseStarterWindow,
    actual_home_offense_starter_window_runs: homeOffenseStarterWindow,
    actual_post_starter_runs: officialActualTotal - starterWindow,
    inherited_runner_crossings: inheritedCrossings,
    actual_total_from_pbp: actualTotal,
  };
}

export function classifyWorkloadState(
  awayExpected: number,
  homeExpected: number,
  awayActual: number,
  homeActual: number,
): { away: number; home: number; maximum: number; state: WorkloadState } {
  const away = Math.max(0, awayExpected - awayActual);
  const home = Math.max(0, homeExpected - homeActual);
  const maximum = Math.max(away, home);
  const state: WorkloadState =
    maximum === 0
      ? "REACHED_OR_EXCEEDED"
      : maximum >= MATERIAL_STARTER_SHORTFALL_IP
        ? "MATERIALLY_SHORT"
        : "MODERATELY_SHORT";
  return {
    away: round(away),
    home: round(home),
    maximum: round(maximum),
    state,
  };
}

function buildCoverageRecord(
  input: PhaseCorpusInput,
  gamePk: number | null,
  reconstruction: PhaseReconstruction,
): PhaseCoverageRecord {
  const expectedReady =
    input.away_expected_ip !== null && input.home_expected_ip !== null;
  const actualIpReady =
    input.actual_away_ip !== null && input.actual_home_ip !== null;
  const rolesReady = Boolean(input.away_role && input.home_role);
  const phasePredictionReady =
    input.starter_attack_runs !== null &&
    input.bullpen_continuation_runs !== null;
  const identityReady =
    input.away_starter_match === "MATCH" &&
    input.home_starter_match === "MATCH";
  const exactPhaseReady = reconstruction.status === "RECONSTRUCTED_VALIDATED";
  const usable =
    expectedReady &&
    actualIpReady &&
    rolesReady &&
    phasePredictionReady &&
    identityReady &&
    exactPhaseReady;
  const reasons = [
    !exactPhaseReady ? reconstruction.status : "",
    !identityReady
      ? `STARTER_IDENTITY_${input.away_starter_match}_${input.home_starter_match}`
      : "",
    !actualIpReady ? "ACTUAL_STARTER_IP_MISSING" : "",
    !expectedReady ? "FROZEN_EXPECTED_IP_MISSING" : "",
    !rolesReady ? "FROZEN_STARTER_ROLE_MISSING" : "",
    !phasePredictionReady ? "FROZEN_PHASE_PROJECTION_MISSING" : "",
  ].filter(Boolean);
  const workload =
    expectedReady && actualIpReady
      ? classifyWorkloadState(
          input.away_expected_ip!,
          input.home_expected_ip!,
          input.actual_away_ip!,
          input.actual_home_ip!,
        )
      : null;
  return {
    ...input,
    game_pk: gamePk,
    reconstruction,
    phase_row_usable: usable,
    exclusion_reason: reasons.join(";") || "",
    away_shortfall_ip: workload?.away ?? null,
    home_shortfall_ip: workload?.home ?? null,
    max_shortfall_ip: workload?.maximum ?? null,
    workload_state: workload?.state ?? null,
  };
}

export function evaluateCoverage(records: readonly PhaseCoverageRecord[]): {
  eligible_n: number;
  usable_n: number;
  coverage_pct: number;
  reconstructed_n: number;
  direct_n: number;
  excluded_by_reason: Map<string, number>;
  verdict: "PASS" | "INSUFFICIENT_PHASE_INSTRUMENTATION";
} {
  const eligible = records.length;
  const usable = records.filter((record) => record.phase_row_usable).length;
  const coveragePct = eligible === 0 ? 0 : round((usable / eligible) * 100, 2);
  const excluded = new Map<string, number>();
  for (const record of records) {
    if (record.phase_row_usable) continue;
    const reason = record.exclusion_reason || "UNSPECIFIED";
    excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  }
  return {
    eligible_n: eligible,
    usable_n: usable,
    coverage_pct: coveragePct,
    reconstructed_n: records.filter(
      (record) => record.reconstruction.status === "RECONSTRUCTED_VALIDATED",
    ).length,
    direct_n: 0,
    excluded_by_reason: excluded,
    verdict:
      usable >= MIN_PHASE_USABLE_GAMES && coveragePct >= MIN_PHASE_COVERAGE_PCT
        ? "PASS"
        : "INSUFFICIENT_PHASE_INSTRUMENTATION",
  };
}

export function buildLosoSlateEnvironments(
  inputs: readonly PhaseCorpusInput[],
): Map<string, SlateEnvironment> {
  const byDate = new Map<string, number[]>();
  for (const input of inputs) {
    const values = byDate.get(input.date) ?? [];
    values.push(input.actual_total);
    byDate.set(input.date, values);
  }
  const slateRates = new Map(
    [...byDate].map(([date, totals]) => [date, mean(totals)!]),
  );
  const result = new Map<string, SlateEnvironment>();
  for (const [date, slateRate] of slateRates) {
    const comparison = [...slateRates]
      .filter(([other]) => other !== date)
      .map(([, rate]) => rate);
    const comparisonMean = mean(comparison);
    const comparisonSd = sampleSd(comparison);
    const z =
      comparisonMean === null || comparisonSd === null || comparisonSd === 0
        ? null
        : (slateRate - comparisonMean) / comparisonSd;
    result.set(date, {
      date,
      slate_runs_per_game: round(slateRate),
      loso_corpus_n_slates: comparison.length,
      loso_mean_runs_per_game:
        comparisonMean === null ? null : round(comparisonMean),
      loso_sd_runs_per_game: comparisonSd === null ? null : round(comparisonSd),
      slate_z_loso: z === null ? null : round(z),
      bucket:
        z === null ? null : z >= 2 ? "EXTREME" : z >= 1 ? "HIGH" : "LOW_NORMAL",
    });
  }
  return result;
}

export function buildPhaseReplayRecords(
  coverage: readonly PhaseCoverageRecord[],
  environments: ReadonlyMap<string, SlateEnvironment>,
): PhaseReplayRecord[] {
  return coverage.flatMap((record) => {
    const environment = environments.get(record.date);
    if (
      !record.phase_row_usable ||
      !environment ||
      environment.bucket === null ||
      record.starter_attack_runs === null ||
      record.bullpen_continuation_runs === null ||
      record.reconstruction.actual_starter_window_runs === null ||
      record.reconstruction.actual_post_starter_runs === null
    )
      return [];
    const starterError =
      record.starter_attack_runs -
      record.reconstruction.actual_starter_window_runs;
    const bullpenError =
      record.bullpen_continuation_runs -
      record.reconstruction.actual_post_starter_runs;
    return [
      {
        ...record,
        starter_phase_error: starterError,
        bullpen_phase_error: bullpenError,
        paired_loss_difference: Math.abs(bullpenError) - Math.abs(starterError),
        environment,
      },
    ];
  });
}

export function phaseMetrics(rows: readonly PhaseReplayRecord[]): PhaseMetrics {
  const starterErrors = rows.map((row) => row.starter_phase_error);
  const bullpenErrors = rows.map((row) => row.bullpen_phase_error);
  const starterSquared = mean(starterErrors.map((error) => error ** 2));
  const bullpenSquared = mean(bullpenErrors.map((error) => error ** 2));
  return {
    n: rows.length,
    n_slates: new Set(rows.map((row) => row.date)).size,
    starter_bias: mean(starterErrors),
    starter_mae: mean(starterErrors.map(Math.abs)),
    starter_rmse: starterSquared === null ? null : Math.sqrt(starterSquared),
    bullpen_bias: mean(bullpenErrors),
    bullpen_mae: mean(bullpenErrors.map(Math.abs)),
    bullpen_rmse: bullpenSquared === null ? null : Math.sqrt(bullpenSquared),
    paired_loss_difference: mean(rows.map((row) => row.paired_loss_difference)),
  };
}

function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let current = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    current =
      (current + Math.imul(current ^ (current >>> 7), 61 | current)) ^ current;
    return ((current ^ (current >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values: number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const raw = (ordered.length - 1) * probability;
  const lower = Math.floor(raw);
  const upper = Math.ceil(raw);
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (raw - lower);
}

/** Paired uncertainty resamples complete slate-date blocks, never games. */
export function blockBootstrapPairedDifference(
  rows: readonly PhaseReplayRecord[],
  repetitions = 5_000,
  seed = 20260913,
): { lower: number; upper: number; method: string } | null {
  const dates = [...new Set(rows.map((row) => row.date))];
  if (rows.length < MIN_INTERPRETABLE_CELL_N || dates.length < 2) return null;
  const grouped = new Map(
    dates.map((date) => [date, rows.filter((row) => row.date === date)]),
  );
  const random = seededRandom(seed);
  const draws: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const sample: PhaseReplayRecord[] = [];
    for (let block = 0; block < dates.length; block++) {
      sample.push(...grouped.get(dates[Math.floor(random() * dates.length)]!)!);
    }
    const estimate = phaseMetrics(sample).paired_loss_difference;
    if (estimate !== null) draws.push(estimate);
  }
  return draws.length === 0
    ? null
    : {
        lower: round(quantile(draws, 0.025)),
        upper: round(quantile(draws, 0.975)),
        method: `SLATE_DATE_BLOCK_BOOTSTRAP_${repetitions}`,
      };
}

const ENVIRONMENTS: EnvironmentBucket[] = ["LOW_NORMAL", "HIGH", "EXTREME"];
const WORKLOADS: WorkloadState[] = [
  "REACHED_OR_EXCEEDED",
  "MODERATELY_SHORT",
  "MATERIALLY_SHORT",
];

export function buildPhaseAnalysisRows(
  rows: readonly PhaseReplayRecord[],
): PhaseAnalysisRow[] {
  const build = (
    subset: PhaseReplayRecord[],
    rowType: PhaseAnalysisRow["row_type"],
    environment: PhaseAnalysisRow["environment_bucket"],
    workload: PhaseAnalysisRow["workload_state"],
    seed: number,
  ): PhaseAnalysisRow => {
    const metrics = phaseMetrics(subset);
    const ci = blockBootstrapPairedDifference(subset, 5_000, seed);
    return {
      ...metrics,
      row_type: rowType,
      environment_bucket: environment,
      workload_state: workload,
      ci_lower: ci?.lower ?? null,
      ci_upper: ci?.upper ?? null,
      uncertainty_method:
        ci?.method ??
        (metrics.n_slates < 2
          ? "CI_UNAVAILABLE_SINGLE_OR_ZERO_SLATE"
          : "CI_UNAVAILABLE_INSUFFICIENT_CELL"),
      cell_status:
        rowType === "INTERACTION_CELL" && metrics.n < MIN_INTERPRETABLE_CELL_N
          ? "INSUFFICIENT_CELL"
          : "INTERPRETABLE",
    };
  };
  const output: PhaseAnalysisRow[] = [
    build([...rows], "OVERALL", "ALL", "ALL", 1),
  ];
  for (const environment of ENVIRONMENTS) {
    output.push(
      build(
        rows.filter((row) => row.environment.bucket === environment),
        "ENVIRONMENT_MAIN_EFFECT",
        environment,
        "ALL",
        10 + ENVIRONMENTS.indexOf(environment),
      ),
    );
  }
  for (const workload of WORKLOADS) {
    output.push(
      build(
        rows.filter((row) => row.workload_state === workload),
        "WORKLOAD_MAIN_EFFECT",
        "ALL",
        workload,
        20 + WORKLOADS.indexOf(workload),
      ),
    );
  }
  for (const environment of ENVIRONMENTS) {
    for (const workload of WORKLOADS) {
      output.push(
        build(
          rows.filter(
            (row) =>
              row.environment.bucket === environment &&
              row.workload_state === workload,
          ),
          "INTERACTION_CELL",
          environment,
          workload,
          100 +
            ENVIRONMENTS.indexOf(environment) * 10 +
            WORKLOADS.indexOf(workload),
        ),
      );
    }
  }
  return output;
}

function analysisCell(
  rows: readonly PhaseAnalysisRow[],
  environment: EnvironmentBucket | "ALL",
  workload: WorkloadState | "ALL",
): PhaseAnalysisRow | undefined {
  return rows.find(
    (row) =>
      row.environment_bucket === environment && row.workload_state === workload,
  );
}

/** Conservative, pre-declared mapping to the user's exact A/B/C/D/E set. */
export function selectPrimaryVerdict(
  coverageVerdict: "PASS" | "INSUFFICIENT_PHASE_INSTRUMENTATION",
  rows: readonly PhaseAnalysisRow[],
): PhaseVerdict {
  if (coverageVerdict !== "PASS") return "INSUFFICIENT_PHASE_INSTRUMENTATION";
  const material = analysisCell(rows, "ALL", "MATERIALLY_SHORT");
  const lowReached = analysisCell(rows, "LOW_NORMAL", "REACHED_OR_EXCEEDED");
  const lowModerate = analysisCell(rows, "LOW_NORMAL", "MODERATELY_SHORT");
  const lowMaterial = analysisCell(rows, "LOW_NORMAL", "MATERIALLY_SHORT");
  const overall = analysisCell(rows, "ALL", "ALL");
  const materialSupported = Boolean(
    material &&
    material.n >= MIN_INTERPRETABLE_CELL_N &&
    material.paired_loss_difference !== null &&
    material.paired_loss_difference > 0 &&
    material.ci_lower !== null &&
    material.ci_lower > 0,
  );
  const lowEnvironmentInteractionSupported = Boolean(
    lowReached &&
    lowModerate &&
    lowMaterial &&
    [lowReached, lowModerate, lowMaterial].every(
      (row) => row.n >= MIN_INTERPRETABLE_CELL_N,
    ) &&
    lowMaterial.paired_loss_difference !== null &&
    lowReached.paired_loss_difference !== null &&
    lowModerate.paired_loss_difference !== null &&
    lowMaterial.paired_loss_difference > lowReached.paired_loss_difference &&
    lowMaterial.paired_loss_difference > lowModerate.paired_loss_difference &&
    lowMaterial.ci_lower !== null &&
    lowMaterial.ci_lower > 0,
  );
  if (materialSupported && lowEnvironmentInteractionSupported) {
    return "BULLPEN_STATE_HYPOTHESIS_SUPPORTED";
  }
  if (
    overall &&
    overall.paired_loss_difference !== null &&
    overall.paired_loss_difference > 0 &&
    overall.ci_lower !== null &&
    overall.ci_lower > 0
  )
    return "GENERIC_BULLPEN_CONTINUATION_DEFECT";
  const lowNormal = analysisCell(rows, "LOW_NORMAL", "ALL");
  const high = analysisCell(rows, "HIGH", "ALL");
  const extreme = analysisCell(rows, "EXTREME", "ALL");
  const highEnvironmentExcess = [high, extreme].some(
    (row) =>
      row &&
      row.n >= MIN_INTERPRETABLE_CELL_N &&
      row.paired_loss_difference !== null &&
      row.paired_loss_difference > 0,
  );
  if (
    lowNormal &&
    lowNormal.n >= MIN_INTERPRETABLE_CELL_N &&
    lowNormal.paired_loss_difference !== null &&
    lowNormal.paired_loss_difference <= 0 &&
    highEnvironmentExcess &&
    !materialSupported
  )
    return "EXTREME_SLATE_EFFECT_DOMINANT";
  return "INCONCLUSIVE_SAMPLE_OR_EFFECT";
}

function coverageRow(
  record: PhaseCoverageRecord,
  timestamp: string,
): unknown[] {
  const exact = record.reconstruction.status === "RECONSTRUCTED_VALIDATED";
  const inherited = exact
    ? record.reconstruction.inherited_runner_crossings > 0
      ? `PRESENT_RESOLVED_BY_CURRENT_PITCHER:${record.reconstruction.inherited_runner_crossings}`
      : "NONE_OBSERVED"
    : "UNRESOLVED";
  return [
    record.date,
    record.game_id,
    "TRUE",
    record.away_role,
    record.home_role,
    exact ? "RECONSTRUCTED_VALIDATED" : record.reconstruction.status,
    exact ? "MLB_STATSAPI_PLAY_BY_PLAY_CURRENT_PITCHER" : "UNAVAILABLE",
    exact ? "RECONSTRUCTED_VALIDATED" : record.reconstruction.status,
    exact ? "OFFICIAL_TOTAL_MINUS_RECONSTRUCTED_STARTER_WINDOW" : "UNAVAILABLE",
    record.actual_away_ip_status,
    record.actual_home_ip_status,
    record.away_expected_ip !== null && record.home_expected_ip !== null
      ? "DIRECT_FROZEN_PACKET"
      : "MISSING",
    "TRUE",
    "STARTERS=FIRST_TOP_AND_BOTTOM_PITCHER_ID; RUNS=SCORING_RUNNERS_GROUPED_BY_PLAY_MATCHUP_PITCHER_ID",
    inherited,
    record.phase_row_usable ? "TRUE" : "FALSE",
    record.exclusion_reason,
    record.game_pk ?? "",
    record.snapshot_ts,
    `${record.away_starter_match}|${record.home_starter_match}`,
    record.reconstruction.actual_starter_window_runs ?? "",
    record.reconstruction.actual_away_offense_starter_window_runs ?? "",
    record.reconstruction.actual_home_offense_starter_window_runs ?? "",
    record.reconstruction.actual_post_starter_runs ?? "",
    record.actual_total,
    record.actual_away_ip ?? "",
    record.actual_home_ip ?? "",
    record.away_expected_ip ?? "",
    record.home_expected_ip ?? "",
    record.starter_attack_runs ?? "",
    record.bullpen_continuation_runs ?? "",
    record.away_shortfall_ip ?? "",
    record.home_shortfall_ip ?? "",
    record.max_shortfall_ip ?? "",
    record.workload_state ?? "",
    PHASE_INSTRUMENTATION_VERSION,
    timestamp,
  ];
}

function coverageSummaryRows(
  coverage: ReturnType<typeof evaluateCoverage>,
  records: readonly PhaseCoverageRecord[],
  timestamp: string,
): unknown[][] {
  const inheritedGames = records.filter(
    (record) => record.reconstruction.inherited_runner_crossings > 0,
  ).length;
  const inheritedCrossings = records.reduce(
    (sum, record) => sum + record.reconstruction.inherited_runner_crossings,
    0,
  );
  const actualAwayIpDirect = records.filter(
    (record) => record.actual_away_ip_status === "DIRECT_MLB_BOXSCORE",
  ).length;
  const actualHomeIpDirect = records.filter(
    (record) => record.actual_home_ip_status === "DIRECT_MLB_BOXSCORE",
  ).length;
  const frozenExpectedIpDirect = records.filter(
    (record) =>
      record.away_expected_ip !== null && record.home_expected_ip !== null,
  ).length;
  const frozenRolesDirect = records.filter((record) =>
    Boolean(record.away_role && record.home_role),
  ).length;
  const exclusions =
    [...coverage.excluded_by_reason]
      .map(([reason, count]) => `${reason}=${count}`)
      .join(";") || "NONE";
  return [
    [
      "Allocation_Eligible_N",
      coverage.eligible_n,
      "OBSERVED",
      "ALLOCATION_SETTLEMENT_DIAGNOSTICS + FROZEN_PACKET",
      "Frozen packet joined to canonical final",
      timestamp,
    ],
    [
      "Direct_Actual_Starter_Window_Runs_N",
      coverage.direct_n,
      "NONE",
      "NO_DIRECT_AGGREGATE_FIELD",
      "Pitcher R/ER is explicitly rejected as an on-mound phase substitute",
      timestamp,
    ],
    [
      "Direct_Actual_Post_Starter_Runs_N",
      coverage.direct_n,
      "NONE",
      "NO_DIRECT_AGGREGATE_FIELD",
      "Requires exact starter-window reconstruction first",
      timestamp,
    ],
    [
      "Deterministically_Reconstructed_N",
      coverage.reconstructed_n,
      "RECONSTRUCTED",
      "MLB_STATSAPI_PLAY_BY_PLAY_CURRENT_PITCHER",
      "Play-by-play scoring total must reconcile to official total",
      timestamp,
    ],
    [
      "Direct_Actual_Away_Starter_IP_N",
      actualAwayIpDirect,
      "OBSERVED",
      "STARTER_OUTCOME_DIAGNOSTICS.Actual_IP",
      "MLB boxscore outs / 3",
      timestamp,
    ],
    [
      "Direct_Actual_Home_Starter_IP_N",
      actualHomeIpDirect,
      "OBSERVED",
      "STARTER_OUTCOME_DIAGNOSTICS.Actual_IP",
      "MLB boxscore outs / 3",
      timestamp,
    ],
    [
      "Direct_Frozen_Expected_IP_Both_Sides_N",
      frozenExpectedIpDirect,
      "OBSERVED",
      "PREGAME_PACKET_HISTORY",
      "Latest legitimate immutable FROZEN_PREGAME packet",
      timestamp,
    ],
    [
      "Direct_Actual_Total_N",
      records.length,
      "OBSERVED",
      "ALLOCATION_SETTLEMENT_DIAGNOSTICS.Actual_Total",
      "Canonical final joined to frozen packet",
      timestamp,
    ],
    [
      "Direct_Frozen_Starter_Roles_Both_Sides_N",
      frozenRolesDirect,
      "OBSERVED",
      "PREGAME_PACKET_HISTORY",
      "Starter/opener/bulk role retained from frozen packet",
      timestamp,
    ],
    [
      "Phase_Usable_N",
      coverage.usable_n,
      coverage.verdict,
      "BULLPEN_PHASE_COVERAGE_V1",
      "Requires exact phase runs, actual/frozen IP, roles, phase projections, and matched starters",
      timestamp,
    ],
    [
      "Coverage_Pct",
      coverage.coverage_pct,
      coverage.verdict,
      "Phase_Usable_N / Allocation_Eligible_N",
      `Floor=${MIN_PHASE_COVERAGE_PCT}% and N>=${MIN_PHASE_USABLE_GAMES}`,
      timestamp,
    ],
    [
      "Inherited_Runner_Ambiguity_Games",
      inheritedGames,
      "RESOLVED_BY_DEFINITION",
      "PBP responsiblePitcher versus matchup.pitcher",
      "Runs remain assigned to the pitcher actually on the mound",
      timestamp,
    ],
    [
      "Inherited_Runner_Crossings",
      inheritedCrossings,
      "RESOLVED_BY_DEFINITION",
      "PBP responsiblePitcher versus matchup.pitcher",
      "Demonstrates why pitcher-charged R cannot define the phase",
      timestamp,
    ],
    [
      "Excluded_N",
      coverage.eligible_n - coverage.usable_n,
      "EXPLICIT",
      "Coverage gate",
      exclusions,
      timestamp,
    ],
    [
      "Estimated_Recoverable_N_After_Identity_Repair",
      coverage.reconstructed_n,
      "DIAGNOSTIC",
      "Exact PBP reconstruction count",
      "Identity-mismatched/unresolved rows remain excluded until a legitimate source repair exists",
      timestamp,
    ],
    [
      "Instrumentation_Verdict",
      coverage.verdict,
      coverage.verdict,
      PHASE_INSTRUMENTATION_VERSION,
      "Inferential phase analysis is prohibited unless both coverage floors pass",
      timestamp,
    ],
  ];
}

function replayRow(record: PhaseReplayRecord, timestamp: string): unknown[] {
  return [
    record.date,
    record.game_id,
    record.snapshot_ts,
    record.actual_total,
    record.starter_attack_runs ?? "",
    record.reconstruction.actual_starter_window_runs ?? "",
    round(record.starter_phase_error),
    round(Math.abs(record.starter_phase_error)),
    record.bullpen_continuation_runs ?? "",
    record.reconstruction.actual_post_starter_runs ?? "",
    round(record.bullpen_phase_error),
    round(Math.abs(record.bullpen_phase_error)),
    round(record.paired_loss_difference),
    record.actual_away_ip ?? "",
    record.actual_home_ip ?? "",
    record.away_expected_ip ?? "",
    record.home_expected_ip ?? "",
    record.away_shortfall_ip ?? "",
    record.home_shortfall_ip ?? "",
    record.max_shortfall_ip ?? "",
    record.workload_state ?? "",
    record.environment.slate_runs_per_game,
    record.environment.loso_corpus_n_slates,
    record.environment.loso_mean_runs_per_game ?? "",
    record.environment.loso_sd_runs_per_game ?? "",
    record.environment.slate_z_loso ?? "",
    record.environment.bucket ?? "",
    record.reconstruction.inherited_runner_crossings > 0
      ? `PRESENT_RESOLVED_BY_CURRENT_PITCHER:${record.reconstruction.inherited_runner_crossings}`
      : "NONE_OBSERVED",
    "MLB_STATSAPI_PLAY_BY_PLAY_CURRENT_PITCHER",
    "EXACT_PHASE_RECONSTRUCTION_RESEARCH_ONLY",
    timestamp,
  ];
}

function consequence(verdict: PhaseVerdict): string {
  if (verdict === "BULLPEN_STATE_HYPOTHESIS_SUPPORTED")
    return "STATE_BASED_BULLPEN_ENGINE_SUPPORTED_RESEARCH_PRIORITY_NO_PRODUCTION_PROMOTION";
  if (verdict === "GENERIC_BULLPEN_CONTINUATION_DEFECT")
    return "PRIORITIZE_GENERIC_BULLPEN_CONTINUATION_CALIBRATION";
  if (verdict === "EXTREME_SLATE_EFFECT_DOMINANT")
    return "DO_NOT_ELEVATE_BULLPEN_STATE_ARCHITECTURE";
  if (verdict === "INSUFFICIENT_PHASE_INSTRUMENTATION")
    return "DATA_INSTRUMENTATION_REPAIR_REQUIRED_BEFORE_MODEL_INTERPRETATION";
  return "RETAIN_HYPOTHESIS_UNRESOLVED";
}

function analysisRowsForSheet(
  rows: readonly PhaseAnalysisRow[],
  verdict: PhaseVerdict,
  timestamp: string,
): unknown[][] {
  const underpowered = rows.filter(
    (row) =>
      row.row_type === "INTERACTION_CELL" &&
      row.cell_status === "INSUFFICIENT_CELL",
  );
  const interactionStatus =
    underpowered.length > 0
      ? "INTERACTION_UNDERPOWERED"
      : "MAIN_EFFECT_EVIDENCE_AVAILABLE";
  const notes =
    "Slate scoring environment is standardized using leave-one-slate-out corpus parameters so the evaluated slate does not contribute to its own benchmark.";
  const metricRows = rows.map((row) => [
    row.row_type,
    row.environment_bucket,
    row.workload_state,
    row.n,
    row.n_slates,
    row.starter_bias === null ? "" : round(row.starter_bias),
    row.starter_mae === null ? "" : round(row.starter_mae),
    row.starter_rmse === null ? "" : round(row.starter_rmse),
    row.bullpen_bias === null ? "" : round(row.bullpen_bias),
    row.bullpen_mae === null ? "" : round(row.bullpen_mae),
    row.bullpen_rmse === null ? "" : round(row.bullpen_rmse),
    row.paired_loss_difference === null
      ? ""
      : round(row.paired_loss_difference),
    row.ci_lower ?? "",
    row.ci_upper ?? "",
    row.uncertainty_method,
    row.cell_status,
    row.row_type === "INTERACTION_CELL" ? "" : "MAIN_EFFECT_EVIDENCE_AVAILABLE",
    row.row_type === "INTERACTION_CELL"
      ? row.cell_status === "INSUFFICIENT_CELL"
        ? "INTERACTION_UNDERPOWERED"
        : "INTERPRETABLE"
      : "",
    verdict,
    consequence(verdict),
    row.row_type === "OVERALL"
      ? notes
      : row.cell_status === "INSUFFICIENT_CELL"
        ? "DESCRIPTIVE_ONLY_NO_EFFECT_INTERPRETATION"
        : "",
    timestamp,
  ]);
  metricRows.push([
    "VERDICT",
    "ALL",
    "ALL",
    rows[0]?.n ?? 0,
    rows[0]?.n_slates ?? 0,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "INTERPRETABLE",
    "MAIN_EFFECT_EVIDENCE_AVAILABLE",
    interactionStatus,
    verdict,
    consequence(verdict),
    `Underpowered interaction cells: ${underpowered.map((row) => `${row.environment_bucket} x ${row.workload_state} (N=${row.n})`).join("; ") || "NONE"}. No conclusion relies only on an underpowered cell.`,
    timestamp,
  ]);
  return metricRows;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Frostline-Bullpen-Phase/1.0" },
    });
    if (!response.ok) throw new Error(`MLB API ${response.status} for ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

const TEAM_ALIASES = new Map([
  ["TB", "TBR"],
  ["TBR", "TBR"],
  ["CWS", "CHW"],
  ["CHW", "CHW"],
  ["AZ", "ARI"],
  ["ARI", "ARI"],
  ["ATH", "OAK"],
  ["OAK", "OAK"],
  ["KC", "KCR"],
  ["KCR", "KCR"],
  ["SD", "SDP"],
  ["SDP", "SDP"],
  ["SF", "SFG"],
  ["SFG", "SFG"],
  ["WSH", "WSN"],
  ["WSN", "WSN"],
]);

function canonicalTeam(value: unknown): string {
  const normalized = text(value).toUpperCase();
  return TEAM_ALIASES.get(normalized) ?? normalized;
}

interface ScheduleGame {
  gamePk?: number;
  gameNumber?: number;
  teams?: {
    away?: { team?: { abbreviation?: string } };
    home?: { team?: { abbreviation?: string } };
  };
}

export function scheduleGamePkMap(
  date: string,
  payload: unknown,
): Map<string, number> {
  const games =
    (
      (payload ?? {}) as { dates?: Array<{ games?: ScheduleGame[] }> }
    ).dates?.flatMap((entry) => entry.games ?? []) ?? [];
  const pairCounts = new Map<string, number>();
  for (const game of games) {
    const pair = `${canonicalTeam(game.teams?.away?.team?.abbreviation)}_${canonicalTeam(game.teams?.home?.team?.abbreviation)}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const game of games) {
    if (!game.gamePk) continue;
    const away = canonicalTeam(game.teams?.away?.team?.abbreviation);
    const home = canonicalTeam(game.teams?.home?.team?.abbreviation);
    const compact = date.replaceAll("-", "");
    const base = `${compact}_${away}_${home}`;
    const pair = `${away}_${home}`;
    if ((pairCounts.get(pair) ?? 0) === 1) result.set(base, game.gamePk);
    else if (game.gameNumber)
      result.set(`${base}__G${game.gameNumber}`, game.gamePk);
  }
  return result;
}

async function resolveGamePks(
  inputs: readonly PhaseCorpusInput[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const date of [...new Set(inputs.map((input) => input.date))].sort()) {
    const payload = await fetchJson(
      `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=team`,
    );
    for (const [gameId, gamePk] of scheduleGamePkMap(date, payload))
      result.set(gameId, gamePk);
  }
  return result;
}

interface CachedReconstruction {
  game_pk: number;
  reconstruction: PhaseReconstruction;
}

function parseCachedReconstruction(
  rows: unknown[][],
): Map<string, CachedReconstruction> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const result = new Map<string, CachedReconstruction>();
  for (const row of data) {
    if (
      text(value(row, index, "Instrumentation_Version")) !==
      PHASE_INSTRUMENTATION_VERSION
    )
      continue;
    if (
      text(value(row, index, "Actual_Starter_Window_Runs_Status")) !==
      "RECONSTRUCTED_VALIDATED"
    )
      continue;
    const gameId = text(value(row, index, "Game_ID"));
    const gamePk = numeric(value(row, index, "Game_PK"));
    const starter = numeric(value(row, index, "Actual_Starter_Window_Runs"));
    const awayStarter = numeric(value(row, index, "Actual_Away_Offense_Starter_Window_Runs"));
    const homeStarter = numeric(value(row, index, "Actual_Home_Offense_Starter_Window_Runs"));
    const post = numeric(value(row, index, "Actual_Post_Starter_Runs"));
    const actualTotal = numeric(value(row, index, "Actual_Total_Runs"));
    if (
      !gameId ||
      gamePk === null ||
      starter === null ||
      awayStarter === null ||
      homeStarter === null ||
      post === null ||
      actualTotal === null
    )
      continue;
    const inheritedText = text(
      value(row, index, "Inherited_Runner_Ambiguity_Status"),
    );
    const inherited = numeric(inheritedText.split(":")[1]) ?? 0;
    result.set(gameId, {
      game_pk: gamePk,
      reconstruction: {
        status: "RECONSTRUCTED_VALIDATED",
        actual_starter_window_runs: starter,
        actual_away_offense_starter_window_runs: awayStarter,
        actual_home_offense_starter_window_runs: homeStarter,
        actual_post_starter_runs: post,
        inherited_runner_crossings: inherited,
        actual_total_from_pbp: actualTotal,
      },
    });
  }
  return result;
}

async function reconstructMissing(
  inputs: readonly PhaseCorpusInput[],
  cached: ReadonlyMap<string, CachedReconstruction>,
  warnings: string[],
): Promise<PhaseCoverageRecord[]> {
  const pks = await resolveGamePks(inputs);
  const records: PhaseCoverageRecord[] = [];
  for (let start = 0; start < inputs.length; start += 8) {
    const batch = inputs.slice(start, start + 8);
    records.push(
      ...(await Promise.all(
        batch.map(async (input) => {
          const cachedRecord = cached.get(input.game_id);
          if (
            cachedRecord &&
            cachedRecord.reconstruction.actual_total_from_pbp ===
              input.actual_total
          ) {
            return buildCoverageRecord(
              input,
              cachedRecord.game_pk,
              cachedRecord.reconstruction,
            );
          }
          const gamePk = pks.get(input.game_id) ?? null;
          if (gamePk === null) {
            warnings.push(`BULLPEN_PHASE_GAME_PK_UNRESOLVED: ${input.game_id}`);
            return buildCoverageRecord(input, null, {
              status: "PLAY_BY_PLAY_UNAVAILABLE",
              actual_starter_window_runs: null,
              actual_away_offense_starter_window_runs: null,
              actual_home_offense_starter_window_runs: null,
              actual_post_starter_runs: null,
              inherited_runner_crossings: 0,
              actual_total_from_pbp: null,
            });
          }
          try {
            const payload = await fetchJson(
              `${MLB_API}/game/${gamePk}/playByPlay`,
            );
            return buildCoverageRecord(
              input,
              gamePk,
              reconstructPhaseFromPlayByPlay(payload, input.actual_total),
            );
          } catch (error: unknown) {
            warnings.push(
              `BULLPEN_PHASE_PBP_UNAVAILABLE: ${input.game_id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return buildCoverageRecord(input, gamePk, {
              status: "PLAY_BY_PLAY_UNAVAILABLE",
              actual_starter_window_runs: null,
              actual_away_offense_starter_window_runs: null,
              actual_home_offense_starter_window_runs: null,
              actual_post_starter_runs: null,
              inherited_runner_crossings: 0,
              actual_total_from_pbp: null,
            });
          }
        }),
      )),
    );
  }
  return records;
}

function isMissingSheetError(error: unknown): boolean {
  return /unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function readOptional(
  workbookId: string,
  range: string,
  warnings: string[],
): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    warnings.push(`MISSING_BULLPEN_PHASE_SOURCE: ${range}`);
    return [];
  }
}

async function ensureSheets(
  workbookId: string,
  sheets: Array<{ name: string; columns: number }>,
): Promise<void> {
  const existing = new Set(
    (await getSpreadsheetSheetProperties(workbookId)).map(
      (sheet) => sheet.title,
    ),
  );
  for (const sheet of sheets) {
    if (!existing.has(sheet.name)) {
      await addSheet(workbookId, sheet.name);
      existing.add(sheet.name);
    }
  }
  await Promise.all(
    sheets.map((sheet) =>
      expandSheetColumns(workbookId, sheet.name, sheet.columns),
    ),
  );
}

export async function runBullpenPhaseAnalysis(
  options: { workbookId?: string } = {},
): Promise<BullpenPhaseAnalysisResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const timestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packets, allocations, starters, outcomes, priorCoverage] =
      await Promise.all([
        readOptional(
          workbookId,
          `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`,
          warnings,
        ),
        readOptional(
          workbookId,
          "ALLOCATION_SETTLEMENT_DIAGNOSTICS!A1:AB10000",
          warnings,
        ),
        readOptional(
          workbookId,
          "STARTER_OUTCOME_DIAGNOSTICS!A1:BO10000",
          warnings,
        ),
        readOptional(workbookId, "SHADOW_OUTCOMES!A1:AW10000", warnings),
        readOptional(
          workbookId,
          `${BULLPEN_PHASE_COVERAGE_SHEET}!A1:AZ10000`,
          warnings,
        ),
      ]);
    const inputs = buildPhaseCorpusInputs(
      packets,
      allocations,
      starters,
      outcomes,
    );
    const coverageRecords = await reconstructMissing(
      inputs,
      parseCachedReconstruction(priorCoverage),
      warnings,
    );
    const coverage = evaluateCoverage(coverageRecords);

    await ensureSheets(workbookId, [
      {
        name: BULLPEN_PHASE_COVERAGE_SHEET,
        columns: BULLPEN_PHASE_COVERAGE_HEADERS.length,
      },
      {
        name: BULLPEN_PHASE_COVERAGE_SUMMARY_SHEET,
        columns: BULLPEN_PHASE_COVERAGE_SUMMARY_HEADERS.length,
      },
    ]);
    await Promise.all([
      clearRange(workbookId, `${BULLPEN_PHASE_COVERAGE_SHEET}!A1:AZ10000`),
      clearRange(workbookId, `${BULLPEN_PHASE_COVERAGE_SUMMARY_SHEET}!A1:F100`),
    ]);
    await Promise.all([
      writeRange(workbookId, `${BULLPEN_PHASE_COVERAGE_SHEET}!A1`, [
        Array.from(BULLPEN_PHASE_COVERAGE_HEADERS),
        ...coverageRecords.map((record) => coverageRow(record, timestamp)),
      ]),
      writeRange(workbookId, `${BULLPEN_PHASE_COVERAGE_SUMMARY_SHEET}!A1`, [
        Array.from(BULLPEN_PHASE_COVERAGE_SUMMARY_HEADERS),
        ...coverageSummaryRows(coverage, coverageRecords, timestamp),
      ]),
    ]);

    if (coverage.verdict !== "PASS") {
      const existing = new Set(
        (await getSpreadsheetSheetProperties(workbookId)).map(
          (sheet) => sheet.title,
        ),
      );
      await Promise.all([
        existing.has(BULLPEN_PHASE_REPLAY_SHEET)
          ? clearRange(workbookId, `${BULLPEN_PHASE_REPLAY_SHEET}!A1:AE10000`)
          : Promise.resolve(),
        existing.has(BULLPEN_PHASE_ANALYSIS_SHEET)
          ? clearRange(workbookId, `${BULLPEN_PHASE_ANALYSIS_SHEET}!A1:V100`)
          : Promise.resolve(),
      ]);
      logger.warn(
        {
          eligible: coverage.eligible_n,
          usable: coverage.usable_n,
          coverage_pct: coverage.coverage_pct,
        },
        "MODULE_32: phase instrumentation gate stopped analysis",
      );
      return {
        status: "success",
        analysis_timestamp_utc: timestamp,
        allocation_eligible_games: coverage.eligible_n,
        direct_phase_games: coverage.direct_n,
        reconstructed_phase_games: coverage.reconstructed_n,
        usable_phase_games: coverage.usable_n,
        coverage_pct: coverage.coverage_pct,
        instrumentation_verdict: coverage.verdict,
        primary_verdict: "INSUFFICIENT_PHASE_INSTRUMENTATION",
        interaction_status: "ANALYSIS_STOPPED",
        coverage_rows_written: coverageRecords.length,
        replay_rows_written: 0,
        analysis_rows_written: 0,
        warnings,
        errors,
      };
    }

    const environments = buildLosoSlateEnvironments(inputs);
    const replay = buildPhaseReplayRecords(coverageRecords, environments);
    const analysis = buildPhaseAnalysisRows(replay);
    const verdict = selectPrimaryVerdict(coverage.verdict, analysis);
    const underpowered = analysis.some(
      (row) =>
        row.row_type === "INTERACTION_CELL" &&
        row.cell_status === "INSUFFICIENT_CELL",
    );
    const interactionStatus = underpowered
      ? "INTERACTION_UNDERPOWERED"
      : "MAIN_EFFECT_EVIDENCE_AVAILABLE";
    await ensureSheets(workbookId, [
      {
        name: BULLPEN_PHASE_REPLAY_SHEET,
        columns: BULLPEN_PHASE_REPLAY_HEADERS.length,
      },
      {
        name: BULLPEN_PHASE_ANALYSIS_SHEET,
        columns: BULLPEN_PHASE_ANALYSIS_HEADERS.length,
      },
    ]);
    await Promise.all([
      clearRange(workbookId, `${BULLPEN_PHASE_REPLAY_SHEET}!A1:AE10000`),
      clearRange(workbookId, `${BULLPEN_PHASE_ANALYSIS_SHEET}!A1:V100`),
    ]);
    await Promise.all([
      writeRange(workbookId, `${BULLPEN_PHASE_REPLAY_SHEET}!A1`, [
        Array.from(BULLPEN_PHASE_REPLAY_HEADERS),
        ...replay.map((record) => replayRow(record, timestamp)),
      ]),
      writeRange(workbookId, `${BULLPEN_PHASE_ANALYSIS_SHEET}!A1`, [
        Array.from(BULLPEN_PHASE_ANALYSIS_HEADERS),
        ...analysisRowsForSheet(analysis, verdict, timestamp),
      ]),
    ]);
    logger.info(
      {
        eligible: coverage.eligible_n,
        usable: coverage.usable_n,
        coverage_pct: coverage.coverage_pct,
        verdict,
      },
      "MODULE_32: bullpen phase coverage and analysis written (research-only)",
    );
    return {
      status: "success",
      analysis_timestamp_utc: timestamp,
      allocation_eligible_games: coverage.eligible_n,
      direct_phase_games: coverage.direct_n,
      reconstructed_phase_games: coverage.reconstructed_n,
      usable_phase_games: coverage.usable_n,
      coverage_pct: coverage.coverage_pct,
      instrumentation_verdict: coverage.verdict,
      primary_verdict: verdict,
      interaction_status: interactionStatus,
      coverage_rows_written: coverageRecords.length,
      replay_rows_written: replay.length,
      analysis_rows_written: analysis.length + 1,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_32: bullpen phase analysis failed");
    return {
      status: "failure",
      analysis_timestamp_utc: timestamp,
      allocation_eligible_games: 0,
      direct_phase_games: 0,
      reconstructed_phase_games: 0,
      usable_phase_games: 0,
      coverage_pct: 0,
      instrumentation_verdict: "INSUFFICIENT_PHASE_INSTRUMENTATION",
      primary_verdict: "INSUFFICIENT_PHASE_INSTRUMENTATION",
      interaction_status: "ANALYSIS_STOPPED",
      coverage_rows_written: 0,
      replay_rows_written: 0,
      analysis_rows_written: 0,
      warnings,
      errors,
    };
  }
}

export const BULLPEN_PHASE_METHOD_STATEMENT =
  "Slate scoring environment is standardized using leave-one-slate-out corpus parameters so the evaluated slate does not contribute to its own benchmark.";

export const BULLPEN_PHASE_DEFINITION_STATEMENT =
  "Actual_Starter_Window_Runs counts runs scored while either designated matched starter/opener/bulk pitcher is actually on the mound; inherited runners scoring after removal belong to Actual_Post_Starter_Runs.";
