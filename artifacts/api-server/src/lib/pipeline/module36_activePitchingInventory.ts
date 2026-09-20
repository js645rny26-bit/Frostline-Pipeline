/**
 * Module 36: Active Pitching Inventory V1.
 *
 * Prospective, price-blind, research-only pitching-chain inventory. It resolves
 * who may absorb innings before assigning the unidentified remainder to the
 * generic bullpen. Nothing in Module 09, the board, market, or authorization
 * imports this module.
 */

import { createHash } from "node:crypto";
import {
  addSheet,
  clearRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type { BullpenResult, RelieverStat } from "./module04b_bullpenUsage.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { StatcastPitcherExpectedStats } from "./module02f_statcastPitcherExpected.js";
import type { ActiveRosterPitcher } from "./module02c_batterSeasonStats.js";
import {
  computeTeamBullpenQuality,
  resolveStarterQuality,
  type GameSummaryRow,
} from "./module09_recalculation.js";
import {
  estimateStarterWorkload,
  type SWEAppearance,
  type SWEGameState,
} from "./module02i_starterWorkloadEstimator.js";
import type { PublicationProtection } from "./module00_scopedPublication.js";

export const ACTIVE_PITCHING_INVENTORY_SHEET = "ACTIVE_PITCHING_INVENTORY_V1";
export const ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET = "ACTIVE_PITCHING_INVENTORY_SUMMARY_V1";
export const ACTIVE_PITCHING_INVENTORY_REPLAY_SHEET = "ACTIVE_PITCHING_INVENTORY_REPLAY_V1";
export const ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_SHEET = "ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_V1";
export const ACTIVE_PITCHING_INVENTORY_VERSION = "API_V1_2026-09-19";
export const ACTIVE_PITCHING_INVENTORY_ACTIVE_INPUT = "NO" as const;
export const ACTIVE_PITCHING_INVENTORY_MAPPING_STATUS = "SHADOW_ONLY_NOT_COMMISSIONED" as const;

export const ACTIVE_PITCHING_INVENTORY_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Pitching_Team", "Opposing_Offense",
  "Scheduled_First_Pitch", "Snapshot_TS", "Data_Through_Date",
  "Named_Starter_ID", "Named_Starter", "Named_Starter_Role",
  "Starter_Expected_IP", "Starter_Expected_Pitches", "Starter_Role_Confidence",
  "Production_Expected_IP", "SWE_Expected_IP", "SWE_Status",
  "Expected_Bulk_Pitcher_ID", "Expected_Bulk_Pitcher", "Expected_Bulk_IP",
  "Expected_Bulk_Pitches", "Bulk_Role_Confidence", "Bulk_Observability",
  "Bulk_SWE_Status", "Secondary_Bulk_or_Swing", "Secondary_Bulk_Expected_IP",
  "Secondary_Bulk_Confidence", "Expected_Leverage_Bridge", "Long_Relief_Options",
  "Unavailable_Pitchers", "Limited_Pitchers", "Expected_Pitching_Sequence",
  "Expected_Starter_Phase_IP", "Expected_Bulk_Phase_IP",
  "Expected_Bullpen_Phase_IP", "True_Bullpen_Exposure_IP",
  "Pitching_Plan_Type", "Pitcher_Chain_Confidence", "Pitcher_Chain_Status",
  "Source_Provenance", "Freshness", "Missing_Data_Flags",
  "Baseline_Opposing_Offense_Runs", "API_Shadow_Opposing_Offense_Runs",
  "API_Shadow_Run_Delta", "Expected_Bulk_Quality_Factor",
  "Generic_Bullpen_Quality_Factor", "Projection_Effect_Status",
  "Active_Input", "Projection_Mapping_Status", "Record_Status",
  "Deterministic_Hash", "Version",
] as const;

export const ACTIVE_PITCHING_INVENTORY_SUMMARY_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Baseline_Away_Runs",
  "Baseline_Home_Runs", "Baseline_Total", "API_Shadow_Away_Runs",
  "API_Shadow_Home_Runs", "API_Shadow_Total", "API_Shadow_Total_Delta",
  "Away_Pitching_Plan", "Home_Pitching_Plan", "Away_Chain_Status",
  "Home_Chain_Status", "Replay_Eligibility", "Research_Status", "Snapshot_TS",
] as const;

export const ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Away_Pitching_Plan",
  "Home_Pitching_Plan", "Baseline_Away_Runs", "Baseline_Home_Runs",
  "Baseline_Total", "API_Shadow_Away_Runs", "API_Shadow_Home_Runs",
  "API_Shadow_Total", "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total",
  "Baseline_Total_Error", "Baseline_Total_Abs_Error", "API_Total_Error",
  "API_Total_Abs_Error", "Baseline_Away_Abs_Error", "Baseline_Home_Abs_Error",
  "API_Away_Abs_Error", "API_Home_Abs_Error", "Baseline_Higher_Side_Correct",
  "API_Higher_Side_Correct", "Baseline_Allocation_Sign_Reversal",
  "API_Allocation_Sign_Reversal", "Production_Away_Starter_IP",
  "SWE_Away_Starter_IP", "API_Away_Starter_Phase_IP", "API_Away_Bulk_Phase_IP",
  "API_Away_True_Bullpen_IP", "Actual_Away_Starter_IP", "Actual_Away_Bulk_IP",
  "Actual_Away_True_Bullpen_IP", "Production_Home_Starter_IP",
  "SWE_Home_Starter_IP", "API_Home_Starter_Phase_IP", "API_Home_Bulk_Phase_IP",
  "API_Home_True_Bullpen_IP", "Actual_Home_Starter_IP", "Actual_Home_Bulk_IP",
  "Actual_Home_True_Bullpen_IP", "Away_Phase_Allocation_Abs_Error",
  "Home_Phase_Allocation_Abs_Error", "Replay_Status", "Settlement_TS",
] as const;

export const ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_HEADERS = [
  "Segment", "Eligible_N", "Baseline_Total_MAE", "API_Total_MAE",
  "Baseline_Total_RMSE", "API_Total_RMSE", "Baseline_Signed_Bias",
  "API_Signed_Bias", "Baseline_Away_MAE", "API_Away_MAE",
  "Baseline_Home_MAE", "API_Home_MAE", "Baseline_Higher_Side_Accuracy",
  "API_Higher_Side_Accuracy", "Baseline_Sign_Reversals", "API_Sign_Reversals",
  "API_Starter_Phase_MAE", "API_Bulk_Phase_MAE", "API_True_Bullpen_Phase_MAE",
  "Baseline_Misses_GE_3", "API_Misses_GE_3", "Baseline_Misses_GE_4",
  "API_Misses_GE_4", "Baseline_Misses_GE_5", "API_Misses_GE_5",
  "Replay_Status", "Replay_TS",
] as const;

export type APIObservability =
  | "KNOWN_PREGAME"
  | "PROBABLE_INFERRED"
  | "NOT_OBSERVABLE_PREGAME"
  | "MISSING_DUE_TO_SOURCE_FAILURE";

export type APIPitchingPlan =
  | "CONVENTIONAL_STARTER"
  | "OPENER_PLUS_CREDIBLE_BULK"
  | "OPENER_PLUS_FRAGMENTED_BRIDGE"
  | "OPENER_PLUS_WEAK_LONG_RELIEF"
  | "TRUE_BULLPEN_GAME"
  | "TANDEM_OR_PIGGYBACK"
  | "SHORT_START_EXPECTED"
  | "ROLE_UNRESOLVED";

export interface ActivePitchingInventoryRow {
  date: string;
  game_id: string;
  team_side: "AWAY" | "HOME";
  pitching_team: string;
  opposing_offense: string;
  scheduled_first_pitch: string;
  snapshot_ts: string;
  data_through_date: string;
  named_starter_id: number | null;
  named_starter: string;
  named_starter_role: string;
  starter_expected_ip: number | null;
  starter_expected_pitches: number | null;
  starter_role_confidence: string;
  production_expected_ip: number | null;
  swe_expected_ip: number | null;
  swe_status: string;
  expected_bulk_pitcher_id: number | null;
  expected_bulk_pitcher: string;
  expected_bulk_ip: number | null;
  expected_bulk_pitches: number | null;
  bulk_role_confidence: string;
  bulk_observability: APIObservability;
  bulk_swe_status: string;
  secondary_bulk_or_swing: string;
  secondary_bulk_expected_ip: number | null;
  secondary_bulk_confidence: string;
  expected_leverage_bridge: string;
  long_relief_options: string;
  unavailable_pitchers: string;
  limited_pitchers: string;
  expected_pitching_sequence: string;
  expected_starter_phase_ip: number | null;
  expected_bulk_phase_ip: number | null;
  expected_bullpen_phase_ip: number | null;
  true_bullpen_exposure_ip: number | null;
  pitching_plan_type: APIPitchingPlan;
  pitcher_chain_confidence: string;
  pitcher_chain_status: string;
  source_provenance: string;
  freshness: string;
  missing_data_flags: string;
  baseline_opposing_offense_runs: number | null;
  api_shadow_opposing_offense_runs: number | null;
  api_shadow_run_delta: number | null;
  expected_bulk_quality_factor: number | null;
  generic_bullpen_quality_factor: number | null;
  projection_effect_status: string;
  record_status: string;
  deterministic_hash: string;
}

export interface ActivePitchingInventoryResult {
  status: "success" | "partial" | "failure";
  date: string;
  rows_written: number;
  summary_rows_written: number;
  rows_preserved: number;
  rows: ActivePitchingInventoryRow[];
  warnings: string[];
  errors: string[];
}

interface BulkCandidate {
  reliever: RelieverStat;
  appearances: SWEAppearance[];
  multi_inning_count: number;
  max_ip: number;
  latest_date: string;
}

interface RosterLongOption {
  pitcher: ActiveRosterPitcher;
  latest_date: string;
  max_ip: number;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function hasChainNeed(role: string, expectedIp: number | null): boolean {
  return /OPENER|BULK|PIGGYBACK|BULLPEN_GAME/.test(role)
    || (expectedIp !== null && expectedIp <= 4);
}

function eligibleBulkCandidates(
  team: string,
  starterId: number | null,
  relievers: readonly RelieverStat[],
  appearances: readonly SWEAppearance[],
  slateDate: string,
): BulkCandidate[] {
  return relievers
    .filter((reliever) =>
      reliever.team_abbr === team
      && reliever.player_id !== null
      && reliever.player_id !== starterId
      && reliever.availability_status === "AVAILABLE",
    )
    .flatMap((reliever) => {
      const prior = appearances
        .filter((appearance) =>
          appearance.pitcher_id === reliever.player_id
          && appearance.game_date < slateDate
          && appearance.outs_status === "AVAILABLE"
          && appearance.innings_pitched !== null,
        )
        .sort((left, right) => right.game_date.localeCompare(left.game_date) || right.game_pk - left.game_pk);
      const multi = prior.filter((appearance) => (appearance.innings_pitched ?? 0) >= 2);
      const maxIp = prior.reduce((maximum, appearance) => Math.max(maximum, appearance.innings_pitched ?? 0), 0);
      const supported = maxIp >= 3 || multi.length >= 2 || reliever.role === "LONG_RELIEF";
      return supported ? [{
        reliever,
        appearances: prior,
        multi_inning_count: multi.length,
        max_ip: maxIp,
        latest_date: prior[0]?.game_date ?? "",
      }] : [];
    })
    .sort((left, right) =>
      right.multi_inning_count - left.multi_inning_count
      || right.max_ip - left.max_ip
      || right.latest_date.localeCompare(left.latest_date)
      || (left.reliever.player_id ?? 0) - (right.reliever.player_id ?? 0),
    );
}

/**
 * Surface active-roster multi-inning options that the daily bullpen report may
 * omit because it classifies them as starters/swingmen rather than relievers.
 * These rows are candidate inventory only: roster membership plus D-1 history
 * cannot name the intended follower and therefore may not populate
 * Expected_Bulk_Pitcher or create a shadow projection delta.
 */
function rosterLongOptions(
  teamId: number | null | undefined,
  starterId: number | null,
  pitchersByTeamId: ReadonlyMap<number, readonly ActiveRosterPitcher[]>,
  appearances: readonly SWEAppearance[],
  slateDate: string,
): RosterLongOption[] {
  if (!teamId) return [];
  return (pitchersByTeamId.get(teamId) ?? [])
    .filter((pitcher) => pitcher.player_id !== starterId)
    .flatMap((pitcher) => {
      const prior = appearances
        .filter((appearance) =>
          appearance.pitcher_id === pitcher.player_id
          && appearance.game_date < slateDate
          && appearance.outs_status === "AVAILABLE"
          && appearance.innings_pitched !== null,
        )
        .sort((left, right) => right.game_date.localeCompare(left.game_date) || right.game_pk - left.game_pk);
      const recent = prior.filter((appearance) => {
        const days = Math.floor((Date.parse(`${slateDate}T12:00:00Z`) - Date.parse(`${appearance.game_date}T12:00:00Z`)) / 86_400_000);
        return days >= 2 && days <= 21;
      });
      const maxIp = recent.reduce((maximum, appearance) => Math.max(maximum, appearance.innings_pitched ?? 0), 0);
      const supported = maxIp >= 3 || recent.filter((appearance) => (appearance.innings_pitched ?? 0) >= 2).length >= 2;
      return supported ? [{ pitcher, latest_date: recent[0]?.game_date ?? "", max_ip: maxIp }] : [];
    })
    .sort((left, right) =>
      right.latest_date.localeCompare(left.latest_date)
      || right.max_ip - left.max_ip
      || left.pitcher.player_id - right.pitcher.player_id,
    );
}

function planType(role: string, starterIp: number | null, bulkCredible: boolean, longReliefN: number): APIPitchingPlan {
  if (!role || role === "UNRESOLVED") return "ROLE_UNRESOLVED";
  if (/PIGGYBACK/.test(role)) return "TANDEM_OR_PIGGYBACK";
  if (role === "BULLPEN_GAME") return "TRUE_BULLPEN_GAME";
  if (role === "OPENER") {
    if (bulkCredible) return "OPENER_PLUS_CREDIBLE_BULK";
    return longReliefN > 1 ? "OPENER_PLUS_FRAGMENTED_BRIDGE" : "OPENER_PLUS_WEAK_LONG_RELIEF";
  }
  if (role === "BULK" || (starterIp !== null && starterIp <= 4)) return "SHORT_START_EXPECTED";
  return "CONVENTIONAL_STARTER";
}

function rowHash(row: Omit<ActivePitchingInventoryRow, "deterministic_hash">): string {
  const stable = { ...row, snapshot_ts: "" };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function resolveSide(
  game: NormalizedGame,
  side: "AWAY" | "HOME",
  summary: GameSummaryRow | undefined,
  bullpen: BullpenResult | null,
  appearances: readonly SWEAppearance[],
  swe: SWEGameState | undefined,
  pitcherStats: Map<number, PitcherSeasonStats>,
  statcastPitcherStats: Map<number, StatcastPitcherExpectedStats>,
  dataThroughDate: string,
  snapshotTs: string,
  activePitchersByTeamId: ReadonlyMap<number, readonly ActiveRosterPitcher[]>,
): ActivePitchingInventoryRow {
  const pitcher = side === "AWAY" ? game.away_pitcher : game.home_pitcher;
  const team = side === "AWAY" ? game.away_team.team_abbr ?? "" : game.home_team.team_abbr ?? "";
  const offense = side === "AWAY" ? game.home_team.team_abbr ?? "" : game.away_team.team_abbr ?? "";
  const sideSwe = side === "AWAY" ? swe?.away : swe?.home;
  const productionIp = pitcher.expected_innings;
  const bullpenSourceAvailable = bullpen !== null && bullpen.status !== "failure";
  const candidates = bullpenSourceAvailable && hasChainNeed(pitcher.role, productionIp)
    ? eligibleBulkCandidates(team, pitcher.player_id, bullpen!.relievers, appearances, game.date)
    : [];
  const rosterOptions = hasChainNeed(pitcher.role, productionIp)
    ? rosterLongOptions(
        side === "AWAY" ? game.away_team.team_id : game.home_team.team_id,
        pitcher.player_id,
        activePitchersByTeamId,
        appearances,
        game.date,
      )
    : [];
  const primary = candidates[0];
  const secondary = candidates[1];
  const primarySwe = primary?.reliever.player_id
    ? estimateStarterWorkload(primary.reliever.player_id, "BULK", game.date, dataThroughDate, appearances, null)
    : null;
  const secondarySwe = secondary?.reliever.player_id
    ? estimateStarterWorkload(secondary.reliever.player_id, "BULK", game.date, dataThroughDate, appearances, null)
    : null;
  // A role fallback is not pitcher-specific evidence. Only an estimated SWE
  // workload may create a credible bulk phase in the projection challenger.
  const bulkIp = primarySwe?.status === "ESTIMATED" ? primarySwe.expected_ip : null;
  const secondaryIp = secondarySwe?.status === "ESTIMATED" ? secondarySwe.expected_ip : null;
  const starterIp = productionIp;
  const bullpenIp = starterIp === null ? null : round(Math.max(0, 9 - starterIp - (bulkIp ?? 0)));
  const plan = planType(pitcher.role, starterIp, bulkIp !== null, Math.max(candidates.length, rosterOptions.length));
  const observability: APIObservability = !bullpenSourceAvailable
    ? "MISSING_DUE_TO_SOURCE_FAILURE"
    : primary ? "PROBABLE_INFERRED" : "NOT_OBSERVABLE_PREGAME";
  const bullpenQuality = bullpenSourceAvailable
    ? computeTeamBullpenQuality(team, bullpen!.relievers, pitcherStats, statcastPitcherStats)
    : null;
  const bulkQuality = primary?.reliever.player_id
    ? resolveStarterQuality(primary.reliever.player_id, pitcherStats, statcastPitcherStats)
    : null;
  const baselineOffenseRuns = summary
    ? side === "AWAY" ? summary.projected_home_runs : summary.projected_away_runs
    : null;
  const offenseCenter = summary
    ? side === "AWAY" ? summary.home_active_offense_center : summary.away_active_offense_center
    : null;
  const projectionEligible = bulkIp !== null && bulkQuality !== null && bullpenQuality !== null && offenseCenter !== null && baselineOffenseRuns !== null;
  const delta = projectionEligible
    ? round(offenseCenter * (bulkIp / 9) * (bulkQuality.factor - bullpenQuality.factor))
    : null;
  const projected = delta === null || baselineOffenseRuns === null ? null : round(baselineOffenseRuns + delta);
  const unavailable = bullpenSourceAvailable
    ? bullpen!.relievers.filter((reliever) => reliever.team_abbr === team && reliever.availability_status === "UNAVAILABLE").map((reliever) => reliever.full_name)
    : [];
  const limited = bullpenSourceAvailable
    ? bullpen!.relievers.filter((reliever) => reliever.team_abbr === team && reliever.availability_status === "TIRED").map((reliever) => reliever.full_name)
    : [];
  const missing = [
    !bullpenSourceAvailable ? "BULLPEN_SOURCE_UNAVAILABLE" : "",
    !primary && hasChainNeed(pitcher.role, productionIp) ? "EXPECTED_BULK_IDENTITY_NOT_OBSERVABLE" : "",
    !primary && rosterOptions.length > 0 ? "ROSTER_MULTI_INNING_OPTIONS_UNCONFIRMED" : "",
    primary && bulkIp === null ? "BULK_SWE_WORKLOAD_INSUFFICIENT" : "",
    !summary ? "ACTIVE_SUMMARY_UNAVAILABLE" : "",
    projectionEligible ? "" : "API_PROJECTION_EFFECT_NOT_ESTIMABLE",
  ].filter(Boolean);
  const chainStatus = plan === "CONVENTIONAL_STARTER"
    ? "NO_BULK_PHASE_EXPECTED"
    : projectionEligible ? "INFERRED_CHAIN_SHADOW_READY" : "CHAIN_PARTIAL_NOT_PROJECTION_READY";
  const explicitCandidateIds = new Set(candidates.map((candidate) => candidate.reliever.player_id));
  const longRelief = [
    ...candidates.map((candidate) => candidate.reliever.full_name),
    ...rosterOptions
      .filter((option) => !explicitCandidateIds.has(option.pitcher.player_id))
      .map((option) => `${option.pitcher.full_name} [ROSTER_HISTORY_ONLY]`),
  ];
  const sequence = [
    pitcher.name || "UNRESOLVED_STARTER",
    primary?.reliever.full_name ? `${primary.reliever.full_name} [INFERRED_BULK]` : "",
    secondary?.reliever.full_name ? `${secondary.reliever.full_name} [SECONDARY_OPTION]` : "",
    "REMAINING_AVAILABLE_RELIEF_POOL",
  ].filter(Boolean).join(" > ");
  const expectedPitches = bulkIp === null || primarySwe?.l5_ip === null
    ? null
    : round((primary.appearances.filter((appearance) => appearance.started_game).slice(0, 5)
        .reduce((sum, appearance) => sum + appearance.pitches_thrown, 0)
      / Math.max(1, primary.appearances.filter((appearance) => appearance.started_game).slice(0, 5).length)), 1);
  const base: Omit<ActivePitchingInventoryRow, "deterministic_hash"> = {
    date: game.date, game_id: game.legacy_game_id, team_side: side, pitching_team: team,
    opposing_offense: offense, scheduled_first_pitch: game.scheduled_utc_time ?? "",
    snapshot_ts: snapshotTs, data_through_date: dataThroughDate,
    named_starter_id: pitcher.player_id, named_starter: pitcher.name ?? "",
    named_starter_role: pitcher.role, starter_expected_ip: pitcher.expected_innings,
    starter_expected_pitches: pitcher.expected_pitches, starter_role_confidence: pitcher.role_confidence,
    production_expected_ip: productionIp, swe_expected_ip: sideSwe?.expected_ip ?? null,
    swe_status: sideSwe?.status ?? "UNAVAILABLE", expected_bulk_pitcher_id: primary?.reliever.player_id ?? null,
    expected_bulk_pitcher: primary?.reliever.full_name ?? "", expected_bulk_ip: bulkIp,
    expected_bulk_pitches: expectedPitches, bulk_role_confidence: projectionEligible ? "MEDIUM" : primary ? "LOW" : "NONE",
    bulk_observability: observability, bulk_swe_status: primarySwe?.status ?? "NOT_EVALUATED",
    secondary_bulk_or_swing: secondary?.reliever.full_name ?? "", secondary_bulk_expected_ip: secondaryIp,
    secondary_bulk_confidence: secondaryIp !== null ? "LOW" : "NONE",
    expected_leverage_bridge: "", long_relief_options: longRelief.join(" | "),
    unavailable_pitchers: unavailable.join(" | "), limited_pitchers: limited.join(" | "),
    expected_pitching_sequence: sequence, expected_starter_phase_ip: starterIp,
    expected_bulk_phase_ip: bulkIp, expected_bullpen_phase_ip: bullpenIp,
    true_bullpen_exposure_ip: bullpenIp, pitching_plan_type: plan,
    pitcher_chain_confidence: plan === "CONVENTIONAL_STARTER" ? "HIGH" : projectionEligible ? "MEDIUM" : "LOW",
    pitcher_chain_status: chainStatus,
    source_provenance: "MLB_STATS_PROBABLE_STARTER|MLB_ACTIVE_ROSTER|MLBSTARTINGNINE_BULLPEN_REPORT|SAVANT_D1_SWE_APPEARANCE_HISTORY|MLB_SEASON_PITCHING",
    freshness: dataThroughDate === new Date(new Date(`${game.date}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10) ? "CURRENT_D1" : "STALE_OR_UNVERIFIED",
    missing_data_flags: missing.join(" | "), baseline_opposing_offense_runs: baselineOffenseRuns,
    api_shadow_opposing_offense_runs: projected, api_shadow_run_delta: delta,
    expected_bulk_quality_factor: bulkQuality?.factor ?? null,
    generic_bullpen_quality_factor: bullpenQuality?.factor ?? null,
    projection_effect_status: projectionEligible ? "SHADOW_DELTA_AVAILABLE" : "NOT_ESTIMABLE",
    record_status: "RESEARCH_ONLY_PROSPECTIVE", 
  };
  return { ...base, deterministic_hash: rowHash(base) };
}

export function buildActivePitchingInventory(
  games: readonly NormalizedGame[],
  summaries: readonly GameSummaryRow[],
  bullpen: BullpenResult | null,
  appearances: readonly SWEAppearance[],
  sweStates: Map<string, SWEGameState>,
  pitcherStats: Map<number, PitcherSeasonStats>,
  statcastPitcherStats: Map<number, StatcastPitcherExpectedStats>,
  dataThroughDate: string,
  snapshotTs = new Date().toISOString(),
  activePitchersByTeamId: ReadonlyMap<number, readonly ActiveRosterPitcher[]> = new Map(),
): ActivePitchingInventoryRow[] {
  const summaryByGame = new Map(summaries.map((summary) => [summary.game_id, summary]));
  return games.flatMap((game) => [
    resolveSide(game, "AWAY", summaryByGame.get(game.legacy_game_id), bullpen, appearances, sweStates.get(game.legacy_game_id), pitcherStats, statcastPitcherStats, dataThroughDate, snapshotTs, activePitchersByTeamId),
    resolveSide(game, "HOME", summaryByGame.get(game.legacy_game_id), bullpen, appearances, sweStates.get(game.legacy_game_id), pitcherStats, statcastPitcherStats, dataThroughDate, snapshotTs, activePitchersByTeamId),
  ]);
}

function rowValues(row: ActivePitchingInventoryRow): unknown[] {
  return [
    row.date, row.game_id, row.team_side, row.pitching_team, row.opposing_offense,
    row.scheduled_first_pitch, row.snapshot_ts, row.data_through_date,
    row.named_starter_id ?? "", row.named_starter, row.named_starter_role,
    row.starter_expected_ip ?? "", row.starter_expected_pitches ?? "", row.starter_role_confidence,
    row.production_expected_ip ?? "", row.swe_expected_ip ?? "", row.swe_status,
    row.expected_bulk_pitcher_id ?? "", row.expected_bulk_pitcher, row.expected_bulk_ip ?? "",
    row.expected_bulk_pitches ?? "", row.bulk_role_confidence, row.bulk_observability,
    row.bulk_swe_status, row.secondary_bulk_or_swing, row.secondary_bulk_expected_ip ?? "",
    row.secondary_bulk_confidence, row.expected_leverage_bridge, row.long_relief_options,
    row.unavailable_pitchers, row.limited_pitchers, row.expected_pitching_sequence,
    row.expected_starter_phase_ip ?? "", row.expected_bulk_phase_ip ?? "",
    row.expected_bullpen_phase_ip ?? "", row.true_bullpen_exposure_ip ?? "",
    row.pitching_plan_type, row.pitcher_chain_confidence, row.pitcher_chain_status,
    row.source_provenance, row.freshness, row.missing_data_flags,
    row.baseline_opposing_offense_runs ?? "", row.api_shadow_opposing_offense_runs ?? "",
    row.api_shadow_run_delta ?? "", row.expected_bulk_quality_factor ?? "",
    row.generic_bullpen_quality_factor ?? "", row.projection_effect_status,
    ACTIVE_PITCHING_INVENTORY_ACTIVE_INPUT, ACTIVE_PITCHING_INVENTORY_MAPPING_STATUS,
    row.record_status, row.deterministic_hash, ACTIVE_PITCHING_INVENTORY_VERSION,
  ];
}

function summaryRows(rows: readonly ActivePitchingInventoryRow[]): unknown[][] {
  const byGame = new Map<string, ActivePitchingInventoryRow[]>();
  for (const row of rows) byGame.set(row.game_id, [...(byGame.get(row.game_id) ?? []), row]);
  return [...byGame.values()].flatMap((gameRows) => {
    const awayDefense = gameRows.find((row) => row.team_side === "AWAY");
    const homeDefense = gameRows.find((row) => row.team_side === "HOME");
    if (!awayDefense || !homeDefense) return [];
    const baselineAway = homeDefense.baseline_opposing_offense_runs;
    const baselineHome = awayDefense.baseline_opposing_offense_runs;
    const apiAway = homeDefense.api_shadow_opposing_offense_runs ?? baselineAway;
    const apiHome = awayDefense.api_shadow_opposing_offense_runs ?? baselineHome;
    const baselineTotal = baselineAway === null || baselineHome === null ? null : round(baselineAway + baselineHome);
    const apiTotal = apiAway === null || apiHome === null ? null : round(apiAway + apiHome);
    return [[
      awayDefense.date, awayDefense.game_id, awayDefense.pitching_team, homeDefense.pitching_team,
      baselineAway ?? "", baselineHome ?? "", baselineTotal ?? "", apiAway ?? "", apiHome ?? "", apiTotal ?? "",
      baselineTotal === null || apiTotal === null ? "" : round(apiTotal - baselineTotal),
      awayDefense.pitching_plan_type, homeDefense.pitching_plan_type,
      awayDefense.pitcher_chain_status, homeDefense.pitcher_chain_status,
      awayDefense.projection_effect_status === "SHADOW_DELTA_AVAILABLE" || homeDefense.projection_effect_status === "SHADOW_DELTA_AVAILABLE"
        ? "PROSPECTIVE_SHADOW_ELIGIBLE" : "NO_ESTIMABLE_CHAIN_DELTA",
      "RESEARCH_ONLY", awayDefense.snapshot_ts,
    ]];
  });
}

async function ensureSheets(workbookId: string, names: readonly string[]): Promise<void> {
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const name of names) {
    if (existing.has(name)) continue;
    await addSheet(workbookId, name);
    existing.add(name);
  }
}

export function selectInventoryRowsForAppend(
  existing: readonly unknown[][],
  rows: readonly ActivePitchingInventoryRow[],
  protectedGameIds: ReadonlySet<string> = new Set(),
): ActivePitchingInventoryRow[] {
  const existingKeys = new Set(existing.map((row) => [0, 1, 2, 6]
    .map((index) => String(row[index] ?? ""))
    .join("|")));
  return rows.filter((row) =>
    !protectedGameIds.has(row.game_id)
    && !existingKeys.has(`${row.date}|${row.game_id}|${row.team_side}|${row.snapshot_ts}`),
  );
}

export async function writeActivePitchingInventory(
  date: string,
  rows: readonly ActivePitchingInventoryRow[],
  options: { workbookId?: string; protection?: PublicationProtection } = {},
): Promise<ActivePitchingInventoryResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    await ensureSheets(workbookId, [ACTIVE_PITCHING_INVENTORY_SHEET, ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET]);
    await expandSheetColumns(workbookId, ACTIVE_PITCHING_INVENTORY_SHEET, ACTIVE_PITCHING_INVENTORY_HEADERS.length);
    await expandSheetColumns(workbookId, ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET, ACTIVE_PITCHING_INVENTORY_SUMMARY_HEADERS.length);
    await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SHEET}!A1:BA1`, [[...ACTIVE_PITCHING_INVENTORY_HEADERS]]);
    await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET}!A1:R1`, [[...ACTIVE_PITCHING_INVENTORY_SUMMARY_HEADERS]]);
    const existing = (await readRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SHEET}!A2:BA5000`).catch(() => ({ values: [] }))).values ?? [];
    // Module 36 is a prospective snapshot ledger, not a one-row-per-game
    // materialization. A later mutable pregame run may learn that the named
    // starter is actually an opener or that a credible bulk arm is available.
    // Preserve the earlier observation and append the later observation. The
    // snapshot timestamp is part of the identity so an idempotent retry of the
    // same payload cannot duplicate it.
    const appended = selectInventoryRowsForAppend(existing, rows, options.protection?.protected_game_ids);
    if (appended.length > 0) {
      const start = existing.length + 2;
      await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SHEET}!A${start}:BA${start + appended.length - 1}`, appended.map(rowValues));
    }
    const summaries = summaryRows(appended);
    const existingSummary = (await readRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET}!A2:R3000`).catch(() => ({ values: [] }))).values ?? [];
    if (summaries.length > 0) {
      const start = existingSummary.length + 2;
      await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SUMMARY_SHEET}!A${start}:R${start + summaries.length - 1}`, summaries);
    }
    const preserved = rows.length - appended.length;
    if (preserved > 0) warnings.push(`${preserved} inventory rows were protected or were exact snapshot retries.`);
    return { status: warnings.length ? "partial" : "success", date, rows_written: appended.length, summary_rows_written: summaries.length, rows_preserved: preserved, rows: [...rows], warnings, errors };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { status: "failure", date, rows_written: 0, summary_rows_written: 0, rows_preserved: 0, rows: [...rows], warnings, errors };
  }
}

export const ACTIVE_PITCHING_INVENTORY_PROOF_CASES = [
  ["2026-09-17", "20260917_KCR_HOU", "NOT_OBSERVABLE_PREGAME", "No retained prospective bullpen-availability/declared-follower inventory exists for this historical packet; Ethan Pecko cannot be reconstructed from postgame order."],
  ["2026-09-17", "20260917_BOS_TEX", "NOT_OBSERVABLE_PREGAME", "No retained prospective chain snapshot exists; Cody Bradford's postgame use cannot be promoted to pregame evidence."],
  ["2026-09-18", "20260918_OAK_CLE", "NOT_OBSERVABLE_PREGAME", "No retained prospective chain snapshot exists; Joey Cantillo's postgame six innings are outcome evidence only."],
] as const;

export function auditHistoricalAPIReplayAvailability(rows: readonly unknown[][]): {
  prospective_rows: number;
  eligible_games: number;
  status: "INSUFFICIENT_PROSPECTIVE_API_HISTORY" | "REPLAY_READY";
} {
  const games = new Set(rows.filter((row) => String(row[50] ?? "") === "RESEARCH_ONLY_PROSPECTIVE").map((row) => String(row[1] ?? "")));
  return { prospective_rows: rows.length, eligible_games: games.size, status: games.size > 0 ? "REPLAY_READY" : "INSUFFICIENT_PROSPECTIVE_API_HISTORY" };
}

export interface ActivePitchingInventoryReplayResult {
  status: "success" | "failure";
  prospective_inventory_rows: number;
  eligible_games: number;
  replay_rows_written: number;
  summary_rows_written: number;
  replay_status: "INSUFFICIENT_PROSPECTIVE_API_HISTORY" | "REPLAY_AVAILABLE";
  warnings: string[];
  errors: string[];
}

function tableObjects(values: unknown[][]): Array<Record<string, unknown>> {
  const [header = [], ...rows] = values;
  const names = header.map((value) => String(value ?? "").trim());
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

export function selectLatestCompleteInventorySnapshot(
  rows: Array<Record<string, unknown>>,
): { snapshot_ts: string; away: Record<string, unknown>; home: Record<string, unknown> } | null {
  const bySnapshot = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const snapshot = String(row.Snapshot_TS ?? "");
    if (!snapshot) continue;
    bySnapshot.set(snapshot, [...(bySnapshot.get(snapshot) ?? []), row]);
  }
  for (const [snapshot, snapshotRows] of [...bySnapshot.entries()].sort(([left], [right]) => right.localeCompare(left))) {
    const away = snapshotRows.find((row) => String(row.Team_Side) === "AWAY");
    const home = snapshotRows.find((row) => String(row.Team_Side) === "HOME");
    if (away && home) return { snapshot_ts: snapshot, away, home };
  }
  return null;
}

function chainInnings(chain: string, pitcherName: string): number | null {
  if (!chain || !pitcherName) return null;
  const escaped = pitcherName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = chain.match(new RegExp(`${escaped} \\((\\d+)(?:\\.(\\d))? IP\\)`, "i"));
  if (!match) return null;
  const whole = Number(match[1] ?? 0);
  const outs = Number(match[2] ?? 0);
  return Number.isFinite(whole) && (outs === 0 || outs === 1 || outs === 2) ? round(whole + outs / 3) : null;
}

function sideCorrect(away: number, home: number, actualAway: number, actualHome: number): boolean | null {
  const predicted = Math.sign(away - home);
  const actual = Math.sign(actualAway - actualHome);
  return predicted === 0 || actual === 0 ? null : predicted === actual;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function replaySummaryRows(rows: Array<Record<string, unknown>>, replayTs: string): unknown[][] {
  const segments = new Map<string, Array<Record<string, unknown>>>([["ALL", rows]]);
  for (const row of rows) {
    for (const segment of new Set([String(row.Away_Pitching_Plan ?? ""), String(row.Home_Pitching_Plan ?? "")])) {
      if (!segment) continue;
      segments.set(segment, [...(segments.get(segment) ?? []), row]);
    }
  }
  return [...segments].map(([segment, group]) => {
    const numberValues = (name: string) => group.map((row) => numeric(row[name])).filter((value): value is number => value !== null);
    const baselineErrors = numberValues("Baseline_Total_Error");
    const apiErrors = numberValues("API_Total_Error");
    const boolRate = (name: string) => {
      const eligible = group.map((row) => String(row[name] ?? "")).filter((value) => value === "TRUE" || value === "FALSE");
      return eligible.length ? eligible.filter((value) => value === "TRUE").length / eligible.length : null;
    };
    const baselineAbs = baselineErrors.map(Math.abs);
    const apiAbs = apiErrors.map(Math.abs);
    const rmse = (values: number[]) => values.length ? Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length) : null;
    const phase = ["Away", "Home"].flatMap((side) => numberValues(`${side}_Phase_Allocation_Abs_Error`));
    const bulkPhase = ["Away", "Home"].flatMap((side) => group.flatMap((row) => {
      const expected = numeric(row[`API_${side}_Bulk_Phase_IP`]);
      const actual = numeric(row[`Actual_${side}_Bulk_IP`]);
      return expected === null || actual === null ? [] : [Math.abs(expected - actual)];
    }));
    const bullpenPhase = ["Away", "Home"].flatMap((side) => group.flatMap((row) => {
      const expected = numeric(row[`API_${side}_True_Bullpen_IP`]);
      const actual = numeric(row[`Actual_${side}_True_Bullpen_IP`]);
      return expected === null || actual === null ? [] : [Math.abs(expected - actual)];
    }));
    return [
      segment, group.length, mean(baselineAbs) ?? "", mean(apiAbs) ?? "", rmse(baselineErrors) ?? "", rmse(apiErrors) ?? "",
      mean(baselineErrors) ?? "", mean(apiErrors) ?? "", mean(numberValues("Baseline_Away_Abs_Error")) ?? "",
      mean(numberValues("API_Away_Abs_Error")) ?? "", mean(numberValues("Baseline_Home_Abs_Error")) ?? "",
      mean(numberValues("API_Home_Abs_Error")) ?? "", boolRate("Baseline_Higher_Side_Correct") ?? "",
      boolRate("API_Higher_Side_Correct") ?? "", numberValues("Baseline_Allocation_Sign_Reversal").reduce((sum, value) => sum + value, 0),
      numberValues("API_Allocation_Sign_Reversal").reduce((sum, value) => sum + value, 0), mean(phase) ?? "", mean(bulkPhase) ?? "",
      mean(bullpenPhase) ?? "", baselineAbs.filter((value) => value >= 3).length, apiAbs.filter((value) => value >= 3).length,
      baselineAbs.filter((value) => value >= 4).length, apiAbs.filter((value) => value >= 4).length,
      baselineAbs.filter((value) => value >= 5).length, apiAbs.filter((value) => value >= 5).length,
      "DESCRIPTIVE_PROSPECTIVE_SHADOW", replayTs,
    ];
  });
}

/**
 * Grades only prospectively preserved Module 36 rows. Historical proof cases
 * without a pregame inventory remain explicit NOT_OBSERVABLE rows.
 */
export async function runActivePitchingInventoryReplay(
  options: { workbookId?: string } = {},
): Promise<ActivePitchingInventoryReplayResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTs = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [inventoryValues, allocationValues, timingValues, outcomeValues] = await Promise.all([
      readRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_SHEET}!A1:BA5000`).then((result) => result.values ?? []).catch(() => []),
      readRange(workbookId, "ALLOCATION_SETTLEMENT_DIAGNOSTICS!A1:AB5000").then((result) => result.values ?? []).catch(() => []),
      readRange(workbookId, "BULLPEN_TIMING_DIAGNOSTICS!A1:AZ5000").then((result) => result.values ?? []).catch(() => []),
      readRange(workbookId, "SHADOW_OUTCOMES!A1:AW5000").then((result) => result.values ?? []).catch(() => []),
    ]);
    const inventory = tableObjects(inventoryValues);
    const allocation = new Map(tableObjects(allocationValues).map((row) => [`${row.Date}|${row.Game_ID}`, row]));
    const timing = new Map(tableObjects(timingValues).map((row) => [`${row.Date}|${row.Game_ID}`, row]));
    const outcomes = new Map(tableObjects(outcomeValues).map((row) => [`${row.Date}|${row.Game_ID}`, row]));
    const byGame = new Map<string, Array<Record<string, unknown>>>();
    for (const row of inventory) {
      const key = `${row.Date}|${row.Game_ID}`;
      byGame.set(key, [...(byGame.get(key) ?? []), row]);
    }
    const replayObjects: Array<Record<string, unknown>> = [];
    for (const [key, rows] of byGame) {
      // Select the latest complete prospectively captured snapshot. Never mix
      // the away side from one refresh with the home side from another.
      const selected = selectLatestCompleteInventorySnapshot(rows);
      const away = selected?.away;
      const home = selected?.home;
      const actual = allocation.get(key);
      if (!away || !home || !actual) continue;
      const actualAway = numeric(actual.Actual_Away_Runs);
      const actualHome = numeric(actual.Actual_Home_Runs);
      const baselineAway = numeric(home.Baseline_Opposing_Offense_Runs);
      const baselineHome = numeric(away.Baseline_Opposing_Offense_Runs);
      const apiAway = numeric(home.API_Shadow_Opposing_Offense_Runs) ?? baselineAway;
      const apiHome = numeric(away.API_Shadow_Opposing_Offense_Runs) ?? baselineHome;
      if ([actualAway, actualHome, baselineAway, baselineHome, apiAway, apiHome].some((value) => value === null)) continue;
      const aAway = actualAway!; const aHome = actualHome!;
      const bAway = baselineAway!; const bHome = baselineHome!;
      const pAway = apiAway!; const pHome = apiHome!;
      const time = timing.get(key) ?? {};
      const outcome = outcomes.get(key) ?? {};
      const actualAwayStarter = numeric(time.Actual_Away_Starter_IP);
      const actualHomeStarter = numeric(time.Actual_Home_Starter_IP);
      const actualAwayBulk = chainInnings(String(outcome.Away_Pitcher_Chain ?? ""), String(away.Expected_Bulk_Pitcher ?? ""));
      const actualHomeBulk = chainInnings(String(outcome.Home_Pitcher_Chain ?? ""), String(home.Expected_Bulk_Pitcher ?? ""));
      const actualAwayBullpen = actualAwayStarter === null ? null : round(Math.max(0, 9 - actualAwayStarter - (actualAwayBulk ?? 0)));
      const actualHomeBullpen = actualHomeStarter === null ? null : round(Math.max(0, 9 - actualHomeStarter - (actualHomeBulk ?? 0)));
      const awayStarterExpected = numeric(away.Expected_Starter_Phase_IP);
      const homeStarterExpected = numeric(home.Expected_Starter_Phase_IP);
      const awayPhaseError = awayStarterExpected === null || actualAwayStarter === null ? null : Math.abs(awayStarterExpected - actualAwayStarter);
      const homePhaseError = homeStarterExpected === null || actualHomeStarter === null ? null : Math.abs(homeStarterExpected - actualHomeStarter);
      const object: Record<string, unknown> = {
        Date: away.Date, Game_ID: away.Game_ID, Away_Team: away.Pitching_Team, Home_Team: home.Pitching_Team,
        Away_Pitching_Plan: away.Pitching_Plan_Type, Home_Pitching_Plan: home.Pitching_Plan_Type,
        Baseline_Away_Runs: bAway, Baseline_Home_Runs: bHome, Baseline_Total: round(bAway + bHome),
        API_Shadow_Away_Runs: pAway, API_Shadow_Home_Runs: pHome, API_Shadow_Total: round(pAway + pHome),
        Actual_Away_Runs: aAway, Actual_Home_Runs: aHome, Actual_Total: aAway + aHome,
        Baseline_Total_Error: round(bAway + bHome - aAway - aHome), Baseline_Total_Abs_Error: round(Math.abs(bAway + bHome - aAway - aHome)),
        API_Total_Error: round(pAway + pHome - aAway - aHome), API_Total_Abs_Error: round(Math.abs(pAway + pHome - aAway - aHome)),
        Baseline_Away_Abs_Error: round(Math.abs(bAway - aAway)), Baseline_Home_Abs_Error: round(Math.abs(bHome - aHome)),
        API_Away_Abs_Error: round(Math.abs(pAway - aAway)), API_Home_Abs_Error: round(Math.abs(pHome - aHome)),
        Baseline_Higher_Side_Correct: sideCorrect(bAway, bHome, aAway, aHome), API_Higher_Side_Correct: sideCorrect(pAway, pHome, aAway, aHome),
        Baseline_Allocation_Sign_Reversal: sideCorrect(bAway, bHome, aAway, aHome) === false ? 1 : 0,
        API_Allocation_Sign_Reversal: sideCorrect(pAway, pHome, aAway, aHome) === false ? 1 : 0,
        Production_Away_Starter_IP: numeric(away.Production_Expected_IP), SWE_Away_Starter_IP: numeric(away.SWE_Expected_IP),
        API_Away_Starter_Phase_IP: awayStarterExpected, API_Away_Bulk_Phase_IP: numeric(away.Expected_Bulk_Phase_IP),
        API_Away_True_Bullpen_IP: numeric(away.True_Bullpen_Exposure_IP), Actual_Away_Starter_IP: actualAwayStarter,
        Actual_Away_Bulk_IP: actualAwayBulk, Actual_Away_True_Bullpen_IP: actualAwayBullpen,
        Production_Home_Starter_IP: numeric(home.Production_Expected_IP), SWE_Home_Starter_IP: numeric(home.SWE_Expected_IP),
        API_Home_Starter_Phase_IP: homeStarterExpected, API_Home_Bulk_Phase_IP: numeric(home.Expected_Bulk_Phase_IP),
        API_Home_True_Bullpen_IP: numeric(home.True_Bullpen_Exposure_IP), Actual_Home_Starter_IP: actualHomeStarter,
        Actual_Home_Bulk_IP: actualHomeBulk, Actual_Home_True_Bullpen_IP: actualHomeBullpen,
        Away_Phase_Allocation_Abs_Error: awayPhaseError, Home_Phase_Allocation_Abs_Error: homePhaseError,
        Replay_Status: "PROSPECTIVE_SHADOW_SETTLED", Settlement_TS: actual.Settlement_TS ?? replayTs,
      };
      replayObjects.push(object);
    }
    const replayRows = replayObjects.map((object) => ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS.map((name) => {
      const value = object[name];
      return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value ?? "";
    }));
    // Proof-case rows are governance evidence only and never enter metrics.
    for (const [date, gameId, status, reason] of ACTIVE_PITCHING_INVENTORY_PROOF_CASES) {
      const row = new Array(ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS.length).fill("");
      row[0] = date; row[1] = gameId; row[45] = `${status}: ${reason}`; row[46] = replayTs;
      replayRows.push(row);
    }
    const summaries = replaySummaryRows(replayObjects, replayTs);
    if (summaries.length === 0) summaries.push([
      "ALL", 0, "", "", "", "", "", "", "", "", "", "", "", "", 0, 0,
      "", "", "", 0, 0, 0, 0, 0, 0, "INSUFFICIENT_PROSPECTIVE_API_HISTORY", replayTs,
    ]);
    await ensureSheets(workbookId, [ACTIVE_PITCHING_INVENTORY_REPLAY_SHEET, ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_SHEET]);
    await expandSheetColumns(workbookId, ACTIVE_PITCHING_INVENTORY_REPLAY_SHEET, ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS.length);
    await expandSheetColumns(workbookId, ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_SHEET, ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_HEADERS.length);
    await clearRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_REPLAY_SHEET}!A1:AU5000`);
    await clearRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_SHEET}!A1:AA500`);
    await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_REPLAY_SHEET}!A1`, [[...ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS], ...replayRows]);
    await writeRange(workbookId, `${ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_SHEET}!A1`, [[...ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_HEADERS], ...summaries]);
    const status = replayObjects.length > 0 ? "REPLAY_AVAILABLE" : "INSUFFICIENT_PROSPECTIVE_API_HISTORY";
    if (status === "INSUFFICIENT_PROSPECTIVE_API_HISTORY") warnings.push("No settled prospectively preserved Module 36 game is eligible; historical chains were not reconstructed.");
    return { status: "success", prospective_inventory_rows: inventory.length, eligible_games: replayObjects.length, replay_rows_written: replayRows.length, summary_rows_written: summaries.length, replay_status: status, warnings, errors };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { status: "failure", prospective_inventory_rows: 0, eligible_games: 0, replay_rows_written: 0, summary_rows_written: 0, replay_status: "INSUFFICIENT_PROSPECTIVE_API_HISTORY", warnings, errors };
  }
}
