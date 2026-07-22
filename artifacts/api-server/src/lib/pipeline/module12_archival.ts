/**
 * Module 12: Run Logging & Archival
 * Appends one row to the RUN_LOG sheet in the workbook for every pipeline run.
 * Replaces the original Google Drive folder approach — the google-sheet connector
 * only proxies Sheets v4 paths, not Drive v3.
 */

import { writeRange, readRange, appendRange, addSheet, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { Module08Result } from "./module08_feedWriter.js";
import type { Module09Result } from "./module09_recalculation.js";
import type { Module10Result } from "./module10_slateInput.js";
import type { Module11Result } from "./module11_outputExtraction.js";
import type { PipelineSlateResult } from "./runner.js";

const RUN_LOG_SHEET = "RUN_LOG";

const RUN_LOG_HEADERS = [
  "Run_Timestamp",
  "Date",
  "Bundle_Name",
  "Pipeline_Status",
  "Total_Games",
  "Validation_Status",
  "Critical_Failures",
  "Warnings",
  "Pitchers_Resolved",
  "Pitchers_Total",
  "Weather_Live",
  "Weather_Fallback",
  "M08_Status",
  "M08_Rows_DailyMatchups",
  "M08_Rows_TodayLineups",
  "M08_Rows_TeamForm",
  "M08_Rows_Bullpen",
  "M08_Rows_RunEnv",
  "M09_Status",
  "M09_IntegrationRows",
  "M09_SummaryRows",
  "M10_Status",
  "M10_NewGames",
  "M10_UpdatedGames",
  "M11_Status",
  "M11_CoreCount",
  "M11_NotCoreCount",
  "M11_SlateBoardRows",
  "Errors",
];

export interface ArchivedFile {
  name: string;
  size: number;
  drive_id?: string;
}

export interface Module12Result {
  status: "success" | "partial_failure" | "failure";
  archival_timestamp_utc: string;
  bundle_name: string;
  bundle_folder_id: string;
  files_archived: {
    run_log_row?: ArchivedFile;
  };
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

async function ensureHeaders(): Promise<void> {
  // Try to read cell A1. If it fails with "Unable to parse range", the sheet
  // tab doesn't exist yet — create it, then write headers.
  let sheetExists = true;
  try {
    const existing = await readRange(WORKBOOK_ID, `${RUN_LOG_SHEET}!A1:A1`);
    const hasHeader =
      existing.values &&
      existing.values[0] &&
      String(existing.values[0][0]).trim() === "Run_Timestamp";

    if (!hasHeader) {
      await writeRange(WORKBOOK_ID, `${RUN_LOG_SHEET}!A1`, [RUN_LOG_HEADERS]);
      logger.info("MODULE_12: RUN_LOG headers written");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Unable to parse range") || msg.includes("400")) {
      sheetExists = false;
    } else {
      throw err; // unexpected error — surface it
    }
  }

  if (!sheetExists) {
    logger.info("MODULE_12: RUN_LOG sheet not found — creating it");
    await addSheet(WORKBOOK_ID, RUN_LOG_SHEET);
    await writeRange(WORKBOOK_ID, `${RUN_LOG_SHEET}!A1`, [RUN_LOG_HEADERS]);
    logger.info("MODULE_12: RUN_LOG sheet created with headers");
  }
}

export async function archiveRunBundle(
  slate: PipelineSlateResult,
  mod08: Module08Result,
  mod09: Module09Result,
  mod10: Module10Result,
  mod11: Module11Result,
  versionNumber = 1,
): Promise<Module12Result> {
  const dateStr = slate.date;
  const bundleName = `${dateStr}_v${String(versionNumber).padStart(2, "0")}`;
  const archivalTimestamp = new Date().toISOString();

  logger.info({ bundleName }, "MODULE_12: Archiving run bundle to RUN_LOG sheet");

  const output: Module12Result = {
    status: "success",
    archival_timestamp_utc: archivalTimestamp,
    bundle_name: bundleName,
    bundle_folder_id: WORKBOOK_ID, // workbook is the "folder" now
    files_archived: {},
    errors: [],
  };

  // Derive counts from upstream results
  const pitchersTotal = slate.games.length * 2;
  const pitchersResolved = slate.games
    .flatMap((g) => [
      (g as { away_pitcher?: { role?: string } }).away_pitcher,
      (g as { home_pitcher?: { role?: string } }).home_pitcher,
    ])
    .filter((p) => p?.role && p.role !== "UNRESOLVED").length;

  const weatherLive = slate.games.filter(
    (g) => (g as { environment?: { data_quality?: string } }).environment?.data_quality === "good",
  ).length;
  const weatherFallback = slate.games.length - weatherLive;

  const sw = mod08.sheets_written;
  const errorsJson = JSON.stringify(
    output.errors.length > 0 ? output.errors : [],
  );

  const row = [
    archivalTimestamp,                                   // Run_Timestamp
    dateStr,                                             // Date
    bundleName,                                          // Bundle_Name
    "partial_success",                                   // Pipeline_Status (overwritten by caller if needed)
    slate.total_games,                                   // Total_Games
    slate.validation.status,                             // Validation_Status
    slate.validation.critical_failures.length,           // Critical_Failures
    slate.validation.warnings.length,                    // Warnings
    pitchersResolved,                                    // Pitchers_Resolved
    pitchersTotal,                                       // Pitchers_Total
    weatherLive,                                         // Weather_Live
    weatherFallback,                                     // Weather_Fallback
    mod08.status,                                        // M08_Status
    sw.daily_matchups?.rows_written ?? 0,                // M08_Rows_DailyMatchups
    sw.today_lineups?.rows_written ?? 0,                 // M08_Rows_TodayLineups
    sw.team_form_input?.rows_written ?? 0,               // M08_Rows_TeamForm
    sw.bullpen_usage_daily?.rows_written ?? 0,           // M08_Rows_Bullpen
    sw.run_environment?.rows_written ?? 0,               // M08_Rows_RunEnv
    mod09.status,                                        // M09_Status
    mod09.checks.game_integration?.actual_rows ?? 0,     // M09_IntegrationRows
    mod09.checks.game_summary?.actual_rows ?? 0,         // M09_SummaryRows
    mod10.status,                                        // M10_Status
    mod10.games_seeded.new_games,                        // M10_NewGames
    mod10.games_seeded.updated_games,                    // M10_UpdatedGames
    mod11.status,                                        // M11_Status
    mod11.core_count,                                    // M11_CoreCount
    mod11.not_core_count,                                // M11_NotCoreCount
    mod11.slate_board.length,                            // M11_SlateBoardRows
    errorsJson,                                          // Errors
  ];

  try {
    await ensureHeaders();
    await appendRange(WORKBOOK_ID, `${RUN_LOG_SHEET}!A:A`, [row]);

    const rowContent = row.join(",");
    output.files_archived.run_log_row = {
      name: `RUN_LOG row — ${bundleName}`,
      size: rowContent.length,
    };

    logger.info({ bundleName, sheet: RUN_LOG_SHEET }, "MODULE_12: Run log row appended");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_12: Failed to append run log row");
    output.status = "failure";
    output.errors.push({
      module: "12_archival",
      error: `RUN_LOG append failed: ${message}`,
      timestamp: new Date().toISOString(),
    });
  }

  return output;
}
