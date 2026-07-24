/**
 * Module 15: Regression Monitoring
 *
 * Reads SHADOW_OUTCOMES and computes trailing performance windows:
 *   • 7-day   • 30-day   • year-to-date   • all-time
 *
 * Alerts fire when a window materially degrades vs the commissioned baseline:
 *   MAE > 4.2, |bias| > 0.20, miss_4plus > 45 %
 *
 * Endpoint: GET /api/pipeline/regression[?write_sheets=true]
 */

import { readRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

const OUTCOMES_SHEET   = "SHADOW_OUTCOMES";
const REGRESSION_SHEET = "REGRESSION_REPORT";
const REGRESSION_COLS  = 12;

// SHADOW_OUTCOMES column indices (0-based)
// Date | Game_ID | Away | Home | Repaired_Proj | Actual | Error | Abs_Error | Park_Src | Away_Src | Home_Src | Settlement_TS
const O_DATE  = 0;
const O_ERROR = 6;
const O_ABS   = 7;

const REGRESSION_HEADER = [
  "Window", "N_Games",
  "MAE", "Median_AE", "Bias",
  "Over_Pct", "Under_Pct", "Miss_4Plus_Pct",
  "MAE_Alert", "Bias_Alert", "Miss_Alert",
  "Report_TS",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegressionWindow {
  window: "7d" | "30d" | "ytd" | "all";
  n_games: number;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  over_pct: number | null;
  under_pct: number | null;
  miss_4plus_pct: number | null;
  /** Human-readable alert strings, e.g. "MAE_HIGH(4.3 > 4.2)" */
  alerts: string[];
}

export interface RegressionReportResult {
  status: "success" | "partial" | "failure";
  report_timestamp_utc: string;
  total_outcomes: number;
  windows: RegressionWindow[];
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type OutcomeObs = { date: string; error: number; abs_error: number };

function computeWindow(
  rows: OutcomeObs[],
  label: RegressionWindow["window"],
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

  const mae    = parseFloat((abs.reduce((a, b) => a + b, 0) / n).toFixed(3));
  const medAE  = parseFloat((median(abs) ?? 0).toFixed(3));
  const bias   = parseFloat((errs.reduce((a, b) => a + b, 0) / n).toFixed(3));
  const over   = subset.filter((r) => r.error > 0).length;
  const under  = subset.filter((r) => r.error < 0).length;
  const miss4  = subset.filter((r) => r.abs_error >= 4).length;

  const overPct  = parseFloat((over  / n * 100).toFixed(1));
  const underPct = parseFloat((under / n * 100).toFixed(1));
  const missPct  = parseFloat((miss4 / n * 100).toFixed(1));

  // Alert thresholds — calibrated against the 1,115-game commissioned baseline (MAE 3.662)
  const alerts: string[] = [];
  if (mae > 4.2)               alerts.push(`MAE_HIGH(${mae} > 4.2)`);
  if (Math.abs(bias) > 0.20)   alerts.push(`BIAS_HIGH(${bias.toFixed(3)})`);
  if (missPct > 45)            alerts.push(`MISS_4PLUS_HIGH(${missPct}%)`);

  return {
    window: label,
    n_games: n,
    mae, median_ae: medAE, bias,
    over_pct: overPct, under_pct: underPct, miss_4plus_pct: missPct,
    alerts,
  };
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

  // ── Read SHADOW_OUTCOMES ──
  let outcomeRows: OutcomeObs[] = [];
  let totalOutcomes = 0;

  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:H5000`);
    const raw  = (resp.values ?? []) as string[][];
    const data = raw.slice(1).filter(
      (r) => r[O_DATE] && r[O_ERROR] !== undefined && r[O_ABS] !== undefined,
    );
    totalOutcomes = data.length;
    outcomeRows = data.map((r) => ({
      date:      r[O_DATE] ?? "",
      error:     parseFloat(r[O_ERROR] ?? "0") || 0,
      abs_error: parseFloat(r[O_ABS]   ?? "0") || 0,
    }));
    logger.info({ rows: totalOutcomes }, "MODULE_15: SHADOW_OUTCOMES loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    return {
      status: "failure",
      report_timestamp_utc: ts,
      total_outcomes: 0,
      windows: [],
      errors,
    };
  }

  // ── Compute date boundaries ──
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

  const allAlerts = windows.flatMap((w) => w.alerts.map((a) => `${w.window}:${a}`));
  if (allAlerts.length > 0) {
    logger.warn({ alerts: allAlerts }, "MODULE_15: Regression alerts triggered");
  }

  // ── Optionally write REGRESSION_REPORT sheet (always overwritten — fresh compute) ──
  if (write && totalOutcomes > 0) {
    try {
      await expandSheetColumns(wbId, REGRESSION_SHEET, REGRESSION_COLS);
      const sheetRows = windows.map((w) => [
        w.window,
        w.n_games,
        w.mae      ?? "",
        w.median_ae ?? "",
        w.bias     ?? "",
        w.over_pct  ?? "",
        w.under_pct ?? "",
        w.miss_4plus_pct ?? "",
        w.alerts.some((a) => a.startsWith("MAE"))  ? "ALERT" : "",
        w.alerts.some((a) => a.startsWith("BIAS")) ? "ALERT" : "",
        w.alerts.some((a) => a.startsWith("MISS")) ? "ALERT" : "",
        ts,
      ]);
      await writeRange(wbId, `${REGRESSION_SHEET}!A1:L1`, [REGRESSION_HEADER]);
      await writeRange(wbId, `${REGRESSION_SHEET}!A2:L${1 + sheetRows.length}`, sheetRows);
      logger.info("MODULE_15: Regression report written to sheet");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Regression sheet write failed: ${msg}`);
      logger.warn({ err: msg }, "MODULE_15: Regression sheet write failed — result still returned");
    }
  }

  const status = errors.length === 0 ? "success" : totalOutcomes > 0 ? "partial" : "failure";

  logger.info(
    { windows: windows.map((w) => ({ w: w.window, n: w.n_games, mae: w.mae, alerts: w.alerts.length })) },
    "MODULE_15: Regression report complete",
  );

  return {
    status,
    report_timestamp_utc: ts,
    total_outcomes: totalOutcomes,
    windows,
    errors,
  };
}
