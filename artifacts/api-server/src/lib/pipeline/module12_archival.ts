/**
 * Module 12: Run Logging & Archival
 * Creates an immutable Run Bundle folder on Google Drive.
 * Archives: manifests, normalized slate, validation report, extraction results, run log.
 */

import { createDriveFolder, uploadDriveFile } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { Module08Result } from "./module08_feedWriter.js";
import type { Module09Result } from "./module09_recalculation.js";
import type { Module10Result } from "./module10_slateInput.js";
import type { Module11Result } from "./module11_outputExtraction.js";
import type { PipelineSlateResult } from "./runner.js";

// Frostline root Google Drive folder ID (Run_Bundles sub-folder expected to exist here)
const DRIVE_ROOT_FOLDER_ID = "root"; // Set to actual folder ID if you have one

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
    normalized_slate?: ArchivedFile;
    validation_report?: ArchivedFile;
    module_08_results?: ArchivedFile;
    module_09_results?: ArchivedFile;
    module_10_results?: ArchivedFile;
    slate_board_extraction?: ArchivedFile;
    runlog?: ArchivedFile;
    readme?: ArchivedFile;
  };
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

function jsonFile(name: string, data: unknown): { name: string; content: string } {
  return { name, content: JSON.stringify(data, null, 2) };
}

async function archiveFile(
  file: { name: string; content: string },
  parentFolderId: string,
): Promise<ArchivedFile> {
  const result = await uploadDriveFile(file.name, file.content, "application/json", parentFolderId);
  return { name: file.name, size: file.content.length, drive_id: result.id };
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

  logger.info({ bundleName }, "MODULE_12: Archiving run bundle to Google Drive");

  const output: Module12Result = {
    status: "success",
    archival_timestamp_utc: new Date().toISOString(),
    bundle_name: bundleName,
    bundle_folder_id: "",
    files_archived: {},
    errors: [],
  };

  let folderId = "";
  try {
    const folder = await createDriveFolder(bundleName, DRIVE_ROOT_FOLDER_ID);
    folderId = folder.id;
    output.bundle_folder_id = folderId;
    logger.info({ folderId, bundleName }, "MODULE_12: Bundle folder created");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_12: Could not create Drive folder");
    output.status = "failure";
    output.errors.push({ module: "12_archival", error: `Create folder failed: ${message}`, timestamp: new Date().toISOString() });
    return output;
  }

  // Files to archive
  const dateStamp = dateStr.replace(/-/g, "");
  const vSuffix = `${dateStamp}.v${String(versionNumber).padStart(2, "0")}`;

  const filesToArchive = [
    jsonFile(`normalized_slate.${vSuffix}.json`, { games: slate.games, total_games: slate.total_games }),
    jsonFile(`validation_report.${vSuffix}.json`, slate.validation),
    jsonFile(`module_08_results.${vSuffix}.json`, mod08),
    jsonFile(`module_09_results.${vSuffix}.json`, mod09),
    jsonFile(`module_10_results.${vSuffix}.json`, mod10),
    jsonFile(`slate_board_extraction.${vSuffix}.json`, { slate_board: mod11.slate_board, active_board: mod11.active_board_snapshot }),
    jsonFile(`runlog.${vSuffix}.json`, {
      bundle_name: bundleName,
      run_timestamp: slate.run_timestamp,
      archival_timestamp: output.archival_timestamp_utc,
      date: dateStr,
      total_games: slate.total_games,
      validation_status: slate.validation.status,
      module_statuses: slate.module_statuses,
      sheets_written: mod08.sheets_written,
      recalculation_status: mod09.status,
      seeding_status: mod10.status,
      extraction_status: mod11.status,
      core_count: mod11.core_count,
      not_core_count: mod11.not_core_count,
    }),
    jsonFile(`README.${vSuffix}.json`, {
      bundle: bundleName,
      description: `Frostline run bundle for ${dateStr}. Contains normalized slate, validation, Sheets write results, and decision board extractions.`,
      modules: ["01_mlb_statsapi", "02_statcast", "03_pitcher_classification", "04_open_meteo", "05_fangraphs", "06_normalization", "07_validation", "08_feed_writer", "09_recalculation", "10_slate_input", "11_output_extraction", "12_archival"],
      created_at: output.archival_timestamp_utc,
    }),
  ];

  const keys: (keyof Module12Result["files_archived"])[] = [
    "normalized_slate", "validation_report", "module_08_results",
    "module_09_results", "module_10_results", "slate_board_extraction",
    "runlog", "readme",
  ];

  let successCount = 0;
  for (let i = 0; i < filesToArchive.length; i++) {
    const file = filesToArchive[i];
    const key = keys[i];
    try {
      const archived = await archiveFile(file, folderId);
      output.files_archived[key] = archived;
      successCount++;
      logger.info({ name: file.name, size: archived.size }, "MODULE_12: File archived");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ file: file.name, err: message }, "MODULE_12: File archive failed");
      output.errors.push({ module: "12_archival", error: `Upload ${file.name}: ${message}`, timestamp: new Date().toISOString() });
    }
  }

  output.status =
    successCount === filesToArchive.length
      ? "success"
      : successCount === 0
        ? "failure"
        : "partial_failure";

  logger.info({ successCount, total: filesToArchive.length, status: output.status }, "MODULE_12: Archival complete");
  return output;
}
