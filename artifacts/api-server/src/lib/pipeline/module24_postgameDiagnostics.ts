/**
 * Module 24: postgame allocation, pitcher-dimension, conversion, timing,
 * full-ladder, and game-truth diagnostics.
 *
 * This is deliberately downstream of settlement. It consumes only a
 * FROZEN_PREGAME packet plus official final MLB data. It neither reconstructs
 * a missing pregame packet nor changes a projection, vehicle, price, or
 * authorization. Every numeric baseline comes from the packet, never the
 * repaired settlement projection.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import type { SettlementRow } from "./module14_shadowSettlement.js";
import {
  FULL_LADDER_AUDIT_HEADERS,
  FULL_LADDER_AUDIT_SHEET,
} from "./module20b_operatorEvidence.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const ALLOCATION_SHEET = "ALLOCATION_SETTLEMENT_DIAGNOSTICS";
const STARTER_SHEET = "STARTER_OUTCOME_DIAGNOSTICS";
const TIMING_SHEET = "BULLPEN_TIMING_DIAGNOSTICS";
const LADDER_SETTLEMENT_SHEET = "FULL_LADDER_SETTLEMENT";
const CONVERSION_SHEET = "CONVERSION_SETTLEMENT_DIAGNOSTICS";
const GAME_TRUTH_REPLAY_SHEET = "GAME_TRUTH_REPLAY_V1";

export const ALLOCATION_SETTLEMENT_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Frozen_Packet_Snapshot_TS",
  "Projected_Away_Runs",
  "Projected_Home_Runs",
  "Projected_Total",
  "Projected_Margin",
  "Actual_Away_Runs",
  "Actual_Home_Runs",
  "Actual_Total",
  "Actual_Margin",
  "Away_Run_Error",
  "Away_Abs_Error",
  "Home_Run_Error",
  "Home_Abs_Error",
  "Total_Error",
  "Total_Abs_Error",
  "Margin_Error",
  "Margin_Abs_Error",
  "Allocation_MAE",
  "Projected_Higher_Scoring_Team",
  "Actual_Higher_Scoring_Team",
  "Allocation_Sign_Reversal",
  "Allocation_Rank_Reversal",
  "Diagnostic_Status",
  "Settlement_TS",
] as const;

export const STARTER_OUTCOME_HEADERS = [
  "Date",
  "Game_ID",
  "Team_Side",
  "Team",
  "Starter",
  "Expected_IP",
  "Actual_IP",
  "IP_Delta",
  "Workload_Leash_Status",
  "Actual_Pitches",
  "BB",
  "HBP",
  "Hits",
  "Baserunners",
  "Traffic_Data_Status",
  "Contact_Data_Status",
  "xBA",
  "Hard_Hit_Pct",
  "Balls_In_Play",
  "Damage_Data_Status",
  "HR",
  "Barrels",
  "XBH",
  "Run_Prevention_Data_Status",
  "R",
  "ER",
  "Starter_Window_Runs_Allowed",
  "K",
  "Whiffs",
  "Starter_Exit_Inning",
  "Diagnostic_Status",
  "Settlement_TS",
  "Command_Traffic_Result",
  "Contact_Result",
  "Damage_Result",
  "Run_Prevention_Result",
  "Starter_Path_Summary",
] as const;

export const BULLPEN_TIMING_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Away_Starter_Exit_Inning",
  "Home_Starter_Exit_Inning",
  "Away_Starter_Window_Runs_Allowed",
  "Home_Starter_Window_Runs_Allowed",
  "Away_Bullpen_Runs_Allowed",
  "Home_Bullpen_Runs_Allowed",
  "Away_Runs_1_3",
  "Away_Runs_4_6",
  "Away_Runs_7Plus",
  "Away_Extra_Inning_Runs",
  "Home_Runs_1_3",
  "Home_Runs_4_6",
  "Home_Runs_7Plus",
  "Home_Extra_Inning_Runs",
  "Timing_Granularity",
  "Diagnostic_Status",
  "Settlement_TS",
  "Frozen_Bullpen_Data_Status",
  "Expected_Leverage_Bridge_Status",
  "Away_Bullpen_Chain",
  "Home_Bullpen_Chain",
  "Away_First_Reliever",
  "Home_First_Reliever",
  "Away_First_Reliever_Entry_Inning",
  "Home_First_Reliever_Entry_Inning",
  "Away_Starter_Exit_vs_Expected",
  "Home_Starter_Exit_vs_Expected",
  "Bullpen_Deployment_Status",
] as const;

export const FULL_LADDER_SETTLEMENT_HEADERS = [
  "Date",
  "Game_ID",
  "Directional_Truth",
  "Available_Line",
  "Actual_Total",
  "Counterfactual_Result",
  "Is_Preferred_Vehicle",
  "Selected_Vehicle_Result",
  "Adjacent_Lower_Line_Result",
  "Adjacent_Higher_Line_Result",
  "Tighter_Line_Also_Captured",
  "Wider_Line_Required",
  "All_Reasonable_Vehicles_Failed",
  "Vehicle_Grade",
  "Ticket_Status",
  "Current_Price",
  "Reasoning_Source",
  "Diagnostic_Status",
  "Settlement_TS",
] as const;

/**
 * One row per team and legitimate frozen packet.  This is not a run model:
 * it simply preserves the observed traffic -> damage -> conversion shape so
 * replay can distinguish offensive access from realized scoring.
 */
export const CONVERSION_SETTLEMENT_HEADERS = [
  "Date",
  "Game_ID",
  "Team_Side",
  "Team",
  "Frozen_Packet_Snapshot_TS",
  "Frozen_Team_Projection",
  "Frozen_Collision_Status",
  "Frozen_Collision_Traffic_Estimate",
  "Frozen_Collision_Damage_Estimate",
  "Actual_Runs",
  "Hits",
  "BB",
  "HBP",
  "Baserunners",
  "HR",
  "XBH",
  "Runs_Per_Baserunner",
  "Contact_Data_Status",
  "xBA",
  "Hard_Hit_Pct",
  "Pregame_Traffic_Signal_Status",
  "Traffic_Conversion_Flag",
  "Conversion_Outcome",
  "Diagnostic_Status",
  "Settlement_TS",
] as const;

/**
 * One joined, replay-safe game record.  It is deliberately diagnostic and
 * observational: it explains the frozen total/allocation after settlement;
 * it never computes a replacement projection or a postgame decision score.
 */
export const GAME_TRUTH_REPLAY_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Frozen_Packet_Snapshot_TS",
  "Frozen_Projected_Away_Runs",
  "Frozen_Projected_Home_Runs",
  "Frozen_Projected_Total",
  "Actual_Away_Runs",
  "Actual_Home_Runs",
  "Actual_Total",
  "Total_Error",
  "Total_Abs_Error",
  "Allocation_MAE",
  "Projected_Higher_Scoring_Team",
  "Actual_Higher_Scoring_Team",
  "Allocation_Sign_Reversal",
  "Allocation_Rank_Reversal",
  "Allocation_Observed_Mechanism",
  "Allocation_Reason_Tags",
  "Away_Starter_Path",
  "Home_Starter_Path",
  "Away_Starter_Window_Runs_Allowed",
  "Home_Starter_Window_Runs_Allowed",
  "Away_Bullpen_Runs_Allowed",
  "Home_Bullpen_Runs_Allowed",
  "Starter_Window_Runs_Total",
  "Bullpen_Window_Runs_Total",
  "Primary_Scoring_Mechanism",
  "Both_Starter_And_Bullpen_Contributed",
  "Away_Conversion_Outcome",
  "Home_Conversion_Outcome",
  "Frozen_Collision_Status",
  "Frozen_Collision_Traffic_Estimate",
  "Frozen_Collision_Damage_Estimate",
  "Replay_Status",
  "Settlement_TS",
] as const;

const LADDER = Object.fromEntries(
  FULL_LADDER_AUDIT_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof FULL_LADDER_AUDIT_HEADERS)[number], number>;

type TeamSide = "AWAY" | "HOME";
type Direction = "OVER" | "UNDER";
type ThresholdResult = "WIN" | "LOSS" | "PUSH" | "NOT_GRADABLE";

export interface FrozenPacketDiagnosticInput {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  scheduled_first_pitch: string;
  snapshot_ts: string;
  projected_away_runs: number;
  projected_home_runs: number;
  projected_total: number;
  away_expected_ip: number | null;
  home_expected_ip: number | null;
  bullpen_data_status?: string;
  collision_status?: string;
  collision_traffic_estimate?: number | null;
  collision_damage_estimate?: number | null;
  operator_evidence_status?: string;
  away_lineup_status?: string;
  home_lineup_status?: string;
}

export interface StarterDimension {
  name: string;
  innings: number | null;
  outs: number | null;
  pitches: number | null;
  bb: number | null;
  hbp: number | null;
  hits: number | null;
  hr: number | null;
  xbh: number | null;
  runs: number | null;
  earned_runs: number | null;
  strikeouts: number | null;
}

export interface BullpenAppearance {
  name: string;
  innings: number | null;
  outs: number | null;
  pitches: number | null;
  runs: number | null;
  earned_runs: number | null;
}

export interface TeamBattingDimension {
  hits: number | null;
  bb: number | null;
  hbp: number | null;
  hr: number | null;
  xbh: number | null;
  strikeouts: number | null;
  at_bats: number | null;
  balls_in_play: number | null;
}

export interface PostgameGameDetail {
  away: StarterDimension | null;
  home: StarterDimension | null;
  away_bullpen: BullpenAppearance[];
  home_bullpen: BullpenAppearance[];
  away_batting: TeamBattingDimension | null;
  home_batting: TeamBattingDimension | null;
  away_runs_by_inning: Map<number, number>;
  home_runs_by_inning: Map<number, number>;
  status: "AVAILABLE" | "POSTGAME_DETAIL_UNAVAILABLE";
}

export interface PostgameDiagnosticsResult {
  status: "success" | "failure";
  date: string;
  allocation_rows_written: number;
  starter_rows_written: number;
  timing_rows_written: number;
  conversion_rows_written: number;
  game_truth_rows_written: number;
  ladder_rows_written: number;
  frozen_packet_games: number;
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
function round2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}
function key(...parts: unknown[]): string {
  return parts.map(text).join("|");
}
function pad(row: unknown[], length: number): unknown[] {
  const next = row.slice(0, length);
  while (next.length < length) next.push("");
  return next;
}
function validBefore(snapshotTs: string, firstPitch: string): boolean {
  const snapshot = Date.parse(snapshotTs);
  const first = Date.parse(firstPitch);
  return (
    Number.isFinite(snapshot) && Number.isFinite(first) && snapshot < first
  );
}
function teamWinner(away: number, home: number): "AWAY" | "HOME" | "TIE" {
  return away === home ? "TIE" : away > home ? "AWAY" : "HOME";
}
function signReversal(
  projectedAway: number,
  projectedHome: number,
  actualAway: number,
  actualHome: number,
): string {
  const projected = teamWinner(projectedAway, projectedHome);
  const actual = teamWinner(actualAway, actualHome);
  if (projected === "TIE" || actual === "TIE") return "NOT_COMPARABLE";
  return projected === actual ? "FALSE" : "TRUE";
}

/** Parse only legitimate frozen packet records. Open/gap rows remain ineligible. */
export function parseFrozenPacketDiagnostics(
  rows: unknown[][],
  date: string,
): Map<string, FrozenPacketDiagnosticInput> {
  const [header = [], ...data] = rows;
  const index = new Map(
    (header as unknown[]).map((value, position) => [text(value), position]),
  );
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const packetByGame = new Map<string, FrozenPacketDiagnosticInput>();
  for (const row of data) {
    if (text(value(row, "Date")) !== date) continue;
    if (text(value(row, "Packet_Status")) !== "FROZEN_PREGAME") continue;
    const gameId = text(value(row, "Game_ID"));
    const firstPitch = text(value(row, "Scheduled_First_Pitch"));
    const snapshotTs = text(value(row, "Packet_Snapshot_TS"));
    const away = numeric(value(row, "Base_Away_Projection"));
    const home = numeric(value(row, "Base_Home_Projection"));
    const total = numeric(value(row, "Base_Projection"));
    if (
      !gameId ||
      !validBefore(snapshotTs, firstPitch) ||
      away === null ||
      home === null ||
      total === null
    )
      continue;
    packetByGame.set(gameId, {
      date,
      game_id: gameId,
      away_team: text(value(row, "Away_Team")),
      home_team: text(value(row, "Home_Team")),
      scheduled_first_pitch: firstPitch,
      snapshot_ts: snapshotTs,
      projected_away_runs: away,
      projected_home_runs: home,
      projected_total: total,
      away_expected_ip: numeric(value(row, "Away_Expected_IP")),
      home_expected_ip: numeric(value(row, "Home_Expected_IP")),
      bullpen_data_status: text(value(row, "Bullpen_Data_Status")),
      collision_status: text(value(row, "Collision_Status")),
      collision_traffic_estimate: numeric(
        value(row, "Collision_Traffic_Estimate"),
      ),
      collision_damage_estimate: numeric(
        value(row, "Collision_Damage_Estimate"),
      ),
      operator_evidence_status: text(value(row, "Operator_Evidence_Status")),
      away_lineup_status: text(value(row, "Away_Lineup_Status")),
      home_lineup_status: text(value(row, "Home_Lineup_Status")),
    });
  }
  return packetByGame;
}

export function buildAllocationDiagnostic(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<
    SettlementRow,
    "actual_away_runs" | "actual_home_runs" | "actual_total" | "settlement_ts"
  >,
): unknown[] {
  const projectedMargin = round2(
    packet.projected_away_runs - packet.projected_home_runs,
  );
  const actualMargin = outcome.actual_away_runs - outcome.actual_home_runs;
  const awayError = round2(
    packet.projected_away_runs - outcome.actual_away_runs,
  );
  const homeError = round2(
    packet.projected_home_runs - outcome.actual_home_runs,
  );
  const totalError = round2(packet.projected_total - outcome.actual_total);
  const marginError = round2(projectedMargin - actualMargin);
  return [
    packet.date,
    packet.game_id,
    packet.away_team,
    packet.home_team,
    packet.snapshot_ts,
    packet.projected_away_runs,
    packet.projected_home_runs,
    packet.projected_total,
    projectedMargin,
    outcome.actual_away_runs,
    outcome.actual_home_runs,
    outcome.actual_total,
    actualMargin,
    awayError,
    Math.abs(awayError),
    homeError,
    Math.abs(homeError),
    totalError,
    Math.abs(totalError),
    marginError,
    Math.abs(marginError),
    round2((Math.abs(awayError) + Math.abs(homeError)) / 2),
    teamWinner(packet.projected_away_runs, packet.projected_home_runs),
    teamWinner(outcome.actual_away_runs, outcome.actual_home_runs),
    signReversal(
      packet.projected_away_runs,
      packet.projected_home_runs,
      outcome.actual_away_runs,
      outcome.actual_home_runs,
    ),
    signReversal(
      packet.projected_away_runs,
      packet.projected_home_runs,
      outcome.actual_away_runs,
      outcome.actual_home_runs,
    ),
    "FROZEN_PACKET_VERIFIED",
    outcome.settlement_ts,
  ];
}

function inningsToOuts(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const [wholeRaw, partialRaw = "0"] = raw.split(".");
  const whole = Number.parseInt(wholeRaw ?? "", 10);
  const partial = Number.parseInt(partialRaw, 10);
  return Number.isFinite(whole) &&
    Number.isFinite(partial) &&
    partial >= 0 &&
    partial <= 2
    ? whole * 3 + partial
    : null;
}

function numberField(
  input: Record<string, unknown>,
  ...names: string[]
): number | null {
  for (const name of names) {
    const value = input[name];
    const parsed = numeric(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

interface PitchingAppearance extends StarterDimension {
  games_started: number;
}

interface RawTeamBoxscore {
  pitchers?: Array<number | string>;
  players?: Record<
    string,
    {
      person?: { id?: number; fullName?: string };
      stats?: {
        pitching?: Record<string, unknown>;
        batting?: Record<string, unknown>;
      };
    }
  >;
  teamStats?: { batting?: Record<string, unknown> };
}

function asTeamBoxscore(rawTeam: unknown): RawTeamBoxscore {
  return (rawTeam ?? {}) as RawTeamBoxscore;
}

function pitchingAppearancesFromTeam(rawTeam: unknown): PitchingAppearance[] {
  const team = asTeamBoxscore(rawTeam);
  return (team.pitchers ?? []).flatMap((id) => {
    const player =
      team.players?.[`ID${id}`] ??
      Object.values(team.players ?? {}).find(
        (candidate) => String(candidate.person?.id ?? "") === String(id),
      );
    const stats = player?.stats?.pitching;
    const name = text(player?.person?.fullName);
    if (!stats || !name) return [];
    const outs =
      numberField(stats, "outs") ?? inningsToOuts(stats.inningsPitched);
    const doubles = numberField(stats, "doubles");
    const triples = numberField(stats, "triples");
    const homers = numberField(stats, "homeRuns");
    return [
      {
        name,
        games_started: numberField(stats, "gamesStarted") ?? 0,
        outs,
        innings:
          outs === null ? numeric(stats.inningsPitched) : round2(outs / 3),
        pitches: numberField(stats, "pitchesThrown", "pitches"),
        bb: numberField(stats, "baseOnBalls", "walks"),
        hbp: numberField(stats, "hitBatsmen", "hitByPitch"),
        hits: numberField(stats, "hits"),
        hr: homers,
        xbh:
          doubles === null || triples === null || homers === null
            ? null
            : doubles + triples + homers,
        runs: numberField(stats, "runs"),
        earned_runs: numberField(stats, "earnedRuns"),
        strikeouts: numberField(stats, "strikeOuts", "strikeouts"),
      },
    ];
  });
}

function starterAndBullpenFromTeam(rawTeam: unknown): {
  starter: StarterDimension | null;
  bullpen: BullpenAppearance[];
} {
  const appearances = pitchingAppearancesFromTeam(rawTeam);
  const starterIndex = appearances.findIndex(
    (appearance) => appearance.games_started > 0,
  );
  const selectedIndex =
    starterIndex >= 0 ? starterIndex : appearances.length > 0 ? 0 : -1;
  const selected = selectedIndex >= 0 ? appearances[selectedIndex]! : null;
  const bullpen = appearances
    .filter((_, index) => index !== selectedIndex)
    .map((appearance) => ({
      name: appearance.name,
      innings: appearance.innings,
      outs: appearance.outs,
      pitches: appearance.pitches,
      runs: appearance.runs,
      earned_runs: appearance.earned_runs,
    }));
  if (!selected) return { starter: null, bullpen };
  return {
    starter: {
      name: selected.name,
      innings: selected.innings,
      outs: selected.outs,
      pitches: selected.pitches,
      bb: selected.bb,
      hbp: selected.hbp,
      hits: selected.hits,
      hr: selected.hr,
      xbh: selected.xbh,
      runs: selected.runs,
      earned_runs: selected.earned_runs,
      strikeouts: selected.strikeouts,
    },
    bullpen,
  };
}

function battingFromTeam(rawTeam: unknown): TeamBattingDimension | null {
  const stats = asTeamBoxscore(rawTeam).teamStats?.batting;
  if (!stats) return null;
  const hits = numberField(stats, "hits");
  const bb = numberField(stats, "baseOnBalls", "walks");
  const hbp = numberField(stats, "hitByPitch", "hitBatsmen");
  const hr = numberField(stats, "homeRuns");
  const doubles = numberField(stats, "doubles");
  const triples = numberField(stats, "triples");
  const strikeouts = numberField(stats, "strikeOuts", "strikeouts");
  const atBats = numberField(stats, "atBats");
  const xbh =
    doubles === null || triples === null || hr === null
      ? null
      : doubles + triples + hr;
  const ballsInPlay =
    atBats === null || strikeouts === null || hr === null
      ? null
      : Math.max(0, atBats - strikeouts - hr);
  const anyAvailable = [
    hits,
    bb,
    hbp,
    hr,
    doubles,
    triples,
    strikeouts,
    atBats,
  ].some((value) => value !== null);
  return anyAvailable
    ? {
        hits,
        bb,
        hbp,
        hr,
        xbh,
        strikeouts,
        at_bats: atBats,
        balls_in_play: ballsInPlay,
      }
    : null;
}

function inningRuns(linescore: unknown, side: TeamSide): Map<number, number> {
  const innings =
    (
      (linescore ?? {}) as {
        innings?: Array<{
          num?: number;
          away?: { runs?: number };
          home?: { runs?: number };
        }>;
      }
    ).innings ?? [];
  const values = new Map<number, number>();
  for (const inning of innings) {
    const number = Number(inning.num ?? 0);
    const runs = side === "AWAY" ? inning.away?.runs : inning.home?.runs;
    if (Number.isFinite(number) && number > 0 && typeof runs === "number")
      values.set(number, runs);
  }
  return values;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Frostline-Settlement/1.0" },
    });
    if (!response.ok) throw new Error(`MLB API ${response.status} for ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pure MLB payload parser kept separate from network retrieval for regression testing. */
export function parsePostgameDetailPayload(
  boxscore: unknown,
  linescore: unknown,
): PostgameGameDetail {
  const raw = boxscore as { teams?: { away?: unknown; home?: unknown } };
  const awayPitching = starterAndBullpenFromTeam(raw.teams?.away);
  const homePitching = starterAndBullpenFromTeam(raw.teams?.home);
  return {
    away: awayPitching.starter,
    home: homePitching.starter,
    away_bullpen: awayPitching.bullpen,
    home_bullpen: homePitching.bullpen,
    away_batting: battingFromTeam(raw.teams?.away),
    home_batting: battingFromTeam(raw.teams?.home),
    away_runs_by_inning: inningRuns(linescore, "AWAY"),
    home_runs_by_inning: inningRuns(linescore, "HOME"),
    status: "AVAILABLE",
  };
}

async function fetchPostgameDetail(
  gamePk: number,
): Promise<PostgameGameDetail> {
  const [boxscore, linescore] = await Promise.all([
    fetchJson(`${MLB_API}/game/${gamePk}/boxscore`),
    fetchJson(`${MLB_API}/game/${gamePk}/linescore`),
  ]);
  return parsePostgameDetailPayload(boxscore, linescore);
}

function timingBand(
  runs: Map<number, number>,
  start: number,
  end: number,
): number {
  let total = 0;
  for (const [inning, value] of runs)
    if (inning >= start && inning <= end) total += value;
  return total;
}
function lateRuns(runs: Map<number, number>): number {
  let total = 0;
  for (const [inning, value] of runs)
    if (inning >= 7 && inning <= 9) total += value;
  return total;
}
function extraRuns(runs: Map<number, number>): number {
  let total = 0;
  for (const [inning, value] of runs) if (inning >= 10) total += value;
  return total;
}
function exitInning(starter: StarterDimension | null): number | "" {
  if (!starter?.outs && starter?.outs !== 0) return "";
  return Math.floor(starter.outs / 3) + 1;
}

export function workloadLeashStatus(
  expected: number | null,
  actual: number | null,
): string {
  if (expected === null) return "EXPECTED_IP_UNAVAILABLE";
  if (actual === null) return "ACTUAL_IP_UNAVAILABLE";
  return actual >= expected ? "REACHED_EXPECTED_IP" : "SHORT_OF_EXPECTED_IP";
}

export function commandTrafficResult(starter: StarterDimension | null): string {
  if (!starter) return "POSTGAME_DETAIL_UNAVAILABLE";
  if (starter.bb === null || starter.hbp === null || starter.hits === null)
    return "TRAFFIC_DATA_UNAVAILABLE";
  const walkTraffic = starter.bb + starter.hbp;
  if (walkTraffic === 0 && starter.hits === 0) return "NO_TRAFFIC_ALLOWED";
  if (walkTraffic > 0 && starter.hits > 0) return "MIXED_WALK_AND_HIT_TRAFFIC";
  return walkTraffic > 0 ? "WALK_HBP_TRAFFIC" : "HIT_TRAFFIC";
}

export function contactResult(starter: StarterDimension | null): string {
  return starter
    ? "UNAVAILABLE_FROM_MLB_BOXSCORE"
    : "POSTGAME_DETAIL_UNAVAILABLE";
}

export function damageResult(starter: StarterDimension | null): string {
  if (!starter) return "POSTGAME_DETAIL_UNAVAILABLE";
  if (starter.hr === null || starter.xbh === null)
    return "DAMAGE_DATA_UNAVAILABLE";
  if (starter.hr > 0) return "HR_DAMAGE_ALLOWED";
  if (starter.xbh > 0) return "XBH_DAMAGE_ALLOWED";
  return "NO_XBH_ALLOWED";
}

export function runPreventionResult(starter: StarterDimension | null): string {
  if (!starter || starter.runs === null || starter.earned_runs === null)
    return "RUN_PREVENTION_DATA_UNAVAILABLE";
  return starter.runs === 0 ? "SHUTOUT_STARTER_WINDOW" : "RUNS_ALLOWED";
}

export interface StarterPathEvidence {
  workload: string;
  command_traffic: string;
  contact: string;
  damage: string;
  run_prevention: string;
  summary: string;
}

export function starterPathEvidence(
  expected: number | null,
  starter: StarterDimension | null,
): StarterPathEvidence {
  const workload = workloadLeashStatus(expected, starter?.innings ?? null);
  const commandTraffic = commandTrafficResult(starter);
  const contact = contactResult(starter);
  const damage = damageResult(starter);
  const runPrevention = runPreventionResult(starter);
  return {
    workload,
    command_traffic: commandTraffic,
    contact,
    damage,
    run_prevention: runPrevention,
    summary: `WORKLOAD=${workload}; COMMAND_TRAFFIC=${commandTraffic}; CONTACT=${contact}; DAMAGE=${damage}; RUN_PREVENTION=${runPrevention}`,
  };
}

function starterRows(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<SettlementRow, "settlement_ts">,
  detail: PostgameGameDetail,
): unknown[][] {
  const rowFor = (
    side: TeamSide,
    starter: StarterDimension | null,
    expected: number | null,
    team: string,
  ): unknown[] => {
    const actualIp = starter?.innings ?? null;
    const bb = starter?.bb ?? null;
    const hbp = starter?.hbp ?? null;
    const hits = starter?.hits ?? null;
    const hr = starter?.hr ?? null;
    const xbh = starter?.xbh ?? null;
    const traffic =
      bb === null || hits === null || hbp === null
        ? "UNAVAILABLE"
        : "AVAILABLE";
    const damage = hr === null || xbh === null ? "PARTIAL" : "AVAILABLE";
    const runPrevention =
      starter?.runs === null || starter?.earned_runs === null
        ? "PARTIAL"
        : starter
          ? "AVAILABLE"
          : "UNAVAILABLE";
    const status =
      detail.status === "AVAILABLE" && starter
        ? "AVAILABLE"
        : "POSTGAME_DETAIL_UNAVAILABLE";
    const path = starterPathEvidence(expected, starter);
    return [
      packet.date,
      packet.game_id,
      side,
      team,
      starter?.name ?? "",
      expected ?? "",
      actualIp ?? "",
      expected === null || actualIp === null ? "" : round2(actualIp - expected),
      workloadLeashStatus(expected, actualIp),
      starter?.pitches ?? "",
      bb ?? "",
      hbp ?? "",
      hits ?? "",
      bb === null || hbp === null || hits === null ? "" : bb + hbp + hits,
      traffic,
      "UNAVAILABLE_FROM_MLB_BOXSCORE",
      "",
      "",
      "",
      damage,
      hr ?? "",
      "",
      xbh ?? "",
      runPrevention,
      starter?.runs ?? "",
      starter?.earned_runs ?? "",
      starter?.runs ?? "",
      starter?.strikeouts ?? "",
      "",
      exitInning(starter),
      status,
      outcome.settlement_ts,
      path.command_traffic,
      path.contact,
      path.damage,
      path.run_prevention,
      path.summary,
    ];
  };
  return [
    rowFor("AWAY", detail.away, packet.away_expected_ip, packet.away_team),
    rowFor("HOME", detail.home, packet.home_expected_ip, packet.home_team),
  ];
}

export interface TimingDiagnosticEvidence {
  away_starter_exit_inning: number | "";
  home_starter_exit_inning: number | "";
  away_starter_window_runs_allowed: number | "";
  home_starter_window_runs_allowed: number | "";
  away_bullpen_runs_allowed: number | "";
  home_bullpen_runs_allowed: number | "";
  away_runs_1_3: number | "";
  away_runs_4_6: number | "";
  away_runs_7_plus: number | "";
  away_extra_inning_runs: number | "";
  home_runs_1_3: number | "";
  home_runs_4_6: number | "";
  home_runs_7_plus: number | "";
  home_extra_inning_runs: number | "";
  timing_granularity: string;
  diagnostic_status: string;
  frozen_bullpen_data_status: string;
  expected_leverage_bridge_status: string;
  away_bullpen_chain: string;
  home_bullpen_chain: string;
  away_first_reliever: string;
  home_first_reliever: string;
  away_first_reliever_entry_inning: number | "";
  home_first_reliever_entry_inning: number | "";
  away_starter_exit_vs_expected: string;
  home_starter_exit_vs_expected: string;
  bullpen_deployment_status: string;
}

function chainText(appearances: BullpenAppearance[]): string {
  return appearances
    .map((appearance) => {
      const innings = appearance.innings === null ? "?" : appearance.innings;
      const runs = appearance.runs === null ? "?" : appearance.runs;
      return `${appearance.name} ${innings}IP/${runs}R`;
    })
    .join("; ");
}

function starterExitVsExpected(
  expected: number | null,
  actual: number | null,
): string {
  if (expected === null || actual === null) return "NOT_COMPARABLE";
  return actual < expected ? "EARLIER_THAN_EXPECTED" : "AT_OR_AFTER_EXPECTED";
}

export function buildTimingDiagnostic(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<SettlementRow, "actual_away_runs" | "actual_home_runs">,
  detail: PostgameGameDetail,
): TimingDiagnosticEvidence {
  const awayStarterRuns = detail.away?.runs ?? null;
  const homeStarterRuns = detail.home?.runs ?? null;
  const hasInningDetail = detail.status === "AVAILABLE";
  const band = (
    runs: Map<number, number>,
    start: number,
    end: number,
  ): number | "" => (hasInningDetail ? timingBand(runs, start, end) : "");
  const late = (runs: Map<number, number>): number | "" =>
    hasInningDetail ? lateRuns(runs) : "";
  const extra = (runs: Map<number, number>): number | "" =>
    hasInningDetail ? extraRuns(runs) : "";
  const awayFirstReliever = detail.away_bullpen[0] ?? null;
  const homeFirstReliever = detail.home_bullpen[0] ?? null;
  const awayExit = exitInning(detail.away);
  const homeExit = exitInning(detail.home);
  return {
    away_starter_exit_inning: awayExit,
    home_starter_exit_inning: homeExit,
    away_starter_window_runs_allowed: awayStarterRuns ?? "",
    home_starter_window_runs_allowed: homeStarterRuns ?? "",
    away_bullpen_runs_allowed:
      awayStarterRuns === null
        ? ""
        : Math.max(0, outcome.actual_home_runs - awayStarterRuns),
    home_bullpen_runs_allowed:
      homeStarterRuns === null
        ? ""
        : Math.max(0, outcome.actual_away_runs - homeStarterRuns),
    away_runs_1_3: band(detail.away_runs_by_inning, 1, 3),
    away_runs_4_6: band(detail.away_runs_by_inning, 4, 6),
    away_runs_7_plus: late(detail.away_runs_by_inning),
    away_extra_inning_runs: extra(detail.away_runs_by_inning),
    home_runs_1_3: band(detail.home_runs_by_inning, 1, 3),
    home_runs_4_6: band(detail.home_runs_by_inning, 4, 6),
    home_runs_7_plus: late(detail.home_runs_by_inning),
    home_extra_inning_runs: extra(detail.home_runs_by_inning),
    timing_granularity:
      detail.status === "AVAILABLE" ? "INNING_LEVEL" : "UNAVAILABLE",
    diagnostic_status: detail.status,
    frozen_bullpen_data_status: packet.bullpen_data_status || "UNAVAILABLE",
    // v32 freezes only team bullpen availability, not a named role-by-role
    // leverage plan.  State that boundary explicitly instead of inventing
    // whether a closer/setup bridge "appeared" after the result is known.
    expected_leverage_bridge_status:
      packet.bullpen_data_status === "AVAILABLE"
        ? "NOT_EVALUABLE_NAMED_BRIDGE_NOT_FROZEN"
        : "PREGAME_BULLPEN_CONTEXT_UNAVAILABLE",
    away_bullpen_chain: chainText(detail.away_bullpen),
    home_bullpen_chain: chainText(detail.home_bullpen),
    away_first_reliever: awayFirstReliever?.name ?? "",
    home_first_reliever: homeFirstReliever?.name ?? "",
    away_first_reliever_entry_inning: awayFirstReliever ? awayExit : "",
    home_first_reliever_entry_inning: homeFirstReliever ? homeExit : "",
    away_starter_exit_vs_expected: starterExitVsExpected(
      packet.away_expected_ip,
      detail.away?.innings ?? null,
    ),
    home_starter_exit_vs_expected: starterExitVsExpected(
      packet.home_expected_ip,
      detail.home?.innings ?? null,
    ),
    bullpen_deployment_status:
      detail.status === "AVAILABLE"
        ? "ACTUAL_CHAIN_RECORDED"
        : "POSTGAME_DETAIL_UNAVAILABLE",
  };
}

function timingRow(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<
    SettlementRow,
    "actual_away_runs" | "actual_home_runs" | "settlement_ts"
  >,
  detail: PostgameGameDetail,
): unknown[] {
  const timing = buildTimingDiagnostic(packet, outcome, detail);
  return [
    packet.date,
    packet.game_id,
    packet.away_team,
    packet.home_team,
    timing.away_starter_exit_inning,
    timing.home_starter_exit_inning,
    timing.away_starter_window_runs_allowed,
    timing.home_starter_window_runs_allowed,
    timing.away_bullpen_runs_allowed,
    timing.home_bullpen_runs_allowed,
    timing.away_runs_1_3,
    timing.away_runs_4_6,
    timing.away_runs_7_plus,
    timing.away_extra_inning_runs,
    timing.home_runs_1_3,
    timing.home_runs_4_6,
    timing.home_runs_7_plus,
    timing.home_extra_inning_runs,
    timing.timing_granularity,
    timing.diagnostic_status,
    outcome.settlement_ts,
    timing.frozen_bullpen_data_status,
    timing.expected_leverage_bridge_status,
    timing.away_bullpen_chain,
    timing.home_bullpen_chain,
    timing.away_first_reliever,
    timing.home_first_reliever,
    timing.away_first_reliever_entry_inning,
    timing.home_first_reliever_entry_inning,
    timing.away_starter_exit_vs_expected,
    timing.home_starter_exit_vs_expected,
    timing.bullpen_deployment_status,
  ];
}

export interface ConversionDiagnosticEvidence {
  side: TeamSide;
  team: string;
  frozen_team_projection: number;
  actual_runs: number;
  hits: number | null;
  bb: number | null;
  hbp: number | null;
  baserunners: number | null;
  hr: number | null;
  xbh: number | null;
  runs_per_baserunner: number | null;
  pregame_traffic_signal_status: string;
  traffic_conversion_flag: string;
  conversion_outcome: string;
  diagnostic_status: string;
}

function teamBattingForSide(
  detail: PostgameGameDetail,
  side: TeamSide,
): TeamBattingDimension | null {
  return side === "AWAY" ? detail.away_batting : detail.home_batting;
}

function teamForSide(
  packet: FrozenPacketDiagnosticInput,
  side: TeamSide,
): string {
  return side === "AWAY" ? packet.away_team : packet.home_team;
}

function projectionForSide(
  packet: FrozenPacketDiagnosticInput,
  side: TeamSide,
): number {
  return side === "AWAY"
    ? packet.projected_away_runs
    : packet.projected_home_runs;
}

function actualRunsForSide(
  outcome: Pick<SettlementRow, "actual_away_runs" | "actual_home_runs">,
  side: TeamSide,
): number {
  return side === "AWAY" ? outcome.actual_away_runs : outcome.actual_home_runs;
}

/**
 * Classifies observed conversion against the preserved allocation without
 * inventing a run-rate threshold.  A positive collision traffic estimate is
 * only a pregame candidate; it does not prove a team should have converted.
 */
export function buildConversionDiagnostic(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<SettlementRow, "actual_away_runs" | "actual_home_runs">,
  detail: PostgameGameDetail,
  side: TeamSide,
): ConversionDiagnosticEvidence {
  const batting = teamBattingForSide(detail, side);
  const projection = projectionForSide(packet, side);
  const actualRuns = actualRunsForSide(outcome, side);
  const trafficEstimate = packet.collision_traffic_estimate;
  const pregameTrafficSignal =
    packet.collision_status === "PROSPECTIVE_SHADOW_CANDIDATE" &&
    trafficEstimate !== null &&
    trafficEstimate !== undefined &&
    trafficEstimate > 0;
  if (!batting) {
    return {
      side,
      team: teamForSide(packet, side),
      frozen_team_projection: projection,
      actual_runs: actualRuns,
      hits: null,
      bb: null,
      hbp: null,
      baserunners: null,
      hr: null,
      xbh: null,
      runs_per_baserunner: null,
      pregame_traffic_signal_status: pregameTrafficSignal
        ? "POSITIVE_FROZEN_TRAFFIC_CANDIDATE"
        : "NO_POSITIVE_FROZEN_TRAFFIC_SIGNAL",
      traffic_conversion_flag: "POSTGAME_BATTING_UNAVAILABLE",
      conversion_outcome: "NOT_GRADABLE",
      diagnostic_status: "POSTGAME_BATTING_UNAVAILABLE",
    };
  }
  const baserunners =
    batting.hits === null || batting.bb === null || batting.hbp === null
      ? null
      : batting.hits + batting.bb + batting.hbp;
  const flag = !pregameTrafficSignal
    ? "NO_POSITIVE_FROZEN_TRAFFIC_SIGNAL"
    : baserunners === null
      ? "POSTGAME_TRAFFIC_UNAVAILABLE"
      : baserunners === 0
        ? "FROZEN_TRAFFIC_SIGNAL_NO_BASERUNNERS"
        : actualRuns < projection
          ? "FROZEN_TRAFFIC_SIGNAL_WITH_RUN_SHORTFALL"
          : "FROZEN_TRAFFIC_SIGNAL_WITH_ALLOCATION_MET";
  const conversionOutcome =
    flag === "FROZEN_TRAFFIC_SIGNAL_WITH_RUN_SHORTFALL"
      ? "TRAFFIC_REALIZED_CONVERSION_SHORTFALL"
      : flag === "FROZEN_TRAFFIC_SIGNAL_WITH_ALLOCATION_MET"
        ? "TRAFFIC_REALIZED_ALLOCATION_MET"
        : flag === "NO_POSITIVE_FROZEN_TRAFFIC_SIGNAL"
          ? "NO_FROZEN_TRAFFIC_CANDIDATE"
          : "NOT_GRADABLE";
  return {
    side,
    team: teamForSide(packet, side),
    frozen_team_projection: projection,
    actual_runs: actualRuns,
    hits: batting.hits,
    bb: batting.bb,
    hbp: batting.hbp,
    baserunners,
    hr: batting.hr,
    xbh: batting.xbh,
    runs_per_baserunner:
      baserunners && baserunners > 0 ? round2(actualRuns / baserunners) : null,
    pregame_traffic_signal_status: pregameTrafficSignal
      ? "POSITIVE_FROZEN_TRAFFIC_CANDIDATE"
      : "NO_POSITIVE_FROZEN_TRAFFIC_SIGNAL",
    traffic_conversion_flag: flag,
    conversion_outcome: conversionOutcome,
    diagnostic_status: "FROZEN_PACKET_VERIFIED",
  };
}

function conversionRow(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<
    SettlementRow,
    "actual_away_runs" | "actual_home_runs" | "settlement_ts"
  >,
  evidence: ConversionDiagnosticEvidence,
): unknown[] {
  return [
    packet.date,
    packet.game_id,
    evidence.side,
    evidence.team,
    packet.snapshot_ts,
    evidence.frozen_team_projection,
    packet.collision_status || "SOURCE_UNAVAILABLE",
    packet.collision_traffic_estimate ?? "",
    packet.collision_damage_estimate ?? "",
    evidence.actual_runs,
    evidence.hits ?? "",
    evidence.bb ?? "",
    evidence.hbp ?? "",
    evidence.baserunners ?? "",
    evidence.hr ?? "",
    evidence.xbh ?? "",
    evidence.runs_per_baserunner ?? "",
    evidence.hits === null
      ? "POSTGAME_BATTING_UNAVAILABLE"
      : "UNAVAILABLE_FROM_MLB_BOXSCORE",
    "",
    "",
    evidence.pregame_traffic_signal_status,
    evidence.traffic_conversion_flag,
    evidence.conversion_outcome,
    evidence.diagnostic_status,
    outcome.settlement_ts,
  ];
}

function timingTotals(timing: TimingDiagnosticEvidence): {
  starter_total: number | null;
  bullpen_total: number | null;
  primary: string;
  both_contributed: string;
} {
  const values = [
    timing.away_starter_window_runs_allowed,
    timing.home_starter_window_runs_allowed,
    timing.away_bullpen_runs_allowed,
    timing.home_bullpen_runs_allowed,
  ];
  if (values.some((value) => typeof value !== "number")) {
    return {
      starter_total: null,
      bullpen_total: null,
      primary: "POSTGAME_DETAIL_UNAVAILABLE",
      both_contributed: "NOT_GRADABLE",
    };
  }
  const starterTotal =
    (timing.away_starter_window_runs_allowed as number) +
    (timing.home_starter_window_runs_allowed as number);
  const bullpenTotal =
    (timing.away_bullpen_runs_allowed as number) +
    (timing.home_bullpen_runs_allowed as number);
  const primary =
    starterTotal > bullpenTotal
      ? "STARTER_WINDOW_PRIMARY"
      : bullpenTotal > starterTotal
        ? "BULLPEN_TRANSITION_PRIMARY"
        : starterTotal > 0
          ? "BALANCED_STARTER_AND_BULLPEN"
          : "NO_STARTER_OR_BULLPEN_RUNS";
  return {
    starter_total: starterTotal,
    bullpen_total: bullpenTotal,
    primary,
    both_contributed: starterTotal > 0 && bullpenTotal > 0 ? "TRUE" : "FALSE",
  };
}

function allocationReasonTags(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<SettlementRow, "actual_away_runs" | "actual_home_runs">,
  allocationReversal: string,
  primaryMechanism: string,
  awayConversion: ConversionDiagnosticEvidence,
  homeConversion: ConversionDiagnosticEvidence,
): string {
  if (allocationReversal !== "TRUE") {
    return allocationReversal === "NOT_COMPARABLE"
      ? "ALLOCATION_NOT_COMPARABLE"
      : "NO_ALLOCATION_REVERSAL";
  }
  const projectedHigher = teamWinner(
    packet.projected_away_runs,
    packet.projected_home_runs,
  );
  const actualHigher = teamWinner(
    outcome.actual_away_runs,
    outcome.actual_home_runs,
  );
  const projectedHighProjection =
    projectedHigher === "AWAY"
      ? packet.projected_away_runs
      : packet.projected_home_runs;
  const projectedHighActual =
    projectedHigher === "AWAY"
      ? outcome.actual_away_runs
      : outcome.actual_home_runs;
  const unexpectedProjection =
    actualHigher === "AWAY"
      ? packet.projected_away_runs
      : packet.projected_home_runs;
  const unexpectedActual =
    actualHigher === "AWAY"
      ? outcome.actual_away_runs
      : outcome.actual_home_runs;
  const projectedHighConversion =
    projectedHigher === "AWAY" ? awayConversion : homeConversion;
  const tags = ["ALLOCATION_REVERSAL", `OBSERVED_${primaryMechanism}`];
  if (projectedHighActual < projectedHighProjection)
    tags.push("PROJECTED_HIGHER_SIDE_UNDERDELIVERED");
  if (unexpectedActual > unexpectedProjection)
    tags.push("UNEXPECTED_HIGHER_SIDE_OVERDELIVERED");
  if (
    projectedHighConversion.conversion_outcome ===
    "TRAFFIC_REALIZED_CONVERSION_SHORTFALL"
  ) {
    tags.push("PROJECTED_ATTACK_TRAFFIC_CONVERSION_SHORTFALL");
  }
  if (packet.operator_evidence_status === "MANUAL_OPERATOR_CAPTURED")
    tags.push("OPERATOR_EVIDENCE_PRESENT");
  if (packet.away_lineup_status && packet.away_lineup_status !== "FULL")
    tags.push(`AWAY_LINEUP_${packet.away_lineup_status}`);
  if (packet.home_lineup_status && packet.home_lineup_status !== "FULL")
    tags.push(`HOME_LINEUP_${packet.home_lineup_status}`);
  return tags.join(";");
}

/** Builds one joined, strictly observational game-truth replay row. */
export function buildGameTruthReplay(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<
    SettlementRow,
    "actual_away_runs" | "actual_home_runs" | "actual_total" | "settlement_ts"
  >,
  detail: PostgameGameDetail,
): unknown[] {
  const allocation = buildAllocationDiagnostic(packet, outcome);
  const allocationMae = allocation[21];
  const projectedHigher = text(allocation[22]);
  const actualHigher = text(allocation[23]);
  const allocationReversal = text(allocation[24]);
  const allocationRankReversal = text(allocation[25]);
  const awayPath = starterPathEvidence(packet.away_expected_ip, detail.away);
  const homePath = starterPathEvidence(packet.home_expected_ip, detail.home);
  const timing = buildTimingDiagnostic(packet, outcome, detail);
  const totals = timingTotals(timing);
  const awayConversion = buildConversionDiagnostic(
    packet,
    outcome,
    detail,
    "AWAY",
  );
  const homeConversion = buildConversionDiagnostic(
    packet,
    outcome,
    detail,
    "HOME",
  );
  const tags = allocationReasonTags(
    packet,
    outcome,
    allocationReversal,
    totals.primary,
    awayConversion,
    homeConversion,
  );
  const observedMechanism =
    allocationReversal === "TRUE"
      ? `ALLOCATION_REVERSAL__${totals.primary}`
      : allocationReversal === "NOT_COMPARABLE"
        ? "ALLOCATION_NOT_COMPARABLE"
        : `NO_ALLOCATION_REVERSAL__${totals.primary}`;
  return [
    packet.date,
    packet.game_id,
    packet.away_team,
    packet.home_team,
    packet.snapshot_ts,
    packet.projected_away_runs,
    packet.projected_home_runs,
    packet.projected_total,
    outcome.actual_away_runs,
    outcome.actual_home_runs,
    outcome.actual_total,
    round2(packet.projected_total - outcome.actual_total),
    Math.abs(round2(packet.projected_total - outcome.actual_total)),
    allocationMae,
    projectedHigher,
    actualHigher,
    allocationReversal,
    allocationRankReversal,
    observedMechanism,
    tags,
    awayPath.summary,
    homePath.summary,
    timing.away_starter_window_runs_allowed,
    timing.home_starter_window_runs_allowed,
    timing.away_bullpen_runs_allowed,
    timing.home_bullpen_runs_allowed,
    totals.starter_total ?? "",
    totals.bullpen_total ?? "",
    totals.primary,
    totals.both_contributed,
    awayConversion.conversion_outcome,
    homeConversion.conversion_outcome,
    packet.collision_status || "SOURCE_UNAVAILABLE",
    packet.collision_traffic_estimate ?? "",
    packet.collision_damage_estimate ?? "",
    "FROZEN_PACKET_AND_FINAL_VERIFIED",
    outcome.settlement_ts,
  ];
}

function normalizeDirection(value: unknown): Direction | null {
  const raw = text(value).toUpperCase();
  if (/\bOVER\b|^O\s?\d/.test(raw)) return "OVER";
  if (/\bUNDER\b|^U\s?\d/.test(raw)) return "UNDER";
  return null;
}

export function parseHalfNumberLines(value: unknown): number[] {
  const lines = text(value)
    .split(/[;,|]/)
    .flatMap((part) => {
      const match = part.trim().match(/^\D*(\d+(?:\.\d+)?)/);
      const number = match ? Number(match[1]) : Number.NaN;
      return Number.isFinite(number) && Math.abs((number % 1) - 0.5) < 0.001
        ? [number]
        : [];
    });
  return [...new Set(lines)].sort((left, right) => left - right);
}

function parsePreferredVehicle(value: unknown): {
  direction: Direction | null;
  line: number | null;
} {
  const source = text(value).toUpperCase();
  const direction = normalizeDirection(source);
  const match = source.match(/(\d+(?:\.\d+)?)/);
  return { direction, line: match ? Number(match[1]) : null };
}

export function gradeThreshold(
  direction: Direction | null,
  line: number | null,
  actual: number,
): ThresholdResult {
  if (!direction || line === null) return "NOT_GRADABLE";
  if (actual === line) return "PUSH";
  if (direction === "OVER") return actual > line ? "WIN" : "LOSS";
  return actual < line ? "WIN" : "LOSS";
}

interface LadderSummary {
  direction: Direction | null;
  preferredLine: number | null;
  selectedResult: ThresholdResult;
  lowerResult: ThresholdResult;
  higherResult: ThresholdResult;
  tighterCaptured: string;
  widerRequired: string;
  allFailed: string;
  vehicleGrade: string;
}

function summarizeLadder(
  direction: Direction | null,
  lines: number[],
  preferredLine: number | null,
  actualTotal: number,
  allocationReversal: string,
): LadderSummary {
  if (!direction || preferredLine === null || lines.length === 0) {
    return {
      direction,
      preferredLine,
      selectedResult: "NOT_GRADABLE",
      lowerResult: "NOT_GRADABLE",
      higherResult: "NOT_GRADABLE",
      tighterCaptured: "NOT_GRADABLE",
      widerRequired: "NOT_GRADABLE",
      allFailed: "NOT_GRADABLE",
      vehicleGrade: "NOT_GRADABLE",
    };
  }
  const results = new Map(
    lines.map((line) => [line, gradeThreshold(direction, line, actualTotal)]),
  );
  const selectedResult =
    results.get(preferredLine) ??
    gradeThreshold(direction, preferredLine, actualTotal);
  const lower =
    [...lines].filter((line) => line < preferredLine).at(-1) ?? null;
  const higher = lines.find((line) => line > preferredLine) ?? null;
  const lowerResult = lower === null ? "NOT_GRADABLE" : results.get(lower)!;
  const higherResult = higher === null ? "NOT_GRADABLE" : results.get(higher)!;
  const tighter = direction === "OVER" ? higherResult : lowerResult;
  const wider = direction === "OVER" ? lowerResult : higherResult;
  const allFailed = [...results.values()].every((result) => result === "LOSS")
    ? "TRUE"
    : "FALSE";
  const vehicleGrade =
    selectedResult === "WIN"
      ? allocationReversal === "TRUE"
        ? "RIGHT_TOTAL_WRONG_MECHANISM"
        : "CLEAN_CAPTURE"
      : selectedResult === "PUSH"
        ? "VEHICLE_PUSH"
        : allFailed === "TRUE"
          ? "DIRECTION_FAILURE"
          : "THRESHOLD_VEHICLE_FAILURE";
  return {
    direction,
    preferredLine,
    selectedResult,
    lowerResult,
    higherResult,
    tighterCaptured:
      tighter === "WIN"
        ? "TRUE"
        : tighter === "NOT_GRADABLE"
          ? "NOT_AVAILABLE"
          : "FALSE",
    widerRequired:
      selectedResult === "LOSS" && wider === "WIN"
        ? "TRUE"
        : selectedResult === "LOSS" && wider === "NOT_GRADABLE"
          ? "NOT_AVAILABLE"
          : "FALSE",
    allFailed,
    vehicleGrade,
  };
}

function parseLadderRows(
  rows: unknown[][],
  date: string,
): Map<string, unknown[]> {
  const [header = [], ...data] = rows;
  const index = new Map(
    (header as unknown[]).map((value, position) => [text(value), position]),
  );
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const result = new Map<string, unknown[]>();
  for (const row of data) {
    if (text(value(row, "Date")) !== date) continue;
    if (text(value(row, "Ledger_Status")) !== "FROZEN_PREGAME") continue;
    const firstPitch = text(value(row, "Scheduled_First_Pitch"));
    const snapshot = text(value(row, "Snapshot_TS"));
    const gameId = text(value(row, "Game_ID"));
    if (gameId && validBefore(snapshot, firstPitch))
      result.set(gameId, pad(row, FULL_LADDER_AUDIT_HEADERS.length));
  }
  return result;
}

function ladderRowsForGame(
  ladder: unknown[],
  outcome: SettlementRow,
  allocationReversal: string,
): { rows: unknown[][]; summary: LadderSummary } {
  const direction =
    normalizeDirection(ladder[LADDER.Directional_Truth]) ??
    parsePreferredVehicle(ladder[LADDER.Preferred_Total_Vehicle]).direction;
  const lines = parseHalfNumberLines(
    ladder[LADDER.Available_HardRock_Total_Lines],
  );
  const preferred = parsePreferredVehicle(
    ladder[LADDER.Preferred_Total_Vehicle],
  );
  const summary = summarizeLadder(
    direction,
    lines,
    preferred.line,
    outcome.actual_total,
    allocationReversal,
  );
  const ticketStatus =
    text(ladder[LADDER.Ticket_Status]) || "NO_WAGER_REPORTED";
  const currentPrice = text(ladder[LADDER.Current_Price]);
  const reasoningSource = text(ladder[LADDER.Reasoning_Source]);
  const eligible =
    text(ladder[LADDER.Manual_Audit_Status]) === "MANUAL_AUDIT_RECORDED";
  const diagnosticStatus = eligible
    ? "FROZEN_LADDER_VERIFIED"
    : "MANUAL_AUDIT_INCOMPLETE";
  return {
    summary,
    rows: lines.map((line) => [
      outcome.date,
      outcome.game_id,
      direction ?? "",
      line,
      outcome.actual_total,
      gradeThreshold(direction, line, outcome.actual_total),
      preferred.line === line ? "TRUE" : "FALSE",
      summary.selectedResult,
      summary.lowerResult,
      summary.higherResult,
      summary.tighterCaptured,
      summary.widerRequired,
      summary.allFailed,
      summary.vehicleGrade,
      ticketStatus,
      currentPrice,
      reasoningSource,
      diagnosticStatus,
      outcome.settlement_ts,
    ]),
  };
}

async function ensureSheet(
  workbookId: string,
  title: string,
  columnCount: number,
): Promise<void> {
  const properties = await getSpreadsheetSheetProperties(workbookId);
  if (!properties.some((sheet) => sheet.title === title))
    await addSheet(workbookId, title);
  await expandSheetColumns(workbookId, title, columnCount);
}

function replaceByKey(
  existing: unknown[][],
  replacements: unknown[][],
  keyIndices: number[],
): unknown[][] {
  const rows = existing.map((row) => [...row]);
  const position = new Map(
    rows.map((row, index) => [
      key(...keyIndices.map((column) => row[column])),
      index,
    ]),
  );
  for (const row of replacements) {
    const rowKey = key(...keyIndices.map((column) => row[column]));
    const existingIndex = position.get(rowKey);
    if (existingIndex === undefined) {
      position.set(rowKey, rows.length);
      rows.push(row);
    } else rows[existingIndex] = row;
  }
  return rows;
}

async function readDataRows(
  workbookId: string,
  sheet: string,
  rangeEnd: string,
): Promise<unknown[][]> {
  const response = await readRange(workbookId, `${sheet}!A1:${rangeEnd}10000`);
  const raw = (response.values ?? []) as unknown[][];
  return raw.length > 0 ? raw.slice(1) : [];
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|\b400\b|sheet\s+"?[^"]+"?\s+not found/i.test(
    message,
  );
}

async function readOptionalDataRows(
  workbookId: string,
  sheet: string,
  rangeEnd: string,
): Promise<unknown[][]> {
  try {
    return await readDataRows(workbookId, sheet, rangeEnd);
  } catch (error: unknown) {
    if (isMissingSheetError(error)) return [];
    throw error;
  }
}

async function writeUpsertedRows(
  workbookId: string,
  sheet: string,
  header: readonly string[],
  existing: unknown[][],
  additions: unknown[][],
  keyIndices: number[],
): Promise<void> {
  await ensureSheet(workbookId, sheet, header.length);
  const rows = replaceByKey(
    existing.map((row) => pad(row, header.length)),
    additions.map((row) => pad(row, header.length)),
    keyIndices,
  );
  await writeRange(workbookId, `${sheet}!A1`, [Array.from(header), ...rows]);
}

/**
 * Writes only diagnostic evidence. Detail retrieval failures remain explicit
 * warnings; allocation and frozen-ladder rows still settle from the official
 * final score rather than failing the entire historical ledger.
 */
export async function runPostgameDiagnostics(
  date: string,
  outcomes: SettlementRow[],
  options: { workbookId?: string } = {},
): Promise<PostgameDiagnosticsResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    // A settlement must remain safe for an older date that predates either
    // ledger. Missing history is an explicit ineligible state, never a reason
    // to manufacture a packet or fail the whole completed-date settlement.
    let packetRaw: unknown[][] = [];
    try {
      packetRaw = ((
        await readRange(
          workbookId,
          `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`,
        )
      ).values ?? []) as unknown[][];
    } catch (error: unknown) {
      if (!isMissingSheetError(error)) throw error;
      warnings.push(
        `MISSING_PREGAME_PACKET_HISTORY: ${date} cannot receive Module 24 diagnostics`,
      );
    }
    const packetByGame = parseFrozenPacketDiagnostics(packetRaw, date);

    let ladderRaw: unknown[][] = [];
    try {
      ladderRaw = ((
        await readRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1:X10000`)
      ).values ?? []) as unknown[][];
    } catch (error: unknown) {
      if (!isMissingSheetError(error)) throw error;
      warnings.push(
        `MISSING_FULL_LADDER_AUDIT: ${date} has no manual ladder ledger to settle`,
      );
    }
    const ladderByGame = parseLadderRows(ladderRaw, date);
    const eligible = outcomes.filter((outcome) =>
      packetByGame.has(outcome.game_id),
    );
    for (const outcome of outcomes) {
      if (!packetByGame.has(outcome.game_id)) {
        warnings.push(
          `MISSING_PREGAME_PACKET: ${outcome.game_id} is ineligible for Module 24 diagnostics`,
        );
      }
    }
    const allocationRows: unknown[][] = [];
    const starterRowsOut: unknown[][] = [];
    const timingRows: unknown[][] = [];
    const conversionRows: unknown[][] = [];
    const gameTruthRows: unknown[][] = [];
    const ladderRows: unknown[][] = [];
    const ladderExistingRows = ladderRaw
      .slice(1)
      .map((row) => pad(row, FULL_LADDER_AUDIT_HEADERS.length));
    const ladderPositions = new Map(
      ladderExistingRows.map((row, index) => [
        key(row[LADDER.Date], row[LADDER.Game_ID]),
        index,
      ]),
    );

    for (const outcome of eligible) {
      const packet = packetByGame.get(outcome.game_id)!;
      const allocation = buildAllocationDiagnostic(packet, outcome);
      allocationRows.push(allocation);
      const allocationReversal = text(allocation[24]);
      let detail: PostgameGameDetail = {
        away: null,
        home: null,
        away_bullpen: [],
        home_bullpen: [],
        away_batting: null,
        home_batting: null,
        away_runs_by_inning: new Map(),
        home_runs_by_inning: new Map(),
        status: "POSTGAME_DETAIL_UNAVAILABLE",
      };
      if (outcome.game_pk) {
        try {
          detail = await fetchPostgameDetail(outcome.game_pk);
        } catch (error: unknown) {
          warnings.push(
            `POSTGAME_DETAIL_UNAVAILABLE: ${outcome.game_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else
        warnings.push(
          `POSTGAME_DETAIL_UNAVAILABLE: ${outcome.game_id}: MLB gamePk missing from settlement`,
        );
      starterRowsOut.push(...starterRows(packet, outcome, detail));
      timingRows.push(timingRow(packet, outcome, detail));
      const awayConversion = buildConversionDiagnostic(
        packet,
        outcome,
        detail,
        "AWAY",
      );
      const homeConversion = buildConversionDiagnostic(
        packet,
        outcome,
        detail,
        "HOME",
      );
      conversionRows.push(
        conversionRow(packet, outcome, awayConversion),
        conversionRow(packet, outcome, homeConversion),
      );
      gameTruthRows.push(buildGameTruthReplay(packet, outcome, detail));

      const ladder = ladderByGame.get(outcome.game_id);
      if (ladder) {
        const grading = ladderRowsForGame(ladder, outcome, allocationReversal);
        ladderRows.push(...grading.rows);
        const position = ladderPositions.get(key(date, outcome.game_id));
        if (position !== undefined) {
          const settled = [...ladderExistingRows[position]!];
          settled[LADDER.Settlement_TS] = outcome.settlement_ts;
          settled[LADDER.Selected_Vehicle_Result] =
            grading.summary.selectedResult;
          settled[LADDER.Ledger_Settlement_Status] =
            grading.summary.vehicleGrade;
          ladderExistingRows[position] = settled;
        }
      }
    }

    const [
      existingAllocation,
      existingStarter,
      existingTiming,
      existingConversion,
      existingGameTruth,
      existingLadderSettlement,
    ] = await Promise.all([
      readOptionalDataRows(workbookId, ALLOCATION_SHEET, "AB"),
      readOptionalDataRows(workbookId, STARTER_SHEET, "AZ"),
      readOptionalDataRows(workbookId, TIMING_SHEET, "AZ"),
      readOptionalDataRows(workbookId, CONVERSION_SHEET, "AZ"),
      readOptionalDataRows(workbookId, GAME_TRUTH_REPLAY_SHEET, "AZ"),
      readOptionalDataRows(workbookId, LADDER_SETTLEMENT_SHEET, "T"),
    ]);
    await writeUpsertedRows(
      workbookId,
      ALLOCATION_SHEET,
      ALLOCATION_SETTLEMENT_HEADERS,
      existingAllocation,
      allocationRows,
      [0, 1],
    );
    await writeUpsertedRows(
      workbookId,
      STARTER_SHEET,
      STARTER_OUTCOME_HEADERS,
      existingStarter,
      starterRowsOut,
      [0, 1, 2],
    );
    await writeUpsertedRows(
      workbookId,
      TIMING_SHEET,
      BULLPEN_TIMING_HEADERS,
      existingTiming,
      timingRows,
      [0, 1],
    );
    await writeUpsertedRows(
      workbookId,
      CONVERSION_SHEET,
      CONVERSION_SETTLEMENT_HEADERS,
      existingConversion,
      conversionRows,
      [0, 1, 2],
    );
    await writeUpsertedRows(
      workbookId,
      GAME_TRUTH_REPLAY_SHEET,
      GAME_TRUTH_REPLAY_HEADERS,
      existingGameTruth,
      gameTruthRows,
      [0, 1],
    );
    await writeUpsertedRows(
      workbookId,
      LADDER_SETTLEMENT_SHEET,
      FULL_LADDER_SETTLEMENT_HEADERS,
      existingLadderSettlement,
      ladderRows,
      [0, 1, 3],
    );
    await ensureSheet(
      workbookId,
      FULL_LADDER_AUDIT_SHEET,
      FULL_LADDER_AUDIT_HEADERS.length,
    );
    await writeRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1`, [
      Array.from(FULL_LADDER_AUDIT_HEADERS),
      ...ladderExistingRows,
    ]);
    logger.info(
      {
        date,
        frozen_packet_games: eligible.length,
        allocation_rows: allocationRows.length,
        conversion_rows: conversionRows.length,
        game_truth_rows: gameTruthRows.length,
        ladder_rows: ladderRows.length,
      },
      "MODULE_24: postgame diagnostics written",
    );
    return {
      status: "success",
      date,
      allocation_rows_written: allocationRows.length,
      starter_rows_written: starterRowsOut.length,
      timing_rows_written: timingRows.length,
      conversion_rows_written: conversionRows.length,
      game_truth_rows_written: gameTruthRows.length,
      ladder_rows_written: ladderRows.length,
      frozen_packet_games: eligible.length,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error(
      { date, err: message },
      "MODULE_24: postgame diagnostics failed",
    );
    return {
      status: "failure",
      date,
      allocation_rows_written: 0,
      starter_rows_written: 0,
      timing_rows_written: 0,
      conversion_rows_written: 0,
      game_truth_rows_written: 0,
      ladder_rows_written: 0,
      frozen_packet_games: 0,
      warnings,
      errors,
    };
  }
}
