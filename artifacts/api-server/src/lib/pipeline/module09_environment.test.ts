import assert from "node:assert/strict";
import test from "node:test";
import { classifyWindContext, resolveEnvironmentFactors, type EnvironmentInput } from "./module09_environment.js";

const neutral: EnvironmentInput = {
  temperature_f: 72, humidity_pct: 55, wind_speed_mph: 0,
  wind_direction_degrees: 180, precipitation_probability_pct: 0,
  wind_context: "Calm", roof: false, roof_pending: false,
  roof_status: "OPEN_OR_OUTDOOR", data_quality: "good",
};
const park = { runs_pct: 10, hr_l_pct: 20, hr_r_pct: 10, woba_l_pct: 5, woba_r_pct: 3 };

test("1. neutral weather preserves the structural park baseline", () => {
  const result = resolveEnvironmentFactors(neutral, park);
  assert.equal(result.weather_multiplier, 1);
  assert.equal(result.weather_hr_multiplier, 1);
  assert.equal(result.combined_multiplier, 1.1);
  assert.equal(result.combined_hr_factor, 1.15);
});

test("2. wind out positively modifies run and HR factors", () => {
  const result = resolveEnvironmentFactors({ ...neutral, wind_speed_mph: 15, wind_context: "Out to CF" }, null);
  assert.equal(result.wind_disposition, "OUT");
  assert.ok(result.weather_multiplier > 1);
  assert.ok(result.weather_hr_multiplier > 1);
});

test("3. wind in negatively modifies run and HR factors", () => {
  const result = resolveEnvironmentFactors({ ...neutral, wind_speed_mph: 15, wind_context: "In from CF" }, null);
  assert.equal(result.wind_disposition, "IN");
  assert.ok(result.weather_multiplier < 1);
  assert.ok(result.weather_hr_multiplier < 1);
});

test("4. crosswind remains neutral", () => {
  const result = resolveEnvironmentFactors({ ...neutral, wind_speed_mph: 25, wind_context: "Cross (R to L)" }, null);
  assert.equal(classifyWindContext("Cross (R to L)"), "CROSS");
  assert.equal(result.component_adjustments.wind_run, 0);
  assert.equal(result.component_adjustments.wind_hr, 0);
});

test("5. a closed roof neutralizes outdoor weather", () => {
  const result = resolveEnvironmentFactors({ ...neutral, temperature_f: 101, humidity_pct: 15, wind_speed_mph: 20, wind_context: "Out to CF", precipitation_probability_pct: 80, roof: true, roof_status: "CLOSED" }, null);
  assert.equal(result.weather_multiplier, 1);
  assert.equal(result.weather_hr_multiplier, 1);
  assert.equal(result.weather_vehicle_status, "ACTIVE");
});

test("6. a pending roof freezes only weather-dependent vehicles", () => {
  const result = resolveEnvironmentFactors({ ...neutral, roof_pending: true, roof_status: "PENDING" }, park);
  assert.equal(result.weather_vehicle_status, "FREEZE_WEATHER_DEPENDENT");
  assert.equal(result.combined_multiplier, 1.1);
});

test("7. fallback weather is neutral", () => {
  const result = resolveEnvironmentFactors({ ...neutral, temperature_f: 99, wind_speed_mph: 30, wind_context: "Out to CF", data_quality: "fallback", roof_status: "UNKNOWN" }, park);
  assert.equal(result.weather_source_status, "FALLBACK_NEUTRAL");
  assert.equal(result.weather_multiplier, 1);
  assert.equal(result.weather_hr_multiplier, 1);
  assert.equal(result.weather_vehicle_status, "FREEZE_WEATHER_DEPENDENT");
});

test("8. severe rain freezes weather-dependent vehicles", () => {
  const result = resolveEnvironmentFactors({ ...neutral, precipitation_probability_pct: 80 }, null);
  assert.equal(result.weather_vehicle_status, "FREEZE_WEATHER_DEPENDENT");
  assert.ok(result.weather_multiplier < 1);
});

test("9. weather factors are monotonic for directional wind", () => {
  const out = resolveEnvironmentFactors({ ...neutral, wind_speed_mph: 15, wind_context: "Out to CF" }, null);
  const calm = resolveEnvironmentFactors(neutral, null);
  const into = resolveEnvironmentFactors({ ...neutral, wind_speed_mph: 15, wind_context: "In from CF" }, null);
  assert.ok(out.weather_multiplier > calm.weather_multiplier && calm.weather_multiplier > into.weather_multiplier);
  assert.ok(out.weather_hr_multiplier > calm.weather_hr_multiplier && calm.weather_hr_multiplier > into.weather_hr_multiplier);
});

test("10. resolver clamps park, weather, and combined factors", () => {
  const extremePark = { ...park, runs_pct: 100, hr_l_pct: 100, hr_r_pct: 100 };
  const result = resolveEnvironmentFactors({ ...neutral, temperature_f: 200, humidity_pct: 100, wind_speed_mph: 100, wind_context: "Out to CF" }, extremePark);
  assert.equal(result.park_multiplier, 1.15);
  assert.equal(result.park_hr_multiplier, 1.3);
  assert.equal(result.weather_multiplier, 1.124);
  assert.equal(result.weather_hr_multiplier, 1.2385);
  assert.equal(result.combined_multiplier, 1.2926);
  assert.equal(result.combined_hr_factor, 1.45);
  const cold = resolveEnvironmentFactors({ ...neutral, temperature_f: -100, humidity_pct: 0, wind_speed_mph: 100, wind_context: "In from CF", precipitation_probability_pct: 80 }, null);
  assert.equal(cold.weather_multiplier, 0.9);
  assert.equal(cold.weather_hr_multiplier, 0.85);
});
