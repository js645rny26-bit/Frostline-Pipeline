/**
 * Module 04c: MLB Starting Nine Scraper
 * Fetches live starting lineups and park factors from mlbstartingnine.com.
 *
 * Data extracted:
 *  - Batting order (1–9) + player name           → ld+json SportsEvent blocks (reliable SSR)
 *  - Handedness (L/R/S) + fielding position       → HTML regex
 *  - Park factors (R%, HR%L/R, wOBA%L/R)         → stripped HTML regex
 *  - Official vs Projected status                 → ld+json subOrganization name
 *
 * No API key required — site is public and server-side rendered.
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { baseGameId } from "./module01_mlbStatsApi.js";

const BASE_URL = "https://mlbstartingnine.com";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LineupPlayer {
  batting_order: number;
  name: string;
  handedness: string;  // "R" | "L" | "S" | ""
  position: string;    // "LF" | "1B" | "SS" | "" etc.
}

/** Park factors as signed integer percentages relative to league average.
 *  e.g. hr_l_pct = +16 means 16% above average for LHB. */
export interface ParkFactors {
  runs_pct: number;
  hr_l_pct: number;
  hr_r_pct: number;
  woba_l_pct: number;
  woba_r_pct: number;
}

export interface StartingNineGame {
  /** legacy_game_id if we could resolve both teams, else null */
  game_id: string | null;
  away_abbr: string | null;
  home_abbr: string | null;
  venue: string;
  lineup_status: "official" | "projected";
  park_factors: ParkFactors;
  away_lineup: LineupPlayer[];
  home_lineup: LineupPlayer[];
}

export interface StartingNineResult {
  status: "success" | "partial" | "failure";
  date: string;
  games: StartingNineGame[];
  games_parsed: number;
  games_matched: number;  // resolved to a legacy_game_id
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build full_name → canonical_abbr reverse lookup from SOURCE_MAPPINGS */
function buildNameToAbbrMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
    map.set(full_name.toLowerCase(), canonical_abbr);
    // Also map the short form, e.g. "Yankees" → "NYY"
    const parts = full_name.split(" ");
    if (parts.length > 1) {
      map.set(parts[parts.length - 1]!.toLowerCase(), canonical_abbr);
    }
  }
  // Manual overrides for site-specific team name variants
  map.set("dbacks", "ARI");
  map.set("d-backs", "ARI");
  map.set("diamondbacks", "ARI");
  return map;
}

const NAME_TO_ABBR = buildNameToAbbrMap();

function resolveTeam(rawName: string): string | null {
  const lower = rawName.toLowerCase().trim();
  // Try full name first
  if (NAME_TO_ABBR.has(lower)) return NAME_TO_ABBR.get(lower)!;
  // Try last word (e.g. "Pittsburgh Pirates" → "pirates")
  const parts = lower.split(" ");
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join(" ");
    if (NAME_TO_ABBR.has(candidate)) return NAME_TO_ABBR.get(candidate)!;
  }
  return null;
}

function buildGameId(date: string, awayAbbr: string, homeAbbr: string): string {
  return `${date.replace(/-/g, "")}_${awayAbbr}_${homeAbbr}`;
}

/** Parse "Pittsburgh Pirates at New York Yankees Matchup" → {away, home} */
function parseMatchupName(name: string): { away: string; home: string } | null {
  const m = name.match(/^(.+?)\s+at\s+(.+?)\s+Matchup$/i);
  if (!m) return null;
  return { away: m[1]!.trim(), home: m[2]!.trim() };
}

/** Convert signed pct string like "+16" or "-2" to number */
function parsePct(s: string): number {
  return parseInt(s, 10);
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────

interface LdJsonEvent {
  venue: string;
  awayName: string;
  homeName: string;
  awayOfficial: boolean;
  homeOfficial: boolean;
  awayPlayers: Array<{ position: number; name: string }>;
  homePlayers: Array<{ position: number; name: string }>;
}

function parseLdJsonEvents(html: string): LdJsonEvent[] {
  const events: LdJsonEvent[] = [];
  const blockRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const [, raw] of html.matchAll(blockRe)) {
    let data: unknown;
    try { data = JSON.parse(raw!.trim()); } catch { continue; }
    const items: unknown[] = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const ev = item as Record<string, unknown>;
      if (ev["@type"] !== "SportsEvent") continue;

      const matchup = parseMatchupName(String(ev["name"] ?? ""));
      if (!matchup) continue;

      const location = ev["location"] as Record<string, unknown> | undefined;
      const venue = String(location?.["name"] ?? "");

      const competitors = (ev["competitor"] as unknown[]) ?? [];
      if (competitors.length < 2) continue;

      const parseTeam = (c: unknown) => {
        const t = c as Record<string, unknown>;
        const subOrg = t["subOrganization"] as Record<string, unknown> | undefined;
        const official = String(subOrg?.["name"] ?? "").toLowerCase().includes("official");
        const items = (subOrg?.["itemListElement"] as unknown[]) ?? [];
        return {
          official,
          players: items.map((i) => {
            const it = i as Record<string, unknown>;
            return {
              position: Number(it["position"]),
              name: String((it["item"] as Record<string, unknown>)?.["name"] ?? ""),
            };
          }),
        };
      };

      const away = parseTeam(competitors[0]);
      const home = parseTeam(competitors[1]);

      events.push({
        venue,
        awayName: matchup.away,
        homeName: matchup.home,
        awayOfficial: away.official,
        homeOfficial: home.official,
        awayPlayers: away.players,
        homePlayers: home.players,
      });
    }
  }
  return events;
}

/** Build name → {handedness, position} lookup from HTML (first occurrence wins) */
function parsePlayerDetails(html: string): Map<string, { handedness: string; position: string }> {
  const map = new Map<string, { handedness: string; position: string }>();

  // Pattern: fielding position span (width: 22px) → handedness span → player name anchor
  const re = /width: 22px[^"]*">\s*([A-Z0-9]{1,3})\s*<\/span>[\s\S]{0,500}?\((R|L|S)\)<\/span>[\s\S]{0,300}?title="([^"]+)"/g;
  for (const m of html.matchAll(re)) {
    const [, pos, hand, name] = m;
    const key = name!.trim().toLowerCase();
    if (!map.has(key)) {
      map.set(key, { handedness: hand!, position: pos! });
    }
  }
  return map;
}

/** Extract park factor blocks from stripped HTML, in page order.
 *  We take only the first N unique blocks (one per game). */
function parseParkFactors(html: string): ParkFactors[] {
  // Strip tags and collapse whitespace
  const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  const re = /R:\s*([-+]?\d+)%\s*HR:\s*([-+]?\d+)%\s*L\s*\/\s*([-+]?\d+)%\s*R\s*wOBA:\s*([-+]?\d+)%\s*L\s*\/\s*([-+]?\d+)%\s*R/g;
  const seen = new Set<string>();
  const results: ParkFactors[] = [];

  for (const m of stripped.matchAll(re)) {
    const key = m.slice(1).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      runs_pct:   parsePct(m[1]!),
      hr_l_pct:   parsePct(m[2]!),
      hr_r_pct:   parsePct(m[3]!),
      woba_l_pct: parsePct(m[4]!),
      woba_r_pct: parsePct(m[5]!),
    });
  }
  return results;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchStartingNine(date: string): Promise<StartingNineResult> {
  logger.info({ date }, "MODULE_04c: Fetching starting lineups from mlbstartingnine.com");

  const result: StartingNineResult = {
    status: "success",
    date,
    games: [],
    games_parsed: 0,
    games_matched: 0,
    errors: [],
  };

  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${BASE_URL}/?date=${date}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "MODULE_04c: Fetch failed");
    result.status = "failure";
    result.errors.push(`Fetch failed: ${msg}`);
    return result;
  }

  // Parse all three data sources from the HTML
  const events     = parseLdJsonEvents(html);
  const playerMap  = parsePlayerDetails(html);
  const pfBlocks   = parseParkFactors(html);

  logger.info({ events: events.length, players: playerMap.size, pf: pfBlocks.length }, "MODULE_04c: HTML parsed");

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    result.games_parsed++;

    const awayAbbr = resolveTeam(ev.awayName);
    const homeAbbr = resolveTeam(ev.homeName);
    const gameId   = awayAbbr && homeAbbr ? buildGameId(date, awayAbbr, homeAbbr) : null;
    if (gameId) result.games_matched++;

    // Park factors: same index as event (unique blocks, page order)
    const pf: ParkFactors = pfBlocks[i] ?? { runs_pct: 0, hr_l_pct: 0, hr_r_pct: 0, woba_l_pct: 0, woba_r_pct: 0 };

    const resolveLineup = (players: Array<{ position: number; name: string }>): LineupPlayer[] =>
      players.map((p) => {
        const detail = playerMap.get(p.name.toLowerCase());
        return {
          batting_order: p.position,
          name:          p.name,
          handedness:    detail?.handedness ?? "",
          position:      detail?.position ?? "",
        };
      });

    const lineupStatus: "official" | "projected" =
      ev.awayOfficial || ev.homeOfficial ? "official" : "projected";

    result.games.push({
      game_id:        gameId,
      away_abbr:      awayAbbr,
      home_abbr:      homeAbbr,
      venue:          ev.venue,
      lineup_status:  lineupStatus,
      park_factors:   pf,
      away_lineup:    resolveLineup(ev.awayPlayers),
      home_lineup:    resolveLineup(ev.homePlayers),
    });

    if (!awayAbbr || !homeAbbr) {
      result.errors.push(`Could not resolve teams: "${ev.awayName}" / "${ev.homeName}"`);
    }
  }

  if (result.games_parsed === 0) {
    result.status = "failure";
    result.errors.push("No SportsEvent blocks found in HTML");
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { parsed: result.games_parsed, matched: result.games_matched, status: result.status },
    "MODULE_04c: Starting Nine fetch complete",
  );
  return result;
}

/**
 * Build a game-ID map for the current schedule.
 *
 * Starting Nine identifies cards by date + teams, which is ambiguous for a
 * doubleheader. We deliberately withhold that card from both official games
 * instead of assigning one lineup/park snapshot to the wrong game. Regular
 * games retain the existing direct match.
 */
export function buildStartingNineMap(
  result: StartingNineResult,
  scheduleGameIds?: readonly string[],
): Map<string, StartingNineGame> {
  const map = new Map<string, StartingNineGame>();
  const scheduleByBase = new Map<string, string[]>();
  for (const id of scheduleGameIds ?? []) {
    const base = baseGameId(id);
    const matches = scheduleByBase.get(base) ?? [];
    matches.push(id);
    scheduleByBase.set(base, matches);
  }

  for (const g of result.games) {
    if (!g.game_id) continue;
    const candidates = scheduleByBase.get(baseGameId(g.game_id));
    if (candidates && candidates.length === 1) {
      map.set(candidates[0]!, g);
    } else if (!candidates) {
      map.set(g.game_id, g);
    }
  }
  return map;
}

/** Convert a park factor percentage to a multiplier (e.g. +16 → 1.16) */
export function pctToMultiplier(pct: number): number {
  return Math.round((1 + pct / 100) * 1000) / 1000;
}
