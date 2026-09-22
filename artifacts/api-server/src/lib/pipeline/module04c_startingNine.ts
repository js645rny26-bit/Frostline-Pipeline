/**
 * Module 04c: MLB Starting Nine Scraper
 * Fetches live starting lineups and park factors from mlbstartingnine.com.
 * It also follows the slate's individual team-page links. Those pages expose
 * the named starter and descriptive opponent/park/umpire context that is not
 * present on the main slate page.
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
import { baseGameId, type ScheduleGameData } from "./module01_mlbStatsApi.js";
import type { SourceSnapshot } from "./module02_sourceSnapshots.js";

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
  /** Source event timestamp used only to bind same-team doubleheader cards. */
  scheduled_first_pitch_utc?: string | null;
  lineup_status: "official" | "projected";
  /** Per-side source state retained for research provenance. */
  away_lineup_status?: "official" | "projected";
  home_lineup_status?: "official" | "projected";
  park_factors: ParkFactors;
  away_lineup: LineupPlayer[];
  home_lineup: LineupPlayer[];
}

export interface StartingNineSplitLine {
  avg: number | null;
  ops: number | null;
  hr: number | null;
  k: number | null;
}

export interface StartingNineTeamPage {
  date: string;
  game_id: string | null;
  team_abbr: string | null;
  opponent_abbr: string | null;
  team_side: "away" | "home" | "unknown";
  scheduled_first_pitch_utc: string | null;
  lineup_status: "official" | "projected" | "unknown";
  starting_pitcher_id: number | null;
  starting_pitcher_name: string | null;
  starting_pitcher_hand: string | null;
  starting_pitcher_identity_status: "MLB_ID_VERIFIED" | "UNVERIFIED" | "MISSING";
  opposing_pitcher_id: number | null;
  opposing_pitcher_name: string | null;
  opposing_pitcher_hand: string | null;
  opposing_pitcher_ip: number | null;
  opposing_pitcher_era: number | null;
  opposing_pitcher_whip: number | null;
  opposing_pitcher_so: number | null;
  opposing_pitcher_vs_lhb: StartingNineSplitLine;
  opposing_pitcher_vs_rhb: StartingNineSplitLine;
  park_runs_index: number | null;
  park_hr_lhb_index: number | null;
  park_hr_rhb_index: number | null;
  umpire: string | null;
  umpire_k_rate: number | null;
  umpire_bb_rate: number | null;
  umpire_runs_per_game: number | null;
  observed_ts_utc: string;
  source_url: string;
  source_status: "PARSED" | "PARTIAL" | "REJECTED";
  source_notes: string[];
  active_input: "NO";
  mapping_status: "DISPLAY_ONLY_NOT_PROJECTION_INPUT";
  /** Untouched HTML retained in the existing append-only source ledger. */
  source_snapshot?: SourceSnapshot | null;
}

export interface StartingNineStarterFallback {
  game_id: string;
  team_abbr: string;
  team_side: "away" | "home";
  pitcher_id: number;
  pitcher_name: string;
  pitcher_hand: string;
  source_url: string;
  observed_ts_utc: string;
}

export interface StartingNineResult {
  status: "success" | "partial" | "failure";
  date: string;
  games: StartingNineGame[];
  games_parsed: number;
  games_matched: number;  // resolved to a legacy_game_id
  errors: string[];
  team_pages: StartingNineTeamPage[];
  team_pages_requested: number;
  team_pages_parsed: number;
  team_page_status: "success" | "partial" | "failure";
  team_page_errors: string[];
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

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ",
  };
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePersonName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

const STARTING_NINE_TEAM_PAGE_EXPECTED_FIELDS = [
  "STARTER_IDENTITY", "STARTER_HAND", "OPPOSING_PITCHER_SEASON",
  "OPPOSING_PITCHER_PLATOON", "PARK_INDEXES", "UMPIRE_CONTEXT",
] as const;

/**
 * Preserve the exact team-page response separately from the current-state
 * workbook view. The page does not publish a trustworthy statistics
 * data-through date, so that field deliberately remains blank.
 */
export function buildStartingNineTeamPageSourceSnapshot(
  page: StartingNineTeamPage,
  rawHtml: string,
): SourceSnapshot {
  const observed = [
    page.starting_pitcher_id && page.starting_pitcher_name ? "STARTER_IDENTITY" : "",
    page.starting_pitcher_hand ? "STARTER_HAND" : "",
    page.opposing_pitcher_ip !== null || page.opposing_pitcher_era !== null
      || page.opposing_pitcher_whip !== null || page.opposing_pitcher_so !== null
      ? "OPPOSING_PITCHER_SEASON" : "",
    page.opposing_pitcher_vs_lhb.avg !== null || page.opposing_pitcher_vs_rhb.avg !== null
      ? "OPPOSING_PITCHER_PLATOON" : "",
    page.park_runs_index !== null || page.park_hr_lhb_index !== null || page.park_hr_rhb_index !== null
      ? "PARK_INDEXES" : "",
    page.umpire !== null || page.umpire_k_rate !== null || page.umpire_bb_rate !== null
      || page.umpire_runs_per_game !== null ? "UMPIRE_CONTEXT" : "",
  ].filter(Boolean);
  return {
    canonical_source_id: "MLB_STARTING_NINE_TEAM_PAGE",
    request_url: page.source_url,
    fetch_timestamp_utc: page.observed_ts_utc,
    data_through_date: "",
    raw_response: rawHtml,
    row_count: 1,
    expected_columns: [...STARTING_NINE_TEAM_PAGE_EXPECTED_FIELDS],
    observed_columns: observed,
    mlbam_coverage: page.starting_pitcher_identity_status === "MLB_ID_VERIFIED" ? 1 : 0,
    parser_version: "STARTING_NINE_TEAM_PAGE_V1",
    source_status: page.source_status === "PARSED"
      ? "CURRENT" : page.source_status === "PARTIAL" ? "PARTIAL" : "SCHEMA_DRIFT",
    fallback_used: "NONE",
    notes: [
      `SLATE_DATE=${page.date}`,
      `GAME_ID=${page.game_id ?? "UNRESOLVED"}`,
      `TEAM=${page.team_abbr ?? "UNRESOLVED"}`,
      `SIDE=${page.team_side}`,
      `IDENTITY=${page.starting_pitcher_identity_status}`,
      `PAGE_STATUS=${page.source_status}`,
      ...page.source_notes,
    ].join(";"),
  };
}

/** Retain only pages belonging to games still mutable at this exact publish. */
export function selectMutableStartingNineTeamPageSnapshots(
  pages: readonly StartingNineTeamPage[],
  mutableGameIds: ReadonlySet<string>,
): SourceSnapshot[] {
  const mutableBaseIds = new Set([...mutableGameIds].map((gameId) => baseGameId(gameId)));
  return pages
    .filter((page) => page.game_id !== null
      && mutableBaseIds.has(baseGameId(page.game_id))
      && page.source_snapshot !== null
      && page.source_snapshot !== undefined)
    .map((page) => page.source_snapshot!);
}

function buildStartingNineTeamSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
    map.set(full_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), canonical_abbr);
  }
  // The site dropped the city from the Athletics slug.
  map.set("athletics", "OAK");
  return map;
}

const STARTING_NINE_TEAM_SLUGS = buildStartingNineTeamSlugMap();

// ─── HTML parsers ─────────────────────────────────────────────────────────────

interface LdJsonEvent {
  venue: string;
  scheduledFirstPitchUtc: string | null;
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
        scheduledFirstPitchUtc: typeof ev["startDate"] === "string" ? ev["startDate"] : null,
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

/**
 * Bind a Starting Nine slate card to an official game identity.
 *
 * A date/team key is sufficient for a normal game. For a doubleheader it is
 * deliberately insufficient: the source event must expose a first-pitch time
 * that matches exactly one MLB schedule game. Otherwise the base identity is
 * retained and the downstream mapper continues to fail closed.
 */
export function resolveStartingNineGameId(
  baseId: string,
  scheduledFirstPitchUtc: string | null,
  scheduleGames: readonly ScheduleGameData[],
): string {
  const candidates = scheduleGames.filter((game) => baseGameId(game.legacy_game_id) === baseId);
  if (candidates.length === 1) return candidates[0]!.legacy_game_id;
  if (candidates.length < 2 || !scheduledFirstPitchUtc) return baseId;

  const sourceTime = Date.parse(scheduledFirstPitchUtc);
  if (!Number.isFinite(sourceTime)) return baseId;
  const exact = candidates.filter((game) => {
    const scheduleTime = game.gameDateTime ? Date.parse(game.gameDateTime) : Number.NaN;
    return Number.isFinite(scheduleTime) && scheduleTime === sourceTime;
  });
  return exact.length === 1 ? exact[0]!.legacy_game_id : baseId;
}

function emptySplitLine(): StartingNineSplitLine {
  return { avg: null, ops: null, hr: null, k: null };
}

function parseTeamPageLinks(html: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const match of html.matchAll(/href="(\/lineups\/([^"/]+)\/)"/gi)) {
    const slug = match[2]!.toLowerCase();
    const teamAbbr = STARTING_NINE_TEAM_SLUGS.get(slug);
    if (teamAbbr) links.set(teamAbbr, `${BASE_URL}${match[1]}`);
  }
  return links;
}

interface TeamPageEvent {
  gameId: string | null;
  teamAbbr: string | null;
  opponentAbbr: string | null;
  side: "away" | "home" | "unknown";
  firstPitchUtc: string | null;
  lineupStatus: "official" | "projected" | "unknown";
}

function parseTeamPageEvent(html: string, requestedDate: string, expectedTeamAbbr: string | null): TeamPageEvent {
  const fallback: TeamPageEvent = {
    gameId: null,
    teamAbbr: null,
    opponentAbbr: null,
    side: "unknown",
    firstPitchUtc: null,
    lineupStatus: "unknown",
  };
  const blockRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const [, raw] of html.matchAll(blockRe)) {
    let data: unknown;
    try { data = JSON.parse(raw!.trim()); } catch { continue; }
    const items: unknown[] = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (event["@type"] !== "SportsEvent") continue;
      const matchup = parseMatchupName(String(event["name"] ?? ""));
      if (!matchup) continue;
      const awayAbbr = resolveTeam(matchup.away);
      const homeAbbr = resolveTeam(matchup.home);
      const competitors = (event["competitor"] as unknown[]) ?? [];
      let teamAbbr: string | null = expectedTeamAbbr;
      let side: TeamPageEvent["side"] = "unknown";
      let lineupStatus: TeamPageEvent["lineupStatus"] = "unknown";
      for (let index = 0; index < competitors.length; index++) {
        const competitor = competitors[index] as Record<string, unknown>;
        const competitorAbbr = resolveTeam(String(competitor["name"] ?? ""));
        if (expectedTeamAbbr && competitorAbbr !== expectedTeamAbbr) continue;
        const subOrg = competitor["subOrganization"] as Record<string, unknown> | undefined;
        teamAbbr = competitorAbbr;
        side = index === 0 ? "away" : index === 1 ? "home" : "unknown";
        lineupStatus = !subOrg
          ? "unknown"
          : String(subOrg["name"] ?? "").toLowerCase().includes("official")
            ? "official"
            : "projected";
        break;
      }
      const firstPitchUtc = typeof event["startDate"] === "string" ? event["startDate"] : null;
      if (firstPitchUtc) {
        const eventDateEt = new Date(firstPitchUtc).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        if (eventDateEt !== requestedDate) return fallback;
      }
      const opponentAbbr = teamAbbr === awayAbbr ? homeAbbr : teamAbbr === homeAbbr ? awayAbbr : null;
      return {
        gameId: awayAbbr && homeAbbr ? buildGameId(requestedDate, awayAbbr, homeAbbr) : null,
        teamAbbr,
        opponentAbbr,
        side,
        firstPitchUtc,
        lineupStatus,
      };
    }
  }
  return fallback;
}

/** Parse one individual team page. Exported for deterministic fixture tests. */
export function parseStartingNineTeamPageHtml(
  html: string,
  requestedDate: string,
  sourceUrl: string,
  observedTsUtc: string,
): StartingNineTeamPage {
  const slug = sourceUrl.match(/\/lineups\/([^/]+)\/?(?:\?|$)/i)?.[1]?.toLowerCase() ?? "";
  const expectedTeamAbbr = STARTING_NINE_TEAM_SLUGS.get(slug) ?? null;
  const event = parseTeamPageEvent(html, requestedDate, expectedTeamAbbr);
  const notes: string[] = [];
  const starterSectionStart = html.search(/>\s*Starting Pitcher\s*</i);
  const starterSectionEnd = starterSectionStart >= 0
    ? html.indexOf("DFS Projections", starterSectionStart)
    : -1;
  const starterSection = starterSectionStart >= 0
    ? html.slice(starterSectionStart, starterSectionEnd > starterSectionStart ? starterSectionEnd : starterSectionStart + 4000)
    : "";
  const starterIdRaw = starterSection.match(/\/people\/(\d+)\/headshot/i)?.[1];
  const starterNameRaw = starterSection.match(/<a\s+href="\/players\/[^"]+"[^>]*>([^<]+)<\/a>/i)?.[1];
  const startingPitcherId = starterIdRaw ? Number(starterIdRaw) : null;
  const startingPitcherName = starterNameRaw ? stripHtml(starterNameRaw) : null;
  if (!startingPitcherId || !startingPitcherName) notes.push("STARTING_PITCHER_MISSING");

  const opposingStart = html.search(/Opposing Pitcher:/i);
  const opposingEnd = opposingStart >= 0 ? html.indexOf("Batter Splits", opposingStart) : -1;
  const opposingHtml = opposingStart >= 0
    ? html.slice(opposingStart, opposingEnd > opposingStart ? opposingEnd : opposingStart + 5000)
    : "";
  const opposingText = stripHtml(opposingHtml);
  const opposingPitcherNameRaw = opposingHtml.match(/Opposing Pitcher:\s*<a[^>]*>([^<]+)<\/a>/i)?.[1];
  const splitMatch = opposingText.match(
    /vs LHB\s+([.\d-]+)\s+([.\d-]+)\s+(\d+|-)\s+(\d+|-)\s+vs RHB\s+([.\d-]+)\s+([.\d-]+)\s+(\d+|-)\s+(\d+|-)/i,
  );
  const seasonMatch = opposingText.match(
    /SEASON:\s*([\d.]+)\s+IP\s+([\d.]+)\s+ERA\s+([\d.]+)\s+WHIP\s+(\d+)\s+SO/i,
  );
  const batterSplitHeader = html.match(/Batter Splits[\s\S]{0,1200}?vs\s+(LHP|RHP)\s*\(OPS\)/i)?.[1]?.toUpperCase() ?? null;
  const stripped = stripHtml(html);
  const parkMatch = stripped.match(/Park Factors\s*\(100\s*=\s*Avg\)\s*Runs:\s*(\d+)\s*HR\s*\(LHB\):\s*(\d+)\s*HR\s*\(RHB\):\s*(\d+)/i);
  const umpireMatch = stripped.match(/Umpire:\s*([^:]+?)\s+K Rate:\s*([\d.]+|-)%?\s+BB Rate:\s*([\d.]+|-)%?\s+Runs\/Game:\s*([\d.]+|-)/i);

  if (!event.gameId || !event.teamAbbr || !event.opponentAbbr) notes.push("GAME_IDENTITY_MISMATCH");
  if (!opposingPitcherNameRaw) notes.push("OPPOSING_PITCHER_STATS_MISSING");

  return {
    date: requestedDate,
    game_id: event.gameId,
    team_abbr: event.teamAbbr,
    opponent_abbr: event.opponentAbbr,
    team_side: event.side,
    scheduled_first_pitch_utc: event.firstPitchUtc,
    lineup_status: event.lineupStatus,
    starting_pitcher_id: startingPitcherId,
    starting_pitcher_name: startingPitcherName,
    starting_pitcher_hand: null,
    starting_pitcher_identity_status: startingPitcherId && startingPitcherName ? "UNVERIFIED" : "MISSING",
    opposing_pitcher_id: null,
    opposing_pitcher_name: opposingPitcherNameRaw ? stripHtml(opposingPitcherNameRaw) : null,
    opposing_pitcher_hand: batterSplitHeader === "LHP" ? "L" : batterSplitHeader === "RHP" ? "R" : null,
    opposing_pitcher_ip: parseOptionalNumber(seasonMatch?.[1]),
    opposing_pitcher_era: parseOptionalNumber(seasonMatch?.[2]),
    opposing_pitcher_whip: parseOptionalNumber(seasonMatch?.[3]),
    opposing_pitcher_so: parseOptionalNumber(seasonMatch?.[4]),
    opposing_pitcher_vs_lhb: splitMatch ? {
      avg: parseOptionalNumber(splitMatch[1]), ops: parseOptionalNumber(splitMatch[2]),
      hr: parseOptionalNumber(splitMatch[3]), k: parseOptionalNumber(splitMatch[4]),
    } : emptySplitLine(),
    opposing_pitcher_vs_rhb: splitMatch ? {
      avg: parseOptionalNumber(splitMatch[5]), ops: parseOptionalNumber(splitMatch[6]),
      hr: parseOptionalNumber(splitMatch[7]), k: parseOptionalNumber(splitMatch[8]),
    } : emptySplitLine(),
    park_runs_index: parseOptionalNumber(parkMatch?.[1]),
    park_hr_lhb_index: parseOptionalNumber(parkMatch?.[2]),
    park_hr_rhb_index: parseOptionalNumber(parkMatch?.[3]),
    umpire: umpireMatch?.[1] ? umpireMatch[1].trim() : null,
    umpire_k_rate: parseOptionalNumber(umpireMatch?.[2]),
    umpire_bb_rate: parseOptionalNumber(umpireMatch?.[3]),
    umpire_runs_per_game: parseOptionalNumber(umpireMatch?.[4]),
    observed_ts_utc: observedTsUtc,
    source_url: sourceUrl,
    source_status: notes.includes("GAME_IDENTITY_MISMATCH")
      ? "REJECTED"
      : notes.length > 0 ? "PARTIAL" : "PARSED",
    source_notes: notes,
    active_input: "NO",
    mapping_status: "DISPLAY_ONLY_NOT_PROJECTION_INPUT",
  };
}

async function fetchStartingNineTeamPages(
  html: string,
  date: string,
): Promise<{ pages: StartingNineTeamPage[]; requested: number; errors: string[] }> {
  const links = [...parseTeamPageLinks(html).entries()];
  const pages: StartingNineTeamPage[] = [];
  const rawByUrl = new Map<string, string>();
  const errors: string[] = [];
  const concurrency = 6;
  for (let index = 0; index < links.length; index += concurrency) {
    const batch = links.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async ([expectedTeam, url]) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const observedTs = new Date().toISOString();
        const rawHtml = await response.text();
        rawByUrl.set(url, rawHtml);
        const page = parseStartingNineTeamPageHtml(rawHtml, date, url, observedTs);
        if (page.team_abbr !== expectedTeam) {
          page.source_status = "REJECTED";
          page.source_notes.push(`EXPECTED_TEAM_${expectedTeam}_GOT_${page.team_abbr ?? "NONE"}`);
        }
        return page;
      } catch (error: unknown) {
        errors.push(`${expectedTeam}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    }));
    pages.push(...results.filter((page): page is StartingNineTeamPage => page !== null));
  }

  const ids = [...new Set(pages.map((page) => page.starting_pitcher_id).filter((id): id is number => id !== null))];
  if (ids.length > 0) {
    try {
      const response = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(",")}`, {
        headers: { "User-Agent": "FrostlinePipeline/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as {
        people?: Array<{ id?: number; fullName?: string; pitchHand?: { code?: string }; primaryPosition?: { type?: string } }>;
      };
      const people = new Map((payload.people ?? []).map((person) => [person.id, person]));
      for (const page of pages) {
        if (!page.starting_pitcher_id || !page.starting_pitcher_name) continue;
        const person = people.get(page.starting_pitcher_id);
        const nameMatches = normalizePersonName(person?.fullName) === normalizePersonName(page.starting_pitcher_name);
        if (person && nameMatches && person.primaryPosition?.type === "Pitcher" && person.pitchHand?.code) {
          page.starting_pitcher_hand = person.pitchHand.code;
          page.starting_pitcher_identity_status = "MLB_ID_VERIFIED";
        } else {
          page.source_status = page.source_status === "REJECTED" ? "REJECTED" : "PARTIAL";
          page.source_notes.push("MLB_IDENTITY_VERIFICATION_FAILED");
        }
      }
    } catch (error: unknown) {
      errors.push(`MLB identity verification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const byGameAndTeam = new Map(
    pages.filter((page) => page.game_id && page.team_abbr).map((page) => [`${page.game_id}|${page.team_abbr}`, page]),
  );
  for (const page of pages) {
    if (page.game_id && page.opponent_abbr && page.opposing_pitcher_name) {
      const opponent = byGameAndTeam.get(`${page.game_id}|${page.opponent_abbr}`);
      if (opponent?.starting_pitcher_id
        && normalizePersonName(opponent.starting_pitcher_name) === normalizePersonName(page.opposing_pitcher_name)) {
        page.opposing_pitcher_id = opponent.starting_pitcher_id;
      }
    }
    const rawHtml = rawByUrl.get(page.source_url);
    page.source_snapshot = rawHtml === undefined
      ? null
      : buildStartingNineTeamPageSourceSnapshot(page, rawHtml);
  }
  return { pages, requested: links.length, errors };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchStartingNine(
  date: string,
  scheduleGames: readonly ScheduleGameData[] = [],
): Promise<StartingNineResult> {
  logger.info({ date }, "MODULE_04c: Fetching starting lineups from mlbstartingnine.com");

  const result: StartingNineResult = {
    status: "success",
    date,
    games: [],
    games_parsed: 0,
    games_matched: 0,
    errors: [],
    team_pages: [],
    team_pages_requested: 0,
    team_pages_parsed: 0,
    team_page_status: "failure",
    team_page_errors: [],
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
    const sourceBaseId = awayAbbr && homeAbbr ? buildGameId(date, awayAbbr, homeAbbr) : null;
    const gameId = sourceBaseId
      ? resolveStartingNineGameId(sourceBaseId, ev.scheduledFirstPitchUtc, scheduleGames)
      : null;
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
      scheduled_first_pitch_utc: ev.scheduledFirstPitchUtc,
      lineup_status:  lineupStatus,
      away_lineup_status: ev.awayOfficial ? "official" : "projected",
      home_lineup_status: ev.homeOfficial ? "official" : "projected",
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

  // Individual team pages carry the named starter and descriptive matchup
  // tables that the slate page omits. Failures here do not invalidate the
  // already-parsed lineups/park factors; consumers must inspect the separate
  // team_page_status and per-row source_status fields.
  const teamPageResult = await fetchStartingNineTeamPages(html, date);
  result.team_pages = teamPageResult.pages;
  result.team_pages_requested = teamPageResult.requested;
  result.team_pages_parsed = teamPageResult.pages.filter((page) => page.source_status !== "REJECTED").length;
  result.team_page_errors = teamPageResult.errors;
  result.team_page_status = result.team_pages_parsed === result.team_pages_requested && result.team_pages_requested > 0
    ? "success"
    : result.team_pages_parsed > 0 ? "partial" : "failure";

  logger.info(
    {
      parsed: result.games_parsed,
      matched: result.games_matched,
      status: result.status,
      team_pages_requested: result.team_pages_requested,
      team_pages_parsed: result.team_pages_parsed,
      team_page_status: result.team_page_status,
    },
    "MODULE_04c: Starting Nine fetch complete",
  );
  return result;
}

/**
 * Fill only genuinely unresolved MLB probable-pitcher slots from verified
 * Starting Nine team pages. A valid MLB schedule pitcher always wins. A
 * doubleheader is withheld because the team page exposes only date+teams.
 */
export function applyStartingNineStarterFallbacks(
  manifest: import("./module01_mlbStatsApi.js").GameScheduleResult,
  result: StartingNineResult | null,
): { manifest: import("./module01_mlbStatsApi.js").GameScheduleResult; applied: StartingNineStarterFallback[]; warnings: string[] } {
  if (!result || result.team_pages.length === 0) return { manifest, applied: [], warnings: [] };
  const warnings: string[] = [];
  const applied: StartingNineStarterFallback[] = [];
  const gamesByBase = new Map<string, typeof manifest.games>();
  for (const game of manifest.games) {
    const base = baseGameId(game.legacy_game_id);
    const games = gamesByBase.get(base) ?? [];
    games.push(game);
    gamesByBase.set(base, games);
  }
  const pageByGameTeam = new Map(
    result.team_pages
      .filter((page) => page.game_id && page.team_abbr)
      .map((page) => [`${page.game_id}|${page.team_abbr}`, page]),
  );

  const games = manifest.games.map((game) => {
    const base = baseGameId(game.legacy_game_id);
    if ((gamesByBase.get(base)?.length ?? 0) !== 1) {
      if (!game.awayProbablePitcher.id || !game.homeProbablePitcher.id) {
        warnings.push(`${game.legacy_game_id}: Starting Nine fallback withheld for ambiguous doubleheader identity`);
      }
      return game;
    }

    const resolveSide = (
      side: "away" | "home",
      current: typeof game.awayProbablePitcher,
      teamAbbr: string,
      opponentAbbr: string,
    ): typeof game.awayProbablePitcher => {
      const page = pageByGameTeam.get(`${base}|${teamAbbr}`);
      const validPage = page
        && page.source_status !== "REJECTED"
        && page.opponent_abbr === opponentAbbr
        && page.team_side === side
        && page.starting_pitcher_identity_status === "MLB_ID_VERIFIED"
        && page.starting_pitcher_id
        && page.starting_pitcher_name
        && page.starting_pitcher_hand
        ? page
        : null;
      if (current.id && current.fullName) {
        if (validPage && current.id !== validPage.starting_pitcher_id) {
          warnings.push(
            `${game.legacy_game_id} ${side}: verified Starting Nine starter `
            + `${validPage.starting_pitcher_name} (${validPage.starting_pitcher_id}) conflicts with `
            + `MLB probable ${current.fullName} (${current.id}); MLB retained`,
          );
        }
        return current;
      }
      if (!validPage) return current;
      const pagePitcherId = validPage.starting_pitcher_id!;
      const pagePitcherName = validPage.starting_pitcher_name!;
      const pagePitcherHand = validPage.starting_pitcher_hand!;
      if (current.id && current.id !== pagePitcherId) {
        warnings.push(`${game.legacy_game_id} ${side}: partial MLB identity conflicts with Starting Nine; fallback withheld`);
        return current;
      }
      if (current.fullName
        && normalizePersonName(current.fullName) !== normalizePersonName(pagePitcherName)) {
        warnings.push(`${game.legacy_game_id} ${side}: partial MLB name conflicts with Starting Nine; fallback withheld`);
        return current;
      }
      applied.push({
        game_id: game.legacy_game_id,
        team_abbr: teamAbbr,
        team_side: side,
        pitcher_id: pagePitcherId,
        pitcher_name: pagePitcherName,
        pitcher_hand: pagePitcherHand,
        source_url: validPage.source_url,
        observed_ts_utc: validPage.observed_ts_utc,
      });
      return {
        id: pagePitcherId,
        fullName: pagePitcherName,
        hand: pagePitcherHand,
        source: "MLB_STARTING_NINE_TEAM_PAGE",
        sourceObservedTs: validPage.observed_ts_utc,
        sourceUrl: validPage.source_url,
      };
    };

    const away = game.awayTeam.abbreviation;
    const home = game.homeTeam.abbreviation;
    return {
      ...game,
      awayProbablePitcher: resolveSide("away", game.awayProbablePitcher, away, home),
      homeProbablePitcher: resolveSide("home", game.homeProbablePitcher, home, away),
    };
  });
  return { manifest: { ...manifest, games }, applied, warnings };
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
    if (candidates?.includes(g.game_id)) {
      map.set(g.game_id, g);
    } else if (candidates && candidates.length === 1) {
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
