/**
 * Module 17: Vehicle Postmortem
 *
 * Two-phase module that separates thesis accuracy from ticket result:
 *
 *   Phase 1 — logVehicles()
 *     Called during every publish run (from runner.ts), but writes only games
 *     whose single-source authorization has finalized at board lock. The first
 *     finalized prospective Date + Game_ID record is immutable; provisional
 *     calculations are not misidentified as frozen publications.
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
import { gradeDirectionalOutcome } from "./module14_settlementGrading.js";
import type { SlateBoardEntry } from "./module11_outputExtraction.js";

const VEHICLE_LOG_SHEET  = "VEHICLE_LOG";
const POSTMORTEM_SHEET   = "VEHICLE_POSTMORTEM";
const OUTCOMES_SHEET     = "SHADOW_OUTCOMES";
export const VEHICLE_LOG_COLS = 17;
const LOG_COLS           = VEHICLE_LOG_COLS;
const POSTMORTEM_COLS    = 19;

export interface ContiguousVehicleLogUpdate {
  start_data_row_index: number;
  rows: unknown[][];
}

// ─── Sheet headers ─────────────────────────────────────────────────────────────

export const VEHICLE_LOG_HEADER: string[] = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Vehicle_Type", "Market_Line", "Direction",
  "Projected_Total", "Variance", "Final_Decision", "Core_Blocker",
  "Edge_Strength", "Confidence", "Publish_TS",
  "Packet_Snapshot_TS", "Vehicle_Snapshot_Key", "Record_Integrity_Status",
];

export const POSTMORTEM_HEADER: string[] = [
  "Date", "Game_ID", "Away_Team", "Home_Team",
  "Active_Vehicle_Label", "Vehicle_Type", "Market_Line", "Decision",
  "Packet_Projected_Total", "Actual_Total", "Signed_Error", "Abs_Error",
  "Game_Truth_Grade", "Vehicle_Capture_Grade", "Ticket_Result", "Blocker_Grade",
  "Failure_Modes", "Exact_Blocker", "Graded_TS",
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
const L_PUBLISH_TS     = 13;
export const L_PACKET_SNAPSHOT_TS = 14;
export const L_VEHICLE_SNAPSHOT_KEY = 15;
export const L_RECORD_INTEGRITY_STATUS = 16;

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

export interface VehicleLogIntegrityResult {
  rows: unknown[][];
  rejected: Array<{ date: string; game_id: string; reason: string }>;
  warnings: string[];
}

export interface PostmortemRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  active_vehicle_label: string;
  vehicle_type: string;
  market_line: number | null;
  decision: "BET" | "PASS";
  packet_projected_total: number;
  actual_total: number;
  /** proj − actual (positive = over-projected) */
  signed_error: number;
  abs_error: number;
  /** null when direction is NONE or no market line available */
  game_truth_grade: string;
  vehicle_capture_grade: string;
  /** COVERED / MISSED / PUSH — only meaningful when final_decision === "CORE" */
  ticket_result: string;
  blocker_grade: string;
  failure_modes: string;
  exact_blocker: string;
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

export function gradeTicket(
  direction: string,
  marketLine: number | null,
  actualTotal: number,
): {
  thesis_correct: boolean | "PUSH" | null;
  ticket_result: "COVERED" | "MISSED" | "PUSH" | "NO_BET";
} {
  const outcome = gradeDirectionalOutcome(direction, marketLine, actualTotal);
  if (outcome === "NOT_EVALUABLE") return { thesis_correct: null, ticket_result: "NO_BET" };
  if (outcome === "PUSH") return { thesis_correct: "PUSH", ticket_result: "PUSH" };
  return {
    thesis_correct: outcome === "WIN",
    ticket_result: outcome === "WIN" ? "COVERED" : "MISSED",
  };
}

function activeVehicleLabel(away: string, home: string, direction: string, line: number | null): string {
  if (direction === "NONE" || line === null) return "—";
  return `${away}@${home} FG ${direction === "OVER" ? "Over" : "Under"} ${line}`;
}

function modernVehicleType(direction: string): string {
  if (direction === "OVER") return "FULL_GAME_OVER";
  if (direction === "UNDER") return "FULL_GAME_UNDER";
  return "—";
}

export function postmortemRowToValues(row: PostmortemRow): unknown[] {
  return [
    row.date, row.game_id, row.away_team, row.home_team,
    row.active_vehicle_label, row.vehicle_type, row.market_line ?? "", row.decision,
    row.packet_projected_total, row.actual_total, row.signed_error, row.abs_error,
    row.game_truth_grade, row.vehicle_capture_grade, row.ticket_result, row.blocker_grade,
    row.failure_modes, row.exact_blocker, row.graded_ts,
  ];
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

export function vehicleSnapshotKey(date: string, gameId: string, packetSnapshotTs: string): string {
  return `${date}|${gameId}|${packetSnapshotTs}`;
}

function rowString(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

function hasCanonicalVehicleSnapshotKey(row: unknown[]): boolean {
  const date = rowString(row, L_DATE);
  const gameId = rowString(row, L_GAME_ID);
  const snapshotTs = rowString(row, L_PACKET_SNAPSHOT_TS);
  return Boolean(date && gameId && snapshotTs)
    && rowString(row, L_VEHICLE_SNAPSHOT_KEY) === vehicleSnapshotKey(date, gameId, snapshotTs)
    && rowString(row, L_RECORD_INTEGRITY_STATUS) === "CANONICAL_PACKET_SNAPSHOT";
}

/**
 * VEHICLE_LOG is append-only, so Date + Game_ID is deliberately not a primary
 * key: a game may have multiple legitimate frozen packet snapshots. New rows
 * carry a canonical packet key. For frozen legacy rows only, distinct Publish
 * timestamps are a documented deterministic selection rule. A duplicate
 * legacy Publish_TS (the 20260729_ATL_NYM defect) cannot be disambiguated and
 * is rejected from joins instead of last-row-wins.
 */
export function selectCanonicalVehicleRows(rows: unknown[][]): VehicleLogIntegrityResult {
  const byGame = new Map<string, unknown[][]>();
  for (const row of rows) {
    const date = rowString(row, L_DATE);
    const gameId = rowString(row, L_GAME_ID);
    if (!date || !gameId || !gameIdDateMatchesDate(gameId, date)) continue;
    const key = `${date}|${gameId}`;
    const group = byGame.get(key) ?? [];
    group.push(row);
    byGame.set(key, group);
  }

  const accepted: unknown[][] = [];
  const rejected: VehicleLogIntegrityResult["rejected"] = [];
  const warnings: string[] = [];
  for (const [gameKey, group] of byGame) {
    if (group.length === 1) {
      accepted.push(group[0]!);
      continue;
    }
    const keyed = group.filter(hasCanonicalVehicleSnapshotKey);
    const uniqueKeys = new Set(keyed.map((row) => rowString(row, L_VEHICLE_SNAPSHOT_KEY)));
    if (keyed.length === group.length && uniqueKeys.size === group.length) {
      // Multiple explicitly keyed snapshots are valid refresh history. The
      // newest frozen packet is the deterministic consumer selection rule.
      accepted.push([...keyed].sort((left, right) => rowString(left, L_PACKET_SNAPSHOT_TS).localeCompare(rowString(right, L_PACKET_SNAPSHOT_TS))).at(-1)!);
      continue;
    }
    const publishTimestamps = group.map((row) => rowString(row, L_PUBLISH_TS));
    const uniquePublishTimestamps = new Set(publishTimestamps);
    if (
      keyed.length === 0
      && publishTimestamps.every(Boolean)
      && uniquePublishTimestamps.size === group.length
    ) {
      accepted.push([...group].sort((left, right) => rowString(left, L_PUBLISH_TS).localeCompare(rowString(right, L_PUBLISH_TS))).at(-1)!);
      warnings.push(`VEHICLE_LOG_LEGACY_PUBLISH_TS_SELECTION: ${gameKey} selected latest of ${group.length} unkeyed legacy snapshots`);
      continue;
    }
    const [date, gameId] = gameKey.split("|");
    rejected.push({ date: date!, game_id: gameId!, reason: "VEHICLE_LOG_SNAPSHOT_COLLISION" });
    warnings.push(`VEHICLE_LOG_SNAPSHOT_COLLISION: ${gameKey} has ${group.length} rows without an unambiguous canonical packet snapshot`);
  }
  return { rows: accepted, rejected, warnings };
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

export function selectNewImmutableVehicleRows(
  existingRows: unknown[][],
  candidateRows: unknown[][],
): { newRows: unknown[][]; protectedRows: number } {
  const existingKeys = new Set(existingRows.flatMap((row) => {
    const rowDate = String(row[L_DATE] ?? "");
    const gameId = String(row[L_GAME_ID] ?? "");
    const snapshotKey = String(row[L_VEHICLE_SNAPSHOT_KEY] ?? "");
    return rowDate && gameId && gameIdDateMatchesDate(gameId, rowDate)
      ? [snapshotKey || `LEGACY|${rowDate}|${gameId}`]
      : [];
  }));
  const newRows: unknown[][] = [];
  let protectedRows = 0;
  for (const row of candidateRows) {
    const date = String(row[L_DATE] ?? "");
    const gameId = String(row[L_GAME_ID] ?? "");
    const key = String(row[L_VEHICLE_SNAPSHOT_KEY] ?? "") || `LEGACY|${date}|${gameId}`;
    if (existingKeys.has(key)) {
      protectedRows++;
      continue;
    }
    existingKeys.add(key);
    newRows.push(row);
  }
  return { newRows, protectedRows };
}

export function isFinalizedVehiclePublication(entry: SlateBoardEntry): boolean {
  return entry.lock_status === "LOCKED_IN" || entry.lock_status === "LOCKED_OUT";
}

// ─── Phase 1: log vehicles from a publish run ─────────────────────────────────

export async function logVehicles(
  date: string,
  slateBoard: SlateBoardEntry[],
  options: { workbookId?: string; packetSnapshotTsByGame?: Readonly<Record<string, string>> } = {},
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
  const finalizedEntries = validEntries.filter(isFinalizedVehiclePublication);
  const provisionalSkipped = validEntries.length - finalizedEntries.length;

  // ── Read existing VEHICLE_LOG (full rows for UPSERT) ──────────────────────
  let existingAllRows: unknown[][] = [];
  let existingRowCount = 0;
  try {
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:Q5000`);
    existingAllRows = (resp.values ?? []) as unknown[][];
    existingRowCount = existingAllRows.length;
  } catch {
    logger.warn("MODULE_17: Could not read VEHICLE_LOG — proceeding as empty");
  }

  const existingDataRows = existingAllRows.slice(1); // exclude header row

  // ── Build update and append lists ──────────────────────────────────────────
  const candidateRows: unknown[][] = [];

  for (const e of finalizedEntries) {
    const packetSnapshotTs = String(options.packetSnapshotTsByGame?.[e.legacy_game_id] ?? "").trim();
    if (!packetSnapshotTs) {
      errors.push(`VEHICLE_LOG_PACKET_SNAPSHOT_UNRESOLVED: ${e.legacy_game_id}`);
      continue;
    }
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
      packetSnapshotTs,
      vehicleSnapshotKey(date, e.legacy_game_id, packetSnapshotTs),
      "CANONICAL_PACKET_SNAPSHOT",
    ];

    candidateRows.push(row);
  }
  const immutable = selectNewImmutableVehicleRows(existingDataRows, candidateRows);
  const newRows = immutable.newRows;

  // ── Write ─────────────────────────────────────────────────────────────────
  let rowsWritten = 0;
  try {
    await expandSheetColumns(wbId, VEHICLE_LOG_SHEET, LOG_COLS);
    const needsHeader = existingRowCount === 0;
    if (needsHeader) {
      await writeRange(wbId, `${VEHICLE_LOG_SHEET}!A1:Q1`, [VEHICLE_LOG_HEADER]);
      existingRowCount = 1;
    } else {
      await writeRange(wbId, `${VEHICLE_LOG_SHEET}!A1:Q1`, [VEHICLE_LOG_HEADER]);
    }

    // Append only. Existing prospective rows are immutable evidence and may
    // never be replaced by a later refresh or postgame calculation.
    if (newRows.length > 0) {
      const startRow = existingRowCount + 1;
      await writeRange(
        wbId,
        `${VEHICLE_LOG_SHEET}!A${startRow}:Q${startRow + newRows.length - 1}`,
        newRows,
      );
      rowsWritten += newRows.length;
    }

    logger.info(
      {
        protected: immutable.protectedRows,
        appended: newRows.length,
        crossDateSkipped,
        provisionalSkipped,
      },
      "MODULE_17: Vehicle log written",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`VEHICLE_LOG write failed: ${msg}`);
    logger.error({ err: msg }, "MODULE_17: Vehicle log write failed");
  }

  const rowsSkipped = crossDateSkipped + provisionalSkipped + immutable.protectedRows;
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
    const resp = await readRange(wbId, `${VEHICLE_LOG_SHEET}!A1:Q5000`);
    const all  = (resp.values ?? []) as string[][];
    const dateRows = all.slice(1).filter((r) => String(r[L_DATE] ?? "") === date);
    const integrity = selectCanonicalVehicleRows(dateRows);
    errors.push(...integrity.warnings);
    vehicleRows = (integrity.rows as string[][]).filter((r) => {
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
  type OutcomeData = { actual_total: number };
  const outcomesMap = new Map<string, OutcomeData>();
  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:K5000`);
    const all  = (resp.values ?? []) as string[][];
    for (const r of all.slice(1)) {
      const gid = r[O_GAME_ID] ?? "";
      if (!gid) continue;
      outcomesMap.set(gid, {
        actual_total: parseFloat(r[O_ACTUAL]  ?? "0") || 0,
      });
    }
    logger.info({ outcomes: outcomesMap.size }, "MODULE_17: SHADOW_OUTCOMES loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    return { ...empty("failure"), errors };
  }

  // ── Read existing VEHICLE_POSTMORTEM to avoid duplicates ──
  const existingPmIndex = new Map<string, number>();
  let existingPmRows: unknown[][] = [];
  try {
    const resp = await readRange(wbId, `${POSTMORTEM_SHEET}!A1:S5000`);
    const all  = (resp.values ?? []) as unknown[][];
    existingPmRows = all.slice(1);
    existingPmRows.forEach((r, index) => {
      const key = `${r[0] ?? ""}_${r[1] ?? ""}`;
      if (key !== "_") existingPmIndex.set(key, index);
    });
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
    const marketLine    = r[L_MARKET_LINE] ? parseFloat(r[L_MARKET_LINE]) : null;
    const direction     = (r[L_DIRECTION]     ?? "NONE") as "OVER" | "UNDER" | "NONE";
    const finalDecision = r[L_FINAL_DECISION] ?? "PENDING";
    const vehicleType   = r[L_VEHICLE_TYPE]   ?? "";

    // Only grade thesis/ticket for total-line vehicles (GAME_TOTAL, TEAM_TOTAL_*)
    const isGradeable = vehicleType.includes("TOTAL");
    const { thesis_correct, ticket_result } = isGradeable
      ? gradeTicket(direction, marketLine, outcome.actual_total)
      : { thesis_correct: null, ticket_result: "NO_BET" as const };

    const projected = parseFloat(r[L_PROJ_TOTAL] ?? "0") || 0;
    const signedError = parseFloat((projected - outcome.actual_total).toFixed(2));
    const decision: PostmortemRow["decision"] = finalDecision === "CORE" ? "BET" : "PASS";
    const truthGrade = thesis_correct === null
      ? "TRUTH_NOT_EVALUABLE"
      : thesis_correct === "PUSH"
        ? "TRUTH_PUSH"
        : thesis_correct ? "TRUTH_CONFIRMED" : "TRUTH_FAILED";
    const failureModes = [
      Math.abs(signedError) >= 4 ? "PROJECTION_MISS_4PLUS" : "",
      thesis_correct === false ? "DIRECTION_MISS" : "",
    ].filter(Boolean).join("; ") || "NO_MATERIAL_DEFECT";

    graded.push({
      date,
      game_id:          gameId,
      away_team:        r[L_AWAY] ?? "",
      home_team:        r[L_HOME] ?? "",
      active_vehicle_label: activeVehicleLabel(r[L_AWAY] ?? "", r[L_HOME] ?? "", direction, marketLine),
      vehicle_type:     modernVehicleType(direction),
      market_line:      marketLine,
      decision,
      packet_projected_total: projected,
      actual_total:     outcome.actual_total,
      signed_error:     signedError,
      abs_error:        parseFloat(Math.abs(signedError).toFixed(2)),
      game_truth_grade: truthGrade,
      vehicle_capture_grade: decision === "BET" ? "AUTHORIZED_VEHICLE" : "NO_AUTHORIZED_VEHICLE",
      ticket_result: decision === "BET" ? ticket_result : "NO_WAGER_SHADOW",
      blocker_grade: decision === "BET"
        ? (ticket_result === "COVERED" ? "EXECUTION_CONFIRMED" : "EXECUTION_FAILED")
        : "BLOCKER_RECORDED",
      failure_modes: failureModes,
      exact_blocker: r[L_CORE_BLOCKER] ?? "",
      graded_ts: ts,
    });
  }

  // ── Aggregate stats ──
  const coreGames   = graded.filter((r) => r.decision === "BET");
  const coreCovered = coreGames.filter((r) => r.ticket_result === "COVERED").length;
  const coreMissed  = coreGames.filter((r) => r.ticket_result === "MISSED").length;
  const corePush    = coreGames.filter((r) => r.ticket_result === "PUSH").length;

  const thesisObs = graded.filter((r) =>
    r.game_truth_grade === "TRUTH_CONFIRMED" || r.game_truth_grade === "TRUTH_FAILED",
  );
  const thesisCorrectPct = thesisObs.length > 0
    ? parseFloat(
        (thesisObs.filter((r) => r.game_truth_grade === "TRUTH_CONFIRMED").length / thesisObs.length * 100).toFixed(1),
      )
    : null;

  // ── Write VEHICLE_POSTMORTEM (append) ──
  if (write && graded.length > 0) {
    try {
      await expandSheetColumns(wbId, POSTMORTEM_SHEET, POSTMORTEM_COLS);
      for (const row of graded) {
        const values = postmortemRowToValues(row);
        const key = `${row.date}_${row.game_id}`;
        const index = existingPmIndex.get(key);
        if (index === undefined) {
          existingPmIndex.set(key, existingPmRows.length);
          existingPmRows.push(values);
        } else {
          existingPmRows[index] = values;
        }
      }
      const sheetRows = [POSTMORTEM_HEADER, ...existingPmRows];
      await writeRange(wbId, `${POSTMORTEM_SHEET}!A1`, sheetRows);
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
