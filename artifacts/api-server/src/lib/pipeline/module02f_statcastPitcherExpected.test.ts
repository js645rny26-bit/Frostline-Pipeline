import assert from "node:assert/strict";
import test from "node:test";
import { MIN_EXPECTED_PITCHER_PA, buildStatcastPitcherExpectedUrl, isFullSlatePregameWindow, parseStatcastPitcherExpectedCsv } from "./module02f_statcastPitcherExpected.js";
import { RAW_SNAPSHOT_CHUNK_CHARS, materializeSourceSnapshot, splitRawSnapshot } from "./module02_sourceSnapshots.js";

const CSV = `"last_name, first_name","player_id","year","pa","bip","ba","est_ba","slg","est_slg","woba","est_woba","era","xera"\n"Ace, Jane","123","2026","156","101",0.22,0.21,0.32,0.31,0.27,0.26,"3.01","2.91"\n`;

test("expected-pitching parser preserves contact-quality fields and source contract", () => {
  const result = parseStatcastPitcherExpectedCsv(CSV, "2026", "https://example.test/expected.csv", "2026-09-05", "2026-09-06T12:00:00.000Z");
  assert.equal(result.status, "success");
  assert.deepEqual(result.stats.get(123), { pitcher_id: 123, name: "Jane Ace", pa: 156, bip: 101, era: 3.01, xera: 2.91, xwoba_allowed: 0.26, xba_allowed: 0.21, xslg_allowed: 0.31 });
  assert.equal(result.source_snapshot?.data_through_date, "2026-09-05");
  assert.equal(result.source_snapshot?.source_status, "CURRENT");
});

test("schema drift is an explicit source failure instead of neutral pitcher evidence", () => {
  const result = parseStatcastPitcherExpectedCsv('"player_id","pa","era"\n"123","156","3.01"\n', "2026", "https://example.test/expected.csv", "2026-09-05");
  assert.equal(result.status, "failure");
  assert.equal(result.source_snapshot?.source_status, "SCHEMA_DRIFT");
  assert.equal(result.stats.size, 0);
});

test("source snapshots hash raw content and split it without loss", () => {
  const raw = "\uFEFF" + "x".repeat(RAW_SNAPSHOT_CHUNK_CHARS + 12);
  const snapshot = materializeSourceSnapshot({ canonical_source_id: "SOURCE_TEST", request_url: "https://example.test", fetch_timestamp_utc: "2026-09-06T12:00:00.000Z", data_through_date: "2026-09-05", raw_response: raw, row_count: 1, expected_columns: [], observed_columns: [], mlbam_coverage: 0, parser_version: "test", source_status: "CURRENT", fallback_used: "NONE", notes: "" });
  const chunks = splitRawSnapshot(snapshot.raw_response);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), raw);
  assert.equal(snapshot.raw_response_sha256.length, 64);
});

test("source retains unqualified pitcher rows and owns its own sample gate", () => {
  assert.match(buildStatcastPitcherExpectedUrl("2026"), /min=1/);
  assert.equal(MIN_EXPECTED_PITCHER_PA, 100);
});

test("current-season leaderboard is withheld after any game on the slate has started", () => {
  assert.equal(isFullSlatePregameWindow([
    "2026-09-06T22:00:00.000Z",
    "2026-09-06T23:00:00.000Z",
  ], "2026-09-06T21:00:00.000Z"), true);
  assert.equal(isFullSlatePregameWindow([
    "2026-09-06T20:00:00.000Z",
    "2026-09-06T23:00:00.000Z",
  ], "2026-09-06T21:00:00.000Z"), false);
  assert.equal(isFullSlatePregameWindow([undefined], "2026-09-06T21:00:00.000Z"), false);
});
