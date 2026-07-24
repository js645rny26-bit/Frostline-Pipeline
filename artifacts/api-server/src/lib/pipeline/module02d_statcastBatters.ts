/**
 * Module 02d: Statcast Batter Leaderboard
 *
 * Fetches the Baseball Savant expected-statistics leaderboard for a given season
 * as a single CSV download. This avoids per-player API calls — one request covers
 * every qualifying batter in MLB.
 *
 * Metrics extracted per player:
 *   xwOBA  — expected weighted on-base average (contact-quality gold standard)
 *   xBA    — expected batting average
 *   xSLG   — expected slugging
 *   barrel_rate   — barrels / PA %
 *   hard_hit_pct  — hard-hit rate %
 *   exit_velo_avg — average exit velocity (mph)
 *
 * xwOBA removes luck (BABIP, sequencing) by computing expected outcomes from
 * exit velocity and launch angle. It is a stronger forward predictor than actual
 * OPS, particularly for short samples and players with BABIP outliers.
 *
 * Minimum PA threshold (min=50) is applied at the source request; the module
 * also enforces MIN_STATCAST_PA after parsing for defence in depth.
 *
 * Used by module09 to blend xwOBA into the batting-order-weighted lineup factor.
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

function buildUrl(season: string): string {
  // min=50 filters at the source; we also enforce MIN_STATCAST_PA after parsing.
  return (
    `https://baseballsavant.mlb.com/leaderboard/expected_statistics` +
    `?type=batter&year=${season}&position=&team=&min=50&csv=true`
  );
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
  const url = buildUrl(season);
  const result: StatcastBatterResult = {
    status: "success",
    season,
    stats: new Map(),
    fetched: 0,
    source_url: url,
    errors: [],
  };

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
    result.status = "failure";
    result.errors.push(`Fetch: ${msg}`);
    return result;
  }

  // ── Parse CSV ──
  const lines = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) {
    result.status = "failure";
    result.errors.push("CSV response has fewer than 2 lines");
    return result;
  }

  const headers = parseCSVRow(lines[0]!);

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

  if (idxId < 0) {
    result.status = "failure";
    result.errors.push(`player_id column not found. Headers: ${headers.slice(0, 10).join(", ")}`);
    logger.warn({ headers: headers.slice(0, 15) }, "MODULE_02d: player_id column not found");
    return result;
  }

  for (const line of lines.slice(1)) {
    const vals = parseCSVRow(line);
    const idRaw = vals[idxId]?.trim();
    const id    = idRaw ? parseInt(idRaw, 10) : NaN;
    if (!id || !Number.isFinite(id) || id <= 0) continue;

    const pa = parseNum(vals[idxPa]);
    if (!pa || pa < MIN_STATCAST_PA) continue;

    // Resolve display name (best-effort, not critical)
    let name = String(id);
    if (idxLastFirst >= 0 && vals[idxLastFirst]) {
      // Format: "Wheeler, Zack" → "Zack Wheeler"
      const parts = vals[idxLastFirst]!.split(",");
      name = parts.length >= 2 ? `${parts[1]!.trim()} ${parts[0]!.trim()}` : vals[idxLastFirst]!.trim();
    } else if (idxFirst >= 0 && idxLast >= 0) {
      name = `${vals[idxFirst]?.trim() ?? ""} ${vals[idxLast]?.trim() ?? ""}`.trim();
    }

    result.stats.set(id, {
      batter_id:    id,
      name,
      pa,
      xwoba:        parseNum(vals[idxXwoba]),
      xba:          parseNum(vals[idxXba]),
      xslg:         parseNum(vals[idxXslg]),
      barrel_rate:  parseNum(vals[idxBarrel]),
      hard_hit_pct: parseNum(vals[idxHardHit]),
      exit_velo_avg: parseNum(vals[idxExitVelo]),
    });
    result.fetched++;
  }

  if (result.fetched === 0) {
    result.status = "failure";
    result.errors.push("No valid player rows parsed — CSV may have changed format");
    logger.warn({ sample: lines.slice(0, 3).join(" | ") }, "MODULE_02d: No rows parsed");
  }

  logger.info(
    { fetched: result.fetched, status: result.status, errors: result.errors.length, season },
    "MODULE_02d: Statcast batter leaderboard complete",
  );
  return result;
}
