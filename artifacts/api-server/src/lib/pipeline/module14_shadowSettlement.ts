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

const MLB_API = "https://statsapi.mlb.com/api/v1";
const HISTORY_SHEET = "SHADOW_HISTORY";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const OUTCOMES_COLS = 23; // A-W

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
const O_PROVENANCE_STATUS = 22;

export const OUTCOMES_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Repaired_Projected_Total", "Actual_Total", "Error", "Abs_Error",
  "Park_Source_Status", "Away_Offense_Source", "Home_Offense_Source", "Settlement_TS",
  "Projected_Away_Starter", "Projected_Home_Starter",
  "Actual_Away_Starter", "Actual_Home_Starter",
  "Away_Starter_Match_Status", "Home_Starter_Match_Status",
  "Away_Bulk_Pitcher", "Home_Bulk_Pitcher",
  "Away_Pitcher_Chain", "Home_Pitcher_Chain", "Pitcher_Provenance_Status",
];

export interface SettlementRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  repaired_projected_total: number;
  actual_total: number;
  error: number;
  abs_error: number;
  park_source_status: string;
  away_offense_source: string;
  home_offense_source: string;
  settlement_ts: string;
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

  const finals: Array<{ key: string; game_pk: number; actual_total: number }> = [];
  for (const day of schedule.dates ?? []) {
    for (const game of day.games ?? []) {
      if (game.status?.abstractGameState !== "Final") continue;
      const awayScore = game.teams?.away?.score;
      const homeScore = game.teams?.home?.score;
      const away = teamNameToAbbr(game.teams?.away?.team?.name ?? "");
      const home = teamNameToAbbr(game.teams?.home?.team?.name ?? "");
      if (awayScore === undefined || homeScore === undefined || !away || !home || !game.gamePk) continue;
      finals.push({ key: `${away}_${home}`, game_pk: game.gamePk, actual_total: awayScore + homeScore });
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
    row.projected_away_starter, row.projected_home_starter,
    row.actual_away_starter, row.actual_home_starter,
    row.away_starter_match_status, row.home_starter_match_status,
    row.away_bulk_pitcher, row.home_bulk_pitcher,
    row.away_pitcher_chain, row.home_pitcher_chain, row.pitcher_provenance_status,
  ];
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

  type Existing = { sheetRow: number; values: string[] };
  const existingByGame = new Map<string, Existing>();
  let existingRowCount = 0;
  try {
    const response = await readRange(wbId, `${OUTCOMES_SHEET}!A1:W5000`);
    const all = (response.values ?? []) as string[][];
    existingRowCount = all.length;
    all.slice(1).forEach((row, index) => {
      const gameId = row[1] ?? "";
      if (gameId) existingByGame.set(gameId, { sheetRow: index + 2, values: row });
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
  const writes: Array<{ sheetRow: number | null; row: SettlementRow }> = [];
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
    if (existing?.values[O_PROVENANCE_STATUS] === "COMPLETE") {
      skipped++;
      continue;
    }

    const projection = Number.parseFloat(history[H_REPAIRED] ?? "0") || 0;
    const error = Number.parseFloat((projection - final.actual_total).toFixed(2));
    const provenance = final.provenance;
    if (provenance.status !== "COMPLETE") provenanceIncomplete++;

    const row: SettlementRow = {
      date: history[H_DATE] ?? date,
      game_id: gameId,
      away_team: history[H_AWAY] ?? "",
      home_team: history[H_HOME] ?? "",
      repaired_projected_total: projection,
      actual_total: final.actual_total,
      error,
      abs_error: Number.parseFloat(Math.abs(error).toFixed(2)),
      park_source_status: history[H_PARK_SRC] ?? "",
      away_offense_source: history[H_AWAY_SRC] ?? "",
      home_offense_source: history[H_HOME_SRC] ?? "",
      settlement_ts: existing?.values[O_SETTLEMENT_TS] || ts,
      projected_away_starter: history[H_AWAY_PITCHER] ?? "",
      projected_home_starter: history[H_HOME_PITCHER] ?? "",
      actual_away_starter: provenance.away.actual_starter,
      actual_home_starter: provenance.home.actual_starter,
      away_starter_match_status: comparePitcherNames(history[H_AWAY_PITCHER] ?? "", provenance.away.actual_starter),
      home_starter_match_status: comparePitcherNames(history[H_HOME_PITCHER] ?? "", provenance.home.actual_starter),
      away_bulk_pitcher: provenance.away.bulk_pitcher,
      home_bulk_pitcher: provenance.home.bulk_pitcher,
      away_pitcher_chain: provenance.away.pitcher_chain,
      home_pitcher_chain: provenance.home.pitcher_chain,
      pitcher_provenance_status: provenance.status,
    };
    processed.push(row);
    writes.push({ sheetRow: existing?.sheetRow ?? null, row });
    if (existing) updated++; else settled++;
  }

  try {
    await expandSheetColumns(wbId, OUTCOMES_SHEET, OUTCOMES_COLS);
    await writeRange(wbId, `${OUTCOMES_SHEET}!A1:W1`, [OUTCOMES_HEADER]);
    let appendRow = Math.max(existingRowCount + 1, 2);
    for (const pending of writes) {
      const target = pending.sheetRow ?? appendRow++;
      await writeRange(wbId, `${OUTCOMES_SHEET}!A${target}:W${target}`, [settlementRowToValues(pending.row)]);
    }
  } catch (error: unknown) {
    errors.push(`SHADOW_OUTCOMES write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const status: SettlementResult["status"] = errors.length > 0
    ? (processed.length > 0 ? "partial" : "failure")
    : provenanceIncomplete > 0 ? "partial"
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
