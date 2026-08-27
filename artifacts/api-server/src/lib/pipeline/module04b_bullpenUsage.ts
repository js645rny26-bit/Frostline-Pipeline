/**
 * Module 04b: Bullpen Usage
 * Primary: https://mlbstartingnine.com/reports/bullpens/ — all 30 teams in a
 * server-rendered report with MLB player IDs, availability, L5 appearances,
 * and a five-day pitch-count heat map.
 *
 * Secondary: insidethepen.com keeps the prior last-seven-day innings history
 * available when its rows can be matched by MLB ID. The daily Starting Nine
 * status and pitch counts remain authoritative whenever present.
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";

const STARTING_NINE_REPORT_URL = "https://mlbstartingnine.com/reports/bullpens/";
const INSIDE_THE_PEN_URL = "https://insidethepen.com/bullpen-usage.html";

export type BullpenAvailability = "AVAILABLE" | "TIRED" | "UNAVAILABLE" | "UNKNOWN";
export type BullpenWorkloadSource =
  | "MLBSTARTINGNINE_BULLPEN_REPORT"
  | "INSIDETHEPEN_FALLBACK";

// ─── Canonical abbr mapping (insidethepen → our SOURCE_MAPPINGS keys) ─────────
const SITE_ABBR_MAP: Record<string, string> = {
  AZ:  "ARI", ATH: "OAK", ATL: "ATL", BAL: "BAL", BOS: "BOS",
  CHC: "CHC", CIN: "CIN", CLE: "CLE", COL: "COL", CWS: "CHW",
  DET: "DET", HOU: "HOU", KC:  "KCR", LAA: "LAA", LAD: "LAD",
  MIA: "MIA", MIL: "MIL", MIN: "MIN", NYM: "NYM", NYY: "NYY",
  PHI: "PHI", PIT: "PIT", SD:  "SDP", SEA: "SEA", SF:  "SFG",
  STL: "STL", TB:  "TBR", TEX: "TEX", TOR: "TOR", WSH: "WSN",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RelieverStat {
  player_id: number | null;
  full_name: string;
  team_abbr: string;
  innings_last_7: number;
  games_last_7: number;
  days_rest: number;
  last_outing_date: string | null;
  role: string;
  notes: string;
  /** Daily source availability, never inferred from generic days-rest logic. */
  availability_status: BullpenAvailability;
  appearances_last_5: number | null;
  pitches_yesterday: number | null;
  pitches_2_days_ago: number | null;
  pitches_3_days_ago: number | null;
  pitches_4_days_ago: number | null;
  pitches_5_days_ago: number | null;
  workload_source: BullpenWorkloadSource;
  source_snapshot_utc: string | null;
}

export interface BullpenResult {
  status: "success" | "partial" | "failure";
  date: string;
  relievers: RelieverStat[];
  teams_fetched: number;
  teams_failed: number;
  errors: string[];
  primary_source: BullpenWorkloadSource | null;
  source_snapshot_utc: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse MLB innings string "1.2" → decimal (1.667) */
function parseIP(raw: string): number {
  const [whole = "0", thirds = "0"] = raw.split(".");
  return parseInt(whole, 10) + parseInt(thirds, 10) / 3;
}

/** Extract player MLB ID from URL like "/pitcher/Paul-Sewald-623149.html" */
function extractPlayerId(href: string): number | null {
  const m = href.match(/-(\d+)\.html$/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Days between two YYYY-MM-DD strings */
function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T12:00:00Z").getTime();
  const b = new Date(to  + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

function deriveRole(inningsPerGame: number, games7: number): string {
  if (games7 === 0)          return "RESTED";
  if (games7 >= 5)           return "HIGH_WORKLOAD";
  if (inningsPerGame >= 1.5) return "LONG_RELIEF";
  return "RELIEF";
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumericCell(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = stripHtml(raw).replace(/,/g, "");
  if (!cleaned || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function isoDateDaysBefore(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function buildStartingNineTeamSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
    map.set(full_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), canonical_abbr);
  }
  // The site uses the current short franchise identity for the Athletics.
  map.set("athletics", "OAK");
  return map;
}

const STARTING_NINE_TEAM_SLUGS = buildStartingNineTeamSlugMap();

/**
 * Parses the public MLB Starting Nine bullpen report without relying on its
 * expand/collapse JavaScript. The full heat-map tables are server rendered.
 */
export function parseMlbStartingNineBullpenHtml(
  html: string,
  date: string,
  snapshotUtc: string,
): RelieverStat[] {
  const groupStarts = [...html.matchAll(/<tbody\s+class="team-group"[^>]*>/g)];
  const relievers: RelieverStat[] = [];

  for (let index = 0; index < groupStarts.length; index++) {
    const start = groupStarts[index]!.index!;
    const end = groupStarts[index + 1]?.index ?? html.length;
    const groupHtml = html.slice(start, end);
    const slug = groupHtml.match(/data-bs-target="#collapse-([^"]+)"/)?.[1] ?? "";
    const teamAbbr = STARTING_NINE_TEAM_SLUGS.get(slug);
    if (!teamAbbr) continue;

    const heatMapAt = groupHtml.indexOf("5-Day Pitch Count Heat Map");
    if (heatMapAt < 0) continue;
    const heatMapHtml = groupHtml.slice(heatMapAt);

    for (const rowMatch of heatMapHtml.matchAll(/<tr\s+class="bg-white"[^>]*>([\s\S]*?)<\/tr>/g)) {
      const rowHtml = rowMatch[1]!;
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
      if (cells.length < 10) continue;

      const name = cells[0] ? stripHtml(cells[0]) : "";
      const playerIdRaw = rowHtml.match(/\/people\/(\d+)\/headshot/i)?.[1];
      const playerId = playerIdRaw ? Number(playerIdRaw) : null;
      const availability = stripHtml(cells[3] ?? "").toUpperCase();
      const availabilityStatus: BullpenAvailability =
        availability === "AVAILABLE" || availability === "TIRED" || availability === "UNAVAILABLE"
          ? availability
          : "UNKNOWN";
      const appearancesLast5 = parseNumericCell(cells[4]);
      const pitches = [5, 6, 7, 8, 9].map((cellIndex) => parseNumericCell(cells[cellIndex]));
      const firstRecentAppearance = pitches.findIndex((pitchesOnDay) => pitchesOnDay !== null && pitchesOnDay > 0);
      // Preserve the established Days_Rest convention: a pitcher used
      // yesterday has one day between his last outing and this slate date.
      const daysRest = firstRecentAppearance >= 0 ? firstRecentAppearance + 1 : 6;
      const lastOutingDate = firstRecentAppearance >= 0
        ? isoDateDaysBefore(date, firstRecentAppearance + 1)
        : null;

      if (!name || !playerId || !Number.isFinite(playerId)) continue;
      relievers.push({
        player_id: playerId,
        full_name: name,
        team_abbr: teamAbbr,
        innings_last_7: 0,
        games_last_7: appearancesLast5 ?? 0,
        days_rest: daysRest,
        last_outing_date: lastOutingDate,
        role: deriveRole(0, appearancesLast5 ?? 0),
        notes: `Availability: ${availabilityStatus}; L5 pitches: ${pitches.map((value) => value ?? "-").join("/")}`,
        availability_status: availabilityStatus,
        appearances_last_5: appearancesLast5,
        pitches_yesterday: pitches[0] ?? null,
        pitches_2_days_ago: pitches[1] ?? null,
        pitches_3_days_ago: pitches[2] ?? null,
        pitches_4_days_ago: pitches[3] ?? null,
        pitches_5_days_ago: pitches[4] ?? null,
        workload_source: "MLBSTARTINGNINE_BULLPEN_REPORT",
        source_snapshot_utc: snapshotUtc,
      });
    }
  }

  return relievers;
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

interface TeamBlock {
  siteAbbr: string;
  rows: RowData[];
  dateCols: string[];   // e.g. ["2026-07-22","2026-07-21",...]
}

interface RowData {
  name: string;
  playerId: number | null;
  appearances: Array<{ date: string; ip: number }>;
}

/** Convert "Jul-22" + year to "2026-07-22" */
function parseDateHeader(raw: string, year: string): string {
  const months: Record<string, string> = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12",
  };
  const m = raw.match(/([A-Za-z]{3})-(\d+)/);
  if (!m) return "";
  return `${year}-${months[m[1]!] ?? "01"}-${m[2]!.padStart(2, "0")}`;
}

function parseInsideThePenHtml(html: string, runDate: string): TeamBlock[] {
  const year = runDate.slice(0, 4);
  const blocks: TeamBlock[] = [];

  // Split on team section boundaries: each block starts with the team link
  // Pattern: <a href="/team/XX-bullpen.html">...</a> Bullpen Usage
  const teamSectionRe = /<a\s+href="\/team\/([A-Z]+)-bullpen\.html"[^>]*>[\s\S]*?Bullpen Usage[\s\S]*?<table[\s\S]*?<\/table>/g;

  for (const sectionMatch of html.matchAll(teamSectionRe)) {
    const siteAbbr = sectionMatch[1]!;
    const tableHtml = sectionMatch[0];

    // Extract column date headers from <thead>
    const theadMatch = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/);
    const dateCols: string[] = [];
    if (theadMatch) {
      for (const th of theadMatch[1]!.matchAll(/<th[^>]*>([\w-]+)<\/th>/g)) {
        const text = th[1]!.trim();
        if (/[A-Za-z]+-\d+/.test(text)) {
          dateCols.push(parseDateHeader(text, year));
        }
      }
    }

    // Extract player rows from <tbody>
    const rows: RowData[] = [];
    const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) continue;

    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    for (const rowMatch of tbodyMatch[1]!.matchAll(rowRe)) {
      const rowHtml = rowMatch[1]!;

      // Player name + ID
      const nameMatch = rowHtml.match(/<a\s+href="([^"]+)"[^>]*class="usage-link"[^>]*>([^<]+)<\/a>/);
      if (!nameMatch) continue;
      const name     = nameMatch[2]!.trim();
      const playerId = extractPlayerId(nameMatch[1]!);

      // Per-day appearances from data-object divs
      const appearances: Array<{ date: string; ip: number }> = [];
      for (const dayMatch of rowHtml.matchAll(/data-object="(\d{4}-\d{2}-\d{2})"[\s\S]*?<div class="table-split-cell">([\d.]+)/g)) {
        const date = dayMatch[1]!;
        const ip   = parseIP(dayMatch[2]!);
        if (ip > 0) appearances.push({ date, ip });
      }

      rows.push({ name, playerId, appearances });
    }

    if (rows.length > 0) blocks.push({ siteAbbr, rows, dateCols });
  }

  return blocks;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function fetchInsideThePenUsage(
  date: string,
  _teamIds: number[] = [],   // kept for interface compatibility; unused — scraper gets all 30
): Promise<BullpenResult> {
  logger.info({ date }, "MODULE_04b: Fetching bullpen usage from insidethepen.com");

  const result: BullpenResult = {
    status: "success",
    date,
    relievers: [],
    teams_fetched: 0,
    teams_failed: 0,
    errors: [],
    primary_source: "INSIDETHEPEN_FALLBACK",
    source_snapshot_utc: null,
  };

  let html: string;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res   = await fetch(INSIDE_THE_PEN_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_04b: Fetch failed");
    return { ...result, status: "failure", errors: [`Fetch: ${msg}`] };
  }

  const blocks = parseInsideThePenHtml(html, date);
  logger.info({ blocks: blocks.length }, "MODULE_04b: Team blocks parsed");

  if (blocks.length === 0) {
    return { ...result, status: "failure", errors: ["No team blocks found in HTML"] };
  }

  for (const block of blocks) {
    const canonAbbr = SITE_ABBR_MAP[block.siteAbbr] ?? block.siteAbbr;

    if (block.rows.length === 0) {
      result.teams_failed++;
      result.errors.push(`No rows for ${block.siteAbbr}`);
      continue;
    }
    result.teams_fetched++;

    for (const row of block.rows) {
      // Filter to last 7 days (appearances before the run date)
      const recent = row.appearances.filter((a) => a.date < date && daysBetween(a.date, date) <= 7);

      const inningsTotal = recent.reduce((s, a) => s + a.ip, 0);
      const gamesTotal   = recent.length;

      const lastDate = recent.length > 0
        ? recent.reduce((latest, a) => a.date > latest ? a.date : latest, recent[0]!.date)
        : null;
      const daysRest = lastDate ? daysBetween(lastDate, date) : 7;

      const ipPerGame = gamesTotal > 0 ? inningsTotal / gamesTotal : 0;

      result.relievers.push({
        player_id:        row.playerId,
        full_name:        row.name,
        team_abbr:        canonAbbr,
        innings_last_7:   Math.round(inningsTotal * 1000) / 1000,
        games_last_7:     gamesTotal,
        days_rest:        daysRest,
        last_outing_date: lastDate,
        role:             deriveRole(ipPerGame, gamesTotal),
        notes:            "",
        availability_status: "UNKNOWN",
        appearances_last_5: gamesTotal,
        pitches_yesterday: null,
        pitches_2_days_ago: null,
        pitches_3_days_ago: null,
        pitches_4_days_ago: null,
        pitches_5_days_ago: null,
        workload_source: "INSIDETHEPEN_FALLBACK",
        source_snapshot_utc: null,
      });
    }
  }

  if (result.errors.length > 0 && result.teams_fetched === 0) {
    result.status = "failure";
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { relievers: result.relievers.length, teams: result.teams_fetched, status: result.status },
    "MODULE_04b: Bullpen usage complete",
  );
  return result;
}

async function fetchMlbStartingNineBullpenUsage(date: string): Promise<BullpenResult> {
  const snapshotUtc = new Date().toISOString();
  const result: BullpenResult = {
    status: "success",
    date,
    relievers: [],
    teams_fetched: 0,
    teams_failed: 0,
    errors: [],
    primary_source: "MLBSTARTINGNINE_BULLPEN_REPORT",
    source_snapshot_utc: snapshotUtc,
  };

  logger.info({ date, source: STARTING_NINE_REPORT_URL }, "MODULE_04b: Fetching primary bullpen availability report");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const response = await fetch(STARTING_NINE_REPORT_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    result.relievers = parseMlbStartingNineBullpenHtml(await response.text(), date, snapshotUtc);
    const teams = new Set(result.relievers.map((reliever) => reliever.team_abbr));
    result.teams_fetched = teams.size;
    result.teams_failed = Math.max(0, Object.keys(SOURCE_MAPPINGS).length - teams.size);
    if (result.relievers.length === 0) {
      result.status = "failure";
      result.errors.push("No reliever rows found in MLB Starting Nine bullpen report");
    } else if (result.teams_failed > 0) {
      result.status = "partial";
      result.errors.push(`Missing bullpen report rows for ${result.teams_failed} team(s)`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_04b: MLB Starting Nine bullpen fetch failed");
    result.status = "failure";
    result.errors.push(`MLB Starting Nine fetch: ${message}`);
  }

  logger.info(
    { relievers: result.relievers.length, teams: result.teams_fetched, status: result.status },
    "MODULE_04b: Primary bullpen availability report complete",
  );
  return result;
}

/**
 * Starting Nine owns same-day availability and pitch-count state. Inside The
 * Pen contributes seven-day innings history only when it can be matched to
 * the same MLB player ID. This prevents a generic rest heuristic from
 * overriding the source's explicit AVAILABLE / TIRED / UNAVAILABLE status.
 */
function mergeBullpenSources(primary: BullpenResult, fallback: BullpenResult): BullpenResult {
  if (primary.relievers.length === 0) {
    return {
      ...fallback,
      errors: [...primary.errors, ...fallback.errors],
    };
  }

  const fallbackByPlayer = new Map(
    fallback.relievers
      .filter((reliever) => reliever.player_id !== null)
      .map((reliever) => [`${reliever.team_abbr}:${reliever.player_id}`, reliever]),
  );
  const primaryTeams = new Set(primary.relievers.map((reliever) => reliever.team_abbr));
  const primaryRelievers = primary.relievers.map((reliever) => {
    const fallbackReliever = reliever.player_id === null
      ? undefined
      : fallbackByPlayer.get(`${reliever.team_abbr}:${reliever.player_id}`);
    if (!fallbackReliever) return reliever;
    return {
      ...reliever,
      innings_last_7: fallbackReliever.innings_last_7,
      games_last_7: fallbackReliever.games_last_7,
      role: fallbackReliever.role,
      notes: `${reliever.notes}; ITP innings history matched`,
    };
  });
  const fallbackOnly = fallback.relievers.filter((reliever) => !primaryTeams.has(reliever.team_abbr));
  const completePrimary = primary.status === "success" && primary.teams_failed === 0;

  return {
    ...primary,
    status: completePrimary ? "success" : "partial",
    relievers: [...primaryRelievers, ...fallbackOnly],
    teams_fetched: new Set([...primaryTeams, ...fallbackOnly.map((reliever) => reliever.team_abbr)]).size,
    teams_failed: primary.teams_failed,
    errors: [...primary.errors, ...fallback.errors],
  };
}

/**
 * Primary daily workload feed: MLB Starting Nine's availability and five-day
 * pitch-count report. Seven-day innings history is enriched from the former
 * Inside The Pen source when available; it never replaces a primary status.
 */
export async function fetchBullpenUsage(
  date: string,
  teamIds: number[] = [],
): Promise<BullpenResult> {
  const [primary, fallback] = await Promise.all([
    fetchMlbStartingNineBullpenUsage(date),
    fetchInsideThePenUsage(date, teamIds),
  ]);
  const merged = mergeBullpenSources(primary, fallback);
  logger.info(
    {
      relievers: merged.relievers.length,
      teams: merged.teams_fetched,
      primary_status: primary.status,
      fallback_status: fallback.status,
      status: merged.status,
    },
    "MODULE_04b: Bullpen availability and innings history resolved",
  );
  return merged;
}

/** Build a Map<game_id, RelieverStat[]> keyed by team_abbr for quick lookups */
export function buildTeamIdAbbrMap(
  sourceMappings: Record<string, { canonical_abbr: string }>,
): Map<number, string> {
  const map = new Map<number, string>();
  for (const [idStr, val] of Object.entries(sourceMappings)) {
    const id = parseInt(idStr, 10);
    if (!isNaN(id)) map.set(id, val.canonical_abbr);
  }
  return map;
}
