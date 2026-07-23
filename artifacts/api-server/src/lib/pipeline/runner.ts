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
import { fetchBullpenUsage } from "./module04b_bullpenUsage.js";
import { fetchStartingNine, buildStartingNineMap } from "./module04c_startingNine.js";
import { fetchStarterPrevOutings } from "./module04d_starterPrevOuting.js";
import { fetchPlateUmpires } from "./module04e_umpires.js";
import { fetchPitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import { fetchTeamRunRates } from "./module05c_teamRunRates.js";
import { trackLineMovement } from "./module05d_oddsHistory.js";
import { fetchMarketOdds, buildOddsMap } from "./module05b_marketOdds.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { normalizeSlate } from "./module06_normalization.js";
import { validateNormalizedSlate } from "./module07_validation.js";
import { writeGoogleSheetsFeed, type Module08Result } from "./module08_feedWriter.js";
import { verifyRecalculation, type Module09Result } from "./module09_recalculation.js";
import { seedSlateInput, type Module10Result } from "./module10_slateInput.js";
import { extractOutputBoards, type Module11Result } from "./module11_outputExtraction.js";
import { archiveRunBundle, type Module12Result } from "./module12_archival.js";
import { WORKBOOK_ID } from "../sheets/client.js";
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

export interface PublishResult {
  run_timestamp: string;
  date: string;
  pipeline_status: string;
  total_games: number;
  validation_status: string;
  module_08: Module08Result;
  module_09: Module09Result;
  module_10: Module10Result;
  module_11: Module11Result;
  module_12: Module12Result;
  workbook_url: string;
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

export async function runFullPipeline(dateStr?: string, workbookId = WORKBOOK_ID): Promise<PublishResult> {
  const date = dateStr ?? getTodayDateStr();
  logger.info({ date, workbookId }, "Full pipeline: starting 12-module run");

  // Modules 01–07
  const slate = await runPipeline(date);
  const normalized = { games: slate.games, normalization_timestamp_utc: slate.run_timestamp, status: "success" };
  const splits = await fetchTeamSplitsWithFallback();

  const allErrors: Array<{ module: string; error: string; timestamp: string }> = [];

  // Module 04b + 04c: Bullpen usage and Starting Nine — fetch in parallel, both non-blocking
  const slateTeamIds = Array.from(
    new Set(
      slate.games
        .flatMap((g) => [g.away_team?.team_id, g.home_team?.team_id])
        .filter((id): id is number => typeof id === "number"),
    ),
  );

  // Fetch schedule manifest for pitcher IDs (needed by module04d)
  const manifest = await fetchMlbSchedule(date).catch(() => null);

  const [bullpenResult, startingNineResult, starterOutings, umpireResult, teamRunRates, oddsResult] = await Promise.all([
    fetchBullpenUsage(date, slateTeamIds).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: bullpen fetch threw — skipping");
      return null;
    }),
    fetchStartingNine(date).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: startingNine fetch threw — skipping");
      return null;
    }),
    manifest
      ? fetchStarterPrevOutings(manifest, date).catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: starterOutings fetch threw — skipping");
          return null;
        })
      : Promise.resolve(null),
    manifest
      ? fetchPlateUmpires(manifest).catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: umpire fetch threw — skipping");
          return null;
        })
      : Promise.resolve(null),
    fetchTeamRunRates(date).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: teamRunRates fetch threw — skipping");
      return null;
    }),
    fetchMarketOdds(date), // never throws — returns status "no_key" | "error" on failure
  ]);

  if (bullpenResult) {
    const lvl = bullpenResult.status === "success" ? "info" : "warn";
    logger[lvl]({ relievers: bullpenResult.relievers.length, status: bullpenResult.status }, "Full pipeline: bullpen usage ready");
  }
  if (startingNineResult) {
    const lvl = startingNineResult.status === "success" ? "info" : "warn";
    logger[lvl]({ matched: startingNineResult.games_matched, status: startingNineResult.status }, "Full pipeline: starting lineups ready");
  }
  if (starterOutings) {
    const lvl = starterOutings.status === "success" ? "info" : "warn";
    logger[lvl]({ fetched: starterOutings.fetched, status: starterOutings.status }, "Full pipeline: starter outings ready");
  }
  if (umpireResult) {
    logger.info({ assigned: umpireResult.assigned, total: umpireResult.total_games }, "Full pipeline: plate umpires ready");
  }

  // Module 05b/05d: market odds → history snapshot → line movement
  const oddsMap = buildOddsMap(oddsResult);
  if (oddsResult.status === "success") {
    logger.info({ lines: oddsMap.size, remaining: oddsResult.requests_remaining }, "Full pipeline: Market odds fetched");
  } else if (oddsResult.status === "error") {
    logger.warn({ err: oddsResult.error }, "Full pipeline: Market odds fetch failed — continuing without lines");
  }
  const lineMovement = await trackLineMovement(oddsResult, workbookId);

  // Module 02b: season stats for every starter + reliever on the slate (batched)
  const statIds: number[] = [];
  if (manifest) {
    for (const g of manifest.games) {
      if (g.awayProbablePitcher.id) statIds.push(g.awayProbablePitcher.id);
      if (g.homeProbablePitcher.id) statIds.push(g.homeProbablePitcher.id);
    }
  }
  if (bullpenResult) {
    for (const r of bullpenResult.relievers) {
      if (r.player_id) statIds.push(r.player_id);
    }
  }
  const pitcherSeasonStats = await fetchPitcherSeasonStats(statIds, date.slice(0, 4)).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: pitcher season stats threw — skipping");
    return null;
  });

  // Module 08: Write feeds to Google Sheets
  const mod08 = await writeGoogleSheetsFeed(
    normalized as Parameters<typeof writeGoogleSheetsFeed>[0],
    splits,
    date,
    workbookId,
    bullpenResult,
    startingNineResult,
    starterOutings,
    umpireResult,
    pitcherSeasonStats,
    teamRunRates,
    lineMovement,
  );
  if (mod08.status === "failure") {
    logger.error("Full pipeline: Module 08 failed — aborting Sheets workflow");
    return {
      run_timestamp: slate.run_timestamp,
      date,
      pipeline_status: "failure",
      total_games: slate.total_games,
      validation_status: slate.validation.status,
      module_08: mod08,
      module_09: { status: "error", verification_timestamp_utc: new Date().toISOString(), checks: { game_integration: { status: "error", expected_rows: 0, actual_rows: 0, formula_errors: [] }, game_summary: { status: "error", expected_rows: 0, actual_rows: 0, formula_errors: [] }, consistency_check: { status: "inconsistent", read_1_timestamp: "", read_2_timestamp: "", diff_seconds: 0 } }, recalculation_time_ms: 0, game_summary_rows: [] },
      module_10: { status: "failure", seeding_timestamp_utc: new Date().toISOString(), games_seeded: { new_games: 0, updated_games: 0, total_games: 0 }, rows_written: 0, seed_results: [], errors: [{ module: "10", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      module_11: { status: "failure", extraction_timestamp_utc: new Date().toISOString(), slate_board: [], active_board_snapshot: [], core_count: 0, not_core_count: 0, error: "Skipped: Module 08 failed" },
      module_12: { status: "failure", archival_timestamp_utc: new Date().toISOString(), bundle_name: `${date}_v01`, bundle_folder_id: "", files_archived: {}, errors: [{ module: "12", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
      errors: [...mod08.errors],
    };
  }

  // Module 09: Compute + write GAME_INTEGRATION and GAME_SUMMARY
  const mod09 = await verifyRecalculation(
    normalized as Parameters<typeof verifyRecalculation>[0],
    splits,
    workbookId,
    pitcherSeasonStats?.stats ?? new Map(),
  );
  if (mod09.status === "error") {
    logger.warn({ status: mod09.status }, "Full pipeline: Module 09 computation error — continuing");
  }

  // Module 10: Seed SLATE_INPUT (odds fetched earlier, reused here)
  const mod10 = await seedSlateInput(normalized as Parameters<typeof seedSlateInput>[0], workbookId, oddsMap);
  if (mod10.status === "failure") {
    allErrors.push(...mod10.errors);
  }

  // Module 11: Compute + write SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT
  const mod11 = await extractOutputBoards(mod09.game_summary_rows, workbookId);

  // Overall status before archival (so we can write it into the run log row)
  // mod08 "failure" case is already handled by the early return above;
  // at this point mod08.status is "success" | "partial_failure".
  const overallStatus =
    mod10.status === "failure"
      ? "failure"
      : mod08.status === "partial_failure"
        ? "partial_success"
        : "success";

  // Module 12: Append run log row to RUN_LOG sheet (non-blocking — failure is advisory)
  const mod12 = await archiveRunBundle(slate, mod08, mod09, mod10, mod11, overallStatus, 1, workbookId);
  if (mod12.status !== "success") {
    // Run log is best-effort; don't downgrade overall status for it
    allErrors.push(...mod12.errors);
  }

  logger.info({ overallStatus, date, workbookId }, "Full pipeline: 12-module run complete");

  return {
    run_timestamp: slate.run_timestamp,
    date,
    pipeline_status: overallStatus,
    total_games: slate.total_games,
    validation_status: slate.validation.status,
    module_08: mod08,
    module_09: mod09,
    module_10: mod10,
    module_11: mod11,
    module_12: mod12,
    workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
    errors: allErrors,
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
