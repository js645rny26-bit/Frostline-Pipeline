/**
 * Module 14: Shadow Settlement
 *
 * Pairs the last pregame SHADOW_HISTORY snapshot for each game with the final
 * score and the actual pitching chain. Existing outcome rows are updated when
 * provenance is missing, so a rerun repairs old settlements without duplicates.
 */

import { addSheet, readRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { selectCanonicalVehicleRows } from "./module17_vehiclePostmortem.js";
import { SOURCE_MAPPINGS } from "./config.js";
import {
  comparePitcherNames,
  parseGamePitcherProvenance,
  type GamePitcherProvenance,
  type PitcherMatchStatus,
  type PitcherProvenanceStatus,
} from "./module14_pitcherProvenance.js";
import {
  normalizePregamePacketHistoryRows,
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_HEADERS,
} from "./module20a_pregamePacket.js";
import { assignUniqueGameIds } from "./module01_mlbStatsApi.js";
import type { PostmortemEventEvidence } from "./module21_postmortemMechanism.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const HISTORY_SHEET = "SHADOW_HISTORY";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const PREGAME_PACKET_HISTORY_SHEET = "PREGAME_PACKET_HISTORY";
const VEHICLE_LOG_SHEET = "VEHICLE_LOG";
const DECISION_AUDIT_SHEET = "DECISION_AUDIT_LOG";
const PROJECTION_REPLAY_SHEET = "PROJECTION_REPLAY";
const LOW_CENTER_HISTORY_SHEET = "LOW_CENTER_CALIBRATION_HISTORY";
const LOW_CENTER_REPORT_SHEET = "LOW_CENTER_CALIBRATION_REPORT";
const COLLISION_HISTORY_SHEET = "COLLISION_CALIBRATION_HISTORY";
const COLLISION_REPORT_SHEET = "COLLISION_CALIBRATION_REPORT";
const STARTER_SURVIVAL_HISTORY_SHEET = "STARTER_SURVIVAL_CALIBRATION_HISTORY";
const STARTER_SURVIVAL_REPORT_SHEET = "STARTER_SURVIVAL_CALIBRATION_REPORT";
const STARTER_SURVIVAL_V2_HISTORY_SHEET = "STARTER_SURVIVAL_V2_CALIBRATION_HISTORY";
const STARTER_SURVIVAL_V2_REPORT_SHEET = "STARTER_SURVIVAL_V2_CALIBRATION_REPORT";
const OUTCOMES_COLS = 44; // A-AR

export const LOW_CENTER_CALIBRATION_REPORT_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Projection", "Primary_Challenger_Projection", "Sensitivity_Challenger_Projection",
  "Actual_Total", "Base_Error", "Primary_Error", "Sensitivity_Error",
  "Base_Abs_Error", "Primary_Abs_Error", "Sensitivity_Abs_Error",
  "Prospective_Snapshot_TS", "Settlement_TS", "Calibration_Status",
];

/**
 * Per-game settlement report for the Statcast collision candidate. Candidate
 * fields are blank when the preserved preview was unavailable or incomplete;
 * zero must never be mistaken for a neutral collision signal.
 */
export const COLLISION_CALIBRATION_REPORT_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Away_Projection", "Base_Home_Projection", "Base_Projection",
  "Collision_Away_Evidence_Projection", "Collision_Home_Evidence_Projection",
  "Collision_Estimated_Projection", "Traffic_Conversion_Estimate", "HR_XBH_Damage_Estimate",
  "Combined_Tail_Adjustment", "Preview_Availability", "Tail_Estimate_Status",
  "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total",
  "Base_Error", "Base_Abs_Error", "Collision_Error", "Collision_Abs_Error",
  "Base_Market_Direction_Result", "Collision_Market_Direction_Result",
  "Prospective_Snapshot_TS", "Settlement_TS", "Calibration_Status",
  // Replay V1 candidate decomposition. These fields are preserved prospective
  // evidence, never settlement-time reconstruction or live model inputs.
  "xwOBA_Shadow_Projection", "Traffic_Only_Projection", "Damage_Only_Projection",
  "Combined_Tail_Only_Projection",
  "xwOBA_Away_Evidence_Projection", "xwOBA_Home_Evidence_Projection",
  "Traffic_Away_Evidence_Projection", "Traffic_Home_Evidence_Projection",
  "Damage_Away_Evidence_Projection", "Damage_Home_Evidence_Projection",
  "Frozen_Market_Line",
];

export const STARTER_SURVIVAL_CALIBRATION_REPORT_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Projected_Total", "Starter_Survival_Adjusted_Total", "Actual_Total",
  "Base_Error", "Base_Abs_Error", "SSAT_Error", "SSAT_Abs_Error",
  "Base_Market_Direction_Result", "SSAT_Market_Direction_Result",
  "Away_Starter_Actual_IP", "Home_Starter_Actual_IP",
  "Away_Starter_Survival_Result", "Home_Starter_Survival_Result",
  "Away_Starter_FDS", "Home_Starter_FDS", "Game_FDS",
  "Prospective_Snapshot_TS", "Settlement_TS", "Calibration_Status",
];

export const STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Base_Projected_Total", "SSAT_V1_Total", "SSAT_V2_Total", "Actual_Total",
  "Base_Error", "Base_Abs_Error", "SSAT_V1_Error", "SSAT_V1_Abs_Error", "SSAT_V2_Error", "SSAT_V2_Abs_Error",
  "Base_Market_Direction_Result", "SSAT_V1_Market_Direction_Result", "SSAT_V2_Market_Direction_Result",
  "Away_Starter_Actual_IP", "Home_Starter_Actual_IP", "Away_Starter_Survival_Result", "Home_Starter_Survival_Result",
  "Away_Starter_Failure_Shortfall", "Home_Starter_Failure_Shortfall", "Away_Starter_Failure_Run_Cost", "Home_Starter_Failure_Run_Cost",
  "Away_Starter_FDS", "Home_Starter_FDS", "Game_FDS", "Calibration_Cohort", "Prospective_Snapshot_TS", "Settlement_TS", "Calibration_Status",
];

const H_DATE = 0;
const H_GAME_ID = 1;
const H_AWAY = 2;
const H_HOME = 3;
const H_AWAY_PITCHER = 4;
const H_HOME_PITCHER = 5;
const H_REPAIRED = 6;
const H_AWAY_SRC = 9;
const H_HOME_SRC = 10;
const H_PARK_SRC = 21;

// PREGAME_PACKET_HISTORY is the canonical freeze boundary. Resolve names from
// its exported schema rather than duplicating fragile column numbers here.
const PACKET_INDEX = Object.fromEntries(
  PREGAME_PACKET_HISTORY_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof PREGAME_PACKET_HISTORY_HEADERS)[number], number>;
const P_DATE = PACKET_INDEX.Date;
const P_GAME_ID = PACKET_INDEX.Game_ID;
const P_SCHEDULED_FIRST_PITCH = PACKET_INDEX.Scheduled_First_Pitch;
const P_PACKET_STATUS = PACKET_INDEX.Packet_Status;
const P_FREEZE_TS = PACKET_INDEX.Freeze_TS;
const P_SNAPSHOT_TS = PACKET_INDEX.Packet_Snapshot_TS;
const P_AWAY_STARTER = PACKET_INDEX.Away_Starter;
const P_HOME_STARTER = PACKET_INDEX.Home_Starter;

const O_SETTLEMENT_TS = 11;
const O_FROZEN_PUBLISHED_TOTAL = 12;
const O_FROZEN_SOURCE = 15;
const O_FROZEN_MARKET_LINE = 17;
const O_FROZEN_TICKET_RESULT = 19;
const O_REFERENCE_MARKET_LINE = 33;
const O_REFERENCE_MARKET_SOURCE = 34;
const O_REFERENCE_MARKET_TS = 35;
const O_EXECUTABLE_MARKET_LINE = 36;
const O_EXECUTABLE_MARKET_SOURCE = 37;
const O_EXECUTABLE_MARKET_TS = 38;
const O_PRIMARY_MARKET_LINE = 39;
const O_PRIMARY_MARKET_SOURCE = 40;
const O_PRIMARY_MARKET_STATUS = 41;
const O_PRIMARY_DIRECTIONAL_RESULT = 42;
const O_REFERENCE_DIRECTIONAL_RESULT = 43;
export const FROZEN_VEHICLE_REQUIRED_FROM_DATE = "2026-08-10";

export const OUTCOMES_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Repaired_Projected_Total", "Actual_Total", "Error", "Abs_Error",
  "Park_Source_Status", "Away_Offense_Source", "Home_Offense_Source", "Settlement_TS",
  "Frozen_Published_Total", "Frozen_Error", "Frozen_Abs_Error",
  "Frozen_Projection_Source", "Repaired_Minus_Frozen",
  "Frozen_Market_Line", "Settlement_Market_Line",
  "Frozen_Ticket_Result", "Settlement_Ticket_Result", "Projection_Audit_Status",
  "Projected_Away_Starter", "Projected_Home_Starter",
  "Actual_Away_Starter", "Actual_Home_Starter",
  "Away_Starter_Match_Status", "Home_Starter_Match_Status",
  "Away_Bulk_Pitcher", "Home_Bulk_Pitcher",
  "Away_Pitcher_Chain", "Home_Pitcher_Chain", "Pitcher_Provenance_Status",
  // Preserve both market observations. Frozen_Market_Line remains the legacy
  // reference/vehicle field; primary grading can use a legitimate executable
  // operator line without rewriting historical reference evidence.
  "Reference_Market_Line", "Reference_Market_Source", "Reference_Market_TS",
  "Executable_Market_Line", "Executable_Market_Source", "Executable_Market_TS",
  "Primary_Grade_Market_Line", "Primary_Grade_Market_Source", "Primary_Market_Grade_Status",
  "Primary_Directional_Result", "Reference_Directional_Result",
];

export const PROJECTION_REPLAY_HEADER = [
  "Replay_Date", "Game_ID", "Away_Team", "Home_Team", "Actual_Total",
  "Legacy_Projected", "L30_Park_Projected", "L10_Park_Projected",
  "Blend_Projected", "Blend_Park_Projected", "Legacy_Error", "L30_Park_Error",
  "L10_Park_Error", "Blend_Error", "Blend_Park_Error", "Away_L30_Rate",
  "Home_L30_Rate", "Away_L10_Rate", "Home_L10_Rate", "Away_Offense_Source",
  "Home_Offense_Source", "Park_Runs_Pct", "Park_Multiplier", "Park_Source_Status",
  "Away_Starter_Quality", "Home_Starter_Quality", "Blend_Park_Pitcher_Projected",
  "Blend_Park_Pitcher_Error", "Market_Line", "Edge_BLEND_PARK_PITCHER", "Replay_Run_TS",
];

export interface FrozenProjection {
  market_line: number | null;
  direction: string;
  projected_total: number;
  source?: "FROZEN_VEHICLE_LOG" | "PROSPECTIVE_DECISION_AUDIT";
}

export interface LowCenterProspectiveSnapshot {
  scheduled_first_pitch: string;
  base_projection: number;
  primary_projection: number;
  sensitivity_projection: number;
  snapshot_ts: string;
}

/** Immutable, timestamp-validated Statcast collision record. */
export interface CollisionProspectiveSnapshot {
  scheduled_first_pitch: string;
  base_away_projection: number;
  base_home_projection: number;
  base_projection: number;
  collision_away_evidence_projection: number | null;
  collision_home_evidence_projection: number | null;
  xwoba_shadow_projection: number | null;
  xwoba_away_evidence_projection: number | null;
  xwoba_home_evidence_projection: number | null;
  traffic_away_evidence_projection: number | null;
  traffic_home_evidence_projection: number | null;
  damage_away_evidence_projection: number | null;
  damage_home_evidence_projection: number | null;
  collision_estimated_projection: number | null;
  traffic_conversion_estimate: number | null;
  hr_xbh_damage_estimate: number | null;
  combined_tail_adjustment: number | null;
  preview_availability: string;
  tail_estimate_status: string;
  candidate_status: string;
  snapshot_ts: string;
}

/** Immutable, timestamp-validated Module 09t candidate. Never reconstructed at settlement. */
export interface StarterSurvivalProspectiveSnapshot {
  scheduled_first_pitch: string;
  base_projected_total: number;
  starter_survival_adjusted_total: number;
  away_survival_workload: number;
  home_survival_workload: number;
  away_starter_fds: number;
  home_starter_fds: number;
  game_fds: number;
  snapshot_ts: string;
}

/** Immutable timestamp-validated SSAT v2 record. */
export interface StarterSurvivalV2ProspectiveSnapshot {
  scheduled_first_pitch: string;
  base_projected_total: number;
  ssat_v1_total: number | null;
  ssat_v2_total: number;
  away_survival_workload: number;
  home_survival_workload: number;
  away_failure_shortfall: number;
  home_failure_shortfall: number;
  away_failure_run_cost: number;
  home_failure_run_cost: number;
  away_starter_fds: number;
  home_starter_fds: number;
  game_fds: number;
  calibration_cohort: string;
  snapshot_ts: string;
}

export interface ProspectiveSnapshotParseResult {
  snapshots: Map<string, FrozenProjection>;
  warnings: string[];
}

/**
 * The packet is the authoritative pregame record once it has frozen.  This
 * narrow type deliberately excludes all current-model inputs so settlement
 * cannot accidentally import a postgame projection while repairing starter
 * provenance.
 */
export interface FrozenPacketStarterSnapshot {
  away_starter: string;
  home_starter: string;
  packet_snapshot_ts: string;
  freeze_ts: string;
}

/**
 * A price-provenance snapshot carried from the immutable pregame packet.
 * `reference_*` is the automated board observation; `executable_*` exists
 * only when a timestamp-valid operator Hard Rock line was supplied before
 * first pitch. Neither is a projection input.
 */
export interface FrozenPacketMarketSnapshot {
  reference_market_line: number | null;
  reference_market_source: string;
  reference_market_ts: string;
  executable_market_line: number | null;
  executable_market_source: string;
  executable_market_ts: string;
  primary_grade_market_line: number | null;
  primary_grade_market_source: string;
  primary_grade_market_status: string;
  packet_snapshot_ts: string;
  freeze_ts: string;
}

function isLegitimateFrozenPacket(row: unknown[], date: string): boolean {
  if (String(row[P_DATE] ?? "") !== date) return false;
  const scheduledFirstPitch = starterName(row[P_SCHEDULED_FIRST_PITCH]);
  const packetSnapshotTs = starterName(row[P_SNAPSHOT_TS]);
  const freezeTs = starterName(row[P_FREEZE_TS]);
  const firstPitchMs = Date.parse(scheduledFirstPitch);
  const packetSnapshotMs = Date.parse(packetSnapshotTs);
  const freezeMs = Date.parse(freezeTs);
  return starterName(row[P_PACKET_STATUS]) === "FROZEN_PREGAME"
    && Number.isFinite(firstPitchMs)
    && Number.isFinite(packetSnapshotMs)
    && Number.isFinite(freezeMs)
    && packetSnapshotMs < firstPitchMs
    && freezeMs >= packetSnapshotMs;
}

export function selectProspectiveProjection(
  vehicle: FrozenProjection | undefined,
  auditSnapshot: FrozenProjection | undefined,
): FrozenProjection | undefined {
  return vehicle ?? auditSnapshot;
}

function starterName(value: unknown): string {
  return String(value ?? "").trim();
}

function isResolvedStarter(value: unknown): boolean {
  const normalized = starterName(value).toLowerCase();
  return normalized !== ""
    && normalized !== "unresolved"
    && normalized !== "unknown"
    && normalized !== "tbd"
    && normalized !== "n/a";
}

/**
 * Read only legitimately frozen packet snapshots. An OPEN packet remains
 * mutable evidence and a post-first-pitch snapshot is never eligible to
 * repair a settled row.
 */
export function parseFrozenPacketStarterSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, FrozenPacketStarterSnapshot> {
  const snapshots = new Map<string, FrozenPacketStarterSnapshot>();
  const latestSnapshotMs = new Map<string, number>();
  for (const row of rows) {
    const gameId = starterName(row[P_GAME_ID]);
    const packetSnapshotTs = starterName(row[P_SNAPSHOT_TS]);
    const freezeTs = starterName(row[P_FREEZE_TS]);
    const packetSnapshotMs = Date.parse(packetSnapshotTs);
    if (
      !gameId
      || !Number.isFinite(packetSnapshotMs)
      || !isLegitimateFrozenPacket(row, date)
      || packetSnapshotMs < (latestSnapshotMs.get(gameId) ?? Number.NEGATIVE_INFINITY)
    ) continue;

    snapshots.set(gameId, {
      away_starter: starterName(row[P_AWAY_STARTER]),
      home_starter: starterName(row[P_HOME_STARTER]),
      packet_snapshot_ts: packetSnapshotTs,
      freeze_ts: freezeTs,
    });
    latestSnapshotMs.set(gameId, packetSnapshotMs);
  }
  return snapshots;
}

/** Read market lineage only from a legitimately frozen, prospective packet. */
export function parseFrozenPacketMarketSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, FrozenPacketMarketSnapshot> {
  const snapshots = new Map<string, FrozenPacketMarketSnapshot>();
  const latestSnapshotMs = new Map<string, number>();
  for (const row of rows) {
    const gameId = starterName(row[P_GAME_ID]);
    const packetSnapshotTs = starterName(row[P_SNAPSHOT_TS]);
    const packetSnapshotMs = Date.parse(packetSnapshotTs);
    if (
      !gameId
      || !Number.isFinite(packetSnapshotMs)
      || !isLegitimateFrozenPacket(row, date)
      || packetSnapshotMs < (latestSnapshotMs.get(gameId) ?? Number.NEGATIVE_INFINITY)
    ) continue;

    const referenceMarketLine = numberOrNull(row[PACKET_INDEX.Reference_Market_Line])
      ?? numberOrNull(row[PACKET_INDEX.Market_Line]);
    const executableMarketLine = numberOrNull(row[PACKET_INDEX.Executable_Market_Line]);
    const primaryMarketLine = numberOrNull(row[PACKET_INDEX.Primary_Grade_Market_Line])
      ?? executableMarketLine
      ?? referenceMarketLine;
    const hasExecutable = executableMarketLine !== null;
    snapshots.set(gameId, {
      reference_market_line: referenceMarketLine,
      reference_market_source: starterName(row[PACKET_INDEX.Reference_Market_Source])
        || (referenceMarketLine === null ? "" : "LEGACY_PACKET_REFERENCE_MARKET"),
      reference_market_ts: starterName(row[PACKET_INDEX.Reference_Market_TS]) || packetSnapshotTs,
      executable_market_line: executableMarketLine,
      executable_market_source: starterName(row[PACKET_INDEX.Executable_Market_Source]),
      executable_market_ts: starterName(row[PACKET_INDEX.Executable_Market_TS]),
      primary_grade_market_line: primaryMarketLine,
      primary_grade_market_source: starterName(row[PACKET_INDEX.Primary_Grade_Market_Source])
        || (hasExecutable ? "MANUAL_OPERATOR_HARD_ROCK" : "LEGACY_PACKET_REFERENCE_MARKET"),
      primary_grade_market_status: starterName(row[PACKET_INDEX.Primary_Grade_Market_Status])
        || (hasExecutable ? "EXECUTABLE_OPERATOR_CAPTURED" : "REFERENCE_ONLY_FALLBACK"),
      packet_snapshot_ts: packetSnapshotTs,
      freeze_ts: starterName(row[P_FREEZE_TS]),
    });
    latestSnapshotMs.set(gameId, packetSnapshotMs);
  }
  return snapshots;
}

/**
 * Existing resolved outcome fields are immutable. A blank or explicitly
 * unresolved legacy value is not legitimate starter evidence, so it may be
 * repaired from the canonical frozen packet. SHADOW_HISTORY is only a legacy
 * fallback when no frozen packet exists; it must never override a packet.
 */
export function resolveProjectedStarter(
  existing: unknown,
  packetStarter: string | undefined,
  historyStarter: unknown,
): string {
  const existingStarter = starterName(existing);
  if (isResolvedStarter(existingStarter)) return existingStarter;
  if (packetStarter !== undefined) return starterName(packetStarter);
  const history = starterName(historyStarter);
  return isResolvedStarter(history) ? history : existingStarter || history;
}

export interface SettlementRow {
  date: string;
  game_id: string;
  /** Official MLB game identifier; diagnostic-only and never written as a pregame field. */
  game_pk?: number;
  away_team: string;
  home_team: string;
  repaired_projected_total: number;
  /** Official final away score. Used by DECISION_AUDIT_LOG allocation grading. */
  actual_away_runs: number;
  /** Official final home score. Used by DECISION_AUDIT_LOG allocation grading. */
  actual_home_runs: number;
  actual_total: number;
  error: number;
  abs_error: number;
  park_source_status: string;
  away_offense_source: string;
  home_offense_source: string;
  settlement_ts: string;
  frozen_published_total: number | null;
  frozen_error: number | null;
  frozen_abs_error: number | null;
  frozen_projection_source: string;
  repaired_minus_frozen: number | null;
  frozen_market_line: number | null;
  settlement_market_line: number | null;
  frozen_ticket_result: string;
  settlement_ticket_result: string;
  projection_audit_status: string;
  reference_market_line?: number | null;
  reference_market_source?: string;
  reference_market_ts?: string;
  executable_market_line?: number | null;
  executable_market_source?: string;
  executable_market_ts?: string;
  primary_grade_market_line?: number | null;
  primary_grade_market_source?: string;
  primary_market_grade_status?: string;
  primary_directional_result?: string;
  reference_directional_result?: string;
  projected_away_starter: string;
  projected_home_starter: string;
  actual_away_starter: string;
  actual_home_starter: string;
  /** Actual final-boxscore starter workloads; used only by the SSAT settlement report. */
  actual_away_starter_innings?: number | null;
  actual_home_starter_innings?: number | null;
  away_starter_match_status: PitcherMatchStatus;
  home_starter_match_status: PitcherMatchStatus;
  away_bulk_pitcher: string;
  home_bulk_pitcher: string;
  away_pitcher_chain: string;
  home_pitcher_chain: string;
  pitcher_provenance_status: PitcherProvenanceStatus;
  /** Timestamp-validated shadow candidate; never reconstructed during settlement. */
  low_center_snapshot?: LowCenterProspectiveSnapshot;
  /** Timestamp-validated collision candidate; never recreated at settlement. */
  collision_snapshot?: CollisionProspectiveSnapshot;
  /** Timestamp-validated four-state candidate; never reconstructed during settlement. */
  starter_survival_snapshot?: StarterSurvivalProspectiveSnapshot;
  starter_survival_v2_snapshot?: StarterSurvivalV2ProspectiveSnapshot;
  /** Optional audited event evidence. Absence must not be inferred from the final score. */
  postmortem_event_evidence?: PostmortemEventEvidence;
}

export interface SettlementResult {
  status: "success" | "partial" | "failure";
  settle_date: string;
  settlement_timestamp_utc: string;
  games_found: number;
  games_settled: number;
  games_updated: number;
  games_skipped: number;
  games_no_actual: number;
  games_provenance_incomplete: number;
  rows: SettlementRow[];
  warnings: string[];
  errors: string[];
}

interface MlbGame {
  gamePk?: number;
  officialDate?: string;
  gameNumber?: number;
  status?: { abstractGameState?: string };
  teams?: {
    away?: { score?: number; team?: { name?: string } };
    home?: { score?: number; team?: { name?: string } };
  };
}

interface FinalGame {
  game_pk: number;
  actual_away_runs: number;
  actual_home_runs: number;
  actual_total: number;
  provenance: GamePitcherProvenance;
}

/** An official final paired with the same canonical identity fields as a packet. */
export interface FinalGameIdentityCandidate extends FinalGame {
  legacy_game_id: string;
  gameNumber: number | null;
}

const FULL_NAME_TO_ABBR: Record<string, string> = {};
for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
  FULL_NAME_TO_ABBR[full_name.toLowerCase()] = canonical_abbr;
}
const athletics = Object.entries(FULL_NAME_TO_ABBR).find(([name]) => name.includes("athletics"));
if (athletics) FULL_NAME_TO_ABBR.athletics = athletics[1];

function teamNameToAbbr(name: string): string | null {
  const lower = name.toLowerCase().trim();
  if (FULL_NAME_TO_ABBR[lower]) return FULL_NAME_TO_ABBR[lower]!;
  const parts = lower.split(" ");
  for (let index = parts.length - 1; index >= 0; index--) {
    const candidate = parts.slice(index).join(" ");
    if (FULL_NAME_TO_ABBR[candidate]) return FULL_NAME_TO_ABBR[candidate]!;
  }
  return null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Frostline-Settlement/1.0" },
    });
    if (!response.ok) throw new Error(`MLB API ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Index official finals by the canonical Game_ID used by pregame packets.
 *
 * Never reduce a final to away/home alone: that silently overwrites Game 1
 * with Game 2 in a same-day doubleheader. An unresolved identity is omitted
 * rather than guessed, so settlement remains ungradable instead of misbound.
 */
export function indexFinalGamesByCanonicalGameId(
  finals: readonly FinalGameIdentityCandidate[],
  warnings: string[],
): Map<string, FinalGame> {
  const indexed = new Map<string, FinalGame>();
  const rejectedIds = new Set<string>();

  const canonicalFinals = assignUniqueGameIds(finals.map((game) => ({
    ...game,
    gamePk: game.game_pk,
  })));
  for (const game of canonicalFinals) {
    const gameId = game.legacy_game_id;
    if (rejectedIds.has(gameId)) continue;
    if (indexed.has(gameId)) {
      indexed.delete(gameId);
      rejectedIds.add(gameId);
      warnings.push(`FINAL_GAME_ID_COLLISION: ${gameId} has multiple official finals; settlement rejected the identity rather than selecting one`);
      continue;
    }
    indexed.set(gameId, {
      game_pk: game.game_pk,
      actual_away_runs: game.actual_away_runs,
      actual_home_runs: game.actual_home_runs,
      actual_total: game.actual_total,
      provenance: game.provenance,
    });
  }

  return indexed;
}

async function fetchFinalGames(date: string, warnings: string[]): Promise<Map<string, FinalGame>> {
  const schedule = await fetchJson(
    `${MLB_API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=linescore`,
  ) as { dates?: Array<{ games?: MlbGame[] }> };

  const finals: Array<Omit<FinalGameIdentityCandidate, "provenance">> = [];
  for (const day of schedule.dates ?? []) {
    for (const game of day.games ?? []) {
      if (game.status?.abstractGameState !== "Final") continue;
      const awayScore = game.teams?.away?.score;
      const homeScore = game.teams?.home?.score;
      const away = teamNameToAbbr(game.teams?.away?.team?.name ?? "");
      const home = teamNameToAbbr(game.teams?.home?.team?.name ?? "");
      if (awayScore === undefined || homeScore === undefined || !away || !home || !game.gamePk) continue;
      const officialDate = game.officialDate ?? date;
      finals.push({
        legacy_game_id: `${officialDate.replace(/-/g, "")}_${away}_${home}`,
        game_pk: game.gamePk,
        gameNumber: Number.isInteger(game.gameNumber) ? game.gameNumber! : null,
        actual_away_runs: awayScore,
        actual_home_runs: homeScore,
        actual_total: awayScore + homeScore,
      });
    }
  }

  const resolved = await Promise.all(finals.map(async (game) => {
    try {
      const boxscore = await fetchJson(`${MLB_API}/game/${game.game_pk}/boxscore`);
      return { ...game, provenance: parseGamePitcherProvenance(boxscore) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Pitcher provenance unavailable for gamePk ${game.game_pk}: ${message}`);
      return { ...game, provenance: parseGamePitcherProvenance(null) };
    }
  }));

  return indexFinalGamesByCanonicalGameId(resolved, warnings);
}

export function settlementRowToValues(row: SettlementRow): unknown[] {
  return [
    row.date, row.game_id, row.away_team, row.home_team,
    row.repaired_projected_total, row.actual_total, row.error, row.abs_error,
    row.park_source_status, row.away_offense_source, row.home_offense_source, row.settlement_ts,
    row.frozen_published_total ?? "", row.frozen_error ?? "", row.frozen_abs_error ?? "",
    row.frozen_projection_source, row.repaired_minus_frozen ?? "",
    row.frozen_market_line ?? "", row.settlement_market_line ?? "",
    row.frozen_ticket_result, row.settlement_ticket_result, row.projection_audit_status,
    row.projected_away_starter, row.projected_home_starter,
    row.actual_away_starter, row.actual_home_starter,
    row.away_starter_match_status, row.home_starter_match_status,
    row.away_bulk_pitcher, row.home_bulk_pitcher,
    row.away_pitcher_chain, row.home_pitcher_chain, row.pitcher_provenance_status,
    row.reference_market_line ?? "", row.reference_market_source, row.reference_market_ts,
    row.executable_market_line ?? "", row.executable_market_source, row.executable_market_ts,
    row.primary_grade_market_line ?? "", row.primary_grade_market_source,
    row.primary_market_grade_status, row.primary_directional_result,
    row.reference_directional_result,
  ];
}

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function gradeDirection(direction: string, line: number | null, actual: number): string {
  if (line === null || direction === "NONE" || !direction) return "NO_BET";
  if (actual === line) return "PUSH";
  if (direction === "OVER") return actual > line ? "WIN" : "LOSS";
  if (direction === "UNDER") return actual < line ? "WIN" : "LOSS";
  return "NO_BET";
}

function isPreservedProspectiveSource(value: unknown): boolean {
  const source = String(value ?? "");
  return source === "FROZEN_VEHICLE_LOG" || source === "PROSPECTIVE_DECISION_AUDIT";
}

/**
 * Extract the last legitimate pre-first-pitch model snapshot from
 * DECISION_AUDIT_LOG. OPEN is intentionally valid here: it is the most recent
 * prospective observation for a game that never received a lock-time publish.
 * AUDIT_GAP rows and timestamps at/after first pitch are always rejected.
 */
export function parseProspectiveDecisionAuditSnapshots(
  rows: unknown[][],
  date: string,
): ProspectiveSnapshotParseResult {
  const snapshots = new Map<string, FrozenProjection>();
  const snapshotTimes = new Map<string, number>();
  const warnings: string[] = [];

  for (const row of rows) {
    if (String(row[0] ?? "") !== date) continue;
    const gameId = String(row[1] ?? "").trim();
    const status = String(row[7] ?? "").trim();
    if (!gameId || (status !== "OPEN" && status !== "FROZEN")) continue;

    const firstPitch = Date.parse(String(row[4] ?? ""));
    const modelTimestamp = Date.parse(String(row[16] ?? ""));
    const projectedTotal = numberOrNull(row[10]);
    if (
      !Number.isFinite(firstPitch)
      || !Number.isFinite(modelTimestamp)
      || modelTimestamp >= firstPitch
      || projectedTotal === null
    ) {
      warnings.push(
        `DECISION_AUDIT snapshot rejected for ${gameId}: missing/invalid projection or non-prospective timestamp`,
      );
      continue;
    }

    const priorTimestamp = snapshotTimes.get(gameId) ?? Number.NEGATIVE_INFINITY;
    if (modelTimestamp < priorTimestamp) continue;
    snapshots.set(gameId, {
      market_line: numberOrNull(row[11]),
      direction: String(row[12] ?? "NONE"),
      projected_total: projectedTotal,
      source: "PROSPECTIVE_DECISION_AUDIT",
    });
    snapshotTimes.set(gameId, modelTimestamp);
  }

  return { snapshots, warnings };
}

/**
 * Select the latest timestamp-validated low-center candidate for each game.
 * The calibration history is append-only, so this retains a genuine pregame
 * observation rather than deriving candidates from settlement-time state.
 */
export function parseLowCenterProspectiveSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, LowCenterProspectiveSnapshot> {
  const snapshots = new Map<string, LowCenterProspectiveSnapshot>();
  const latestTs = new Map<string, number>();
  for (const row of rows) {
    if (String(row[0] ?? "") !== date) continue;
    const gameId = String(row[1] ?? "").trim();
    const scheduledFirstPitch = String(row[4] ?? "");
    const snapshotTs = String(row[9] ?? "");
    const firstPitchMs = Date.parse(scheduledFirstPitch);
    const snapshotMs = Date.parse(snapshotTs);
    const base = numberOrNull(row[5]);
    const primary = numberOrNull(row[6]);
    const sensitivity = numberOrNull(row[7]);
    if (
      !gameId || !Number.isFinite(firstPitchMs) || !Number.isFinite(snapshotMs)
      || snapshotMs >= firstPitchMs || base === null || primary === null || sensitivity === null
    ) continue;
    if (snapshotMs < (latestTs.get(gameId) ?? Number.NEGATIVE_INFINITY)) continue;
    snapshots.set(gameId, {
      scheduled_first_pitch: scheduledFirstPitch,
      base_projection: base,
      primary_projection: primary,
      sensitivity_projection: sensitivity,
      snapshot_ts: snapshotTs,
    });
    latestTs.set(gameId, snapshotMs);
  }
  return snapshots;
}

function directionForProjection(projection: number | null, line: number | null): string {
  if (projection === null || line === null) return "NONE";
  if (projection > line) return "OVER";
  if (projection < line) return "UNDER";
  return "NONE";
}

export interface SettlementMarketGrade {
  reference_market_line: number | null;
  reference_market_source: string;
  reference_market_ts: string;
  executable_market_line: number | null;
  executable_market_source: string;
  executable_market_ts: string;
  primary_grade_market_line: number | null;
  primary_grade_market_source: string;
  primary_market_grade_status: string;
  primary_directional_result: string;
  reference_directional_result: string;
}

/**
 * Keep automated/reference and operator/executable market observations apart.
 * The primary line is the operator Hard Rock line only when it was captured in
 * the frozen packet; otherwise the reference line remains an explicit fallback.
 */
export function resolveSettlementMarketGrade(
  frozenProjection: number | null,
  actualTotal: number,
  packet: FrozenPacketMarketSnapshot | undefined,
  existing: unknown[] | undefined,
): SettlementMarketGrade {
  const legacyReferenceLine = numberOrNull(existing?.[O_REFERENCE_MARKET_LINE])
    ?? numberOrNull(existing?.[17]);
  const referenceMarketLine = packet?.reference_market_line
    ?? legacyReferenceLine;
  const referenceMarketSource = packet?.reference_market_source
    || starterName(existing?.[O_REFERENCE_MARKET_SOURCE])
    || (referenceMarketLine === null ? "" : "FROZEN_REFERENCE_MARKET");
  const referenceMarketTs = packet?.reference_market_ts
    || starterName(existing?.[O_REFERENCE_MARKET_TS]);
  const executableMarketLine = packet?.executable_market_line
    ?? numberOrNull(existing?.[O_EXECUTABLE_MARKET_LINE]);
  const executableMarketSource = packet?.executable_market_source
    || starterName(existing?.[O_EXECUTABLE_MARKET_SOURCE]);
  const executableMarketTs = packet?.executable_market_ts
    || starterName(existing?.[O_EXECUTABLE_MARKET_TS]);
  const primaryMarketLine = packet?.primary_grade_market_line
    ?? executableMarketLine
    ?? referenceMarketLine;
  const primaryMarketSource = packet?.primary_grade_market_source
    || starterName(existing?.[O_PRIMARY_MARKET_SOURCE])
    || (executableMarketLine === null
      ? referenceMarketLine === null ? "" : "FROZEN_REFERENCE_MARKET"
      : "MANUAL_OPERATOR_HARD_ROCK");
  const primaryMarketStatus = packet?.primary_grade_market_status
    || starterName(existing?.[O_PRIMARY_MARKET_STATUS])
    || (executableMarketLine === null
      ? referenceMarketLine === null ? "MISSING_MARKET" : "REFERENCE_ONLY_FALLBACK"
      : "EXECUTABLE_OPERATOR_CAPTURED");
  const primaryDirection = directionForProjection(frozenProjection, primaryMarketLine);
  const referenceDirection = directionForProjection(frozenProjection, referenceMarketLine);
  return {
    reference_market_line: referenceMarketLine,
    reference_market_source: referenceMarketSource,
    reference_market_ts: referenceMarketTs,
    executable_market_line: executableMarketLine,
    executable_market_source: executableMarketSource,
    executable_market_ts: executableMarketTs,
    primary_grade_market_line: primaryMarketLine,
    primary_grade_market_source: primaryMarketSource,
    primary_market_grade_status: primaryMarketStatus,
    primary_directional_result: gradeDirection(primaryDirection, primaryMarketLine, actualTotal),
    reference_directional_result: gradeDirection(referenceDirection, referenceMarketLine, actualTotal),
  };
}

/**
 * Read only pre-first-pitch collision records. A source-unavailable row is
 * retained with a non-candidate status for audit coverage, but its candidate
 * projection is deliberately null so settlement cannot grade a fake zero.
 */
export function parseCollisionProspectiveSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, CollisionProspectiveSnapshot> {
  const snapshots = new Map<string, CollisionProspectiveSnapshot>();
  const latestTs = new Map<string, number>();
  for (const row of rows) {
    if (String(row[0] ?? "") !== date) continue;
    const gameId = String(row[1] ?? "").trim();
    const scheduledFirstPitch = String(row[4] ?? "");
    const snapshotTs = String(row[18] ?? "");
    const firstPitchMs = Date.parse(scheduledFirstPitch);
    const snapshotMs = Date.parse(snapshotTs);
    const baseAway = numberOrNull(row[5]);
    const baseHome = numberOrNull(row[6]);
    const base = numberOrNull(row[7]);
    const candidateStatus = String(row[17] ?? "");
    const candidate = candidateStatus === "PROSPECTIVE_SHADOW_CANDIDATE"
      ? numberOrNull(row[14])
      : null;
    if (
      !gameId || !Number.isFinite(firstPitchMs) || !Number.isFinite(snapshotMs)
      || snapshotMs >= firstPitchMs || baseAway === null || baseHome === null || base === null
      || (candidateStatus === "PROSPECTIVE_SHADOW_CANDIDATE" && candidate === null)
    ) continue;
    if (snapshotMs < (latestTs.get(gameId) ?? Number.NEGATIVE_INFINITY)) continue;
    snapshots.set(gameId, {
      scheduled_first_pitch: scheduledFirstPitch,
      base_away_projection: baseAway,
      base_home_projection: baseHome,
      base_projection: base,
      collision_away_evidence_projection: candidate === null ? null : numberOrNull(row[8]),
      collision_home_evidence_projection: candidate === null ? null : numberOrNull(row[9]),
      xwoba_shadow_projection: candidate === null ? null : numberOrNull(row[10]),
      xwoba_away_evidence_projection: candidate === null ? null : numberOrNull(row[19]),
      xwoba_home_evidence_projection: candidate === null ? null : numberOrNull(row[20]),
      traffic_away_evidence_projection: candidate === null ? null : numberOrNull(row[21]),
      traffic_home_evidence_projection: candidate === null ? null : numberOrNull(row[22]),
      damage_away_evidence_projection: candidate === null ? null : numberOrNull(row[23]),
      damage_home_evidence_projection: candidate === null ? null : numberOrNull(row[24]),
      collision_estimated_projection: candidate,
      traffic_conversion_estimate: candidate === null ? null : numberOrNull(row[11]),
      hr_xbh_damage_estimate: candidate === null ? null : numberOrNull(row[12]),
      combined_tail_adjustment: candidate === null ? null : numberOrNull(row[13]),
      preview_availability: String(row[15] ?? "UNAVAILABLE"),
      tail_estimate_status: String(row[16] ?? "UNAVAILABLE"),
      candidate_status: candidateStatus || "INSUFFICIENT_INPUT",
      snapshot_ts: snapshotTs,
    });
    latestTs.set(gameId, snapshotMs);
  }
  return snapshots;
}

/**
 * Selects only a genuine pre-first-pitch Module 09t record.  Settlement must
 * never create a candidate from a completed game's current data.
 */
export function parseStarterSurvivalProspectiveSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, StarterSurvivalProspectiveSnapshot> {
  const snapshots = new Map<string, StarterSurvivalProspectiveSnapshot>();
  const latestTs = new Map<string, number>();
  for (const row of rows) {
    if (String(row[0] ?? "") !== date) continue;
    const gameId = String(row[1] ?? "").trim();
    const scheduledFirstPitch = String(row[2] ?? "");
    const snapshotTs = String(row[20] ?? "");
    const firstPitchMs = Date.parse(scheduledFirstPitch);
    const snapshotMs = Date.parse(snapshotTs);
    const status = String(row[21] ?? "");
    const base = numberOrNull(row[3]);
    const ssat = numberOrNull(row[4]);
    const awayWorkload = numberOrNull(row[5]);
    const homeWorkload = numberOrNull(row[6]);
    const awayFds = numberOrNull(row[17]);
    const homeFds = numberOrNull(row[18]);
    const gameFds = numberOrNull(row[19]);
    if (
      !gameId || status !== "PROSPECTIVE_SHADOW_CANDIDATE"
      || !Number.isFinite(firstPitchMs) || !Number.isFinite(snapshotMs) || snapshotMs >= firstPitchMs
      || base === null || ssat === null || awayWorkload === null || homeWorkload === null
      || awayFds === null || homeFds === null || gameFds === null
    ) continue;
    if (snapshotMs < (latestTs.get(gameId) ?? Number.NEGATIVE_INFINITY)) continue;
    snapshots.set(gameId, {
      scheduled_first_pitch: scheduledFirstPitch,
      base_projected_total: base,
      starter_survival_adjusted_total: ssat,
      away_survival_workload: awayWorkload,
      home_survival_workload: homeWorkload,
      away_starter_fds: awayFds,
      home_starter_fds: homeFds,
      game_fds: gameFds,
      snapshot_ts: snapshotTs,
    });
    latestTs.set(gameId, snapshotMs);
  }
  return snapshots;
}

/** Reads only preserved SSAT v2 observations; never recalculates one at settlement. */
export function parseStarterSurvivalV2ProspectiveSnapshots(
  rows: unknown[][],
  date: string,
): Map<string, StarterSurvivalV2ProspectiveSnapshot> {
  const snapshots = new Map<string, StarterSurvivalV2ProspectiveSnapshot>();
  const latestTs = new Map<string, number>();
  for (const row of rows) {
    if (String(row[0] ?? "") !== date) continue;
    const gameId = String(row[1] ?? "").trim();
    const scheduledFirstPitch = String(row[2] ?? "");
    const snapshotTs = String(row[30] ?? "");
    const firstPitchMs = Date.parse(scheduledFirstPitch);
    const snapshotMs = Date.parse(snapshotTs);
    const status = String(row[31] ?? "");
    const base = numberOrNull(row[3]);
    const v2 = numberOrNull(row[5]);
    const awayWorkload = numberOrNull(row[8]);
    const homeWorkload = numberOrNull(row[9]);
    const awayShortfall = numberOrNull(row[14]);
    const homeShortfall = numberOrNull(row[15]);
    const awayRunCost = numberOrNull(row[16]);
    const homeRunCost = numberOrNull(row[17]);
    const awayFds = numberOrNull(row[26]);
    const homeFds = numberOrNull(row[27]);
    const gameFds = numberOrNull(row[28]);
    if (
      !gameId || status !== "PROSPECTIVE_SHADOW_CANDIDATE"
      || !Number.isFinite(firstPitchMs) || !Number.isFinite(snapshotMs) || snapshotMs >= firstPitchMs
      || base === null || v2 === null || awayWorkload === null || homeWorkload === null
      || awayShortfall === null || homeShortfall === null || awayRunCost === null || homeRunCost === null
      || awayFds === null || homeFds === null || gameFds === null
    ) continue;
    if (snapshotMs < (latestTs.get(gameId) ?? Number.NEGATIVE_INFINITY)) continue;
    snapshots.set(gameId, {
      scheduled_first_pitch: scheduledFirstPitch,
      base_projected_total: base,
      ssat_v1_total: numberOrNull(row[4]),
      ssat_v2_total: v2,
      away_survival_workload: awayWorkload,
      home_survival_workload: homeWorkload,
      away_failure_shortfall: awayShortfall,
      home_failure_shortfall: homeShortfall,
      away_failure_run_cost: awayRunCost,
      home_failure_run_cost: homeRunCost,
      away_starter_fds: awayFds,
      home_starter_fds: homeFds,
      game_fds: gameFds,
      calibration_cohort: String(row[29] ?? ""),
      snapshot_ts: snapshotTs,
    });
    latestTs.set(gameId, snapshotMs);
  }
  return snapshots;
}

function frozenAuditValues(
  repairedProjection: number,
  actualTotal: number,
  projection: FrozenProjection | undefined,
  existing?: unknown[],
  recomputeSettlementDerived = false,
): unknown[] {
  const hasPreservedSource = isPreservedProspectiveSource(existing?.[O_FROZEN_SOURCE]);
  // Reading or migrating unrelated historical outcome rows must not rewrite
  // their grading. A date-scoped settlement repair explicitly opts in below,
  // after it has obtained that game's canonical official final.
  if (hasPreservedSource && !recomputeSettlementDerived) return existing!.slice(12, 22);
  const preservedFrozenTotal = numberOrNull(existing?.[O_FROZEN_PUBLISHED_TOTAL]);
  if (hasPreservedSource && preservedFrozenTotal === null) {
    // A preserved source without its frozen value is an integrity gap. Do not
    // substitute a current vehicle or audit value under its historical label.
    return ["", "", "", "INVALID_PRESERVED_FROZEN_VALUE", "", "", "", "", "", "FROZEN_SOURCE_UNRESOLVED"];
  }
  if (!hasPreservedSource && !projection) {
    return ["", "", "", "MISSING_FROZEN_VEHICLE_LOG", "", "", "", "", "", "FROZEN_SOURCE_UNRESOLVED"];
  }
  // The projection, its source, and its frozen market are prospective facts.
  // Error, absolute error, and ticket grading are settlement-derived values.
  // Recompute only the latter on every rerun, so a repaired official final
  // cannot leave a stale outcome attached to immutable pregame evidence.
  const frozenTotal = hasPreservedSource ? preservedFrozenTotal! : projection!.projected_total;
  const source = hasPreservedSource
    ? String(existing?.[O_FROZEN_SOURCE] ?? "")
    : projection!.source ?? "FROZEN_VEHICLE_LOG";
  const preservedLine = numberOrNull(existing?.[O_FROZEN_MARKET_LINE]);
  const line = hasPreservedSource ? preservedLine : projection!.market_line;
  const direction = projection?.direction ?? "";
  const frozenError = round2(frozenTotal - actualTotal);
  const delta = round2(repairedProjection - frozenTotal);
  const result = direction === "OVER" || direction === "UNDER"
    ? gradeDirection(direction, line, actualTotal)
    : String(existing?.[O_FROZEN_TICKET_RESULT] ?? "");
  return [
    frozenTotal,
    frozenError,
    round2(Math.abs(frozenError)),
    source,
    delta,
    line ?? "",
    line ?? "",
    result,
    result,
    Math.abs(delta) < 0.005 ? "MATCHES_PUBLISHED" : "REPAIRED_DIFFERS_FROM_PUBLISHED",
  ];
}

export function classifyFrozenVehicleGap(
  date: string,
  gameId: string,
  hasFrozenProspectiveState: boolean,
): { warning?: string; error?: string } {
  if (hasFrozenProspectiveState) return {};
  const message = `PREGAME_FREEZE_MISSING/AUDIT_GAP: ${gameId} has no preserved prospective projection snapshot`;
  // Fail closed means: never reconstruct or silently grade a missing
  // prospective value.  It does not mean an otherwise successful settlement
  // should fail merely for truthfully recording a known partial-pregame scope.
  // The per-game outcome remains explicitly ungradable through
  // FROZEN_SOURCE_UNRESOLVED, while a missing *decision-audit row* still fails
  // the settlement chain in Module 20.
  return date < FROZEN_VEHICLE_REQUIRED_FROM_DATE
    ? { warning: `LEGACY_${message}` }
    : { warning: message };
}

/** Migrate either legacy frozen-audit M:V rows or v16 pitcher M:W rows. */
export function normalizeOutcomeValues(
  raw: unknown[],
  vehicle?: FrozenProjection,
  recomputeSettlementDerived = false,
): unknown[] {
  const base = raw.slice(0, 12);
  while (base.length < 12) base.push("");
  const repaired = numberOrNull(base[4]) ?? 0;
  const actual = numberOrNull(base[5]) ?? 0;
  const hasCombinedLayout = String(raw[32] ?? "") !== "";
  const hasLegacyFrozenLayout = isPreservedProspectiveSource(raw[15]);
  const pitcher = hasCombinedLayout
    ? raw.slice(22, 33)
    : hasLegacyFrozenLayout
      ? Array(11).fill("")
      : raw.slice(12, 23);
  while (pitcher.length < 11) pitcher.push("");
  const frozen = frozenAuditValues(repaired, actual, vehicle, raw, recomputeSettlementDerived);
  // Market-provenance columns were added after the original 33-column
  // outcome layout. Preserve them verbatim on normalization so a settlement
  // rerun cannot erase a legitimately frozen executable line.
  const market = raw.slice(O_REFERENCE_MARKET_LINE, OUTCOMES_COLS);
  while (market.length < OUTCOMES_COLS - O_REFERENCE_MARKET_LINE) market.push("");
  return [...base, ...frozen, ...pitcher, ...market].slice(0, OUTCOMES_COLS);
}

function combinedProvenanceStatus(
  actualStatus: PitcherProvenanceStatus,
  awayMatch: PitcherMatchStatus,
  homeMatch: PitcherMatchStatus,
): PitcherProvenanceStatus {
  if (actualStatus !== "COMPLETE") return actualStatus;
  return awayMatch === "UNRESOLVED" || homeMatch === "UNRESOLVED" ? "PARTIAL" : "COMPLETE";
}

export function frozenProjectionReplayValues(row: SettlementRow, ts: string): unknown[] | null {
  const frozen = row.frozen_published_total;
  const error = row.frozen_error;
  if (frozen === null || error === null) return null;
  return [
    // Settlement must carry the prospective Game_ID forward verbatim. Rebuilding
    // it from the team pair collapses same-day doubleheaders in PROJECTION_REPLAY.
    row.date, row.game_id,
    row.away_team, row.home_team, row.actual_total,
    frozen, frozen, frozen, frozen, frozen,
    error, error, error, error, error,
    "", "", "", "", row.away_offense_source, row.home_offense_source,
    "", "", row.frozen_projection_source, "", "", frozen, error,
    row.frozen_market_line ?? "",
    row.frozen_market_line === null ? "" : round2(frozen - row.frozen_market_line),
    ts,
  ];
}

async function upsertFrozenProjectionReplay(
  workbookId: string,
  date: string,
  rows: SettlementRow[],
  ts: string,
): Promise<void> {
  const response = await readRange(workbookId, `${PROJECTION_REPLAY_SHEET}!A1:AE5000`).catch(() => ({ values: [] }));
  const existing = ((response.values ?? []) as unknown[][]).slice(1);
  const retained = existing.filter((value) => String(value[0] ?? "") !== date);
  const replacements = rows.map((row) => frozenProjectionReplayValues(row, ts)).filter((row): row is unknown[] => row !== null);
  await expandSheetColumns(workbookId, PROJECTION_REPLAY_SHEET, PROJECTION_REPLAY_HEADER.length);
  await writeRange(workbookId, `${PROJECTION_REPLAY_SHEET}!A1`, [PROJECTION_REPLAY_HEADER, ...retained, ...replacements]);
}

function lowCenterCalibrationValues(row: SettlementRow): unknown[] | null {
  const snapshot = row.low_center_snapshot;
  if (!snapshot) return null;
  const baseError = round2(snapshot.base_projection - row.actual_total);
  const primaryError = round2(snapshot.primary_projection - row.actual_total);
  const sensitivityError = round2(snapshot.sensitivity_projection - row.actual_total);
  return [
    row.date, row.game_id, row.away_team, row.home_team, snapshot.scheduled_first_pitch,
    snapshot.base_projection, snapshot.primary_projection, snapshot.sensitivity_projection,
    row.actual_total, baseError, primaryError, sensitivityError,
    round2(Math.abs(baseError)), round2(Math.abs(primaryError)), round2(Math.abs(sensitivityError)),
    snapshot.snapshot_ts, row.settlement_ts, "PROSPECTIVE_SHADOW_CANDIDATE",
  ];
}

async function upsertLowCenterCalibrationReport(
  workbookId: string,
  date: string,
  rows: SettlementRow[],
): Promise<void> {
  let allRows: unknown[][] = [];
  try {
    allRows = (await readRange(workbookId, `${LOW_CENTER_REPORT_SHEET}!A1:R5000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, LOW_CENTER_REPORT_SHEET);
  }
  const retained = allRows.slice(1).filter((row) => String(row[0] ?? "") !== date);
  const replacements = rows.map(lowCenterCalibrationValues).filter((row): row is unknown[] => row !== null);
  await expandSheetColumns(workbookId, LOW_CENTER_REPORT_SHEET, LOW_CENTER_CALIBRATION_REPORT_HEADER.length);
  await writeRange(workbookId, `${LOW_CENTER_REPORT_SHEET}!A1`, [
    LOW_CENTER_CALIBRATION_REPORT_HEADER,
    ...retained,
    ...replacements,
  ]);
}

/** Settlement values for a preserved collision candidate, never a replay. */
export function collisionCalibrationValues(row: SettlementRow): unknown[] {
  const snapshot = row.collision_snapshot;
  if (!snapshot) {
    const base = row.frozen_published_total;
    const baseError = base === null ? null : round2(base - row.actual_total);
    return [
      row.date, row.game_id, row.away_team, row.home_team, "",
      "", "", base ?? "", "", "", "", "", "", "", "UNAVAILABLE", "UNAVAILABLE",
      row.actual_away_runs, row.actual_home_runs, row.actual_total,
      baseError ?? "", baseError === null ? "" : round2(Math.abs(baseError)), "", "", "NO_BET", "NO_BET",
      "", row.settlement_ts, "PREGAME_SNAPSHOT_MISSING",
      "", "", "", "", "", "", "", "", "", "", row.frozen_market_line ?? "",
    ];
  }
  const baseError = round2(snapshot.base_projection - row.actual_total);
  const candidate = snapshot.collision_estimated_projection;
  const collisionError = candidate === null ? null : round2(candidate - row.actual_total);
  const status = candidate === null
    ? `SETTLED_${snapshot.candidate_status}`
    : "SETTLED";
  return [
    row.date, row.game_id, row.away_team, row.home_team, snapshot.scheduled_first_pitch,
    snapshot.base_away_projection, snapshot.base_home_projection, snapshot.base_projection,
    snapshot.collision_away_evidence_projection ?? "", snapshot.collision_home_evidence_projection ?? "",
    candidate ?? "", snapshot.traffic_conversion_estimate ?? "", snapshot.hr_xbh_damage_estimate ?? "",
    snapshot.combined_tail_adjustment ?? "", snapshot.preview_availability, snapshot.tail_estimate_status,
    row.actual_away_runs, row.actual_home_runs, row.actual_total,
    baseError, round2(Math.abs(baseError)), collisionError ?? "", collisionError === null ? "" : round2(Math.abs(collisionError)),
    gradeDirection(directionForProjection(snapshot.base_projection, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    candidate === null ? "NO_BET" : gradeDirection(directionForProjection(candidate, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    snapshot.snapshot_ts, row.settlement_ts, status,
    snapshot.xwoba_shadow_projection ?? "",
    snapshot.traffic_conversion_estimate === null ? "" : round2(snapshot.base_projection + snapshot.traffic_conversion_estimate),
    snapshot.hr_xbh_damage_estimate === null ? "" : round2(snapshot.base_projection + snapshot.hr_xbh_damage_estimate),
    snapshot.combined_tail_adjustment === null ? "" : round2(snapshot.base_projection + snapshot.combined_tail_adjustment),
    snapshot.xwoba_away_evidence_projection ?? "", snapshot.xwoba_home_evidence_projection ?? "",
    snapshot.traffic_away_evidence_projection ?? "", snapshot.traffic_home_evidence_projection ?? "",
    snapshot.damage_away_evidence_projection ?? "", snapshot.damage_home_evidence_projection ?? "",
    row.frozen_market_line ?? "",
  ];
}

async function upsertCollisionCalibrationReport(
  workbookId: string,
  date: string,
  rows: SettlementRow[],
): Promise<void> {
  let allRows: unknown[][] = [];
  try {
    allRows = (await readRange(workbookId, `${COLLISION_REPORT_SHEET}!A1:AM5000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, COLLISION_REPORT_SHEET);
  }
  const retained = allRows.slice(1).filter((value) => String(value[0] ?? "") !== date);
  await expandSheetColumns(workbookId, COLLISION_REPORT_SHEET, COLLISION_CALIBRATION_REPORT_HEADER.length);
  await writeRange(workbookId, `${COLLISION_REPORT_SHEET}!A1`, [
    COLLISION_CALIBRATION_REPORT_HEADER,
    ...retained,
    ...rows.map(collisionCalibrationValues),
  ]);
}

function survivalResult(actualIp: number | null, projectedWorkload: number): "SURVIVED" | "FAILED" | "UNAVAILABLE" {
  if (actualIp === null) return "UNAVAILABLE";
  return actualIp >= projectedWorkload ? "SURVIVED" : "FAILED";
}

export function starterSurvivalCalibrationValues(row: SettlementRow): unknown[] | null {
  const snapshot = row.starter_survival_snapshot;
  if (!snapshot) {
    // Explicit gap record, not a recreated challenger. This preserves the
    // distinction between no candidate and a candidate that performed poorly.
    return [
      row.date, row.game_id, row.away_team, row.home_team, "",
      "", "", row.actual_total, "", "", "", "", "", "",
      row.actual_away_starter_innings ?? "", row.actual_home_starter_innings ?? "",
      "UNAVAILABLE", "UNAVAILABLE", "", "", "", "", row.settlement_ts,
      "PREGAME_SNAPSHOT_MISSING",
    ];
  }
  const baseError = round2(snapshot.base_projected_total - row.actual_total);
  const ssatError = round2(snapshot.starter_survival_adjusted_total - row.actual_total);
  const actualAwayIp = row.actual_away_starter_innings ?? null;
  const actualHomeIp = row.actual_home_starter_innings ?? null;
  return [
    row.date, row.game_id, row.away_team, row.home_team, snapshot.scheduled_first_pitch,
    snapshot.base_projected_total, snapshot.starter_survival_adjusted_total, row.actual_total,
    baseError, round2(Math.abs(baseError)), ssatError, round2(Math.abs(ssatError)),
    gradeDirection(directionForProjection(snapshot.base_projected_total, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    gradeDirection(directionForProjection(snapshot.starter_survival_adjusted_total, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    actualAwayIp ?? "", actualHomeIp ?? "",
    survivalResult(actualAwayIp, snapshot.away_survival_workload),
    survivalResult(actualHomeIp, snapshot.home_survival_workload),
    snapshot.away_starter_fds, snapshot.home_starter_fds, snapshot.game_fds,
    snapshot.snapshot_ts, row.settlement_ts,
    actualAwayIp === null || actualHomeIp === null ? "SETTLED_PROVENANCE_INCOMPLETE" : "SETTLED",
  ];
}

async function upsertStarterSurvivalCalibrationReport(
  workbookId: string,
  date: string,
  rows: SettlementRow[],
): Promise<void> {
  let allRows: unknown[][] = [];
  try {
    allRows = (await readRange(workbookId, `${STARTER_SURVIVAL_REPORT_SHEET}!A1:X5000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, STARTER_SURVIVAL_REPORT_SHEET);
  }
  const retained = allRows.slice(1).filter((value) => String(value[0] ?? "") !== date);
  const replacements = rows.map(starterSurvivalCalibrationValues).filter((value): value is unknown[] => value !== null);
  await expandSheetColumns(workbookId, STARTER_SURVIVAL_REPORT_SHEET, STARTER_SURVIVAL_CALIBRATION_REPORT_HEADER.length);
  await writeRange(workbookId, `${STARTER_SURVIVAL_REPORT_SHEET}!A1`, [
    STARTER_SURVIVAL_CALIBRATION_REPORT_HEADER,
    ...retained,
    ...replacements,
  ]);
}

export function starterSurvivalV2CalibrationValues(row: SettlementRow): unknown[] {
  const snapshot = row.starter_survival_v2_snapshot;
  if (!snapshot) {
    return [
      row.date, row.game_id, row.away_team, row.home_team, "", "", "", "", row.actual_total,
      "", "", "", "", "", "", "", "", "",
      row.actual_away_starter_innings ?? "", row.actual_home_starter_innings ?? "", "UNAVAILABLE", "UNAVAILABLE",
      "", "", "", "", "", "", "", "", "", row.settlement_ts, "PREGAME_SNAPSHOT_MISSING",
    ];
  }
  const baseError = round2(snapshot.base_projected_total - row.actual_total);
  const v1Error = snapshot.ssat_v1_total === null ? null : round2(snapshot.ssat_v1_total - row.actual_total);
  const v2Error = round2(snapshot.ssat_v2_total - row.actual_total);
  const actualAwayIp = row.actual_away_starter_innings ?? null;
  const actualHomeIp = row.actual_home_starter_innings ?? null;
  return [
    row.date, row.game_id, row.away_team, row.home_team, snapshot.scheduled_first_pitch,
    snapshot.base_projected_total, snapshot.ssat_v1_total ?? "", snapshot.ssat_v2_total, row.actual_total,
    baseError, round2(Math.abs(baseError)), v1Error ?? "", v1Error === null ? "" : round2(Math.abs(v1Error)), v2Error, round2(Math.abs(v2Error)),
    gradeDirection(directionForProjection(snapshot.base_projected_total, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    snapshot.ssat_v1_total === null ? "NO_BET" : gradeDirection(directionForProjection(snapshot.ssat_v1_total, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    gradeDirection(directionForProjection(snapshot.ssat_v2_total, row.frozen_market_line), row.frozen_market_line, row.actual_total),
    actualAwayIp ?? "", actualHomeIp ?? "",
    survivalResult(actualAwayIp, snapshot.away_survival_workload), survivalResult(actualHomeIp, snapshot.home_survival_workload),
    snapshot.away_failure_shortfall, snapshot.home_failure_shortfall, snapshot.away_failure_run_cost, snapshot.home_failure_run_cost,
    snapshot.away_starter_fds, snapshot.home_starter_fds, snapshot.game_fds, snapshot.calibration_cohort,
    snapshot.snapshot_ts, row.settlement_ts,
    actualAwayIp === null || actualHomeIp === null ? "SETTLED_PROVENANCE_INCOMPLETE" : "SETTLED",
  ];
}

async function upsertStarterSurvivalV2CalibrationReport(
  workbookId: string,
  date: string,
  rows: SettlementRow[],
): Promise<void> {
  let allRows: unknown[][] = [];
  try {
    allRows = (await readRange(workbookId, `${STARTER_SURVIVAL_V2_REPORT_SHEET}!A1:AH5000`)).values ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    await addSheet(workbookId, STARTER_SURVIVAL_V2_REPORT_SHEET);
  }
  const retained = allRows.slice(1).filter((value) => String(value[0] ?? "") !== date);
  await expandSheetColumns(workbookId, STARTER_SURVIVAL_V2_REPORT_SHEET, STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER.length);
  await writeRange(workbookId, `${STARTER_SURVIVAL_V2_REPORT_SHEET}!A1`, [
    STARTER_SURVIVAL_V2_CALIBRATION_REPORT_HEADER,
    ...retained,
    ...rows.map(starterSurvivalV2CalibrationValues),
  ]);
}

function failedResult(date: string, ts: string, errors: string[]): SettlementResult {
  return {
    status: "failure", settle_date: date, settlement_timestamp_utc: ts,
    games_found: 0, games_settled: 0, games_updated: 0, games_skipped: 0,
    games_no_actual: 0, games_provenance_incomplete: 0,
    rows: [], warnings: [], errors,
  };
}

export async function runShadowSettlement(
  date: string,
  options: { workbookId?: string } = {},
): Promise<SettlementResult> {
  const ts = new Date().toISOString();
  const wbId = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];
  const warnings: string[] = [];

  logger.info({ date }, "MODULE_14: Shadow settlement starting");

  let historyRows: string[][];
  try {
    const response = await readRange(wbId, `${HISTORY_SHEET}!A1:W5000`);
    const latestByGame = new Map<string, string[]>();
    for (const row of ((response.values ?? []) as string[][]).slice(1)) {
      if ((row[H_DATE] ?? "") !== date || !(row[H_GAME_ID] ?? "")) continue;
      latestByGame.set(row[H_GAME_ID]!, row);
    }
    historyRows = [...latestByGame.values()];
  } catch (error: unknown) {
    errors.push(`SHADOW_HISTORY read failed: ${error instanceof Error ? error.message : String(error)}`);
    return failedResult(date, ts, errors);
  }

  const gamesFound = historyRows.length;
  if (gamesFound === 0) {
    return { ...failedResult(date, ts, []), status: "success", games_found: 0 };
  }

  // SHADOW_HISTORY is retained for legacy settlement compatibility, but a
  // FROZEN_PREGAME packet is the canonical provenance surface for starters.
  // This read is deliberately best-effort so pre-packet historical dates can
  // still settle truthfully as incomplete rather than failing wholesale.
  const frozenPacketStartersByGame = new Map<string, FrozenPacketStarterSnapshot>();
  const frozenPacketMarketsByGame = new Map<string, FrozenPacketMarketSnapshot>();
  try {
    const response = await readRange(wbId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(5000)}`);
    const normalizedPacketRows = normalizePregamePacketHistoryRows(
      (response.values ?? []) as unknown[][],
    );
    const packetRows = normalizedPacketRows.rows;
    if (normalizedPacketRows.headerMigrated) {
      warnings.push("PREGAME_PACKET_HEADER_REINDEXED_IN_MEMORY: settlement used stored column names before packet parsing");
    }
    for (const [gameId, snapshot] of parseFrozenPacketStarterSnapshots(packetRows, date)) {
      frozenPacketStartersByGame.set(gameId, snapshot);
    }
    for (const [gameId, snapshot] of parseFrozenPacketMarketSnapshots(packetRows, date)) {
      frozenPacketMarketsByGame.set(gameId, snapshot);
    }
  } catch (error: unknown) {
    warnings.push(`PREGAME_PACKET_HISTORY provenance read unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const vehiclesByGame = new Map<string, FrozenProjection>();
  try {
    const response = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:Q5000`);
    const vehicleIntegrity = selectCanonicalVehicleRows(((response.values ?? []) as unknown[][]).slice(1));
    warnings.push(...vehicleIntegrity.warnings);
    for (const row of vehicleIntegrity.rows) {
      const gameId = String(row[1] ?? "");
      const projected = numberOrNull(row[7]);
      if (!gameId || projected === null) continue;
      vehiclesByGame.set(gameId, {
        market_line: numberOrNull(row[5]),
        direction: String(row[6] ?? "NONE"),
        projected_total: projected,
        source: "FROZEN_VEHICLE_LOG",
      });
    }
  } catch (error: unknown) {
    warnings.push(`VEHICLE_LOG frozen projection read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A game can remain OPEN until first pitch when no publish occurs near its
  // lock cutoff. DECISION_AUDIT_LOG still contains the last real pregame model
  // observation. Accept that observation only when its model timestamp is
  // strictly earlier than scheduled first pitch; VehicleLog always wins when
  // both sources exist.
  const auditSnapshotsByGame = new Map<string, FrozenProjection>();
  try {
    const response = await readRange(wbId, `${DECISION_AUDIT_SHEET}!A1:Q5000`);
    const parsed = parseProspectiveDecisionAuditSnapshots(
      ((response.values ?? []) as unknown[][]).slice(1),
      date,
    );
    for (const [gameId, snapshot] of parsed.snapshots) {
      auditSnapshotsByGame.set(gameId, snapshot);
    }
    warnings.push(...parsed.warnings);
  } catch (error: unknown) {
    warnings.push(`DECISION_AUDIT_LOG prospective snapshot read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lowCenterSnapshotsByGame = new Map<string, LowCenterProspectiveSnapshot>();
  try {
    const response = await readRange(wbId, `${LOW_CENTER_HISTORY_SHEET}!A1:J5000`);
    for (const [gameId, snapshot] of parseLowCenterProspectiveSnapshots(
      ((response.values ?? []) as unknown[][]).slice(1),
      date,
    )) {
      lowCenterSnapshotsByGame.set(gameId, snapshot);
    }
  } catch (error: unknown) {
    // This surface begins with schema v24. Older dates do not require it, and
    // its absence must not prevent normal settlement from grading the frozen model.
    warnings.push(`LOW_CENTER_CALIBRATION_HISTORY read unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const collisionSnapshotsByGame = new Map<string, CollisionProspectiveSnapshot>();
  try {
    const response = await readRange(wbId, `${COLLISION_HISTORY_SHEET}!A1:Y5000`);
    for (const [gameId, snapshot] of parseCollisionProspectiveSnapshots(
      ((response.values ?? []) as unknown[][]).slice(1),
      date,
    )) {
      collisionSnapshotsByGame.set(gameId, snapshot);
    }
  } catch (error: unknown) {
    // The ledger is new. Its absence must not rewrite history or prevent core
    // settlement; a later run will record an explicit snapshot gap instead.
    warnings.push(`COLLISION_CALIBRATION_HISTORY read unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const starterSurvivalSnapshotsByGame = new Map<string, StarterSurvivalProspectiveSnapshot>();
  try {
    const response = await readRange(wbId, `${STARTER_SURVIVAL_HISTORY_SHEET}!A1:V5000`);
    for (const [gameId, snapshot] of parseStarterSurvivalProspectiveSnapshots(
      ((response.values ?? []) as unknown[][]).slice(1),
      date,
    )) {
      starterSurvivalSnapshotsByGame.set(gameId, snapshot);
    }
  } catch (error: unknown) {
    // This surface is new. Its absence must not mutate historical settlement
    // behavior or prevent the frozen base model from settling.
    warnings.push(`STARTER_SURVIVAL_CALIBRATION_HISTORY read unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const starterSurvivalV2SnapshotsByGame = new Map<string, StarterSurvivalV2ProspectiveSnapshot>();
  try {
    const response = await readRange(wbId, `${STARTER_SURVIVAL_V2_HISTORY_SHEET}!A1:AF5000`);
    for (const [gameId, snapshot] of parseStarterSurvivalV2ProspectiveSnapshots(
      ((response.values ?? []) as unknown[][]).slice(1),
      date,
    )) {
      starterSurvivalV2SnapshotsByGame.set(gameId, snapshot);
    }
  } catch (error: unknown) {
    warnings.push(`STARTER_SURVIVAL_V2_CALIBRATION_HISTORY read unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  type Existing = { dataIndex: number; values: unknown[] };
  const existingByGame = new Map<string, Existing>();
  let existingRows: unknown[][] = [];
  try {
    const response = await readRange(wbId, `${OUTCOMES_SHEET}!A1:AR5000`);
    const all = (response.values ?? []) as unknown[][];
    existingRows = all.slice(1).map((row) => normalizeOutcomeValues(row, vehiclesByGame.get(String(row[1] ?? ""))));
    existingRows.forEach((row, index) => {
      const gameId = String(row[1] ?? "");
      if (gameId) existingByGame.set(gameId, { dataIndex: index, values: row });
    });
  } catch (error: unknown) {
    errors.push(`SHADOW_OUTCOMES read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ...failedResult(date, ts, errors), games_found: gamesFound };
  }

  let finalGames: Map<string, FinalGame>;
  try {
    finalGames = await fetchFinalGames(date, warnings);
  } catch (error: unknown) {
    errors.push(`MLB API actuals fetch failed for ${date}: ${error instanceof Error ? error.message : String(error)}`);
    return { ...failedResult(date, ts, errors), games_found: gamesFound };
  }

  const processed: SettlementRow[] = [];
  let settled = 0;
  let updated = 0;
  let skipped = 0;
  let noActual = 0;
  let provenanceIncomplete = 0;

  for (const history of historyRows) {
    const gameId = history[H_GAME_ID] ?? "";
    const final = finalGames.get(gameId);
    if (!final) {
      noActual++;
      continue;
    }

    const existing = existingByGame.get(gameId);
    // Once an outcome row exists, preserve every resolved pregame-origin field
    // from that row. Settlement reruns may repair only blank/UNRESOLVED starter
    // fields from the canonical frozen packet, never from current/live data.
    const projection = existing
      ? numberOrNull(existing.values[4]) ?? 0
      : Number.parseFloat(history[H_REPAIRED] ?? "0") || 0;
    const error = Number.parseFloat((projection - final.actual_total).toFixed(2));
    const provenance = final.provenance;
    const packetStarters = frozenPacketStartersByGame.get(gameId);
    const projectedAwayStarter = resolveProjectedStarter(
      existing?.values[22],
      packetStarters?.away_starter,
      history[H_AWAY_PITCHER],
    );
    const projectedHomeStarter = resolveProjectedStarter(
      existing?.values[23],
      packetStarters?.home_starter,
      history[H_HOME_PITCHER],
    );
    const awayMatch = comparePitcherNames(projectedAwayStarter, provenance.away.actual_starter);
    const homeMatch = comparePitcherNames(projectedHomeStarter, provenance.home.actual_starter);
    const combinedStatus = combinedProvenanceStatus(provenance.status, awayMatch, homeMatch);
    if (combinedStatus !== "COMPLETE") provenanceIncomplete++;
    // Already-valid prospective fields remain immutable in frozenAuditValues.
    // An unresolved outcome may be repaired only from a timestamp-validated
    // pre-first-pitch Decision Audit observation, never from a current model
    // recalculation. VehicleLog remains the authoritative first choice.
    const prospectiveProjection = selectProspectiveProjection(
      vehiclesByGame.get(gameId),
      auditSnapshotsByGame.get(gameId),
    );
    const frozen = frozenAuditValues(
      projection,
      final.actual_total,
      prospectiveProjection,
      existing?.values,
      true,
    );
    const frozenGap = classifyFrozenVehicleGap(
      date,
      gameId,
      prospectiveProjection !== undefined || isPreservedProspectiveSource(existing?.values[O_FROZEN_SOURCE]),
    );
    if (frozenGap.warning) warnings.push(frozenGap.warning);
    if (frozenGap.error) errors.push(frozenGap.error);

    const marketGrade = resolveSettlementMarketGrade(
      numberOrNull(frozen[0]),
      final.actual_total,
      frozenPacketMarketsByGame.get(gameId),
      existing?.values,
    );
    const row: SettlementRow = {
      date: String(existing?.values[0] || history[H_DATE] || date),
      game_id: gameId,
      game_pk: final.game_pk,
      away_team: String(existing?.values[2] || history[H_AWAY] || ""),
      home_team: String(existing?.values[3] || history[H_HOME] || ""),
      repaired_projected_total: projection,
      actual_away_runs: final.actual_away_runs,
      actual_home_runs: final.actual_home_runs,
      actual_total: final.actual_total,
      error,
      abs_error: Number.parseFloat(Math.abs(error).toFixed(2)),
      park_source_status: String(existing?.values[8] || history[H_PARK_SRC] || ""),
      away_offense_source: String(existing?.values[9] || history[H_AWAY_SRC] || ""),
      home_offense_source: String(existing?.values[10] || history[H_HOME_SRC] || ""),
      settlement_ts: String(existing?.values[O_SETTLEMENT_TS] || ts),
      frozen_published_total: numberOrNull(frozen[0]),
      frozen_error: numberOrNull(frozen[1]),
      frozen_abs_error: numberOrNull(frozen[2]),
      frozen_projection_source: String(frozen[3] ?? ""),
      repaired_minus_frozen: numberOrNull(frozen[4]),
      frozen_market_line: numberOrNull(frozen[5]),
      settlement_market_line: numberOrNull(frozen[6]),
      frozen_ticket_result: String(frozen[7] ?? ""),
      settlement_ticket_result: String(frozen[8] ?? ""),
      projection_audit_status: String(frozen[9] ?? ""),
      ...marketGrade,
      projected_away_starter: projectedAwayStarter,
      projected_home_starter: projectedHomeStarter,
      actual_away_starter: provenance.away.actual_starter,
      actual_home_starter: provenance.home.actual_starter,
      actual_away_starter_innings: provenance.away.actual_starter_innings,
      actual_home_starter_innings: provenance.home.actual_starter_innings,
      away_starter_match_status: awayMatch,
      home_starter_match_status: homeMatch,
      away_bulk_pitcher: provenance.away.bulk_pitcher,
      home_bulk_pitcher: provenance.home.bulk_pitcher,
      away_pitcher_chain: provenance.away.pitcher_chain,
      home_pitcher_chain: provenance.home.pitcher_chain,
      pitcher_provenance_status: combinedStatus,
      low_center_snapshot: lowCenterSnapshotsByGame.get(gameId),
      collision_snapshot: collisionSnapshotsByGame.get(gameId),
      starter_survival_snapshot: starterSurvivalSnapshotsByGame.get(gameId),
      starter_survival_v2_snapshot: starterSurvivalV2SnapshotsByGame.get(gameId),
    };
    processed.push(row);
    if (existing) {
      existingRows[existing.dataIndex] = settlementRowToValues(row);
      updated++;
    } else {
      existingRows.push(settlementRowToValues(row));
      settled++;
    }
  }

  try {
    await expandSheetColumns(wbId, OUTCOMES_SHEET, OUTCOMES_COLS);
    await writeRange(wbId, `${OUTCOMES_SHEET}!A1`, [OUTCOMES_HEADER, ...existingRows]);
    await upsertFrozenProjectionReplay(wbId, date, processed, ts);
    try {
      await upsertLowCenterCalibrationReport(wbId, date, processed);
    } catch (error: unknown) {
      warnings.push(`LOW_CENTER_CALIBRATION_REPORT write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await upsertCollisionCalibrationReport(wbId, date, processed);
    } catch (error: unknown) {
      // This report is the proof that collision values are working rather than
      // decorative. Do not let settlement claim a clean calibration chain when
      // it failed to write.
      errors.push(`COLLISION_CALIBRATION_REPORT write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await upsertStarterSurvivalCalibrationReport(wbId, date, processed);
    } catch (error: unknown) {
      warnings.push(`STARTER_SURVIVAL_CALIBRATION_REPORT write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await upsertStarterSurvivalV2CalibrationReport(wbId, date, processed);
    } catch (error: unknown) {
      warnings.push(`STARTER_SURVIVAL_V2_CALIBRATION_REPORT write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error: unknown) {
    errors.push(`SHADOW_OUTCOMES write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (provenanceIncomplete > 0) {
    warnings.push(`${provenanceIncomplete} game(s) have explicitly partial or unavailable pregame pitcher provenance`);
  }
  const status: SettlementResult["status"] = errors.length > 0
    ? (processed.length > 0 ? "partial" : "failure")
    : "success";

  logger.info({
    date, found: gamesFound, settled, updated, skipped, noActual,
    provenance_incomplete: provenanceIncomplete, errors: errors.length, warnings: warnings.length,
  }, "MODULE_14: Shadow settlement complete");

  return {
    status, settle_date: date, settlement_timestamp_utc: ts,
    games_found: gamesFound, games_settled: settled, games_updated: updated,
    games_skipped: skipped, games_no_actual: noActual,
    games_provenance_incomplete: provenanceIncomplete,
    rows: processed, warnings, errors,
  };
}
