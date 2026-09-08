import assert from "node:assert/strict";
import test from "node:test";
import {
  SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS,
  buildSavantPitchLevelUrl,
  parseSavantPitchLevelCsv,
  selectSavantPitchLevelWindow,
} from "./module02h_savantPitchLevel.js";

const HEADER = [
  "release_speed", "game_date", "game_pk", "batter", "pitcher", "stand", "p_throws", "pitch_type", "events", "description", "pfx_x",
];
const row = (date: string, gamePk: number, batter: number, pitcher: number) =>
  ["95.1", date, String(gamePk), String(batter), String(pitcher), "L", "R", "FF", "single", "hit_into_play", "0.12"].join(",");

test("pitch-level parser preserves Savant headers, required identities, and raw values", () => {
  const raw = `${HEADER.join(",")}\n${row("2026-09-06", 12, 101, 201)}\n`;
  const result = parseSavantPitchLevelCsv(raw, "2026-09-06", "https://example.test/csv");
  assert.equal(result.status, "success");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.raw.get("release_speed"), "95.1");
  assert.deepEqual(result.source_snapshot?.observed_columns, HEADER);
  assert.equal(result.source_snapshot?.mlbam_coverage, 2);
});

test("schema drift and post-cutoff rows cannot become neutral pitch evidence", () => {
  const missing = parseSavantPitchLevelCsv("game_date,game_pk\n2026-09-06,12\n", "2026-09-06", "https://example.test/csv");
  assert.equal(missing.status, "failure");
  assert.equal(missing.source_snapshot?.source_status, "SCHEMA_DRIFT");
  assert.match(missing.errors[0] ?? "", /batter/);

  const raw = `${HEADER.join(",")}\n${row("2026-09-07", 13, 102, 202)}\n`;
  const future = parseSavantPitchLevelCsv(raw, "2026-09-06", "https://example.test/csv");
  assert.equal(future.status, "partial");
  assert.equal(future.events.length, 0);
});

test("shared rolling windows are cutoff-safe and calendar-defined", () => {
  const raw = `${HEADER.join(",")}\n${row("2026-09-06", 12, 101, 201)}\n${row("2026-08-24", 13, 102, 202)}\n${row("2026-08-07", 14, 103, 203)}\n`;
  const events = parseSavantPitchLevelCsv(raw, "2026-09-06", "https://example.test/csv").events;
  assert.equal(selectSavantPitchLevelWindow(events, "2026-09-06", "L5").length, 1);
  assert.equal(selectSavantPitchLevelWindow(events, "2026-09-06", "L14").length, 2);
  assert.equal(selectSavantPitchLevelWindow(events, "2026-09-06", "L30").length, 2);
  assert.equal(selectSavantPitchLevelWindow(events, "2026-09-06", "SEASON").length, 3);
});

test("direct CSV request retains the mandated complete/details/date/regular-season filters", () => {
  const url = buildSavantPitchLevelUrl("2026-09-06");
  assert.match(url, /type=details/);
  assert.match(url, /game_date_gt=2026-09-06/);
  assert.match(url, /game_date_lt=2026-09-06/);
  assert.match(url, /hfGT=R%7C/);
  assert.match(url, /all=true/);
  assert.equal(SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS.includes("description"), true);
});
