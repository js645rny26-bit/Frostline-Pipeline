/**
 * Module 02b: Pitcher Season Stats
 * Batched fetch of season pitching stats + sabermetrics for any set of
 * pitcher IDs (starters and relievers) via the MLB Stats API people endpoint:
 *   /people?personIds=1,2,...&hydrate=stats(group=[pitching],type=[season,sabermetrics],season=YYYY)
 *
 * One request covers ~40 pitchers, so a full slate (30 starters + 240
 * relievers) costs ~7 requests total.
 *
 * Output: Map<pitcher_id, PitcherSeasonStats> — era, fip, k_pct, whip,
 * hr_per_9, throwing hand (also used for platoon advantage).
 */

import { logger } from "../../lib/logger.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CHUNK_SIZE = 40;

export interface PitcherSeasonStats {
  pitcher_id: number;
  name: string;
  hand: string | null;        // "L" | "R"
  era: number | null;
  fip: number | null;
  k_pct: number | null;       // 0–1, strikeOuts / battersFaced
  bb_pct: number | null;      // 0–1, baseOnBalls / battersFaced
  whip: number | null;
  hr_per_9: number | null;
  innings_pitched: string | null;
}

export interface PitcherSeasonStatsResult {
  status: "success" | "partial" | "failure";
  season: string;
  stats: Map<number, PitcherSeasonStats>;
  fetched: number;
  errors: string[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface PersonStatSplit {
  stat?: Record<string, unknown>;
}

interface PersonStats {
  type?: { displayName?: string };
  splits?: PersonStatSplit[];
}

interface Person {
  id?: number;
  fullName?: string;
  pitchHand?: { code?: string };
  stats?: PersonStats[];
}

async function fetchChunk(ids: number[], season: string): Promise<Person[]> {
  const hydrate = `stats(group=[pitching],type=[season,sabermetrics],season=${season})`;
  const url = `${MLB_API}/people?personIds=${ids.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const json = await res.json() as { people?: Person[] };
    return json.people ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function parsePerson(p: Person): PitcherSeasonStats | null {
  if (!p.id) return null;

  let season: Record<string, unknown> = {};
  let saber:  Record<string, unknown> = {};
  for (const s of p.stats ?? []) {
    const st = s.splits?.[0]?.stat;
    if (!st) continue;
    if (s.type?.displayName === "season")       season = st;
    if (s.type?.displayName === "sabermetrics") saber  = st;
  }

  const so = num(season.strikeOuts);
  const bb = num(season.baseOnBalls);
  const bf = num(season.battersFaced);

  const kPct = so !== null && bf !== null && bf > 0
    ? parseFloat((so / bf).toFixed(3))
    : null;
  const bbPct = bb !== null && bf !== null && bf > 0
    ? parseFloat((bb / bf).toFixed(3))
    : null;

  const fipRaw = num(saber.fip);

  return {
    pitcher_id:      p.id,
    name:            p.fullName ?? "Unknown",
    hand:            p.pitchHand?.code ?? null,
    era:             num(season.era),
    fip:             fipRaw !== null ? parseFloat(fipRaw.toFixed(2)) : null,
    k_pct:           kPct,
    bb_pct:          bbPct,
    whip:            num(season.whip),
    hr_per_9:        num(season.homeRunsPer9),
    innings_pitched: season.inningsPitched != null ? String(season.inningsPitched) : null,
  };
}

export async function fetchPitcherSeasonStats(
  pitcherIds: number[],
  season: string,
): Promise<PitcherSeasonStatsResult> {
  const unique = [...new Set(pitcherIds.filter((id) => id > 0))];
  const result: PitcherSeasonStatsResult = {
    status: "success",
    season,
    stats: new Map(),
    fetched: 0,
    errors: [],
  };
  if (unique.length === 0) return result;

  logger.info({ pitchers: unique.length }, "MODULE_02b: Fetching pitcher season stats");

  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + CHUNK_SIZE));
  }

  const settled = await Promise.allSettled(chunks.map((c) => fetchChunk(c, season)));
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    if (s.status === "fulfilled") {
      for (const person of s.value) {
        const parsed = parsePerson(person);
        if (parsed) {
          result.stats.set(parsed.pitcher_id, parsed);
          result.fetched++;
        }
      }
    } else {
      result.errors.push(`chunk ${i}: ${String(s.reason)}`);
    }
  }

  if (result.fetched === 0 && result.errors.length > 0) {
    result.status = "failure";
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { fetched: result.fetched, requested: unique.length, errors: result.errors.length },
    "MODULE_02b: Pitcher season stats complete",
  );
  return result;
}
