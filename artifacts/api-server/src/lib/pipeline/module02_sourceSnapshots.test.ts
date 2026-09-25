import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeSourceSnapshot,
  persistSourceSnapshots,
  RAW_SNAPSHOT_ROWS_PER_APPEND,
  type SourceSnapshot,
  type SourceSnapshotPersistenceDependencies,
} from "./module02_sourceSnapshots.js";

function source(index: number, raw = `<html>team-${index}</html>`): SourceSnapshot {
  return {
    canonical_source_id: `STARTING_NINE_TEAM_PAGE_${index}`,
    request_url: `https://example.test/team-${index}`,
    fetch_timestamp_utc: `2026-09-25T16:00:${String(index).padStart(2, "0")}Z`,
    data_through_date: "2026-09-25",
    raw_response: raw,
    row_count: 1,
    expected_columns: ["starter"],
    observed_columns: ["starter"],
    mlbam_coverage: 1,
    parser_version: "test",
    source_status: "CURRENT",
    fallback_used: "NO",
    notes: "test fixture",
  };
}

function harness(storedRows: unknown[][] = []) {
  const calls = { ensure: 0, read: 0, raw: 0, metadata: 0 };
  const rawRows: unknown[][] = [];
  const metadataRows: unknown[][] = [];
  const dependencies: SourceSnapshotPersistenceDependencies = {
    async ensureSheets() { calls.ensure += 1; },
    async readStoredMetadata() { calls.read += 1; return storedRows; },
    async appendRawRows(_workbookId, rows) {
      calls.raw += 1;
      rawRows.push(...rows);
    },
    async appendMetadataRows(_workbookId, rows) {
      calls.metadata += 1;
      metadataRows.push(...rows);
    },
  };
  return { calls, rawRows, metadataRows, dependencies };
}

test("full-slate snapshot retention uses constant preparation reads instead of per-source reads", async () => {
  const one = harness();
  const oneResult = await persistSourceSnapshots([source(1)], "test-workbook", one.dependencies);
  assert.deepEqual(one.calls, { ensure: 1, read: 1, raw: 1, metadata: 1 });
  assert.equal(oneResult[0].status, "success");

  const fullSlate = harness();
  const results = await persistSourceSnapshots(
    Array.from({ length: 30 }, (_, index) => source(index)),
    "test-workbook",
    fullSlate.dependencies,
  );
  assert.deepEqual(fullSlate.calls, { ensure: 1, read: 1, raw: 1, metadata: 1 });
  assert.equal(fullSlate.rawRows.length, 30);
  assert.equal(fullSlate.metadataRows.length, 30);
  assert.ok(results.every((result) => result.status === "success"));
  assert.ok(results.every((result) => result.metadata_written && result.raw_chunks_written === 1));
});

test("large raw retention is bounded into deterministic append batches", async () => {
  const fixture = harness();
  const count = RAW_SNAPSHOT_ROWS_PER_APPEND + 1;
  const results = await persistSourceSnapshots(
    Array.from({ length: count }, (_, index) => source(index)),
    "test-workbook",
    fixture.dependencies,
  );
  assert.equal(fixture.calls.ensure, 1);
  assert.equal(fixture.calls.read, 1);
  assert.equal(fixture.calls.raw, 2);
  assert.equal(fixture.calls.metadata, 1);
  assert.equal(results.length, count);
});

test("same-batch duplicate evidence is written once while every caller receives success", async () => {
  const duplicate = source(1);
  const fixture = harness();
  const results = await persistSourceSnapshots(
    [duplicate, { ...duplicate }],
    "test-workbook",
    fixture.dependencies,
  );
  assert.equal(fixture.rawRows.length, 1);
  assert.equal(fixture.metadataRows.length, 1);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === "success"));
  assert.ok(results.every((result) => result.metadata_written));
});

test("already retained evidence performs no append writes", async () => {
  const input = source(3);
  const snapshot = materializeSourceSnapshot(input);
  const storedRow = [
    snapshot.snapshot_id, snapshot.canonical_source_id, snapshot.request_url,
    snapshot.fetch_timestamp_utc, snapshot.data_through_date,
    snapshot.raw_response_sha256, snapshot.raw_response_bytes, snapshot.row_count,
    snapshot.expected_columns.join(","), snapshot.observed_columns.join(","),
    snapshot.mlbam_coverage, snapshot.parser_version, snapshot.source_status,
    snapshot.fallback_used, "STORED", snapshot.notes,
  ];
  const fixture = harness([storedRow]);
  const [result] = await persistSourceSnapshots([input], "test-workbook", fixture.dependencies);
  assert.deepEqual(fixture.calls, { ensure: 1, read: 1, raw: 0, metadata: 0 });
  assert.equal(result.status, "success");
  assert.equal(result.metadata_written, false);
  assert.equal(result.raw_chunks_written, 0);
});

test("a batch write failure remains a per-source retention gap", async () => {
  const fixture = harness();
  fixture.dependencies.appendRawRows = async () => { throw new Error("Google Sheets 429"); };
  const results = await persistSourceSnapshots(
    Array.from({ length: 30 }, (_, index) => source(index)),
    "test-workbook",
    fixture.dependencies,
  );
  assert.ok(results.every((result) => result.status === "failure"));
  assert.ok(results.every((result) => result.errors.includes("Google Sheets 429")));
  assert.equal(fixture.calls.metadata, 0);
});
