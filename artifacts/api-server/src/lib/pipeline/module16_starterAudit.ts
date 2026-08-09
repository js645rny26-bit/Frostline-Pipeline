/**
 * Module 16: Starter Projection Audit
 *
 * Uses actual starters preserved in SHADOW_OUTCOMES (falling back to the last
 * pregame SHADOW_HISTORY assignment for legacy rows) to surface per-pitcher
 * projection accuracy.
 *
 * Useful for identifying pitchers whose games are consistently over- or
 * under-projected, indicating model blind spots in the starter ERA/FIP inputs.
 *
 * Rows are sorted by MAE descending (most problematic pitchers first).
 * Only pitchers with ≥ minGames (default 3) settled games are included.
 *
 * Endpoint: GET /api/pipeline/starter-audit[?min_games=N&write_sheets=true]
 */

import { readRange, writeRange, clearRange, expandSheetColumns, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { hasUsablePitcherProvenance } from "./module14_pitcherProvenance.js";

const HISTORY_SHEET  = "SHADOW_HISTORY";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const AUDIT_SHEET    = "STARTER_AUDIT";
const AUDIT_COLS     = 10;

// SHADOW_HISTORY column indices (0-based)
// Date | Game_ID | Away | Home | Away_Pitcher | Home_Pitcher | ...
const H_DATE         = 0;
const H_GAME_ID      = 1;
const H_AWAY_PITCHER = 4;
const H_HOME_PITCHER = 5;

// SHADOW_OUTCOMES column indices (0-based)
// Date | Game_ID | Away | Home | Proj | Actual | Error | Abs_Error | ...
const O_GAME_ID = 1;
const O_ERROR   = 6;
const O_ABS     = 7;
const O_DATE    = 0;
const O_FROZEN_ERROR = 13;
const O_FROZEN_ABS = 14;
const O_FROZEN_SOURCE = 15;
const O_ACTUAL_AWAY_STARTER = 24;
const O_ACTUAL_HOME_STARTER = 25;
const O_PROVENANCE_STATUS = 32;

const AUDIT_HEADER = [
  "Pitcher", "N_Games",
  "MAE", "Bias", "Over_Pct", "Under_Pct", "Miss_4Plus_Pct",
  "Bias_Direction",
  "First_Date", "Last_Date",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StarterAuditRow {
  pitcher: string;
  n_games: number;
  mae: number;
  bias: number;
  over_pct: number;
  under_pct: number;
  miss_4plus_pct: number;
  /** "OVER" = engine systematically projects high; "UNDER" = projects low; "NEUTRAL" */
  bias_direction: "OVER" | "UNDER" | "NEUTRAL";
  first_date: string;
  last_date: string;
}

export interface StarterAuditResult {
  status: "success" | "partial" | "failure";
  audit_timestamp_utc: string;
  total_settled_games: number;
  pitchers_audited: number;
  /** Pitchers with |bias| > 0.5 and ≥ minGames — model calibration candidates */
  flagged_pitchers: number;
  rows: StarterAuditRow[];
  errors: string[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runStarterAudit(
  options: { workbookId?: string; writeSheets?: boolean; minGames?: number } = {},
): Promise<StarterAuditResult> {
  const ts       = new Date().toISOString();
  const wbId     = options.workbookId ?? WORKBOOK_ID;
  const write    = options.writeSheets ?? false;
  const minGames = options.minGames ?? 3;
  const errors: string[] = [];

  logger.info({ minGames }, "MODULE_16: Starter audit starting");

  // ── Read SHADOW_HISTORY (pitcher names) ──
  // Keep most recent row per game_id — later publishes have updated pitcher assignments.
  type HistEntry = { date: string; away_pitcher: string; home_pitcher: string };
  const historyMap = new Map<string, HistEntry>();

  try {
    const resp = await readRange(wbId, `${HISTORY_SHEET}!A1:F5000`);
    const raw  = (resp.values ?? []) as string[][];
    for (const r of raw.slice(1)) {
      const gid = r[H_GAME_ID] ?? "";
      if (!gid) continue;
      historyMap.set(gid, {
        date:         r[H_DATE]          ?? "",
        away_pitcher: r[H_AWAY_PITCHER]  ?? "",
        home_pitcher: r[H_HOME_PITCHER]  ?? "",
      });
    }
    logger.info({ games: historyMap.size }, "MODULE_16: SHADOW_HISTORY loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_HISTORY read failed: ${msg}`);
    return {
      status: "failure", audit_timestamp_utc: ts,
      total_settled_games: 0, pitchers_audited: 0, flagged_pitchers: 0,
      rows: [], errors,
    };
  }

  // ── Read SHADOW_OUTCOMES (settled errors) ──
  type OutcomeEntry = {
    game_id: string;
    date: string;
    error: number;
    abs_error: number;
    actual_away_starter: string;
    actual_home_starter: string;
    provenance_status: string;
  };
  let outcomes: OutcomeEntry[] = [];

  try {
    const resp = await readRange(wbId, `${OUTCOMES_SHEET}!A1:AG5000`);
    const raw  = (resp.values ?? []) as string[][];
    const latestByGame = new Map<string, OutcomeEntry>();
    for (const r of raw.slice(1)) {
      const gameId = r[O_GAME_ID] ?? "";
      if (!gameId) continue;
      latestByGame.set(gameId, {
        game_id:   r[O_GAME_ID] ?? "",
        date:      r[O_DATE] ?? "",
        error:     parseFloat((r[O_FROZEN_SOURCE] === "FROZEN_VEHICLE_LOG" ? r[O_FROZEN_ERROR] : r[O_ERROR]) ?? "0") || 0,
        abs_error: parseFloat((r[O_FROZEN_SOURCE] === "FROZEN_VEHICLE_LOG" ? r[O_FROZEN_ABS] : r[O_ABS]) ?? "0") || 0,
        actual_away_starter: r[O_ACTUAL_AWAY_STARTER] ?? "",
        actual_home_starter: r[O_ACTUAL_HOME_STARTER] ?? "",
        provenance_status: r[O_PROVENANCE_STATUS] ?? "",
      });
    }
    outcomes = [...latestByGame.values()];
    logger.info({ outcomes: outcomes.length }, "MODULE_16: SHADOW_OUTCOMES loaded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`SHADOW_OUTCOMES read failed: ${msg}`);
    return {
      status: "failure", audit_timestamp_utc: ts,
      total_settled_games: 0, pitchers_audited: 0, flagged_pitchers: 0,
      rows: [], errors,
    };
  }

  if (outcomes.length === 0) {
    return {
      status: "success", audit_timestamp_utc: ts,
      total_settled_games: 0, pitchers_audited: 0, flagged_pitchers: 0,
      rows: [], errors,
    };
  }

  // ── Join outcomes → pitcher observations ──
  // Each settled game contributes one obs for the away starter and one for the home starter.
  // Error on the game total (proj − actual) is attributed to both pitchers equally —
  // it's a blunt signal, but it accumulates directional bias over many starts.
  type PitcherObs = { date: string; error: number; abs_error: number };
  const pitcherMap = new Map<string, PitcherObs[]>();

  const SKIP_VALUES = new Set(["UNRESOLVED", "TBD", "", "Unknown"]);

  for (const outcome of outcomes) {
    const hist = historyMap.get(outcome.game_id);
    const date = outcome.date || hist?.date || "";
    const useActual = hasUsablePitcherProvenance(outcome.provenance_status);
    const awayPitcher = (useActual ? outcome.actual_away_starter : "") || hist?.away_pitcher || "";
    const homePitcher = (useActual ? outcome.actual_home_starter : "") || hist?.home_pitcher || "";

    for (const pitcher of [awayPitcher, homePitcher]) {
      if (!pitcher || SKIP_VALUES.has(pitcher)) continue;
      if (!pitcherMap.has(pitcher)) pitcherMap.set(pitcher, []);
      pitcherMap.get(pitcher)!.push({
        date,
        error:     outcome.error,
        abs_error: outcome.abs_error,
      });
    }
  }

  // ── Compute metrics per pitcher ──
  const auditRows: StarterAuditRow[] = [];

  for (const [pitcher, obs] of pitcherMap.entries()) {
    if (obs.length < minGames) continue;

    const n    = obs.length;
    const abs  = obs.map((o) => o.abs_error);
    const errs = obs.map((o) => o.error);
    const mae  = parseFloat((abs.reduce((a, b) => a + b, 0) / n).toFixed(3));
    const bias = parseFloat((errs.reduce((a, b) => a + b, 0) / n).toFixed(3));
    const over  = obs.filter((o) => o.error > 0).length;
    const under = obs.filter((o) => o.error < 0).length;
    const miss4 = obs.filter((o) => o.abs_error >= 4).length;

    const bias_direction: StarterAuditRow["bias_direction"] =
      Math.abs(bias) < 0.3 ? "NEUTRAL" : bias > 0 ? "OVER" : "UNDER";

    const dates = obs.map((o) => o.date).sort();

    auditRows.push({
      pitcher,
      n_games: n,
      mae,
      bias,
      over_pct:      parseFloat((over  / n * 100).toFixed(1)),
      under_pct:     parseFloat((under / n * 100).toFixed(1)),
      miss_4plus_pct: parseFloat((miss4 / n * 100).toFixed(1)),
      bias_direction,
      first_date: dates[0]!,
      last_date:  dates[dates.length - 1]!,
    });
  }

  // Sort by MAE descending — worst-performing pitchers at the top
  auditRows.sort((a, b) => b.mae - a.mae);

  const flagged = auditRows.filter((r) => Math.abs(r.bias) > 0.5).length;

  // ── Optionally write STARTER_AUDIT sheet ──
  if (write) {
    try {
      await expandSheetColumns(wbId, AUDIT_SHEET, AUDIT_COLS);
      await clearRange(wbId, `${AUDIT_SHEET}!A1:J5000`);
      await writeRange(wbId, `${AUDIT_SHEET}!A1:J1`, [AUDIT_HEADER]);
      const sheetRows = auditRows.map((r) => [
        r.pitcher, r.n_games,
        r.mae, r.bias, r.over_pct, r.under_pct, r.miss_4plus_pct,
        r.bias_direction,
        r.first_date, r.last_date,
      ]);
      if (sheetRows.length > 0) {
        await writeRange(wbId, `${AUDIT_SHEET}!A2:J${1 + sheetRows.length}`, sheetRows);
      }
      logger.info({ rows: auditRows.length }, "MODULE_16: Starter audit written to sheet");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Starter audit sheet write failed: ${msg}`);
      logger.warn({ err: msg }, "MODULE_16: Starter audit sheet write failed — result still returned");
    }
  }

  const status = errors.length === 0 ? "success" : auditRows.length > 0 ? "partial" : "failure";

  logger.info(
    { pitchers: auditRows.length, flagged, outcomes: outcomes.length },
    "MODULE_16: Starter audit complete",
  );

  return {
    status,
    audit_timestamp_utc: ts,
    total_settled_games: outcomes.length,
    pitchers_audited:    auditRows.length,
    flagged_pitchers:    flagged,
    rows:                auditRows,
    errors,
  };
}
