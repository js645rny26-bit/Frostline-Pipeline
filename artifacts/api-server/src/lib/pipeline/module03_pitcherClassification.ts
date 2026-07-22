/**
 * Module 03: Pitcher Role Classification
 * Determines starter role: CONVENTIONAL_STARTER, OPENER, BULK, UNRESOLVED, etc.
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";
import type { WorkloadResult } from "./module02_statcast.js";

export interface PitcherClassificationData {
  player_id: number | null;
  name: string | null;
  hand: string | null;
  role: string;
  role_confidence: string;
  workload_flags: string[];
  expected_pitches: number | null;
  expected_innings: number | null;
  reasoning: string;
}

export interface ClassifiedGame {
  gamePk: number;
  legacy_game_id: string;
  away_pitcher: PitcherClassificationData;
  home_pitcher: PitcherClassificationData;
}

export interface ClassificationResult {
  classification_timestamp_utc: string;
  games: ClassifiedGame[];
  status: string;
}

function classifySinglePitcher(
  pitcherId: number | null,
  pitcherName: string | null,
  hand: string | null,
  workloadData: { status?: string; rolling_stats?: { l30?: { appearances?: number; avg_pitches_per_appearance?: number } }; recent_games_count?: number } | undefined,
): PitcherClassificationData {
  if (!pitcherId || !pitcherName) {
    return {
      player_id: pitcherId,
      name: pitcherName,
      hand,
      role: "UNRESOLVED",
      role_confidence: "low",
      workload_flags: [],
      expected_pitches: null,
      expected_innings: null,
      reasoning: "No probable pitcher listed",
    };
  }

  if (!workloadData || workloadData.status === "fetch_error" || workloadData.status === "no_games_in_window") {
    // A pitcher listed as probable IS going to start regardless of workload data availability.
    // Apply a seasonal-baseline classification: assume CONVENTIONAL_STARTER with moderate confidence
    // and standard expected values, rather than leaving them UNRESOLVED.
    const flags: string[] = [];
    if (workloadData?.status === "no_games_in_window") {
      flags.push("RETURNING_FROM_IL");
    } else if (workloadData?.status === "fetch_error") {
      flags.push("STATCAST_UNAVAILABLE");
    } else {
      flags.push("NO_WORKLOAD_DATA");
    }
    return {
      player_id: pitcherId,
      name: pitcherName,
      hand,
      role: "CONVENTIONAL_STARTER",
      role_confidence: "moderate",
      workload_flags: flags,
      expected_pitches: 85,
      expected_innings: 5.5,
      reasoning: workloadData?.status === "no_games_in_window"
        ? "No data in 60-day window; probable starter classified using seasonal baseline (returning from IL)"
        : "No Statcast workload data; probable starter classified using seasonal baseline",
    };
  }

  const l30 = workloadData.rolling_stats?.l30;
  const avgPitches = l30?.avg_pitches_per_appearance ?? 0;
  const appearances = l30?.appearances ?? 0;
  const recentGames = workloadData.recent_games_count ?? 0;

  const flags: string[] = [];
  let role = "CONVENTIONAL_STARTER";
  let confidence = "high";
  let reasoning = "Probable pitcher with recent workload data";

  // Opener heuristic: very low avg pitch count suggests opener role
  if (avgPitches > 0 && avgPitches < 40) {
    role = "OPENER";
    confidence = "medium";
    reasoning = `Low avg pitch count (${avgPitches}) suggests opener role`;
  }
  // Bulk heuristic: moderate pitch count
  else if (avgPitches >= 40 && avgPitches < 65) {
    role = "BULK";
    confidence = "medium";
    reasoning = `Moderate avg pitch count (${avgPitches}) suggests bulk/piggyback role`;
  }
  // Standard starter
  else if (avgPitches >= 65 || appearances > 0) {
    role = "CONVENTIONAL_STARTER";
    confidence = appearances > 2 ? "high" : "medium";
    reasoning = `Typical starter workload pattern (${avgPitches} avg pitches, ${appearances} recent appearances)`;
  }

  // Workload flags
  if (recentGames < 3 && appearances > 0) {
    flags.push("RESTRICTED_WORKLOAD");
  }

  const expectedPitches = role === "OPENER" ? 25 : role === "BULK" ? 55 : 92;
  const expectedInnings = role === "OPENER" ? 1.2 : role === "BULK" ? 3.0 : 6.0;

  return {
    player_id: pitcherId,
    name: pitcherName,
    hand,
    role,
    role_confidence: confidence,
    workload_flags: flags,
    expected_pitches: expectedPitches,
    expected_innings: expectedInnings,
    reasoning,
  };
}

export function classifyPitcherRoles(
  manifest: GameScheduleResult,
  workload: WorkloadResult,
): ClassificationResult {
  logger.info({ games: manifest.total_games }, "MODULE_03: Classifying pitcher roles");

  const workloadById = new Map(
    workload.pitchers.map((p) => [p.playerId, p])
  );

  let unresolved = 0;
  const classifiedGames: ClassifiedGame[] = manifest.games.map((game) => {
    const awayPitcher = classifySinglePitcher(
      game.awayProbablePitcher.id,
      game.awayProbablePitcher.fullName,
      game.awayProbablePitcher.hand,
      game.awayProbablePitcher.id ? workloadById.get(game.awayProbablePitcher.id) : undefined,
    );
    const homePitcher = classifySinglePitcher(
      game.homeProbablePitcher.id,
      game.homeProbablePitcher.fullName,
      game.homeProbablePitcher.hand,
      game.homeProbablePitcher.id ? workloadById.get(game.homeProbablePitcher.id) : undefined,
    );

    if (awayPitcher.role === "UNRESOLVED") unresolved++;
    if (homePitcher.role === "UNRESOLVED") unresolved++;

    return {
      gamePk: game.gamePk,
      legacy_game_id: game.legacy_game_id,
      away_pitcher: awayPitcher,
      home_pitcher: homePitcher,
    };
  });

  logger.info({ unresolved, total: classifiedGames.length * 2 }, "MODULE_03: Classification complete");

  return {
    classification_timestamp_utc: new Date().toISOString(),
    games: classifiedGames,
    status: "success",
  };
}
