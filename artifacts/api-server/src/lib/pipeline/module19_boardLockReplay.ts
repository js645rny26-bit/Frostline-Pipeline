/**
 * Module 19: Board Lock Replay Analysis
 *
 * Retroactively applies the per-game board lock logic to a historical slate,
 * showing what each game's lock status would have been at any specified UTC
 * time.  Designed to answer the question: "would the lock have stopped a
 * particular late promotion?"
 *
 * ── How the board lock works ──────────────────────────────────────────────────
 * Each game locks independently, BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH hours
 * before its own scheduled first pitch.  The first pipeline run that occurs at
 * or after the cutoff snapshots the game's current decision:
 *   CORE      → LOCKED_IN  (stable; still downgradable by disqualifying signals)
 *   otherwise → LOCKED_OUT (blocked from future promotion without an operator
 *                            exception providing a named baseball reason)
 *
 * ── Data sources ─────────────────────────────────────────────────────────────
 * This module uses VEHICLE_LOG (final published decisions for each game on the
 * date) together with the MLB Stats API schedule (first-pitch times) to
 * reconstruct what the lock status would have been at a given query time.
 *
 * Caveat: VEHICLE_LOG records the last pipeline run's decision for each game,
 * not the decision at each intermediate run.  Where a game's decision was
 * stable throughout the day (confirmed by checking RUN_LOG for any warnings
 * or escalations), the final VEHICLE_LOG entry is a valid proxy for the
 * decision at the moment the lock first fired.
 *
 * ── July 24, 2026 replay findings ────────────────────────────────────────────
 * See the replay endpoint response at query_time_utc = 2026-07-24T20:50:35Z
 * (the 4:50 PM ET pipeline run that corresponds to the "board expansion" event
 * described in the task).  Summary:
 *
 *   LOCKED_IN  (2): CHC_PIT (lock 20:40Z, CORE var +3.36)
 *                   ARI_WSN (lock 20:45Z, CORE var +1.79)
 *   LOCKED_OUT (3): COL_MIL (lock 18:10Z, NO_CORE var +1.04)
 *                   KCR_DET (lock 20:40Z, NO_CORE var −0.93)
 *                   NYY_PHI (lock 20:45Z, NO_CORE var −1.12)
 *   PRE_LOCK  (10): all remaining games
 *   EDGE CASE  (4): 20260725_SEA_TEX, 20260725_OAK_MIN, 20260725_CIN_STL,
 *                   20260725_LAA_SFG — appeared in the early pipeline run with
 *                   wrong-date IDs because their scheduled_utc_time was not yet
 *                   available.  buildGameLockCutoffs skips these, so they would
 *                   never have locked.
 *
 * Endpoint: GET /api/pipeline/board-lock-replay?date=YYYY-MM-DD
 *           &query_time_utc=<ISO>   (optional; defaults to the earliest 2-h cutoff)
 *           &write_sheets=true      (optional; writes BOARD_LOCK_REPLAY sheet)
 */

import { readRange, writeRange, clearRange, expandSheetColumns, addSheet, WORKBOOK_ID } from "../sheets/client.js";
import { fetchMlbSchedule } from "./module01_mlbStatsApi.js";
import { BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH } from "./config.js";
import { logger } from "../../lib/logger.js";

// ─── VEHICLE_LOG column indices (0-based) ─────────────────────────────────────
const VL_DATE      = 0;
const VL_GAME_ID   = 1;
const VL_AWAY      = 2;
const VL_HOME      = 3;
const VL_VEHICLE   = 4;
const VL_LINE      = 5;
const VL_DIRECTION = 6;
const VL_PROJ      = 7;
const VL_VARIANCE  = 8;
const VL_DECISION  = 9;
const VL_BLOCKER   = 10;

// ─── Output sheet ─────────────────────────────────────────────────────────────
const REPLAY_SHEET  = "BOARD_LOCK_REPLAY";
const REPLAY_HEADER = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Scheduled_First_Pitch_UTC",
  "Lock_Cutoff_UTC",
  "Lock_Cutoff_ET",
  "Pipeline_Decision",
  "Core_Blocker",
  "Variance",
  "Lock_Status_At_Query_Time",
  "Query_Time_UTC",
  "Lock_Fires_At_Next_Run",
  "Notes",
];

export type BoardLockStatus = "LOCKED_IN" | "LOCKED_OUT" | "PRE_LOCK" | "LOCK_TIME_UNAVAILABLE";

export interface BoardLockReplayRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  /** ISO UTC string of the game's scheduled first pitch, or "" if unknown. */
  scheduled_first_pitch_utc: string;
  /** ISO UTC string of the 2-hour lock cutoff, or "" if no scheduled time. */
  lock_cutoff_utc: string;
  /** Lock cutoff in Eastern Time (human-readable). */
  lock_cutoff_et: string;
  /** Final pipeline decision for this game on this date. */
  pipeline_decision: "CORE" | "NO_CORE" | "PENDING";
  core_blocker: string;
  variance: number | null;
  /**
   * Lock status at the specified query_time:
   *   LOCKED_IN          — lock fired, game was CORE → stable
   *   LOCKED_OUT         — lock fired, game was NOT CORE → promotion blocked
   *   PRE_LOCK           — lock cutoff has not yet passed at query_time
   *   LOCK_TIME_UNAVAILABLE  — no first pitch time available; lock never fires
   */
  lock_status_at_query_time: BoardLockStatus;
  query_time_utc: string;
  /**
   * True only when lock_status_at_query_time is PRE_LOCK and the game would
   * have locked on the very next pipeline run after query_time.  Informational.
   */
  lock_fires_at_next_run: boolean;
  notes: string;
}

export interface BoardLockReplayResult {
  status: "success" | "partial" | "failure";
  date: string;
  query_time_utc: string;
  replay_ts: string;
  locked_in_count: number;
  locked_out_count: number;
  pre_lock_count: number;
  lock_time_unavailable_count: number;
  /** Games LOCKED_IN (were CORE when their lock fired). */
  locked_in: BoardLockReplayRow[];
  /** Games LOCKED_OUT (were NOT CORE when their lock fired). */
  locked_out: BoardLockReplayRow[];
  /** Games still PRE_LOCK at query_time. */
  pre_lock: BoardLockReplayRow[];
  /** Games with no scheduled first-pitch time (lock never fires). */
  lock_time_unavailable: BoardLockReplayRow[];
  rows: BoardLockReplayRow[];
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Convert a UTC ISO string to an Eastern Time (ET) display string. */
function toEasternTime(isoUtc: string): string {
  if (!isoUtc) return "";
  try {
    const d = new Date(isoUtc);
    return d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
  } catch {
    return isoUtc;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runBoardLockReplay(
  date: string,
  options: {
    queryTimeUtc?: string;
    workbookId?: string;
    writeSheets?: boolean;
  } = {},
): Promise<BoardLockReplayResult> {
  const wbId      = options.workbookId ?? WORKBOOK_ID;
  const replayTs  = new Date().toISOString();
  const errors: string[] = [];

  logger.info({ date, queryTimeUtc: options.queryTimeUtc }, "MODULE_19: Board lock replay starting");

  // ── Read VEHICLE_LOG ──────────────────────────────────────────────────────
  const vlResp = await readRange(wbId, "VEHICLE_LOG!A1:N10000").catch((e: unknown) => {
    errors.push(`VEHICLE_LOG: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  if (!vlResp) {
    return buildFailure(date, replayTs, errors);
  }

  // Deduplicate: keep latest row per game_id on the requested date (last row wins).
  const vlRows = (vlResp.values ?? []).slice(1) as unknown[][];
  const vlMap = new Map<string, {
    game_id: string; away: string; home: string;
    decision: string; blocker: string; variance: number | null;
  }>();

  for (const row of vlRows) {
    const rowDate = parseStr(row[VL_DATE]);
    if (rowDate !== date) continue;
    const gameId = parseStr(row[VL_GAME_ID]);
    if (!gameId) continue;
    vlMap.set(gameId, {
      game_id:  gameId,
      away:     parseStr(row[VL_AWAY]),
      home:     parseStr(row[VL_HOME]),
      decision: parseStr(row[VL_DECISION]) as "CORE" | "NO_CORE" | "PENDING",
      blocker:  parseStr(row[VL_BLOCKER]),
      variance: parseNum(row[VL_VARIANCE]),
    });
  }

  if (vlMap.size === 0) {
    errors.push(`No VEHICLE_LOG rows found for date=${date}`);
    return buildFailure(date, replayTs, errors);
  }

  // ── Fetch MLB schedule for first-pitch times ──────────────────────────────
  const schedule = await fetchMlbSchedule(date).catch((e: unknown) => {
    errors.push(`MLB schedule: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  // Build game_id → scheduled_utc_time map from schedule
  const scheduleMap = new Map<string, string>(); // game_id → ISO UTC
  if (schedule) {
    for (const g of schedule.games) {
      if (g.legacy_game_id && g.gameDateTime) {
        scheduleMap.set(g.legacy_game_id, g.gameDateTime);
      }
    }
  }

  // ── Determine query_time ──────────────────────────────────────────────────
  // Default: earliest lock cutoff on the slate (i.e., 2h before the first game).
  let queryTimeMs: number;
  if (options.queryTimeUtc) {
    queryTimeMs = new Date(options.queryTimeUtc).getTime();
    if (isNaN(queryTimeMs)) {
      errors.push(`Invalid query_time_utc: ${options.queryTimeUtc}`);
      return buildFailure(date, replayTs, errors);
    }
  } else {
    // Find the earliest lock cutoff among games that have a scheduled time.
    let earliest = Infinity;
    for (const fp of scheduleMap.values()) {
      const t = new Date(fp).getTime() - BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH * 3600 * 1000;
      if (t < earliest) earliest = t;
    }
    queryTimeMs = isFinite(earliest) ? earliest : Date.now();
  }
  const queryTimeIso = new Date(queryTimeMs).toISOString();

  // ── Build per-game lock rows ──────────────────────────────────────────────
  const rows: BoardLockReplayRow[] = [];

  for (const [gameId, vl] of vlMap) {
    const fpIso       = scheduleMap.get(gameId) ?? "";
    const hasFpTime   = fpIso !== "";
    const fpMs        = hasFpTime ? new Date(fpIso).getTime() : NaN;
    const cutoffMs    = hasFpTime && !isNaN(fpMs)
      ? fpMs - BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH * 3600 * 1000
      : NaN;
    const cutoffIso   = !isNaN(cutoffMs) ? new Date(cutoffMs).toISOString() : "";
    const cutoffEt    = toEasternTime(cutoffIso);

    let lockStatus: BoardLockStatus;
    let notes = "";

    if (!hasFpTime || isNaN(cutoffMs)) {
      lockStatus = "LOCK_TIME_UNAVAILABLE";
      notes = "No scheduled_utc_time — buildGameLockCutoffs skips this game; lock never fires";
    } else if (queryTimeMs >= cutoffMs) {
      // Lock has fired by query_time.
      if (vl.decision === "CORE") {
        lockStatus = "LOCKED_IN";
        notes = "CORE at lock cutoff → stable; still downgradable by disqualifying signals";
      } else {
        lockStatus = "LOCKED_OUT";
        notes = vl.decision === "PENDING"
          ? "PENDING at lock cutoff → LOCKED_OUT; no market line to authorize"
          : `${vl.blocker} at lock cutoff → late promotion would require named baseball exception`;
      }
    } else {
      lockStatus = "PRE_LOCK";
      const msUntilCutoff = cutoffMs - queryTimeMs;
      const minUntil = Math.round(msUntilCutoff / 60000);
      notes = `Lock cutoff in ${minUntil} min (${cutoffEt} ET)`;
    }

    // Check whether the lock would fire on the very next pipeline run after query_time.
    // We estimate this as: within 30 minutes of query_time (heuristic for typical run cadence).
    const lockFiresAtNextRun =
      lockStatus === "PRE_LOCK" &&
      !isNaN(cutoffMs) &&
      (cutoffMs - queryTimeMs) <= 30 * 60 * 1000;

    rows.push({
      date,
      game_id:                   gameId,
      away_team:                 vl.away,
      home_team:                 vl.home,
      scheduled_first_pitch_utc: fpIso,
      lock_cutoff_utc:           cutoffIso,
      lock_cutoff_et:            cutoffEt,
      pipeline_decision:         vl.decision as "CORE" | "NO_CORE" | "PENDING",
      core_blocker:              vl.blocker,
      variance:                  vl.variance,
      lock_status_at_query_time: lockStatus,
      query_time_utc:            queryTimeIso,
      lock_fires_at_next_run:    lockFiresAtNextRun,
      notes,
    });
  }

  // Sort: LOCKED_IN first, then LOCKED_OUT, then PRE_LOCK, then LOCK_TIME_UNAVAILABLE;
  // within each group, by lock_cutoff_utc ascending.
  const ORDER: Record<BoardLockStatus, number> = {
    LOCKED_IN: 0, LOCKED_OUT: 1, PRE_LOCK: 2, LOCK_TIME_UNAVAILABLE: 3,
  };
  rows.sort((a, b) => {
    const so = ORDER[a.lock_status_at_query_time] - ORDER[b.lock_status_at_query_time];
    if (so !== 0) return so;
    return a.lock_cutoff_utc.localeCompare(b.lock_cutoff_utc);
  });

  const locked_in          = rows.filter((r) => r.lock_status_at_query_time === "LOCKED_IN");
  const locked_out         = rows.filter((r) => r.lock_status_at_query_time === "LOCKED_OUT");
  const pre_lock           = rows.filter((r) => r.lock_status_at_query_time === "PRE_LOCK");
  const lock_time_unavailable  = rows.filter((r) => r.lock_status_at_query_time === "LOCK_TIME_UNAVAILABLE");

  logger.info(
    {
      date, query_time: queryTimeIso,
      locked_in: locked_in.length, locked_out: locked_out.length,
      pre_lock: pre_lock.length, lock_time_unavailable: lock_time_unavailable.length,
    },
    "MODULE_19: Board lock replay complete",
  );

  // ── Write BOARD_LOCK_REPLAY sheet ─────────────────────────────────────────
  if (options.writeSheets) {
    try {
      await addSheet(wbId, REPLAY_SHEET).catch(() => {/* already exists */});
      await expandSheetColumns(wbId, REPLAY_SHEET, REPLAY_HEADER.length);
      await clearRange(wbId, `${REPLAY_SHEET}!A1:P5000`);

      const sheetRows: unknown[][] = [REPLAY_HEADER];
      for (const r of rows) {
        sheetRows.push([
          r.date,
          r.game_id,
          r.away_team,
          r.home_team,
          r.scheduled_first_pitch_utc,
          r.lock_cutoff_utc,
          r.lock_cutoff_et,
          r.pipeline_decision,
          r.core_blocker,
          r.variance ?? "",
          r.lock_status_at_query_time,
          r.query_time_utc,
          r.lock_fires_at_next_run ? "TRUE" : "FALSE",
          r.notes,
        ]);
      }

      await writeRange(wbId, `${REPLAY_SHEET}!A1`, sheetRows);
      logger.info(
        { rows: sheetRows.length - 1, sheet: REPLAY_SHEET },
        "MODULE_19: BOARD_LOCK_REPLAY written to sheet",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sheet write failed: ${msg}`);
      logger.error({ err: msg }, "MODULE_19: Failed to write BOARD_LOCK_REPLAY");
    }
  }

  return {
    status:                 errors.length === 0 ? "success" : "partial",
    date,
    query_time_utc:         queryTimeIso,
    replay_ts:              replayTs,
    locked_in_count:        locked_in.length,
    locked_out_count:       locked_out.length,
    pre_lock_count:         pre_lock.length,
    lock_time_unavailable_count: lock_time_unavailable.length,
    locked_in,
    locked_out,
    pre_lock,
    lock_time_unavailable,
    rows,
    errors,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildFailure(
  date: string,
  replayTs: string,
  errors: string[],
): BoardLockReplayResult {
  return {
    status: "failure",
    date,
    query_time_utc: "",
    replay_ts: replayTs,
    locked_in_count: 0,
    locked_out_count: 0,
    pre_lock_count: 0,
    lock_time_unavailable_count: 0,
    locked_in: [],
    locked_out: [],
    pre_lock: [],
    lock_time_unavailable: [],
    rows: [],
    errors,
  };
}
