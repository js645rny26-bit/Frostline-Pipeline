/**
 * Source-acquisition provenance and immutable raw-response retention.
 *
 * A source is not usable merely because a fetch returned HTTP 200. Every
 * active or candidate baseball source records the exact request, response
 * hash, parser contract, coverage, and a chunked copy of the untouched
 * response before any feature engineering. The raw sheet is append-only and
 * is never a projection input.
 */

import { createHash } from "node:crypto";
import {
  addSheet,
  appendRange,
  expandSheetColumns,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

export const SOURCE_ACQUISITION_LOG_SHEET = "SOURCE_ACQUISITION_LOG";
export const SOURCE_RAW_SNAPSHOT_SHEET = "SOURCE_RAW_SNAPSHOT";

export const SOURCE_ACQUISITION_LOG_HEADERS = [
  "Snapshot_ID", "Canonical_Source_ID", "Request_URL", "Fetch_TS_UTC",
  "Data_Through_Date", "Raw_Response_SHA256", "Raw_Response_Bytes", "Row_Count",
  "Expected_Columns", "Observed_Columns", "MLBAM_Coverage", "Parser_Version",
  "Source_Status", "Fallback_Used", "Raw_Storage_Status", "Notes",
] as const;

export const SOURCE_RAW_SNAPSHOT_HEADERS = [
  "Snapshot_ID", "Chunk_Index", "Chunk_Count", "Raw_Response_Chunk",
] as const;

/** Stay below the Google Sheets per-cell character limit with headroom. */
export const RAW_SNAPSHOT_CHUNK_CHARS = 30_000;

export type SourceAvailability = "CURRENT" | "PARTIAL" | "UNAVAILABLE" | "SCHEMA_DRIFT";

export interface SourceSnapshot {
  canonical_source_id: string;
  request_url: string;
  fetch_timestamp_utc: string;
  /** Source-proven evidence horizon; blank when the source cannot establish it. */
  data_through_date: string;
  raw_response: string;
  row_count: number;
  expected_columns: string[];
  observed_columns: string[];
  mlbam_coverage: number;
  parser_version: string;
  source_status: SourceAvailability;
  fallback_used: string;
  notes: string;
}

export interface MaterializedSourceSnapshot extends SourceSnapshot {
  snapshot_id: string;
  raw_response_sha256: string;
  raw_response_bytes: number;
}

export interface SourceSnapshotWriteResult {
  status: "success" | "partial" | "failure";
  snapshot_id: string;
  metadata_written: boolean;
  raw_chunks_written: number;
  errors: string[];
}

export function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function materializeSourceSnapshot(snapshot: SourceSnapshot): MaterializedSourceSnapshot {
  // Preserve the response exactly as received, including a possible UTF-8 BOM.
  // Parsers may normalize a copy, but source provenance must remain byte-faithful.
  const raw = snapshot.raw_response;
  const digest = sha256(raw);
  return {
    ...snapshot,
    raw_response: raw,
    raw_response_sha256: digest,
    raw_response_bytes: Buffer.byteLength(raw, "utf8"),
    snapshot_id: `${snapshot.canonical_source_id}:${snapshot.fetch_timestamp_utc}:${digest.slice(0, 16)}`,
  };
}

export function splitRawSnapshot(raw: string): string[] {
  if (!raw) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < raw.length; offset += RAW_SNAPSHOT_CHUNK_CHARS) {
    chunks.push(raw.slice(offset, offset + RAW_SNAPSHOT_CHUNK_CHARS));
  }
  return chunks;
}

async function ensureSheet(workbookId: string, sheet: string, headers: readonly string[]): Promise<void> {
  try {
    const existing = await readRange(workbookId, `${sheet}!A1:AZ1`);
    const row = (existing.values?.[0] ?? []).map((value) => String(value ?? "").trim());
    if (!headers.every((header, index) => row[index] === header)) {
      await writeRange(workbookId, `${sheet}!A1`, [Array.from(headers)]);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("400") && !message.includes("Unable to parse range")) throw error;
    await addSheet(workbookId, sheet);
    await writeRange(workbookId, `${sheet}!A1`, [Array.from(headers)]);
  }
  await expandSheetColumns(workbookId, sheet, headers.length);
}

export function sourceSnapshotMetadataMatchesStoredRow(
  snapshot: MaterializedSourceSnapshot,
  row: readonly unknown[],
): boolean {
  return String(row[1] ?? "") === snapshot.canonical_source_id &&
    String(row[4] ?? "") === snapshot.data_through_date &&
    String(row[5] ?? "") === snapshot.raw_response_sha256 &&
    String(row[11] ?? "") === snapshot.parser_version &&
    String(row[12] ?? "") === snapshot.source_status &&
    String(row[13] ?? "") === snapshot.fallback_used &&
    String(row[15] ?? "") === snapshot.notes;
}

async function alreadyStored(workbookId: string, snapshot: MaterializedSourceSnapshot): Promise<boolean> {
  const raw = (await readRange(workbookId, `${SOURCE_ACQUISITION_LOG_SHEET}!A2:P5000`)).values ?? [];
  // Identical bytes may be reacquired under materially different cutoff or
  // availability evidence. Deduplicate only when both bytes and governing
  // metadata match; otherwise append the new acquisition state.
  return raw.some((row) => sourceSnapshotMetadataMatchesStoredRow(snapshot, row));
}

/**
 * Persists metadata and the untouched response before feature engineering.
 * Identical raw hashes are deliberately deduplicated: a new copy would add no
 * replay value, while the run log retains each fetch event.
 */
export async function persistSourceSnapshot(
  source: SourceSnapshot,
  workbookId = WORKBOOK_ID,
): Promise<SourceSnapshotWriteResult> {
  const snapshot = materializeSourceSnapshot(source);
  const result: SourceSnapshotWriteResult = {
    status: "success", snapshot_id: snapshot.snapshot_id, metadata_written: false,
    raw_chunks_written: 0, errors: [],
  };
  try {
    await Promise.all([
      ensureSheet(workbookId, SOURCE_ACQUISITION_LOG_SHEET, SOURCE_ACQUISITION_LOG_HEADERS),
      ensureSheet(workbookId, SOURCE_RAW_SNAPSHOT_SHEET, SOURCE_RAW_SNAPSHOT_HEADERS),
    ]);
    if (await alreadyStored(workbookId, snapshot)) return result;

    const chunks = splitRawSnapshot(snapshot.raw_response);
    // Retain source bytes before declaring the metadata record stored.  A
    // source whose raw response could not be retained is an evidence gap,
    // never an apparently complete source-log entry.
    if (chunks.length > 0) {
      await appendRange(
        workbookId,
        `${SOURCE_RAW_SNAPSHOT_SHEET}!A:D`,
        chunks.map((chunk, index) => [snapshot.snapshot_id, index + 1, chunks.length, chunk]),
      );
      result.raw_chunks_written = chunks.length;
    }
    await appendRange(workbookId, `${SOURCE_ACQUISITION_LOG_SHEET}!A:P`, [[
      snapshot.snapshot_id, snapshot.canonical_source_id, snapshot.request_url,
      snapshot.fetch_timestamp_utc, snapshot.data_through_date,
      snapshot.raw_response_sha256, snapshot.raw_response_bytes, snapshot.row_count,
      snapshot.expected_columns.join(","), snapshot.observed_columns.join(","),
      snapshot.mlbam_coverage, snapshot.parser_version, snapshot.source_status,
      snapshot.fallback_used, "STORED", snapshot.notes,
    ]]);
    result.metadata_written = true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    result.status = result.metadata_written ? "partial" : "failure";
    logger.warn({ source: source.canonical_source_id, snapshot_id: snapshot.snapshot_id, error: message }, "SOURCE_ACQUISITION: source retention failed");
  }
  return result;
}
