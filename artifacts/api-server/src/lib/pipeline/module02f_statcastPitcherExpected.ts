/**
 * SOURCE_SAVANT_PITCHER_EXPECTED
 *
 * Pitcher-side counterpart to module02d's Batter Statcast feed. This belongs
 * to a single true-skill/contact-quality family: xERA may replace a missing
 * FIP/ERA baseline, but it must never be a second traffic/damage vote.
 */

import { logger } from "../../lib/logger.js";
import { type SourceAvailability, type SourceSnapshot } from "./module02_sourceSnapshots.js";

export const SOURCE_SAVANT_PITCHER_EXPECTED = "SOURCE_SAVANT_PITCHER_EXPECTED";
export const SAVANT_PITCHER_EXPECTED_PARSER_VERSION = "1.0.0";
/** Model-owned gate; source download retains unqualified arms. */
export const MIN_EXPECTED_PITCHER_PA = 100;

export interface StatcastPitcherExpectedStats {
  pitcher_id: number;
  name: string;
  pa: number;
  bip: number | null;
  era: number | null;
  xera: number | null;
  xwoba_allowed: number | null;
  xba_allowed: number | null;
  xslg_allowed: number | null;
}

export interface StatcastPitcherExpectedResult {
  status: "success" | "partial" | "failure";
  season: string;
  stats: Map<number, StatcastPitcherExpectedStats>;
  fetched: number;
  source_url: string;
  source_snapshot: SourceSnapshot | null;
  errors: string[];
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') { current += '"'; index++; }
      else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) { fields.push(current); current = ""; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || ["null", "na", "n/a", "."].includes(normalized.toLowerCase())) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexOfHeader(headers: string[], ...candidates: string[]): number {
  return headers.findIndex((header) => candidates.some((candidate) => header.trim().toLowerCase() === candidate.toLowerCase()));
}

function nameFromRow(values: string[], headers: string[]): string {
  const combined = indexOfHeader(headers, "last_name, first_name", "player_name", "name");
  if (combined >= 0 && values[combined]) {
    const parts = values[combined]!.split(",");
    return parts.length >= 2 ? `${parts[1]!.trim()} ${parts[0]!.trim()}` : values[combined]!.trim();
  }
  const first = indexOfHeader(headers, "first_name");
  const last = indexOfHeader(headers, "last_name");
  return `${first >= 0 ? values[first] ?? "" : ""} ${last >= 0 ? values[last] ?? "" : ""}`.trim();
}

export function buildStatcastPitcherExpectedUrl(season: string): string {
  return `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${encodeURIComponent(season)}&position=&team=&min=1&csv=true`;
}

/**
 * The season leaderboard does not expose a data-through-date parameter. It
 * is admissible for active use only before *every* game on the requested
 * slate begins, when the date-minus-one cutoff cannot contain same-date MLB
 * results. Staggered/slate-after-start runs must use retained pitch-level
 * data with an explicit cutoff instead; this source is withheld for now.
 */
export function isFullSlatePregameWindow(
  scheduledFirstPitches: readonly (string | null | undefined)[],
  asOf = new Date().toISOString(),
): boolean {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || scheduledFirstPitches.length === 0) return false;
  return scheduledFirstPitches.every((firstPitch) => {
    const ms = firstPitch ? Date.parse(firstPitch) : Number.NaN;
    return Number.isFinite(ms) && ms > asOfMs;
  });
}

export function parseStatcastPitcherExpectedCsv(
  raw: string,
  season: string,
  sourceUrl: string,
  dataThroughDate: string,
  fetchTimestampUtc = new Date().toISOString(),
): StatcastPitcherExpectedResult {
  const normalizedForParsing = raw.replace(/^\uFEFF/, "");
  const lines = normalizedForParsing.split(/\r?\n/).filter((line) => line.length > 0);
  const result: StatcastPitcherExpectedResult = { status: "success", season, stats: new Map(), fetched: 0, source_url: sourceUrl, source_snapshot: null, errors: [] };
  if (lines.length < 2) {
    result.status = "failure";
    result.errors.push("CSV response has fewer than two rows");
    return result;
  }
  const headers = parseCsvRow(lines[0]!);
  const expected = ["player_id", "pa", "xera", "est_woba", "est_slg"];
  const idIndex = indexOfHeader(headers, "player_id", "pitcher_id", "mlbam_id");
  const paIndex = indexOfHeader(headers, "pa", "batters_faced");
  const bipIndex = indexOfHeader(headers, "bip");
  const eraIndex = indexOfHeader(headers, "era");
  const xeraIndex = indexOfHeader(headers, "xera", "expected_era", "est_era");
  const xwobaIndex = indexOfHeader(headers, "est_woba", "xwoba", "expected_woba");
  const xbaIndex = indexOfHeader(headers, "est_ba", "xba", "expected_ba");
  const xslgIndex = indexOfHeader(headers, "est_slg", "xslg", "expected_slg");
  const missing = expected.filter((header) => indexOfHeader(headers, header) < 0);
  let availability: SourceAvailability = "CURRENT";
  if (idIndex < 0 || paIndex < 0 || xeraIndex < 0) {
    availability = "SCHEMA_DRIFT";
    result.status = "failure";
    result.errors.push(`Required expected-statistics columns missing: ${missing.join(", ") || "player_id/pa/xera"}`);
  } else if (missing.length > 0) {
    availability = "PARTIAL";
    result.status = "partial";
    result.errors.push(`Optional expected-statistics columns missing: ${missing.join(", ")}`);
  }
  if (result.status !== "failure") {
    for (const line of lines.slice(1)) {
      const values = parseCsvRow(line);
      const id = parseNumber(values[idIndex]);
      const pa = parseNumber(values[paIndex]);
      if (id === null || pa === null || id <= 0 || pa < 0) continue;
      result.stats.set(id, {
        pitcher_id: id, name: nameFromRow(values, headers) || String(id), pa,
        bip: parseNumber(values[bipIndex]), era: parseNumber(values[eraIndex]),
        xera: parseNumber(values[xeraIndex]), xwoba_allowed: parseNumber(values[xwobaIndex]),
        xba_allowed: parseNumber(values[xbaIndex]), xslg_allowed: parseNumber(values[xslgIndex]),
      });
    }
    result.fetched = result.stats.size;
    if (result.fetched === 0) { availability = "SCHEMA_DRIFT"; result.status = "failure"; result.errors.push("No pitcher expected-statistics rows parsed"); }
  }
  result.source_snapshot = {
    canonical_source_id: SOURCE_SAVANT_PITCHER_EXPECTED, request_url: sourceUrl,
    fetch_timestamp_utc: fetchTimestampUtc, data_through_date: dataThroughDate,
    raw_response: raw, row_count: Math.max(0, lines.length - 1),
    expected_columns: expected, observed_columns: headers, mlbam_coverage: result.stats.size,
    parser_version: SAVANT_PITCHER_EXPECTED_PARSER_VERSION, source_status: availability,
    fallback_used: "NONE", notes: "Season-to-date expected-pitching quality; admissible only through the supplied pregame cutoff.",
  };
  return result;
}

export async function fetchStatcastPitcherExpectedLeaderboard(season: string, dataThroughDate: string): Promise<StatcastPitcherExpectedResult> {
  const url = buildStatcastPitcherExpectedUrl(season);
  logger.info({ season, dataThroughDate, url }, "MODULE_02f: fetching Savant expected-pitching leaderboard");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)", Accept: "text/csv,text/plain,*/*" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const result = parseStatcastPitcherExpectedCsv(await response.text(), season, url, dataThroughDate);
    logger.info({ status: result.status, pitchers: result.fetched, errors: result.errors.length }, "MODULE_02f: expected-pitching complete");
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, "MODULE_02f: Savant expected-pitching unavailable");
    return { status: "failure", season, stats: new Map(), fetched: 0, source_url: url, source_snapshot: null, errors: [`Fetch: ${message}`] };
  } finally {
    clearTimeout(timeout);
  }
}
