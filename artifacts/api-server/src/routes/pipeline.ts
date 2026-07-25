import { Router, type IRouter } from "express";
import {
  GetPipelineSlateQueryParams,
  GetPipelineSummaryQueryParams,
  GetPipelineScheduleQueryParams,
} from "@workspace/api-zod";
import { runPipeline, getPipelineSummary, runFullPipeline } from "../lib/pipeline/runner.js";
import { fetchMlbSchedule } from "../lib/pipeline/module01_mlbStatsApi.js";
import { getTodayDateStr } from "../lib/pipeline/config.js";
import { runHistoricalReplay } from "../lib/pipeline/module13_historicalReplay.js";
import { runShadowSettlement } from "../lib/pipeline/module14_shadowSettlement.js";
import { runRegressionReport } from "../lib/pipeline/module15_regressionReport.js";
import { runStarterAudit } from "../lib/pipeline/module16_starterAudit.js";
import { runPostmortem } from "../lib/pipeline/module17_vehiclePostmortem.js";
import { runSurvivalGateReplay } from "../lib/pipeline/module18_survivalGateReplay.js";
import { runBoardLockReplay } from "../lib/pipeline/module19_boardLockReplay.js";
import { WORKBOOK_ID, writeRange, clearRange, expandSheetColumns } from "../lib/sheets/client.js";
import { WORKBOOK_SCHEMA, generateSchemaReferenceRows, WORKBOOK_SCHEMA_VERSION } from "../lib/workbook/workbookSchema.js";

const router: IRouter = Router();


router.get("/pipeline/slate", async (req, res): Promise<void> => {
  const parsed = GetPipelineSlateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? getTodayDateStr();
  const slate = await runPipeline(date);
  res.json(slate);
});

router.get("/pipeline/summary", async (req, res): Promise<void> => {
  const parsed = GetPipelineSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? getTodayDateStr();
  const summary = await getPipelineSummary(date);
  res.json(summary);
});

router.get("/pipeline/schedule", async (req, res): Promise<void> => {
  const parsed = GetPipelineScheduleQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? getTodayDateStr();
  const schedule = await fetchMlbSchedule(date);
  res.json(schedule);
});

router.post("/pipeline/publish", async (req, res): Promise<void> => {
  const dateParam = req.query.date;
  const workbookParam = req.query.workbook_id;
  const date = typeof dateParam === "string" ? dateParam : getTodayDateStr();
  const workbookId = typeof workbookParam === "string" && workbookParam ? workbookParam : undefined;
  try {
    const result = await runFullPipeline(date, workbookId);
    const statusCode = result.pipeline_status === "failure" ? 500 : 200;
    res.status(statusCode).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /pipeline/replay
 * Run historical replay across 5 projection variants for a date range.
 *
 * Query params:
 *   start_date   — ISO date string (required), e.g. 2026-07-01
 *   end_date     — ISO date string (required), e.g. 2026-07-20
 *   write_sheets — "true" to write REPLAY_RESULTS + REPLAY_METRICS to the workbook
 *   workbook_id  — override workbook (optional)
 *   max_dates    — integer override for the date-range cap (default 30, hard ceiling 120)
 *
 * Returns ReplayResult JSON.
 */
router.get("/pipeline/replay", async (req, res): Promise<void> => {
  const { start_date, end_date, write_sheets, workbook_id, max_dates } = req.query;

  if (typeof start_date !== "string" || typeof end_date !== "string") {
    res.status(400).json({ error: "start_date and end_date are required query params (YYYY-MM-DD)" });
    return;
  }

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_RE.test(start_date) || !ISO_RE.test(end_date)) {
    res.status(400).json({ error: "start_date and end_date must be YYYY-MM-DD format" });
    return;
  }

  if (start_date > end_date) {
    res.status(400).json({ error: "start_date must be ≤ end_date" });
    return;
  }

  const maxDatesOverride = typeof max_dates === "string" ? parseInt(max_dates, 10) : undefined;

  try {
    const result = await runHistoricalReplay(start_date, end_date, {
      writeSheets: write_sheets === "true",
      workbookId:  typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
      maxDates:    Number.isFinite(maxDatesOverride) ? maxDatesOverride : undefined,
    });
    const statusCode = result.status === "failure" ? 500 : 200;
    res.status(statusCode).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /pipeline/settle
 * Settle shadow projections for a given date by pairing them with actual
 * MLB final scores. Appends settled rows to the SHADOW_OUTCOMES sheet.
 *
 * Query params:
 *   date        — YYYY-MM-DD (optional; defaults to yesterday)
 *   workbook_id — override workbook (optional)
 */
router.get("/pipeline/settle", async (req, res): Promise<void> => {
  const { date, workbook_id } = req.query;

  let settleDate: string;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    settleDate = date;
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    settleDate = d.toISOString().slice(0, 10);
  }

  try {
    const result = await runShadowSettlement(settleDate, {
      workbookId: typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /pipeline/regression
 * Compute trailing regression metrics from SHADOW_OUTCOMES.
 * Windows: 7d, 30d, ytd, all. Alerts fire on material degradation.
 *
 * Query params:
 *   write_sheets  — "true" to write REGRESSION_REPORT sheet (optional)
 *   workbook_id   — override workbook (optional)
 */
router.get("/pipeline/regression", async (req, res): Promise<void> => {
  const { write_sheets, workbook_id } = req.query;
  try {
    const result = await runRegressionReport({
      writeSheets: write_sheets === "true",
      workbookId:  typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /pipeline/starter-audit
 * Join SHADOW_HISTORY pitcher names with SHADOW_OUTCOMES errors.
 * Returns per-pitcher MAE, bias, and directional flag.
 *
 * Query params:
 *   min_games    — minimum settled games to include a pitcher (default 3)
 *   write_sheets — "true" to write STARTER_AUDIT sheet (optional)
 *   workbook_id  — override workbook (optional)
 */
router.get("/pipeline/starter-audit", async (req, res): Promise<void> => {
  const { min_games, write_sheets, workbook_id } = req.query;
  const minGames = min_games ? parseInt(String(min_games), 10) : 3;
  try {
    const result = await runStarterAudit({
      minGames:    Number.isFinite(minGames) ? minGames : 3,
      writeSheets: write_sheets === "true",
      workbookId:  typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /pipeline/postmortem
 * Grade vehicle selections against settled outcomes for a given date.
 * Separates thesis accuracy (direction correct?) from ticket result (covered?).
 *
 * Query params:
 *   date         — YYYY-MM-DD (required)
 *   write_sheets — "true" to append to VEHICLE_POSTMORTEM sheet (optional)
 *   workbook_id  — override workbook (optional)
 */
router.get("/pipeline/postmortem", async (req, res): Promise<void> => {
  const { date, write_sheets, workbook_id } = req.query;

  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    return;
  }

  try {
    const result = await runPostmortem(date, {
      writeSheets: write_sheets === "true",
      workbookId:  typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /pipeline/survival-replay
 * Retroactively applies the Over survival gate to historical VEHICLE_LOG data.
 *
 * Reconstructs baseball_only_projection = projected_total / combined_multiplier
 * (exact, from SHADOW_HISTORY multiplier data) and re-grades every OVER pick
 * in the date range against the gate thresholds.
 *
 * Query params:
 *   start_date   — YYYY-MM-DD (required)
 *   end_date     — YYYY-MM-DD (required)
 *   write_sheets — "true" to write SURVIVAL_GATE_REPLAY sheet (optional)
 *   workbook_id  — override workbook (optional)
 */
router.get("/pipeline/survival-replay", async (req, res): Promise<void> => {
  const { start_date, end_date, write_sheets, workbook_id } = req.query;

  if (!start_date || typeof start_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    res.status(400).json({ error: "start_date query param required (YYYY-MM-DD)" });
    return;
  }
  if (!end_date || typeof end_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    res.status(400).json({ error: "end_date query param required (YYYY-MM-DD)" });
    return;
  }

  try {
    const result = await runSurvivalGateReplay(start_date, end_date, {
      writeSheets: write_sheets === "true",
      workbookId:  typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /pipeline/repair-headers
 * Re-writes row 1 for every sheet in WORKBOOK_SCHEMA and refreshes
 * SCHEMA_REFERENCE with the current column definitions.
 *
 * Run this once after any schema version change or when the auditor
 * finds unnamed / stale header rows in the live workbook.
 *
 * Query params:
 *   workbook_id — override workbook (optional)
 */
router.get("/pipeline/repair-headers", async (req, res): Promise<void> => {
  const { workbook_id } = req.query;
  const wbId = typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID;
  const repaired: string[] = [];
  const errors: string[] = [];

  // ── Re-write row 1 for every schema-defined sheet ──────────────────────────
  for (const sheet of WORKBOOK_SCHEMA) {
    if (sheet.columns.length === 0) continue;

    // Build a sparse row array long enough to hold all named columns.
    const maxIndex = Math.max(...sheet.columns.map((c) => c.index));
    const headerRow: string[] = Array(maxIndex + 1).fill("");
    for (const col of sheet.columns) {
      headerRow[col.index] = col.name;
    }

    // Convert column index to A1 column letter(s)
    function colLetter(n: number): string {
      let s = "";
      let i = n + 1;
      while (i > 0) {
        const r = (i - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        i = Math.floor((i - 1) / 26);
      }
      return s;
    }
    const lastCol = colLetter(maxIndex);
    const range = `${sheet.name}!A1:${lastCol}1`;

    try {
      await expandSheetColumns(wbId, sheet.name, maxIndex + 1);
      await writeRange(wbId, range, [headerRow]);
      repaired.push(sheet.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${sheet.name}: ${msg}`);
    }
  }

  // ── Refresh SCHEMA_REFERENCE content ────────────────────────────────────────
  let schemaRefRows = 0;
  try {
    const schemaRows = generateSchemaReferenceRows();
    await clearRange(wbId, "SCHEMA_REFERENCE!A2:J5000");
    await writeRange(wbId, "SCHEMA_REFERENCE!A2", schemaRows);
    schemaRefRows = schemaRows.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SCHEMA_REFERENCE: ${msg}`);
  }

  res.status(errors.length > 0 ? 207 : 200).json({
    status:               errors.length === 0 ? "success" : "partial",
    schema_version:       WORKBOOK_SCHEMA_VERSION,
    sheets_repaired:      repaired.length,
    schema_ref_rows:      schemaRefRows,
    repaired_sheets:      repaired,
    errors,
  });
});

/**
 * GET /pipeline/board-lock-replay
 * Retroactively compute per-game board lock status for a historical date.
 * Shows which games would have been LOCKED_IN, LOCKED_OUT, or PRE_LOCK at
 * a given UTC time — confirming whether the gate would have stopped late
 * promotions.
 *
 * Query params:
 *   date             — YYYY-MM-DD (required)
 *   query_time_utc   — ISO UTC timestamp to evaluate lock status at
 *                      (optional; defaults to the earliest lock cutoff on the slate)
 *   write_sheets     — "true" to write BOARD_LOCK_REPLAY sheet (optional)
 *   workbook_id      — override workbook (optional)
 *
 * Returns BoardLockReplayResult JSON.
 *
 * July 24, 2026 replay (query_time_utc=2026-07-24T20:50:35Z):
 *   LOCKED_IN  (2): CHC_PIT, ARI_WSN  — both CORE at their 4:40/4:45 PM ET cutoffs
 *   LOCKED_OUT (3): COL_MIL, KCR_DET, NYY_PHI  — NO_CORE; any late promotion blocked
 *   PRE_LOCK  (10): all games with first pitch after 6:50 PM ET
 *   NO_SCHED   (4): 20260725_* IDs from early run — no scheduled_utc_time, never lock
 */
router.get("/pipeline/board-lock-replay", async (req, res): Promise<void> => {
  const { date, query_time_utc, write_sheets, workbook_id } = req.query;

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    return;
  }

  try {
    const result = await runBoardLockReplay(date, {
      queryTimeUtc:  typeof query_time_utc === "string" ? query_time_utc : undefined,
      writeSheets:   write_sheets === "true",
      workbookId:    typeof workbook_id === "string" && workbook_id ? workbook_id : undefined,
    });
    res.status(result.status === "failure" ? 500 : 200).json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
