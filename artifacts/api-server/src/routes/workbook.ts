import { Router, type IRouter } from "express";
import { createOptimizedWorkbook, repairWorkbookSchemaReference } from "../lib/workbook/workbookSetup.js";
import { getTodayDateStr } from "../lib/pipeline/config.js";
import { WORKBOOK_ID } from "../lib/sheets/client.js";

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

/**
 * POST /workbook/repair-schema-reference
 *
 * Rewrites SCHEMA_REFERENCE and README in the live workbook so they match
 * the current WORKBOOK_SCHEMA definitions and WORKBOOK_SCHEMA_VERSION.
 *
 * Idempotent — safe to run at any time; only touches the two reference tabs.
 * Accepts an optional ?workbook_id query param to target a different workbook.
 */
router.post("/workbook/repair-schema-reference", async (req, res): Promise<void> => {
  const workbookIdParam = req.query.workbook_id;
  const workbookId = typeof workbookIdParam === "string" ? workbookIdParam : WORKBOOK_ID;
  try {
    const result = await repairWorkbookSchemaReference(workbookId);
    const statusCode = result.errors.length > 0 ? 207 : 200;
    res.status(statusCode).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
