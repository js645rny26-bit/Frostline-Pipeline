/**
 * Module 08b: STATCAST_GAME_PREVIEW Sheet Writer
 *
 * Clears and rewrites the STATCAST_GAME_PREVIEW workbook tab with the results
 * from module02e (Baseball Savant game preview fetch). The raw payload files on
 * disk are the immutable audit record; the sheet is the run's summary view.
 *
 * Preview_Used_In_Projection is always "NO" in Phase 1.
 * Projection logic, authorization, and lock state are not affected.
 */

import { addSheet, clearRange, writeRange } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { StatcastPreviewResult, StatcastPreviewGameResult, StatcastPlayerStats } from "./module02e_statcastPreview.js";

const SHEET = "STATCAST_GAME_PREVIEW";

// Column count must match WORKBOOK_SCHEMA STATCAST_GAME_PREVIEW definition exactly.
const HEADER: string[] = [
  // Identity + status (cols A–U, indices 0–20)
  "Date", "Game_ID", "MLB_GamePk", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Preview_Availability", "Fetch_Status", "Fetch_TS", "Source_Name", "Source_URL_or_Endpoint",
  "Source_Published_TS", "Payload_Hash", "Parser_Version",
  "Starting_Pitcher_Match_Status", "Lineup_Match_Status", "Stale_Data_Flag",
  "Parse_Warnings", "Parse_Error", "Preview_Used_In_Projection", "Projection_Influence_Notes",
  // Away pitcher Statcast (cols V–AF, indices 21–30)
  "Away_Pitcher_ID", "Away_Pitcher_Name", "Away_Pitcher_Qualifies",
  "Away_Pitcher_xwOBA", "Away_Pitcher_K_Pct", "Away_Pitcher_BB_Pct",
  "Away_Pitcher_EV_Avg", "Away_Pitcher_Whiff_Pct", "Away_Pitcher_Hard_Hit_Pct",
  "Away_Pitcher_Barrel_Rate",
  // Home pitcher Statcast (cols AG–AQ, indices 31–40)
  "Home_Pitcher_ID", "Home_Pitcher_Name", "Home_Pitcher_Qualifies",
  "Home_Pitcher_xwOBA", "Home_Pitcher_K_Pct", "Home_Pitcher_BB_Pct",
  "Home_Pitcher_EV_Avg", "Home_Pitcher_Whiff_Pct", "Home_Pitcher_Hard_Hit_Pct",
  "Home_Pitcher_Barrel_Rate",
  // Away hitter aggregates (cols AR–AX, indices 41–47)
  "Away_Hitters_Total", "Away_Hitters_Qualified",
  "Away_Hitters_xwOBA_Avg", "Away_Hitters_EV_Avg", "Away_Hitters_Hard_Hit_Avg",
  "Away_Hitters_K_Pct_Avg", "Away_Hitters_BB_Pct_Avg",
  // Home hitter aggregates (cols AY–BE, indices 48–54)
  "Home_Hitters_Total", "Home_Hitters_Qualified",
  "Home_Hitters_xwOBA_Avg", "Home_Hitters_EV_Avg", "Home_Hitters_Hard_Hit_Avg",
  "Home_Hitters_K_Pct_Avg", "Home_Hitters_BB_Pct_Avg",
];

const SOURCE_NAME = "Baseball Savant Game Preview (baseballsavant.mlb.com/preview)";

export interface StatcastPreviewWriterResult {
  status: "success" | "failure";
  write_timestamp_utc: string;
  rows_written: number;
  errors: string[];
}

/** Create the sheet on first run; silently swallow "already exists" errors. */
async function ensureSheet(workbookId: string): Promise<void> {
  try {
    await addSheet(workbookId, SHEET);
    logger.info("MODULE_08b: Created STATCAST_GAME_PREVIEW sheet");
  } catch {
    // Sheet already exists — expected on every run after the first
  }
}

/** Round a number to 3 decimal places, or return "" for null/undefined. */
function fmt3(v: number | null | undefined): number | string {
  if (v === null || v === undefined) return "";
  return Math.round(v * 1000) / 1000;
}

/** Format a boolean for display. */
function fmtBool(v: boolean): string {
  return v ? "YES" : "NO";
}

/** Flatten pitcher stats into ordered cell values matching the pitcher columns. */
function pitcherCells(s: StatcastPlayerStats | null): (string | number)[] {
  if (!s) {
    return ["", "", "", "", "", "", "", "", "", ""];
  }
  return [
    s.player_id ?? "",
    s.player_name ?? "",
    s.did_not_qualify ? "NO" : "YES",
    fmt3(s.xwoba),
    fmt3(s.k_percent),
    fmt3(s.bb_percent),
    fmt3(s.exit_velocity_avg),
    fmt3(s.whiff_percent),
    fmt3(s.hard_hit_percent),
    fmt3(s.barrel_batted_rate),
  ];
}

/** Convert one game result to a flat row array aligned to HEADER. */
function gameToRow(g: StatcastPreviewGameResult): (string | number | boolean)[] {
  return [
    // Identity + status
    g.date,
    g.game_id,
    g.gamePk,
    g.away_team ?? "",
    g.home_team ?? "",
    g.scheduled_first_pitch ?? "",
    g.preview_availability,
    g.fetch_status,
    g.fetch_ts,
    SOURCE_NAME,
    g.source_url,
    "",                               // Source_Published_TS — not available from this source
    g.payload_hash ?? "",
    g.parser_version,
    g.starting_pitcher_match_status,
    g.lineup_match_status,
    fmtBool(g.stale_data_flag),
    g.parse_warnings.join("; "),
    g.parse_error ?? "",
    g.preview_used_in_projection,
    g.projection_influence_notes,
    // Away pitcher
    ...pitcherCells(g.away_pitcher_stats),
    // Home pitcher
    ...pitcherCells(g.home_pitcher_stats),
    // Away hitter aggregates
    g.away_hitters_total,
    g.away_hitters_qualified,
    fmt3(g.away_hitters_xwoba_avg),
    fmt3(g.away_hitters_ev_avg),
    fmt3(g.away_hitters_hard_hit_avg),
    fmt3(g.away_hitters_k_pct_avg),
    fmt3(g.away_hitters_bb_pct_avg),
    // Home hitter aggregates
    g.home_hitters_total,
    g.home_hitters_qualified,
    fmt3(g.home_hitters_xwoba_avg),
    fmt3(g.home_hitters_ev_avg),
    fmt3(g.home_hitters_hard_hit_avg),
    fmt3(g.home_hitters_k_pct_avg),
    fmt3(g.home_hitters_bb_pct_avg),
  ];
}

/**
 * Clear and rewrite the STATCAST_GAME_PREVIEW sheet for this pipeline run.
 * Header row is always written; game rows follow. Sheet is clear-and-replace
 * (not append) — the disk payload files are the immutable audit record.
 */
export async function writeStatcastPreviewFeed(
  preview: StatcastPreviewResult,
  workbookId: string,
): Promise<StatcastPreviewWriterResult> {
  const writeTs = new Date().toISOString();
  const errors: string[] = [];

  try {
    await ensureSheet(workbookId);

    const lastCol = String.fromCharCode(65 + ((HEADER.length - 1) % 26)); // single-letter range cap
    // Use a wide enough column reference; HEADER has 55 cols (A–BC range)
    const colCount = HEADER.length;
    // Build A1 notation end column for 55 columns: A=1, Z=26, AA=27 … BC=55
    function colLetter(n: number): string {
      let s = "";
      while (n > 0) {
        n--; // 0-indexed
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26);
      }
      return s;
    }
    const endCol = colLetter(colCount);
    const clearRangeStr = `${SHEET}!A1:${endCol}`;

    await clearRange(workbookId, clearRangeStr);

    const dataRows = preview.games.map(gameToRow);
    const allRows = [HEADER, ...dataRows];

    const writeRangeStr = `${SHEET}!A1:${endCol}${allRows.length}`;
    await writeRange(workbookId, writeRangeStr, allRows);

    logger.info(
      {
        rows: dataRows.length,
        available: preview.games_available,
        failed: preview.games_failed,
      },
      "MODULE_08b: STATCAST_GAME_PREVIEW written",
    );

    return {
      status: "success",
      write_timestamp_utc: writeTs,
      rows_written: dataRows.length,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_08b: failed to write STATCAST_GAME_PREVIEW");
    errors.push(msg);
    return {
      status: "failure",
      write_timestamp_utc: writeTs,
      rows_written: 0,
      errors,
    };
  }
}
