/**
 * Module 03: Pitcher Role Classification
 * Determines starter role: CONVENTIONAL_STARTER, OPENER, BULK, UNRESOLVED, etc.
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";
import type { PitcherWorkloadData, WorkloadResult } from "./module02_pitcherWorkload.js";
import { estimatePitcherSpecificWorkload } from "./module03_numericWorkload.js";

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
  identity_source?: "MLB_STATS_API" | "MLB_STARTING_NINE_TEAM_PAGE" | "UNRESOLVED";
  identity_source_observed_ts?: string | null;
  identity_source_url?: string | null;
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
  workloadData: PitcherWorkloadData | undefined,
  identitySource: "MLB_STATS_API" | "MLB_STARTING_NINE_TEAM_PAGE" | undefined,
  identitySourceObservedTs: string | null | undefined,
  identitySourceUrl: string | null | undefined,
  gameDate: string,
  dataThroughDate: string,
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
      identity_source: "UNRESOLVED",
      identity_source_observed_ts: identitySourceObservedTs ?? null,
      identity_source_url: identitySourceUrl ?? null,
    };
  }

  if (!workloadData || workloadData.status === "fetch_error" || workloadData.status === "no_games_in_window") {
    // A pitcher listed as probable IS going to start regardless of workload data availability.
    // Apply a seasonal-baseline classification rather than leaving them UNRESOLVED.
    // NOTE: "no_games_in_window" means Statcast has no pitch-level data for this pitcher in 60 days —
    // it does NOT reliably mean they are returning from IL (could be a data lag, new acquisition, etc.).
    const flag = workloadData?.status === "fetch_error" ? "STATCAST_UNAVAILABLE" : "NO_RECENT_DATA";
    return {
      player_id: pitcherId,
      name: pitcherName,
      hand,
      role: "CONVENTIONAL_STARTER",
      role_confidence: "medium",
      workload_flags: [flag],
      expected_pitches: 85,
      expected_innings: 5.5,
      reasoning: "No Statcast workload data; probable starter classified using seasonal baseline",
      identity_source: identitySource ?? "MLB_STATS_API",
      identity_source_observed_ts: identitySourceObservedTs ?? null,
      identity_source_url: identitySourceUrl ?? null,
    };
  }

  const l30 = workloadData.rolling_stats?.l30;
  const appearances = l30?.appearances ?? 0;
  const recentGames = workloadData.recent_games_count ?? 0;

  const flags: string[] = [];
  const role = "CONVENTIONAL_STARTER";
  const confidence = identitySource === "MLB_STARTING_NINE_TEAM_PAGE" ? "medium" : "high";

  // Workload flags
  if (recentGames < 3 && appearances > 0) {
    flags.push("RESTRICTED_WORKLOAD");
  }
  if (workloadData.status === "active_wide_window") {
    flags.push("RETURNING_FROM_IL");
  }

  // Role truth and numeric workload are intentionally independent. A pitcher
  // named in the probable-starter slot is a starter assignment; low recent
  // pitch volume alone is not evidence that today's plan is OPENER or BULK.
  // The already-frozen D-1 workload estimator supplies the numeric innings
  // and pitches from prior starts without changing the assignment label.
  const workloadEstimate = estimatePitcherSpecificWorkload(
    role,
    workloadData.status === "active_wide_window" ? 85 : 92,
    workloadData.status === "active_wide_window" ? 5.5 : 6,
    gameDate,
    dataThroughDate,
    workloadData,
  );

  return {
    player_id: pitcherId,
    name: pitcherName,
    hand,
    role,
    role_confidence: confidence,
    workload_flags: flags,
    expected_pitches: workloadEstimate.expected_pitches,
    expected_innings: workloadEstimate.expected_innings,
    reasoning:
      `Listed probable starter; role is not inferred from pitch-count magnitude. `
      + `Independent workload: ${workloadEstimate.notes}`,
    identity_source: identitySource ?? "MLB_STATS_API",
    identity_source_observed_ts: identitySourceObservedTs ?? null,
    identity_source_url: identitySourceUrl ?? null,
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
      game.awayProbablePitcher.source,
      game.awayProbablePitcher.sourceObservedTs,
      game.awayProbablePitcher.sourceUrl,
      game.officialDate ?? manifest.date,
      workload.data_through_date,
    );
    const homePitcher = classifySinglePitcher(
      game.homeProbablePitcher.id,
      game.homeProbablePitcher.fullName,
      game.homeProbablePitcher.hand,
      game.homeProbablePitcher.id ? workloadById.get(game.homeProbablePitcher.id) : undefined,
      game.homeProbablePitcher.source,
      game.homeProbablePitcher.sourceObservedTs,
      game.homeProbablePitcher.sourceUrl,
      game.officialDate ?? manifest.date,
      workload.data_through_date,
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
