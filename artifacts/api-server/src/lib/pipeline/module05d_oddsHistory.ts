/**
 * Module 05d: O/U Line Movement Tracking
 * Every pipeline run appends the current totals snapshot to an ODDS_HISTORY
 * sheet, then computes movement for each game: today's earliest logged line
 * (the "opener" from our perspective) vs the current line.
 *
 * ODDS_HISTORY columns:
 *   A: Snapshot_TS_UTC | B: Date | C: Game_ID | D: Total | E: Over_Odds
 *   F: Under_Odds | G: Bookmaker
 *
 * A negative move (8.5 → 7.5 = -1.0) signals money on the under.
 */

import { readRange, appendRange, addSheet } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { OddsResult } from "./module05b_marketOdds.js";

const SHEET = "ODDS_HISTORY";
const HEADER = ["Snapshot_TS_UTC", "Date", "Game_ID", "Total", "Over_Odds", "Under_Odds", "Bookmaker"];
// Bounded read window: appends are chronological, so today's snapshots always
// live in the last N rows. 2000 rows covers days of snapshots even at
// 15 games × dozens of runs/day — safe no matter how large the sheet grows.
const TAIL_WINDOW_ROWS = 2000;

/** "ODDS_HISTORY!A123:G127" → 127; null if the range is missing/unparseable */
function parseEndRow(updatedRange: string | null): number | null {
  if (!updatedRange) return null;
  const m = /(\d+)\s*$/.exec(updatedRange);
  return m ? Number(m[1]) : null;
}

export interface LineMovement {
  game_id: string;
  open: number;      // earliest total we logged today
  current: number;   // this run's total
  move: number;      // current - open (negative = line dropped)
}

export interface LineMovementResult {
  status: "success" | "failure";
  date: string;
  snapshots_appended: number;
  movement: Map<string, LineMovement>;
  error?: string;
}

async function ensureSheet(workbookId: string): Promise<void> {
  try {
    await addSheet(workbookId, SHEET);
    await appendRange(workbookId, `${SHEET}!A1:G1`, [HEADER]);
    logger.info("MODULE_05d: Created ODDS_HISTORY sheet");
  } catch {
    // already exists — expected on every run after the first
  }
}

export async function trackLineMovement(
  odds: OddsResult,
  workbookId: string,
): Promise<LineMovementResult> {
  const result: LineMovementResult = {
    status: "success",
    date: odds.date,
    snapshots_appended: 0,
    movement: new Map(),
  };

  if (odds.status !== "success" || odds.lines.length === 0) {
    return result; // nothing to track — no key or no lines
  }

  try {
    await ensureSheet(workbookId);

    // 1. Append this run's snapshot
    const ts = new Date().toISOString();
    const rows = odds.lines.map((l) => [
      ts, odds.date, l.game_id, l.total, l.over_odds, l.under_odds, l.bookmaker,
    ]);
    const appended = await appendRange(workbookId, `${SHEET}!A:G`, rows);
    result.snapshots_appended = appended.updatedRows;

    // 2. Read back today's snapshots → earliest total per game = opener.
    //    Anchor the read to the append's own end row so we scan a bounded tail
    //    window instead of the whole sheet (a fixed full-sheet range silently
    //    misses today's rows once history outgrows it).
    const endRow = parseEndRow(appended.updatedRange);
    if (endRow === null) {
      logger.warn("MODULE_05d: append returned no range; using top-window fallback");
    }
    const window = endRow === null
      ? `${SHEET}!A2:G${TAIL_WINDOW_ROWS}`
      : `${SHEET}!A${Math.max(2, endRow - TAIL_WINDOW_ROWS + 1)}:G${endRow}`;
    const read = await readRange(workbookId, window);
    const earliest = new Map<string, { ts: string; total: number }>();
    for (const row of read.values ?? []) {
      const [snapTs, rowDate, gameId, totalRaw] = row as [string?, string?, string?, unknown?];
      if (rowDate !== odds.date || !gameId || !snapTs) continue;
      const total = Number(totalRaw);
      if (!Number.isFinite(total) || total === 0) continue;
      const prev = earliest.get(gameId);
      if (!prev || snapTs < prev.ts) earliest.set(gameId, { ts: snapTs, total });
    }

    // 3. Movement per game on today's slate
    for (const l of odds.lines) {
      if (!l.market_available || l.total === 0) continue;
      const open = earliest.get(l.game_id)?.total ?? l.total;
      result.movement.set(l.game_id, {
        game_id: l.game_id,
        open,
        current: l.total,
        move: parseFloat((l.total - open).toFixed(1)),
      });
    }

    logger.info(
      { appended: result.snapshots_appended, games: result.movement.size },
      "MODULE_05d: Line movement tracked",
    );
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "MODULE_05d: Line movement tracking failed");
    return { ...result, status: "failure", error: message };
  }
}
