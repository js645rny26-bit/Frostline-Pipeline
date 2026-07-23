/**
 * Module 04: Weather MLB
 * Fetches pre-built daily weather JSON from https://weathermlb.com
 * One request covers all games on the slate date.
 *
 * Fallback: if the file is not yet published for today, returns default weather
 * so the pipeline continues gracefully.
 */

import { logger } from "../../lib/logger.js";
import type { GameScheduleResult } from "./module01_mlbStatsApi.js";

const WEATHERMLB_BASE = "https://weathermlb.com/data/daily_files";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeatherData {
  temperature_f:              number | null;
  humidity_pct:               number | null;
  wind_speed_mph:             number | null;
  wind_direction_degrees:     number | null;
  precipitation_probability_pct: number | null;
  /** Contextualized wind direction relative to the field, e.g. "Out to CF", "In from Left", "Cross (R to L)" */
  wind_context:               string | null;
  /** True if stadium has a closed/retractable roof */
  roof:                       boolean;
  data_quality:               string;
}

export interface GameWeatherData {
  gamePk:  number;
  venue:   string | null;
  status:  string;
  weather: WeatherData;
}

export interface WeatherResult {
  retrieval_timestamp_utc: string;
  retrieval_source:        string;
  games:                   GameWeatherData[];
  status:                  string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultWeather(): WeatherData {
  return {
    temperature_f:                72,
    humidity_pct:                 65,
    wind_speed_mph:               10,
    wind_direction_degrees:       180,
    precipitation_probability_pct: 10,
    wind_context:                 null,
    roof:                         false,
    data_quality:                 "fallback",
  };
}

interface WeatherMLBGame {
  gameRaw?: {
    gamePk?: number;
    gameDate?: string;
    venue?: { name?: string };
    teams?: {
      away?: { team?: { name?: string } };
      home?: { team?: { name?: string } };
    };
  };
  weather?: {
    temp?:            number;
    humidity?:        number;
    windSpeed?:       number;
    windDir?:         number;
    maxPrecipChance?: number;
    status?:          string;
  };
  wind?:        { text?: string };
  roof?:        boolean;
  roofPending?: boolean;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchWeatherForecasts(manifest: GameScheduleResult): Promise<WeatherResult> {
  logger.info({ games: manifest.total_games }, "MODULE_04: Fetching weather from weathermlb.com");

  const date = manifest.games[0]?.gameDateTime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const url  = `${WEATHERMLB_BASE}/games_${date}.json?v=${Date.now()}`;

  let siteGames: WeatherMLBGame[] = [];
  let source = "weathermlb";

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrostlinePipeline/1.0)" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn({ status: res.status, date }, "MODULE_04: weathermlb.com file not available — using fallback");
      source = "fallback";
    } else {
      siteGames = await res.json() as WeatherMLBGame[];
      logger.info({ count: siteGames.length, date }, "MODULE_04: weathermlb.com JSON fetched");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "MODULE_04: weathermlb.com fetch threw — using fallback");
    source = "fallback";
  }

  // Build lookup: gamePk → site game entry
  const byGamePk = new Map<number, WeatherMLBGame>();
  for (const g of siteGames) {
    const pk = g.gameRaw?.gamePk;
    if (pk) byGamePk.set(pk, g);
  }

  // Also build venue-name fallback lookup (strip diacritics for fuzzy match)
  const byVenue = new Map<string, WeatherMLBGame>();
  for (const g of siteGames) {
    const v = g.gameRaw?.venue?.name;
    if (v) byVenue.set(v.toLowerCase(), g);
  }

  let successCount  = 0;
  let fallbackCount = 0;

  const games: GameWeatherData[] = manifest.games.map((game) => {
    // Match by gamePk first, then venue name
    let site = byGamePk.get(game.gamePk);
    if (!site) site = byVenue.get((game.venue.name ?? "").toLowerCase());

    if (!site?.weather || site.weather.status !== "ok") {
      fallbackCount++;
      return {
        gamePk: game.gamePk,
        venue:  game.venue.name,
        status: "fallback",
        weather: defaultWeather(),
      };
    }

    successCount++;
    const w   = site.weather;
    const hasRoof = !!(site.roof || site.roofPending);

    return {
      gamePk: game.gamePk,
      venue:  game.venue.name,
      status: "success",
      weather: {
        temperature_f:                w.temp   ?? null,
        humidity_pct:                 w.humidity ?? null,
        wind_speed_mph:               w.windSpeed ?? null,
        wind_direction_degrees:       w.windDir ?? null,
        precipitation_probability_pct: w.maxPrecipChance ?? null,
        wind_context:                 site.wind?.text ?? null,
        roof:                         hasRoof,
        data_quality:                 "good",
      },
    };
  });

  logger.info({ success: successCount, fallback: fallbackCount }, "MODULE_04: Weather resolved");

  return {
    retrieval_timestamp_utc: new Date().toISOString(),
    retrieval_source:        source,
    games,
    status: successCount > 0 ? "success" : "fallback",
  };
}
