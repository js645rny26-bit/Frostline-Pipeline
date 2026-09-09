import assert from "node:assert/strict";
import test from "node:test";
import {
  BVH_DAILY_HISTORY_HEADERS,
  existingBVHSnapshotState,
  parseBVHDailyHistory,
  selectCanonicalBVHDailyHistory,
} from "./module02j_batterVsHandHistory.js";

function row(date: string, batter: number, hand: "L" | "R", snapshot: string, ts: string, pa = 1): unknown[] {
  return [date, batter, hand, pa, pa, 1, 0, 0, 0, 0, 1, snapshot, ts, date, "1.0.0"];
}

test("BVH history parses by named columns and selects the latest immutable snapshot for a date", () => {
  const parsed = parseBVHDailyHistory([
    Array.from(BVH_DAILY_HISTORY_HEADERS),
    row("2026-09-06", 1, "R", "old", "2026-09-07T01:00:00.000Z", 1),
    row("2026-09-06", 1, "R", "new", "2026-09-07T02:00:00.000Z", 2),
    row("2026-09-05", 2, "L", "prior", "2026-09-06T02:00:00.000Z", 3),
  ]);
  const selected = selectCanonicalBVHDailyHistory(parsed);
  assert.equal(selected.length, 2);
  assert.equal(selected.find((value) => value.game_date === "2026-09-06")?.source_snapshot_id, "new");
  assert.equal(selected.find((value) => value.game_date === "2026-09-06")?.pa, 2);
});

test("BVH history rejects same-timestamp competing snapshots instead of double counting", () => {
  const parsed = parseBVHDailyHistory([
    Array.from(BVH_DAILY_HISTORY_HEADERS),
    row("2026-09-06", 1, "R", "a", "2026-09-07T02:00:00.000Z"),
    row("2026-09-06", 1, "R", "b", "2026-09-07T02:00:00.000Z"),
  ]);
  assert.throws(() => selectCanonicalBVHDailyHistory(parsed), /BVH_DAILY_SNAPSHOT_COLLISION/);
});

test("BVH history refuses to treat a partially persisted source snapshot as complete", () => {
  const parsed = parseBVHDailyHistory([
    Array.from(BVH_DAILY_HISTORY_HEADERS),
    row("2026-09-06", 1, "R", "partial", "2026-09-07T02:00:00.000Z", 1),
  ]);
  const expected = [
    { game_date: "2026-09-06", batter_mlbam_id: 1, pitcher_hand: "R" as const, pa: 1, ab: 1, hits: 1, bb: 0, ibb: 0, hbp: 0, sf: 0, total_bases: 1 },
    { game_date: "2026-09-06", batter_mlbam_id: 2, pitcher_hand: "L" as const, pa: 1, ab: 1, hits: 1, bb: 0, ibb: 0, hbp: 0, sf: 0, total_bases: 1 },
  ];
  assert.throws(() => existingBVHSnapshotState(parsed, "partial", expected), /BVH_HISTORY_PARTIAL_SNAPSHOT/);
  assert.equal(existingBVHSnapshotState([], "missing", expected), "ABSENT");
});
