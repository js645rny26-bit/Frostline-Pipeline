import { Router, type IRouter } from "express";
import { createOptimizedWorkbook } from "../lib/workbook/workbookSetup.js";
import { getTodayDateStr } from "../lib/pipeline/config.js";

const router: IRouter = Router();

router.post("/workbook/create", async (req, res): Promise<void> => {
  const dateParam = req.query.date;
  const date = typeof dateParam === "string" ? dateParam : getTodayDateStr();
  try {
    const result = await createOptimizedWorkbook(date);
    const statusCode = result.errors.length > 0 ? 207 : 200;
    res.status(statusCode).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
