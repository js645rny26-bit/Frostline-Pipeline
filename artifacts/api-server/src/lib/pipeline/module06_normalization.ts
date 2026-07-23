/**
 * Module 06: Normalization
 * Merges all source data into canonical game records.
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";
import type { WorkloadResult } from "./module02_statcast.js";
import type { ClassificationResult, PitcherClassificationData } from "./module03_pitcherClassification.js";
import type { WeatherResult, WeatherData } from "./module04_openMeteo.js";
import type { FangraphsResult } from "./module05_fangraphs.js";

export interface NormalizedGameTeam {
  team_id: number | null;
  team_abbr: string | null;
  team_name: string | null;
}

export interface NormalizedGame {
  gamePk: number;
  legacy_game_id: string;
  date: string;
  scheduled_utc_time: string | null;
  venue: { id: number | null; name: string | null; timeZone: string | null };
  away_team: NormalizedGameTeam;
  home_team: NormalizedGameTeam;
  away_pitcher: PitcherClassificationData;
  home_pitcher: PitcherClassificationData;
  environment: WeatherData;
  game_status: { abstractGameState: string | null; detailedState: string | null; codedGameState: string | null };
  doubleheader_status: string;
}

export interface NormalizationResult {
  normalization_timestamp_utc: string;
  games: NormalizedGame[];
  status: string;
}

const UNRESOLVED_PITCHER: PitcherClassificationData = {
  player_id: null,
  name: null,
  hand: null,
  role: "UNRESOLVED",
  role_confidence: "low",
  workload_flags: [],
  expected_pitches: null,
  expected_innings: null,
  reasoning: "No classification data",
};

const DEFAULT_WEATHER: WeatherData = {
  temperature_f: 72,
  humidity_pct: 65,
  wind_speed_mph: 10,
  wind_direction_degrees: 180,
  precipitation_probability_pct: 10,
  wind_context: null,
  roof: false,
  data_quality: "fallback",
};

export function normalizeSlate(
  manifest: GameScheduleResult,
  _workload: WorkloadResult,
  roles: ClassificationResult,
  weather: WeatherResult,
  _splits: FangraphsResult,
): NormalizationResult {
  logger.info({ games: manifest.total_games }, "MODULE_06: Normalizing slate");

  const rolesByPk = new Map(roles.games.map((g) => [g.gamePk, g]));
  const weatherByPk = new Map(weather.games.map((g) => [g.gamePk, g]));

  const normalizedGames: NormalizedGame[] = manifest.games.map((game): NormalizedGame => {
    const gameRoles = rolesByPk.get(game.gamePk);
    const gameWeather = weatherByPk.get(game.gamePk);

    return {
      gamePk: game.gamePk,
      legacy_game_id: game.legacy_game_id,
      date: game.gameDateTime?.split("T")[0] ?? "",
      scheduled_utc_time: game.gameDateTime,
      venue: game.venue,
      away_team: {
        team_id: game.awayTeam.id,
        team_abbr: game.awayTeam.abbreviation,
        team_name: game.awayTeam.name,
      },
      home_team: {
        team_id: game.homeTeam.id,
        team_abbr: game.homeTeam.abbreviation,
        team_name: game.homeTeam.name,
      },
      away_pitcher: gameRoles?.away_pitcher ?? UNRESOLVED_PITCHER,
      home_pitcher: gameRoles?.home_pitcher ?? UNRESOLVED_PITCHER,
      environment: gameWeather?.weather ?? DEFAULT_WEATHER,
      game_status: game.status,
      doubleheader_status: game.doubleheaderStatus,
    };
  });

  logger.info({ normalized: normalizedGames.length }, "MODULE_06: Normalization complete");

  return {
    normalization_timestamp_utc: new Date().toISOString(),
    games: normalizedGames,
    status: "success",
  };
}
