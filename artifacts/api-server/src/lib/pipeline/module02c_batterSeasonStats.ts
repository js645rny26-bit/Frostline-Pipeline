/**
 * Module 02c: Batter Season Stats
 *
 * Two-step data flow:
 *
 * 1. fetchTeamRosters(teamIds, season)
 *    Calls /teams/{id}/roster for each team to build a name→playerId lookup map.
 *    The map key is a Unicode-normalized, lowercased full name so it matches the
 *    names scraped by module04c despite diacritics ("Jesús" → "jesus").
 *
 * 2. fetchBatterSeasonStats(playerIds, season)
 *    Batched /people?personIds=...&hydrate=stats(group=[hitting],type=[season])
 *    for the resolved batter IDs. Identical chunk strategy to module02b (40/request).
 *    Returns OBP, SLG, OPS, K%, BB%, and plate appearances per player.
 *
 * Consumer (module09) uses the resulting maps to compute a batting-order-weighted
 * lineup OPS factor that adjusts the team's base offensive rate projection.
 *
 * Minimum PA gate: batters with < MIN_BATTER_PA are excluded from the lineup
 * factor calculation (their slot reverts to league-average OPS). This prevents
 * partial-season injury returns or very recent call-ups from distorting the model.
 */

import { logger } from "../../lib/logger.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CHUNK_SIZE = 40;

/** Minimum plate appearances before a batter's stats are used in the lineup factor. */
export const MIN_BATTER_PA = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BatterSeasonStats {
  batter_id: number;
  name: string;
  bat_hand: string | null;        // "L" | "R" | "S"
  obp: number | null;             // on-base percentage (0–1 scale)
  slg: number | null;             // slugging percentage (0–1 scale)
  ops: number | null;             // obp + slg
  k_pct: number | null;           // strikeOuts / plateAppearances
  bb_pct: number | null;          // baseOnBalls / plateAppearances
  plate_appearances: number | null;
}

export interface BatterSeasonStatsResult {
  status: "success" | "partial" | "failure";
  season: string;
  stats: Map<number, BatterSeasonStats>;
  fetched: number;
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a player name for matching:
 *   - lowercase
 *   - strip Unicode diacritics (NFD decomposition → remove combining chars)
 *   - trim whitespace
 *
 * This allows "Jesús Luzardo" (mlbstartingnine) to match "Jesus Luzardo" (MLB API).
 */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// ─── API shape (internal) ─────────────────────────────────────────────────────

interface RosterPerson {
  id?: number;
  fullName?: string;
  batSide?: { code?: string };
}

interface RosterEntry {
  person?: RosterPerson;
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
  batSide?: { code?: string };
  stats?: PersonStats[];
}

// ─── Roster fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch active rosters for a list of MLB team IDs.
 * Returns a single Map<normalizedFullName, playerId> covering all teams.
 *
 * The map is used by module09 to resolve lineup names (from mlbstartingnine)
 * to MLB player IDs needed for the batter stats lookup.
 */
export async function fetchTeamRosters(
  teamIds: number[],
  season: string,
): Promise<Map<string, number>> {
  const uniqueIds = [...new Set(teamIds.filter((id) => id > 0))];
  if (uniqueIds.length === 0) return new Map();

  logger.info({ teams: uniqueIds.length, season }, "MODULE_02c: Fetching team rosters");

  const nameToId = new Map<string, number>();

  const settled = await Promise.allSettled(
    uniqueIds.map(async (teamId) => {
      const url = `${MLB_API}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person`;
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { roster?: RosterEntry[] };
        return json.roster ?? [];
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  let successCount = 0;
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    if (s.status === "fulfilled") {
      successCount++;
      for (const entry of s.value) {
        const p = entry.person;
        if (p?.id && p.fullName) {
          nameToId.set(normalizeForMatch(p.fullName), p.id);
        }
      }
    } else {
      logger.warn(
        { teamId: uniqueIds[i], err: String(s.reason) },
        "MODULE_02c: Roster fetch failed for team",
      );
    }
  }

  logger.info(
    { teams: successCount, players: nameToId.size },
    "MODULE_02c: Roster fetch complete",
  );
  return nameToId;
}

// ─── Batter stats fetch ───────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchChunk(ids: number[], season: string): Promise<Person[]> {
  const hydrate = `stats(group=[hitting],type=[season],season=${season})`;
  const url = `${MLB_API}/people?personIds=${ids.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const json = await res.json() as { people?: Person[] };
    return json.people ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function parsePerson(p: Person): BatterSeasonStats | null {
  if (!p.id) return null;

  let season: Record<string, unknown> = {};
  for (const s of p.stats ?? []) {
    if (s.type?.displayName === "season") {
      season = s.splits?.[0]?.stat ?? {};
      break;
    }
  }

  const pa = num(season["plateAppearances"]);
  const so = num(season["strikeOuts"]);
  const bb = num(season["baseOnBalls"]);

  const obpRaw = num(season["obp"]);
  const slgRaw = num(season["slugging"]);

  // OPS: prefer API-provided value; fall back to computed sum if available
  let opsRaw = num(season["ops"]);
  if (opsRaw === null && obpRaw !== null && slgRaw !== null) {
    opsRaw = parseFloat((obpRaw + slgRaw).toFixed(3));
  }

  const kPct =
    so !== null && pa !== null && pa >= MIN_BATTER_PA
      ? parseFloat((so / pa).toFixed(3))
      : null;
  const bbPct =
    bb !== null && pa !== null && pa >= MIN_BATTER_PA
      ? parseFloat((bb / pa).toFixed(3))
      : null;

  return {
    batter_id:        p.id,
    name:             p.fullName ?? "Unknown",
    bat_hand:         p.batSide?.code ?? null,
    obp:              obpRaw !== null ? parseFloat(obpRaw.toFixed(3)) : null,
    slg:              slgRaw !== null ? parseFloat(slgRaw.toFixed(3)) : null,
    ops:              opsRaw !== null ? parseFloat(opsRaw.toFixed(3)) : null,
    k_pct:            kPct,
    bb_pct:           bbPct,
    plate_appearances: pa,
  };
}

/**
 * Batch-fetch season hitting stats for a list of batter IDs.
 * Uses the same chunked /people endpoint strategy as module02b.
 */
export async function fetchBatterSeasonStats(
  playerIds: number[],
  season: string,
): Promise<BatterSeasonStatsResult> {
  const unique = [...new Set(playerIds.filter((id) => id > 0))];
  const result: BatterSeasonStatsResult = {
    status: "success",
    season,
    stats: new Map(),
    fetched: 0,
    errors: [],
  };
  if (unique.length === 0) return result;

  logger.info({ batters: unique.length, season }, "MODULE_02c: Fetching batter season stats");

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
          result.stats.set(parsed.batter_id, parsed);
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
    "MODULE_02c: Batter season stats complete",
  );
  return result;
}
