/**
 * Pipeline Runner
 * Orchestrates all 7 modules and returns the full slate result.
 */

import { getTodayDateStr } from "./config.js";
import { fetchMlbSchedule } from "./module01_mlbStatsApi.js";
import { fetchPitcherWorkload } from "./module02_statcast.js";
import { classifyPitcherRoles } from "./module03_pitcherClassification.js";
import { fetchWeatherForecasts } from "./module04_openMeteo.js";
import { fetchTeamSplitsWithFallback } from "./module05_fangraphs.js";
import { normalizeSlate } from "./module06_normalization.js";
import { validateNormalizedSlate } from "./module07_validation.js";
import { logger } from "../../lib/logger.js";

export interface ModuleStatus {
  module: string;
  status: string;
  message: string | null;
  count: number | null;
}

export interface PipelineSlateResult {
  run_timestamp: string;
  date: string;
  total_games: number;
  games: ReturnType<typeof normalizeSlate>["games"];
  validation: ReturnType<typeof validateNormalizedSlate>;
  module_statuses: ModuleStatus[];
  fangraphs_source: string;
  fangraphs_freshness: string;
}

export interface PipelineSummaryResult {
  date: string;
  total_games: number;
  pitchers_resolved: number;
  pitchers_total: number;
  pitcher_resolution_pct: number;
  weather_live_count: number;
  weather_fallback_count: number;
  weather_live_pct: number;
  validation_status: string;
  critical_failures: number;
  warnings: number;
  fangraphs_source: string;
  fangraphs_freshness: string;
  doubleheaders: number;
}

export async function runPipeline(dateStr?: string): Promise<PipelineSlateResult> {
  const date = dateStr ?? getTodayDateStr();
  const runTimestamp = new Date().toISOString();

  logger.info({ date }, "Pipeline: starting full run");

  const moduleStatuses: ModuleStatus[] = [];

  // Module 01: MLB Schedule
  const manifest = await fetchMlbSchedule(date);
  moduleStatuses.push({
    module: "01_mlb_statsapi",
    status: manifest.status === "success" ? "PASS" : "FAIL",
    message: manifest.status === "success" ? `${manifest.total_games} games retrieved` : (manifest.error ?? null),
    count: manifest.total_games,
  });

  if (manifest.status !== "success" || manifest.games.length === 0) {
    logger.warn({ date }, "Pipeline: no games found, returning empty slate");
    return {
      run_timestamp: runTimestamp,
      date,
      total_games: 0,
      games: [],
      validation: {
        validation_timestamp_utc: new Date().toISOString(),
        status: "FAIL",
        critical_failures: ["No games found for this date"],
        warnings: [],
        info_notes: [],
      },
      module_statuses: moduleStatuses,
      fangraphs_source: "none",
      fangraphs_freshness: "unavailable",
    };
  }

  // Collect unique pitcher IDs
  const pitcherIds = new Set<number>();
  for (const game of manifest.games) {
    if (game.awayProbablePitcher.id) pitcherIds.add(game.awayProbablePitcher.id);
    if (game.homeProbablePitcher.id) pitcherIds.add(game.homeProbablePitcher.id);
  }

  // Modules 02, 04, 05 can run concurrently
  const [workload, weather, splits] = await Promise.all([
    fetchPitcherWorkload(Array.from(pitcherIds), date),
    fetchWeatherForecasts(manifest),
    fetchTeamSplitsWithFallback(),
  ]);

  moduleStatuses.push({
    module: "02_statcast",
    status: workload.status === "success" || workload.status === "no_pitchers" ? "PASS" : "FAIL",
    message: `${workload.pitchers.length} pitchers fetched`,
    count: workload.pitchers.length,
  });
  moduleStatuses.push({
    module: "04_open_meteo",
    status: weather.status === "success" ? "PASS" : "FAIL",
    message: `${weather.games.filter((g) => g.status === "success").length} live, ${weather.games.filter((g) => g.status !== "success").length} fallback`,
    count: weather.games.length,
  });
  moduleStatuses.push({
    module: "05_fangraphs",
    status: splits.status === "success" ? "PASS" : "FAIL",
    message: `${splits.teams.length / 2} teams (${splits.freshness_status})`,
    count: splits.teams.length / 2,
  });

  // Module 03: Pitcher classification
  const roles = classifyPitcherRoles(manifest, workload);
  const resolvedCount = roles.games.flatMap((g) => [g.away_pitcher, g.home_pitcher]).filter((p) => p.role !== "UNRESOLVED").length;
  const totalPitchers = roles.games.length * 2;
  moduleStatuses.push({
    module: "03_pitcher_classification",
    status: roles.status === "success" ? "PASS" : "FAIL",
    message: `${resolvedCount}/${totalPitchers} pitchers classified`,
    count: resolvedCount,
  });

  // Module 06: Normalization
  const normalized = normalizeSlate(manifest, workload, roles, weather, splits);
  moduleStatuses.push({
    module: "06_normalization",
    status: normalized.status === "success" ? "PASS" : "FAIL",
    message: `${normalized.games.length} games normalized`,
    count: normalized.games.length,
  });

  // Module 07: Validation
  const validation = validateNormalizedSlate(normalized);
  moduleStatuses.push({
    module: "07_validation",
    status: validation.status,
    message: validation.status === "PASS"
      ? `${validation.critical_failures.length} critical, ${validation.warnings.length} warnings`
      : validation.critical_failures[0] ?? "Validation failed",
    count: null,
  });

  logger.info({ date, games: normalized.games.length, validation: validation.status }, "Pipeline: run complete");

  return {
    run_timestamp: runTimestamp,
    date,
    total_games: normalized.games.length,
    games: normalized.games,
    validation,
    module_statuses: moduleStatuses,
    fangraphs_source: splits.retrieval_source,
    fangraphs_freshness: splits.freshness_status,
  };
}

export async function getPipelineSummary(dateStr?: string): Promise<PipelineSummaryResult> {
  const slate = await runPipeline(dateStr);

  const pitchersTotal = slate.games.length * 2;
  const pitchersResolved = slate.games.flatMap((g) => [g.away_pitcher, g.home_pitcher])
    .filter((p) => p.role !== "UNRESOLVED").length;

  const weatherLive = slate.games.filter((g) => g.environment.data_quality === "good").length;
  const weatherFallback = slate.games.filter((g) => g.environment.data_quality !== "good").length;

  const doubleheaders = slate.games.filter(
    (g) => g.doubleheader_status !== "N" && g.doubleheader_status !== "NONE"
  ).length;

  return {
    date: slate.date,
    total_games: slate.total_games,
    pitchers_resolved: pitchersResolved,
    pitchers_total: pitchersTotal,
    pitcher_resolution_pct: pitchersTotal > 0 ? Math.round((pitchersResolved / pitchersTotal) * 1000) / 10 : 0,
    weather_live_count: weatherLive,
    weather_fallback_count: weatherFallback,
    weather_live_pct: slate.games.length > 0 ? Math.round((weatherLive / slate.games.length) * 1000) / 10 : 0,
    validation_status: slate.validation.status,
    critical_failures: slate.validation.critical_failures.length,
    warnings: slate.validation.warnings.length,
    fangraphs_source: slate.fangraphs_source,
    fangraphs_freshness: slate.fangraphs_freshness,
    doubleheaders,
  };
}
