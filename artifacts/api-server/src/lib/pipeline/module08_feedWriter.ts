/**
 * Module 08: Google Sheets Feed Writer
 * Writes normalized data to 5 input sheets in the canonical workbook.
 * Workbook: 1FY2FgpFbr2pSmFF-0Gowh-HXW3z5QOnj2ujpcTQQRB4
 */

import {
  clearRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult, NormalizedGame } from "./module06_normalization.js";
import type { FangraphsResult } from "./module05_fangraphs.js";

export interface SheetWriteStatus {
  status: "success" | "failure" | "skipped";
  rows_written: number;
  range: string;
  error?: string;
}

export interface Module08Result {
  status: "success" | "failure" | "partial_failure";
  write_timestamp_utc: string;
  workbook_id: string;
  sheets_written: {
    daily_matchups: SheetWriteStatus;
    today_lineups: SheetWriteStatus;
    team_form_input: SheetWriteStatus;
    bullpen_usage_daily: SheetWriteStatus;
    run_environment: SheetWriteStatus;
  };
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

// ─── Row builders ─────────────────────────────────────────────────────────────

// Schema: DAILY_MATCHUPS — 25 cols A–Y, data starts row 2 (frozenRows: 1)
function confidenceNum(c: string | null | undefined): number {
  if (c === "high") return 0.9;
  if (c === "medium") return 0.75;
  return 0.5;
}

function buildDailyMatchupsRows(games: NormalizedGame[]): unknown[][] {
  const now = new Date().toISOString();
  return games.map((g) => [
    g.date,                                                          // A: Date
    g.legacy_game_id,                                                // B: Game_ID
    g.game_status.detailedState ?? "Scheduled",                      // C: Game_Status
    g.away_team.team_abbr ?? "",                                     // D: Away_Team
    g.home_team.team_abbr ?? "",                                     // E: Home_Team
    g.away_pitcher.name ?? "",                                       // F: Away_Pitcher
    g.home_pitcher.name ?? "",                                       // G: Home_Pitcher
    g.away_pitcher.role ?? "UNRESOLVED",                             // H: Away_Pitcher_Role
    g.home_pitcher.role ?? "UNRESOLVED",                             // I: Home_Pitcher_Role
    confidenceNum(g.away_pitcher.role_confidence),                   // J: Away_Pitcher_Confidence
    confidenceNum(g.home_pitcher.role_confidence),                   // K: Home_Pitcher_Confidence
    g.away_pitcher.expected_pitches ?? "",                           // L: Away_Expected_Pitches
    g.home_pitcher.expected_pitches ?? "",                           // M: Home_Expected_Pitches
    g.away_pitcher.expected_innings ?? "",                           // N: Away_Expected_Innings
    g.home_pitcher.expected_innings ?? "",                           // O: Home_Expected_Innings
    g.environment.temperature_f ?? "",                               // P: Temperature_F
    g.environment.wind_speed_mph ?? "",                              // Q: Wind_MPH
    g.environment.precipitation_probability_pct !== null
      ? g.environment.precipitation_probability_pct / 100 : "",     // R: Precipitation_Pct (0–1)
    g.environment.data_quality === "fallback" ? "CLIMATOLOGY" : "LIVE_WX", // S: Weather_Source
    g.venue.name ?? "",                                              // T: Stadium
    1.0,                                                             // U: Park_Factor_HR (stub)
    4.75,                                                            // V: Run_Environment (stub)
    now,                                                             // W: FanGraphs_Last_Updated
    now,                                                             // X: Statcast_Last_Updated
    "",                                                              // Y: Notes
  ]);
}

function buildWeatherTag(g: NormalizedGame): string {
  const temp = g.environment.temperature_f;
  const wind = g.environment.wind_speed_mph;
  const rain = g.environment.precipitation_probability_pct;
  if (rain !== null && rain > 50) return "RAIN_RISK";
  if (temp !== null && temp > 90) return "HOT";
  if (temp !== null && temp < 50) return "COLD";
  if (wind !== null && wind > 20) return "WINDY";
  return "NEUTRAL";
}

// Schema: TODAY_LINEUPS — 14 cols A–N, data starts row 2 (frozenRows: 1)
// Projected placeholder rows: 9 batting slots × 2 teams per game.
// Player-level data (name, ID, wRC+, salary) will be populated once a roster source is wired up.
function buildTodayLineupsRows(games: NormalizedGame[]): unknown[][] {
  const rows: unknown[][] = [];

  for (const g of games) {
    for (const side of ["A", "H"] as const) {
      const team = side === "A" ? g.away_team : g.home_team;
      for (let order = 1; order <= 9; order++) {
        rows.push([
          g.date,              // A: Date
          g.legacy_game_id,   // B: Game_ID
          team.team_abbr ?? "", // C: Team
          order,              // D: Batting_Order
          "",                 // E: Player_Name (no source yet)
          "",                 // F: Player_ID
          "",                 // G: Position
          "",                 // H: vs_LHP_wRC_plus
          "",                 // I: vs_RHP_wRC_plus
          "",                 // J: Last_30_Days_wRC_plus
          "ACTIVE",           // K: Injury_Status
          "",                 // L: Salary
          "",                 // M: FanGraphs_Projection
          "",                 // N: Notes
        ]);
      }
    }
  }
  return rows;
}

// Schema: TEAM_FORM_INPUT — 8 cols A–H, 1 row per team (30 rows), data starts row 2
// FanGraphs provides vs_RHP / vs_LHP splits; we average them into a single team row.
// Runs scored/allowed are estimated from wRC+ (100 wRC+ ≈ 4.5 R/G league average).
function buildTeamFormRows(splits: FangraphsResult["teams"]): unknown[][] {
  const date = new Date().toISOString().split("T")[0];
  // Collapse two splits per team into one row, keyed by team abbr
  const byTeam = new Map<string, { rsTotal: number; raTotal: number; woba: number; n: number }>();
  for (const s of splits) {
    const entry = byTeam.get(s.team) ?? { rsTotal: 0, raTotal: 0, woba: 0, n: 0 };
    // Estimate runs scored per game from wRC+ and runs allowed as its mirror
    entry.rsTotal += (s.l30_wrc_plus / 100) * 4.5;
    entry.raTotal += 4.5; // league-average placeholder until RA source is wired up
    entry.woba += 0.315 + (s.l30_wrc_plus - 100) * 0.001; // rough wOBA from wRC+
    entry.n++;
    byTeam.set(s.team, entry);
  }

  return Array.from(byTeam.entries()).map(([team, d]) => [
    date,                                                  // A: Date
    team,                                                  // B: Team
    parseFloat((d.rsTotal / d.n).toFixed(2)),              // C: Last_10_Runs_Scored (est.)
    parseFloat((d.raTotal / d.n).toFixed(2)),              // D: Last_10_Runs_Allowed (stub)
    parseFloat((d.woba / d.n).toFixed(3)),                 // E: Last_10_wOBA (est.)
    "MEDIUM",                                              // F: Recent_Strength_of_Schedule
    1,                                                     // G: Bullpen_Rest_Days (stub)
    "",                                                    // H: Notes
  ]);
}

// BULLPEN_USAGE_DAILY columns (A–I):
//   A: Date | B: Team | C: Reliever_Name | D: Player_ID
//   E: Innings_Last_7_Days | F: Games_Last_7_Days | G: Days_Rest | H: Role | I: Notes
// Per-reliever rows will be populated once the Statcast bullpen usage source is wired up.
function buildBullpenRows(_date: string): unknown[][] {
  return []; // No reliever data source yet; sheet cleared and left ready for operator input
}

// Schema: RUN_ENVIRONMENT — 12 cols A–L, data starts row 2 (frozenRows: 1)
function buildRunEnvironmentRows(games: NormalizedGame[]): unknown[][] {
  return games.map((g) => {
    const e = g.environment;
    return [
      g.date,                                                              // A: Date
      g.legacy_game_id,                                                    // B: Game_ID
      g.venue.name ?? "",                                                  // C: Stadium
      0,                                                                   // D: Elevation_Feet (stub — add per-venue lookup later)
      e.temperature_f ?? "",                                               // E: Temperature_F
      e.wind_speed_mph ?? "",                                              // F: Wind_MPH
      compassDirection(e.wind_direction_degrees),                          // G: Wind_Direction
      e.precipitation_probability_pct !== null
        ? e.precipitation_probability_pct / 100 : "",                     // H: Precipitation_Pct (0–1)
      e.humidity_pct !== null ? e.humidity_pct / 100 : "",                // I: Humidity_Pct (0–1)
      1.0,                                                                 // J: Home_Run_Factor (stub)
      1.0,                                                                 // K: Run_Multiplier (stub)
      "",                                                                  // L: Notes
    ];
  });
}

function compassDirection(degrees: number | null): string {
  if (degrees === null) return "VAR";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(degrees / 45) % 8];
}

// ─── Sheet write helper with retry ───────────────────────────────────────────

async function safeWrite(
  label: string,
  clearRng: string,
  writeRng: string,
  rows: unknown[][],
  workbookId: string,
): Promise<SheetWriteStatus> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await clearRange(workbookId, clearRng);
      if (rows.length === 0) {
        return { status: "success", rows_written: 0, range: writeRng };
      }
      const result = await writeRange(workbookId, writeRng, rows);
      logger.info({ sheet: label, rows: result.updatedRows }, "MODULE_08: Sheet written");
      return { status: "success", rows_written: result.updatedRows, range: result.updatedRange };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) {
        logger.error({ sheet: label, err: message }, "MODULE_08: Sheet write failed");
        return { status: "failure", rows_written: 0, range: writeRng, error: message };
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { status: "failure", rows_written: 0, range: writeRng, error: "exhausted retries" };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function writeGoogleSheetsFeed(
  normalized: NormalizationResult,
  splits: FangraphsResult,
  runDate: string,
  workbookId = WORKBOOK_ID,
): Promise<Module08Result> {
  logger.info({ games: normalized.games.length }, "MODULE_08: Writing feeds to Google Sheets");

  const errors: Module08Result["errors"] = [];
  const failed: string[] = [];

  // 1. DAILY_MATCHUPS — 25 cols A–Y, starts row 2
  const dmRows = buildDailyMatchupsRows(normalized.games);
  const dmResult = await safeWrite(
    "DAILY_MATCHUPS",
    "DAILY_MATCHUPS!A2:Y32",
    `DAILY_MATCHUPS!A2:Y${1 + Math.max(dmRows.length, 1)}`,
    dmRows,
    workbookId,
  );
  if (dmResult.status === "failure") {
    failed.push("daily_matchups");
    errors.push({ module: "08_daily_matchups", error: dmResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 2. TODAY_LINEUPS — 14 cols A–N, starts row 2
  const tlRows = buildTodayLineupsRows(normalized.games);
  const tlResult = await safeWrite(
    "TODAY_LINEUPS",
    "TODAY_LINEUPS!A2:N602",
    `TODAY_LINEUPS!A2:N${1 + Math.max(tlRows.length, 1)}`,
    tlRows,
    workbookId,
  );
  if (tlResult.status === "failure") {
    failed.push("today_lineups");
    errors.push({ module: "08_today_lineups", error: tlResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 3. TEAM_FORM_INPUT — 8 cols A–H, 30 rows (1 per team), starts row 2
  const tfRows = buildTeamFormRows(splits.teams);
  const tfResult = await safeWrite(
    "TEAM_FORM_INPUT",
    "TEAM_FORM_INPUT!A2:H62",
    `TEAM_FORM_INPUT!A2:H${1 + Math.max(tfRows.length, 1)}`,
    tfRows,
    workbookId,
  );
  if (tfResult.status === "failure") {
    failed.push("team_form_input");
    errors.push({ module: "08_team_form_input", error: tfResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 4. BULLPEN_USAGE_DAILY — clear data rows; reliever rows written when data source available
  let buResult: SheetWriteStatus = { status: "skipped", rows_written: 0, range: "BULLPEN_USAGE_DAILY!A2:I300" };
  try {
    const buRows = buildBullpenRows(runDate);
    await clearRange(workbookId, "BULLPEN_USAGE_DAILY!A2:I300");
    if (buRows.length > 0) {
      await writeRange(workbookId, `BULLPEN_USAGE_DAILY!A2:I${1 + buRows.length}`, buRows);
    }
    buResult = { status: "success", rows_written: buRows.length, range: "BULLPEN_USAGE_DAILY!A2:I300" };
    logger.info({ rows: buRows.length }, "MODULE_08: BULLPEN_USAGE_DAILY cleared and ready");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failed.push("bullpen_usage_daily");
    errors.push({ module: "08_bullpen_usage_daily", error: message, timestamp: new Date().toISOString() });
    buResult = { status: "failure", rows_written: 0, range: "BULLPEN_USAGE_DAILY!A2:I300", error: message };
  }

  // 5. RUN_ENVIRONMENT — 12 cols A–L, starts row 2
  const reRows = buildRunEnvironmentRows(normalized.games);
  const reResult = await safeWrite(
    "RUN_ENVIRONMENT",
    "RUN_ENVIRONMENT!A2:L32",
    `RUN_ENVIRONMENT!A2:L${1 + Math.max(reRows.length, 1)}`,
    reRows,
    workbookId,
  );
  if (reResult.status === "failure") {
    failed.push("run_environment");
    errors.push({ module: "08_run_environment", error: reResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  const totalSheets = 5;
  const overallStatus =
    failed.length === 0
      ? "success"
      : failed.length === totalSheets
        ? "failure"
        : "partial_failure";

  logger.info({ overallStatus, failed }, "MODULE_08: Feed write complete");

  return {
    status: overallStatus,
    write_timestamp_utc: new Date().toISOString(),
    workbook_id: workbookId,
    sheets_written: {
      daily_matchups: dmResult,
      today_lineups: tlResult,
      team_form_input: tfResult,
      bullpen_usage_daily: buResult,
      run_environment: reResult,
    },
    errors,
  };
}
