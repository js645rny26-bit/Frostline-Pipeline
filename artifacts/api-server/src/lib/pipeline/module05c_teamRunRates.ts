/**
 * Module 05c: Team Run Rates (Actual, Last 10 Games)
 * ONE schedule-range call to the MLB Stats API covering the trailing 15 days,
 * then groups final games by team and computes actual runs scored / allowed
 * per game over each team's last 10 completed games.
 *
 * Replaces the wRC+-estimated RS/RA in TEAM_FORM_INPUT with real numbers.
 *
 * Output: Map<team_abbr, TeamRunRate>
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const LOOKBACK_DAYS = 15;
const LAST_N = 10;

export interface TeamRunRate {
  team_abbr: string;
  games: number;            // how many finals found (≤ LAST_N)
  runs_per_game: number;
  runs_allowed_per_game: number;
}

export interface TeamRunRatesResult {
  status: "success" | "failure";
  date: string;
  rates: Map<string, TeamRunRate>;
  error?: string;
}

export interface RunRateOptions {
  /** Calendar days before `date` to include (default 15). */
  lookbackDays?: number;
  /** Most-recent finals per team to average (default 10). */
  lastN?: number;
}

// full team name (lowercase) → canonical abbr, same pattern as module05b
const FULL_NAME_TO_ABBR: Record<string, string> = {};
for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
  FULL_NAME_TO_ABBR[full_name.toLowerCase()] = canonical_abbr;
}
// MLB API drops the city for the A's ("Athletics"); alias it to the same abbr
{
  const athletics = Object.entries(FULL_NAME_TO_ABBR).find(([n]) => n.includes("athletics"));
  if (athletics) FULL_NAME_TO_ABBR["athletics"] = athletics[1];
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface ScheduleRangeGame {
  gamePk?: number;
  officialDate?: string;
  status?: { abstractGameState?: string };
  teams?: {
    away?: { score?: number; team?: { id?: number; name?: string } };
    home?: { score?: number; team?: { id?: number; name?: string } };
  };
}

export async function fetchTeamRunRates(
  date: string,
  opts: RunRateOptions = {},
): Promise<TeamRunRatesResult> {
  const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS;
  const lastNCap     = opts.lastN ?? LAST_N;
  const startDate = shiftDate(date, -lookbackDays);
  const endDate   = shiftDate(date, -1);
  const url = `${MLB_API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`;

  logger.info({ startDate, endDate, lastN: lastNCap }, "MODULE_05c: Fetching team run rates (actual)");

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res   = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`MLB API ${res.status}`);

    const json = await res.json() as { dates?: Array<{ games?: ScheduleRangeGame[] }> };

    // Collect per-team game log: [{date, scored, allowed}]
    const perTeam = new Map<string, Array<{ date: string; scored: number; allowed: number }>>();

    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.status?.abstractGameState !== "Final") continue;
        const away = g.teams?.away;
        const home = g.teams?.home;
        if (away?.score === undefined || home?.score === undefined) continue;

        const entries: Array<[string | undefined, number, number]> = [
          [away.team?.name, away.score, home.score],
          [home.team?.name, home.score, away.score],
        ];
        for (const [name, scored, allowed] of entries) {
          const abbr = name ? FULL_NAME_TO_ABBR[name.toLowerCase()] : undefined;
          if (!abbr) continue;
          const log = perTeam.get(abbr) ?? [];
          log.push({ date: g.officialDate ?? "", scored, allowed });
          perTeam.set(abbr, log);
        }
      }
    }

    const rates = new Map<string, TeamRunRate>();
    for (const [abbr, log] of perTeam) {
      log.sort((a, b) => b.date.localeCompare(a.date));   // newest first
      const lastN = log.slice(0, lastNCap);
      if (lastN.length === 0) continue;
      const rs = lastN.reduce((sum, g) => sum + g.scored, 0) / lastN.length;
      const ra = lastN.reduce((sum, g) => sum + g.allowed, 0) / lastN.length;
      rates.set(abbr, {
        team_abbr: abbr,
        games: lastN.length,
        runs_per_game: parseFloat(rs.toFixed(2)),
        runs_allowed_per_game: parseFloat(ra.toFixed(2)),
      });
    }

    logger.info({ teams: rates.size }, "MODULE_05c: Team run rates complete");
    return { status: "success", date, rates };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "MODULE_05c: Team run rates fetch failed");
    return { status: "failure", date, rates: new Map(), error: message };
  }
}
