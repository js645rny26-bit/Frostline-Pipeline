import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveHistoricalEnvironment,
  type HistoricalWeatherFixtures,
} from "./module13_historicalWeather.js";

const park = { runs_pct: 6, hr_l_pct: 8, hr_r_pct: 4, woba_l_pct: 0, woba_r_pct: 0 };
const gameId = "2026-08-01_AAA@BBB";

test("historical fixtures cannot look ahead to another date", () => {
  const fixtures: HistoricalWeatherFixtures = {
    "2026-08-02": {
      [gameId]: {
        game_date: "2026-08-02", temperature_f: 90, humidity_pct: 20,
        wind_speed_mph: 20, wind_context: "out to center",
        precipitation_probability_pct: 0, roof: false, roof_pending: false,
        roof_status: "OPEN_OR_OUTDOOR", data_quality: "good",
      },
    },
  };
  const resolved = resolveHistoricalEnvironment("2026-08-01", gameId, park, "SEASONAL_FACTOR_USED", fixtures);
  assert.equal(resolved.weather_status, "MISSING_NEUTRAL");
  assert.equal(resolved.environment.weather_multiplier, 1);
  assert.equal(resolved.environment.combined_multiplier, 1.06);
});

test("missing historical weather is explicitly fallback-neutral", () => {
  const resolved = resolveHistoricalEnvironment("2026-08-01", gameId, park, "SEASONAL_FACTOR_USED", {});
  assert.equal(resolved.weather_status, "MISSING_NEUTRAL");
  assert.equal(resolved.environment.weather_source_status, "FALLBACK_NEUTRAL");
  assert.equal(resolved.environment.weather_multiplier, 1);
  assert.equal(resolved.environment.park_multiplier, 1.06);
});
