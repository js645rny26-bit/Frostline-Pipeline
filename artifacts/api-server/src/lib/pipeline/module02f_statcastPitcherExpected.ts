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
  pregame_eligible: boolean;
  cutoff_status: PregameCutoffStatus;
  cutoff_provenance: PregameCutoffProvenance;
  requested_through_date: string;
  errors: string[];
}

export type PregameCutoffProvenance =
  | "PAYLOAD_FIELD"
  | "DATE_FILTERED_REQUEST"
  | "PIPELINE_ASSIGNED"
  | "UNKNOWN";

export type PregameCutoffStatus =
  | "VERIFIED_D1_OR_EARLIER"
  | "REJECTED_SAME_DAY_OR_LATER"
  | "CUTOFF_UNVERIFIED";

export interface PregameCutoffEvidence {
  slate_date: string;
  requested_through_date: string;
  /** Proven source horizon. Null when the endpoint does not expose one. */
  data_through_date: string | null;
  provenance: PregameCutoffProvenance;
}

export interface PregameCutoffResolution {
  eligible: boolean;
  status: PregameCutoffStatus;
  reason: string;
}

function canonicalDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function previousUtcDate(value: string): string | null {
  const canonical = canonicalDate(value);
  if (!canonical) return null;
  const parsed = new Date(`${canonical}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * A caller-supplied label is not evidence of the source's data horizon.
 * Only a payload field or an actually date-filtered request can establish a
 * pregame-safe data-through date.
 */
export function evaluatePregameCutoff(evidence: PregameCutoffEvidence): PregameCutoffResolution {
  const slateDate = canonicalDate(evidence.slate_date);
  const requestedThroughDate = canonicalDate(evidence.requested_through_date);
  const expectedThroughDate = slateDate ? previousUtcDate(slateDate) : null;
  const provenThroughDate = canonicalDate(evidence.data_through_date);
  const provenanceIsProof =
    evidence.provenance === "PAYLOAD_FIELD" ||
    evidence.provenance === "DATE_FILTERED_REQUEST";

  if (!slateDate || !requestedThroughDate || requestedThroughDate !== expectedThroughDate) {
    return {
      eligible: false,
      status: "CUTOFF_UNVERIFIED",
      reason: "Invalid slate/requested-through cutoff contract",
    };
  }
  if (provenThroughDate && provenThroughDate >= slateDate) {
    return {
      eligible: false,
      status: "REJECTED_SAME_DAY_OR_LATER",
      reason: `Source horizon ${provenThroughDate} is not earlier than slate ${slateDate}`,
    };
  }
  if (!provenanceIsProof || !provenThroughDate) {
    return {
      eligible: false,
      status: "CUTOFF_UNVERIFIED",
      reason: `Source horizon is not proven by payload or date-filtered request (${evidence.provenance})`,
    };
  }
  if (provenThroughDate > requestedThroughDate) {
    return {
      eligible: false,
      status: "REJECTED_SAME_DAY_OR_LATER",
      reason: `Source horizon ${provenThroughDate} exceeds requested cutoff ${requestedThroughDate}`,
    };
  }
  return {
    eligible: true,
    status: "VERIFIED_D1_OR_EARLIER",
    reason: `Source horizon ${provenThroughDate} is cutoff-safe through ${requestedThroughDate}`,
  };
}

export function pregameEligiblePitcherExpectedStats(
  result: StatcastPitcherExpectedResult | null | undefined,
): Map<number, StatcastPitcherExpectedStats> {
  return result?.pregame_eligible ? result.stats : new Map();
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
 * This timing guard prevents after-start acquisition. It does not prove the
 * season leaderboard's data-through date; cutoff eligibility is evaluated
 * separately from source evidence.
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
  cutoffEvidence: PregameCutoffEvidence,
  fetchTimestampUtc = new Date().toISOString(),
): StatcastPitcherExpectedResult {
  const normalizedForParsing = raw.replace(/^\uFEFF/, "");
  const lines = normalizedForParsing.split(/\r?\n/).filter((line) => line.length > 0);
  const cutoff = evaluatePregameCutoff(cutoffEvidence);
  const result: StatcastPitcherExpectedResult = {
    status: "success", season, stats: new Map(), fetched: 0,
    source_url: sourceUrl, source_snapshot: null,
    pregame_eligible: cutoff.eligible, cutoff_status: cutoff.status,
    cutoff_provenance: cutoffEvidence.provenance,
    requested_through_date: cutoffEvidence.requested_through_date,
    errors: [],
  };
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
  if (result.status !== "failure" && !cutoff.eligible) {
    availability = "UNAVAILABLE";
    result.status = "partial";
    result.errors.push(`${cutoff.status}: ${cutoff.reason}`);
  }
  result.source_snapshot = {
    canonical_source_id: SOURCE_SAVANT_PITCHER_EXPECTED, request_url: sourceUrl,
    fetch_timestamp_utc: fetchTimestampUtc,
    data_through_date: cutoffEvidence.data_through_date ?? "",
    raw_response: raw, row_count: Math.max(0, lines.length - 1),
    expected_columns: expected, observed_columns: headers, mlbam_coverage: result.stats.size,
    parser_version: SAVANT_PITCHER_EXPECTED_PARSER_VERSION, source_status: availability,
    fallback_used: cutoff.eligible ? "NONE" : "TRADITIONAL_PITCHER_QUALITY_OR_NEUTRAL",
    notes: [
      "Season-to-date expected-pitching quality.",
      `Pregame cutoff: ${cutoff.status}.`,
      cutoff.reason,
      `Requested through: ${cutoffEvidence.requested_through_date}.`,
      `Cutoff provenance: ${cutoffEvidence.provenance}.`,
    ].join(" "),
  };
  return result;
}

export async function fetchStatcastPitcherExpectedLeaderboard(
  season: string,
  slateDate: string,
  requestedThroughDate: string,
): Promise<StatcastPitcherExpectedResult> {
  const url = buildStatcastPitcherExpectedUrl(season);
  logger.info({ season, slateDate, requestedThroughDate, url }, "MODULE_02f: fetching Savant expected-pitching leaderboard");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)", Accept: "text/csv,text/plain,*/*" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    // The endpoint is a season-to-date leaderboard with no date filter and no
    // payload-level evidence horizon. Preserve the raw response, but never
    // represent the pipeline's requested D-1 label as source-proven D-1 data.
    const result = parseStatcastPitcherExpectedCsv(await response.text(), season, url, {
      slate_date: slateDate,
      requested_through_date: requestedThroughDate,
      data_through_date: null,
      provenance: "PIPELINE_ASSIGNED",
    });
    logger.info({ status: result.status, pitchers: result.fetched, cutoffStatus: result.cutoff_status, pregameEligible: result.pregame_eligible, errors: result.errors.length }, "MODULE_02f: expected-pitching complete");
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, "MODULE_02f: Savant expected-pitching unavailable");
    return {
      status: "failure", season, stats: new Map(), fetched: 0,
      source_url: url, source_snapshot: null, pregame_eligible: false,
      cutoff_status: "CUTOFF_UNVERIFIED", cutoff_provenance: "UNKNOWN",
      requested_through_date: requestedThroughDate,
      errors: [`Fetch: ${message}`],
    };
  } finally {
    clearTimeout(timeout);
  }
}
