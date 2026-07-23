/**
 * Module 04d: Starter Previous Outing
 * For each probable starting pitcher on today's slate:
 *   1. Fetch their MLB Stats API game log → find the most recent regular-season start
 *      (gamePk, date, IP, pitch count)
 *   2. Fetch Baseball Savant /gf?game_pk=X → extract pitch array → compute innings
 *      pitched per inning and derive a stress flag
 *
 * Outputs: Map<pitcherId, StarterOuting> for use in DAILY_MATCHUPS columns Z–AG.
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";

const MLB_API    = "https://statsapi.mlb.com/api/v1";
const SAVANT_GF  = "https://baseballsavant.mlb.com/gf";
const CONCURRENCY = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StarterOuting {
  pitcher_id:    number;
  pitcher_name:  string;
  game_pk:       number;
  outing_date:   string;    // YYYY-MM-DD
  ip_display:    string;    // official "x.y" format, e.g. "6.2"
  ip_decimal:    number;    // decimal, e.g. 6.667
  pitch_count:   number;
  days_rest:     number;
  stress_flag:   "NORMAL" | "KNOCKED_OUT" | "DEEP_OUTING" | "SHORT_REST" | "UNKNOWN";
  summary:       string;    // e.g. "6.2 IP | 98P | 4d rest"
}

export interface StarterOutingResult {
  status:   "success" | "partial" | "failure";
  date:     string;
  outings:  Map<number, StarterOuting>;
  fetched:  number;
  errors:   string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T12:00:00Z").getTime();
  const b = new Date(to   + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

function parseIPDisplay(ip: string | number | undefined): { display: string; decimal: number } {
  if (ip == null) return { display: "0.0", decimal: 0 };
  const s = String(ip);
  const [whole = "0", thirds = "0"] = s.split(".");
  const decimal = parseInt(whole, 10) + parseInt(thirds, 10) / 3;
  return { display: s, decimal: parseFloat(decimal.toFixed(3)) };
}

function stressFlag(
  ipDecimal: number,
  pitchCount: number,
  daysRest: number,
): StarterOuting["stress_flag"] {
  if (daysRest <= 3)                        return "SHORT_REST";
  if (ipDecimal >= 7.0)                     return "DEEP_OUTING";
  if (ipDecimal < 4.0 && pitchCount >= 70)  return "KNOCKED_OUT";
  return "NORMAL";
}

function makeSummary(outing: Omit<StarterOuting, "summary">): string {
  return `${outing.ip_display} IP | ${outing.pitch_count}P | ${outing.days_rest}d rest | ${outing.stress_flag}`;
}

// ─── Step 1: MLB Stats API game log → find last regular-season start ──────────

interface GameLogEntry {
  date:     string;
  gamePk:   number;
  ip:       string;
  pitches:  number;
}

async function fetchLastStart(pitcherId: number, beforeDate: string): Promise<GameLogEntry | null> {
  const season = beforeDate.slice(0, 4);
  const url    = `${MLB_API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res   = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`MLB API ${res.status}`);

    const json = await res.json() as {
      stats?: Array<{
        splits?: Array<{
          date?: string;
          game?: { gamePk?: number; gameType?: string };
          stat?: { inningsPitched?: string; numberOfPitches?: number; gamesStarted?: number };
        }>;
      }>;
    };

    const splits = json.stats?.[0]?.splits ?? [];

    // Filter to regular-season starts before today, sorted newest-first
    const starts = splits
      .filter((s) =>
        s.game?.gameType === "R" &&
        (s.stat?.gamesStarted ?? 0) >= 1 &&
        s.date !== undefined &&
        s.date < beforeDate,
      )
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    const last = starts[0];
    if (!last?.game?.gamePk || !last.date) return null;

    return {
      date:    last.date,
      gamePk:  last.game.gamePk,
      ip:      String(last.stat?.inningsPitched ?? "0.0"),
      pitches: last.stat?.numberOfPitches ?? 0,
    };
  } catch (err: unknown) {
    logger.debug({ pitcherId, err: err instanceof Error ? err.message : String(err) }, "MODULE_04d: game log fetch failed");
    return null;
  }
}

// ─── Step 2: Baseball Savant /gf → enrich with stress analysis ───────────────

interface SavantPitch {
  inning:               number;
  player_total_pitches: number;
  outs?:                number;
}

async function fetchSavantPitcher(
  gamePk:    number,
  pitcherId: number,
): Promise<{ pitchCount: number | null }> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res   = await fetch(`${SAVANT_GF}?game_pk=${gamePk}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Savant HTTP ${res.status}`);

    const gf = await res.json() as {
      home_pitchers?: Record<string, SavantPitch[]>;
      away_pitchers?: Record<string, SavantPitch[]>;
    };

    const key = String(pitcherId);
    const pitches: SavantPitch[] =
      gf.home_pitchers?.[key] ?? gf.away_pitchers?.[key] ?? [];

    if (pitches.length === 0) return { pitchCount: null };

    // player_total_pitches is cumulative — last entry is the total
    const lastPitch = pitches[pitches.length - 1]!;
    return { pitchCount: lastPitch.player_total_pitches };
  } catch (err: unknown) {
    logger.debug({ gamePk, pitcherId, err: err instanceof Error ? err.message : String(err) }, "MODULE_04d: Savant /gf fetch failed");
    return { pitchCount: null };
  }
}

// ─── Step 3: Assemble outing for one pitcher ──────────────────────────────────

async function resolveOuting(
  pitcherId:   number,
  pitcherName: string,
  today:       string,
): Promise<StarterOuting | null> {
  const lastStart = await fetchLastStart(pitcherId, today);
  if (!lastStart) return null;

  // Enrich with Baseball Savant (non-blocking; falls back to MLB game log pitch count)
  const { pitchCount: savantPitches } = await fetchSavantPitcher(lastStart.gamePk, pitcherId);

  const { display: ipDisplay, decimal: ipDecimal } = parseIPDisplay(lastStart.ip);
  const pitchCount = savantPitches ?? lastStart.pitches;
  const daysRest   = daysBetween(lastStart.date, today);
  const flag       = stressFlag(ipDecimal, pitchCount, daysRest);

  const outing: Omit<StarterOuting, "summary"> = {
    pitcher_id:   pitcherId,
    pitcher_name: pitcherName,
    game_pk:      lastStart.gamePk,
    outing_date:  lastStart.date,
    ip_display:   ipDisplay,
    ip_decimal:   ipDecimal,
    pitch_count:  pitchCount,
    days_rest:    daysRest,
    stress_flag:  flag,
  };

  return { ...outing, summary: makeSummary(outing) };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchStarterPrevOutings(
  manifest: GameScheduleResult,
  date: string,
): Promise<StarterOutingResult> {
  logger.info({ games: manifest.total_games }, "MODULE_04d: Fetching starter previous outings");

  // Collect unique probable starters (id → name)
  const pitchers = new Map<number, string>();
  for (const g of manifest.games) {
    const { awayProbablePitcher: away, homeProbablePitcher: home } = g;
    if (away.id) pitchers.set(away.id, away.fullName ?? "Unknown");
    if (home.id) pitchers.set(home.id, home.fullName ?? "Unknown");
  }

  const result: StarterOutingResult = {
    status:  "success",
    date,
    outings: new Map(),
    fetched: 0,
    errors:  [],
  };

  const entries = [...pitchers.entries()];

  // Batched concurrency — respect Savant rate limits
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(([id, name]) => resolveOuting(id, name, date)),
    );

    for (let j = 0; j < settled.length; j++) {
      const s    = settled[j]!;
      const [id] = batch[j]!;
      if (s.status === "fulfilled" && s.value) {
        result.outings.set(id, s.value);
        result.fetched++;
      } else {
        const reason = s.status === "rejected" ? String(s.reason) : "no last start found";
        result.errors.push(`pitcher ${id}: ${reason}`);
      }
    }
  }

  if (result.fetched === 0) {
    result.status = "failure";
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { fetched: result.fetched, total: pitchers.size, errors: result.errors.length },
    "MODULE_04d: Starter outings complete",
  );
  return result;
}
