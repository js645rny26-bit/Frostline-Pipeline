/**
 * Module 02e: Baseball Savant Game Preview Fetcher
 *
 * Fetches the Baseball Savant game preview page for each game on the slate,
 * extracts the embedded `var teams = {...}` JavaScript variable, saves the raw
 * payload to disk (immutable per-fetch record), and returns structured Statcast
 * metrics for probable pitchers and hitter lineup aggregates.
 *
 * Source:   https://baseballsavant.mlb.com/preview?game_pk={gamePk}
 * Format:   HTML page with server-rendered `var teams = {...}` JS variable.
 *           This is NOT a documented machine-readable API.
 *           Page restructures will break the parser — this is a known limitation (L1).
 *
 * Fail-open:    overall pipeline continues when this module fails or is unavailable.
 * Fail-closed:  projection influence is always zero; Preview_Used_In_Projection = "NO".
 * Authorization: unchanged in all cases.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import type { NormalizedGame } from "./module06_normalization.js";

const BASE_URL = "https://baseballsavant.mlb.com/preview";
const PARSER_VERSION = "1.2.0";
const RAW_PAYLOAD_DIR = "artifacts/statcast-preview";
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PreviewAvailability =
  | "AVAILABLE"
  | "NOT_PUBLISHED"
  | "NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "PARSE_FAILED"
  | "IDENTITY_MISMATCH"
  | "STALE"
  | "UNSUPPORTED_FORMAT";

export type FetchStatus = "success" | "http_error" | "timeout" | "parse_error" | "skipped";
export type PitcherMatchStatus = "MATCHED" | "UNVERIFIED" | "MISMATCH" | "NO_PROBABLE";
export type LineupMatchStatus = "LINEUP_POSTED" | "LINEUP_NOT_POSTED" | "UNAVAILABLE";

export interface StatcastPlayerStats {
  player_id: number | null;
  player_name: string | null;
  did_not_qualify: boolean;
  k_percent: number | null;
  bb_percent: number | null;
  exit_velocity_avg: number | null;
  launch_angle_avg: number | null;
  hard_hit_percent: number | null;
  xwoba: number | null;
  xba: number | null;
  xslg: number | null;
  whiff_percent: number | null;
  barrel_batted_rate: number | null;
}

export interface StatcastPreviewGameResult {
  gamePk: number;
  date: string;
  game_id: string;
  away_team: string | null;
  home_team: string | null;
  scheduled_first_pitch: string | null;
  fetch_ts: string;
  source_url: string;
  preview_availability: PreviewAvailability;
  fetch_status: FetchStatus;
  raw_payload_path: string | null;
  payload_hash: string | null;
  parser_version: string;
  has_lineup_away: boolean;
  has_lineup_home: boolean;
  has_probable_away: boolean;
  has_probable_home: boolean;
  starting_pitcher_match_status: PitcherMatchStatus;
  lineup_match_status: LineupMatchStatus;
  stale_data_flag: boolean;
  parse_warnings: string[];
  parse_error: string | null;
  preview_used_in_projection: "NO";
  projection_influence_notes: string;
  // Probable pitcher Statcast fields (null when didNotQualify or no probable)
  away_pitcher_stats: StatcastPlayerStats | null;
  home_pitcher_stats: StatcastPlayerStats | null;
  // Hitter aggregate fields (qualified hitters only)
  away_hitters_total: number;
  away_hitters_qualified: number;
  away_hitters_xwoba_avg: number | null;
  away_hitters_ev_avg: number | null;
  away_hitters_hard_hit_avg: number | null;
  away_hitters_k_pct_avg: number | null;
  away_hitters_bb_pct_avg: number | null;
  home_hitters_total: number;
  home_hitters_qualified: number;
  home_hitters_xwoba_avg: number | null;
  home_hitters_ev_avg: number | null;
  home_hitters_hard_hit_avg: number | null;
  home_hitters_k_pct_avg: number | null;
  home_hitters_bb_pct_avg: number | null;
}

export interface StatcastPreviewResult {
  status: "success" | "partial" | "failure";
  fetch_timestamp: string;
  games_expected: number;
  games_available: number;
  games_parsed: number;
  games_missing: number;
  games_failed: number;
  games_identity_mismatch: number;
  games: StatcastPreviewGameResult[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Safely convert a raw value from the page payload to a finite number or null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Compute a short SHA-256 hex digest of a serialised payload. */
function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Extract the `var teams = { ... }` JSON object from the Baseball Savant HTML page.
 * Uses a brace-depth counter with string-literal awareness to find the exact
 * closing brace rather than relying on a fixed delimiter after the object.
 */
function extractTeamsJson(html: string): unknown {
  const marker = "var teams = ";
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;

  let pos = markerIdx + marker.length;
  // Skip whitespace to the opening brace
  while (pos < html.length && html[pos] !== "{") pos++;
  if (pos >= html.length) return null;

  const jsonStart = pos;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (; pos < html.length; pos++) {
    const ch = html[pos];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === "{") { depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(html.slice(jsonStart, pos + 1)) as unknown;
      }
    }
  }
  return null;
}

/** Extract Statcast player stats from a raw player object in the `var teams` payload. */
export function extractPlayerStats(raw: unknown): StatcastPlayerStats | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;

  // The Statcast fields may live directly on the player object or under a nested
  // 'stats' or 'statcast' sub-object — try all three paths.
  // Savant roster rows can retain a generic nested `stats` object for MLB
  // box-score fields while placing actual Statcast metrics directly on the
  // player record. A metric-free nested object must not mask that payload.
  const nestedStatcast = asRecord(p["statcast"]);
  const nestedStats = asRecord(p["stats"]);
  const hasStatcastMetric = (candidate: Record<string, unknown> | null): candidate is Record<string, unknown> =>
    candidate !== null && [
      "xwoba", "hard_hit_percent", "k_percent", "bb_percent",
      "exit_velocity_avg", "whiff_percent", "barrel_batted_rate",
    ].some((field) => num(candidate[field]) !== null);
  const src = [nestedStatcast, p, nestedStats].find(hasStatcastMetric) ?? p;

  const didNotQualify =
    src["didNotQualify"] === "*" ||
    src["didNotQualify"] === true ||
    p["didNotQualify"] === "*" ||
    p["didNotQualify"] === true;

  const playerId = num(p["id"]) ?? num(p["player_id"]);
  const person = typeof p["person"] === "object" && p["person"] !== null
    ? p["person"] as Record<string, unknown>
    : null;
  const playerName =
    typeof p["name"] === "string"
      ? p["name"]
      : typeof p["fullName"] === "string"
        ? p["fullName"]
        : typeof person?.["fullName"] === "string"
          ? person["fullName"]
          : typeof p["name_display_first_last"] === "string"
            ? p["name_display_first_last"]
        : null;

  return {
    player_id: playerId,
    player_name: playerName,
    did_not_qualify: didNotQualify,
    k_percent: num(src["k_percent"]),
    bb_percent: num(src["bb_percent"]),
    exit_velocity_avg: num(src["exit_velocity_avg"]),
    launch_angle_avg: num(src["launch_angle_avg"]),
    hard_hit_percent: num(src["hard_hit_percent"]),
    xwoba: num(src["xwoba"]),
    xba: num(src["xba"]),
    xslg: num(src["xslg"]),
    whiff_percent: num(src["whiff_percent"]),
    barrel_batted_rate: num(src["barrel_batted_rate"]),
  };
}

export type HitterAggregationSource =
  | "POSTED_BATTING_ORDER"
  | "ROSTER_FALLBACK"
  | "UNAVAILABLE";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Flatten either an array or a keyed-object player collection. */
function playerRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return record ? Object.values(record) : [];
}

/**
 * Select the hitter collection supplied by the preview page without assuming
 * that hitterPlusRows is an array. The live page currently exposes the useful
 * Statcast fields under roster.hitters and represents hitterPlusRows as a
 * numeric counter, so that counter is evidence of neither freshness nor
 * unavailability by itself.
 */
export function selectStatcastHitterRows(side: Record<string, unknown>): {
  rows: unknown[];
  source: HitterAggregationSource;
} {
  const roster = asRecord(side["roster"]);
  const directRows = playerRows(side["hitterRows"] ?? side["hitters"]);
  const rosterRows = playerRows(roster?.["hitters"]);
  const candidates = directRows.length > 0 ? directRows : rosterRows;

  const postedOrder = candidates.filter((candidate) => {
    const row = asRecord(candidate);
    const battingOrder = num(row?.["battingOrder"] ?? row?.["batting_order"]);
    return battingOrder !== null && battingOrder > 0;
  });

  if (side["hasLineup"] === true && postedOrder.length > 0) {
    return { rows: postedOrder, source: "POSTED_BATTING_ORDER" };
  }
  if (candidates.length > 0) {
    return { rows: candidates, source: "ROSTER_FALLBACK" };
  }
  return { rows: [], source: "UNAVAILABLE" };
}

/** A side is usable when it contains at least one hitter with actual Statcast input. */
export function hasUsableStatcastHitterPayload(side: Record<string, unknown>): boolean {
  return selectStatcastHitterRows(side).rows.some((row) => {
    const stats = extractPlayerStats(row);
    return stats !== null && (
      stats.xwoba !== null ||
      stats.hard_hit_percent !== null ||
      stats.k_percent !== null ||
      stats.bb_percent !== null
    );
  });
}

/**
 * The preview page's probable pitcher is currently in roster.pitchers, not at
 * the root. Resolve it by the pipeline's pregame probable-pitcher ID; never
 * guess a pitcher from roster order.
 */
export function resolveStatcastPitcherRaw(
  side: Record<string, unknown>,
  expectedPlayerId: number | null | undefined,
): unknown {
  const direct = side["pitcher"] ?? side["startingPitcher"];
  if (direct !== null && direct !== undefined) return direct;
  if (expectedPlayerId === null || expectedPlayerId === undefined) return null;

  const roster = asRecord(side["roster"]);
  return playerRows(roster?.["pitchers"])
    .find((candidate) => {
      const row = asRecord(candidate);
      return num(row?.["id"]) === expectedPlayerId || num(row?.["player_id"]) === expectedPlayerId;
    }) ?? null;
}

/** Compute the mean of non-null values; null when fewer than 2 qualified values. */
function avg(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length < 2) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

interface PersistResult {
  path: string | null;
  /**
   * Count of prior .json files already in the same date/gamePk directory
   * before this write.  > 0 means this gamePk was fetched in an earlier
   * pipeline run today — the caller should emit a cached-payload-reuse warning.
   */
  priorFetchCount: number;
}

/**
 * Save the raw payload JSON to disk at
 *   {RAW_PAYLOAD_DIR}/{date}/{gamePk}/{fetchTimestamp}.json
 * Returns the path on success (null on I/O failure) and a count of any prior
 * fetch files already present so the caller can warn on re-runs (non-blocking).
 */
async function persistPayload(
  date: string,
  gamePk: number,
  payload: unknown,
  fetchTs: string,
): Promise<PersistResult> {
  try {
    const dir = join(RAW_PAYLOAD_DIR, date, String(gamePk));
    await mkdir(dir, { recursive: true });

    // Count existing fetch files before writing — a non-zero count means this
    // gamePk was already fetched earlier today (re-run or duplicate run).
    const existing = await readdir(dir).catch(() => [] as string[]);
    const priorFetchCount = existing.filter((e) => e.endsWith(".json")).length;

    // Replace colons and dots so the filename is safe on all filesystems
    const safeName = fetchTs.replace(/[:.]/g, "-") + ".json";
    const filePath = join(dir, safeName);
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, priorFetchCount };
  } catch (err) {
    logger.warn(
      { gamePk, err: err instanceof Error ? err.message : String(err) },
      "MODULE_02e: failed to persist raw payload to disk",
    );
    return { path: null, priorFetchCount: 0 };
  }
}

/**
 * Fetch a URL with an AbortController timeout.
 */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ─── Per-game fetch + parse ───────────────────────────────────────────────────

async function fetchOneGame(game: NormalizedGame): Promise<StatcastPreviewGameResult> {
  const fetchTs = new Date().toISOString();
  const url = `${BASE_URL}?game_pk=${game.gamePk}`;
  const warnings: string[] = [];

  const base: StatcastPreviewGameResult = {
    gamePk: game.gamePk,
    date: game.date,
    game_id: game.legacy_game_id,
    away_team: game.away_team.team_abbr,
    home_team: game.home_team.team_abbr,
    scheduled_first_pitch: game.scheduled_utc_time,
    fetch_ts: fetchTs,
    source_url: url,
    preview_availability: "SOURCE_UNAVAILABLE",
    fetch_status: "skipped",
    raw_payload_path: null,
    payload_hash: null,
    parser_version: PARSER_VERSION,
    has_lineup_away: false,
    has_lineup_home: false,
    has_probable_away: false,
    has_probable_home: false,
    starting_pitcher_match_status: "UNVERIFIED",
    lineup_match_status: "UNAVAILABLE",
    stale_data_flag: false,
    parse_warnings: [],
    parse_error: null,
    preview_used_in_projection: "NO",
    projection_influence_notes: "Phase 1 — ingestion only; no projection influence authorised",
    away_pitcher_stats: null,
    home_pitcher_stats: null,
    away_hitters_total: 0,
    away_hitters_qualified: 0,
    away_hitters_xwoba_avg: null,
    away_hitters_ev_avg: null,
    away_hitters_hard_hit_avg: null,
    away_hitters_k_pct_avg: null,
    away_hitters_bb_pct_avg: null,
    home_hitters_total: 0,
    home_hitters_qualified: 0,
    home_hitters_xwoba_avg: null,
    home_hitters_ev_avg: null,
    home_hitters_hard_hit_avg: null,
    home_hitters_k_pct_avg: null,
    home_hitters_bb_pct_avg: null,
  };

  // ── 1. HTTP fetch ──────────────────────────────────────────────────────────
  let html: string;
  try {
    const resp = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (resp.status === 404) {
      return { ...base, preview_availability: "NOT_FOUND", fetch_status: "http_error", parse_error: "HTTP 404" };
    }
    if (!resp.ok) {
      return { ...base, preview_availability: "SOURCE_UNAVAILABLE", fetch_status: "http_error", parse_error: `HTTP ${resp.status}` };
    }
    html = await resp.text();
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ...base,
      preview_availability: "SOURCE_UNAVAILABLE",
      fetch_status: isTimeout ? "timeout" : "http_error",
      parse_error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── 2. Extract var teams JSON ─────────────────────────────────────────────
  let teamsRaw: unknown;
  try {
    teamsRaw = extractTeamsJson(html);
  } catch (err) {
    return {
      ...base,
      preview_availability: "PARSE_FAILED",
      fetch_status: "parse_error",
      parse_error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!teamsRaw) {
    // Page loaded but has no var teams — likely pre-season or non-game page
    return {
      ...base,
      preview_availability: "NOT_PUBLISHED",
      fetch_status: "success",
      parse_error: "var teams marker not found in page",
    };
  }

  // ── 3. Persist raw payload ─────────────────────────────────────────────────
  const payloadHash = hashPayload(teamsRaw);
  const { path: rawPayloadPath, priorFetchCount } = await persistPayload(game.date, game.gamePk, teamsRaw, fetchTs);
  if (priorFetchCount > 0) {
    // A prior fetch file already exists for this gamePk today — this is a
    // repeat pipeline run, not cache reuse.  The current fetch is a fresh
    // network call that produced a new immutable payload file.
    // CACHED_PAYLOAD_REUSED is NOT emitted here; it is reserved for a future
    // Phase 3 code path that deliberately loads a prior payload instead of
    // making a network request.
    warnings.push(`Repeat fetch detected: ${priorFetchCount} prior fetch(es) already on disk for this gamePk today`);
  }

  // ── 4. Parse structure ────────────────────────────────────────────────────
  if (typeof teamsRaw !== "object" || teamsRaw === null) {
    return {
      ...base,
      preview_availability: "UNSUPPORTED_FORMAT",
      fetch_status: "parse_error",
      payload_hash: payloadHash,
      raw_payload_path: rawPayloadPath,
      parse_error: "var teams value is not an object",
    };
  }

  const teams = teamsRaw as Record<string, unknown>;
  const awayRaw = teams["away"] as Record<string, unknown> | undefined;
  const homeRaw = teams["home"] as Record<string, unknown> | undefined;

  if (!awayRaw || !homeRaw) {
    return {
      ...base,
      preview_availability: "UNSUPPORTED_FORMAT",
      fetch_status: "parse_error",
      payload_hash: payloadHash,
      raw_payload_path: rawPayloadPath,
      parse_error: "Missing away or home key in var teams",
    };
  }

  // ── 4b. Detect live/completed-game page format ────────────────────────────
  // The source may expose hitterPlusRows as a numeric counter while preserving
  // usable player-level Statcast fields in roster.hitters. Availability is
  // therefore determined from those fields, not the counter's runtime type.
  const awayHasUsableHitterStats = hasUsableStatcastHitterPayload(awayRaw);
  const homeHasUsableHitterStats = hasUsableStatcastHitterPayload(homeRaw);
  if (!awayHasUsableHitterStats && !homeHasUsableHitterStats) {
    return {
      ...base,
      preview_availability: "NOT_PUBLISHED",
      fetch_status: "success",
      payload_hash: payloadHash,
      raw_payload_path: rawPayloadPath,
      parse_error: "No usable pregame Statcast hitter fields found in the page payload",
    };
  }
  if (typeof awayRaw["hitterPlusRows"] === "number" || typeof homeRaw["hitterPlusRows"] === "number") {
    warnings.push("Numeric hitterPlusRows counter accepted; using roster-level Statcast fields");
  }

  const hasLineupAway = awayRaw["hasLineup"] === true;
  const hasLineupHome = homeRaw["hasLineup"] === true;
  const hasProbableAway = awayRaw["hasProbable"] === true;
  const hasProbableHome = homeRaw["hasProbable"] === true;

  // ── 5. Identity check ──────────────────────────────────────────────────────
  // Confirm team abbreviations in the payload match the expected game.
  // Baseball Savant may use full names or abbreviations — treat as UNVERIFIED
  // if we can't confirm, MISMATCH only if we can and they disagree.
  let pitcherMatchStatus: PitcherMatchStatus = "UNVERIFIED";
  const awayAbbr = (awayRaw["abbreviation"] ?? awayRaw["teamAbbr"] ?? awayRaw["abbr"]) as string | undefined;
  const homeAbbr = (homeRaw["abbreviation"] ?? homeRaw["teamAbbr"] ?? homeRaw["abbr"]) as string | undefined;

  if (awayAbbr && homeAbbr) {
    const expectedAway = game.away_team.team_abbr ?? "";
    const expectedHome = game.home_team.team_abbr ?? "";
    if (awayAbbr !== expectedAway || homeAbbr !== expectedHome) {
      warnings.push(`Team abbreviation mismatch: page has ${awayAbbr}@${homeAbbr}, expected ${expectedAway}@${expectedHome}`);
      return {
        ...base,
        preview_availability: "IDENTITY_MISMATCH",
        fetch_status: "success",
        payload_hash: payloadHash,
        raw_payload_path: rawPayloadPath,
        has_lineup_away: hasLineupAway,
        has_lineup_home: hasLineupHome,
        has_probable_away: hasProbableAway,
        has_probable_home: hasProbableHome,
        starting_pitcher_match_status: "MISMATCH",
        lineup_match_status: hasLineupAway && hasLineupHome ? "LINEUP_POSTED" : "LINEUP_NOT_POSTED",
        parse_warnings: warnings,
        parse_error: `Identity mismatch: page ${awayAbbr}@${homeAbbr} ≠ expected ${expectedAway}@${expectedHome}`,
      };
    }
    pitcherMatchStatus = "MATCHED";
  }

  // ── 5b. gamePk identity check ─────────────────────────────────────────────
  // If the payload embeds a game_pk / gamePk / pk field, verify it matches the
  // requested gamePk.  A mismatch is unusual (Savant routes by URL param) but
  // detectable as a distinct observable warning without blocking the parse.
  const embeddedGamePk = teams["game_pk"] ?? teams["gamePk"] ?? teams["pk"];
  if (embeddedGamePk !== undefined && embeddedGamePk !== null) {
    const pageGamePk = Number(embeddedGamePk);
    if (!Number.isNaN(pageGamePk) && pageGamePk !== game.gamePk) {
      warnings.push(`gamePk mismatch: page embeds game_pk=${pageGamePk}, expected=${game.gamePk}`);
    }
  }

  if (!hasProbableAway || !hasProbableHome) {
    pitcherMatchStatus = "NO_PROBABLE";
    if (!hasProbableAway) warnings.push("Away probable pitcher not posted");
    if (!hasProbableHome) warnings.push("Home probable pitcher not posted");
  }

  // ── 6. Extract pitcher Statcast stats ─────────────────────────────────────
  const awayPitcherRaw = resolveStatcastPitcherRaw(awayRaw, game.away_pitcher.player_id);
  const homePitcherRaw = resolveStatcastPitcherRaw(homeRaw, game.home_pitcher.player_id);
  const awayPitcherStats = hasProbableAway ? extractPlayerStats(awayPitcherRaw) : null;
  const homePitcherStats = hasProbableHome ? extractPlayerStats(homePitcherRaw) : null;

  // Verify pitcher names match probable pitchers from the normalized game
  if (awayPitcherStats?.player_id && game.away_pitcher.player_id) {
    if (awayPitcherStats.player_id !== game.away_pitcher.player_id) {
      warnings.push(
        `Away pitcher ID mismatch: page ${awayPitcherStats.player_id} vs pipeline ${game.away_pitcher.player_id} (${game.away_pitcher.name ?? "unknown"})`,
      );
    }
  }
  if (homePitcherStats?.player_id && game.home_pitcher.player_id) {
    if (homePitcherStats.player_id !== game.home_pitcher.player_id) {
      warnings.push(
        `Home pitcher ID mismatch: page ${homePitcherStats.player_id} vs pipeline ${game.home_pitcher.player_id} (${game.home_pitcher.name ?? "unknown"})`,
      );
    }
  }

  // ── 7. Extract hitter aggregates (qualified hitters only) ─────────────────
  function aggregateHitters(side: Record<string, unknown>) {
    // hitterRows is the primary key; fall back to 'hitters' or 'roster'.
    // Guard: the value MUST be an array before calling .map().  Some page
    // variants serve a keyed object (flatten via Object.values) or a number
    // count (treat as empty).  Without this guard, a non-array crashes here
    // and escapes fetchOneGame entirely — the outer .catch() then mislabels
    // the failure as http_error / SOURCE_UNAVAILABLE.
    const rawValue = selectStatcastHitterRows(side).rows;
    let rawList: unknown[];
    if (Array.isArray(rawValue)) {
      rawList = rawValue;
    } else if (rawValue !== null && rawValue !== undefined && typeof rawValue === "object") {
      // Keyed-object format (e.g. {playerId: {...}, ...}) — flatten to values.
      rawList = Object.values(rawValue as Record<string, unknown>);
    } else {
      rawList = [];
    }
    const all = rawList
      .map(extractPlayerStats)
      .filter((s): s is StatcastPlayerStats => s !== null);
    const qualified = all.filter((s) => !s.did_not_qualify);
    return {
      total: all.length,
      qualified: qualified.length,
      xwoba_avg: avg(qualified.map((s) => s.xwoba)),
      ev_avg: avg(qualified.map((s) => s.exit_velocity_avg)),
      hard_hit_avg: avg(qualified.map((s) => s.hard_hit_percent)),
      k_pct_avg: avg(qualified.map((s) => s.k_percent)),
      bb_pct_avg: avg(qualified.map((s) => s.bb_percent)),
    };
  }

  // Wrap aggregation in a catch so any unexpected structural error is classified
  // as PARSE_FAILED / parse_error rather than escaping to the outer batch handler
  // which would mislabel it as http_error / SOURCE_UNAVAILABLE.
  let awayHitters: ReturnType<typeof aggregateHitters>;
  let homeHitters: ReturnType<typeof aggregateHitters>;
  try {
    awayHitters = aggregateHitters(awayRaw);
    homeHitters = aggregateHitters(homeRaw);
  } catch (err) {
    return {
      ...base,
      preview_availability: "PARSE_FAILED",
      fetch_status: "parse_error",
      payload_hash: payloadHash,
      raw_payload_path: rawPayloadPath,
      parse_error: `Hitter aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (awayHitters.total === 0) warnings.push("No hitter rows found for away team");
  if (homeHitters.total === 0) warnings.push("No hitter rows found for home team");
  const awayHitterSource = selectStatcastHitterRows(awayRaw).source;
  const homeHitterSource = selectStatcastHitterRows(homeRaw).source;
  if (hasLineupAway && awayHitterSource !== "POSTED_BATTING_ORDER") {
    warnings.push(`Away lineup posted but Statcast hitter source is ${awayHitterSource}`);
  }
  if (hasLineupHome && homeHitterSource !== "POSTED_BATTING_ORDER") {
    warnings.push(`Home lineup posted but Statcast hitter source is ${homeHitterSource}`);
  }

  const lineupMatchStatus: LineupMatchStatus =
    hasLineupAway && hasLineupHome
      ? "LINEUP_POSTED"
      : hasProbableAway || hasProbableHome
        ? "LINEUP_NOT_POSTED"
        : "UNAVAILABLE";

  return {
    gamePk: game.gamePk,
    date: game.date,
    game_id: game.legacy_game_id,
    away_team: game.away_team.team_abbr,
    home_team: game.home_team.team_abbr,
    scheduled_first_pitch: game.scheduled_utc_time,
    fetch_ts: fetchTs,
    source_url: url,
    preview_availability: "AVAILABLE",
    fetch_status: "success",
    raw_payload_path: rawPayloadPath,
    payload_hash: payloadHash,
    parser_version: PARSER_VERSION,
    has_lineup_away: hasLineupAway,
    has_lineup_home: hasLineupHome,
    has_probable_away: hasProbableAway,
    has_probable_home: hasProbableHome,
    starting_pitcher_match_status: pitcherMatchStatus,
    lineup_match_status: lineupMatchStatus,
    stale_data_flag: false,
    parse_warnings: warnings,
    parse_error: null,
    preview_used_in_projection: "NO",
    projection_influence_notes: "Phase 1 — ingestion only; no projection influence authorised",
    away_pitcher_stats: awayPitcherStats,
    home_pitcher_stats: homePitcherStats,
    away_hitters_total: awayHitters.total,
    away_hitters_qualified: awayHitters.qualified,
    away_hitters_xwoba_avg: awayHitters.xwoba_avg,
    away_hitters_ev_avg: awayHitters.ev_avg,
    away_hitters_hard_hit_avg: awayHitters.hard_hit_avg,
    away_hitters_k_pct_avg: awayHitters.k_pct_avg,
    away_hitters_bb_pct_avg: awayHitters.bb_pct_avg,
    home_hitters_total: homeHitters.total,
    home_hitters_qualified: homeHitters.qualified,
    home_hitters_xwoba_avg: homeHitters.xwoba_avg,
    home_hitters_ev_avg: homeHitters.ev_avg,
    home_hitters_hard_hit_avg: homeHitters.hard_hit_avg,
    home_hitters_k_pct_avg: homeHitters.k_pct_avg,
    home_hitters_bb_pct_avg: homeHitters.bb_pct_avg,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Fetch Baseball Savant game previews for all games in the slate.
 * Runs concurrently with a max of 5 simultaneous requests to avoid hammering the
 * source. Each game's raw payload is saved to disk before parsing.
 * Never throws — all failures are captured in the result.
 */
export async function fetchStatcastPreviews(
  games: NormalizedGame[],
  _date: string,
): Promise<StatcastPreviewResult> {
  const fetchTimestamp = new Date().toISOString();

  if (games.length === 0) {
    return {
      status: "success",
      fetch_timestamp: fetchTimestamp,
      games_expected: 0,
      games_available: 0,
      games_parsed: 0,
      games_missing: 0,
      games_failed: 0,
      games_identity_mismatch: 0,
      games: [],
    };
  }

  // Chunk into batches of 5 to limit concurrent requests
  const CONCURRENCY = 5;
  const results: StatcastPreviewGameResult[] = [];
  for (let i = 0; i < games.length; i += CONCURRENCY) {
    const batch = games.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((g) =>
        fetchOneGame(g).catch((err) => {
          logger.error(
            { gamePk: g.gamePk, err: err instanceof Error ? err.message : String(err) },
            "MODULE_02e: unexpected error fetching game preview",
          );
          return {
            gamePk: g.gamePk,
            date: g.date,
            game_id: g.legacy_game_id,
            away_team: g.away_team.team_abbr,
            home_team: g.home_team.team_abbr,
            scheduled_first_pitch: g.scheduled_utc_time,
            fetch_ts: new Date().toISOString(),
            source_url: `${BASE_URL}?game_pk=${g.gamePk}`,
            preview_availability: "SOURCE_UNAVAILABLE" as PreviewAvailability,
            fetch_status: "http_error" as FetchStatus,
            raw_payload_path: null,
            payload_hash: null,
            parser_version: PARSER_VERSION,
            has_lineup_away: false,
            has_lineup_home: false,
            has_probable_away: false,
            has_probable_home: false,
            starting_pitcher_match_status: "UNVERIFIED" as PitcherMatchStatus,
            lineup_match_status: "UNAVAILABLE" as LineupMatchStatus,
            stale_data_flag: false,
            parse_warnings: [],
            parse_error: err instanceof Error ? err.message : String(err),
            preview_used_in_projection: "NO" as const,
            projection_influence_notes: "Phase 1 — ingestion only; no projection influence authorised",
            away_pitcher_stats: null,
            home_pitcher_stats: null,
            away_hitters_total: 0,
            away_hitters_qualified: 0,
            away_hitters_xwoba_avg: null,
            away_hitters_ev_avg: null,
            away_hitters_hard_hit_avg: null,
            away_hitters_k_pct_avg: null,
            away_hitters_bb_pct_avg: null,
            home_hitters_total: 0,
            home_hitters_qualified: 0,
            home_hitters_xwoba_avg: null,
            home_hitters_ev_avg: null,
            home_hitters_hard_hit_avg: null,
            home_hitters_k_pct_avg: null,
            home_hitters_bb_pct_avg: null,
          } satisfies StatcastPreviewGameResult;
        }),
      ),
    );
    results.push(...batchResults);
  }

  const gamesAvailable = results.filter((r) => r.preview_availability === "AVAILABLE").length;
  const gamesFailed = results.filter(
    (r) =>
      r.preview_availability === "SOURCE_UNAVAILABLE" ||
      r.preview_availability === "PARSE_FAILED" ||
      r.preview_availability === "UNSUPPORTED_FORMAT",
  ).length;
  const gamesMissing = results.filter(
    (r) =>
      r.preview_availability === "NOT_PUBLISHED" ||
      r.preview_availability === "NOT_FOUND" ||
      r.preview_availability === "STALE",
  ).length;
  const gamesIdentityMismatch = results.filter(
    (r) => r.preview_availability === "IDENTITY_MISMATCH",
  ).length;

  // Emit one concise per-game warning for each failure mode so operators can
  // identify problems without reading the full STATCAST_GAME_PREVIEW sheet.
  // Cached-payload-reuse detection requires Phase-3 caching logic; not yet emitted.
  for (const r of results) {
    switch (r.preview_availability) {
      case "SOURCE_UNAVAILABLE":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, fetch_status: r.fetch_status, error: r.parse_error },
          "MODULE_02e: source unavailable — preview fetch failed for game",
        );
        break;
      case "NOT_PUBLISHED":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id },
          "MODULE_02e: preview not yet published for game",
        );
        break;
      case "PARSE_FAILED":
      case "UNSUPPORTED_FORMAT":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, availability: r.preview_availability, error: r.parse_error },
          "MODULE_02e: parser failure — var teams JSON could not be extracted or parsed",
        );
        break;
      case "IDENTITY_MISMATCH":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, error: r.parse_error },
          "MODULE_02e: team mismatch — preview page team abbreviations do not match expected game",
        );
        break;
      case "NOT_FOUND":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id },
          "MODULE_02e: game preview page not found (HTTP 404) — gamePk may be invalid or game cancelled",
        );
        break;
      case "STALE":
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id },
          "MODULE_02e: stale preview — preview data is stale for game",
        );
        break;
    }
    // Emit distinct named warnings for parse_warnings with known failure tags;
    // fall back to a generic parse-warning line for everything else.
    for (const w of r.parse_warnings) {
      if (w.includes("gamePk mismatch")) {
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, warning: w },
          "MODULE_02e: gamePk mismatch — embedded game_pk in preview payload differs from requested gamePk",
        );
      } else if (w.includes("pitcher ID mismatch")) {
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, warning: w },
          "MODULE_02e: starter mismatch — pitcher ID on preview page differs from pipeline probable",
        );
      } else if (w.includes("Repeat fetch detected")) {
        // Prior immutable payload(s) exist on disk for this gamePk today, but
        // the current run made a fresh network fetch — this is a repeat run,
        // not cache reuse.  CACHED_PAYLOAD_REUSED requires a Phase 3 cache-
        // loading path that deliberately returns a stored payload instead of
        // fetching; that path does not exist in Phase 1.
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, warning: w },
          "MODULE_02e: repeat fetch detected — prior payload(s) on disk for this gamePk today; fresh network fetch still performed",
        );
      } else {
        logger.warn(
          { gamePk: r.gamePk, game_id: r.game_id, warning: w },
          "MODULE_02e: game preview parse warning",
        );
      }
    }
  }

  logger.info(
    {
      expected: games.length,
      available: gamesAvailable,
      missing: gamesMissing,
      failed: gamesFailed,
      identity_mismatch: gamesIdentityMismatch,
    },
    "MODULE_02e: Statcast game preview fetch complete",
  );

  const status =
    gamesFailed === games.length
      ? "failure"
      : gamesAvailable < games.length
        ? "partial"
        : "success";

  return {
    status,
    fetch_timestamp: fetchTimestamp,
    games_expected: games.length,
    games_available: gamesAvailable,
    games_parsed: gamesAvailable,
    games_missing: gamesMissing,
    games_failed: gamesFailed,
    games_identity_mismatch: gamesIdentityMismatch,
    games: results,
  };
}
