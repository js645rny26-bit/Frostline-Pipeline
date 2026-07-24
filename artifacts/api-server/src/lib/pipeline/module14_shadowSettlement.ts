/**
 * Module 14: Shadow Settlement
 * Pairs historical shadow projections (from SHADOW_HISTORY) with actual
 * game totals from the MLB Stats API, then appends settled rows to
 * SHADOW_OUTCOMES (an accumulation sheet, never cleared).
 *
 * Designed to be called once per day for the previous day's games, via
 * GET /api/pipeline/settle?date=YYYY-MM-DD (defaults to yesterday).
 *
 * Settlement is idempotent: game_ids already present in SHADOW_OUTCOMES
 * are skipped on re-runs.
 */

import { readRange, writeRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";

const MLB_API  = "https://statsapi.mlb.com/api/v1";
const HISTORY_SHEET  = "SHADOW_HISTORY";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const OUTCOMES_COLS  = 12; // A–L

// SHADOW_HISTORY column indices (0-based) — must match module12s header
const H_DATE       = 0;
const H_GAME_ID    = 1;
const H_AWAY       = 2;
const H_HOME       = 3;
const H_REPAIRED   = 6;   // Repaired_Projected_Total
const H_AWAY_SRC   = 9;   // Away_Offense_Source
const H_HOME_SRC   = 10;  // Home_Offense_Source
const H_PARK_SRC   = 21;  // Park_Source_Status

// ─── SHADOW_OUTCOMES header ───────────────────────────────────────────────────

const OUTCOMES_HEADER = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Repaired_Projected_Total",
  "Actual_Total",
  "Error",          // Proj − Actual (positive = overprojected)
  "Abs_Error",
  "Park_Source_Status",
  "Away_Offense_Source",
  "Home_Offense_Source",
  "Settlement_TS",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SettlementRow {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  repaired_projected_total: number;
  actual_total: number;
  error: number;
  abs_error: number;
  park_source_status: string;
  away_offense_source: string;
  home_offense_source: string;
  settlement_ts: string;
}

export interface SettlementResult {
  status: "success" | "partial" | "failure";
  settle_date: string;
  settlement_timestamp_utc: string;
  games_found: number;       // projected rows found in SHADOW_HISTORY for this date
  games_settled: number;     // rows written to SHADOW_OUTCOMES this run
  games_skipped: number;     // already settled in a prior run
  games_no_actual: number;   // projected but game not yet final
  rows: SettlementRow[];
  errors: string[];
}

// ─── MLB Stats API helpers ────────────────────────────────────────────────────

// full team name (lowercase) → canonical abbr
const FULL_NAME_TO_ABBR: Record<string, string> = {};
for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
  FULL_NAME_TO_ABBR[full_name.toLowerCase()] = canonical_abbr;
}
// "Athletics" (no city) alias
{
  const ath = Object.entries(FULL_NAME_TO_ABBR).find(([n]) => n.includes("athletics"));
  if (ath) FULL_NAME_TO_ABBR["athletics"] = ath[1]!;
}

function teamNameToAbbr(name: string): string | null {
  const lower = name.toLowerCase().trim();
  if (FULL_NAME_TO_ABBR[lower]) return FULL_NAME_TO_ABBR[lower]!;
  const parts = lower.split(" ");
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join(" ");
    if (FULL_NAME_TO_ABBR[candidate]) return FULL_NAME_TO_ABBR[candidate]!;
  }
  return null;
}

interface MlbGame {
  status?: { abstractGameState?: string };
  teams?: {
    away?: { score?: number; team?: { name?: string } };
    home?: { score?: number; team?: { name?: string } };
  };
}

async function fetchActuals(date: string): Promise<Map<string, number>> {
  // Returns map of "AWAY_HOME" (abbr pair key) → actual total runs
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=linescore`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const json = await res.json() as { dates?: Array<{ games?: MlbGame[] }> };
    const map = new Map<string, number>();
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.status?.abstractGameState !== "Final") continue;
        const awayScore = g.teams?.away?.score;
        const homeScore = g.teams?.home?.score;
        if (awayScore === undefined || homeScore === undefined) continue;
        const awayAbbr = teamNameToAbbr(g.teams?.away?.team?.name ?? "");
        const homeAbbr = teamNameToAbbr(g.teams?.home?.team?.name ?? "");
        if (!awayAbbr || !homeAbbr) continue;
        map.set(`${awayAbbr}_${homeAbbr}`, awayScore + homeScore);
      }
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}

function gameIdToTeamKey(gameId: string): string | null {
  // Game_ID format: YYYYMMDD_AWAY_HOME → returns "AWAY_HOME"
  const parts = gameId.split("_");
  if (parts.length < 3) return null;
  return `${parts[1]}_${parts[2]}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runShadowSettlement(
  date: string,
  options: { workbookId?: string } = {},
): Promise<SettlementResult> {
  const ts     = new Date().toISOString();
  const wbId   = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];

  logger.info({ date }, "MODULE_14: Shadow settlement starting");

  // ── Read SHADOW_HISTORY rows for this date ──
  let historyRows: string[][] = [];
  try {
    const resp = await readRange(wbId, `${HISTORY_SHEET}!A1:W5000`);
    const all = (resp.values ?? []) as string[][];
    // Skip header row; filter by date column
    historyRows = all.slice(1).filter(r => (r[H_DATE] ?? "") === date);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_HISTORY read failed: ${msg}`);
    return {
      status: "failure",
      settle_date: date,
      settlement_timestamp_utc: ts,
      games_found: 0,
      games_settled: 0,
      games_skipped: 0,
      games_no_actual: 0,
      rows: [],
      errors,
    };
  }

  const gamesFound = historyRows.length;
  logger.info({ date, gamesFound }, "MODULE_14: History rows loaded");

  if (gamesFound === 0) {
    return {
      status: "success",
      settle_date: date,
      settlement_timestamp_utc: ts,
      games_found: 0,
      games_settled: 0,
      games_skipped: 0,
      games_no_actual: 0,
      rows: [],
      errors,
    };
  }

  // ── Read SHADOW_OUTCOMES to find already-settled game_ids ──
  let existingIds = new Set<string>();
  let existingRowCount = 0;
  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:B5000`);
    const rows = (resp.values ?? []) as string[][];
    existingRowCount = rows.length;
    existingIds = new Set(rows.slice(1).map(r => r[1] ?? "").filter(Boolean));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    // Non-fatal — proceed, de-dup will be skipped
    logger.warn({ err: msg }, "MODULE_14: Could not read SHADOW_OUTCOMES — may produce duplicates");
  }

  // ── Fetch actual scores from MLB Stats API ──
  let actualsMap = new Map<string, number>();
  try {
    actualsMap = await fetchActuals(date);
    logger.info({ date, games: actualsMap.size }, "MODULE_14: Actual scores fetched");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`MLB API actuals fetch failed for ${date}: ${msg}`);
  }

  // ── Settle each history row ──
  const settled: SettlementRow[] = [];
  let skipped = 0;
  let noActual = 0;

  for (const row of historyRows) {
    const gameId = row[H_GAME_ID] ?? "";
    if (!gameId) continue;

    // Dedup
    if (existingIds.has(gameId)) {
      skipped++;
      continue;
    }

    const teamKey = gameIdToTeamKey(gameId);
    const actual  = teamKey ? (actualsMap.get(teamKey) ?? null) : null;

    if (actual === null) {
      noActual++;
      continue;
    }

    const projTotal = parseFloat(row[H_REPAIRED] ?? "0") || 0;
    const error     = parseFloat((projTotal - actual).toFixed(2));
    const absError  = parseFloat(Math.abs(error).toFixed(2));

    settled.push({
      date:                      row[H_DATE]     ?? "",
      game_id:                   gameId,
      away_team:                 row[H_AWAY]     ?? "",
      home_team:                 row[H_HOME]     ?? "",
      repaired_projected_total:  projTotal,
      actual_total:              actual,
      error,
      abs_error:                 absError,
      park_source_status:        row[H_PARK_SRC] ?? "",
      away_offense_source:       row[H_AWAY_SRC] ?? "",
      home_offense_source:       row[H_HOME_SRC] ?? "",
      settlement_ts:             ts,
    });
  }

  // ── Write to SHADOW_OUTCOMES (append after existing rows) ──
  if (settled.length > 0) {
    const newSheetRows = settled.map(r => [
      r.date,
      r.game_id,
      r.away_team,
      r.home_team,
      r.repaired_projected_total,
      r.actual_total,
      r.error,
      r.abs_error,
      r.park_source_status,
      r.away_offense_source,
      r.home_offense_source,
      r.settlement_ts,
    ]);

    try {
      await expandSheetColumns(wbId, OUTCOMES_SHEET, OUTCOMES_COLS);

      // Write header if sheet is empty
      const needsHeader = existingRowCount === 0;
      if (needsHeader) {
        await writeRange(wbId, `${OUTCOMES_SHEET}!A1:L1`, [OUTCOMES_HEADER]);
        existingRowCount = 1;
      }

      const startRow = existingRowCount + 1;
      await writeRange(
        wbId,
        `${OUTCOMES_SHEET}!A${startRow}:L${startRow + newSheetRows.length - 1}`,
        newSheetRows,
      );
      logger.info({ appended: newSheetRows.length, startRow }, "MODULE_14: Shadow outcomes written");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`SHADOW_OUTCOMES write failed: ${msg}`);
      logger.error({ err: msg }, "MODULE_14: Shadow outcomes write failed");
    }
  }

  const overallStatus = errors.length === 0 ? "success"
    : settled.length > 0 ? "partial"
    : "failure";

  logger.info(
    { date, found: gamesFound, settled: settled.length, skipped, noActual, errors: errors.length },
    "MODULE_14: Shadow settlement complete",
  );

  return {
    status:                    overallStatus,
    settle_date:               date,
    settlement_timestamp_utc:  ts,
    games_found:               gamesFound,
    games_settled:             settled.length,
    games_skipped:             skipped,
    games_no_actual:           noActual,
    rows:                      settled,
    errors,
  };
}
