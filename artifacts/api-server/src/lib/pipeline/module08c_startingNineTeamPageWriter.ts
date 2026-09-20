/**
 * Module 08c: MLB Starting Nine individual team-page materialization.
 *
 * The named starter can act only as a verified fallback for an otherwise
 * unresolved MLB schedule starter. Every descriptive matchup statistic stays
 * DISPLAY_ONLY_NOT_PROJECTION_INPUT until a separate commissioning review.
 */

import { addSheet, clearRange, expandSheetColumns, readRange, writeRange } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { baseGameId } from "./module01_mlbStatsApi.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type {
  StartingNineResult,
  StartingNineStarterFallback,
  StartingNineTeamPage,
} from "./module04c_startingNine.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";

export const STARTING_NINE_TEAM_PAGE_SHEET = "STARTING_NINE_TEAM_PAGE_V1";

export const STARTING_NINE_TEAM_PAGE_HEADERS = [
  "Date", "Game_ID", "Team", "Opponent", "Team_Side", "Scheduled_First_Pitch",
  "Lineup_Status", "Starting_Pitcher_ID", "Starting_Pitcher_Name", "Starting_Pitcher_Hand",
  "Starting_Pitcher_Identity_Status", "Starter_Fallback_Applied",
  "Opposing_Pitcher_ID", "Opposing_Pitcher_Name", "Opposing_Pitcher_Hand",
  "Opposing_Pitcher_IP", "Opposing_Pitcher_ERA", "Opposing_Pitcher_WHIP", "Opposing_Pitcher_SO",
  "Opposing_vs_LHB_AVG", "Opposing_vs_LHB_OPS", "Opposing_vs_LHB_HR", "Opposing_vs_LHB_K",
  "Opposing_vs_RHB_AVG", "Opposing_vs_RHB_OPS", "Opposing_vs_RHB_HR", "Opposing_vs_RHB_K",
  "Park_Runs_Index", "Park_HR_LHB_Index", "Park_HR_RHB_Index",
  "Umpire", "Umpire_K_Rate", "Umpire_BB_Rate", "Umpire_Runs_Per_Game",
  "Observed_TS_UTC", "Source_URL", "Source_Status", "Source_Notes",
  "Active_Input", "Mapping_Status",
] as const;

export interface StartingNineTeamPageWriterResult {
  status: "success" | "partial" | "failure";
  write_timestamp_utc: string;
  rows_written: number;
  pages_requested: number;
  pages_parsed: number;
  starter_fallbacks_applied: number;
  errors: string[];
}

function colLetter(n: number): string {
  let value = "";
  while (n > 0) {
    n--;
    value = String.fromCharCode(65 + (n % 26)) + value;
    n = Math.floor(n / 26);
  }
  return value;
}

function cell(value: string | number | null | undefined): string | number {
  return value === null || value === undefined ? "" : value;
}

function rowValues(page: StartingNineTeamPage, gameId: string, fallbackApplied: boolean): unknown[] {
  return [
    page.date, gameId, page.team_abbr ?? "", page.opponent_abbr ?? "", page.team_side,
    page.scheduled_first_pitch_utc ?? "", page.lineup_status,
    cell(page.starting_pitcher_id), cell(page.starting_pitcher_name), cell(page.starting_pitcher_hand),
    page.starting_pitcher_identity_status, fallbackApplied ? "YES" : "NO",
    cell(page.opposing_pitcher_id), cell(page.opposing_pitcher_name), cell(page.opposing_pitcher_hand),
    cell(page.opposing_pitcher_ip), cell(page.opposing_pitcher_era), cell(page.opposing_pitcher_whip),
    cell(page.opposing_pitcher_so),
    cell(page.opposing_pitcher_vs_lhb.avg), cell(page.opposing_pitcher_vs_lhb.ops),
    cell(page.opposing_pitcher_vs_lhb.hr), cell(page.opposing_pitcher_vs_lhb.k),
    cell(page.opposing_pitcher_vs_rhb.avg), cell(page.opposing_pitcher_vs_rhb.ops),
    cell(page.opposing_pitcher_vs_rhb.hr), cell(page.opposing_pitcher_vs_rhb.k),
    cell(page.park_runs_index), cell(page.park_hr_lhb_index), cell(page.park_hr_rhb_index),
    cell(page.umpire), cell(page.umpire_k_rate), cell(page.umpire_bb_rate), cell(page.umpire_runs_per_game),
    page.observed_ts_utc, page.source_url, page.source_status, page.source_notes.join("; "),
    page.active_input, page.mapping_status,
  ];
}

export function buildStartingNineTeamPageRows(
  result: StartingNineResult,
  games: readonly NormalizedGame[],
  fallbacks: readonly StartingNineStarterFallback[],
): unknown[][] {
  const gamesByBase = new Map<string, NormalizedGame[]>();
  for (const game of games) {
    const base = baseGameId(game.legacy_game_id);
    const group = gamesByBase.get(base) ?? [];
    group.push(game);
    gamesByBase.set(base, group);
  }
  const fallbackKeys = new Set(fallbacks.map((fallback) => `${fallback.game_id}|${fallback.team_abbr}`));
  return result.team_pages.flatMap((page) => {
    if (!page.game_id || !page.team_abbr) return [];
    const matches = gamesByBase.get(baseGameId(page.game_id)) ?? [];
    if (matches.length !== 1) return [];
    const gameId = matches[0]!.legacy_game_id;
    return [rowValues(page, gameId, fallbackKeys.has(`${gameId}|${page.team_abbr}`))];
  });
}

export async function writeStartingNineTeamPageFeed(
  result: StartingNineResult,
  games: readonly NormalizedGame[],
  fallbacks: readonly StartingNineStarterFallback[],
  workbookId: string,
  protection?: PublicationProtection,
): Promise<StartingNineTeamPageWriterResult> {
  const writeTs = new Date().toISOString();
  const errors: string[] = [];
  try {
    try { await addSheet(workbookId, STARTING_NINE_TEAM_PAGE_SHEET); } catch { /* already exists */ }
    await expandSheetColumns(workbookId, STARTING_NINE_TEAM_PAGE_SHEET, STARTING_NINE_TEAM_PAGE_HEADERS.length);
    const endCol = colLetter(STARTING_NINE_TEAM_PAGE_HEADERS.length);
    const dataRange = `${STARTING_NINE_TEAM_PAGE_SHEET}!A2:${endCol}100`;
    const incomingRows = buildStartingNineTeamPageRows(result, games, fallbacks);
    const rows = protection && protection.protected_game_ids.size > 0
      ? mergeProtectedRows(
          (await readRange(workbookId, dataRange).catch(() => ({ values: [] }))).values ?? [],
          incomingRows,
          1,
          protection.protected_game_ids,
          protection.expected_game_ids,
        )
      : incomingRows;
    await clearRange(workbookId, dataRange);
    await writeRange(workbookId, `${STARTING_NINE_TEAM_PAGE_SHEET}!A1:${endCol}1`, [[...STARTING_NINE_TEAM_PAGE_HEADERS]]);
    if (rows.length > 0) {
      await writeRange(workbookId, `${STARTING_NINE_TEAM_PAGE_SHEET}!A2:${endCol}${rows.length + 1}`, rows);
    }
    logger.info({ rows: rows.length, fallbacks: fallbacks.length }, "MODULE_08c: Starting Nine team pages written");
    return {
      status: result.team_page_status === "success" ? "success" : "partial",
      write_timestamp_utc: writeTs,
      rows_written: rows.length,
      pages_requested: result.team_pages_requested,
      pages_parsed: result.team_pages_parsed,
      starter_fallbacks_applied: fallbacks.length,
      errors: [...result.team_page_errors],
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      status: "failure",
      write_timestamp_utc: writeTs,
      rows_written: 0,
      pages_requested: result.team_pages_requested,
      pages_parsed: result.team_pages_parsed,
      starter_fallbacks_applied: fallbacks.length,
      errors,
    };
  }
}
