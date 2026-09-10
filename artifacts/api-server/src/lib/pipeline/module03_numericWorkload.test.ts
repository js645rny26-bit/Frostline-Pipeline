import assert from "node:assert/strict";
import test from "node:test";
import type { PitcherGameLogAppearance, PitcherWorkloadData } from "./module02_pitcherWorkload.js";
import { estimatePitcherSpecificWorkload } from "./module03_numericWorkload.js";

function appearance(
  date: string,
  innings: number,
  pitches: number | null,
  started = true,
): PitcherGameLogAppearance {
  return { date, game_pk: null, games_started: started ? 1 : 0, innings, pitch_count: pitches, batters_faced: null };
}

function workload(rows: PitcherGameLogAppearance[], status = "active"): PitcherWorkloadData {
  return {
    playerId: 1,
    name: "Fixture",
    status,
    rolling_stats: {
      l30: { appearances: rows.length, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
      l14: { appearances: rows.length, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
      season: { appearances: rows.length, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
    },
    recent_games_count: rows.length,
    recent_appearances: rows,
  };
}

test("Module 03 workload candidate uses pitcher-specific innings and pitch evidence instead of a role lookup", () => {
  const rows = [
    appearance("2026-09-04", 5, 75),
    appearance("2026-08-30", 4.667, 65),
    appearance("2026-08-26", 1, 8, false),
    appearance("2026-08-23", 4.667, 69),
    appearance("2026-08-17", 5, 88),
  ];
  const result = estimatePitcherSpecificWorkload("BULK", 55, 3, "2026-09-09", "2026-09-08", workload(rows));
  assert.equal(result.status, "PITCHER_SPECIFIC");
  assert.equal(result.expected_innings, 4.19);
  assert.equal(result.expected_pitches, 61);
  assert.equal(result.relevant_appearances, 5);
  assert.notEqual(result.expected_innings, 3);
  assert.match(result.notes, /ip_sd=/);
});

test("Module 03 workload candidate shrinks a one-appearance sample and never becomes a single-start estimator", () => {
  const result = estimatePitcherSpecificWorkload(
    "CONVENTIONAL_STARTER", 92, 6, "2026-09-09", "2026-09-08",
    workload([appearance("2026-09-03", 2, 40)]),
  );
  assert.equal(result.history_weight, 0.2);
  assert.equal(result.expected_innings, 5.2);
  assert.equal(result.expected_pitches, 82);
});

test("Module 03 workload candidate enforces D-1 and falls back explicitly when no admissible history remains", () => {
  const result = estimatePitcherSpecificWorkload(
    "CONVENTIONAL_STARTER", 92, 6, "2026-09-09", "2026-09-08",
    workload([appearance("2026-09-09", 9, 120)]),
  );
  assert.equal(result.status, "ROLE_FALLBACK_NO_USABLE_HISTORY");
  assert.equal(result.expected_innings, 6);
  assert.equal(result.expected_pitches, 92);
});

test("Module 03 workload candidate preserves return evidence as a constraint, not a fixed 5.7-IP answer", () => {
  const rows = [
    appearance("2026-07-26", 5.667, 89),
    appearance("2026-07-21", 4.333, 85),
    appearance("2026-07-11", 5, 85),
    appearance("2026-07-06", 5, 80),
    appearance("2026-07-01", 5, 69),
  ];
  const result = estimatePitcherSpecificWorkload(
    "CONVENTIONAL_STARTER", 85, 5.7, "2026-09-09", "2026-09-08",
    workload(rows, "active_wide_window"),
  );
  assert.equal(result.rest_state, "RETURN_FROM_EXTENDED_REST");
  assert.equal(result.expected_innings, 4.37);
  assert.notEqual(result.expected_innings, 5.7);
});

test("named extended-rest cases remain constrained but pitcher-specific", () => {
  const gallen = estimatePitcherSpecificWorkload(
    "CONVENTIONAL_STARTER", 85, 5.5, "2026-09-09", "2026-09-08",
    workload([
      appearance("2026-07-07", 6, 91),
      appearance("2026-07-01", 6, 94),
      appearance("2026-06-25", 5.333, 89),
      appearance("2026-06-19", 5.667, 93),
      appearance("2026-06-13", 6, 95),
    ], "active_wide_window"),
  );
  const reynaldoLopez = estimatePitcherSpecificWorkload(
    "CONVENTIONAL_STARTER", 85, 5.7, "2026-09-09", "2026-09-08",
    workload([
      appearance("2026-07-26", 5.667, 89),
      appearance("2026-07-21", 4.333, 85),
      appearance("2026-07-11", 5, 85),
      appearance("2026-07-06", 5, 80),
      appearance("2026-07-01", 5, 69),
    ], "active_wide_window"),
  );
  assert.equal(gallen.rest_state, "RETURN_FROM_EXTENDED_REST");
  assert.equal(gallen.expected_innings, 5.11, "Zac Gallen");
  assert.equal(reynaldoLopez.expected_innings, 4.37, "Reynaldo López");
});

test("named Sept. 9 workload cases remain individual rather than collapsing to role defaults", () => {
  const cases: Array<{
    name: string; role: string; priorIp: number; priorPitches: number;
    rows: PitcherGameLogAppearance[]; expectedIp: number;
  }> = [
    { name: "Griffin Jax", role: "BULK", priorIp: 3, priorPitches: 55, expectedIp: 4.19, rows: [appearance("2026-09-02", 2.667, 63), appearance("2026-08-02", 5, 82), appearance("2026-07-28", 5.667, 93), appearance("2026-07-22", 6, 83), appearance("2026-07-17", 5, 85)] },
    { name: "Daniel Lynch IV", role: "BULK", priorIp: 3, priorPitches: 55, expectedIp: 4.25, rows: [appearance("2026-09-04", 5, 70), appearance("2026-08-29", 3.333, 70), appearance("2026-08-23", 4.333, 59), appearance("2026-08-18", 4, 45), appearance("2026-08-12", 2.333, 39)] },
    { name: "Davis Martin", role: "BULK", priorIp: 3, priorPitches: 55, expectedIp: 3.86, rows: [appearance("2026-09-02", 5.667, 80), appearance("2026-08-13", 2, 35), appearance("2026-08-09", 1, 23), appearance("2026-08-04", 5, 91), appearance("2026-07-29", 6, 106)] },
    { name: "Janson Junk", role: "BULK", priorIp: 3, priorPitches: 55, expectedIp: 4.19, rows: [appearance("2026-09-04", 5, 75), appearance("2026-08-30", 4.667, 65), appearance("2026-08-26", 1, 8, false), appearance("2026-08-23", 4.667, 69), appearance("2026-08-17", 5, 88)] },
    { name: "Andre Pallante", role: "CONVENTIONAL_STARTER", priorIp: 6, priorPitches: 92, expectedIp: 5.52, rows: [appearance("2026-09-04", 5, 72), appearance("2026-08-17", 6, 88), appearance("2026-08-11", 6, 97), appearance("2026-08-05", 5.333, 103), appearance("2026-07-30", 6.333, 90)] },
    { name: "Walker Buehler", role: "CONVENTIONAL_STARTER", priorIp: 6, priorPitches: 92, expectedIp: 5.3, rows: [appearance("2026-09-04", 5, 76), appearance("2026-08-29", 5, 71), appearance("2026-08-23", 6, 86), appearance("2026-08-17", 6, 86), appearance("2026-08-11", 6, 98)] },
    { name: "Cody Bradford", role: "CONVENTIONAL_STARTER", priorIp: 6, priorPitches: 92, expectedIp: 4.8, rows: [appearance("2026-09-02", 4, 86), appearance("2026-08-28", 5.667, 100), appearance("2026-08-22", 5.333, 80), appearance("2026-08-16", 4, 81), appearance("2026-08-11", 7, 75)] },
    { name: "Kade Anderson", role: "CONVENTIONAL_STARTER", priorIp: 6, priorPitches: 92, expectedIp: 5.36, rows: [appearance("2026-09-03", 5, 79), appearance("2026-08-29", 4.333, 85), appearance("2026-08-22", 5.667, 81)] },
  ];
  for (const item of cases) {
    const result = estimatePitcherSpecificWorkload(item.role, item.priorPitches, item.priorIp, "2026-09-09", "2026-09-08", workload(item.rows));
    assert.equal(result.expected_innings, item.expectedIp, item.name);
    assert.equal(result.status, "PITCHER_SPECIFIC", item.name);
  }
});
