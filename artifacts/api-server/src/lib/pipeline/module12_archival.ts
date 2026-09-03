/**
 * Module 12: Run Logging & Archival
 * Appends one row to the RUN_LOG sheet in the workbook for every pipeline run.
 * Replaces the original Google Drive folder approach — the google-sheet connector
 * only proxies Sheets v4 paths, not Drive v3.
 */

import { writeRange, readRange, appendRange, addSheet, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";
import { logger } from "../../lib/logger.js";
import type { Module08Result } from "./module08_feedWriter.js";
import type { Module09Result } from "./module09_recalculation.js";
import type { Module10Result } from "./module10_slateInput.js";
import type { Module11Result } from "./module11_outputExtraction.js";
import type { PipelineSlateResult } from "./runner.js";
import type { StatcastPreviewResult } from "./module02e_statcastPreview.js";

const RUN_LOG_SHEET = "RUN_LOG";

// Exported so schema-validation tests can assert exact alignment with workbookSchema.
export const RUN_LOG_HEADERS = [
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
  "Schema_Version",
  "Statcast_Preview_Status",
  "Statcast_Preview_Games_Expected",
  "Statcast_Preview_Games_Available",
  "Statcast_Preview_Games_Parsed",
  "Statcast_Preview_Games_Missing",
  "Statcast_Preview_Games_Failed",
  "Statcast_Preview_Stale_Count",
  "Statcast_Preview_Identity_Mismatch_Count",
  // Publication scope is deliberately separate from the full MLB schedule
  // count above. A staggered-slate run may legitimately write only the games
  // that remain pregame; reporting it as a full 15-game board is misleading.
  "Mutable_Games_At_Start",
  "Protected_Games_At_Start",
  "Feed_Writable_Games",
  "Projection_Writable_Games",
  "Audit_Gap_Games",
  "Publication_Scope",
  // P0 observability fields. Counts without the corresponding immutable
  // detail records are an integrity failure, not a successful run log.
  "Critical_Failure_Details",
  "Warning_Details",
  "Module_Error_Details",
  "Run_Log_Integrity_Status",
] as const;

/**
 * Exact prospective scope observed by the runner. These are observability
 * facts, not another authorization layer. They let RUN_LOG say plainly when a
 * 15-game schedule produced a one-game pregame refresh.
 */
export interface PublicationScopeAudit {
  mutable_games_at_start: number;
  protected_games_at_start: number;
  feed_writable_games: number;
  projection_writable_games: number;
  audit_gap_games: number;
}

/**
 * Normalized issue record deliberately carries the absence of fallback/use
 * information as data.  Earlier runs recorded neither the issue nor whether
 * the pipeline could continue; P0 must never manufacture those facts.
 */
export interface RunLogIssueDetail {
  module: string;
  code: string;
  message: string;
  timestamp: string;
  fallback_state: "NOT_DECLARED" | "NO_FALLBACK" | "FALLBACK_AVAILABLE";
  usability_state: "BLOCKING" | "WARNING" | "DEGRADED";
}

export interface RunLogModuleIssue {
  module: string;
  error: string;
  timestamp: string;
}

/**
 * Keeps the P0 observability invariant independently testable. A future
 * caller that reports a count without serializing the corresponding detail
 * must make the record visibly invalid rather than returning a reassuring
 * successful run-log row.
 */
export function assessRunLogIntegrity(
  criticalFailureCount: number,
  warningCount: number,
  criticalDetails: readonly RunLogIssueDetail[],
  warningDetails: readonly RunLogIssueDetail[],
): "PASS" | "RUN_LOG_INTEGRITY_FAILURE" {
  return criticalDetails.length === criticalFailureCount && warningDetails.length === warningCount
    ? "PASS"
    : "RUN_LOG_INTEGRITY_FAILURE";
}

export function buildRunLogIssueDetails(
  criticalFailures: readonly string[],
  warnings: readonly string[],
  moduleIssues: readonly RunLogModuleIssue[],
  timestamp: string,
): {
  critical: RunLogIssueDetail[];
  warnings: RunLogIssueDetail[];
  moduleErrors: RunLogIssueDetail[];
  integrityStatus: "PASS" | "RUN_LOG_INTEGRITY_FAILURE";
} {
  const critical = criticalFailures.map((message) => ({
    module: "07_validation",
    code: "VALIDATION_CRITICAL_FAILURE",
    message,
    timestamp,
    fallback_state: "NO_FALLBACK" as const,
    usability_state: "BLOCKING" as const,
  }));
  const warningDetails = warnings.map((message) => ({
    module: "07_validation",
    code: "VALIDATION_WARNING",
    message,
    timestamp,
    fallback_state: "NOT_DECLARED" as const,
    usability_state: "WARNING" as const,
  }));
  const moduleErrors = moduleIssues.map((issue) => ({
    module: issue.module,
    code: "MODULE_ERROR",
    message: issue.error,
    timestamp: issue.timestamp || timestamp,
    fallback_state: "NOT_DECLARED" as const,
    usability_state: "DEGRADED" as const,
  }));
  const integrityStatus = assessRunLogIntegrity(
    criticalFailures.length,
    warnings.length,
    critical,
    warningDetails,
  );
  return { critical, warnings: warningDetails, moduleErrors, integrityStatus };
}

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

async function ensureHeaders(workbookId: string): Promise<void> {
  // Try to read the header row. If it fails with "Unable to parse range", the
  // sheet tab doesn't exist yet — create it, then write headers. If the row
  // exists but is outdated (wrong count OR any header out of position), rewrite
  // the full header row in place — data rows are unaffected.
  let sheetExists = true;
  try {
    const existing = await readRange(workbookId, `${RUN_LOG_SHEET}!A1:AZ1`);
    const headerRow = (existing.values?.[0] ?? []).map((c) => String(c ?? "").trim());
    // All 38 headers must match in order — count-and-last-only check can miss renames.
    const upToDate =
      headerRow.length >= RUN_LOG_HEADERS.length &&
      RUN_LOG_HEADERS.every((expected, idx) => headerRow[idx] === expected);

    if (!upToDate) {
      await writeRange(workbookId, `${RUN_LOG_SHEET}!A1`, [Array.from(RUN_LOG_HEADERS)]);
      logger.info("MODULE_12: RUN_LOG headers written/refreshed");
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
    await addSheet(workbookId, RUN_LOG_SHEET);
    await writeRange(workbookId, `${RUN_LOG_SHEET}!A1`, [Array.from(RUN_LOG_HEADERS)]);
    logger.info("MODULE_12: RUN_LOG sheet created with headers");
  }

  // Schema v27 appends scope fields beyond the legacy 38-column RUN_LOG.
  // Expand first so an old commissioning workbook never silently truncates
  // the scope record that explains a partial slate.
  await expandSheetColumns(workbookId, RUN_LOG_SHEET, RUN_LOG_HEADERS.length);
}

export async function archiveRunBundle(
  slate: PipelineSlateResult,
  mod08: Module08Result,
  mod09: Module09Result,
  mod10: Module10Result,
  mod11: Module11Result,
  pipelineStatus: "success" | "partial_success" | "failure" = "partial_success",
  versionNumber = 1,
  workbookId = WORKBOOK_ID,
  statcastPreview: StatcastPreviewResult | null = null,
  scope: PublicationScopeAudit | null = null,
  moduleIssues: readonly RunLogModuleIssue[] = [],
): Promise<Module12Result> {
  const dateStr = slate.date;
  const bundleName = `${dateStr}_v${String(versionNumber).padStart(2, "0")}`;
  const archivalTimestamp = new Date().toISOString();

  logger.info({ bundleName }, "MODULE_12: Archiving run bundle to RUN_LOG sheet");

  const output: Module12Result = {
    status: "success",
    archival_timestamp_utc: archivalTimestamp,
    bundle_name: bundleName,
    bundle_folder_id: workbookId,
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
  const issueDetails = buildRunLogIssueDetails(
    slate.validation.critical_failures,
    slate.validation.warnings,
    moduleIssues,
    archivalTimestamp,
  );
  // Retain Errors for backwards compatibility, but it now carries the
  // upstream module errors that the runner had actually observed rather than
  // the impossible-to-know result of this row's own future append failure.
  const errorsJson = JSON.stringify(issueDetails.moduleErrors);

  const row = [
    archivalTimestamp,                                   // Run_Timestamp
    dateStr,                                             // Date
    bundleName,                                          // Bundle_Name
    pipelineStatus,                                      // Pipeline_Status (computed by runner)
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
    mod11.no_core_count,                                 // M11_NoCoreCount
    mod11.slate_board.length,                            // M11_SlateBoardRows
    errorsJson,                                          // Errors
    WORKBOOK_SCHEMA_VERSION,                             // Schema_Version
    statcastPreview?.status ?? "skipped",                // Statcast_Preview_Status
    statcastPreview?.games_expected ?? 0,                // Statcast_Preview_Games_Expected
    statcastPreview?.games_available ?? 0,               // Statcast_Preview_Games_Available
    statcastPreview?.games_parsed ?? 0,                  // Statcast_Preview_Games_Parsed
    statcastPreview?.games_missing ?? 0,                 // Statcast_Preview_Games_Missing
    statcastPreview?.games_failed ?? 0,                  // Statcast_Preview_Games_Failed
    statcastPreview?.games.filter((g) => g.preview_availability === "STALE").length ?? 0, // Statcast_Preview_Stale_Count
    statcastPreview?.games_identity_mismatch ?? 0,       // Statcast_Preview_Identity_Mismatch_Count
    scope?.mutable_games_at_start ?? slate.total_games,   // Mutable_Games_At_Start
    scope?.protected_games_at_start ?? 0,                 // Protected_Games_At_Start
    scope?.feed_writable_games ?? slate.total_games,      // Feed_Writable_Games
    scope?.projection_writable_games ?? slate.total_games,// Projection_Writable_Games
    scope?.audit_gap_games ?? 0,                          // Audit_Gap_Games
    !scope || scope.projection_writable_games === slate.total_games
      ? "FULL_PREGAME_SCOPE"
      : scope.projection_writable_games > 0
        ? "PARTIAL_PREGAME_SCOPE"
        : "NO_PREGAME_SCOPE",                            // Publication_Scope
    JSON.stringify(issueDetails.critical),                // Critical_Failure_Details
    JSON.stringify(issueDetails.warnings),                // Warning_Details
    JSON.stringify(issueDetails.moduleErrors),            // Module_Error_Details
    issueDetails.integrityStatus,                          // Run_Log_Integrity_Status
  ];

  try {
    await ensureHeaders(workbookId);
    await appendRange(workbookId, `${RUN_LOG_SHEET}!A:A`, [row]);

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
