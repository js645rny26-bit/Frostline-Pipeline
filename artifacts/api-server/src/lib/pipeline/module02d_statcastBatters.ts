/**
 * Module 02d: Statcast Batter Leaderboard
 *
 * Fetches the Baseball Savant expected-statistics leaderboard for a given season
 * as a single CSV download. This avoids per-player API calls — one request covers
 * every qualifying batter in MLB.
 *
 * Metrics extracted per player when the endpoint exposes them:
 *   xwOBA  — expected weighted on-base average (contact-quality gold standard)
 *   xBA    — expected batting average
 *   xSLG   — expected slugging
 *   barrel_rate   — barrels / PA % (optional source field)
 *   hard_hit_pct  — hard-hit rate % (optional source field)
 *   exit_velo_avg — average exit velocity (mph; optional source field)
 *
 * xwOBA removes luck (BABIP, sequencing) by computing expected outcomes from
 * exit velocity and launch angle. It is a stronger forward predictor than actual
 * OPS, particularly for short samples and players with BABIP outliers.
 *
 * Minimum PA threshold (min=50) is applied at the source request; the module
 * also enforces MIN_STATCAST_PA after parsing for defence in depth.
 *
 * Used by module09 to blend xwOBA into the batting-order-weighted lineup factor.
 * Damage metrics are independently schema-checked and cannot become active merely
 * because the xwOBA payload parsed successfully.
 * The map is keyed by MLBAM player_id — the same ID space as modules 02b/02c.
 */

import { logger } from "../../lib/logger.js";

/** Minimum plate appearances before a batter's Statcast stats are used. */
export const MIN_STATCAST_PA = 50;

/** 2024–2026 MLB league-average xwOBA (contact-quality baseline). */
export const LEAGUE_AVG_XWOBA = 0.315;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatcastBatterStats {
  batter_id: number;
  name: string;
  pa: number;
  xwoba: number | null;
  xba: number | null;
  xslg: number | null;
  /** Barrels per plate appearance, as a percentage (e.g. 8.5 = 8.5%). */
  barrel_rate: number | null;
  /** Hard-hit rate — balls hit ≥ 95 mph exit velocity (e.g. 45.2 = 45.2%). */
  hard_hit_pct: number | null;
  /** Average exit velocity in mph. */
  exit_velo_avg: number | null;
}

export interface StatcastBatterResult {
  status: "success" | "partial" | "failure";
  season: string;
  stats: Map<number, StatcastBatterStats>;
  fetched: number;
  source_url: string;
  observed_columns: string[];
  hard_hit_fetched: number;
  barrel_fetched: number;
  damage_metric_status:
    | "AVAILABLE"
    | "SOURCE_SCHEMA_MISSING"
    | "NO_QUALIFYING_DAMAGE_ROWS";
  errors: string[];
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Minimal CSV parser that handles quoted fields (Baseball Savant's first column
 * is `"last_name, first_name"` — a quoted field containing a comma).
 */
function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "" || t === "null" || t === "NA" || t === "N/A" || t === ".") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the index of a header column by trying multiple name variants
 * (Baseball Savant has changed column names across seasons).
 */
function colIdx(headers: string[], ...candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.findIndex((h) => h.toLowerCase().trim() === c.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export function buildStatcastBatterLeaderboardUrl(season: string): string {
  // min=50 filters at the source; we also enforce MIN_STATCAST_PA after parsing.
  return (
    `https://baseballsavant.mlb.com/leaderboard/expected_statistics` +
    `?type=batter&year=${season}&position=&team=&min=50&csv=true`
  );
}

function emptyResult(season: string, sourceUrl: string): StatcastBatterResult {
  return {
    status: "success",
    season,
    stats: new Map(),
    fetched: 0,
    source_url: sourceUrl,
    observed_columns: [],
    hard_hit_fetched: 0,
    barrel_fetched: 0,
    damage_metric_status: "SOURCE_SCHEMA_MISSING",
    errors: [],
  };
}

/**
 * Parse the exact expected-statistics CSV contract returned by Savant.
 *
 * xwOBA remains useful when the endpoint omits its historical hard-hit and
 * barrel columns.  That condition is nevertheless PARTIAL: callers must not
 * mistake a valid player/xwOBA payload for a materialized damage input.
 */
export function parseStatcastBatterLeaderboardCsv(
  text: string,
  season: string,
  sourceUrl = buildStatcastBatterLeaderboardUrl(season),
): StatcastBatterResult {
  const result = emptyResult(season, sourceUrl);
  const lines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length < 2) {
    result.status = "failure";
    result.errors.push("CSV response has fewer than 2 lines");
    return result;
  }

  const headers = parseCSVRow(lines[0]!.replace(/^\uFEFF/, ""));
  result.observed_columns = headers;

  // Locate column indices — try multiple name variants for resilience across seasons
  const idxId         = colIdx(headers, "player_id", "batter_id", "mlbam_id");
  const idxPa         = colIdx(headers, "pa");
  const idxXwoba      = colIdx(headers, "xwoba", "expected_woba", "est_woba");
  const idxXba        = colIdx(headers, "xba", "expected_ba", "est_ba");
  const idxXslg       = colIdx(headers, "xslg", "expected_slg", "est_slg");
  const idxBarrel     = colIdx(headers, "barrel_batted_rate", "barrel_rate", "barrels_per_pa",
                                "brl_pa", "brl_percent");
  const idxHardHit    = colIdx(headers, "hard_hit_percent", "hard_hit_pct", "hard_hit_rate");
  const idxExitVelo   = colIdx(headers, "exit_velocity_avg", "avg_exit_velocity", "ev_avg");
  const idxLastFirst  = colIdx(headers, "last_name, first_name", "last_name,first_name", "player_name");
  const idxLast       = colIdx(headers, "last_name");
  const idxFirst      = colIdx(headers, "first_name");

  if (idxId < 0 || idxPa < 0 || idxXwoba < 0) {
    result.status = "failure";
    result.errors.push(
      `Required expected-statistics columns missing. Headers: ${headers.slice(0, 15).join(", ")}`,
    );
    return result;
  }

  for (const line of lines.slice(1)) {
    const vals = parseCSVRow(line);
    const idRaw = vals[idxId]?.trim();
    const id = idRaw ? parseInt(idRaw, 10) : NaN;
    if (!id || !Number.isFinite(id) || id <= 0) continue;

    const pa = parseNum(vals[idxPa]);
    if (!pa || pa < MIN_STATCAST_PA) continue;

    let name = String(id);
    if (idxLastFirst >= 0 && vals[idxLastFirst]) {
      const parts = vals[idxLastFirst]!.split(",");
      name = parts.length >= 2 ? `${parts[1]!.trim()} ${parts[0]!.trim()}` : vals[idxLastFirst]!.trim();
    } else if (idxFirst >= 0 && idxLast >= 0) {
      name = `${vals[idxFirst]?.trim() ?? ""} ${vals[idxLast]?.trim() ?? ""}`.trim();
    }

    const barrelRate = idxBarrel >= 0 ? parseNum(vals[idxBarrel]) : null;
    const hardHitPct = idxHardHit >= 0 ? parseNum(vals[idxHardHit]) : null;
    if (barrelRate !== null) result.barrel_fetched++;
    if (hardHitPct !== null) result.hard_hit_fetched++;
    result.stats.set(id, {
      batter_id: id,
      name,
      pa,
      xwoba: parseNum(vals[idxXwoba]),
      xba: idxXba >= 0 ? parseNum(vals[idxXba]) : null,
      xslg: idxXslg >= 0 ? parseNum(vals[idxXslg]) : null,
      barrel_rate: barrelRate,
      hard_hit_pct: hardHitPct,
      exit_velo_avg: idxExitVelo >= 0 ? parseNum(vals[idxExitVelo]) : null,
    });
    result.fetched++;
  }

  if (result.fetched === 0) {
    result.status = "failure";
    result.errors.push("No valid player rows parsed — CSV may have changed format");
    return result;
  }

  if (idxHardHit < 0) {
    result.status = "partial";
    result.damage_metric_status = "SOURCE_SCHEMA_MISSING";
    result.errors.push(
      "Damage input unavailable: expected-statistics CSV does not expose hard-hit percentage",
    );
  } else if (result.hard_hit_fetched === 0) {
    result.status = "partial";
    result.damage_metric_status = "NO_QUALIFYING_DAMAGE_ROWS";
    result.errors.push("Damage input unavailable: no qualifying hard-hit values parsed");
  } else {
    result.damage_metric_status = "AVAILABLE";
  }
  return result;
}

/**
 * Fetch and parse the Baseball Savant expected-statistics leaderboard for a season.
 * Returns a Map<batter_id, StatcastBatterStats>.
 *
 * On failure (network error, unexpected CSV format, empty result), returns an
 * empty map with status "failure" — the caller degrades to OPS-only gracefully.
 */
export async function fetchStatcastBatterLeaderboard(
  season: string,
): Promise<StatcastBatterResult> {
  const url = buildStatcastBatterLeaderboardUrl(season);

  logger.info({ season, url }, "MODULE_02d: Fetching Statcast batter leaderboard");

  let text: string;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)",
        "Accept":     "text/csv,text/plain,*/*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    text = await res.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "MODULE_02d: Fetch failed — degrading to OPS-only");
    const result = emptyResult(season, url);
    result.status = "failure";
    result.errors.push(`Fetch: ${msg}`);
    return result;
  }

  const result = parseStatcastBatterLeaderboardCsv(text, season, url);

  logger.info(
    {
      fetched: result.fetched,
      hard_hit_fetched: result.hard_hit_fetched,
      damage_metric_status: result.damage_metric_status,
      status: result.status,
      errors: result.errors.length,
      season,
    },
    "MODULE_02d: Statcast batter leaderboard complete",
  );
  return result;
}
