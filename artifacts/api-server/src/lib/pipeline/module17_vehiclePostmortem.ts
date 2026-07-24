/**
 * Module 17: Vehicle Postmortem
 *
 * Two-phase module that separates thesis accuracy from ticket result:
 *
 *   Phase 1 — logVehicles()
 *     Called during every publish run (from runner.ts) to append each game's
 *     vehicle selection, market line, projection, and authorization decision
 *     to VEHICLE_LOG. Idempotent — deduplicates by (date + game_id).
 *
 *   Phase 2 — runPostmortem()
 *     Called after settlement (any time SHADOW_OUTCOMES has rows for a date)
 *     to join VEHICLE_LOG with actual outcomes. Grades each game on:
 *       • Thesis accuracy — did the projection direction match reality?
 *       • Ticket result   — did the authorized bet cover?
 *     Appends graded rows to VEHICLE_POSTMORTEM (never cleared; idempotent).
 *
 * Endpoints:
 *   GET /api/pipeline/postmortem?date=YYYY-MM-DD[&write_sheets=true]
 */

import { readRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { SlateBoardEntry } from "./module11_outputExtraction.js";

const VEHICLE_LOG_SHEET  = "VEHICLE_LOG";
const POSTMORTEM_SHEET   = "VEHICLE_POSTMORTEM";
const OUTCOMES_SHEET     = "SHADOW_OUTCOMES";
const LOG_COLS           = 14;
const POSTMORTEM_COLS    = 17;

// ─── Sheet headers ─────────────────────────────────────────────────────────────

const LOG_HEADER: string[] = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Vehicle_Type", "Market_Line", "Direction",
  "Projected_Total", "Variance", "Final_Decision", "Core_Blocker",
  "Edge_Strength", "Confidence", "Publish_TS",
];

const POSTMORTEM_HEADER: string[] = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Vehicle_Type", "Market_Line", "Direction",
  "Projected_Total", "Actual_Total", "Error",
  "Final_Decision", "Core_Blocker",
  "Thesis_Correct", "Ticket_Result",
  "Away_Offense_Source", "Home_Offense_Source",
  "Graded_TS",
];

// ─── VEHICLE_LOG column indices (0-based) ──────────────────────────────────────
const L_DATE           = 0;
const L_GAME_ID        = 1;
const L_AWAY           = 2;
const L_HOME           = 3;
const L_VEHICLE_TYPE   = 4;
const L_MARKET_LINE    = 5;
const L_DIRECTION      = 6;
const L_PROJ_TOTAL     = 7;
const L_VARIANCE       = 8;
const L_FINAL_DECISION = 9;
const L_CORE_BLOCKER   = 10;
const L_EDGE_STRENGTH  = 11;
const L_CONFIDENCE     = 12;

// ─── SHADOW_OUTCOMES column indices (0-based) ─────────────────────────────────
const O_GAME_ID  = 1;
const O_ACTUAL   = 5;
const O_ERROR    = 6;
const O_AWAY_SRC = 9;
const O_HOME_SRC = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VehicleLogResult {
  status: "success" | "partial" | "failure";
  date: string;
  publish_ts: string;
  rows_written: number;
  rows_skipped: number;
  errors: string[];
}

export interface PostmortemRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  vehicle_type: string;
  market_line: number | null;
  direction: "OVER" | "UNDER" | "NONE";
  projected_total: number;
  actual_total: number;
  /** proj − actual (positive = over-projected) */
  error: number;
  final_decision: "CORE" | "NO_CORE" | "PENDING";
  core_blocker: string;
  /** null when direction is NONE or no market line available */
  thesis_correct: boolean | null;
  /** COVERED / MISSED / PUSH — only meaningful when final_decision === "CORE" */
  ticket_result: "COVERED" | "MISSED" | "PUSH" | "NO_BET";
  away_offense_source: string;
  home_offense_source: string;
  graded_ts: string;
}

export interface PostmortemResult {
  status: "success" | "partial" | "failure";
  graded_date: string;
  graded_ts: string;
  games_graded: number;
  games_no_outcome: number;
  /** Games where final_decision === "CORE" */
  core_bets: number;
  core_covered: number;
  core_missed: number;
  core_push: number;
  /** % of GAME_TOTAL vehicles where projection direction matched outcome, across all decisions */
  thesis_correct_pct: number | null;
  rows: PostmortemRow[];
  errors: string[];
}

// ─── Grading helper ───────────────────────────────────────────────────────────

function gradeTicket(
  direction: string,
  marketLine: number | null,
  actualTotal: number,
): { thesis_correct: boolean | null; ticket_result: PostmortemRow["ticket_result"] } {
  if (!marketLine || direction === "NONE") {
    return { thesis_correct: null, ticket_result: "NO_BET" };
  }
  const diff = actualTotal - marketLine;
  const thesis_correct =
    (direction === "OVER" && diff > 0) ||
    (direction === "UNDER" && diff < 0);

  let ticket_result: PostmortemRow["ticket_result"];
  if (diff === 0) {
    ticket_result = "PUSH";
  } else if (direction === "OVER") {
    ticket_result = diff > 0 ? "COVERED" : "MISSED";
  } else {
    ticket_result = diff < 0 ? "COVERED" : "MISSED";
  }
  return { thesis_correct, ticket_result };
}

// ─── Phase 1: log vehicles from a publish run ─────────────────────────────────

export async function logVehicles(
  date: string,
  slateBoard: SlateBoardEntry[],
  options: { workbookId?: string } = {},
): Promise<VehicleLogResult> {
  const ts   = new Date().toISOString();
  const wbId = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];

  logger.info({ date, games: slateBoard.length }, "MODULE_17: Vehicle log starting");

  if (slateBoard.length === 0) {
    return { status: "success", date, publish_ts: ts, rows_written: 0, rows_skipped: 0, errors };
  }

  // ── Read existing log to deduplicate by (date + game_id) ──
  let existingKeys = new Set<string>();
  let existingRowCount = 0;
  try {
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:B5000`);
    const rows = (resp.values ?? []) as string[][];
    existingRowCount = rows.length;
    existingKeys = new Set(
      rows.slice(1)
        .map((r) => `${r[0] ?? ""}_${r[1] ?? ""}`)
        .filter((k) => k !== "_"),
    );
  } catch {
    logger.warn("MODULE_17: Could not read VEHICLE_LOG for dedup — proceeding");
  }

  const logRows = slateBoard
    .filter((e) => !existingKeys.has(`${date}_${e.legacy_game_id}`))
    .map((e) => [
      date,
      e.legacy_game_id,
      e.away_team,
      e.home_team,
      e.vehicle_type,
      e.market_line ?? "",
      e.direction,
      e.projected_total,
      e.variance ?? "",
      e.final_decision,
      e.core_blocker,
      e.edge_strength,
      e.confidence,
      ts,
    ]);

  const skipped = slateBoard.length - logRows.length;

  if (logRows.length === 0) {
    logger.info({ skipped }, "MODULE_17: All vehicle rows already logged — nothing to write");
    return { status: "success", date, publish_ts: ts, rows_written: 0, rows_skipped: skipped, errors };
  }

  try {
    await expandSheetColumns(wbId, VEHICLE_LOG_SHEET, LOG_COLS);
    const needsHeader = existingRowCount === 0;
    if (needsHeader) {
      await writeRange(wbId, `${VEHICLE_LOG_SHEET}!A1:N1`, [LOG_HEADER]);
      existingRowCount = 1;
    }
    const startRow = existingRowCount + 1;
    await writeRange(
      wbId,
      `${VEHICLE_LOG_SHEET}!A${startRow}:N${startRow + logRows.length - 1}`,
      logRows,
    );
    logger.info({ written: logRows.length, skipped }, "MODULE_17: Vehicle log written");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`VEHICLE_LOG write failed: ${msg}`);
    logger.error({ err: msg }, "MODULE_17: Vehicle log write failed");
  }

  const status = errors.length === 0 ? "success" : logRows.length > 0 ? "partial" : "failure";
  return { status, date, publish_ts: ts, rows_written: logRows.length, rows_skipped: skipped, errors };
}

// ─── Phase 2: grade vehicles against settled outcomes ─────────────────────────

export async function runPostmortem(
  date: string,
  options: { workbookId?: string; writeSheets?: boolean } = {},
): Promise<PostmortemResult> {
  const ts    = new Date().toISOString();
  const wbId  = options.workbookId ?? WORKBOOK_ID;
  const write = options.writeSheets ?? false;
  const errors: string[] = [];

  const empty = (status: PostmortemResult["status"]): PostmortemResult => ({
    status, graded_date: date, graded_ts: ts,
    games_graded: 0, games_no_outcome: 0,
    core_bets: 0, core_covered: 0, core_missed: 0, core_push: 0,
    thesis_correct_pct: null, rows: [], errors,
  });

  logger.info({ date }, "MODULE_17: Vehicle postmortem starting");

  // ── Read VEHICLE_LOG for this date ──
  let vehicleRows: string[][] = [];
  try {
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:N5000`);
    const all  = (resp.values ?? []) as string[][];
    vehicleRows = all.slice(1).filter((r) => (r[L_DATE] ?? "") === date);
    logger.info({ found: vehicleRows.length }, "MODULE_17: Vehicle log rows for date");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`VEHICLE_LOG read failed: ${msg}`);
    return { ...empty("failure"), errors };
  }

  if (vehicleRows.length === 0) {
    return empty("success");
  }

  // ── Read SHADOW_OUTCOMES ──
  type OutcomeData = { actual_total: number; error: number; away_src: string; home_src: string };
  const outcomesMap = new Map<string, OutcomeData>();
  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:K5000`);
    const all  = (resp.values ?? []) as string[][];
    for (const r of all.slice(1)) {
      const gid = r[O_GAME_ID] ?? "";
      if (!gid) continue;
      outcomesMap.set(gid, {
        actual_total: parseFloat(r[O_ACTUAL]  ?? "0") || 0,
        error:        parseFloat(r[O_ERROR]   ?? "0") || 0,
        away_src:     r[O_AWAY_SRC] ?? "",
        home_src:     r[O_HOME_SRC] ?? "",
      });
    }
    logger.info({ outcomes: outcomesMap.size }, "MODULE_17: SHADOW_OUTCOMES loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    return { ...empty("failure"), errors };
  }

  // ── Read existing VEHICLE_POSTMORTEM to avoid duplicates ──
  let existingPmKeys = new Set<string>();
  let existingPmCount = 0;
  try {
    const resp = await readRange(wbId, `${POSTMORTEM_SHEET}!A1:B5000`);
    const all  = (resp.values ?? []) as string[][];
    existingPmCount = all.length;
    existingPmKeys = new Set(
      all.slice(1).map((r) => `${r[0] ?? ""}_${r[1] ?? ""}`).filter((k) => k !== "_"),
    );
  } catch {
    logger.warn("MODULE_17: Could not read VEHICLE_POSTMORTEM for dedup — proceeding");
  }

  // ── Grade each vehicle row ──
  const graded: PostmortemRow[] = [];
  let noOutcome = 0;

  for (const r of vehicleRows) {
    const gameId  = r[L_GAME_ID] ?? "";
    const outcome = outcomesMap.get(gameId);
    if (!outcome) { noOutcome++; continue; }

    // Idempotency — skip already-graded rows
    if (existingPmKeys.has(`${date}_${gameId}`)) continue;

    const marketLine    = r[L_MARKET_LINE] ? parseFloat(r[L_MARKET_LINE]) : null;
    const direction     = (r[L_DIRECTION]     ?? "NONE") as "OVER" | "UNDER" | "NONE";
    const finalDecision = (r[L_FINAL_DECISION] ?? "PENDING") as PostmortemRow["final_decision"];
    const vehicleType   = r[L_VEHICLE_TYPE]   ?? "";

    // Only grade thesis/ticket for total-line vehicles (GAME_TOTAL, TEAM_TOTAL_*)
    const isGradeable = vehicleType.includes("TOTAL");
    const { thesis_correct, ticket_result } = isGradeable
      ? gradeTicket(direction, marketLine, outcome.actual_total)
      : { thesis_correct: null, ticket_result: "NO_BET" as const };

    graded.push({
      date,
      game_id:          gameId,
      away_team:        r[L_AWAY] ?? "",
      home_team:        r[L_HOME] ?? "",
      vehicle_type:     vehicleType,
      market_line:      marketLine,
      direction,
      projected_total:  parseFloat(r[L_PROJ_TOTAL] ?? "0") || 0,
      actual_total:     outcome.actual_total,
      error:            outcome.error,
      final_decision:   finalDecision,
      core_blocker:     r[L_CORE_BLOCKER]  ?? "",
      thesis_correct,
      ticket_result,
      away_offense_source: outcome.away_src,
      home_offense_source: outcome.home_src,
      graded_ts: ts,
    });
  }

  // ── Aggregate stats ──
  const coreGames   = graded.filter((r) => r.final_decision === "CORE");
  const coreCovered = coreGames.filter((r) => r.ticket_result === "COVERED").length;
  const coreMissed  = coreGames.filter((r) => r.ticket_result === "MISSED").length;
  const corePush    = coreGames.filter((r) => r.ticket_result === "PUSH").length;

  const thesisObs = graded.filter((r) => r.thesis_correct !== null);
  const thesisCorrectPct = thesisObs.length > 0
    ? parseFloat(
        (thesisObs.filter((r) => r.thesis_correct).length / thesisObs.length * 100).toFixed(1),
      )
    : null;

  // ── Write VEHICLE_POSTMORTEM (append) ──
  if (write && graded.length > 0) {
    try {
      await expandSheetColumns(wbId, POSTMORTEM_SHEET, POSTMORTEM_COLS);
      const needsHeader = existingPmCount === 0;
      if (needsHeader) {
        await writeRange(wbId, `${POSTMORTEM_SHEET}!A1:Q1`, [POSTMORTEM_HEADER]);
        existingPmCount = 1;
      }
      const startRow = existingPmCount + 1;
      const sheetRows = graded.map((r) => [
        r.date, r.game_id, r.away_team, r.home_team,
        r.vehicle_type, r.market_line ?? "", r.direction,
        r.projected_total, r.actual_total, r.error,
        r.final_decision, r.core_blocker,
        r.thesis_correct === null ? "" : (r.thesis_correct ? "TRUE" : "FALSE"),
        r.ticket_result,
        r.away_offense_source, r.home_offense_source,
        r.graded_ts,
      ]);
      await writeRange(
        wbId,
        `${POSTMORTEM_SHEET}!A${startRow}:Q${startRow + sheetRows.length - 1}`,
        sheetRows,
      );
      logger.info({ written: sheetRows.length }, "MODULE_17: Vehicle postmortem written");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`VEHICLE_POSTMORTEM write failed: ${msg}`);
      logger.error({ err: msg }, "MODULE_17: Vehicle postmortem write failed");
    }
  }

  const status = errors.length === 0 ? "success" : graded.length > 0 ? "partial" : "failure";

  logger.info(
    {
      graded: graded.length, noOutcome,
      coreGames: coreGames.length, coreCovered, coreMissed, corePush,
      thesisCorrectPct,
    },
    "MODULE_17: Vehicle postmortem complete",
  );

  return {
    status,
    graded_date:        date,
    graded_ts:          ts,
    games_graded:       graded.length,
    games_no_outcome:   noOutcome,
    core_bets:          coreGames.length,
    core_covered:       coreCovered,
    core_missed:        coreMissed,
    core_push:          corePush,
    thesis_correct_pct: thesisCorrectPct,
    rows:               graded,
    errors,
  };
}
