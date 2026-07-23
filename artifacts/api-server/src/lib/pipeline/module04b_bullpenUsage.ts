/**
 * Module 04b: Bullpen Usage
 * Scrapes https://insidethepen.com/bullpen-usage.html — all 30 teams in one
 * server-side-rendered page. Extracts per-reliever last-7-day IP, appearances,
 * days rest, and last outing date. No API key required.
 */

import { logger } from "../../lib/logger.js";

const SOURCE_URL = "https://insidethepen.com/bullpen-usage.html";

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
}

export interface BullpenResult {
  status: "success" | "partial" | "failure";
  date: string;
  relievers: RelieverStat[];
  teams_fetched: number;
  teams_failed: number;
  errors: string[];
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

function parseHtml(html: string, runDate: string): TeamBlock[] {
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

export async function fetchBullpenUsage(
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
  };

  let html: string;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res   = await fetch(SOURCE_URL, {
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

  const blocks = parseHtml(html, date);
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
