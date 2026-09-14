/**
 * Module 33: Allocation Bridge V1.
 *
 * Settlement-only research that asks how an already-frozen price-blind total
 * should be divided between the two teams. It cannot change that total or
 * write any active/frozen pregame, board, market, vehicle, or ticket surface.
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
import {
  ALLOCATION_SETTLEMENT_HEADERS,
  ALLOCATION_SETTLEMENT_SHEET,
} from "./module24_postgameDiagnostics.js";
import { logger } from "../../lib/logger.js";

export const ALLOCATION_BRIDGE_SHEET = "ALLOCATION_BRIDGE_V1";
export const ALLOCATION_BRIDGE_SUMMARY_SHEET = "ALLOCATION_BRIDGE_SUMMARY_V1";
export const ALLOCATION_BRIDGE_REPLAY_SHEET = "ALLOCATION_BRIDGE_REPLAY_V1";
export const ALLOCATION_BRIDGE_DIAG_SHEET = "ALLOCATION_BRIDGE_DIAG_V1";
export const ALLOCATION_BRIDGE_VERSION = "ALLOCATION_BRIDGE_V1_2026-09-14";
export const FIXED_TOTAL_TOLERANCE = 1e-9;

export type AllocationBridgeVerdict =
  | "FAIL"
  | "HOLD"
  | "CONTINUE_SHADOW"
  | "CANDIDATE_FOR_COMMISSIONING";

export const ALLOCATION_BRIDGE_HEADERS = [
  "Date", "Game_ID", "Frozen_Packet_Snapshot_TS", "Bridge_Version",
  "Research_Status", "Exclusion_Reason", "Frozen_Total",
  "Legacy_Away_Projection", "Legacy_Home_Projection", "Legacy_Run_Diff",
  "Bridge_Away_Share", "Bridge_Home_Share", "Bridge_Away_Projection",
  "Bridge_Home_Projection", "Bridge_Run_Diff", "Away_Allocation_Support",
  "Home_Allocation_Support", "Away_Offense_Component", "Home_Offense_Component",
  "Away_Traffic_Component", "Home_Traffic_Component", "Away_Damage_Component",
  "Home_Damage_Component", "Away_Conversion_Component", "Home_Conversion_Component",
  "Away_Starter_Component", "Home_Starter_Component", "Away_Bullpen_Component",
  "Home_Bullpen_Component", "Away_System_Factor", "Home_System_Factor",
  "Allocation_Data_Confidence", "Allocation_Missingness_Flag",
  "Allocation_Limitation_Flag", "Allocation_Dominant_Driver", "Allocation_Notes",
  "Away_Lineup_Coverage", "Home_Lineup_Coverage", "Away_Lineup_Status",
  "Home_Lineup_Status", "Away_Starter_Role", "Home_Starter_Role",
  "Bullpen_Data_Status", "Away_Bullpen_Quality_Source", "Home_Bullpen_Quality_Source",
  "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Run_Diff",
  "Legacy_Higher_Scoring_Side_Correct", "Bridge_Higher_Scoring_Side_Correct",
  "Legacy_Allocation_Sign_Error", "Bridge_Allocation_Sign_Error",
  "Legacy_Away_Abs_Error", "Legacy_Home_Abs_Error", "Bridge_Away_Abs_Error",
  "Bridge_Home_Abs_Error", "Legacy_Combined_Team_MAE", "Bridge_Combined_Team_MAE",
  "Legacy_Run_Diff_Abs_Error", "Bridge_Run_Diff_Abs_Error",
  "Frozen_Total_Abs_Error", "Total_Good_Allocation_Bad_Flag",
  "Fixed_Total_Invariant_Delta", "Fixed_Total_Invariant_Status",
  "Snapshot_Lineage_Status", "Failure_Classification", "Failure_Evidence_Status",
  "Replay_TS",
] as const;

export const ALLOCATION_BRIDGE_REPLAY_HEADERS = [
  "Date", "Game_ID", "Frozen_Packet_Snapshot_TS", "Frozen_Total",
  "Legacy_Away_Projection", "Legacy_Home_Projection", "Bridge_Away_Projection",
  "Bridge_Home_Projection", "Actual_Away_Runs", "Actual_Home_Runs",
  "Legacy_Run_Diff", "Bridge_Run_Diff", "Actual_Run_Diff",
  "Legacy_Higher_Scoring_Side_Correct", "Bridge_Higher_Scoring_Side_Correct",
  "Legacy_Allocation_Sign_Error", "Bridge_Allocation_Sign_Error",
  "Legacy_Away_Abs_Error", "Legacy_Home_Abs_Error", "Bridge_Away_Abs_Error",
  "Bridge_Home_Abs_Error", "Legacy_Combined_Team_MAE", "Bridge_Combined_Team_MAE",
  "Legacy_Run_Diff_Abs_Error", "Bridge_Run_Diff_Abs_Error",
  "Frozen_Total_Abs_Error", "Allocation_Strength_Bucket", "Lineup_Completeness_Cohort",
  "Starter_Role_Cohort", "Bullpen_Data_Cohort", "Total_Error_Bucket",
  "Total_Good_Allocation_Bad_Flag", "Allocation_Data_Confidence",
  "Fixed_Total_Invariant_Status", "Replay_Status", "Replay_TS",
] as const;

export const ALLOCATION_BRIDGE_SUMMARY_HEADERS = [
  "Summary_Dimension", "Cohort", "Eligible_N", "Comparable_N",
  "Legacy_Higher_Scoring_Side_Accuracy", "Bridge_Higher_Scoring_Side_Accuracy",
  "Bridge_Minus_Legacy_Accuracy", "Legacy_Allocation_Sign_Reversals",
  "Bridge_Allocation_Sign_Reversals", "Legacy_Away_MAE", "Bridge_Away_MAE",
  "Legacy_Home_MAE", "Bridge_Home_MAE", "Legacy_Combined_Team_MAE",
  "Bridge_Combined_Team_MAE", "Legacy_Run_Diff_MAE", "Bridge_Run_Diff_MAE",
  "Frozen_Total_MAE", "Mean_Abs_Bridge_Away_Delta", "Mean_Abs_Bridge_Home_Delta",
  "Max_Fixed_Total_Invariant_Delta", "High_Confidence_N", "Research_Verdict",
  "Summary_Notes", "Replay_TS",
] as const;

export const ALLOCATION_BRIDGE_DIAG_HEADERS = [
  "Date", "Game_ID", "Legacy_Sign_Error", "Bridge_Sign_Error",
  "Failure_Classification", "Failure_Evidence_Status", "Allocation_Dominant_Driver",
  "Total_Good_Allocation_Bad_Flag", "Allocation_Strength_Bucket",
  "Lineup_Completeness_Cohort", "Starter_Role_Cohort", "Bullpen_Data_Cohort",
  "Total_Error_Bucket", "Legacy_Run_Diff", "Bridge_Run_Diff", "Actual_Run_Diff",
  "Candidate_Changed_Sign", "Sept13_Case_Study", "Diagnostic_Notes", "Report_TS",
] as const;

type HigherSide = "AWAY" | "HOME" | "TIE";

interface FrozenAllocationPacket {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  scheduled_first_pitch: string;
  snapshot_ts: string;
  legacy_away: number;
  legacy_home: number;
  frozen_total: number;
  away_role: string;
  home_role: string;
  away_starter_quality: number;
  home_starter_quality: number;
  bullpen_status: string;
  away_lineup_status: string;
  home_lineup_status: string;
  away_lineup_coverage: number;
  home_lineup_coverage: number;
  run_multiplier: number;
  away_pitcher_effective_ip: number;
  home_pitcher_effective_ip: number;
  away_traffic_factor: number;
  home_traffic_factor: number;
  away_damage_factor: number;
  home_damage_factor: number;
  away_matchup_status: string;
  home_matchup_status: string;
  away_active_offense_center: number;
  home_active_offense_center: number;
  away_starter_quality_source: string;
  home_starter_quality_source: string;
  away_bullpen_quality_source: string;
  home_bullpen_quality_source: string;
  traffic_conversion_runs: number;
  hr_xbh_damage_runs: number;
}

interface AllocationOutcome {
  date: string;
  game_id: string;
  snapshot_ts: string;
  legacy_away: number;
  legacy_home: number;
  frozen_total: number;
  actual_away: number;
  actual_home: number;
  actual_total: number;
  status: string;
}

interface PhaseContext {
  workload_state: string;
}

export interface AllocationBridgeInput {
  packet: FrozenAllocationPacket;
  outcome: AllocationOutcome;
  phase?: PhaseContext;
}

export interface BridgeComponents {
  support: number;
  offense: number;
  starter: number;
  traffic: number;
  damage: number;
  conversion: number;
  bullpen: number;
  system_factor: number;
}

export interface AllocationBridgeRecord {
  input: AllocationBridgeInput;
  research_status: "ELIGIBLE" | "EXCLUDED";
  exclusion_reason: string;
  away: BridgeComponents | null;
  home: BridgeComponents | null;
  bridge_away: number | null;
  bridge_home: number | null;
  invariant_delta: number | null;
  invariant_status: "PASS" | "FAIL" | "NOT_EVALUATED";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  missingness: string;
  limitation: string;
  dominant_driver: string;
  failure_classification: string;
  failure_evidence_status: string;
  notes: string;
}

export interface AllocationBridgeResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  allocation_rows_seen: number;
  frozen_packets_seen: number;
  eligible_games: number;
  excluded_games: number;
  bridge_rows_written: number;
  replay_rows_written: number;
  summary_rows_written: number;
  diagnostic_rows_written: number;
  invariant_failures: number;
  verdict: AllocationBridgeVerdict;
  warnings: string[];
  errors: string[];
}

const SEPT13_CASES = new Set([
  "20260913_COL_DET", "20260913_LAD_MIA", "20260913_SDP_SFG",
  "20260913_NYM_NYY", "20260913_TEX_ARI", "20260913_SEA_OAK",
]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalDate(value: unknown, gameId = ""): string {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  if (/^\d{8}_/.test(gameId)) return `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`;
  return "";
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((value, index) => [text(value), index]));
}

function field(row: unknown[], index: Map<string, number>, name: string): unknown {
  return row[index.get(name) ?? -1];
}

function key(date: string, gameId: string): string {
  return `${date}|${gameId}`;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function sameNumber(left: number, right: number, tolerance = 1e-6): boolean {
  return Math.abs(left - right) <= tolerance;
}

function validPregameSnapshot(snapshot: string, firstPitch: string): boolean {
  const snapshotMs = Date.parse(snapshot);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
}

function higherSide(away: number, home: number): HigherSide {
  if (Math.abs(away - home) <= 1e-12) return "TIE";
  return away > home ? "AWAY" : "HOME";
}

function correctness(predicted: HigherSide, actual: HigherSide): string {
  if (predicted === "TIE" || actual === "TIE") return "NOT_COMPARABLE";
  return predicted === actual ? "TRUE" : "FALSE";
}

function signError(predicted: HigherSide, actual: HigherSide): string {
  const correct = correctness(predicted, actual);
  return correct === "NOT_COMPARABLE" ? "NOT_COMPARABLE" : correct === "TRUE" ? "FALSE" : "TRUE";
}

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Parse only legitimate immutable packets; newer component availability is checked later. */
export function parseFrozenAllocationPackets(rows: unknown[][]): Map<string, FrozenAllocationPacket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const packets = new Map<string, FrozenAllocationPacket>();
  for (const row of data) {
    const gameId = text(field(row, index, "Game_ID"));
    const date = canonicalDate(field(row, index, "Date"), gameId);
    if (!date || !gameId || text(field(row, index, "Packet_Status")) !== "FROZEN_PREGAME") continue;
    const snapshot = text(field(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(field(row, index, "Scheduled_First_Pitch"));
    const values = [
      "Base_Away_Projection", "Base_Home_Projection", "Base_Projection",
      "Away_Starter_Quality", "Home_Starter_Quality", "Away_Lineup_Coverage",
      "Home_Lineup_Coverage", "Run_Multiplier", "Away_Pitcher_Effective_IP",
      "Home_Pitcher_Effective_IP", "Away_Traffic_Matchup_Factor",
      "Home_Traffic_Matchup_Factor", "Away_Damage_Matchup_Factor",
      "Home_Damage_Matchup_Factor", "Away_Active_Offense_Center",
      "Home_Active_Offense_Center", "Traffic_Conversion_Runs", "HR_XBH_Damage_Runs",
    ].map((name) => numeric(field(row, index, name)));
    const packet: FrozenAllocationPacket = {
      date, game_id: gameId,
      away_team: text(field(row, index, "Away_Team")),
      home_team: text(field(row, index, "Home_Team")),
      scheduled_first_pitch: firstPitch, snapshot_ts: snapshot,
      legacy_away: values[0] ?? Number.NaN, legacy_home: values[1] ?? Number.NaN,
      frozen_total: values[2] ?? Number.NaN,
      away_role: text(field(row, index, "Away_Starter_Role")),
      home_role: text(field(row, index, "Home_Starter_Role")),
      away_starter_quality: values[3] ?? Number.NaN,
      home_starter_quality: values[4] ?? Number.NaN,
      bullpen_status: text(field(row, index, "Bullpen_Data_Status")),
      away_lineup_status: text(field(row, index, "Away_Lineup_Status")),
      home_lineup_status: text(field(row, index, "Home_Lineup_Status")),
      away_lineup_coverage: values[5] ?? Number.NaN,
      home_lineup_coverage: values[6] ?? Number.NaN,
      run_multiplier: values[7] ?? Number.NaN,
      away_pitcher_effective_ip: values[8] ?? Number.NaN,
      home_pitcher_effective_ip: values[9] ?? Number.NaN,
      away_traffic_factor: values[10] ?? Number.NaN,
      home_traffic_factor: values[11] ?? Number.NaN,
      away_damage_factor: values[12] ?? Number.NaN,
      home_damage_factor: values[13] ?? Number.NaN,
      away_matchup_status: text(field(row, index, "Away_Matchup_Profile_Status")),
      home_matchup_status: text(field(row, index, "Home_Matchup_Profile_Status")),
      away_active_offense_center: values[14] ?? Number.NaN,
      home_active_offense_center: values[15] ?? Number.NaN,
      away_starter_quality_source: text(field(row, index, "Away_Starter_Quality_Source")),
      home_starter_quality_source: text(field(row, index, "Home_Starter_Quality_Source")),
      away_bullpen_quality_source: text(field(row, index, "Away_Bullpen_Quality_Source")),
      home_bullpen_quality_source: text(field(row, index, "Home_Bullpen_Quality_Source")),
      traffic_conversion_runs: values[16] ?? Number.NaN,
      hr_xbh_damage_runs: values[17] ?? Number.NaN,
    };
    if (!validPregameSnapshot(snapshot, firstPitch)) continue;
    packets.set(key(date, gameId), packet);
  }
  return packets;
}

export function parseAllocationOutcomes(rows: unknown[][]): Map<string, AllocationOutcome> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const outcomes = new Map<string, AllocationOutcome>();
  for (const row of data) {
    const gameId = text(field(row, index, "Game_ID"));
    const date = canonicalDate(field(row, index, "Date"), gameId);
    const legacyAway = numeric(field(row, index, "Projected_Away_Runs"));
    const legacyHome = numeric(field(row, index, "Projected_Home_Runs"));
    const frozenTotal = numeric(field(row, index, "Projected_Total"));
    const actualAway = numeric(field(row, index, "Actual_Away_Runs"));
    const actualHome = numeric(field(row, index, "Actual_Home_Runs"));
    const actualTotal = numeric(field(row, index, "Actual_Total"));
    if (!date || !gameId || [legacyAway, legacyHome, frozenTotal, actualAway, actualHome, actualTotal].some((v) => v === null)) continue;
    outcomes.set(key(date, gameId), {
      date, game_id: gameId,
      snapshot_ts: text(field(row, index, "Frozen_Packet_Snapshot_TS")),
      legacy_away: legacyAway!, legacy_home: legacyHome!, frozen_total: frozenTotal!,
      actual_away: actualAway!, actual_home: actualHome!, actual_total: actualTotal!,
      status: text(field(row, index, "Diagnostic_Status")),
    });
  }
  return outcomes;
}

function parsePhaseContext(rows: unknown[][]): Map<string, PhaseContext> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const output = new Map<string, PhaseContext>();
  for (const row of data) {
    const gameId = text(field(row, index, "Game_ID"));
    const date = canonicalDate(field(row, index, "Date"), gameId);
    if (!date || !gameId) continue;
    output.set(key(date, gameId), { workload_state: text(field(row, index, "Workload_State")) });
  }
  return output;
}

export function buildAllocationBridgeInputs(
  packetRows: unknown[][],
  allocationRows: unknown[][],
  phaseRows: unknown[][] = [],
): AllocationBridgeInput[] {
  const packets = parseFrozenAllocationPackets(packetRows);
  const outcomes = parseAllocationOutcomes(allocationRows);
  const phases = parsePhaseContext(phaseRows);
  return [...outcomes.values()]
    .flatMap((outcome) => {
      const packet = packets.get(key(outcome.date, outcome.game_id));
      return packet ? [{ packet, outcome, phase: phases.get(key(outcome.date, outcome.game_id)) }] : [];
    })
    .sort((a, b) => key(a.packet.date, a.packet.game_id).localeCompare(key(b.packet.date, b.packet.game_id)));
}

function exclusionReason(input: AllocationBridgeInput): string {
  const { packet, outcome } = input;
  if (outcome.status !== "FROZEN_PACKET_VERIFIED") return "ALLOCATION_OUTCOME_NOT_FROZEN_PACKET_VERIFIED";
  if (packet.snapshot_ts !== outcome.snapshot_ts) return "FROZEN_PACKET_SNAPSHOT_MISMATCH";
  if (!sameNumber(packet.legacy_away, outcome.legacy_away) || !sameNumber(packet.legacy_home, outcome.legacy_home) || !sameNumber(packet.frozen_total, outcome.frozen_total)) {
    return "FROZEN_PACKET_PROJECTION_MISMATCH";
  }
  if (!sameNumber(packet.legacy_away + packet.legacy_home, packet.frozen_total, 0.011)) return "LEGACY_TEAM_TOTAL_RECONCILIATION_FAILURE";
  const required = [
    packet.legacy_away, packet.legacy_home, packet.frozen_total, packet.run_multiplier,
    packet.away_starter_quality, packet.home_starter_quality,
    packet.away_pitcher_effective_ip, packet.home_pitcher_effective_ip,
    packet.away_traffic_factor, packet.home_traffic_factor,
    packet.away_damage_factor, packet.home_damage_factor,
    packet.away_active_offense_center, packet.home_active_offense_center,
  ];
  if (required.some((value) => !Number.isFinite(value))) return "FROZEN_BRIDGE_COMPONENTS_MISSING";
  if (packet.run_multiplier <= 0 || packet.away_active_offense_center <= 0 || packet.home_active_offense_center <= 0) return "FROZEN_BRIDGE_COMPONENTS_INVALID";
  if (packet.away_pitcher_effective_ip < 0 || packet.away_pitcher_effective_ip > 9 || packet.home_pitcher_effective_ip < 0 || packet.home_pitcher_effective_ip > 9) return "FROZEN_EFFECTIVE_IP_INVALID";
  return "";
}

/**
 * Equal-family geometric bridge: offense is full strength; the complete
 * opposing run-prevention system is retained once at half log-strength.
 */
function sideComponents(args: {
  legacy_runs: number;
  run_multiplier: number;
  offense_center: number;
  opposing_effective_ip: number;
  opposing_starter_quality: number;
  traffic_factor: number;
  damage_factor: number;
}): BridgeComponents | null {
  const baseballRuns = args.legacy_runs / args.run_multiplier;
  const systemFactor = baseballRuns / args.offense_center;
  if (![baseballRuns, systemFactor].every(Number.isFinite) || baseballRuns <= 0 || systemFactor <= 0) return null;
  const starterShare = args.opposing_effective_ip / 9;
  const bullpenShare = 1 - starterShare;
  const afterStarter = starterShare * args.opposing_starter_quality + bullpenShare;
  const afterTraffic = starterShare * args.opposing_starter_quality * args.traffic_factor + bullpenShare;
  const afterDamage = starterShare * args.opposing_starter_quality * args.traffic_factor * args.damage_factor + bullpenShare;
  if ([afterStarter, afterTraffic, afterDamage].some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const half = 0.5;
  const offense = Math.log(args.offense_center / 4.5);
  const starter = half * Math.log(afterStarter);
  const traffic = half * (Math.log(afterTraffic) - Math.log(afterStarter));
  const damage = half * (Math.log(afterDamage) - Math.log(afterTraffic));
  const bullpen = half * (Math.log(systemFactor) - Math.log(afterDamage));
  const support = args.offense_center * Math.sqrt(systemFactor);
  return {
    support, offense, starter, traffic, damage, conversion: 0, bullpen,
    system_factor: systemFactor,
  };
}

function confidence(packet: FrozenAllocationPacket): AllocationBridgeRecord["confidence"] {
  const fullLineups = packet.away_lineup_coverage >= 0.95 && packet.home_lineup_coverage >= 0.95
    && /FULL|CONFIRMED/.test(packet.away_lineup_status) && /FULL|CONFIRMED/.test(packet.home_lineup_status);
  const activeMatchups = packet.away_matchup_status === "ACTIVE" && packet.home_matchup_status === "ACTIVE";
  const resolvedRoles = ![packet.away_role, packet.home_role].some((role) => !role || role === "UNRESOLVED");
  const quality = ![
    packet.away_starter_quality_source, packet.home_starter_quality_source,
    packet.away_bullpen_quality_source, packet.home_bullpen_quality_source,
  ].some((source) => !source || source === "LEAGUE_NEUTRAL");
  if (fullLineups && activeMatchups && resolvedRoles && quality && packet.bullpen_status === "AVAILABLE") return "HIGH";
  if (packet.away_lineup_coverage >= 0.7 && packet.home_lineup_coverage >= 0.7 && resolvedRoles) return "MEDIUM";
  return "LOW";
}

function driver(away: BridgeComponents, home: BridgeComponents): string {
  const candidates = [
    ["OFFENSE", Math.abs(away.offense - home.offense)],
    ["STARTER", Math.abs(away.starter - home.starter)],
    ["TRAFFIC", Math.abs(away.traffic - home.traffic)],
    ["DAMAGE", Math.abs(away.damage - home.damage)],
    ["BULLPEN", Math.abs(away.bullpen - home.bullpen)],
  ] as const;
  return [...candidates].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "NONE";
}

function sign(value: number): number {
  return value > 1e-12 ? 1 : value < -1e-12 ? -1 : 0;
}

function failureClassification(record: Omit<AllocationBridgeRecord, "failure_classification" | "failure_evidence_status">): [string, string] {
  if (record.research_status !== "ELIGIBLE" || !record.away || !record.home || record.bridge_away === null || record.bridge_home === null) {
    return ["INSUFFICIENT_EVIDENCE_TO_CLASSIFY", "NOT_CLASSIFIABLE_EXCLUDED_ROW"];
  }
  const { packet, outcome, phase } = record.input;
  const legacyDiff = packet.legacy_away - packet.legacy_home;
  const actualDiff = outcome.actual_away - outcome.actual_home;
  if (sign(legacyDiff) === sign(actualDiff)) return ["NO_LEGACY_SIGN_ERROR", "NOT_AN_ALLOCATION_SIGN_MISS"];
  if (packet.away_lineup_coverage < 0.95 || packet.home_lineup_coverage < 0.95 || !/FULL|CONFIRMED/.test(packet.away_lineup_status) || !/FULL|CONFIRMED/.test(packet.home_lineup_status)) {
    return ["LINEUP_IDENTITY_GAP", "DIRECT_FROZEN_LINEUP_LIMITATION"];
  }
  if (phase?.workload_state === "MATERIALLY_SHORT") return ["ROLE_OR_WORKLOAD_MISMATCH", "SETTLED_PHASE_DIAGNOSTIC"];
  const offenseDiff = record.away.offense - record.home.offense;
  if (sign(offenseDiff) === sign(actualDiff) && sign(offenseDiff) !== sign(legacyDiff)) {
    return ["STARTER_WEIGHT_OVERREACH", "STRUCTURAL_COUNTERFACTUAL"];
  }
  if (record.dominant_driver === "OFFENSE" && sign(offenseDiff) !== sign(actualDiff)) {
    return ["OFFENSE_STRENGTH_MISALLOCATION", "FROZEN_COMPONENT_DIRECTION"];
  }
  const bullpenDiff = record.away.bullpen - record.home.bullpen;
  if (record.dominant_driver === "BULLPEN" && sign(bullpenDiff) !== sign(actualDiff)) {
    return ["BULLPEN_EXPOSURE_MISALLOCATION", "INFERRED_FROZEN_SYSTEM_RESIDUAL"];
  }
  const trafficDamageDiff = (record.away.traffic + record.away.damage) - (record.home.traffic + record.home.damage);
  if ((record.dominant_driver === "TRAFFIC" || record.dominant_driver === "DAMAGE") && sign(trafficDamageDiff) !== sign(actualDiff)) {
    return ["TRAFFIC_CONVERSION_MISALLOCATION", "FROZEN_MATCHUP_COMPONENT_DIRECTION"];
  }
  if (packet.hr_xbh_damage_runs === 0 && Math.abs(actualDiff) >= 4) {
    return ["DAMAGE_PATH_MISSING", "KNOWN_INERT_DAMAGE_COMPONENT_HYPOTHESIS"];
  }
  if (Math.abs(legacyDiff) < 0.5) return ["RANDOM_SEQUENCE / LOW_EVIDENCE", "LOW_FROZEN_ALLOCATION_SEPARATION"];
  return ["INSUFFICIENT_EVIDENCE_TO_CLASSIFY", "NO_SINGLE_SUPPORTED_MECHANISM"];
}

export function buildAllocationBridgeRecord(input: AllocationBridgeInput): AllocationBridgeRecord {
  const reason = exclusionReason(input);
  const base: Omit<AllocationBridgeRecord, "failure_classification" | "failure_evidence_status"> = {
    input, research_status: reason ? "EXCLUDED" : "ELIGIBLE", exclusion_reason: reason,
    away: null, home: null, bridge_away: null, bridge_home: null,
    invariant_delta: null, invariant_status: "NOT_EVALUATED", confidence: "LOW",
    missingness: reason || "NONE",
    limitation: "NO_STANDALONE_FROZEN_BULLPEN_FACTOR|NO_INDEPENDENT_TEAM_CONVERSION_OBJECT|HR_XBH_DAMAGE_RUNS_INERT_IN_ELIGIBLE_CORPUS",
    dominant_driver: "NONE",
    notes: reason || "Fixed total; offense identity plus half-strength frozen opponent-system factor; no market input.",
  };
  if (reason) {
    const [classification, evidence] = failureClassification(base);
    return { ...base, failure_classification: classification, failure_evidence_status: evidence };
  }
  const p = input.packet;
  const away = sideComponents({
    legacy_runs: p.legacy_away, run_multiplier: p.run_multiplier,
    offense_center: p.away_active_offense_center,
    opposing_effective_ip: p.home_pitcher_effective_ip,
    opposing_starter_quality: p.home_starter_quality,
    traffic_factor: p.away_traffic_factor, damage_factor: p.away_damage_factor,
  });
  const home = sideComponents({
    legacy_runs: p.legacy_home, run_multiplier: p.run_multiplier,
    offense_center: p.home_active_offense_center,
    opposing_effective_ip: p.away_pitcher_effective_ip,
    opposing_starter_quality: p.away_starter_quality,
    traffic_factor: p.home_traffic_factor, damage_factor: p.home_damage_factor,
  });
  if (!away || !home || !finitePositive(away.support) || !finitePositive(home.support)) {
    const excluded = { ...base, research_status: "EXCLUDED" as const, exclusion_reason: "BRIDGE_SUPPORT_INVALID", missingness: "BRIDGE_SUPPORT_INVALID" };
    const [classification, evidence] = failureClassification(excluded);
    return { ...excluded, failure_classification: classification, failure_evidence_status: evidence };
  }
  const awayShare = away.support / (away.support + home.support);
  const bridgeAway = p.frozen_total * awayShare;
  const bridgeHome = p.frozen_total - bridgeAway;
  const invariantDelta = bridgeAway + bridgeHome - p.frozen_total;
  const evaluated: Omit<AllocationBridgeRecord, "failure_classification" | "failure_evidence_status"> = {
    ...base, away, home, bridge_away: bridgeAway, bridge_home: bridgeHome,
    invariant_delta: invariantDelta,
    invariant_status: Math.abs(invariantDelta) <= FIXED_TOTAL_TOLERANCE ? "PASS" : "FAIL",
    confidence: confidence(p), dominant_driver: driver(away, home),
  };
  const [classification, evidence] = failureClassification(evaluated);
  return { ...evaluated, failure_classification: classification, failure_evidence_status: evidence };
}

function allocationStrength(record: AllocationBridgeRecord): string {
  if (record.bridge_away === null || record.bridge_home === null) return "UNAVAILABLE";
  const magnitude = Math.abs(record.bridge_away - record.bridge_home);
  return magnitude < 0.5 ? "LOW" : magnitude < 1 ? "MEDIUM" : "HIGH";
}

function lineupCohort(packet: FrozenAllocationPacket): string {
  return packet.away_lineup_coverage >= 0.95 && packet.home_lineup_coverage >= 0.95
    && /FULL|CONFIRMED/.test(packet.away_lineup_status) && /FULL|CONFIRMED/.test(packet.home_lineup_status)
    ? "FULL" : "PARTIAL_OR_LOWER";
}

function roleCohort(packet: FrozenAllocationPacket): string {
  if ([packet.away_role, packet.home_role].some((role) => !role || role === "UNRESOLVED")) return "UNRESOLVED_PRESENT";
  return packet.away_role === "CONVENTIONAL_STARTER" && packet.home_role === "CONVENTIONAL_STARTER"
    ? "CONVENTIONAL_BOTH" : "ATYPICAL_PRESENT";
}

function bullpenCohort(packet: FrozenAllocationPacket): string {
  return packet.bullpen_status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE_OR_PARTIAL";
}

function totalErrorBucket(record: AllocationBridgeRecord): string {
  const error = Math.abs(record.input.packet.frozen_total - record.input.outcome.actual_total);
  return error <= 2 ? "GOOD" : error <= 4 ? "MODERATE" : "POOR";
}

function totalGoodAllocationBad(record: AllocationBridgeRecord): boolean {
  const { packet, outcome } = record.input;
  const legacyMae = (Math.abs(packet.legacy_away - outcome.actual_away) + Math.abs(packet.legacy_home - outcome.actual_home)) / 2;
  return Math.abs(packet.frozen_total - outcome.actual_total) <= 2 && legacyMae >= 3;
}

function recordMetrics(record: AllocationBridgeRecord) {
  const { packet: p, outcome: o } = record.input;
  const bridgeAway = record.bridge_away!;
  const bridgeHome = record.bridge_home!;
  const legacyAwayAbs = Math.abs(p.legacy_away - o.actual_away);
  const legacyHomeAbs = Math.abs(p.legacy_home - o.actual_home);
  const bridgeAwayAbs = Math.abs(bridgeAway - o.actual_away);
  const bridgeHomeAbs = Math.abs(bridgeHome - o.actual_home);
  const legacySide = higherSide(p.legacy_away, p.legacy_home);
  const bridgeSide = higherSide(bridgeAway, bridgeHome);
  const actualSide = higherSide(o.actual_away, o.actual_home);
  return {
    legacy_diff: p.legacy_away - p.legacy_home,
    bridge_diff: bridgeAway - bridgeHome,
    actual_diff: o.actual_away - o.actual_home,
    legacy_correct: correctness(legacySide, actualSide),
    bridge_correct: correctness(bridgeSide, actualSide),
    legacy_sign_error: signError(legacySide, actualSide),
    bridge_sign_error: signError(bridgeSide, actualSide),
    legacy_away_abs: legacyAwayAbs, legacy_home_abs: legacyHomeAbs,
    bridge_away_abs: bridgeAwayAbs, bridge_home_abs: bridgeHomeAbs,
    legacy_combined: (legacyAwayAbs + legacyHomeAbs) / 2,
    bridge_combined: (bridgeAwayAbs + bridgeHomeAbs) / 2,
    legacy_diff_abs: Math.abs((p.legacy_away - p.legacy_home) - (o.actual_away - o.actual_home)),
    bridge_diff_abs: Math.abs((bridgeAway - bridgeHome) - (o.actual_away - o.actual_home)),
    total_abs: Math.abs(p.frozen_total - o.actual_total),
  };
}

function blank(value: number | null | undefined, digits = 4): number | "" {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : round(value, digits);
}

export function allocationBridgeRow(record: AllocationBridgeRecord, timestamp: string): unknown[] {
  const p = record.input.packet;
  const o = record.input.outcome;
  const usable = record.research_status === "ELIGIBLE" && record.away && record.home && record.bridge_away !== null && record.bridge_home !== null;
  const m = usable ? recordMetrics(record) : null;
  const awayShare = usable ? record.bridge_away! / p.frozen_total : null;
  const homeShare = usable ? record.bridge_home! / p.frozen_total : null;
  const storedBridgeAway = usable ? round(record.bridge_away!) : null;
  const storedBridgeHome = storedBridgeAway === null ? null : round(p.frozen_total - storedBridgeAway);
  return [
    p.date, p.game_id, p.snapshot_ts, ALLOCATION_BRIDGE_VERSION,
    record.research_status, record.exclusion_reason, p.frozen_total,
    p.legacy_away, p.legacy_home, round(p.legacy_away - p.legacy_home),
    blank(awayShare, 6), blank(homeShare, 6), blank(storedBridgeAway),
    blank(storedBridgeHome), blank(usable ? storedBridgeAway! - storedBridgeHome! : null),
    blank(record.away?.support), blank(record.home?.support),
    blank(record.away?.offense, 6), blank(record.home?.offense, 6),
    blank(record.away?.traffic, 6), blank(record.home?.traffic, 6),
    blank(record.away?.damage, 6), blank(record.home?.damage, 6),
    blank(record.away?.conversion, 6), blank(record.home?.conversion, 6),
    blank(record.away?.starter, 6), blank(record.home?.starter, 6),
    blank(record.away?.bullpen, 6), blank(record.home?.bullpen, 6),
    blank(record.away?.system_factor, 6), blank(record.home?.system_factor, 6),
    record.confidence, record.missingness, record.limitation, record.dominant_driver, record.notes,
    p.away_lineup_coverage, p.home_lineup_coverage, p.away_lineup_status, p.home_lineup_status,
    p.away_role, p.home_role, p.bullpen_status, p.away_bullpen_quality_source, p.home_bullpen_quality_source,
    o.actual_away, o.actual_home, o.actual_away - o.actual_home,
    m?.legacy_correct ?? "", m?.bridge_correct ?? "", m?.legacy_sign_error ?? "", m?.bridge_sign_error ?? "",
    blank(m?.legacy_away_abs), blank(m?.legacy_home_abs), blank(m?.bridge_away_abs), blank(m?.bridge_home_abs),
    blank(m?.legacy_combined), blank(m?.bridge_combined), blank(m?.legacy_diff_abs), blank(m?.bridge_diff_abs),
    blank(m?.total_abs), usable ? (totalGoodAllocationBad(record) ? "TRUE" : "FALSE") : "",
    blank(record.invariant_delta, 12), record.invariant_status,
    record.exclusion_reason.includes("SNAPSHOT") || record.exclusion_reason.includes("PROJECTION_MISMATCH")
      ? "FAIL" : "FROZEN_PACKET_MATCHED",
    record.failure_classification, record.failure_evidence_status, timestamp,
  ];
}

export function allocationBridgeReplayRow(record: AllocationBridgeRecord, timestamp: string): unknown[] {
  const p = record.input.packet;
  const o = record.input.outcome;
  const m = recordMetrics(record);
  const storedBridgeAway = round(record.bridge_away!);
  const storedBridgeHome = round(p.frozen_total - storedBridgeAway);
  return [
    p.date, p.game_id, p.snapshot_ts, p.frozen_total, p.legacy_away, p.legacy_home,
    storedBridgeAway, storedBridgeHome, o.actual_away, o.actual_home,
    round(m.legacy_diff), round(m.bridge_diff), m.actual_diff,
    m.legacy_correct, m.bridge_correct, m.legacy_sign_error, m.bridge_sign_error,
    round(m.legacy_away_abs), round(m.legacy_home_abs), round(m.bridge_away_abs), round(m.bridge_home_abs),
    round(m.legacy_combined), round(m.bridge_combined), round(m.legacy_diff_abs), round(m.bridge_diff_abs),
    round(m.total_abs), allocationStrength(record), lineupCohort(p), roleCohort(p), bullpenCohort(p),
    totalErrorBucket(record), totalGoodAllocationBad(record) ? "TRUE" : "FALSE", record.confidence,
    record.invariant_status, "FROZEN_PACKET_NO_LEAKAGE_REPLAY", timestamp,
  ];
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summaryRow(
  dimension: string,
  cohort: string,
  records: AllocationBridgeRecord[],
  verdict: AllocationBridgeVerdict,
  timestamp: string,
): unknown[] {
  const metrics = records.map(recordMetrics);
  const comparable = metrics.filter((m) => m.legacy_correct !== "NOT_COMPARABLE" && m.bridge_correct !== "NOT_COMPARABLE");
  const legacyAccuracy = comparable.length === 0 ? null : comparable.filter((m) => m.legacy_correct === "TRUE").length / comparable.length;
  const bridgeAccuracy = comparable.length === 0 ? null : comparable.filter((m) => m.bridge_correct === "TRUE").length / comparable.length;
  const maxInvariant = records.length === 0 ? null : Math.max(...records.map((r) => Math.abs(r.invariant_delta ?? Number.POSITIVE_INFINITY)));
  return [
    dimension, cohort, records.length, comparable.length, blank(legacyAccuracy, 6), blank(bridgeAccuracy, 6),
    blank(legacyAccuracy === null || bridgeAccuracy === null ? null : bridgeAccuracy - legacyAccuracy, 6),
    metrics.filter((m) => m.legacy_sign_error === "TRUE").length,
    metrics.filter((m) => m.bridge_sign_error === "TRUE").length,
    blank(mean(metrics.map((m) => m.legacy_away_abs))), blank(mean(metrics.map((m) => m.bridge_away_abs))),
    blank(mean(metrics.map((m) => m.legacy_home_abs))), blank(mean(metrics.map((m) => m.bridge_home_abs))),
    blank(mean(metrics.map((m) => m.legacy_combined))), blank(mean(metrics.map((m) => m.bridge_combined))),
    blank(mean(metrics.map((m) => m.legacy_diff_abs))), blank(mean(metrics.map((m) => m.bridge_diff_abs))),
    blank(mean(metrics.map((m) => m.total_abs))),
    blank(mean(records.map((r) => Math.abs(r.bridge_away! - r.input.packet.legacy_away)))),
    blank(mean(records.map((r) => Math.abs(r.bridge_home! - r.input.packet.legacy_home)))),
    blank(maxInvariant, 12), records.filter((r) => r.confidence === "HIGH").length, verdict,
    "Frozen-total research only; accuracy excludes prediction ties; no market or active projection input.", timestamp,
  ];
}

export function selectAllocationBridgeVerdict(records: AllocationBridgeRecord[]): AllocationBridgeVerdict {
  if (records.some((record) => record.invariant_status === "FAIL")) return "FAIL";
  if (records.length < 100) return "HOLD";
  const metrics = records.map(recordMetrics);
  const comparable = metrics.filter((m) => m.legacy_correct !== "NOT_COMPARABLE" && m.bridge_correct !== "NOT_COMPARABLE");
  if (comparable.length === 0) return "HOLD";
  const legacyAccuracy = comparable.filter((m) => m.legacy_correct === "TRUE").length / comparable.length;
  const bridgeAccuracy = comparable.filter((m) => m.bridge_correct === "TRUE").length / comparable.length;
  const legacyMae = mean(metrics.map((m) => m.legacy_combined))!;
  const bridgeMae = mean(metrics.map((m) => m.bridge_combined))!;
  const legacyDiffMae = mean(metrics.map((m) => m.legacy_diff_abs))!;
  const bridgeDiffMae = mean(metrics.map((m) => m.bridge_diff_abs))!;
  if (bridgeAccuracy > legacyAccuracy && bridgeMae < legacyMae && bridgeDiffMae < legacyDiffMae) return "CANDIDATE_FOR_COMMISSIONING";
  if (bridgeAccuracy < legacyAccuracy && bridgeMae > legacyMae && bridgeDiffMae > legacyDiffMae) return "FAIL";
  return "CONTINUE_SHADOW";
}

export function buildAllocationBridgeSummaryRows(
  records: AllocationBridgeRecord[],
  verdict: AllocationBridgeVerdict,
  timestamp: string,
): unknown[][] {
  const groups: Array<[string, string, (record: AllocationBridgeRecord) => boolean]> = [
    ["OVERALL", "ALL_ELIGIBLE", () => true],
    ...["LOW", "MEDIUM", "HIGH"].map((cohort) => ["ALLOCATION_STRENGTH", cohort, (r: AllocationBridgeRecord) => allocationStrength(r) === cohort] as [string, string, (record: AllocationBridgeRecord) => boolean]),
    ...["FULL", "PARTIAL_OR_LOWER"].map((cohort) => ["LINEUP_COMPLETENESS", cohort, (r: AllocationBridgeRecord) => lineupCohort(r.input.packet) === cohort] as [string, string, (record: AllocationBridgeRecord) => boolean]),
    ...["CONVENTIONAL_BOTH", "ATYPICAL_PRESENT", "UNRESOLVED_PRESENT"].map((cohort) => ["STARTER_ROLE", cohort, (r: AllocationBridgeRecord) => roleCohort(r.input.packet) === cohort] as [string, string, (record: AllocationBridgeRecord) => boolean]),
    ...["AVAILABLE", "UNAVAILABLE_OR_PARTIAL"].map((cohort) => ["BULLPEN_DATA", cohort, (r: AllocationBridgeRecord) => bullpenCohort(r.input.packet) === cohort] as [string, string, (record: AllocationBridgeRecord) => boolean]),
    ...["GOOD", "MODERATE", "POOR"].map((cohort) => ["TOTAL_ERROR", cohort, (r: AllocationBridgeRecord) => totalErrorBucket(r) === cohort] as [string, string, (record: AllocationBridgeRecord) => boolean]),
    ["SPECIAL", "TOTAL_GOOD_ALLOCATION_BAD", (r) => totalGoodAllocationBad(r)],
  ];
  return groups.map(([dimension, cohort, predicate]) => summaryRow(dimension, cohort, records.filter(predicate), verdict, timestamp));
}

export function allocationBridgeDiagRow(record: AllocationBridgeRecord, timestamp: string): unknown[] {
  const p = record.input.packet;
  const m = recordMetrics(record);
  return [
    p.date, p.game_id, m.legacy_sign_error, m.bridge_sign_error,
    record.failure_classification, record.failure_evidence_status, record.dominant_driver,
    totalGoodAllocationBad(record) ? "TRUE" : "FALSE", allocationStrength(record), lineupCohort(p),
    roleCohort(p), bullpenCohort(p), totalErrorBucket(record), round(m.legacy_diff),
    round(m.bridge_diff), m.actual_diff, sign(m.legacy_diff) === sign(m.bridge_diff) ? "FALSE" : "TRUE",
    SEPT13_CASES.has(p.game_id) ? "TRUE" : "FALSE",
    record.failure_classification === "DAMAGE_PATH_MISSING"
      ? "Known HR_XBH_Damage_Runs inactivity limits mechanism attribution; no signal was fabricated."
      : record.notes,
    timestamp,
  ];
}

function columnLabel(columnCount: number): string {
  let value = columnCount;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

async function readOptional(workbookId: string, range: string, warnings: string[]): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message)) throw error;
    warnings.push(`MISSING_ALLOCATION_BRIDGE_SOURCE: ${range}`);
    return [];
  }
}

async function ensureSheets(workbookId: string): Promise<void> {
  const specs = [
    [ALLOCATION_BRIDGE_SHEET, ALLOCATION_BRIDGE_HEADERS.length],
    [ALLOCATION_BRIDGE_REPLAY_SHEET, ALLOCATION_BRIDGE_REPLAY_HEADERS.length],
    [ALLOCATION_BRIDGE_SUMMARY_SHEET, ALLOCATION_BRIDGE_SUMMARY_HEADERS.length],
    [ALLOCATION_BRIDGE_DIAG_SHEET, ALLOCATION_BRIDGE_DIAG_HEADERS.length],
  ] as const;
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const [name] of specs) {
    if (!existing.has(name)) await addSheet(workbookId, name);
  }
  await Promise.all(specs.map(([name, count]) => expandSheetColumns(workbookId, name, count)));
}

export async function runAllocationBridgeV1(options: { workbookId?: string } = {}): Promise<AllocationBridgeResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const timestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packets, allocations, phase] = await Promise.all([
      readOptional(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`, warnings),
      readOptional(workbookId, `${ALLOCATION_SETTLEMENT_SHEET}!A1:AB10000`, warnings),
      readOptional(workbookId, "BULLPEN_PHASE_COVERAGE_V1!A1:AI10000", warnings),
    ]);
    const inputs = buildAllocationBridgeInputs(packets, allocations, phase);
    const records = inputs.map(buildAllocationBridgeRecord);
    const eligible = records.filter((record) => record.research_status === "ELIGIBLE" && record.invariant_status === "PASS");
    const invariantFailures = records.filter((record) => record.invariant_status === "FAIL").length;
    const verdict = selectAllocationBridgeVerdict(eligible);
    const summary = buildAllocationBridgeSummaryRows(eligible, verdict, timestamp);
    const diag = eligible.map((record) => allocationBridgeDiagRow(record, timestamp));

    await ensureSheets(workbookId);
    const specs = [
      [ALLOCATION_BRIDGE_SHEET, ALLOCATION_BRIDGE_HEADERS, records.map((r) => allocationBridgeRow(r, timestamp))],
      [ALLOCATION_BRIDGE_REPLAY_SHEET, ALLOCATION_BRIDGE_REPLAY_HEADERS, eligible.map((r) => allocationBridgeReplayRow(r, timestamp))],
      [ALLOCATION_BRIDGE_SUMMARY_SHEET, ALLOCATION_BRIDGE_SUMMARY_HEADERS, summary],
      [ALLOCATION_BRIDGE_DIAG_SHEET, ALLOCATION_BRIDGE_DIAG_HEADERS, diag],
    ] as const;
    await Promise.all(specs.map(([name, headers]) => clearRange(workbookId, `${name}!A1:${columnLabel(headers.length)}10000`)));
    await Promise.all(specs.map(([name, headers, rows]) => writeRange(workbookId, `${name}!A1`, [Array.from(headers), ...rows])));

    logger.info({ eligible: eligible.length, excluded: records.length - eligible.length, verdict }, "MODULE_33: allocation bridge research complete");
    return {
      status: "success", replay_timestamp_utc: timestamp,
      allocation_rows_seen: parseAllocationOutcomes(allocations).size,
      frozen_packets_seen: parseFrozenAllocationPackets(packets).size,
      eligible_games: eligible.length, excluded_games: records.length - eligible.length,
      bridge_rows_written: records.length, replay_rows_written: eligible.length,
      summary_rows_written: summary.length, diagnostic_rows_written: diag.length,
      invariant_failures: invariantFailures, verdict, warnings, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    return {
      status: "failure", replay_timestamp_utc: timestamp,
      allocation_rows_seen: 0, frozen_packets_seen: 0, eligible_games: 0,
      excluded_games: 0, bridge_rows_written: 0, replay_rows_written: 0,
      summary_rows_written: 0, diagnostic_rows_written: 0, invariant_failures: 0,
      verdict: "FAIL", warnings, errors,
    };
  }
}
