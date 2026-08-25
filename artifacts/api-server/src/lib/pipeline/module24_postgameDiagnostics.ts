/**
 * Module 24: postgame allocation, pitcher-dimension, timing, and full-ladder
 * diagnostics.
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
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const ALLOCATION_SHEET = "ALLOCATION_SETTLEMENT_DIAGNOSTICS";
const STARTER_SHEET = "STARTER_OUTCOME_DIAGNOSTICS";
const TIMING_SHEET = "BULLPEN_TIMING_DIAGNOSTICS";
const LADDER_SETTLEMENT_SHEET = "FULL_LADDER_SETTLEMENT";

export const ALLOCATION_SETTLEMENT_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Frozen_Packet_Snapshot_TS",
  "Projected_Away_Runs", "Projected_Home_Runs", "Projected_Total", "Projected_Margin",
  "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total", "Actual_Margin",
  "Away_Run_Error", "Away_Abs_Error", "Home_Run_Error", "Home_Abs_Error",
  "Total_Error", "Total_Abs_Error", "Margin_Error", "Margin_Abs_Error", "Allocation_MAE",
  "Projected_Higher_Scoring_Team", "Actual_Higher_Scoring_Team", "Allocation_Sign_Reversal",
  "Allocation_Rank_Reversal", "Diagnostic_Status", "Settlement_TS",
] as const;

export const STARTER_OUTCOME_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Team", "Starter", "Expected_IP", "Actual_IP", "IP_Delta", "Workload_Leash_Status",
  "Actual_Pitches", "BB", "HBP", "Hits", "Baserunners", "Traffic_Data_Status",
  "Contact_Data_Status", "xBA", "Hard_Hit_Pct", "Balls_In_Play", "Damage_Data_Status",
  "HR", "Barrels", "XBH", "Run_Prevention_Data_Status", "R", "ER", "Starter_Window_Runs_Allowed", "K", "Whiffs",
  "Starter_Exit_Inning", "Diagnostic_Status", "Settlement_TS",
] as const;

export const BULLPEN_TIMING_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Away_Starter_Exit_Inning", "Home_Starter_Exit_Inning",
  "Away_Starter_Window_Runs_Allowed", "Home_Starter_Window_Runs_Allowed",
  "Away_Bullpen_Runs_Allowed", "Home_Bullpen_Runs_Allowed",
  "Away_Runs_1_3", "Away_Runs_4_6", "Away_Runs_7Plus", "Away_Extra_Inning_Runs",
  "Home_Runs_1_3", "Home_Runs_4_6", "Home_Runs_7Plus", "Home_Extra_Inning_Runs",
  "Timing_Granularity", "Diagnostic_Status", "Settlement_TS",
] as const;

export const FULL_LADDER_SETTLEMENT_HEADERS = [
  "Date", "Game_ID", "Directional_Truth", "Available_Line", "Actual_Total", "Counterfactual_Result",
  "Is_Preferred_Vehicle", "Selected_Vehicle_Result", "Adjacent_Lower_Line_Result", "Adjacent_Higher_Line_Result",
  "Tighter_Line_Also_Captured", "Wider_Line_Required", "All_Reasonable_Vehicles_Failed",
  "Vehicle_Grade", "Ticket_Status", "Current_Price", "Reasoning_Source", "Diagnostic_Status", "Settlement_TS",
] as const;

const LADDER = Object.fromEntries(FULL_LADDER_AUDIT_HEADERS.map((name, index) => [name, index])) as Record<(typeof FULL_LADDER_AUDIT_HEADERS)[number], number>;

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

export interface PostgameGameDetail {
  away: StarterDimension | null;
  home: StarterDimension | null;
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
  ladder_rows_written: number;
  frozen_packet_games: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string { return String(value ?? "").trim(); }
function numeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
function round2(value: number): number { return Number.parseFloat(value.toFixed(2)); }
function key(...parts: unknown[]): string { return parts.map(text).join("|"); }
function pad(row: unknown[], length: number): unknown[] {
  const next = row.slice(0, length);
  while (next.length < length) next.push("");
  return next;
}
function validBefore(snapshotTs: string, firstPitch: string): boolean {
  const snapshot = Date.parse(snapshotTs);
  const first = Date.parse(firstPitch);
  return Number.isFinite(snapshot) && Number.isFinite(first) && snapshot < first;
}
function teamWinner(away: number, home: number): "AWAY" | "HOME" | "TIE" {
  return away === home ? "TIE" : away > home ? "AWAY" : "HOME";
}
function signReversal(projectedAway: number, projectedHome: number, actualAway: number, actualHome: number): string {
  const projected = teamWinner(projectedAway, projectedHome);
  const actual = teamWinner(actualAway, actualHome);
  if (projected === "TIE" || actual === "TIE") return "NOT_COMPARABLE";
  return projected === actual ? "FALSE" : "TRUE";
}

/** Parse only legitimate frozen packet records. Open/gap rows remain ineligible. */
export function parseFrozenPacketDiagnostics(rows: unknown[][], date: string): Map<string, FrozenPacketDiagnosticInput> {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((value, position) => [text(value), position]));
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
    if (!gameId || !validBefore(snapshotTs, firstPitch) || away === null || home === null || total === null) continue;
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
    });
  }
  return packetByGame;
}

export function buildAllocationDiagnostic(
  packet: FrozenPacketDiagnosticInput,
  outcome: Pick<SettlementRow, "actual_away_runs" | "actual_home_runs" | "actual_total" | "settlement_ts">,
): unknown[] {
  const projectedMargin = round2(packet.projected_away_runs - packet.projected_home_runs);
  const actualMargin = outcome.actual_away_runs - outcome.actual_home_runs;
  const awayError = round2(packet.projected_away_runs - outcome.actual_away_runs);
  const homeError = round2(packet.projected_home_runs - outcome.actual_home_runs);
  const totalError = round2(packet.projected_total - outcome.actual_total);
  const marginError = round2(projectedMargin - actualMargin);
  return [
    packet.date, packet.game_id, packet.away_team, packet.home_team, packet.snapshot_ts,
    packet.projected_away_runs, packet.projected_home_runs, packet.projected_total, projectedMargin,
    outcome.actual_away_runs, outcome.actual_home_runs, outcome.actual_total, actualMargin,
    awayError, Math.abs(awayError), homeError, Math.abs(homeError), totalError, Math.abs(totalError), marginError, Math.abs(marginError),
    round2((Math.abs(awayError) + Math.abs(homeError)) / 2),
    teamWinner(packet.projected_away_runs, packet.projected_home_runs),
    teamWinner(outcome.actual_away_runs, outcome.actual_home_runs),
    signReversal(packet.projected_away_runs, packet.projected_home_runs, outcome.actual_away_runs, outcome.actual_home_runs),
    signReversal(packet.projected_away_runs, packet.projected_home_runs, outcome.actual_away_runs, outcome.actual_home_runs),
    "FROZEN_PACKET_VERIFIED", outcome.settlement_ts,
  ];
}

function inningsToOuts(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const [wholeRaw, partialRaw = "0"] = raw.split(".");
  const whole = Number.parseInt(wholeRaw ?? "", 10);
  const partial = Number.parseInt(partialRaw, 10);
  return Number.isFinite(whole) && Number.isFinite(partial) && partial >= 0 && partial <= 2 ? whole * 3 + partial : null;
}

function numberField(input: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = input[name];
    const parsed = numeric(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function starterFromTeam(rawTeam: unknown): StarterDimension | null {
  const team = (rawTeam ?? {}) as {
    pitchers?: Array<number | string>;
    players?: Record<string, { person?: { id?: number; fullName?: string }; stats?: { pitching?: Record<string, unknown> } }>;
  };
  const appearances = (team.pitchers ?? []).flatMap((id) => {
    const player = team.players?.[`ID${id}`] ?? Object.values(team.players ?? {}).find((candidate) => String(candidate.person?.id ?? "") === String(id));
    const stats = player?.stats?.pitching;
    const name = text(player?.person?.fullName);
    if (!stats || !name) return [];
    const outs = numberField(stats, "outs") ?? inningsToOuts(stats.inningsPitched);
    return [{
      name,
      gamesStarted: numberField(stats, "gamesStarted") ?? 0,
      outs,
      innings: outs === null ? numeric(stats.inningsPitched) : round2(outs / 3),
      pitches: numberField(stats, "pitchesThrown", "pitches"),
      bb: numberField(stats, "baseOnBalls", "walks"),
      hbp: numberField(stats, "hitBatsmen", "hitByPitch"),
      hits: numberField(stats, "hits"),
      hr: numberField(stats, "homeRuns"),
      xbh: (() => {
        const doubles = numberField(stats, "doubles");
        const triples = numberField(stats, "triples");
        const homers = numberField(stats, "homeRuns");
        return doubles === null || triples === null || homers === null ? null : doubles + triples + homers;
      })(),
      runs: numberField(stats, "runs"),
      earned_runs: numberField(stats, "earnedRuns"),
      strikeouts: numberField(stats, "strikeOuts", "strikeouts"),
    }];
  });
  const starter = appearances.find((appearance) => appearance.gamesStarted > 0) ?? appearances[0];
  if (!starter) return null;
  return {
    name: starter.name,
    innings: starter.innings,
    outs: starter.outs,
    pitches: starter.pitches,
    bb: starter.bb,
    hbp: starter.hbp,
    hits: starter.hits,
    hr: starter.hr,
    xbh: starter.xbh,
    runs: starter.runs,
    earned_runs: starter.earned_runs,
    strikeouts: starter.strikeouts,
  };
}

function inningRuns(linescore: unknown, side: TeamSide): Map<number, number> {
  const innings = ((linescore ?? {}) as { innings?: Array<{ num?: number; away?: { runs?: number }; home?: { runs?: number } }> }).innings ?? [];
  const values = new Map<number, number>();
  for (const inning of innings) {
    const number = Number(inning.num ?? 0);
    const runs = side === "AWAY" ? inning.away?.runs : inning.home?.runs;
    if (Number.isFinite(number) && number > 0 && typeof runs === "number") values.set(number, runs);
  }
  return values;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Frostline-Settlement/1.0" } });
    if (!response.ok) throw new Error(`MLB API ${response.status} for ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPostgameDetail(gamePk: number): Promise<PostgameGameDetail> {
  const [boxscore, linescore] = await Promise.all([
    fetchJson(`${MLB_API}/game/${gamePk}/boxscore`),
    fetchJson(`${MLB_API}/game/${gamePk}/linescore`),
  ]);
  const raw = boxscore as { teams?: { away?: unknown; home?: unknown } };
  return {
    away: starterFromTeam(raw.teams?.away),
    home: starterFromTeam(raw.teams?.home),
    away_runs_by_inning: inningRuns(linescore, "AWAY"),
    home_runs_by_inning: inningRuns(linescore, "HOME"),
    status: "AVAILABLE",
  };
}

function timingBand(runs: Map<number, number>, start: number, end: number): number {
  let total = 0;
  for (const [inning, value] of runs) if (inning >= start && inning <= end) total += value;
  return total;
}
function lateRuns(runs: Map<number, number>): number {
  let total = 0;
  for (const [inning, value] of runs) if (inning >= 7 && inning <= 9) total += value;
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

export function workloadLeashStatus(expected: number | null, actual: number | null): string {
  if (expected === null) return "EXPECTED_IP_UNAVAILABLE";
  if (actual === null) return "ACTUAL_IP_UNAVAILABLE";
  return actual >= expected ? "REACHED_EXPECTED_IP" : "SHORT_OF_EXPECTED_IP";
}

function starterRows(
  packet: FrozenPacketDiagnosticInput,
  outcome: SettlementRow,
  detail: PostgameGameDetail,
): unknown[][] {
  const rowFor = (side: TeamSide, starter: StarterDimension | null, expected: number | null, team: string): unknown[] => {
    const actualIp = starter?.innings ?? null;
    const bb = starter?.bb ?? null;
    const hbp = starter?.hbp ?? null;
    const hits = starter?.hits ?? null;
    const hr = starter?.hr ?? null;
    const xbh = starter?.xbh ?? null;
    const traffic = bb === null || hits === null || hbp === null ? "UNAVAILABLE" : "AVAILABLE";
    const damage = hr === null || xbh === null ? "PARTIAL" : "AVAILABLE";
    const runPrevention = starter?.runs === null || starter?.earned_runs === null ? "PARTIAL" : starter ? "AVAILABLE" : "UNAVAILABLE";
    const status = detail.status === "AVAILABLE" && starter ? "AVAILABLE" : "POSTGAME_DETAIL_UNAVAILABLE";
    return [
      packet.date, packet.game_id, side, team, starter?.name ?? "",
      expected ?? "", actualIp ?? "", expected === null || actualIp === null ? "" : round2(actualIp - expected),
      workloadLeashStatus(expected, actualIp),
      starter?.pitches ?? "", bb ?? "", hbp ?? "", hits ?? "",
      bb === null || hbp === null || hits === null ? "" : bb + hbp + hits,
      traffic, "UNAVAILABLE_FROM_MLB_BOXSCORE", "", "", "", damage,
      hr ?? "", "", xbh ?? "", runPrevention, starter?.runs ?? "", starter?.earned_runs ?? "",
      starter?.runs ?? "", starter?.strikeouts ?? "", "", exitInning(starter), status, outcome.settlement_ts,
    ];
  };
  return [
    rowFor("AWAY", detail.away, packet.away_expected_ip, packet.away_team),
    rowFor("HOME", detail.home, packet.home_expected_ip, packet.home_team),
  ];
}

function timingRow(packet: FrozenPacketDiagnosticInput, outcome: SettlementRow, detail: PostgameGameDetail): unknown[] {
  const awayStarterRuns = detail.away?.runs ?? null;
  const homeStarterRuns = detail.home?.runs ?? null;
  const hasInningDetail = detail.status === "AVAILABLE";
  const band = (runs: Map<number, number>, start: number, end: number): number | "" => (
    hasInningDetail ? timingBand(runs, start, end) : ""
  );
  const late = (runs: Map<number, number>): number | "" => hasInningDetail ? lateRuns(runs) : "";
  const extra = (runs: Map<number, number>): number | "" => hasInningDetail ? extraRuns(runs) : "";
  return [
    packet.date, packet.game_id, packet.away_team, packet.home_team,
    exitInning(detail.away), exitInning(detail.home), awayStarterRuns ?? "", homeStarterRuns ?? "",
    awayStarterRuns === null ? "" : Math.max(0, outcome.actual_home_runs - awayStarterRuns),
    homeStarterRuns === null ? "" : Math.max(0, outcome.actual_away_runs - homeStarterRuns),
    band(detail.away_runs_by_inning, 1, 3), band(detail.away_runs_by_inning, 4, 6), late(detail.away_runs_by_inning), extra(detail.away_runs_by_inning),
    band(detail.home_runs_by_inning, 1, 3), band(detail.home_runs_by_inning, 4, 6), late(detail.home_runs_by_inning), extra(detail.home_runs_by_inning),
    detail.status === "AVAILABLE" ? "INNING_LEVEL" : "UNAVAILABLE", detail.status, outcome.settlement_ts,
  ];
}

function normalizeDirection(value: unknown): Direction | null {
  const raw = text(value).toUpperCase();
  if (/\bOVER\b|^O\s?\d/.test(raw)) return "OVER";
  if (/\bUNDER\b|^U\s?\d/.test(raw)) return "UNDER";
  return null;
}

export function parseHalfNumberLines(value: unknown): number[] {
  const lines = text(value).split(/[;,|]/).flatMap((part) => {
    const match = part.trim().match(/^\D*(\d+(?:\.\d+)?)/);
    const number = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(number) && Math.abs((number % 1) - 0.5) < 0.001 ? [number] : [];
  });
  return [...new Set(lines)].sort((left, right) => left - right);
}

function parsePreferredVehicle(value: unknown): { direction: Direction | null; line: number | null } {
  const source = text(value).toUpperCase();
  const direction = normalizeDirection(source);
  const match = source.match(/(\d+(?:\.\d+)?)/);
  return { direction, line: match ? Number(match[1]) : null };
}

export function gradeThreshold(direction: Direction | null, line: number | null, actual: number): ThresholdResult {
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
    return { direction, preferredLine, selectedResult: "NOT_GRADABLE", lowerResult: "NOT_GRADABLE", higherResult: "NOT_GRADABLE", tighterCaptured: "NOT_GRADABLE", widerRequired: "NOT_GRADABLE", allFailed: "NOT_GRADABLE", vehicleGrade: "NOT_GRADABLE" };
  }
  const results = new Map(lines.map((line) => [line, gradeThreshold(direction, line, actualTotal)]));
  const selectedResult = results.get(preferredLine) ?? gradeThreshold(direction, preferredLine, actualTotal);
  const lower = [...lines].filter((line) => line < preferredLine).at(-1) ?? null;
  const higher = lines.find((line) => line > preferredLine) ?? null;
  const lowerResult = lower === null ? "NOT_GRADABLE" : results.get(lower)!;
  const higherResult = higher === null ? "NOT_GRADABLE" : results.get(higher)!;
  const tighter = direction === "OVER" ? higherResult : lowerResult;
  const wider = direction === "OVER" ? lowerResult : higherResult;
  const allFailed = [...results.values()].every((result) => result === "LOSS") ? "TRUE" : "FALSE";
  const vehicleGrade = selectedResult === "WIN"
    ? allocationReversal === "TRUE" ? "RIGHT_TOTAL_WRONG_MECHANISM" : "CLEAN_CAPTURE"
    : selectedResult === "PUSH" ? "VEHICLE_PUSH"
    : allFailed === "TRUE" ? "DIRECTION_FAILURE"
    : "THRESHOLD_VEHICLE_FAILURE";
  return {
    direction, preferredLine, selectedResult, lowerResult, higherResult,
    tighterCaptured: tighter === "WIN" ? "TRUE" : tighter === "NOT_GRADABLE" ? "NOT_AVAILABLE" : "FALSE",
    widerRequired: selectedResult === "LOSS" && wider === "WIN" ? "TRUE" : selectedResult === "LOSS" && wider === "NOT_GRADABLE" ? "NOT_AVAILABLE" : "FALSE",
    allFailed,
    vehicleGrade,
  };
}

function parseLadderRows(rows: unknown[][], date: string): Map<string, unknown[]> {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((value, position) => [text(value), position]));
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const result = new Map<string, unknown[]>();
  for (const row of data) {
    if (text(value(row, "Date")) !== date) continue;
    if (text(value(row, "Ledger_Status")) !== "FROZEN_PREGAME") continue;
    const firstPitch = text(value(row, "Scheduled_First_Pitch"));
    const snapshot = text(value(row, "Snapshot_TS"));
    const gameId = text(value(row, "Game_ID"));
    if (gameId && validBefore(snapshot, firstPitch)) result.set(gameId, pad(row, FULL_LADDER_AUDIT_HEADERS.length));
  }
  return result;
}

function ladderRowsForGame(
  ladder: unknown[],
  outcome: SettlementRow,
  allocationReversal: string,
): { rows: unknown[][]; summary: LadderSummary } {
  const direction = normalizeDirection(ladder[LADDER.Directional_Truth]) ?? parsePreferredVehicle(ladder[LADDER.Preferred_Total_Vehicle]).direction;
  const lines = parseHalfNumberLines(ladder[LADDER.Available_HardRock_Total_Lines]);
  const preferred = parsePreferredVehicle(ladder[LADDER.Preferred_Total_Vehicle]);
  const summary = summarizeLadder(direction, lines, preferred.line, outcome.actual_total, allocationReversal);
  const ticketStatus = text(ladder[LADDER.Ticket_Status]) || "NO_WAGER_REPORTED";
  const currentPrice = text(ladder[LADDER.Current_Price]);
  const reasoningSource = text(ladder[LADDER.Reasoning_Source]);
  const eligible = text(ladder[LADDER.Manual_Audit_Status]) === "MANUAL_AUDIT_RECORDED";
  const diagnosticStatus = eligible ? "FROZEN_LADDER_VERIFIED" : "MANUAL_AUDIT_INCOMPLETE";
  return {
    summary,
    rows: lines.map((line) => [
      outcome.date, outcome.game_id, direction ?? "", line, outcome.actual_total,
      gradeThreshold(direction, line, outcome.actual_total),
      preferred.line === line ? "TRUE" : "FALSE", summary.selectedResult, summary.lowerResult, summary.higherResult,
      summary.tighterCaptured, summary.widerRequired, summary.allFailed, summary.vehicleGrade,
      ticketStatus, currentPrice, reasoningSource, diagnosticStatus, outcome.settlement_ts,
    ]),
  };
}

async function ensureSheet(workbookId: string, title: string, columnCount: number): Promise<void> {
  const properties = await getSpreadsheetSheetProperties(workbookId);
  if (!properties.some((sheet) => sheet.title === title)) await addSheet(workbookId, title);
  await expandSheetColumns(workbookId, title, columnCount);
}

function replaceByKey(existing: unknown[][], replacements: unknown[][], keyIndices: number[]): unknown[][] {
  const rows = existing.map((row) => [...row]);
  const position = new Map(rows.map((row, index) => [key(...keyIndices.map((column) => row[column])), index]));
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

async function readDataRows(workbookId: string, sheet: string, rangeEnd: string): Promise<unknown[][]> {
  const response = await readRange(workbookId, `${sheet}!A1:${rangeEnd}10000`);
  const raw = (response.values ?? []) as unknown[][];
  return raw.length > 0 ? raw.slice(1) : [];
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|\b400\b|sheet\s+"?[^"]+"?\s+not found/i.test(message);
}

async function readOptionalDataRows(workbookId: string, sheet: string, rangeEnd: string): Promise<unknown[][]> {
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
  const rows = replaceByKey(existing, additions, keyIndices);
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
      packetRaw = ((await readRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1:CA10000`)).values ?? []) as unknown[][];
    } catch (error: unknown) {
      if (!isMissingSheetError(error)) throw error;
      warnings.push(`MISSING_PREGAME_PACKET_HISTORY: ${date} cannot receive Module 24 diagnostics`);
    }
    const packetByGame = parseFrozenPacketDiagnostics(packetRaw, date);

    let ladderRaw: unknown[][] = [];
    try {
      ladderRaw = ((await readRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1:X10000`)).values ?? []) as unknown[][];
    } catch (error: unknown) {
      if (!isMissingSheetError(error)) throw error;
      warnings.push(`MISSING_FULL_LADDER_AUDIT: ${date} has no manual ladder ledger to settle`);
    }
    const ladderByGame = parseLadderRows(ladderRaw, date);
    const eligible = outcomes.filter((outcome) => packetByGame.has(outcome.game_id));
    for (const outcome of outcomes) {
      if (!packetByGame.has(outcome.game_id)) {
        warnings.push(`MISSING_PREGAME_PACKET: ${outcome.game_id} is ineligible for Module 24 diagnostics`);
      }
    }
    const allocationRows: unknown[][] = [];
    const starterRowsOut: unknown[][] = [];
    const timingRows: unknown[][] = [];
    const ladderRows: unknown[][] = [];
    const ladderExistingRows = ladderRaw.slice(1).map((row) => pad(row, FULL_LADDER_AUDIT_HEADERS.length));
    const ladderPositions = new Map(ladderExistingRows.map((row, index) => [key(row[LADDER.Date], row[LADDER.Game_ID]), index]));

    for (const outcome of eligible) {
      const packet = packetByGame.get(outcome.game_id)!;
      const allocation = buildAllocationDiagnostic(packet, outcome);
      allocationRows.push(allocation);
      const allocationReversal = text(allocation[24]);
      let detail: PostgameGameDetail = { away: null, home: null, away_runs_by_inning: new Map(), home_runs_by_inning: new Map(), status: "POSTGAME_DETAIL_UNAVAILABLE" };
      if (outcome.game_pk) {
        try {
          detail = await fetchPostgameDetail(outcome.game_pk);
        } catch (error: unknown) {
          warnings.push(`POSTGAME_DETAIL_UNAVAILABLE: ${outcome.game_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else warnings.push(`POSTGAME_DETAIL_UNAVAILABLE: ${outcome.game_id}: MLB gamePk missing from settlement`);
      starterRowsOut.push(...starterRows(packet, outcome, detail));
      timingRows.push(timingRow(packet, outcome, detail));

      const ladder = ladderByGame.get(outcome.game_id);
      if (ladder) {
        const grading = ladderRowsForGame(ladder, outcome, allocationReversal);
        ladderRows.push(...grading.rows);
        const position = ladderPositions.get(key(date, outcome.game_id));
        if (position !== undefined) {
          const settled = [...ladderExistingRows[position]!];
          settled[LADDER.Settlement_TS] = outcome.settlement_ts;
          settled[LADDER.Selected_Vehicle_Result] = grading.summary.selectedResult;
          settled[LADDER.Ledger_Settlement_Status] = grading.summary.vehicleGrade;
          ladderExistingRows[position] = settled;
        }
      }
    }

    const [existingAllocation, existingStarter, existingTiming, existingLadderSettlement] = await Promise.all([
      readOptionalDataRows(workbookId, ALLOCATION_SHEET, "AB"),
      readOptionalDataRows(workbookId, STARTER_SHEET, "AF"),
      readOptionalDataRows(workbookId, TIMING_SHEET, "W"),
      readOptionalDataRows(workbookId, LADDER_SETTLEMENT_SHEET, "T"),
    ]);
    await writeUpsertedRows(workbookId, ALLOCATION_SHEET, ALLOCATION_SETTLEMENT_HEADERS, existingAllocation, allocationRows, [0, 1]);
    await writeUpsertedRows(workbookId, STARTER_SHEET, STARTER_OUTCOME_HEADERS, existingStarter, starterRowsOut, [0, 1, 2]);
    await writeUpsertedRows(workbookId, TIMING_SHEET, BULLPEN_TIMING_HEADERS, existingTiming, timingRows, [0, 1]);
    await writeUpsertedRows(workbookId, LADDER_SETTLEMENT_SHEET, FULL_LADDER_SETTLEMENT_HEADERS, existingLadderSettlement, ladderRows, [0, 1, 3]);
    await ensureSheet(workbookId, FULL_LADDER_AUDIT_SHEET, FULL_LADDER_AUDIT_HEADERS.length);
    await writeRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1`, [Array.from(FULL_LADDER_AUDIT_HEADERS), ...ladderExistingRows]);
    logger.info({ date, frozen_packet_games: eligible.length, allocation_rows: allocationRows.length, ladder_rows: ladderRows.length }, "MODULE_24: postgame diagnostics written");
    return {
      status: "success", date,
      allocation_rows_written: allocationRows.length,
      starter_rows_written: starterRowsOut.length,
      timing_rows_written: timingRows.length,
      ladder_rows_written: ladderRows.length,
      frozen_packet_games: eligible.length,
      warnings, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ date, err: message }, "MODULE_24: postgame diagnostics failed");
    return {
      status: "failure", date, allocation_rows_written: 0, starter_rows_written: 0,
      timing_rows_written: 0, ladder_rows_written: 0, frozen_packet_games: 0, warnings, errors,
    };
  }
}
