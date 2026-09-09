/**
 * Module 02h: SOURCE_SAVANT_PITCH_LEVEL
 *
 * Cutoff-safe raw Statcast pitch-event acquisition shared by future workload,
 * exact-lineup, arsenal, true-skill, and conversion research. This module is
 * deliberately a source store, not a run-projection input. It retains the
 * untouched CSV and validates the Savant schema before exposing a parsed view.
 */

import { logger } from "../../lib/logger.js";
import type { SourceAvailability, SourceSnapshot } from "./module02_sourceSnapshots.js";

export const SOURCE_SAVANT_PITCH_LEVEL = "SOURCE_SAVANT_PITCH_LEVEL";
export const SAVANT_PITCH_LEVEL_PARSER_VERSION = "1.0.0";

export const SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS = [
  "game_date",
  "game_pk",
  "at_bat_number",
  "batter",
  "pitcher",
  "stand",
  "p_throws",
  "pitch_type",
  "events",
  "description",
] as const;

export type PitchLevelWindow = "SEASON" | "L30" | "L14" | "L5";

export interface SavantPitchLevelEvent {
  game_date: string;
  game_pk: number;
  at_bat_number: number;
  batter: number;
  pitcher: number;
  stand: string;
  p_throws: string;
  pitch_type: string;
  events: string;
  description: string;
  /** Exact source header/value pairs are preserved for later feature work. */
  raw: ReadonlyMap<string, string>;
}

export interface SavantPitchLevelResult {
  status: "success" | "partial" | "failure";
  data_through_date: string;
  source_url: string;
  events: SavantPitchLevelEvent[];
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
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index++;
      } else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields;
}

function parseId(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function headerIndex(headers: readonly string[], name: string): number {
  return headers.indexOf(name);
}

/**
 * Direct Savant CSV route. Query parameters deliberately remain visible in
 * the stored request URL; source definitions must never be inferred later.
 */
export function buildSavantPitchLevelUrl(date: string): string {
  const query = new URLSearchParams({
    type: "details",
    game_date_gt: date,
    game_date_lt: date,
    hfGT: "R|",
    // Savant otherwise returns a schema-valid header-only CSV for an
    // unscoped details query. This requests the complete result set while
    // the date and regular-season filters remain the pregame safety boundary.
    all: "true",
  });
  return `https://baseballsavant.mlb.com/statcast_search/csv?${query.toString()}`;
}

function snapshot(
  raw: string,
  url: string,
  dataThroughDate: string,
  headers: string[],
  events: SavantPitchLevelEvent[],
  status: SourceAvailability,
  notes: string,
): SourceSnapshot {
  return {
    canonical_source_id: SOURCE_SAVANT_PITCH_LEVEL,
    request_url: url,
    fetch_timestamp_utc: new Date().toISOString(),
    data_through_date: dataThroughDate,
    raw_response: raw,
    row_count: events.length,
    expected_columns: Array.from(SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS),
    // Header spelling is source-owned. Preserve the exact response contract.
    observed_columns: headers,
    mlbam_coverage: new Set(events.flatMap((event) => [event.batter, event.pitcher])).size,
    parser_version: SAVANT_PITCH_LEVEL_PARSER_VERSION,
    source_status: status,
    fallback_used: "NONE",
    notes,
  };
}

/** Parse a raw daily CSV without renaming or positionally interpreting Savant fields. */
export function parseSavantPitchLevelCsv(
  raw: string,
  dataThroughDate: string,
  sourceUrl: string,
): SavantPitchLevelResult {
  const parsed = raw.replace(/^\uFEFF/, "");
  const lines = parsed.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return {
      status: "failure", data_through_date: dataThroughDate, source_url: sourceUrl,
      events: [], source_snapshot: null, errors: ["Savant pitch-level CSV was empty"],
    };
  }
  const headers = parseCsvRow(lines[0]!);
  const missing = SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS.filter(
    (name) => headerIndex(headers, name) < 0,
  );
  if (missing.length > 0) {
    return {
      status: "failure",
      data_through_date: dataThroughDate,
      source_url: sourceUrl,
      events: [],
      source_snapshot: snapshot(
        raw, sourceUrl, dataThroughDate, headers, [], "SCHEMA_DRIFT",
        `Required pitch-level columns missing: ${missing.join(", ")}`,
      ),
      errors: [`Required pitch-level columns missing: ${missing.join(", ")}`],
    };
  }
  const indices = Object.fromEntries(
    SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS.map((name) => [name, headerIndex(headers, name)]),
  ) as Record<(typeof SAVANT_PITCH_LEVEL_REQUIRED_COLUMNS)[number], number>;
  const events: SavantPitchLevelEvent[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvRow(line);
    const gamePk = parseId(values[indices.game_pk]);
    const atBatNumber = Number.parseInt(String(values[indices.at_bat_number] ?? "").trim(), 10);
    const batter = parseId(values[indices.batter]);
    const pitcher = parseId(values[indices.pitcher]);
    const gameDate = String(values[indices.game_date] ?? "").trim();
    if (!gamePk || !Number.isFinite(atBatNumber) || atBatNumber < 0 || !batter || !pitcher || !gameDate || gameDate > dataThroughDate) continue;
    events.push({
      game_date: gameDate,
      game_pk: gamePk,
      at_bat_number: atBatNumber,
      batter,
      pitcher,
      stand: String(values[indices.stand] ?? "").trim(),
      p_throws: String(values[indices.p_throws] ?? "").trim(),
      pitch_type: String(values[indices.pitch_type] ?? "").trim(),
      events: String(values[indices.events] ?? "").trim(),
      description: String(values[indices.description] ?? "").trim(),
      raw: new Map(headers.map((header, index) => [header, values[index] ?? ""])),
    });
  }
  const status: SourceAvailability = events.length === 0 ? "PARTIAL" : "CURRENT";
  const notes = events.length === 0
    ? "Validated regular-season pitch-level schema; no parsable events in requested date window."
    : "Daily regular-season pitch-level events; retained raw before downstream feature engineering.";
  return {
    status: events.length === 0 ? "partial" : "success",
    data_through_date: dataThroughDate,
    source_url: sourceUrl,
    events,
    source_snapshot: snapshot(raw, sourceUrl, dataThroughDate, headers, events, status, notes),
    errors: [],
  };
}

/**
 * Shared event-window law for later Season/L30/L14/L5 feature builders.
 * The cutoff is inclusive, with a calendar lookback that never permits a
 * same-day pitch into a game whose pregame snapshot was earlier that day.
 */
export function selectSavantPitchLevelWindow(
  events: readonly SavantPitchLevelEvent[],
  dataThroughDate: string,
  window: PitchLevelWindow,
): SavantPitchLevelEvent[] {
  const cutoff = Date.parse(`${dataThroughDate}T12:00:00.000Z`);
  if (!Number.isFinite(cutoff)) return [];
  const days = window === "L30" ? 30 : window === "L14" ? 14 : window === "L5" ? 5 : null;
  const start = days === null ? Number.NEGATIVE_INFINITY : cutoff - (days - 1) * 86_400_000;
  return events.filter((event) => {
    const date = Date.parse(`${event.game_date}T12:00:00.000Z`);
    return Number.isFinite(date) && date >= start && date <= cutoff;
  });
}

export async function fetchSavantPitchLevelDay(
  dataThroughDate: string,
): Promise<SavantPitchLevelResult> {
  const url = buildSavantPitchLevelUrl(dataThroughDate);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    logger.info({ data_through_date: dataThroughDate, url }, "MODULE_02h: fetching Savant pitch-level CSV");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)",
        Accept: "text/csv,text/plain,*/*",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return parseSavantPitchLevelCsv(await response.text(), dataThroughDate, url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message, data_through_date: dataThroughDate }, "MODULE_02h: Savant pitch-level source unavailable");
    return {
      status: "failure", data_through_date: dataThroughDate, source_url: url,
      events: [], source_snapshot: null, errors: [`Fetch: ${message}`],
    };
  } finally {
    clearTimeout(timeout);
  }
}
