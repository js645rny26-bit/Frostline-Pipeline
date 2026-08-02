/**
 * Historical weather fixture adapter for Module 13.
 *
 * Fixtures are keyed by the replay date and the immutable replay game id.
 * The resolver intentionally never searches neighbouring dates: a weather
 * record is usable only when its game_date exactly matches the replay date.
 */
import type { ParkFactors } from "./module04c_startingNine.js";
import {
  resolveEnvironmentFactors,
  type EnvironmentFactorResolution,
  type ParkSourceStatus,
  type RoofStatus,
} from "./module09_environment.js";

export interface HistoricalWeatherFixture {
  /** Must equal the enclosing date key and the replay date. */
  game_date: string;
  temperature_f: number | null;
  humidity_pct: number | null;
  wind_speed_mph: number | null;
  /** Field-relative only; compass bearings are deliberately not interpreted. */
  wind_context: string | null;
  precipitation_probability_pct: number | null;
  roof: boolean;
  roof_pending: boolean;
  roof_status: RoofStatus;
  /** "good" enables conservative weather treatment; every other value is neutral. */
  data_quality: string;
}

/** date -> replay game id (YYYY-MM-DD_AWAY@HOME) -> observed/pre-game fixture */
export type HistoricalWeatherFixtures = Record<string, Record<string, HistoricalWeatherFixture>>;

/**
 * Commissioning starts with no supplied historical observations.  Populate this
 * table only with source-dated, pre-game records; never backfill from a later
 * date or final game outcome.
 */
export const HISTORICAL_WEATHER_FIXTURES: HistoricalWeatherFixtures = {};

export type HistoricalWeatherStatus =
  | "FIXTURE_LIVE"
  | "FIXTURE_FALLBACK_NEUTRAL"
  | "MISSING_NEUTRAL"
  | "INVALID_NEUTRAL";

export interface HistoricalEnvironmentResolution {
  weather_status: HistoricalWeatherStatus;
  environment: EnvironmentFactorResolution;
}

function neutralWeather() {
  return {
    temperature_f: null,
    humidity_pct: null,
    wind_speed_mph: null,
    wind_direction_degrees: null,
    precipitation_probability_pct: null,
    wind_context: null,
    roof: false,
    roof_pending: false,
    roof_status: "UNKNOWN" as const,
    data_quality: "fallback",
  };
}

/**
 * Resolve historical weather without lookahead.  Only fixtures[replayDate] is
 * consulted, and a stale/misdated record is rejected as neutral.
 */
export function resolveHistoricalEnvironment(
  replayDate: string,
  gameId: string,
  parkFactor: ParkFactors | null,
  parkSourceStatus: ParkSourceStatus,
  fixtures: HistoricalWeatherFixtures = HISTORICAL_WEATHER_FIXTURES,
): HistoricalEnvironmentResolution {
  const fixture = fixtures[replayDate]?.[gameId];
  if (!fixture) {
    return {
      weather_status: "MISSING_NEUTRAL",
      environment: resolveEnvironmentFactors(neutralWeather(), parkFactor, parkSourceStatus),
    };
  }
  if (fixture.game_date !== replayDate) {
    return {
      weather_status: "INVALID_NEUTRAL",
      environment: resolveEnvironmentFactors(neutralWeather(), parkFactor, parkSourceStatus),
    };
  }

  const environment = resolveEnvironmentFactors({
    temperature_f: fixture.temperature_f,
    humidity_pct: fixture.humidity_pct,
    wind_speed_mph: fixture.wind_speed_mph,
    wind_direction_degrees: null,
    precipitation_probability_pct: fixture.precipitation_probability_pct,
    wind_context: fixture.wind_context,
    roof: fixture.roof,
    roof_pending: fixture.roof_pending,
    roof_status: fixture.roof_status,
    data_quality: fixture.data_quality,
  }, parkFactor, parkSourceStatus);

  return {
    weather_status: fixture.data_quality === "good" ? "FIXTURE_LIVE" : "FIXTURE_FALLBACK_NEUTRAL",
    environment,
  };
}
