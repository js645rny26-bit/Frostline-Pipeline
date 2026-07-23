/**
 * Module 02: Pitcher Workload
 * Fetches per-start pitch counts and innings from the MLB Stats API game log endpoint.
 * Baseball Savant's statcast_search/csv endpoint now returns only aggregated career stats
 * (one row per pitcher) and no longer serves pitch-level or date-filtered data.
 */

import { logger } from "../../lib/logger.js";

const MLB_API = "https://statsapi.mlb.com/api/v1";

export interface PitcherRollingStats {
  appearances: number;
  total_pitch_count: number;
  total_innings: number;
  avg_pitches_per_appearance: number;
}

export interface PitcherWorkloadData {
  playerId: number;
  name: string;
  status: string;
  rolling_stats: {
    l30: PitcherRollingStats;
    l14: PitcherRollingStats;
    season: PitcherRollingStats;
  };
  recent_games_count: number;
  error?: string;
}

export interface WorkloadResult {
  retrieval_timestamp_utc: string;
  retrieval_source: string;
  data_through_date: string;
  pitchers: PitcherWorkloadData[];
  status: string;
}

interface GameLogSplit {
  date: string;
  stat: {
    inningsPitched?: string | number;
    numberOfPitches?: number;
    battersFaced?: number;
  };
}

function parseInnings(ip: string | number | undefined): number {
  if (ip == null) return 0;
  const s = String(ip);
  // "6.2" = 6 full innings + 2 outs = 6.667 innings
  const parts = s.split(".");
  const full = parseInt(parts[0] ?? "0", 10);
  const thirds = parseInt(parts[1] ?? "0", 10);
  return full + thirds / 3;
}

function rollingStats(splits: GameLogSplit[], afterDate: string, beforeOrOnDate: string): PitcherRollingStats {
  const filtered = splits.filter((s) => s.date > afterDate && s.date <= beforeOrOnDate);
  if (filtered.length === 0) {
    return { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 };
  }
  const totalPitches = filtered.reduce((acc, s) => acc + (s.stat.numberOfPitches ?? 0), 0);
  const totalInnings = filtered.reduce((acc, s) => acc + parseInnings(s.stat.inningsPitched), 0);
  const appearances = filtered.length;
  return {
    appearances,
    total_pitch_count: totalPitches,
    total_innings: parseFloat(totalInnings.toFixed(1)),
    avg_pitches_per_appearance: appearances > 0 ? Math.round(totalPitches / appearances) : 0,
  };
}

async function fetchSinglePitcher(pitcherId: number, endDate: string): Promise<PitcherWorkloadData> {
  const season = endDate.slice(0, 4);
  const url = `${MLB_API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);

    const json = (await response.json()) as { stats?: Array<{ splits?: GameLogSplit[] }> };
    const splits: GameLogSplit[] = json.stats?.[0]?.splits ?? [];

    if (splits.length === 0) {
      return {
        playerId: pitcherId,
        name: "Unknown",
        status: "no_games_in_window",
        rolling_stats: {
          l30:    { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
          l14:    { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
          season: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        },
        recent_games_count: 0,
      };
    }

    // Date arithmetic — endDate is the game date (today); look back from the day before
    const through = new Date(endDate);
    through.setDate(through.getDate() - 1);
    const throughStr = through.toISOString().split("T")[0]!;

    const d30 = new Date(through); d30.setDate(d30.getDate() - 30);
    const d14 = new Date(through); d14.setDate(d14.getDate() - 14);
    const d60 = new Date(through); d60.setDate(d60.getDate() - 60);
    const seasonStart = `${season}-01-01`;

    const l30    = rollingStats(splits, d30.toISOString().split("T")[0]!, throughStr);
    const l14    = rollingStats(splits, d14.toISOString().split("T")[0]!, throughStr);
    const seasonStats = rollingStats(splits, seasonStart, throughStr);
    const l60    = rollingStats(splits, d60.toISOString().split("T")[0]!, throughStr);

    // Determine status:
    // "active"             — pitched in last 30 days
    // "active_wide_window" — no starts in 30 days but did pitch in 60 days (IL return signal)
    // "no_games_in_window" — nothing in 60 days (debut / off-season / extended absence)
    let status: string;
    if (l30.appearances > 0) {
      status = "active";
    } else if (l60.appearances > 0) {
      status = "active_wide_window";
    } else {
      status = "no_games_in_window";
    }

    return {
      playerId: pitcherId,
      name: "Unknown", // name sourced from MLB API in module01, not needed here
      status,
      rolling_stats: { l30, l14, season: seasonStats },
      recent_games_count: l30.appearances,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      playerId: pitcherId,
      name: "Unknown",
      status: "fetch_error",
      rolling_stats: {
        l30:    { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        l14:    { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        season: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
      },
      recent_games_count: 0,
      error: message,
    };
  }
}

export async function fetchPitcherWorkload(
  pitcherIds: number[],
  endDate: string,
): Promise<WorkloadResult> {
  logger.info({ count: pitcherIds.length }, "MODULE_02: Fetching pitcher workload");

  if (pitcherIds.length === 0) {
    return {
      retrieval_timestamp_utc: new Date().toISOString(),
      retrieval_source: "mlb_stats_api",
      data_through_date: endDate,
      pitchers: [],
      status: "no_pitchers",
    };
  }

  const throughDate = new Date(endDate);
  throughDate.setDate(throughDate.getDate() - 1);
  const dataThroughDate = throughDate.toISOString().split("T")[0]!;

  const CONCURRENCY = 8;
  const results: PitcherWorkloadData[] = [];

  for (let i = 0; i < pitcherIds.length; i += CONCURRENCY) {
    const batch = pitcherIds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((id) => fetchSinglePitcher(id, endDate)));
    results.push(...batchResults);
  }

  logger.info({ fetched: results.length }, "MODULE_02: Workload fetched");

  return {
    retrieval_timestamp_utc: new Date().toISOString(),
    retrieval_source: "mlb_stats_api",
    data_through_date: dataThroughDate,
    pitchers: results,
    status: results.length > 0 ? "success" : "no_data",
  };
}
