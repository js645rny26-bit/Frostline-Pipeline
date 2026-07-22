import { Router, type IRouter } from "express";
import {
  GetPipelineSlateQueryParams,
  GetPipelineSummaryQueryParams,
  GetPipelineScheduleQueryParams,
} from "@workspace/api-zod";
import { runPipeline, getPipelineSummary, runFullPipeline } from "../lib/pipeline/runner.js";
import { fetchMlbSchedule } from "../lib/pipeline/module01_mlbStatsApi.js";
import { getTodayDateStr } from "../lib/pipeline/config.js";

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

export default router;
