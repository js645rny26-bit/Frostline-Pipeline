/**
 * Module 02: Statcast Pitcher Workload
 * Fetches recent pitcher usage data from Baseball Savant.
 */

import { logger } from "../../lib/logger.js";

const SAVANT_CSV = "https://baseballsavant.mlb.com/statcast_search/csv";

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

async function fetchSinglePitcher(
  pitcherId: number,
  endDate: string,
  lookbackDays = 30,
): Promise<PitcherWorkloadData> {
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - lookbackDays);
  const startStr = startDate.toISOString().split("T")[0];

  try {
    const url = new URL(SAVANT_CSV);
    url.searchParams.set("pitcher_id", String(pitcherId));
    url.searchParams.set("game_date_gte", startStr);
    url.searchParams.set("game_date_lte", endDate);
    url.searchParams.set("type", "pitcher");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Statcast HTTP ${response.status}`);
    }

    const text = await response.text();
    const lines = text.trim().split("\n");

    if (lines.length < 2) {
      return {
        playerId: pitcherId,
        name: "Unknown",
        status: "no_games_in_window",
        rolling_stats: {
          l30: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
          l14: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
          season: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        },
        recent_games_count: 0,
      };
    }

    const header = lines[0].split(",");
    const pitcherIdx = header.indexOf("player_name");
    const pitchCountIdx = header.indexOf("release_speed"); // proxy for pitch count rows
    const dataRows = lines.slice(1).filter(Boolean);

    let pitcherName = "Unknown";
    if (pitcherIdx >= 0 && dataRows.length > 0) {
      const firstRow = dataRows[0].split(",");
      pitcherName = firstRow[pitcherIdx] ?? "Unknown";
    }

    // Count appearances as unique game dates
    const gameDateIdx = header.indexOf("game_date");
    const gameDates = new Set<string>();
    for (const row of dataRows) {
      const cols = row.split(",");
      if (gameDateIdx >= 0 && cols[gameDateIdx]) {
        gameDates.add(cols[gameDateIdx]);
      }
    }

    const appearances = gameDates.size || 1;
    const totalPitches = dataRows.length; // each row = one pitch in Statcast CSV

    return {
      playerId: pitcherId,
      name: pitcherName,
      status: "active",
      rolling_stats: {
        l30: {
          appearances,
          total_pitch_count: totalPitches,
          total_innings: Math.round((totalPitches / 15) * 10) / 10, // rough estimate
          avg_pitches_per_appearance: appearances > 0 ? Math.round(totalPitches / appearances) : 0,
        },
        l14: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        season: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
      },
      recent_games_count: dataRows.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      playerId: pitcherId,
      name: "Unknown",
      status: "fetch_error",
      rolling_stats: {
        l30: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
        l14: { appearances: 0, total_pitch_count: 0, total_innings: 0, avg_pitches_per_appearance: 0 },
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
      retrieval_source: "statcast",
      data_through_date: endDate,
      pitchers: [],
      status: "no_pitchers",
    };
  }

  const endDateObj = new Date(endDate);
  endDateObj.setDate(endDateObj.getDate() - 1);
  const dataThroughDate = endDateObj.toISOString().split("T")[0];

  // Fetch all pitchers concurrently (with a concurrency cap)
  const CONCURRENCY = 5;
  const results: PitcherWorkloadData[] = [];

  for (let i = 0; i < pitcherIds.length; i += CONCURRENCY) {
    const batch = pitcherIds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((id) => fetchSinglePitcher(id, endDate))
    );
    results.push(...batchResults);
  }

  logger.info({ fetched: results.length }, "MODULE_02: Workload fetched");

  return {
    retrieval_timestamp_utc: new Date().toISOString(),
    retrieval_source: "statcast",
    data_through_date: dataThroughDate,
    pitchers: results,
    status: results.length > 0 ? "success" : "no_data",
  };
}
