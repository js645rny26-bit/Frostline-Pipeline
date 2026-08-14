/**
 * Module 14: Shadow Settlement
 *
 * Pairs the last pregame SHADOW_HISTORY snapshot for each game with the final
 * score and the actual pitching chain. Existing outcome rows are updated when
 * provenance is missing, so a rerun repairs old settlements without duplicates.
 */

import { readRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";
import {
  comparePitcherNames,
  parseGamePitcherProvenance,
  type GamePitcherProvenance,
  type PitcherMatchStatus,
  type PitcherProvenanceStatus,
} from "./module14_pitcherProvenance.js";
import type { PostmortemEventEvidence } from "./module21_postmortemMechanism.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const HISTORY_SHEET = "SHADOW_HISTORY";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const VEHICLE_LOG_SHEET = "VEHICLE_LOG";
const DECISION_AUDIT_SHEET = "DECISION_AUDIT_LOG";
const PROJECTION_REPLAY_SHEET = "PROJECTION_REPLAY";
const OUTCOMES_COLS = 33; // A-AG

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

const O_SETTLEMENT_TS = 11;
const O_FROZEN_SOURCE = 15;
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

export interface ProspectiveSnapshotParseResult {
  snapshots: Map<string, FrozenProjection>;
  warnings: string[];
}

export function selectProspectiveProjection(
  vehicle: FrozenProjection | undefined,
  auditSnapshot: FrozenProjection | undefined,
): FrozenProjection | undefined {
  return vehicle ?? auditSnapshot;
}

export interface SettlementRow {
  date: string;
  game_id: string;
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
  projected_away_starter: string;
  projected_home_starter: string;
  actual_away_starter: string;
  actual_home_starter: string;
  away_starter_match_status: PitcherMatchStatus;
  home_starter_match_status: PitcherMatchStatus;
  away_bulk_pitcher: string;
  home_bulk_pitcher: string;
  away_pitcher_chain: string;
  home_pitcher_chain: string;
  pitcher_provenance_status: PitcherProvenanceStatus;
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

async function fetchFinalGames(date: string, warnings: string[]): Promise<Map<string, FinalGame>> {
  const schedule = await fetchJson(
    `${MLB_API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=linescore`,
  ) as { dates?: Array<{ games?: MlbGame[] }> };

  const finals: Array<{
    key: string;
    game_pk: number;
    actual_away_runs: number;
    actual_home_runs: number;
    actual_total: number;
  }> = [];
  for (const day of schedule.dates ?? []) {
    for (const game of day.games ?? []) {
      if (game.status?.abstractGameState !== "Final") continue;
      const awayScore = game.teams?.away?.score;
      const homeScore = game.teams?.home?.score;
      const away = teamNameToAbbr(game.teams?.away?.team?.name ?? "");
      const home = teamNameToAbbr(game.teams?.home?.team?.name ?? "");
      if (awayScore === undefined || homeScore === undefined || !away || !home || !game.gamePk) continue;
      finals.push({
        key: `${away}_${home}`,
        game_pk: game.gamePk,
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

  return new Map(resolved.map((game) => [game.key, {
    game_pk: game.game_pk,
    actual_away_runs: game.actual_away_runs,
    actual_home_runs: game.actual_home_runs,
    actual_total: game.actual_total,
    provenance: game.provenance,
  }]));
}

function gameIdToTeamKey(gameId: string): string | null {
  const parts = gameId.split("_");
  return parts.length >= 3 ? `${parts[1]}_${parts[2]}` : null;
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

function frozenAuditValues(
  repairedProjection: number,
  actualTotal: number,
  projection: FrozenProjection | undefined,
  existing?: unknown[],
): unknown[] {
  // Schema-v16 manual repairs stored the frozen audit directly in M:V. Preserve
  // those values verbatim while migrating the pitcher fields to W:AG.
  if (isPreservedProspectiveSource(existing?.[O_FROZEN_SOURCE])) {
    return existing!.slice(12, 22);
  }
  if (!projection) {
    return ["", "", "", "MISSING_FROZEN_VEHICLE_LOG", "", "", "", "", "", "FROZEN_SOURCE_UNRESOLVED"];
  }
  const frozenError = round2(projection.projected_total - actualTotal);
  const delta = round2(repairedProjection - projection.projected_total);
  const line = projection.market_line;
  const result = gradeDirection(projection.direction, line, actualTotal);
  return [
    projection.projected_total,
    frozenError,
    round2(Math.abs(frozenError)),
    projection.source ?? "FROZEN_VEHICLE_LOG",
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
  return date < FROZEN_VEHICLE_REQUIRED_FROM_DATE
    ? { warning: `LEGACY_${message}` }
    : { error: message };
}

/** Migrate either legacy frozen-audit M:V rows or v16 pitcher M:W rows. */
export function normalizeOutcomeValues(
  raw: unknown[],
  vehicle?: FrozenProjection,
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
  const frozen = frozenAuditValues(repaired, actual, vehicle, raw);
  return [...base, ...frozen, ...pitcher].slice(0, OUTCOMES_COLS);
}

function combinedProvenanceStatus(
  actualStatus: PitcherProvenanceStatus,
  awayMatch: PitcherMatchStatus,
  homeMatch: PitcherMatchStatus,
): PitcherProvenanceStatus {
  if (actualStatus !== "COMPLETE") return actualStatus;
  return awayMatch === "UNRESOLVED" || homeMatch === "UNRESOLVED" ? "PARTIAL" : "COMPLETE";
}

function projectionReplayGameId(date: string, away: string, home: string): string {
  return `${date}_${away}@${home}`;
}

export function frozenProjectionReplayValues(row: SettlementRow, ts: string): unknown[] | null {
  const frozen = row.frozen_published_total;
  const error = row.frozen_error;
  if (frozen === null || error === null) return null;
  return [
    row.date, projectionReplayGameId(row.date, row.away_team, row.home_team),
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

  const vehiclesByGame = new Map<string, FrozenProjection>();
  try {
    const response = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:N5000`);
    for (const row of ((response.values ?? []) as unknown[][]).slice(1)) {
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

  type Existing = { dataIndex: number; values: unknown[] };
  const existingByGame = new Map<string, Existing>();
  let existingRows: unknown[][] = [];
  try {
    const response = await readRange(wbId, `${OUTCOMES_SHEET}!A1:AG5000`);
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
    const key = gameIdToTeamKey(gameId);
    const final = key ? finalGames.get(key) : undefined;
    if (!final) {
      noActual++;
      continue;
    }

    const existing = existingByGame.get(gameId);
    // Once an outcome row exists, preserve every pregame-origin field from that
    // row. Settlement reruns may refresh actual/provenance fields only.
    const projection = existing
      ? numberOrNull(existing.values[4]) ?? 0
      : Number.parseFloat(history[H_REPAIRED] ?? "0") || 0;
    const error = Number.parseFloat((projection - final.actual_total).toFixed(2));
    const provenance = final.provenance;
    const projectedAwayStarter = String(existing?.values[22] || history[H_AWAY_PITCHER] || "");
    const projectedHomeStarter = String(existing?.values[23] || history[H_HOME_PITCHER] || "");
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
    const frozen = frozenAuditValues(projection, final.actual_total, prospectiveProjection, existing?.values);
    const frozenGap = classifyFrozenVehicleGap(
      date,
      gameId,
      prospectiveProjection !== undefined || isPreservedProspectiveSource(existing?.values[O_FROZEN_SOURCE]),
    );
    if (frozenGap.warning) warnings.push(frozenGap.warning);
    if (frozenGap.error) errors.push(frozenGap.error);

    const row: SettlementRow = {
      date: String(existing?.values[0] || history[H_DATE] || date),
      game_id: gameId,
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
      projected_away_starter: projectedAwayStarter,
      projected_home_starter: projectedHomeStarter,
      actual_away_starter: provenance.away.actual_starter,
      actual_home_starter: provenance.home.actual_starter,
      away_starter_match_status: awayMatch,
      home_starter_match_status: homeMatch,
      away_bulk_pitcher: provenance.away.bulk_pitcher,
      home_bulk_pitcher: provenance.home.bulk_pitcher,
      away_pitcher_chain: provenance.away.pitcher_chain,
      home_pitcher_chain: provenance.home.pitcher_chain,
      pitcher_provenance_status: combinedStatus,
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
