/**
 * Module 17: Vehicle Postmortem
 *
 * Two-phase module that separates thesis accuracy from ticket result:
 *
 *   Phase 1 — logVehicles()
 *     Called during every publish run (from runner.ts) to UPSERT each game's
 *     vehicle selection, market line, projection, and authorization decision
 *     into VEHICLE_LOG. Overwrites existing rows for today (canonical snapshot
 *     = final decision before lock) and appends new ones.
 *
 *     Cross-date validation: any slateBoard entry whose game_id date prefix
 *     does not match the `date` parameter is rejected to prevent contamination
 *     from games that appear in the schedule with the wrong date key.
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

export interface ContiguousVehicleLogUpdate {
  start_data_row_index: number;
  rows: unknown[][];
}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Validate that the date encoded in a game_id matches the expected date string.
 * game_id format: YYYYMMDD_AWAY_HOME  (e.g. "20260725_KCR_DET")
 * date format:    YYYY-MM-DD           (e.g. "2026-07-25")
 */
function gameIdDateMatchesDate(gameId: string, date: string): boolean {
  const expectedPrefix = date.replace(/-/g, ""); // "20260725"
  return gameId.slice(0, 8) === expectedPrefix;
}

/** Collapse adjacent in-place updates into the fewest Sheets write requests. */
export function groupContiguousVehicleLogUpdates(
  rowUpdates: ReadonlyMap<number, unknown[]>,
): ContiguousVehicleLogUpdate[] {
  const sorted = [...rowUpdates.entries()].sort(([left], [right]) => left - right);
  const groups: ContiguousVehicleLogUpdate[] = [];

  for (const [dataRowIndex, row] of sorted) {
    const current = groups[groups.length - 1];
    if (current && dataRowIndex === current.start_data_row_index + current.rows.length) {
      current.rows.push(row);
    } else {
      groups.push({ start_data_row_index: dataRowIndex, rows: [row] });
    }
  }

  return groups;
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

  // ── Cross-date validation ──────────────────────────────────────────────────
  // Reject any slateBoard entry whose game_id date prefix doesn't match `date`.
  // This prevents contamination from games that appear with incorrect date keys.
  const validEntries = slateBoard.filter((e) => {
    if (!gameIdDateMatchesDate(e.legacy_game_id, date)) {
      logger.warn(
        { date, game_id: e.legacy_game_id },
        "MODULE_17: Cross-date game_id rejected — game_id date does not match log date",
      );
      return false;
    }
    return true;
  });
  const crossDateSkipped = slateBoard.length - validEntries.length;

  // ── Read existing VEHICLE_LOG (full rows for UPSERT) ──────────────────────
  let existingAllRows: unknown[][] = [];
  let existingRowCount = 0;
  try {
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:N5000`);
    existingAllRows = (resp.values ?? []) as unknown[][];
    existingRowCount = existingAllRows.length;
  } catch {
    logger.warn("MODULE_17: Could not read VEHICLE_LOG — proceeding as empty");
  }

  const existingDataRows = existingAllRows.slice(1); // exclude header row

  // Build upsert index: (date + game_id) → 0-based index in existingDataRows.
  // Skip rows that are already cross-date contaminated (game_id date ≠ row date)
  // so contaminated rows cannot win deduplication.
  const existingIndex = new Map<string, number>();
  for (let i = 0; i < existingDataRows.length; i++) {
    const row       = existingDataRows[i] as unknown[];
    const rowDate   = String(row[L_DATE]    ?? "");
    const rowGameId = String(row[L_GAME_ID] ?? "");
    if (!rowDate || !rowGameId) continue;
    if (!gameIdDateMatchesDate(rowGameId, rowDate)) {
      logger.warn(
        { rowDate, rowGameId },
        "MODULE_17: Contaminated row in VEHICLE_LOG index — skipping for upsert",
      );
      continue;
    }
    existingIndex.set(`${rowDate}_${rowGameId}`, i);
  }

  // ── Build update and append lists ──────────────────────────────────────────
  const rowUpdates = new Map<number, unknown[]>(); // dataRow index → new row data
  const newRows: unknown[][] = [];

  for (const e of validEntries) {
    const key = `${date}_${e.legacy_game_id}`;
    const row: unknown[] = [
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
    ];

    if (existingIndex.has(key)) {
      rowUpdates.set(existingIndex.get(key)!, row);
    } else {
      newRows.push(row);
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  let rowsWritten = 0;
  try {
    await expandSheetColumns(wbId, VEHICLE_LOG_SHEET, LOG_COLS);
    const needsHeader = existingRowCount === 0;
    if (needsHeader) {
      await writeRange(wbId, `${VEHICLE_LOG_SHEET}!A1:N1`, [LOG_HEADER]);
      existingRowCount = 1;
    }

    // In-place updates for existing rows (canonical snapshot = latest decision).
    // Adjacent rows are written as one range so a full slate does not consume
    // one Google Sheets write-quota unit per game.
    for (const group of groupContiguousVehicleLogUpdates(rowUpdates)) {
      const startSheetRow = group.start_data_row_index + 2; // +1 header, +1 for 1-based rows
      const endSheetRow = startSheetRow + group.rows.length - 1;
      await writeRange(
        wbId,
        `${VEHICLE_LOG_SHEET}!A${startSheetRow}:N${endSheetRow}`,
        group.rows,
      );
      rowsWritten += group.rows.length;
    }

    // Append new rows not previously in the log
    if (newRows.length > 0) {
      const startRow = existingRowCount + 1;
      await writeRange(
        wbId,
        `${VEHICLE_LOG_SHEET}!A${startRow}:N${startRow + newRows.length - 1}`,
        newRows,
      );
      rowsWritten += newRows.length;
    }

    logger.info(
      { updated: rowUpdates.size, appended: newRows.length, crossDateSkipped },
      "MODULE_17: Vehicle log written",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`VEHICLE_LOG write failed: ${msg}`);
    logger.error({ err: msg }, "MODULE_17: Vehicle log write failed");
  }

  const rowsSkipped = crossDateSkipped;
  const status = errors.length === 0 ? "success" : rowsWritten > 0 ? "partial" : "failure";
  return { status, date, publish_ts: ts, rows_written: rowsWritten, rows_skipped: rowsSkipped, errors };
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
    vehicleRows = all.slice(1).filter((r) => {
      const rowDate   = r[L_DATE]    ?? "";
      const rowGameId = r[L_GAME_ID] ?? "";
      // Only include rows where (a) date matches requested date and
      // (b) game_id date prefix is consistent with the row date — guards against
      // contaminated rows (game_id from wrong date) skewing postmortem grades.
      return rowDate === date && gameIdDateMatchesDate(rowGameId, rowDate);
    });
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
