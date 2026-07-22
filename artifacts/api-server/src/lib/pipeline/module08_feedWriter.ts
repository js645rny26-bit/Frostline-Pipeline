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

function buildDailyMatchupsRows(games: NormalizedGame[]): unknown[][] {
  return games.map((g) => [
    g.date,                                  // A: date
    g.legacy_game_id,                        // B: legacy_game_id
    g.away_team.team_abbr ?? "",             // C: away_team_abbr
    g.home_team.team_abbr ?? "",             // D: home_team_abbr
    g.away_pitcher.name ?? "",               // E: away_pitcher_name
    null,                                    // F: [formula] skip
    g.away_pitcher.hand ?? "",               // G: away_pitcher_hand
    g.away_pitcher.role ?? "UNRESOLVED",     // H: away_pitcher_role
    g.away_pitcher.role_confidence === "high", // I: away_role_confirmed
    g.away_pitcher.expected_pitches ?? "",   // J: away_expected_pitches
    g.away_pitcher.expected_innings ?? "",   // K: away_expected_innings
    g.home_pitcher.name ?? "",               // L: home_pitcher_name
    null,                                    // M: [formula] skip
    g.home_pitcher.hand ?? "",               // N: home_pitcher_hand
    g.home_pitcher.role ?? "UNRESOLVED",     // O: home_pitcher_role
    g.home_pitcher.role_confidence === "high", // P: home_role_confirmed
    g.home_pitcher.expected_pitches ?? "",   // Q: home_expected_pitches
    g.home_pitcher.expected_innings ?? "",   // R: home_expected_innings
    g.venue.name ?? "",                      // S: park
    buildWeatherTag(g),                      // T: weather_tag
    "",                                      // U: umpire_tag
    "",                                      // V: context_tag
    1,                                       // W: context_multiplier
    false,                                   // X: weather_ump_clear
    null,                                    // Y: market_total
    g.game_status.codedGameState ?? "",      // Z: game_status
    "statsapi",                              // AA: source
    "valid",                                 // AB: data_status
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

function buildTodayLineupsRows(games: NormalizedGame[]): unknown[][] {
  // We don't have confirmed lineup data — write projected slots (9 batters × 2 teams per game)
  const rows: unknown[][] = [];
  const today = games[0]?.date ?? new Date().toISOString().split("T")[0];

  for (const g of games) {
    for (const side of ["A", "H"] as const) {
      const team = side === "A" ? g.away_team : g.home_team;
      const opponent = side === "A" ? g.home_team : g.away_team;
      const starterHand = side === "A"
        ? (g.home_pitcher.hand ?? "R")   // away batters face home starter
        : (g.away_pitcher.hand ?? "R");  // home batters face away starter

      for (let order = 1; order <= 9; order++) {
        rows.push([
          today,                           // A: date
          g.legacy_game_id,               // B: legacy_game_id
          team.team_abbr ?? "",           // C: team_abbr
          opponent.team_abbr ?? "",       // D: opponent_abbr
          side === "A" ? "A" : "H",       // E: home_away
          "projected",                    // F: lineup_status
          "",                             // G: confirmed_time
          order,                          // H: batting_order
          "",                             // I: player_name (unknown — not yet sourced)
          null,                           // J: [formula] player_id
          "",                             // K: bats
          "",                             // L: position
          starterHand,                    // M: starter_hand_faced
          "",                             // N: pinch_hit_risk
          "",                             // O: injury_note
          "pipeline",                     // P: source
          "",                             // Q: operator_note
        ]);
      }
    }
  }
  return rows;
}

function buildTeamFormRows(splits: FangraphsResult["teams"]): unknown[][] {
  return splits.map((s) => [
    s.team,                   // A: team_abbr
    s.split,                  // B: split (vs_RHP / vs_LHP)
    null,                     // C: [formula] season_wrc_plus
    s.l30_wrc_plus,           // D: l30_wrc_plus
    s.l30_k_pct,              // E: l30_k_pct
    null,                     // F: [formula] season_k_pct
    s.l14_wrc_plus,           // G: l14_wrc_plus
    s.l14_k_pct,              // H: l14_k_pct
    null,                     // I: [formula] season_bb_pct
    s.l30_bb_pct,             // J: l30_bb_pct
    s.l14_bb_pct,             // K: l14_bb_pct
    null,                     // L: [formula] season_iso
    s.l30_iso,                // M: l30_iso
    s.l14_iso,                // N: l14_iso
    "fangraphs",              // O: source
    new Date().toISOString().split("T")[0], // P: refresh_date
  ]);
}

function buildBullpenDateHeaders(date: string): unknown[] {
  // Generate 6-day window headers ending on date
  const headers: string[] = [];
  const end = new Date(date);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    headers.push(d.toISOString().split("T")[0]);
  }
  return headers; // D1:I1 — 6 values
}

function buildRunEnvironmentRows(games: NormalizedGame[]): unknown[][] {
  return games.map((g) => {
    const e = g.environment;
    const wind = `${compassDirection(e.wind_direction_degrees)} ${e.wind_speed_mph ?? "?"}mph`;
    const scheduledLocal = g.scheduled_utc_time
      ? new Date(g.scheduled_utc_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      : "";

    return [
      g.date,                              // A: date
      scheduledLocal,                      // B: time_local
      g.venue.name ?? "",                  // C: park
      g.away_team.team_abbr ?? "",         // D: away_abbr
      g.home_team.team_abbr ?? "",         // E: home_abbr
      "Open",                              // F: roof (default)
      e.temperature_f ?? "",               // G: temperature_f
      wind,                                // H: wind
      e.humidity_pct ?? "",                // I: humidity_pct
      e.precipitation_probability_pct ?? "", // J: rain_probability_pct
      1.0,                                 // K: park_run_factor (stub)
      1.0,                                 // L: park_hr_factor (stub)
      0.330,                               // M: park_woba (stub)
      "",                                  // N: umpire_name
      buildWeatherTag(g),                  // O: environment_tag
      e.data_quality === "fallback" ? "Fallback weather data" : "Live Open-Meteo", // P: weather_note
      "projected",                         // Q: lineup_status
      // R: operator truth_note — DO NOT WRITE (preserve)
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

  // 1. DAILY_MATCHUPS
  const dmRows = buildDailyMatchupsRows(normalized.games);
  const dmResult = await safeWrite(
    "DAILY_MATCHUPS",
    "DAILY_MATCHUPS!A3:AB32",
    `DAILY_MATCHUPS!A3:AB${2 + Math.max(dmRows.length, 1)}`,
    dmRows,
    workbookId,
  );
  if (dmResult.status === "failure") {
    failed.push("daily_matchups");
    errors.push({ module: "08_daily_matchups", error: dmResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 2. TODAY_LINEUPS
  const tlRows = buildTodayLineupsRows(normalized.games);
  const tlResult = await safeWrite(
    "TODAY_LINEUPS",
    "TODAY_LINEUPS!A3:Q602",
    `TODAY_LINEUPS!A3:Q${2 + Math.max(tlRows.length, 1)}`,
    tlRows,
    workbookId,
  );
  if (tlResult.status === "failure") {
    failed.push("today_lineups");
    errors.push({ module: "08_today_lineups", error: tlResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 3. TEAM_FORM_INPUT (always 60 rows — 30 teams × 2 splits)
  const tfRows = buildTeamFormRows(splits.teams);
  const tfResult = await safeWrite(
    "TEAM_FORM_INPUT",
    "TEAM_FORM_INPUT!A3:P62",
    "TEAM_FORM_INPUT!A3:P62",
    tfRows,
    workbookId,
  );
  if (tfResult.status === "failure") {
    failed.push("team_form_input");
    errors.push({ module: "08_team_form_input", error: tfResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 4. BULLPEN_USAGE_DAILY — date headers first, then no player rows (no per-day data yet)
  let buResult: SheetWriteStatus = { status: "skipped", rows_written: 0, range: "BULLPEN_USAGE_DAILY!D1:I1" };
  try {
    const dateHeaders = buildBullpenDateHeaders(runDate);
    await clearRange(workbookId, "BULLPEN_USAGE_DAILY!A2:L300");
    await clearRange(workbookId, "BULLPEN_USAGE_DAILY!O2:U31");
    await writeRange(workbookId, "BULLPEN_USAGE_DAILY!D1:I1", [dateHeaders]);
    // No per-player workload rows to write in this version (data source TBD)
    buResult = { status: "success", rows_written: 0, range: "BULLPEN_USAGE_DAILY!D1:I1" };
    logger.info("MODULE_08: BULLPEN_USAGE_DAILY date headers written");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failed.push("bullpen_usage_daily");
    errors.push({ module: "08_bullpen_usage_daily", error: message, timestamp: new Date().toISOString() });
    buResult = { status: "failure", rows_written: 0, range: "BULLPEN_USAGE_DAILY!D1:I1", error: message };
  }

  // 5. RUN_ENVIRONMENT
  const reRows = buildRunEnvironmentRows(normalized.games);
  const reResult = await safeWrite(
    "RUN_ENVIRONMENT",
    "RUN_ENVIRONMENT!A2:Q31",
    `RUN_ENVIRONMENT!A2:Q${1 + Math.max(reRows.length, 1)}`,
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
