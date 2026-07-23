/**
 * Module 04b: Bullpen Usage
 * Fetches last-7-day relief pitcher workload for each team in today's slate
 * using the MLB Stats API.
 *
 * Per reliever: innings pitched, games appeared, days of rest since last outing.
 * No external API key required — MLB Stats API is public.
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

// Max concurrent game-log fetches to avoid hammering the MLB API
const CONCURRENCY = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelieverStat {
  player_id: number;
  full_name: string;
  team_abbr: string;
  innings_last_7: number;    // IP as decimal (1.667 = 1⅔)
  games_last_7: number;
  days_rest: number;         // days since last appearance (capped at 7 if no appearance)
  last_outing_date: string | null;
  role: string;              // derived label
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse MLB "1.2" innings format → decimal (1.667) */
function parseIP(raw: string | number | undefined | null): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw);
  const [whole, thirds] = s.split(".");
  const w = parseInt(whole ?? "0", 10);
  const t = parseInt(thirds ?? "0", 10);
  return w + t / 3;
}

/** Clamp a date string to midnight UTC */
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Days between two YYYY-MM-DD strings */
function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Role label derived from innings-per-game and usage pattern */
function deriveRole(inningsPerGame: number, games7: number): string {
  if (games7 === 0) return "RESTED";
  if (games7 >= 5) return "HIGH_WORKLOAD";
  if (inningsPerGame >= 1.5) return "LONG_RELIEF";
  if (inningsPerGame <= 0.4) return "OPENER_SPECIALIST";
  return "RELIEF";
}

/** Simple fetch with timeout */
async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `tasks` in batches of `concurrency` */
async function batchedAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map((t) => t());
    const settled = await Promise.allSettled(batch);
    results.push(...settled);
  }
  return results;
}

// ─── MLB API calls ────────────────────────────────────────────────────────────

interface RosterPlayer {
  person: { id: number; fullName: string };
  position: { code: string; abbreviation: string; type: string };
}

async function fetchActiveRoster(teamId: number, season: string): Promise<RosterPlayer[]> {
  const url = `${MLB_API_BASE}/teams/${teamId}/roster?rosterType=active&season=${season}`;
  const data = await fetchJson<{ roster: RosterPlayer[] }>(url);
  return data.roster ?? [];
}

interface GameLogEntry {
  date: string;
  stat: {
    inningsPitched: string;
    gamesPlayed: number;
    gamesStarted: number;
  };
}

async function fetchPitchingGameLog(playerId: number, season: string): Promise<GameLogEntry[]> {
  const url = `${MLB_API_BASE}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const data = await fetchJson<{ stats: Array<{ splits: GameLogEntry[] }> }>(url);
  return data.stats?.[0]?.splits ?? [];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchBullpenUsage(
  date: string,          // YYYY-MM-DD — the run date
  teamIds: number[],     // MLB numeric team IDs for today's slate
): Promise<BullpenResult> {
  const season = date.slice(0, 4);
  const windowStart = toDateOnly(
    new Date(new Date(date + "T00:00:00Z").getTime() - 7 * 86_400_000).toISOString(),
  );

  logger.info({ date, teams: teamIds.length, season }, "MODULE_04b: Fetching bullpen usage");

  const result: BullpenResult = {
    status: "success",
    date,
    relievers: [],
    teams_fetched: 0,
    teams_failed: 0,
    errors: [],
  };

  // Step 1: Fetch active rosters in parallel for all slate teams
  const rosterResults = await Promise.allSettled(
    teamIds.map((id) => fetchActiveRoster(id, season).then((r) => ({ teamId: id, roster: r }))),
  );

  // Build: reliever player IDs grouped by team
  interface RelieverEntry { teamId: number; playerId: number; fullName: string }
  const relievers: RelieverEntry[] = [];

  for (const r of rosterResults) {
    if (r.status === "rejected") {
      result.teams_failed++;
      result.errors.push(`Roster fetch failed: ${r.reason}`);
      continue;
    }
    result.teams_fetched++;
    const { teamId, roster } = r.value;
    for (const p of roster) {
      // Position type "Pitcher" covers both SP and RP.
      // We further restrict to non-starters by position code.
      // MLB codes: "SP" = starting pitcher, "RP" = relief pitcher
      if (p.position.abbreviation === "RP" || p.position.code === "RP") {
        relievers.push({ teamId, playerId: p.person.id, fullName: p.person.fullName });
      }
    }
  }

  logger.info({ relievers: relievers.length }, "MODULE_04b: Relievers identified; fetching game logs");

  if (relievers.length === 0) {
    result.status = "partial";
    result.errors.push("No relievers found across all rosters");
    return result;
  }

  // Step 2: Fetch game logs in batches
  const teamAbbrMap = buildTeamIdAbbrMap(SOURCE_MAPPINGS);

  const gameLogTasks = relievers.map((rel) => async () => {
    const log = await fetchPitchingGameLog(rel.playerId, season);

    // Filter to last 7 days
    const recent = log.filter((e) => e.date >= windowStart && e.date < date);

    const inningsTotal = recent.reduce((sum, e) => sum + parseIP(e.stat.inningsPitched), 0);
    const gamesTotal   = recent.reduce((sum, e) => sum + (e.stat.gamesPlayed ?? 0), 0);

    // Days rest: gap between last appearance and today
    const lastDate = recent.length > 0
      ? recent.reduce((latest, e) => e.date > latest ? e.date : latest, recent[0]!.date)
      : null;
    const daysRest = lastDate ? daysBetween(lastDate, date) : 7;

    const ipPerGame = gamesTotal > 0 ? inningsTotal / gamesTotal : 0;
    const role = deriveRole(ipPerGame, gamesTotal);

    const stat: RelieverStat = {
      player_id:        rel.playerId,
      full_name:        rel.fullName,
      team_abbr:        teamAbbrMap.get(rel.teamId) ?? String(rel.teamId),
      innings_last_7:   Math.round(inningsTotal * 1000) / 1000,
      games_last_7:     gamesTotal,
      days_rest:        daysRest,
      last_outing_date: lastDate,
      role,
      notes: "",
    };
    return stat;
  });

  const settled = await batchedAll(gameLogTasks, CONCURRENCY);

  for (const s of settled) {
    if (s.status === "fulfilled") {
      result.relievers.push(s.value);
    } else {
      result.errors.push(`Game log failed: ${s.reason}`);
    }
  }

  if (result.errors.length > 0 && result.relievers.length === 0) {
    result.status = "failure";
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { rows: result.relievers.length, failed: result.errors.length },
    "MODULE_04b: Bullpen usage fetch complete",
  );
  return result;
}

/**
 * Build the team-abbr lookup for `fetchBullpenUsage`.
 * Pass SOURCE_MAPPINGS from config — this avoids importing config directly
 * in this module so it stays testable.
 */
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
