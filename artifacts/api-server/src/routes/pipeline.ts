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
import { WORKBOOK_ID } from "../lib/sheets/client.js";

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

export default router;
