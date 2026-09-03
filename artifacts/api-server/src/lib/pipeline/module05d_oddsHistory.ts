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

import { readRange, appendRange, addSheet, expandSheetColumns, writeRange } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { OddsResult } from "./module05b_marketOdds.js";

const SHEET = "ODDS_HISTORY";
export const ODDS_HISTORY_HEADERS = [
  "Snapshot_TS_UTC", "Date", "Game_ID", "Total", "Over_Odds", "Under_Odds", "Bookmaker",
  "Price_Provenance_Status", "Price_Usage_Status", "Provenance_Notes",
] as const;
const HEADER = ODDS_HISTORY_HEADERS;
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

export type OddsPriceProvenanceStatus =
  | "REFERENCE_TOTAL_SYNTHETIC_PRICE"
  | "OBSERVED_REFERENCE_PRICE_UNVERIFIED"
  | "OBSERVED_REFERENCE_PRICE_INVALID_FORMAT"
  | "UNKNOWN_PROVENANCE";

export interface OddsPriceProvenance {
  status: OddsPriceProvenanceStatus;
  usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV";
  notes: string;
}

function validAmericanOdds(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) >= 100;
}

/**
 * Historic source labels alone cannot prove a literal executable price. The
 * only historical auto-classification we can make is Starting Nine's known
 * synthetic -110 convention; everything else stays explicitly unknown.
 */
export function classifyOddsPriceProvenance(
  bookmaker: unknown,
  overOdds: unknown,
  underOdds: unknown,
  historical: boolean,
): OddsPriceProvenance {
  const source = String(bookmaker ?? "").trim().toLowerCase();
  if (source === "mlbstartingnine") {
    return {
      status: "REFERENCE_TOTAL_SYNTHETIC_PRICE",
      usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV",
      notes: "Automated Starting Nine reference total; -110 side prices are synthetic placeholders, not observed executable quotes.",
    };
  }
  if (historical) {
    return {
      status: "UNKNOWN_PROVENANCE",
      usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV",
      notes: "Legacy source label does not establish captured book, quote integrity, or executable price provenance.",
    };
  }
  if (!validAmericanOdds(overOdds) || !validAmericanOdds(underOdds)) {
    return {
      status: "OBSERVED_REFERENCE_PRICE_INVALID_FORMAT",
      usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV",
      notes: "Reference-price capture failed American-odds plausibility validation; retained for provenance only.",
    };
  }
  return {
    status: "OBSERVED_REFERENCE_PRICE_UNVERIFIED",
    usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV",
    notes: "Observed automated reference quote; not verified as a literal executable Hard Rock price.",
  };
}

export function classifyHistoricalOddsHistoryRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => {
    const next = [...row];
    const existing = String(next[7] ?? "").trim();
    if (existing) return next;
    const provenance = classifyOddsPriceProvenance(next[6], next[4], next[5], true);
    next[7] = provenance.status;
    next[8] = provenance.usage_status;
    next[9] = provenance.notes;
    return next;
  });
}

async function ensureSheet(workbookId: string): Promise<void> {
  let created = false;
  try {
    await addSheet(workbookId, SHEET);
    created = true;
    await writeRange(workbookId, `${SHEET}!A1:J1`, [Array.from(HEADER)]);
    logger.info("MODULE_05d: Created ODDS_HISTORY sheet");
  } catch {
    // already exists — expected on every run after the first
  }
  await expandSheetColumns(workbookId, SHEET, HEADER.length);
  if (created) return;

  // Metadata-only migration: append provenance classifications beside frozen
  // historic values; never modify the original line, price, or bookmaker.
  const existing = await readRange(workbookId, `${SHEET}!A1:J20000`);
  const raw = (existing.values ?? []) as unknown[][];
  const data = raw.slice(1);
  await writeRange(workbookId, `${SHEET}!A1:J1`, [Array.from(HEADER)]);
  const labelled = classifyHistoricalOddsHistoryRows(data);
  if (labelled.length > 0) {
    await writeRange(workbookId, `${SHEET}!H2:J${labelled.length + 1}`, labelled.map((row) => [row[7] ?? "", row[8] ?? "", row[9] ?? ""]));
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
    const rows = odds.lines.map((l) => {
      const provenance = classifyOddsPriceProvenance(l.bookmaker, l.over_odds, l.under_odds, false);
      return [
        ts, odds.date, l.game_id, l.total, l.over_odds, l.under_odds, l.bookmaker,
        provenance.status, provenance.usage_status, provenance.notes,
      ];
    });
    const appended = await appendRange(workbookId, `${SHEET}!A:J`, rows);
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
