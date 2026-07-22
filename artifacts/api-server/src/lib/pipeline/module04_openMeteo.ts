/**
 * Module 04: Open-Meteo Weather
 * Fetches game-time weather forecasts for each stadium.
 */

import { STADIUM_COORDS, resolveVenueName, celsiusToFahrenheit, kmhToMph } from "./config.js";
import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";

const OPEN_METEO_API = "https://api.open-meteo.com/v1/forecast";

export interface WeatherData {
  temperature_f: number | null;
  humidity_pct: number | null;
  wind_speed_mph: number | null;
  wind_direction_degrees: number | null;
  precipitation_probability_pct: number | null;
  data_quality: string;
}

export interface GameWeatherData {
  gamePk: number;
  venue: string | null;
  status: string;
  weather: WeatherData;
}

export interface WeatherResult {
  retrieval_timestamp_utc: string;
  retrieval_source: string;
  games: GameWeatherData[];
  status: string;
}

function defaultWeather(): WeatherData {
  return {
    temperature_f: 72,
    humidity_pct: 65,
    wind_speed_mph: 10,
    wind_direction_degrees: 180,
    precipitation_probability_pct: 10,
    data_quality: "fallback",
  };
}

async function fetchOpenMeteoForecast(
  coords: { latitude: number; longitude: number; timezone: string },
  gameDateTime: string | null,
  maxRetries = 3,
): Promise<WeatherData | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = new URL(OPEN_METEO_API);
      url.searchParams.set("latitude", String(coords.latitude));
      url.searchParams.set("longitude", String(coords.longitude));
      url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m");
      url.searchParams.set("timezone", coords.timezone);
      url.searchParams.set("forecast_days", "7");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Open-Meteo HTTP ${response.status}`);
      }

      const data = await response.json() as {
        hourly?: {
          time?: string[];
          temperature_2m?: number[];
          relative_humidity_2m?: number[];
          wind_speed_10m?: number[];
          wind_direction_10m?: number[];
          precipitation_probability?: number[];
        };
      };

      const hourly = data?.hourly ?? {};
      const times = hourly.time ?? [];
      if (times.length === 0) throw new Error("Empty hourly data");

      // Find hour closest to game time
      let idx = 0;
      if (gameDateTime) {
        const gameHour = gameDateTime.slice(0, 13); // "2026-07-22T18"
        const bestIdx = times.findIndex((t) => t >= gameHour);
        idx = bestIdx >= 0 ? bestIdx : 0;
      }

      return {
        temperature_f: celsiusToFahrenheit(hourly.temperature_2m?.[idx] ?? null),
        humidity_pct: hourly.relative_humidity_2m?.[idx] ?? null,
        wind_speed_mph: kmhToMph(hourly.wind_speed_10m?.[idx] ?? null),
        wind_direction_degrees: hourly.wind_direction_10m?.[idx] ?? null,
        precipitation_probability_pct: hourly.precipitation_probability?.[idx] ?? null,
        data_quality: "good",
      };
    } catch (err) {
      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms
        await new Promise((r) => setTimeout(r, 500 * attempt));
      } else {
        logger.warn({ err, attempt }, "MODULE_04: Open-Meteo fetch failed after retries");
      }
    }
  }
  return null;
}

export async function fetchWeatherForecasts(manifest: GameScheduleResult): Promise<WeatherResult> {
  logger.info({ games: manifest.total_games }, "MODULE_04: Fetching weather forecasts");

  let successCount = 0;
  let fallbackCount = 0;

  // Fetch all games concurrently
  const weatherGames = await Promise.all(
    manifest.games.map(async (game): Promise<GameWeatherData> => {
      const rawVenueName = game.venue.name;
      const resolvedKey = resolveVenueName(rawVenueName);
      const coords = resolvedKey ? STADIUM_COORDS[resolvedKey] : null;

      if (!coords) {
        logger.warn({ venue: rawVenueName }, "MODULE_04: No coords found for venue — using fallback weather");
        fallbackCount++;
        return {
          gamePk: game.gamePk,
          venue: rawVenueName,
          status: "missing_coords",
          weather: defaultWeather(),
        };
      }

      const weather = await fetchOpenMeteoForecast(coords, game.gameDateTime);

      if (weather) {
        successCount++;
        return { gamePk: game.gamePk, venue: rawVenueName, status: "success", weather };
      } else {
        fallbackCount++;
        return { gamePk: game.gamePk, venue: rawVenueName, status: "fallback", weather: defaultWeather() };
      }
    })
  );

  logger.info({ success: successCount, fallback: fallbackCount }, "MODULE_04: Weather fetched");

  return {
    retrieval_timestamp_utc: new Date().toISOString(),
    retrieval_source: "open_meteo_with_fallback",
    games: weatherGames,
    status: "success",
  };
}
