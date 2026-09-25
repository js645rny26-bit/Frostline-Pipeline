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
/** Bound raw append payloads while keeping write count independent of source count. */
export const RAW_SNAPSHOT_ROWS_PER_APPEND = 50;

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

export interface SourceSnapshotPersistenceDependencies {
  ensureSheets(workbookId: string): Promise<void>;
  readStoredMetadata(workbookId: string): Promise<unknown[][]>;
  appendRawRows(workbookId: string, rows: unknown[][]): Promise<void>;
  appendMetadataRows(workbookId: string, rows: unknown[][]): Promise<void>;
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

function metadataRow(snapshot: MaterializedSourceSnapshot): unknown[] {
  return [
    snapshot.snapshot_id, snapshot.canonical_source_id, snapshot.request_url,
    snapshot.fetch_timestamp_utc, snapshot.data_through_date,
    snapshot.raw_response_sha256, snapshot.raw_response_bytes, snapshot.row_count,
    snapshot.expected_columns.join(","), snapshot.observed_columns.join(","),
    snapshot.mlbam_coverage, snapshot.parser_version, snapshot.source_status,
    snapshot.fallback_used, "STORED", snapshot.notes,
  ];
}

function snapshotMetadataKey(snapshot: MaterializedSourceSnapshot): string {
  return JSON.stringify([
    snapshot.canonical_source_id,
    snapshot.data_through_date,
    snapshot.raw_response_sha256,
    snapshot.parser_version,
    snapshot.source_status,
    snapshot.fallback_used,
    snapshot.notes,
  ]);
}

const defaultPersistenceDependencies: SourceSnapshotPersistenceDependencies = {
  async ensureSheets(workbookId) {
    await Promise.all([
      ensureSheet(workbookId, SOURCE_ACQUISITION_LOG_SHEET, SOURCE_ACQUISITION_LOG_HEADERS),
      ensureSheet(workbookId, SOURCE_RAW_SNAPSHOT_SHEET, SOURCE_RAW_SNAPSHOT_HEADERS),
    ]);
  },
  async readStoredMetadata(workbookId) {
    return (await readRange(workbookId, `${SOURCE_ACQUISITION_LOG_SHEET}!A2:P5000`)).values ?? [];
  },
  async appendRawRows(workbookId, rows) {
    await appendRange(workbookId, `${SOURCE_RAW_SNAPSHOT_SHEET}!A:D`, rows);
  },
  async appendMetadataRows(workbookId, rows) {
    await appendRange(workbookId, `${SOURCE_ACQUISITION_LOG_SHEET}!A:P`, rows);
  },
};

/**
 * Persists a slate's source responses with one sheet-preparation pass and one
 * acquisition-log read. This prevents per-source metadata reads from
 * exhausting the Google Sheets per-user read quota on full MLB slates.
 */
export async function persistSourceSnapshots(
  sources: readonly SourceSnapshot[],
  workbookId = WORKBOOK_ID,
  dependencies: SourceSnapshotPersistenceDependencies = defaultPersistenceDependencies,
): Promise<SourceSnapshotWriteResult[]> {
  const snapshots = sources.map(materializeSourceSnapshot);
  const results = snapshots.map<SourceSnapshotWriteResult>((snapshot) => ({
    status: "success",
    snapshot_id: snapshot.snapshot_id,
    metadata_written: false,
    raw_chunks_written: 0,
    errors: [],
  }));
  if (snapshots.length === 0) return results;

  let storedRows: unknown[][];
  try {
    await dependencies.ensureSheets(workbookId);
    storedRows = await dependencies.readStoredMetadata(workbookId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const result of results) {
      result.status = "failure";
      result.errors.push(message);
    }
    logger.warn({ sources: sources.length, error: message }, "SOURCE_ACQUISITION: batch preparation failed");
    return results;
  }

  const planned = new Map<string, { snapshot: MaterializedSourceSnapshot; resultIndexes: number[] }>();
  snapshots.forEach((snapshot, index) => {
    if (storedRows.some((row) => sourceSnapshotMetadataMatchesStoredRow(snapshot, row))) return;
    const key = snapshotMetadataKey(snapshot);
    const existing = planned.get(key);
    if (existing) existing.resultIndexes.push(index);
    else planned.set(key, { snapshot, resultIndexes: [index] });
  });
  if (planned.size === 0) return results;

  const rawRows: Array<{ row: unknown[]; resultIndexes: number[] }> = [];
  for (const entry of planned.values()) {
    const chunks = splitRawSnapshot(entry.snapshot.raw_response);
    chunks.forEach((chunk, index) => {
      rawRows.push({
        row: [entry.snapshot.snapshot_id, index + 1, chunks.length, chunk],
        resultIndexes: entry.resultIndexes,
      });
    });
  }

  try {
    for (let offset = 0; offset < rawRows.length; offset += RAW_SNAPSHOT_ROWS_PER_APPEND) {
      const batch = rawRows.slice(offset, offset + RAW_SNAPSHOT_ROWS_PER_APPEND);
      await dependencies.appendRawRows(workbookId, batch.map((item) => item.row));
      for (const item of batch) {
        for (const index of item.resultIndexes) results[index].raw_chunks_written += 1;
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of planned.values()) {
      for (const index of entry.resultIndexes) {
        results[index].status = results[index].raw_chunks_written > 0 ? "partial" : "failure";
        results[index].errors.push(message);
      }
    }
    logger.warn({ sources: planned.size, error: message }, "SOURCE_ACQUISITION: batched raw retention failed");
    return results;
  }

  try {
    await dependencies.appendMetadataRows(
      workbookId,
      Array.from(planned.values(), (entry) => metadataRow(entry.snapshot)),
    );
    for (const entry of planned.values()) {
      for (const index of entry.resultIndexes) results[index].metadata_written = true;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of planned.values()) {
      for (const index of entry.resultIndexes) {
        results[index].status = results[index].raw_chunks_written > 0 ? "partial" : "failure";
        results[index].errors.push(message);
      }
    }
    logger.warn({ sources: planned.size, error: message }, "SOURCE_ACQUISITION: batched metadata retention failed");
  }
  return results;
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
  return (await persistSourceSnapshots([source], workbookId))[0];
}
