/**
 * Daily environment factor resolver. Park is the structural baseline; weather
 * is a bounded modifier and is never sufficient to originate a game thesis.
 */
import type { WeatherData } from "./module04_openMeteo.js";
import type { ParkFactors } from "./module04c_startingNine.js";

export type ParkSourceStatus = "VENUE_FACTOR_USED" | "SEASONAL_FACTOR_USED" | "MISSING_PARK_DATA";
export type RoofStatus = "CLOSED" | "PENDING" | "OPEN_OR_OUTDOOR" | "UNKNOWN";
export type WindDisposition = "OUT" | "IN" | "CROSS" | "UNKNOWN";
export type EnvironmentCertainty = "HIGH" | "MEDIUM" | "LOW";
export type WeatherVehicleStatus = "ACTIVE" | "CAUTION" | "FREEZE_WEATHER_DEPENDENT";

export type EnvironmentInput = WeatherData;

export interface EnvironmentFactorResolution {
  park_runs_pct: number | null;
  park_hr_pct: number | null;
  park_multiplier: number;
  park_hr_multiplier: number;
  weather_multiplier: number;
  weather_hr_multiplier: number;
  combined_multiplier: number;
  combined_hr_factor: number;
  park_source_status: ParkSourceStatus;
  weather_source_status: "LIVE" | "FALLBACK_NEUTRAL";
  roof_status: RoofStatus;
  wind_disposition: WindDisposition;
  environment_certainty: EnvironmentCertainty;
  weather_vehicle_status: WeatherVehicleStatus;
  component_adjustments: {
    temperature_run: number; temperature_hr: number;
    humidity_run: number; humidity_hr: number;
    wind_run: number; wind_hr: number;
    precipitation_run: number; precipitation_hr: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

/** Uses only WeatherMLB field-relative text; compass headings have no field orientation. */
export function classifyWindContext(context: string | null | undefined): WindDisposition {
  if (!context) return "UNKNOWN";
  const text = context.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!text) return "UNKNOWN";
  if (text.includes("cross") || text.includes("left to right") || text.includes("right to left") || text.includes("l to r") || text.includes("r to l")) return "CROSS";
  if (text.includes("blowing in") || text.includes("in from") || text.startsWith("in ") || text.endsWith(" in")) return "IN";
  if (text.includes("blowing out") || text.includes("out to") || text.includes("toward left") || text.includes("toward center") || text.includes("toward right") || text.includes("towards left") || text.includes("towards center") || text.includes("towards right") || text.startsWith("out ") || text.endsWith(" out")) return "OUT";
  return "UNKNOWN";
}

function resolveRoofStatus(env: EnvironmentInput): RoofStatus {
  if (env.roof_status) return env.roof_status;
  if (env.roof_pending) return "PENDING";
  if (env.roof) return "CLOSED";
  return env.data_quality === "good" ? "OPEN_OR_OUTDOOR" : "UNKNOWN";
}

/** Resolves daily run and HR factors from a park baseline plus conservative live weather. */
export function resolveEnvironmentFactors(
  env: EnvironmentInput,
  parkFactor: ParkFactors | null,
  parkSource?: ParkSourceStatus,
): EnvironmentFactorResolution {
  const park_runs_pct = parkFactor?.runs_pct ?? null;
  const park_hr_pct = parkFactor ? rounded((parkFactor.hr_l_pct + parkFactor.hr_r_pct) / 2, 2) : null;
  const park_multiplier = parkFactor ? rounded(clamp(1 + parkFactor.runs_pct / 100, 0.85, 1.15)) : 1;
  const park_hr_multiplier = parkFactor ? rounded(clamp(1 + (park_hr_pct ?? 0) / 100, 0.75, 1.30)) : 1;
  const park_source_status: ParkSourceStatus = parkFactor ? (parkSource ?? "VENUE_FACTOR_USED") : "MISSING_PARK_DATA";
  const roof_status = resolveRoofStatus(env);
  const isFallback = env.data_quality !== "good";
  const weather_source_status = isFallback ? "FALLBACK_NEUTRAL" as const : "LIVE" as const;
  const wind_disposition = classifyWindContext(env.wind_context);

  let temperatureRun = 0, temperatureHr = 0, humidityRun = 0, humidityHr = 0;
  let windRun = 0, windHr = 0, precipitationRun = 0, precipitationHr = 0;
  // Placeholders and closed-roof outdoor conditions are deliberately neutral.
  if (!isFallback && roof_status !== "CLOSED") {
    if (env.temperature_f !== null) {
      temperatureRun = clamp((env.temperature_f - 72) * 0.0012, -0.04, 0.04);
      temperatureHr = clamp((env.temperature_f - 72) * 0.0018, -0.06, 0.06);
    }
    if (env.humidity_pct !== null) {
      humidityRun = clamp((env.humidity_pct - 55) * 0.0002, -0.012, 0.012);
      humidityHr = clamp((env.humidity_pct - 55) * 0.0003, -0.018, 0.018);
    }
    if (env.wind_speed_mph !== null) {
      const speed = clamp(env.wind_speed_mph, 0, 30);
      if (wind_disposition === "OUT") {
        windRun = clamp(speed * 0.0025, 0, 0.075);
        windHr = clamp(speed * 0.0055, 0, 0.165);
      } else if (wind_disposition === "IN") {
        windRun = clamp(-speed * 0.0020, -0.060, 0);
        windHr = clamp(-speed * 0.0045, -0.135, 0);
      }
    }
    if (env.precipitation_probability_pct !== null) {
      if (env.precipitation_probability_pct >= 60) { precipitationRun = -0.020; precipitationHr = -0.010; }
      else if (env.precipitation_probability_pct >= 35) { precipitationRun = -0.010; precipitationHr = -0.005; }
    }
  }

  const weather_multiplier = rounded(clamp(1 + temperatureRun + humidityRun + windRun + precipitationRun, 0.90, 1.15));
  const weather_hr_multiplier = rounded(clamp(1 + temperatureHr + humidityHr + windHr + precipitationHr, 0.85, 1.25));
  const combined_multiplier = rounded(clamp(park_multiplier * weather_multiplier, 0.85, 1.30));
  const combined_hr_factor = rounded(clamp(park_hr_multiplier * weather_hr_multiplier, 0.70, 1.45));

  const rainRisk = env.precipitation_probability_pct ?? 0;
  let environment_certainty: EnvironmentCertainty = "HIGH";
  let weather_vehicle_status: WeatherVehicleStatus = "ACTIVE";
  if (isFallback || roof_status === "PENDING" || rainRisk >= 60) {
    environment_certainty = "LOW";
    weather_vehicle_status = "FREEZE_WEATHER_DEPENDENT";
  } else if (rainRisk >= 35 || wind_disposition === "UNKNOWN") {
    environment_certainty = "MEDIUM";
    weather_vehicle_status = "CAUTION";
  }
  if (!isFallback && roof_status === "CLOSED") {
    environment_certainty = "HIGH";
    weather_vehicle_status = "ACTIVE";
  }

  return {
    park_runs_pct, park_hr_pct, park_multiplier, park_hr_multiplier,
    weather_multiplier, weather_hr_multiplier, combined_multiplier, combined_hr_factor,
    park_source_status, weather_source_status, roof_status, wind_disposition,
    environment_certainty, weather_vehicle_status,
    component_adjustments: {
      temperature_run: rounded(temperatureRun), temperature_hr: rounded(temperatureHr),
      humidity_run: rounded(humidityRun), humidity_hr: rounded(humidityHr),
      wind_run: rounded(windRun), wind_hr: rounded(windHr),
      precipitation_run: rounded(precipitationRun), precipitation_hr: rounded(precipitationHr),
    },
  };
}
