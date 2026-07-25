import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import {
  GetPipelineSlateQueryParams,
  GetPipelineSummaryQueryParams,
  GetPipelineScheduleQueryParams,
} from "@workspace/api-zod";
import { runPipeline, getPipelineSummary, runFullPipeline, runDailySettlement } from "../lib/pipeline/runner.js";
import { fetchMlbSchedule } from "../lib/pipeline/module01_mlbStatsApi.js";
import { getTodayDateStr } from "../lib/pipeline/config.js";
import { runHistoricalReplay } from "../lib/pipeline/module13_historicalReplay.js";
import { logger } from "../lib/logger.js";
import { runRegressionReport } from "../lib/pipeline/module15_regressionReport.js";
import { runStarterAudit } from "../lib/pipeline/module16_starterAudit.js";
import { runPostmortem } from "../lib/pipeline/module17_vehiclePostmortem.js";
import { runSurvivalGateReplay } from "../lib/pipeline/module18_survivalGateReplay.js";
import { runBoardLockReplay } from "../lib/pipeline/module19_boardLockReplay.js";
import { WORKBOOK_ID, readRange, writeRange, clearRange, expandSheetColumns } from "../lib/sheets/client.js";
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
 * MLB final scores, then automatically run survival gate replay for the
 * same date so the SURVIVAL_GATE_REPLAY sheet accumulates without manual work.
 *
 * Step 1 (Module 14): Appends settled rows to SHADOW_OUTCOMES (idempotent).
 * Step 2 (Module 18): Appends/replaces survival gate replay rows for the date
 *                     in SURVIVAL_GATE_REPLAY (idempotent by date+game_id).
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

  const workbookId = typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID;

  try {
    const result = await runDailySettlement(settleDate, workbookId);
    const hasFailure =
      result.settlement.status === "failure" ||
      result.survival_replay.status === "failure";
    res.status(hasFailure ? 500 : 200).json(result);
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

  // ── Write README content with current schema version ─────────────────────
  // repair-headers is the only writer — README data rows are never set elsewhere.
  try {
    const today = new Date().toISOString().split("T")[0];
    const readmeContent: string[][] = [
      ["Schema version", String(WORKBOOK_SCHEMA_VERSION)],
      ["Last updated",   today],
      ["Status",         "Headers reconciled via /api/pipeline/repair-headers"],
      ["Reference",      "See SCHEMA_REFERENCE tab for the full column data dictionary"],
    ];
    await clearRange(wbId, "README!A2:B100");
    await writeRange(wbId, "README!A2", readmeContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`README: ${msg}`);
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
 * GET /pipeline/repair-data
 * One-time historical data cleanup for the live workbook:
 *   1. BOARD_LOCK_STATE — invalidates any LOCKED_IN rows whose Locked_TS was
 *      stamped more than 30 min after Lock_Cutoff_TS (no valid pre-cutoff
 *      snapshot existed; rewrite to LOCKED_OUT / UNKNOWN_LATE_FIRST_RUN).
 *   2. VEHICLE_LOG — removes cross-date rows (Game_ID date prefix does not
 *      match the Date column value).
 *   3. REPLAY_RESULTS — deduplicates rows with the same Date + Game_ID key,
 *      keeping the last occurrence (highest row wins).
 *
 * Safe to run multiple times — idempotent.
 * Query params: workbook_id (optional override).
 */
router.get("/pipeline/repair-data", async (req, res): Promise<void> => {
  const { workbook_id } = req.query;
  const wbId = typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID;

  const GRACE_MS = 30 * 60 * 1000; // 30 min, matches BOARD_LOCK_LATE_GRACE_MS
  const report: Record<string, unknown> = {};
  const errors: string[] = [];

  // ── Shared helpers ─────────────────────────────────────────────────────────
  // Parse a cell as string.
  const cell = (row: unknown[], i: number): string => String(row[i] ?? "").trim();

  // Normalize any date string to bare "YYYYMMDD" regardless of Sheets formatting.
  // Sheets returns Date cells as "MM/DD/YYYY" (FORMATTED_VALUE) even when written
  // as "2026-07-25". Module17/18 Game_ID prefix is already "YYYYMMDD" (first 8 chars).
  const toYMD = (s: string): string => {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).replace(/-/g, ""); // "YYYY-MM-DD"
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}`;   // "MM/DD/YYYY"
    return "";
  };

  // Detect ISO-timestamp-like strings (written by the replay module as Replay_Run_TS).
  const isIsoTs = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

  // ── 1. BOARD_LOCK_STATE: invalidate false LOCKED_IN stamps ───────────────
  try {
    const blsResp = await readRange(wbId, "BOARD_LOCK_STATE!A:L");
    const blsRows = (blsResp.values ?? []) as unknown[][];
    if (blsRows.length > 1) {
      const dataRows = blsRows.slice(1);
      let invalidated = 0;
      const nowIso = new Date().toISOString();

      for (let i = 0; i < dataRows.length; i++) {
        const row = [...dataRows[i]];
        const lockStatus     = cell(row, 4); // E: Lock_Status
        const preLockDecision = cell(row, 5); // F: Pre_Lock_Decision
        const lockedTs       = cell(row, 6); // G: Locked_TS
        const lockCutoffTs   = cell(row, 3); // D: Lock_Cutoff_TS

        if (lockStatus !== "LOCKED_IN") continue;
        if (!lockedTs || !lockCutoffTs) continue;
        // A valid LOCKED_IN must have been stamped within GRACE_MS of the cutoff.
        const cutoffMs = new Date(lockCutoffTs).getTime();
        const lockedMs = new Date(lockedTs).getTime();
        if (isNaN(cutoffMs) || isNaN(lockedMs)) continue;
        const msLate = lockedMs - cutoffMs;
        if (msLate <= GRACE_MS) continue;
        // Stamped too late — no valid pre-cutoff snapshot existed.
        // Also verify the pre_lock_decision isn't already an UNKNOWN sentinel.
        if (preLockDecision.startsWith("UNKNOWN")) continue;

        // Rewrite: LOCKED_OUT / UNKNOWN_LATE_FIRST_RUN
        row[4] = "LOCKED_OUT";
        row[5] = "UNKNOWN_LATE_FIRST_RUN";
        row[11] = nowIso; // L: Last_Updated_TS
        dataRows[i] = row;
        invalidated++;
        logger.warn(
          { gameId: cell(row, 1), lockedTs, lockCutoffTs, msLate: Math.round(msLate / 60000) },
          "REPAIR_DATA: Invalidated false LOCKED_IN — locked > 30 min after cutoff",
        );
      }

      if (invalidated > 0) {
        // Rewrite all data rows (safest: overwrite the whole data range).
        await writeRange(
          wbId,
          `BOARD_LOCK_STATE!A2:L${1 + dataRows.length}`,
          dataRows,
        );
      }
      report["board_lock_state"] = { rows_inspected: dataRows.length, invalidated };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`BOARD_LOCK_STATE: ${msg}`);
  }

  // ── 2. VEHICLE_LOG: remove cross-date rows ───────────────────────────────
  // Game_ID format: "YYYYMMDD_AWAY_HOME". Cross-date = first 8 chars of
  // Game_ID don't match the Date column (normalized via shared toYMD).
  try {
    const vlResp = await readRange(wbId, "VEHICLE_LOG!A1:N5000");
    const vlAll  = (vlResp.values ?? []) as unknown[][];
    if (vlAll.length > 1) {
      const dataRows = vlAll.slice(1);
      const clean: unknown[][] = [];
      let removed = 0;
      for (const row of dataRows) {
        const dateCol = cell(row, 0); // A: Date
        const gameId  = cell(row, 1); // B: Game_ID ("YYYYMMDD_AWAY_HOME")
        const gameYMD = gameId.slice(0, 8); // first 8 chars = "YYYYMMDD"
        const rowYMD  = toYMD(dateCol);
        if (gameYMD && rowYMD && gameYMD !== rowYMD) {
          removed++;
          logger.warn({ dateCol, gameId, gameYMD, rowYMD }, "REPAIR_DATA: Removing cross-date VEHICLE_LOG row");
          continue;
        }
        clean.push(row);
      }
      if (removed > 0) {
        await clearRange(wbId, "VEHICLE_LOG!A2:N5000");
        if (clean.length > 0) await writeRange(wbId, "VEHICLE_LOG!A2", clean);
      }
      report["vehicle_log"] = { rows_inspected: dataRows.length, removed };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`VEHICLE_LOG: ${msg}`);
  }

  // ── 3. SURVIVAL_GATE_REPLAY: remove cross-date rows ──────────────────────
  // Same Game_ID format as VEHICLE_LOG. The 4 contaminated rows have
  // Date = 2026-07-24 but Game_ID prefix = 20260725.
  try {
    const sgrResp = await readRange(wbId, "SURVIVAL_GATE_REPLAY!A1:AA5000");
    const sgrAll  = (sgrResp.values ?? []) as unknown[][];
    if (sgrAll.length > 1) {
      const dataRows = sgrAll.slice(1);
      const clean: unknown[][] = [];
      let removed = 0;
      for (const row of dataRows) {
        const dateCol = cell(row, 0); // A: Date
        const gameId  = cell(row, 1); // B: Game_ID
        const gameYMD = gameId.slice(0, 8);
        const rowYMD  = toYMD(dateCol);
        if (gameYMD && rowYMD && gameYMD !== rowYMD) {
          removed++;
          logger.warn({ dateCol, gameId, gameYMD, rowYMD }, "REPAIR_DATA: Removing cross-date SURVIVAL_GATE_REPLAY row");
          continue;
        }
        clean.push(row);
      }
      if (removed > 0) {
        await clearRange(wbId, "SURVIVAL_GATE_REPLAY!A2:AA5000");
        if (clean.length > 0) await writeRange(wbId, "SURVIVAL_GATE_REPLAY!A2", clean);
      }
      report["survival_gate_replay"] = { rows_inspected: dataRows.length, removed };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SURVIVAL_GATE_REPLAY: ${msg}`);
  }

  // ── 4. REPLAY_RESULTS: migrate legacy column layout + deduplicate ─────────
  // RESULTS_HEADER grew in two steps; rows written before the current 31-col
  // layout have Replay_Run_TS in the wrong column:
  //
  //   Era A (24-col, oldest): Replay_Run_TS was at index 23
  //     → cols 0-22 correct; col 23 (now Park_Source_Status) holds the TS.
  //   Era B (29-col): Replay_Run_TS was at index 28
  //     → cols 0-27 correct; col 28 (now Market_Line) holds the TS.
  //   Current (31-col): Replay_Run_TS at index 30. Market_Line=28, Edge=29.
  //
  // Migration: if col 30 is blank and the candidate column (28 or 23) is an
  // ISO timestamp, move it to col 30 and blank the candidate.
  // After migration, deduplicate by Replay_Date + Game_ID (keep last row).
  try {
    const rrResp  = await readRange(wbId, "REPLAY_RESULTS!A1:AE5000");
    const rrAll   = (rrResp.values ?? []) as unknown[][];
    if (rrAll.length > 1) {
      const dataRows  = rrAll.slice(1);
      let migrated29  = 0;
      let migrated24  = 0;

      const migrated: unknown[][] = dataRows.map(rawRow => {
        // Pad to 31 cols so index 30 always exists.
        const row: unknown[] = [...rawRow];
        while (row.length < 31) row.push("");

        const col30 = cell(row, 30); // current Replay_Run_TS slot
        if (col30) return row;       // already populated — nothing to migrate

        const col28 = cell(row, 28); // Market_Line slot (holds old TS in era-B rows)
        if (isIsoTs(col28)) {
          row[30] = col28;
          row[28] = "";
          migrated29++;
          return row;
        }

        const col23 = cell(row, 23); // Park_Source_Status slot (holds old TS in era-A rows)
        if (isIsoTs(col23)) {
          row[30] = col23;
          row[23] = "";
          migrated24++;
          return row;
        }

        return row;
      });

      // Deduplicate by Replay_Date (col 0) + Game_ID (col 1) — keep last occurrence.
      const lastSeen = new Map<string, unknown[]>();
      let dupes = 0;
      for (const row of migrated) {
        const key = `${cell(row, 0)}|${cell(row, 1)}`;
        if (!key || key === "|") continue;
        if (lastSeen.has(key)) dupes++;
        lastSeen.set(key, row);
      }

      if (migrated29 > 0 || migrated24 > 0 || dupes > 0) {
        const final = Array.from(lastSeen.values());
        await clearRange(wbId, "REPLAY_RESULTS!A2:AE5000");
        if (final.length > 0) await writeRange(wbId, "REPLAY_RESULTS!A2", final);
      }
      report["replay_results"] = {
        rows_inspected: dataRows.length,
        migrated_era_b_29col: migrated29,
        migrated_era_a_24col: migrated24,
        duplicates_removed:   dupes,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`REPLAY_RESULTS: ${msg}`);
  }

  res.status(errors.length > 0 ? 207 : 200).json({
    status: errors.length === 0 ? "success" : "partial",
    ...report,
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

/**
 * GET /pipeline/board-status
 * Returns per-game board lock status for a given date, read from the
 * BOARD_LOCK_STATE and SLATE_BOARD sheets. Used by the Frostline UI to
 * surface Locked In / Locked Out indicators without re-running the pipeline.
 *
 * Query params:
 *   date        — YYYY-MM-DD (optional; defaults to today ET)
 *   workbook_id — override workbook (optional)
 */
router.get("/pipeline/board-status", async (req, res): Promise<void> => {
  const { date: dateParam, workbook_id } = req.query;
  const date =
    typeof dateParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : getTodayDateStr();
  const wbId =
    typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID;

  try {
    const [blsData, sbData, monoData] = await Promise.all([
      readRange(wbId, "BOARD_LOCK_STATE!A:L").catch(() => ({
        values: [] as unknown[][],
      })),
      readRange(wbId, "SLATE_BOARD!A:AH").catch(() => ({
        values: [] as unknown[][],
      })),
      readRange(wbId, "MONOTONICITY!A:O").catch(() => ({
        values: [] as unknown[][],
      })),
    ]);

    // ── Read MONOTONICITY overall verdict + Report_TS ──
    const MONOTONICITY_STALE_HOURS = 24;
    let monotonicityVerdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE" | null = null;
    let monotonicityReportTs: string | null = null;
    for (const row of ((monoData.values ?? []) as string[][])) {
      if (
        String(row[0] ?? "").trim().toUpperCase() === "OVERALL" &&
        String(row[1] ?? "").trim().toUpperCase() === "VERDICT"
      ) {
        const v = String(row[2] ?? "").trim().toUpperCase();
        monotonicityReportTs = String(row[14] ?? "").trim() || null; // col O = Report_TS
        if (v === "PASS" || v === "FAIL" || v === "INSUFFICIENT_SAMPLE") {
          monotonicityVerdict = v as "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE";
        }
        break;
      }
    }

    // Staleness: Report_TS absent, unparseable, or > 24 h old → STALE.
    const isMonotonicityStale = (() => {
      if (!monotonicityReportTs) return true;
      const ts = new Date(monotonicityReportTs).getTime();
      if (isNaN(ts)) return true;
      return (Date.now() - ts) / (1000 * 60 * 60) > MONOTONICITY_STALE_HOURS;
    })();

    // ── Check BOARD_LOCK_STATE for operator monotonicity override sentinel ──
    // Validity requirements: authorized=TRUE, reason non-blank, source non-blank,
    // timestamp parseable, and Date matches the active slate date (auto-expires).
    const MONOTONICITY_GATE_OVERRIDE_ID = "MONOTONICITY_GATE_OVERRIDE";
    let monotonicityOverrideActive = false;
    const blsAllRowsForMono = ((blsData.values ?? []) as unknown[][]).slice(1);
    for (const row of blsAllRowsForMono) {
      if (String(row[1] ?? "").trim() === MONOTONICITY_GATE_OVERRIDE_ID) {
        const overrideDate  = String(row[0] ?? "").trim();
        const reason        = String(row[7] ?? "").trim();
        const source        = String(row[8] ?? "").trim();
        const changeTsStr   = String(row[9] ?? "").trim();
        const authorized    = String(row[10] ?? "").trim().toUpperCase() === "TRUE";
        const tsValid       = changeTsStr !== "" && !isNaN(new Date(changeTsStr).getTime());
        if (
          authorized &&
          reason !== "" &&
          source !== "" &&
          tsValid &&
          overrideDate === date   // auto-expires: must match the active slate date
        ) {
          monotonicityOverrideActive = true;
        }
        break;
      }
    }

    // Determine core_auth_status from verdict, freshness, and override
    type CoreAuthStatus =
      | "ENABLED"
      | "DISABLED_MONOTONICITY_FAIL"
      | "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"
      | "DISABLED_MONOTONICITY_NOT_COMPUTED"
      | "DISABLED_MONOTONICITY_STALE";
    let coreAuthStatus: CoreAuthStatus;
    if (monotonicityOverrideActive) {
      coreAuthStatus = "ENABLED";
    } else if (monotonicityVerdict === "PASS") {
      coreAuthStatus = isMonotonicityStale ? "DISABLED_MONOTONICITY_STALE" : "ENABLED";
    } else if (monotonicityVerdict === "FAIL") {
      coreAuthStatus = "DISABLED_MONOTONICITY_FAIL";
    } else if (monotonicityVerdict === "INSUFFICIENT_SAMPLE") {
      coreAuthStatus = "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE";
    } else {
      coreAuthStatus = "DISABLED_MONOTONICITY_NOT_COMPUTED";
    }

    // BOARD_LOCK_STATE cols (0-based): A=Date, B=Game_ID, C=Scheduled_First_Pitch,
    // D=Lock_Cutoff_TS, E=Lock_Status, F=Pre_Lock_Decision, G=Locked_TS
    const blsRows = ((blsData.values ?? []) as unknown[][]).slice(1);
    const blsForDate = blsRows.filter(
      (row) => String(row[0] ?? "").trim() === date,
    );

    // SLATE_BOARD cols (0-based):
    //   B(1)=Game_ID, F(5)=Projected_Value, G(6)=Market_Line, I(8)=Direction,
    //   J(9)=Decision, M(12)=Edge_Strength, N(13)=CORE_Blocker,
    //   AF(31)=Survival_Check, AG(32)=Survival_Failure_Reason, AH(33)=Lock_Status
    const sbRows = ((sbData.values ?? []) as unknown[][]).slice(1);
    const sbMap = new Map<
      string,
      {
        final_decision: string;
        core_blocker: string;
        direction: string;
        projected_total: number | null;
        market_line: number | null;
        edge_strength: string;
        survival_check: string;
        survival_failure_reason: string;
      }
    >();
    for (const row of sbRows) {
      const gameId = String(row[1] ?? "").trim();
      if (!gameId) continue;
      const parseNum = (v: unknown) => {
        const n = parseFloat(String(v ?? ""));
        return isNaN(n) ? null : n;
      };
      sbMap.set(gameId, {
        final_decision:          String(row[9]  ?? "").trim(),
        core_blocker:            String(row[13] ?? "").trim(),
        direction:               String(row[8]  ?? "").trim(),
        projected_total:         parseNum(row[5]),
        market_line:             parseNum(row[6]),
        edge_strength:           String(row[12] ?? "").trim(),
        survival_check:          String(row[31] ?? "").trim(),
        survival_failure_reason: String(row[32] ?? "").trim(),
      });
    }

    const nowMs = Date.now();
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    interface BoardStatusEntry {
      game_id: string;
      /**
       * PRE_LOCK              — before cutoff; normal promotion allowed.
       * LOCKED_IN             — was CORE at cutoff; still downgradable.
       * LOCKED_OUT            — not CORE at cutoff; promotion blocked.
       * LOCK_TIME_UNAVAILABLE — no scheduled_utc_time; CORE promotion disabled.
       * LOCK_DATA_UNAVAILABLE — ≥ 50 % of slate games have no time; all new CORE blocked.
       */
      lock_status: "PRE_LOCK" | "LOCKED_IN" | "LOCKED_OUT" | "LOCK_TIME_UNAVAILABLE" | "LOCK_DATA_UNAVAILABLE";
      lock_cutoff_ts: string;
      pre_lock_decision: string;
      final_decision: string;
      core_blocker: string;
      // ── Pick decision detail fields (from SLATE_BOARD) ──
      direction: string;
      projected_total: number | null;
      market_line: number | null;
      edge_strength: string;
      survival_check: string;
      survival_failure_reason: string;
    }

    const games: BoardStatusEntry[] = [];

    const KNOWN_LOCK_STATUSES = new Set([
      "LOCKED_IN", "LOCKED_OUT", "LOCK_TIME_UNAVAILABLE", "LOCK_DATA_UNAVAILABLE",
    ]);

    for (const row of blsForDate) {
      const gameId = String(row[1] ?? "").trim();
      // Explicitly skip the monotonicity override sentinel — it is a control-state
      // row, not a real game, and must never appear in counts or the games array.
      if (!gameId || gameId === MONOTONICITY_GATE_OVERRIDE_ID) continue;
      const lockCutoffTs = String(row[3] ?? "").trim();
      const rawStatus = String(row[4] ?? "").trim();
      // Pass through all known statuses; unrecognised values default to PRE_LOCK.
      const lockStatus: BoardStatusEntry["lock_status"] =
        KNOWN_LOCK_STATUSES.has(rawStatus)
          ? (rawStatus as BoardStatusEntry["lock_status"])
          : "PRE_LOCK";
      const sb = sbMap.get(gameId);
      games.push({
        game_id:                 gameId,
        lock_status:             lockStatus,
        lock_cutoff_ts:          lockCutoffTs,
        pre_lock_decision:       String(row[5] ?? "").trim(),
        final_decision:          sb?.final_decision          ?? "",
        core_blocker:            sb?.core_blocker            ?? "",
        direction:               sb?.direction               ?? "",
        projected_total:         sb?.projected_total         ?? null,
        market_line:             sb?.market_line             ?? null,
        edge_strength:           sb?.edge_strength           ?? "",
        survival_check:          sb?.survival_check          ?? "",
        survival_failure_reason: sb?.survival_failure_reason ?? "",
      });
    }

    // Nearest upcoming cutoff (has not yet passed) — used for "locking soon" banner
    let nextUpcomingCutoffTs: string | null = null;
    let nextCutoffMs = Infinity;
    let cutoffApproaching = false;

    for (const g of games) {
      if (!g.lock_cutoff_ts) continue;
      const cMs = new Date(g.lock_cutoff_ts).getTime();
      if (isNaN(cMs)) continue;
      if (cMs > nowMs) {
        // Still in the future
        if (cMs < nextCutoffMs) {
          nextCutoffMs = cMs;
          nextUpcomingCutoffTs = g.lock_cutoff_ts;
        }
        if (cMs - nowMs <= THIRTY_MIN_MS) {
          cutoffApproaching = true;
        }
      }
    }

    const lockedInCount              = games.filter((g) => g.lock_status === "LOCKED_IN").length;
    const lockedOutCount             = games.filter((g) => g.lock_status === "LOCKED_OUT").length;
    const preLockCount               = games.filter((g) => g.lock_status === "PRE_LOCK").length;
    const lockTimeUnavailableCount   = games.filter((g) => g.lock_status === "LOCK_TIME_UNAVAILABLE").length;
    const lockDataUnavailableCount   = games.filter((g) => g.lock_status === "LOCK_DATA_UNAVAILABLE").length;

    // ── ETag — hash of sorted game_id:lock_status pairs ────────────────────────
    // Computed from the lock status for each game so any badge change produces a
    // new ETag.  The UI uses this to detect when a publish run just completed and
    // schedule a confirmatory re-fetch; if two consecutive reads return the same
    // ETag the data is considered consistent and badges update.
    const etagBody = games
      .map((g) => `${g.game_id}:${g.lock_status}`)
      .sort()
      .join("|");
    const etag = `"${createHash("sha256").update(etagBody).digest("hex").slice(0, 16)}"`;

    logger.info(
      {
        date,
        locked_in:              lockedInCount,
        locked_out:             lockedOutCount,
        pre_lock:               preLockCount,
        lock_time_unavailable:  lockTimeUnavailableCount,
        lock_data_unavailable:  lockDataUnavailableCount,
        core_auth_status:       coreAuthStatus,
        monotonicity_verdict:   monotonicityVerdict,
        etag,
      },
      "BOARD_STATUS: read complete",
    );

    // Set ETag header so HTTP caches and the client can detect content changes.
    res.setHeader("ETag", etag);
    // Prevent stale intermediary caches from serving a snapshot mid-write.
    res.setHeader("Cache-Control", "no-cache");

    res.json({
      date,
      timestamp: new Date().toISOString(),
      /**
       * Content hash of sorted game_id:lock_status pairs (16-hex-char SHA-256 prefix).
       * Changes whenever any game's lock badge changes.  The UI uses consecutive
       * ETag equality to confirm data is consistent after a publish run completes.
       */
      etag,
      games,
      next_upcoming_cutoff_ts:      nextUpcomingCutoffTs,
      cutoff_approaching:           cutoffApproaching,
      locked_in_count:              lockedInCount,
      locked_out_count:             lockedOutCount,
      pre_lock_count:               preLockCount,
      lock_time_unavailable_count:  lockTimeUnavailableCount,
      lock_data_unavailable_count:  lockDataUnavailableCount,
      /**
       * ENABLED                   — monotonicity PASS; CORE picks authorized normally.
       * DISABLED_MONOTONICITY_FAIL — verdict is FAIL; all CORE blocked.
       * DISABLED_NOT_YET_COMPUTED  — no verdict yet; CORE blocked until regression runs.
       */
      core_auth_status:             coreAuthStatus,
      /** Raw OVERALL verdict from the MONOTONICITY sheet. Null when sheet absent. */
      monotonicity_verdict:         monotonicityVerdict,
      /** True when the operator sentinel row in BOARD_LOCK_STATE bypasses the gate. */
      monotonicity_override_active: monotonicityOverrideActive,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /pipeline/monotonicity-override
 * Writes (or revokes) an operator MONOTONICITY_GATE_OVERRIDE sentinel row in
 * BOARD_LOCK_STATE so the operator can re-enable CORE picks from the UI without
 * editing the spreadsheet directly.
 *
 * Body: { date, reason, active?, workbook_id? }
 *   active — optional boolean (default true); pass false to revoke the override.
 */
router.post("/pipeline/monotonicity-override", async (req, res): Promise<void> => {
  const { date: dateParam, reason, active, workbook_id } = req.body as {
    date?: string;
    reason?: string;
    active?: boolean;
    workbook_id?: string;
  };

  const date =
    typeof dateParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : getTodayDateStr();
  const wbId = typeof workbook_id === "string" && workbook_id ? workbook_id : WORKBOOK_ID;
  const isActive = active !== false; // default true

  if (isActive && (!reason || typeof reason !== "string" || !reason.trim())) {
    res.status(400).json({ error: "reason is required when activating an override" });
    return;
  }

  const OVERRIDE_ID = "MONOTONICITY_GATE_OVERRIDE";
  const ts = new Date().toISOString();

  try {
    const blsData = await readRange(wbId, "BOARD_LOCK_STATE!A:L").catch(() => ({
      values: [] as unknown[][],
    }));
    const allRows = (blsData.values ?? []) as unknown[][];
    const dataRows = allRows.slice(1);

    // Find existing sentinel row index
    const existingIdx = dataRows.findIndex(
      (r) => String(r[1] ?? "").trim() === OVERRIDE_ID,
    );

    const overrideRow: unknown[] = [
      date, OVERRIDE_ID, "", "", "", "", "",
      isActive ? (reason ?? "").trim() : "",   // Late_Change_Reason
      isActive ? "OPERATOR_UI" : "",            // Late_Change_Source
      ts,                                       // Late_Change_TS
      isActive ? "TRUE" : "FALSE",              // Late_Promotion_Authorized
      ts,                                       // Last_Updated_TS
    ];

    if (existingIdx >= 0) {
      // Update in place
      const sheetRow = existingIdx + 2; // +1 header, +1 1-based
      await writeRange(wbId, `BOARD_LOCK_STATE!A${sheetRow}:L${sheetRow}`, [overrideRow]);
    } else {
      // Append after existing rows
      const startRow = allRows.length + 1;
      await writeRange(wbId, `BOARD_LOCK_STATE!A${startRow}:L${startRow}`, [overrideRow]);
    }

    logger.info({ date, active: isActive, reason }, "BOARD_STATUS: Monotonicity override written");
    res.json({ ok: true, date, active: isActive, reason: isActive ? (reason ?? "").trim() : "" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
