/**
 * Commissioning smoke test — Module 12s (Shadow Validation) + Module 13 (Historical Replay)
 * 28 cases. Rerun of the corrected suite (prior run: 27/28).
 *
 * Run: ../frostline/node_modules/.bin/tsx smoketest_mod12s_mod13.mts
 */

import {
  legacyAdjRate,
  scaleLegacyRuns,
  runShadowValidation,
} from "./src/lib/pipeline/module12s_shadowValidation.js";
import type { GameSummaryRow } from "./src/lib/pipeline/module09_recalculation.js";
import {
  dateRange,
  parkMultiplierFromFactors,
  rateFromMap,
  computeVariants,
  median,
  computeMetrics,
  type ReplayGameRow,
  type ReplayVariantKey,
} from "./src/lib/pipeline/module13_historicalReplay.js";
import type { ParkFactors } from "./src/lib/pipeline/module04c_startingNine.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(id: number, name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  [${String(id).padStart(2, "0")}] ${name}`);
  } else {
    failed++;
    failures.push(`[${id}] ${name} ${detail}`);
    console.log(`  FAIL  [${String(id).padStart(2, "0")}] ${name} ${detail}`);
  }
}

function near(a: number | null | undefined, b: number, tol = 1e-9): boolean {
  return a != null && Math.abs(a - b) <= tol;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function mkSummaryRow(over: Partial<GameSummaryRow>): GameSummaryRow {
  return {
    game_id: "G", date: "2026-07-24",
    away_team: "AAA", home_team: "HHH",
    away_pitcher: "A. Pitcher", home_pitcher: "H. Pitcher",
    away_pitcher_role: "CONFIRMED_SP", home_pitcher_role: "CONFIRMED_SP",
    away_expected_innings: 5.5, home_expected_innings: 5.5,
    projected_away_runs: 4.0, projected_home_runs: 4.0, projected_total_runs: 8.0,
    run_multiplier: 1.0, stadium: "Test Park",
    environment_quality: "good", bullpen_available: true,
    away_l30_rs_estimate: 4.5, home_l30_rs_estimate: 4.5,
    away_l10_rs_actual: null, home_l10_rs_actual: null,
    away_offense_rate_used: 4.5, home_offense_rate_used: 4.5,
    away_offense_source_status: "L30_ONLY", home_offense_source_status: "L30_ONLY",
    park_runs_pct: null, park_multiplier: 1.0, weather_multiplier: 1.0,
    combined_run_multiplier: 1.0, park_source_status: "MISSING_PARK_DATA",
    ...over,
  };
}

const GAME_A = mkSummaryRow({
  game_id: "A", away_team: "TB", home_team: "TOR",
  projected_away_runs: 4.2, projected_home_runs: 4.6, projected_total_runs: 8.8,
  away_offense_rate_used: 4.8, home_offense_rate_used: 5.0,
  away_l30_rs_estimate: 4.6, home_l30_rs_estimate: 4.9,
  away_l10_rs_actual: 5.1, home_l10_rs_actual: 5.2,
  away_offense_source_status: "BLENDED", home_offense_source_status: "BLENDED",
  weather_multiplier: 1.02, park_multiplier: 1.08, combined_run_multiplier: 1.10,
  park_runs_pct: 8, park_source_status: "VENUE_FACTOR_USED",
});

const GAME_B = mkSummaryRow({
  game_id: "B", away_team: "MIA", home_team: "PIT",
  projected_away_runs: 4.0, projected_home_runs: 3.9, projected_total_runs: 7.9,
  away_offense_rate_used: 4.5, home_offense_rate_used: 4.4,
  away_l30_rs_estimate: null, home_l30_rs_estimate: 4.4,
  away_offense_source_status: "LEAGUE_AVG_FALLBACK", home_offense_source_status: "L30_ONLY",
  weather_multiplier: 0.95, park_multiplier: 1.0, combined_run_multiplier: 0.95,
});

const GAME_C = mkSummaryRow({
  game_id: "C", away_team: "NYY", home_team: "COL",
  projected_away_runs: 4.9, projected_home_runs: 4.3, projected_total_runs: 9.2,
  away_offense_rate_used: 5.2, home_offense_rate_used: 4.5,
  away_l30_rs_estimate: 5.0, home_l30_rs_estimate: null,
  away_l10_rs_actual: 5.6,
  away_offense_source_status: "BLENDED", home_offense_source_status: "LEAGUE_AVG_FALLBACK",
  weather_multiplier: 1.0, park_multiplier: 1.12, combined_run_multiplier: 1.12,
  park_runs_pct: 12, park_source_status: "VENUE_FACTOR_USED",
});

// Rate-map fixture builder (shape shared by L30 and L10 maps)
function mkL10(entries: Array<[string, number, number]>): Map<string, { games: number; runs_per_game: number }> {
  const m = new Map<string, { games: number; runs_per_game: number }>();
  for (const [abbr, games, rpg] of entries) m.set(abbr, { games, runs_per_game: rpg });
  return m;
}

// L30-actual map (MLB API date-anchored source; rates match old fixtures:
// NYY 5.4, BOS 3.6, CHC 4.5, SD 4.5 — expected values unchanged)
const L30MAP = mkL10([["NYY", 27, 5.4], ["BOS", 27, 3.6], ["CHC", 26, 4.5], ["SD", 25, 4.5]]);

function mkReplayRow(proj: number | null, err: number | null): ReplayGameRow {
  const p = {} as Record<ReplayVariantKey, number | null>;
  const e = {} as Record<ReplayVariantKey, number | null>;
  for (const v of ["LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK"] as ReplayVariantKey[]) {
    p[v] = proj;
    e[v] = err;
  }
  return {
    replay_date: "2026-07-01", game_id: "R", away_team: "AAA", home_team: "HHH",
    actual_total: proj != null && err != null ? proj - err : 0,
    projections: p, errors: e,
    away_l30_rate: null, home_l30_rate: null, away_l10_rate: null, home_l10_rate: null,
    away_offense_source: "L30_ONLY", home_offense_source: "L30_ONLY",
    park_runs_pct: null, park_multiplier: 1.0,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Module 12s — Shadow Validation (10 cases) ===");

  // [01] legacyAdjRate with L30 present
  check(1, "legacyAdjRate: L30 present → rate × weather", near(legacyAdjRate(4.8, 1.05), 5.04));

  // [02] legacyAdjRate with null L30 → league-avg 4.5
  check(2, "legacyAdjRate: null L30 → 4.5 league-avg fallback", near(legacyAdjRate(null, 1.1), 4.95));

  // [03] scaleLegacyRuns normal ratio scaling
  check(3, "scaleLegacyRuns: ratio scaling (5.0 × 4.5/5.0 = 4.5)", near(scaleLegacyRuns(5.0, 4.5, 5.0), 4.5));

  // [04] degenerate repairedAdj = 0
  check(4, "scaleLegacyRuns: repairedAdj=0 → legacyAdj absolute (no div/0)", near(scaleLegacyRuns(5.0, 4.73, 0), 4.73));

  // [05] degenerate repairedAdj < 0
  check(5, "scaleLegacyRuns: repairedAdj<0 → legacyAdj absolute", near(scaleLegacyRuns(5.0, 4.73, -1), 4.73));

  // [06] empty slate short-circuit (no sheet write attempted)
  const empty = await runShadowValidation([], "NO_SUCH_WORKBOOK_SMOKE");
  check(6, "runShadowValidation: empty slate → success, 0 games, null aggregates",
    empty.status === "success" && empty.games_compared === 0 &&
    empty.avg_delta === null && empty.max_abs_delta === null &&
    empty.fallback_count === 0 && empty.errors.length === 0,
    JSON.stringify({ s: empty.status, g: empty.games_compared }));

  // [07–10] fixture slate through full path (invalid workbook → write fails, result intact)
  const shadow = await runShadowValidation([GAME_A, GAME_B, GAME_C], "NO_SUCH_WORKBOOK_SMOKE");
  const rowA = shadow.rows.find((r) => r.game_id === "A");
  const rowB = shadow.rows.find((r) => r.game_id === "B");

  check(7, "shadow: Game A delta +0.89, legacy 7.91 (repaired > legacy)",
    near(rowA?.legacy_projected_total ?? null, 7.91, 0.001) && near(rowA?.delta ?? null, 0.89, 0.001),
    JSON.stringify({ legacy: rowA?.legacy_projected_total, delta: rowA?.delta }));

  check(8, "shadow: identity invariant — park=1.0 + L30-only/fallback game has delta 0",
    near(rowB?.delta ?? null, 0, 0.001),
    JSON.stringify({ delta: rowB?.delta }));

  check(9, "shadow: fallback_count counts games with either side on LEAGUE_AVG (2)",
    shadow.fallback_count === 2, `got ${shadow.fallback_count}`);

  check(10, "shadow: aggregates avg 0.68 / maxAbs 1.15; write-failure keeps rows + flags error",
    near(shadow.avg_delta, 0.68, 0.001) && near(shadow.max_abs_delta, 1.15, 0.001) &&
    shadow.status === "failure" && shadow.errors.length === 1 && shadow.rows.length === 3,
    JSON.stringify({ avg: shadow.avg_delta, max: shadow.max_abs_delta, s: shadow.status, e: shadow.errors.length }));

  console.log("=== Module 13 — Historical Replay (18 cases) ===");

  // [11] dateRange basic inclusive
  const dr1 = dateRange("2026-07-01", "2026-07-03");
  check(11, "dateRange: inclusive 3-date range",
    dr1.length === 3 && dr1[0] === "2026-07-01" && dr1[2] === "2026-07-03", JSON.stringify(dr1));

  // [12] dateRange 30-date cap
  const dr2 = dateRange("2026-06-01", "2026-07-20");
  check(12, "dateRange: caps at 30 dates (MAX_DATE_RANGE)",
    dr2.length === 30 && dr2[29] === "2026-06-30", `len=${dr2.length} last=${dr2[dr2.length - 1]}`);

  // [13] dateRange start > end
  check(13, "dateRange: start > end → empty", dateRange("2026-07-10", "2026-07-01").length === 0);

  // [14] park multiplier: null factors → neutral
  const pmNull = parkMultiplierFromFactors(null);
  check(14, "parkMultiplier: null → 1.0 neutral, null pct",
    pmNull.park_multiplier === 1.0 && pmNull.park_runs_pct === null);

  const PF = (runs_pct: number): ParkFactors =>
    ({ runs_pct, hr_l_pct: 0, hr_r_pct: 0, woba_l_pct: 0, woba_r_pct: 0 });

  // [15] park multiplier basic
  check(15, "parkMultiplier: +8% → 1.08", near(parkMultiplierFromFactors(PF(8)).park_multiplier, 1.08));

  // [16] clamp high
  check(16, "parkMultiplier: +40% clamps to 1.15", near(parkMultiplierFromFactors(PF(40)).park_multiplier, 1.15));

  // [17] clamp low
  check(17, "parkMultiplier: −40% clamps to 0.85", near(parkMultiplierFromFactors(PF(-40)).park_multiplier, 0.85));

  // [18] rateFromMap: absent team + below-min games → null
  check(18, "rateFromMap: absent team → null; 14 games < min 15 → null",
    rateFromMap("XXX", L30MAP, 15) === null &&
    rateFromMap("LOW", mkL10([["LOW", 14, 5.0]]), 15) === null);

  // [19] rateFromMap boundary + computeVariants L30 gate (MIN_L30_GAMES = 15)
  const v19 = computeVariants("LOW", "SD",
    mkL10([["LOW", 14, 6.0], ["SD", 25, 4.5]]),
    mkL10([["LOW", 10, 5.0], ["SD", 10, 4.0]]), null);
  check(19, "rateFromMap: exactly 15 games accepted; variants gate L30 at 15 (14 → L10_ONLY)",
    near(rateFromMap("OK", mkL10([["OK", 15, 5.2]]), 15), 5.2) &&
    v19.away_offense_source === "L10_ONLY" && v19.away_l30 === null &&
    v19.home_offense_source === "BLENDED",
    JSON.stringify({ a: v19.away_offense_source, aL30: v19.away_l30 }));

  // [20] computeVariants BLENDED weights
  const l10a = mkL10([["NYY", 10, 5.8], ["BOS", 10, 4.2]]);
  const v20 = computeVariants("NYY", "BOS", L30MAP, l10a, null);
  check(20, "variants: BLEND = 0.65×L30 + 0.35×L10 (5.54 + 3.81 = 9.35), source BLENDED",
    near(v20.projections.BLEND, 9.35, 0.001) &&
    v20.away_offense_source === "BLENDED" && v20.home_offense_source === "BLENDED",
    JSON.stringify({ blend: v20.projections.BLEND }));

  // [21] MIN_L10_GAMES boundary: 4 rejected, 5 accepted
  const l10b = mkL10([["CHC", 4, 9.9], ["SD", 5, 4.0]]);
  const v21 = computeVariants("CHC", "SD", L30MAP, l10b, null);
  check(21, "variants: L10 with 4 games rejected (L30_ONLY); 5 games accepted (BLENDED)",
    v21.away_offense_source === "L30_ONLY" && v21.away_l10 === null &&
    v21.home_offense_source === "BLENDED" && near(v21.home_l10, 4.0),
    JSON.stringify({ a: v21.away_offense_source, h: v21.home_offense_source }));

  // [22] double LEAGUE_AVG_FALLBACK → all variants 9.0
  const v22 = computeVariants("XXA", "XXB", L30MAP, mkL10([]), null);
  check(22, "variants: no L30/L10 → LEAGUE_AVG_FALLBACK both sides, all variants 9.0",
    v22.away_offense_source === "LEAGUE_AVG_FALLBACK" &&
    v22.home_offense_source === "LEAGUE_AVG_FALLBACK" &&
    (["LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK"] as ReplayVariantKey[])
      .every((k) => near(v22.projections[k], 9.0)),
    JSON.stringify(v22.projections));

  // [23] LEGACY === BLEND when L10 absent (blend degrades to L30-only)
  const v23 = computeVariants("NYY", "BOS", L30MAP, mkL10([]), null);
  check(23, "variants: L10 absent → BLEND degrades to L30-only (LEGACY === BLEND === 9.0)",
    near(v23.projections.LEGACY, 9.0) && near(v23.projections.BLEND, 9.0) &&
    v23.away_offense_source === "L30_ONLY",
    JSON.stringify({ legacy: v23.projections.LEGACY, blend: v23.projections.BLEND }));

  // [24] L30_PARK = LEGACY × park multiplier
  const v24 = computeVariants("NYY", "BOS", L30MAP, mkL10([]), PF(10));
  check(24, "variants: L30_PARK = LEGACY × park mult (9.0 × 1.1 = 9.9), pct/mult audited",
    near(v24.projections.L30_PARK, 9.9, 0.011) &&
    near(v24.park_multiplier, 1.1) && v24.park_runs_pct === 10,
    JSON.stringify({ l30park: v24.projections.L30_PARK, mult: v24.park_multiplier }));

  // [25] computeMetrics: MAE + bias sign convention
  const m25 = computeMetrics("LEGACY", [mkReplayRow(8, 2), mkReplayRow(8, -1), mkReplayRow(8, 3)], "ts");
  check(25, "metrics: MAE 2.0, bias +1.333 (positive = overprojection), over 66.7 / under 33.3",
    near(m25.mae, 2.0, 0.001) && near(m25.bias, 1.333, 0.001) &&
    near(m25.overproject_pct, 66.7, 0.05) && near(m25.underproject_pct, 33.3, 0.05),
    JSON.stringify({ mae: m25.mae, bias: m25.bias }));

  // [26] miss_4plus boundary: |err| = 4.0 counts
  const m26 = computeMetrics("LEGACY", [mkReplayRow(8, 4), mkReplayRow(8, -4), mkReplayRow(8, 1)], "ts");
  check(26, "metrics: miss_4plus includes |err| exactly 4.0 (2/3 = 66.7%)",
    near(m26.miss_4plus_pct, 66.7, 0.05), `got ${m26.miss_4plus_pct}`);

  // [27] median on even count + zero-error excluded from over AND under
  const m27 = computeMetrics("LEGACY", [mkReplayRow(8, 1), mkReplayRow(8, -3), mkReplayRow(8, 0), mkReplayRow(8, 2)], "ts");
  check(27, "metrics: even-count median AE 1.5; zero-error in neither over (50%) nor under (25%)",
    near(m27.median_ae, 1.5, 0.001) && near(m27.overproject_pct, 50.0, 0.05) &&
    near(m27.underproject_pct, 25.0, 0.05),
    JSON.stringify({ med: m27.median_ae, over: m27.overproject_pct, under: m27.underproject_pct }));

  // [28] calibration band boundaries + null projections excluded
  const m28 = computeMetrics("LEGACY", [
    mkReplayRow(6.9, 1), mkReplayRow(7.0, 1), mkReplayRow(9.0, 1), mkReplayRow(11.0, 1),
    mkReplayRow(null, null),
  ], "ts");
  const bandGames = m28.calibration.map((b) => b.games);
  check(28, "metrics: bands [<7, 7–8.9, 9–10.9, ≥11] each get 1 game (7.0→band2, 9.0→band3); null row excluded",
    m28.games_count === 4 && bandGames.length === 4 && bandGames.every((g) => g === 1),
    JSON.stringify({ count: m28.games_count, bands: bandGames }));

  // ── Summary ──
  console.log("");
  console.log(`RESULT: ${passed}/${passed + failed} passed`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
