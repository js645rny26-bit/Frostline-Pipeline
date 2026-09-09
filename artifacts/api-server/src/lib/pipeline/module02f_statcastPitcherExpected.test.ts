import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_EXPECTED_PITCHER_PA,
  buildStatcastPitcherExpectedUrl,
  evaluatePregameCutoff,
  isFullSlatePregameWindow,
  parseStatcastPitcherExpectedCsv,
  pregameEligiblePitcherExpectedStats,
} from "./module02f_statcastPitcherExpected.js";
import {
  RAW_SNAPSHOT_CHUNK_CHARS,
  materializeSourceSnapshot,
  sourceSnapshotMetadataMatchesStoredRow,
  splitRawSnapshot,
} from "./module02_sourceSnapshots.js";

const CSV = `"last_name, first_name","player_id","year","pa","bip","ba","est_ba","slg","est_slg","woba","est_woba","era","xera"\n"Ace, Jane","123","2026","156","101",0.22,0.21,0.32,0.31,0.27,0.26,"3.01","2.91"\n`;
const VERIFIED_D1 = {
  slate_date: "2026-09-06",
  requested_through_date: "2026-09-05",
  data_through_date: "2026-09-05",
  provenance: "PAYLOAD_FIELD" as const,
};

test("expected-pitching parser preserves contact-quality fields and source contract", () => {
  const result = parseStatcastPitcherExpectedCsv(CSV, "2026", "https://example.test/expected.csv", VERIFIED_D1, "2026-09-06T12:00:00.000Z");
  assert.equal(result.status, "success");
  assert.equal(result.pregame_eligible, true);
  assert.equal(result.cutoff_status, "VERIFIED_D1_OR_EARLIER");
  assert.deepEqual(result.stats.get(123), { pitcher_id: 123, name: "Jane Ace", pa: 156, bip: 101, era: 3.01, xera: 2.91, xwoba_allowed: 0.26, xba_allowed: 0.21, xslg_allowed: 0.31 });
  assert.equal(result.source_snapshot?.data_through_date, "2026-09-05");
  assert.equal(result.source_snapshot?.source_status, "CURRENT");
});

test("schema drift is an explicit source failure instead of neutral pitcher evidence", () => {
  const result = parseStatcastPitcherExpectedCsv('"player_id","pa","era"\n"123","156","3.01"\n', "2026", "https://example.test/expected.csv", VERIFIED_D1);
  assert.equal(result.status, "failure");
  assert.equal(result.source_snapshot?.source_status, "SCHEMA_DRIFT");
  assert.equal(result.stats.size, 0);
});

test("slate-day expected-pitcher evidence is rejected for pregame use", () => {
  const result = parseStatcastPitcherExpectedCsv(CSV, "2026", "https://example.test/expected.csv", {
    ...VERIFIED_D1,
    data_through_date: "2026-09-06",
  });
  assert.equal(result.pregame_eligible, false);
  assert.equal(result.cutoff_status, "REJECTED_SAME_DAY_OR_LATER");
  assert.equal(result.source_snapshot?.source_status, "UNAVAILABLE");
  assert.equal(pregameEligiblePitcherExpectedStats(result).size, 0);
});

test("source-proven D-1 expected-pitcher evidence is accepted", () => {
  assert.deepEqual(evaluatePregameCutoff(VERIFIED_D1), {
    eligible: true,
    status: "VERIFIED_D1_OR_EARLIER",
    reason: "Source horizon 2026-09-05 is cutoff-safe through 2026-09-05",
  });
  const result = parseStatcastPitcherExpectedCsv(CSV, "2026", "https://example.test/expected.csv", VERIFIED_D1);
  assert.equal(pregameEligiblePitcherExpectedStats(result).size, 1);
});

test("an unprovable season-leaderboard cutoff retains raw evidence but cannot become CURRENT", () => {
  const result = parseStatcastPitcherExpectedCsv(CSV, "2026", "https://example.test/expected.csv", {
    slate_date: "2026-09-06",
    requested_through_date: "2026-09-05",
    data_through_date: null,
    provenance: "PIPELINE_ASSIGNED",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.pregame_eligible, false);
  assert.equal(result.cutoff_status, "CUTOFF_UNVERIFIED");
  assert.equal(result.source_snapshot?.source_status, "UNAVAILABLE");
  assert.equal(result.source_snapshot?.data_through_date, "");
  assert.equal(result.source_snapshot?.raw_response, CSV);
  assert.equal(result.source_snapshot?.fallback_used, "TRADITIONAL_PITCHER_QUALITY_OR_NEUTRAL");
  assert.equal(pregameEligiblePitcherExpectedStats(result).size, 0);
});

test("source snapshots hash raw content and split it without loss", () => {
  const raw = "\uFEFF" + "x".repeat(RAW_SNAPSHOT_CHUNK_CHARS + 12);
  const snapshot = materializeSourceSnapshot({ canonical_source_id: "SOURCE_TEST", request_url: "https://example.test", fetch_timestamp_utc: "2026-09-06T12:00:00.000Z", data_through_date: "2026-09-05", raw_response: raw, row_count: 1, expected_columns: [], observed_columns: [], mlbam_coverage: 0, parser_version: "test", source_status: "CURRENT", fallback_used: "NONE", notes: "" });
  const chunks = splitRawSnapshot(snapshot.raw_response);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), raw);
  assert.equal(snapshot.raw_response_sha256.length, 64);
});

test("identical raw bytes with a different cutoff status append new provenance", () => {
  const current = materializeSourceSnapshot({
    canonical_source_id: "SOURCE_TEST", request_url: "https://example.test",
    fetch_timestamp_utc: "2026-09-09T12:00:00.000Z", data_through_date: "2026-09-09",
    raw_response: CSV, row_count: 1, expected_columns: [], observed_columns: [],
    mlbam_coverage: 1, parser_version: "test", source_status: "CURRENT",
    fallback_used: "NONE", notes: "caller-stamped",
  });
  const unsafe = materializeSourceSnapshot({
    ...current,
    fetch_timestamp_utc: "2026-09-09T13:00:00.000Z",
    data_through_date: "",
    source_status: "UNAVAILABLE",
    fallback_used: "TRADITIONAL_PITCHER_QUALITY_OR_NEUTRAL",
    notes: "PREGAME_CUTOFF_UNVERIFIED",
  });
  const storedCurrentRow = [
    current.snapshot_id, current.canonical_source_id, current.request_url,
    current.fetch_timestamp_utc, current.data_through_date,
    current.raw_response_sha256, current.raw_response_bytes, current.row_count,
    "", "", current.mlbam_coverage, current.parser_version,
    current.source_status, current.fallback_used, "STORED", current.notes,
  ];
  assert.equal(sourceSnapshotMetadataMatchesStoredRow(current, storedCurrentRow), true);
  assert.equal(sourceSnapshotMetadataMatchesStoredRow(unsafe, storedCurrentRow), false);
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
