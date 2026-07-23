/**
 * Module 04e: Plate Umpire Assignments
 * Fetches the boxscore for each of today's games and extracts the Home Plate
 * umpire. Assignments are typically posted around noon ET — morning runs will
 * legitimately return few or no umps; afternoon re-runs fill them in.
 *
 * Output: Map<legacy_game_id, plate_ump_full_name>
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CONCURRENCY = 5;

export interface UmpireResult {
  status: "success" | "partial" | "failure";
  date: string;
  /** legacy_game_id → Home Plate umpire full name */
  plate_umps: Map<string, string>;
  assigned: number;
  total_games: number;
  errors: string[];
}

interface BoxscoreOfficial {
  official?: { id?: number; fullName?: string };
  officialType?: string;
}

async function fetchPlateUmp(gamePk: number): Promise<string | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const json = await res.json() as { officials?: BoxscoreOfficial[] };
    const plate = (json.officials ?? []).find((o) => o.officialType === "Home Plate");
    return plate?.official?.fullName ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPlateUmpires(manifest: GameScheduleResult): Promise<UmpireResult> {
  logger.info({ games: manifest.total_games }, "MODULE_04e: Fetching plate umpire assignments");

  const result: UmpireResult = {
    status: "success",
    date: manifest.date,
    plate_umps: new Map(),
    assigned: 0,
    total_games: manifest.total_games,
    errors: [],
  };

  const games = manifest.games;
  for (let i = 0; i < games.length; i += CONCURRENCY) {
    const batch = games.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((g) => fetchPlateUmp(g.gamePk)));

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!;
      const g = batch[j]!;
      if (s.status === "fulfilled" && s.value) {
        result.plate_umps.set(g.legacy_game_id, s.value);
        result.assigned++;
      } else if (s.status === "rejected") {
        result.errors.push(`game ${g.gamePk}: ${String(s.reason)}`);
      }
      // fulfilled-but-null = not yet assigned; not an error
    }
  }

  if (result.errors.length > 0 && result.assigned === 0) {
    result.status = "failure";
  } else if (result.errors.length > 0) {
    result.status = "partial";
  }

  logger.info(
    { assigned: result.assigned, total: result.total_games, errors: result.errors.length },
    "MODULE_04e: Plate umpires complete (unassigned games are normal before ~noon ET)",
  );
  return result;
}
