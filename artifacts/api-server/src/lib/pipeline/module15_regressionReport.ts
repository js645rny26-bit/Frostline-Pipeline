/**
 * Module 15: Regression Monitoring + Edge Monotonicity Analysis
 *
 * ── Part A — Regression windows ──────────────────────────────────────────────
 * Reads SHADOW_OUTCOMES and computes trailing performance windows:
 *   • 7-day   • 30-day   • year-to-date   • all-time
 *
 * Alerts fire when a window materially degrades vs the commissioned baseline:
 *   MAE > 4.2, |bias| > 0.20, miss_4plus > 45 %
 *
 * ── Part B — Edge Monotonicity ────────────────────────────────────────────────
 * Joins VEHICLE_LOG (direction + market line at PREDICTION TIME + projected total)
 * with SHADOW_OUTCOMES (settled actuals) on game_id.
 *
 * For each matched game we compute:
 *   edge      = |VEHICLE_LOG.Variance|   = |projected_total − market_line_at_prediction|
 *   direction = VEHICLE_LOG.Direction    = OVER | UNDER (NONE excluded)
 *   hit       = direction was correct:
 *                 OVER  → actual_total > market_line
 *                 UNDER → actual_total < market_line
 *   push      = actual_total === market_line (excluded from hit-rate denominator)
 *
 * Two parallel analyses — OVER picks and UNDER picks — each reporting:
 *   (a) Fixed edge tiers: 1.50–1.99 | 2.00–2.49 | 2.50–2.99 | 3.00+
 *   (b) Equal-count quintiles (Q1 lowest edge … Q5 highest)
 *
 * Per-bucket stats: n, n_hits, n_pushes, hit_rate_pct, MAE, median_AE, bias
 *
 * PASS verdict (per direction, applied to fixed tiers):
 *   1. Hit-rate non-decreasing: ≥ 80 % of adjacent pairs where BOTH buckets n ≥ 75
 *   2. MAE non-worsening:       ≥ 80 % of adjacent pairs where BOTH buckets n ≥ 75
 *   3. Top-tier vs bottom-tier hit-rate separation ≥ 5 pp
 *   4. All tiers used in the verdict have n ≥ MIN_BUCKET_N (75)
 *
 * If fewer than 2 tiers have n ≥ 75 the verdict is INSUFFICIENT_SAMPLE.
 * Overall verdict: PASS only if BOTH OVER and UNDER pass (or one direction has
 * no data, in which case the available direction's verdict stands alone).
 *
 * Endpoint: GET /api/pipeline/regression[?write_sheets=true]
 */

import { readRange, writeRange, clearRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

// ─── Sheet / column constants ─────────────────────────────────────────────────

const OUTCOMES_SHEET     = "SHADOW_OUTCOMES";
const VEHICLE_LOG_SHEET  = "VEHICLE_LOG";
const REGRESSION_SHEET   = "REGRESSION_REPORT";
const MONOTONICITY_SHEET = "MONOTONICITY";

const REGRESSION_COLS   = 12;
const MONOTONICITY_COLS = 15;

// SHADOW_OUTCOMES column indices (0-based)
const O_DATE   = 0;
const O_GAME   = 1;
const O_PROJ   = 4;
const O_ACTUAL = 5;
const O_ERROR  = 6;
const O_ABS    = 7;
const O_FROZEN_ERROR = 13;
const O_FROZEN_ABS = 14;
const O_FROZEN_SOURCE = 15;

// VEHICLE_LOG column indices (0-based)
// Date | Game_ID | Away_Team | Home_Team | Vehicle_Type | Market_Line | Direction |
// Projected_Total | Variance | Final_Decision | Core_Blocker | Edge_Strength | Confidence | Publish_TS
const VL_DATE        = 0;
const VL_GAME_ID     = 1;
const VL_MARKET_LINE = 5;
const VL_DIRECTION   = 6;
const VL_PROJ_TOTAL  = 7;
const VL_VARIANCE    = 8;

// ─── Monotonicity thresholds ──────────────────────────────────────────────────

const MIN_BUCKET_N        = 75;    // minimum n per bucket to include in verdict
const MONOTONE_PASS_FRAC  = 0.80;  // fraction of adjacent pairs that must be monotone
const TOP_BOTTOM_SEP_PCT  = 5.0;   // minimum hit-rate % gap between top and bottom tier

// ─── Fixed edge tiers ─────────────────────────────────────────────────────────

const FIXED_TIERS = [
  { label: "1.50–1.99", edge_min: 1.50, edge_max: 2.00 },
  { label: "2.00–2.49", edge_min: 2.00, edge_max: 2.50 },
  { label: "2.50–2.99", edge_min: 2.50, edge_max: 3.00 },
  { label: "3.00+",     edge_min: 3.00, edge_max: Infinity },
] as const;

// ─── Sheet headers ────────────────────────────────────────────────────────────

const REGRESSION_HEADER = [
  "Window", "N_Games",
  "MAE", "Median_AE", "Bias",
  "Over_Pct", "Under_Pct", "Miss_4Plus_Pct",
  "MAE_Alert", "Bias_Alert", "Miss_Alert",
  "Report_TS",
];

const MONOTONICITY_HEADER = [
  "Direction", "Analysis_Type", "Tier",
  "Edge_Min", "Edge_Max",
  "N_Games", "N_Hits", "N_Pushes",
  "Hit_Rate_Pct",
  "MAE", "Median_AE", "Bias",
  "Hit_Monotone_vs_Prior",
  "MAE_Monotone_vs_Prior",
  "Report_TS",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegressionWindow {
  window: string;
  n_games: number;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  over_pct: number | null;
  under_pct: number | null;
  miss_4plus_pct: number | null;
  alerts: string[];
}

export interface EdgeTierBucket {
  label: string;
  analysis_type: "FIXED_TIER" | "QUINTILE";
  direction: "OVER" | "UNDER";
  edge_min: number;
  edge_max: number;
  n_games: number;
  n_hits: number;
  n_pushes: number;
  /** Hits / (n_games − n_pushes). Null when denominator is 0. */
  hit_rate_pct: number | null;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  /** PASS | FAIL | N/A | INSUFFICIENT_SAMPLE */
  hit_monotone_vs_prior: "PASS" | "FAIL" | "N/A" | "INSUFFICIENT_SAMPLE";
  /** PASS (MAE ≤ prior) | FAIL | N/A | INSUFFICIENT_SAMPLE */
  mae_monotone_vs_prior: "PASS" | "FAIL" | "N/A" | "INSUFFICIENT_SAMPLE";
}

export interface DirectionalMonotonicity {
  direction: "OVER" | "UNDER";
  n_total: number;
  fixed_tiers: EdgeTierBucket[];
  quintile_tiers: EdgeTierBucket[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE";
  verdict_detail: string;
}

export interface MonotonicityResult {
  /** Games matched between VEHICLE_LOG and SHADOW_OUTCOMES. */
  n_joined: number;
  over: DirectionalMonotonicity;
  under: DirectionalMonotonicity;
  overall_verdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE";
  overall_verdict_detail: string;
}

export interface RegressionReportResult {
  status: "success" | "partial" | "failure";
  report_timestamp_utc: string;
  total_outcomes: number;
  windows: RegressionWindow[];
  /** Null when VEHICLE_LOG is absent or has no settled games. */
  monotonicity: MonotonicityResult | null;
  errors: string[];
}

// ─── Part A helpers ───────────────────────────────────────────────────────────

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type OutcomeObs = {
  date: string;
  error: number;
  abs_error: number;
};

function computeWindow(
  rows: OutcomeObs[],
  label: string,
  sinceDate: string | null,
): RegressionWindow {
  const subset = sinceDate ? rows.filter((r) => r.date >= sinceDate) : rows;
  if (subset.length === 0) {
    return {
      window: label, n_games: 0,
      mae: null, median_ae: null, bias: null,
      over_pct: null, under_pct: null, miss_4plus_pct: null,
      alerts: [],
    };
  }
  const abs  = subset.map((r) => r.abs_error);
  const errs = subset.map((r) => r.error);
  const n    = subset.length;
  const mae     = parseFloat((abs.reduce((a, b) => a + b, 0) / n).toFixed(3));
  const medAE   = parseFloat((median(abs) ?? 0).toFixed(3));
  const bias    = parseFloat((errs.reduce((a, b) => a + b, 0) / n).toFixed(3));
  const over    = subset.filter((r) => r.error > 0).length;
  const under   = subset.filter((r) => r.error < 0).length;
  const miss4   = subset.filter((r) => r.abs_error >= 4).length;
  const overPct  = parseFloat((over  / n * 100).toFixed(1));
  const underPct = parseFloat((under / n * 100).toFixed(1));
  const missPct  = parseFloat((miss4 / n * 100).toFixed(1));
  const alerts: string[] = [];
  if (mae > 4.2)               alerts.push(`MAE_HIGH(${mae} > 4.2)`);
  if (Math.abs(bias) > 0.20)   alerts.push(`BIAS_HIGH(${bias.toFixed(3)})`);
  if (missPct > 45)            alerts.push(`MISS_4PLUS_HIGH(${missPct}%)`);
  return {
    window: label, n_games: n,
    mae, median_ae: medAE, bias,
    over_pct: overPct, under_pct: underPct, miss_4plus_pct: missPct,
    alerts,
  };
}

function frozenAuditLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return `${date}_frozen_published`;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][Number(match[2]) - 1] ?? match[2];
  return `${month}${Number(match[3])}_frozen_published`;
}

// ─── Part B helpers ───────────────────────────────────────────────────────────

interface JoinedGame {
  game_id: string;
  direction: "OVER" | "UNDER";
  market_line: number;
  projected_total: number;
  /** projected_total − market_line (signed, from VEHICLE_LOG.Variance) */
  variance: number;
  /** |variance| — always ≥ 0 */
  edge: number;
  actual_total: number;
  /** |projected_total − actual_total| */
  abs_error: number;
  /** projected_total − actual_total */
  error: number;
  hit: boolean;
  push: boolean;
}

function bucketStats(
  games: JoinedGame[],
  label: string,
  analysis_type: EdgeTierBucket["analysis_type"],
  direction: "OVER" | "UNDER",
  edge_min: number,
  edge_max: number,
  hit_monotone: EdgeTierBucket["hit_monotone_vs_prior"],
  mae_monotone: EdgeTierBucket["mae_monotone_vs_prior"],
): EdgeTierBucket {
  const n       = games.length;
  const nHits   = games.filter((g) => g.hit).length;
  const nPushes = games.filter((g) => g.push).length;
  const denom   = n - nPushes;
  const hitRate = denom > 0 ? parseFloat((nHits / denom * 100).toFixed(1)) : null;
  const absErrs = games.map((g) => g.abs_error);
  const errs    = games.map((g) => g.error);
  return {
    label, analysis_type, direction,
    edge_min: edge_min === -Infinity ? -999 : edge_min,
    edge_max: edge_max ===  Infinity ?  999 : edge_max,
    n_games: n,
    n_hits: nHits,
    n_pushes: nPushes,
    hit_rate_pct: hitRate,
    mae:       n > 0 ? parseFloat((absErrs.reduce((a, b) => a + b, 0) / n).toFixed(3)) : null,
    median_ae: parseFloat((median(absErrs) ?? 0).toFixed(3)),
    bias:      n > 0 ? parseFloat((errs.reduce((a, b) => a + b, 0) / n).toFixed(3)) : null,
    hit_monotone_vs_prior: hit_monotone,
    mae_monotone_vs_prior: mae_monotone,
  };
}

function fillMonotonicity(buckets: EdgeTierBucket[]): void {
  for (let i = 1; i < buckets.length; i++) {
    const curr = buckets[i]!;
    const prev = buckets[i - 1]!;
    // Hit monotonicity
    if (curr.n_games < MIN_BUCKET_N || prev.n_games < MIN_BUCKET_N) {
      curr.hit_monotone_vs_prior = "INSUFFICIENT_SAMPLE";
      curr.mae_monotone_vs_prior = "INSUFFICIENT_SAMPLE";
    } else {
      curr.hit_monotone_vs_prior =
        curr.hit_rate_pct !== null && prev.hit_rate_pct !== null
          ? curr.hit_rate_pct >= prev.hit_rate_pct ? "PASS" : "FAIL"
          : "N/A";
      curr.mae_monotone_vs_prior =
        curr.mae !== null && prev.mae !== null
          ? curr.mae <= prev.mae ? "PASS" : "FAIL"
          : "N/A";
    }
  }
}

function buildVerdict(buckets: EdgeTierBucket[]): { verdict: DirectionalMonotonicity["verdict"]; detail: string } {
  // Only include tiers with sufficient sample for the verdict comparison.
  // Crucially, adjacency is re-established on this filtered list so that a
  // skipped low-n bucket does not orphan the next eligible tier's comparison.
  const eligible = buckets.filter((b) => b.n_games >= MIN_BUCKET_N);
  if (eligible.length < 2) {
    return {
      verdict: "INSUFFICIENT_SAMPLE",
      detail: `Only ${eligible.length} tier(s) with n ≥ ${MIN_BUCKET_N} — need at least 2`,
    };
  }

  // Re-compute monotonicity directly on adjacent eligible pairs.
  // Do NOT use the pre-computed hit_monotone_vs_prior labels from fillMonotonicity:
  // those were annotated against full-list adjacency and would misrepresent
  // comparisons when low-n tiers are skipped.
  let hitPass = 0, hitFail = 0, maePass = 0, maeFail = 0;
  for (let i = 1; i < eligible.length; i++) {
    const curr = eligible[i]!;
    const prev = eligible[i - 1]!;
    if (curr.hit_rate_pct !== null && prev.hit_rate_pct !== null) {
      if (curr.hit_rate_pct >= prev.hit_rate_pct) hitPass++;
      else                                         hitFail++;
    }
    if (curr.mae !== null && prev.mae !== null) {
      if (curr.mae <= prev.mae) maePass++;
      else                      maeFail++;
    }
  }
  const totalPairs = eligible.length - 1;
  const hitPct = totalPairs > 0 ? hitPass / totalPairs : 1;
  const maePct = totalPairs > 0 ? maePass / totalPairs : 1;

  // Top-vs-bottom separation
  const firstHit = eligible[0]!.hit_rate_pct ?? 0;
  const lastHit  = eligible[eligible.length - 1]!.hit_rate_pct ?? 0;
  const separation = lastHit - firstHit;

  const hitOk  = hitPct  >= MONOTONE_PASS_FRAC;
  const maeOk  = maePct  >= MONOTONE_PASS_FRAC;
  const sepOk  = separation >= TOP_BOTTOM_SEP_PCT;

  const passed = hitOk && maeOk && sepOk;

  const detail = [
    `Hit monotone: ${hitPass}/${totalPairs} (${(hitPct * 100).toFixed(0)}%) — ${hitOk ? "OK" : "FAIL"}`,
    `MAE monotone: ${maePass}/${totalPairs} (${(maePct * 100).toFixed(0)}%) — ${maeOk ? "OK" : "FAIL"}`,
    `Top-bottom separation: ${separation.toFixed(1)} pp (need ≥ ${TOP_BOTTOM_SEP_PCT}) — ${sepOk ? "OK" : "FAIL"}`,
  ].join("; ");

  return { verdict: passed ? "PASS" : "FAIL", detail };
}

function computeDirectional(
  games: JoinedGame[],
  direction: "OVER" | "UNDER",
): DirectionalMonotonicity {
  const n = games.length;

  // ── Fixed tiers ──
  const fixed_tiers: EdgeTierBucket[] = FIXED_TIERS.map((t) => {
    const inTier = games.filter((g) => g.edge >= t.edge_min && g.edge < t.edge_max);
    return bucketStats(inTier, t.label, "FIXED_TIER", direction, t.edge_min, t.edge_max, "N/A", "N/A");
  });
  fillMonotonicity(fixed_tiers);

  // ── Equal-count quintiles ──
  const sorted = [...games].sort((a, b) => a.edge - b.edge);
  const quintile_tiers: EdgeTierBucket[] = [];
  if (sorted.length > 0) {
    const base  = Math.floor(sorted.length / 5);
    const extra = sorted.length % 5;
    let start   = 0;
    for (let q = 0; q < 5; q++) {
      const size  = base + (q < extra ? 1 : 0);
      const slice = sorted.slice(start, start + size);
      start      += size;
      if (slice.length === 0) continue;
      const eMin  = slice[0]!.edge;
      const eLast = slice[slice.length - 1]!.edge;
      quintile_tiers.push(
        bucketStats(
          slice,
          `Q${q + 1} (${eMin.toFixed(2)}–${eLast.toFixed(2)})`,
          "QUINTILE", direction,
          eMin, eLast,
          q === 0 ? "N/A" : "N/A",  // filled by fillMonotonicity below
          q === 0 ? "N/A" : "N/A",
        ),
      );
    }
    fillMonotonicity(quintile_tiers);
  }

  const { verdict, detail } = buildVerdict(fixed_tiers);

  return {
    direction,
    n_total: n,
    fixed_tiers,
    quintile_tiers,
    verdict,
    verdict_detail: n === 0 ? `No ${direction} picks with settled outcomes` : detail,
  };
}

function computeMonotonicity(joined: JoinedGame[]): MonotonicityResult {
  // Separate by direction; exclude NONE (already filtered at join time)
  const overGames  = joined.filter((g) => g.direction === "OVER");
  const underGames = joined.filter((g) => g.direction === "UNDER");

  const over  = computeDirectional(overGames,  "OVER");
  const under = computeDirectional(underGames, "UNDER");

  // Overall verdict
  let overall_verdict: MonotonicityResult["overall_verdict"];
  let overall_verdict_detail: string;

  if (overGames.length === 0 && underGames.length === 0) {
    overall_verdict        = "INSUFFICIENT_SAMPLE";
    overall_verdict_detail = "No directional picks with settled outcomes";
  } else if (overGames.length === 0) {
    overall_verdict        = under.verdict;
    overall_verdict_detail = `UNDER only: ${under.verdict_detail}`;
  } else if (underGames.length === 0) {
    overall_verdict        = over.verdict;
    overall_verdict_detail = `OVER only: ${over.verdict_detail}`;
  } else {
    const verdicts = [over.verdict, under.verdict];
    if (verdicts.every((v) => v === "PASS"))                  overall_verdict = "PASS";
    else if (verdicts.includes("FAIL"))                       overall_verdict = "FAIL";
    else                                                       overall_verdict = "INSUFFICIENT_SAMPLE";
    overall_verdict_detail = `OVER: ${over.verdict_detail} | UNDER: ${under.verdict_detail}`;
  }

  return {
    n_joined: joined.length,
    over,
    under,
    overall_verdict,
    overall_verdict_detail,
  };
}

// ─── Join VEHICLE_LOG × SHADOW_OUTCOMES ──────────────────────────────────────

async function readVehicleLog(wbId: string): Promise<Map<string, { direction: "OVER" | "UNDER"; market_line: number; projected_total: number; variance: number }>> {
  const map = new Map<string, { direction: "OVER" | "UNDER"; market_line: number; projected_total: number; variance: number }>();
  try {
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A2:N20000`);
    for (const row of (resp.values ?? []) as string[][]) {
      const gameId    = row[VL_GAME_ID];
      const dir       = row[VL_DIRECTION];
      const line      = parseFloat(row[VL_MARKET_LINE] ?? "");
      const proj      = parseFloat(row[VL_PROJ_TOTAL] ?? "");
      const variance  = parseFloat(row[VL_VARIANCE] ?? "");
      if (!gameId || (dir !== "OVER" && dir !== "UNDER")) continue;
      if (!Number.isFinite(line) || !Number.isFinite(proj) || !Number.isFinite(variance)) continue;
      // If multiple publish runs logged the same game, keep the first (earliest prediction)
      if (!map.has(gameId)) {
        map.set(gameId, { direction: dir as "OVER" | "UNDER", market_line: line, projected_total: proj, variance });
      }
    }
  } catch {
    // VEHICLE_LOG absent or unreadable
  }
  return map;
}

async function joinVehicleOutcomes(wbId: string): Promise<{ joined: JoinedGame[]; errors: string[] }> {
  const errors: string[] = [];
  const joined: JoinedGame[] = [];

  let vehicleMap: Map<string, { direction: "OVER" | "UNDER"; market_line: number; projected_total: number; variance: number }>;
  try {
    vehicleMap = await readVehicleLog(wbId);
  } catch (err: unknown) {
    errors.push(`VEHICLE_LOG read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { joined, errors };
  }

  if (vehicleMap.size === 0) return { joined, errors };

  // Read SHADOW_OUTCOMES — keyed by game_id (col 1)
  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A2:H20000`);
    for (const row of (resp.values ?? []) as string[][]) {
      const gameId = row[O_GAME];
      if (!gameId) continue;
      const vehicle = vehicleMap.get(gameId);
      if (!vehicle) continue;

      const proj   = parseFloat(row[O_PROJ]   ?? "");
      const actual = parseFloat(row[O_ACTUAL] ?? "");
      const err_v  = parseFloat(row[O_ERROR]  ?? "");
      const absE   = parseFloat(row[O_ABS]    ?? "");
      if (!Number.isFinite(actual)) continue;

      const { direction, market_line, projected_total, variance } = vehicle;
      const edge  = Math.abs(variance);
      const push  = actual === market_line;
      const hit   = !push && (
        (direction === "OVER"  && actual > market_line) ||
        (direction === "UNDER" && actual < market_line)
      );

      // Prefer SHADOW_OUTCOMES error (uses repaired projection); fall back to variance-derived
      const projForError = Number.isFinite(proj) ? proj : projected_total;
      const errorVal     = Number.isFinite(err_v) ? err_v : parseFloat((projForError - actual).toFixed(2));
      const absErrVal    = Number.isFinite(absE)  ? absE  : Math.abs(errorVal);

      joined.push({
        game_id:        gameId,
        direction,
        market_line,
        projected_total,
        variance,
        edge,
        actual_total:   actual,
        abs_error:      absErrVal,
        error:          errorVal,
        hit,
        push,
      });
    }
  } catch (err: unknown) {
    errors.push(`SHADOW_OUTCOMES read (join) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { joined, errors };
}

// ─── Sheet writers ────────────────────────────────────────────────────────────

function tierToRow(t: EdgeTierBucket, ts: string): (string | number)[] {
  return [
    t.direction,
    t.analysis_type,
    t.label,
    t.edge_min,
    t.edge_max === 999 ? "∞" : t.edge_max,
    t.n_games,
    t.n_hits,
    t.n_pushes,
    t.hit_rate_pct ?? "",
    t.mae          ?? "",
    t.median_ae    ?? "",
    t.bias         ?? "",
    t.hit_monotone_vs_prior,
    t.mae_monotone_vs_prior,
    ts,
  ];
}

async function writeMonotonicitySheet(
  mono: MonotonicityResult,
  ts: string,
  wbId: string,
): Promise<void> {
  await expandSheetColumns(wbId, MONOTONICITY_SHEET, MONOTONICITY_COLS);
  await clearRange(wbId, `${MONOTONICITY_SHEET}!A1:O200`);
  await writeRange(wbId, `${MONOTONICITY_SHEET}!A1:O1`, [MONOTONICITY_HEADER]);

  const rows: (string | number)[][] = [];

  for (const dir of [mono.over, mono.under]) {
    if (dir.n_total === 0) continue;
    for (const t of dir.fixed_tiers)   rows.push(tierToRow(t, ts));
    for (const t of dir.quintile_tiers) rows.push(tierToRow(t, ts));
    // Direction summary row
    rows.push([
      dir.direction, "SUMMARY", dir.verdict, "", "",
      dir.n_total, "", "", "", "", "", "",
      dir.verdict_detail, "", ts,
    ]);
  }

  // Overall verdict row
  rows.push([
    "OVERALL", "VERDICT", mono.overall_verdict, "", "",
    mono.n_joined, "", "", "", "", "", "",
    mono.overall_verdict_detail, "", ts,
  ]);

  if (rows.length > 0) {
    await writeRange(wbId, `${MONOTONICITY_SHEET}!A2:O${1 + rows.length}`, rows);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runRegressionReport(
  options: { workbookId?: string; writeSheets?: boolean } = {},
): Promise<RegressionReportResult> {
  const ts    = new Date().toISOString();
  const wbId  = options.workbookId ?? WORKBOOK_ID;
  const write = options.writeSheets ?? false;
  const errors: string[] = [];

  logger.info("MODULE_15: Regression report starting");

  // ── Part A: Read SHADOW_OUTCOMES for regression windows ──
  let outcomeRows: OutcomeObs[] = [];
  const frozenRowsByDate = new Map<string, OutcomeObs[]>();
  let totalOutcomes = 0;

  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:AG5000`);
    const raw  = (resp.values ?? []) as string[][];
    const data = raw.slice(1).filter(
      (r) => r[O_DATE] && r[O_ERROR] !== undefined && r[O_ABS] !== undefined,
    );
    totalOutcomes = data.length;
    outcomeRows = data.map((r) => {
      const date = r[O_DATE] ?? "";
      const hasFrozen = r[O_FROZEN_SOURCE] === "FROZEN_VEHICLE_LOG";
      const observation = {
        date,
        error: parseFloat((hasFrozen ? r[O_FROZEN_ERROR] : r[O_ERROR]) ?? "0") || 0,
        abs_error: parseFloat((hasFrozen ? r[O_FROZEN_ABS] : r[O_ABS]) ?? "0") || 0,
      };
      if (hasFrozen) {
        const bucket = frozenRowsByDate.get(date) ?? [];
        bucket.push(observation);
        frozenRowsByDate.set(date, bucket);
      }
      return observation;
    });
    logger.info({ rows: totalOutcomes }, "MODULE_15: SHADOW_OUTCOMES loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    return {
      status: "failure",
      report_timestamp_utc: ts,
      total_outcomes: 0,
      windows: [],
      monotonicity: null,
      errors,
    };
  }

  // ── Regression windows ──
  const today    = ts.slice(0, 10);
  const d7       = new Date(today + "T12:00:00Z");
  d7.setUTCDate(d7.getUTCDate() - 7);
  const d30      = new Date(today + "T12:00:00Z");
  d30.setUTCDate(d30.getUTCDate() - 30);
  const ytdStart = today.slice(0, 4) + "-01-01";

  const windows: RegressionWindow[] = [
    computeWindow(outcomeRows, "7d",  d7.toISOString().slice(0, 10)),
    computeWindow(outcomeRows, "30d", d30.toISOString().slice(0, 10)),
    computeWindow(outcomeRows, "ytd", ytdStart),
    computeWindow(outcomeRows, "all", null),
  ];
  const frozenAuditWindows = [...frozenRowsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rows]) => computeWindow(rows, frozenAuditLabel(date), null));

  const allAlerts = windows.flatMap((w) => w.alerts.map((a) => `${w.window}:${a}`));
  if (allAlerts.length > 0) {
    logger.warn({ alerts: allAlerts }, "MODULE_15: Regression alerts triggered");
  }

  // ── Part B: Monotonicity analysis ──
  let monotonicity: MonotonicityResult | null = null;

  const { joined, errors: joinErrors } = await joinVehicleOutcomes(wbId);
  errors.push(...joinErrors);

  if (joined.length > 0) {
    monotonicity = computeMonotonicity(joined);
    logger.info(
      {
        n_joined:    monotonicity.n_joined,
        over_n:      monotonicity.over.n_total,
        under_n:     monotonicity.under.n_total,
        verdict:     monotonicity.overall_verdict,
      },
      "MODULE_15: Monotonicity analysis complete",
    );
  } else {
    logger.info("MODULE_15: No joined games for monotonicity analysis");
  }

  // ── Write sheets ──
  if (write && totalOutcomes > 0) {
    // Regression report sheet
    try {
      await expandSheetColumns(wbId, REGRESSION_SHEET, REGRESSION_COLS);
      const sheetRows = [...windows, ...frozenAuditWindows].map((w) => [
        w.window, w.n_games,
        w.mae      ?? "", w.median_ae ?? "", w.bias     ?? "",
        w.over_pct ?? "", w.under_pct ?? "", w.miss_4plus_pct ?? "",
        w.alerts.some((a) => a.startsWith("MAE"))  ? "ALERT" : "",
        w.alerts.some((a) => a.startsWith("BIAS")) ? "ALERT" : "",
        w.alerts.some((a) => a.startsWith("MISS")) ? "ALERT" : "",
        ts,
      ]);
      await writeRange(wbId, `${REGRESSION_SHEET}!A1:L1`, [REGRESSION_HEADER]);
      await clearRange(wbId, `${REGRESSION_SHEET}!A2:L5000`);
      await writeRange(wbId, `${REGRESSION_SHEET}!A2:L${1 + sheetRows.length}`, sheetRows);
      logger.info("MODULE_15: Regression report written");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Regression sheet write failed: ${msg}`);
      logger.warn({ err: msg }, "MODULE_15: Regression sheet write failed");
    }

    // Monotonicity sheet
    if (monotonicity) {
      try {
        await writeMonotonicitySheet(monotonicity, ts, wbId);
        logger.info("MODULE_15: Monotonicity sheet written");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Monotonicity sheet write failed: ${msg}`);
        logger.warn({ err: msg }, "MODULE_15: Monotonicity sheet write failed");
      }
    }
  }

  const status = errors.length === 0 ? "success" : totalOutcomes > 0 ? "partial" : "failure";

  logger.info(
    { windows: windows.map((w) => ({ w: w.window, n: w.n_games, mae: w.mae })) },
    "MODULE_15: Regression report complete",
  );

  return {
    status,
    report_timestamp_utc: ts,
    total_outcomes: totalOutcomes,
    windows,
    monotonicity,
    errors,
  };
}
