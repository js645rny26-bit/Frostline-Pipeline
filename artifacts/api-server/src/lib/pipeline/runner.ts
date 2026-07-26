/**
 * Pipeline Runner
 * Orchestrates all 7 modules and returns the full slate result.
 */

import { getTodayDateStr } from "./config.js";
import { fetchMlbSchedule } from "./module01_mlbStatsApi.js";
import { fetchPitcherWorkload } from "./module02_pitcherWorkload.js";
import { classifyPitcherRoles } from "./module03_pitcherClassification.js";
import { fetchWeatherForecasts } from "./module04_openMeteo.js";
import { fetchTeamSplitsWithFallback } from "./module05_fangraphs.js";
import { fetchBullpenUsage } from "./module04b_bullpenUsage.js";
import { fetchStartingNine, buildStartingNineMap } from "./module04c_startingNine.js";
import { fetchStarterPrevOutings } from "./module04d_starterPrevOuting.js";
import { fetchPlateUmpires } from "./module04e_umpires.js";
import { fetchPitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import { fetchTeamRosters, fetchBatterSeasonStats, normalizeForMatch } from "./module02c_batterSeasonStats.js";
import { fetchStatcastBatterLeaderboard } from "./module02d_statcastBatters.js";
import { fetchTeamRunRates } from "./module05c_teamRunRates.js";
import { trackLineMovement } from "./module05d_oddsHistory.js";
import { fetchMarketOddsWithFallback, buildOddsMap } from "./module05c_startingNineScraper.js";
import { fetchRotowireProps, type RotowirePropsResult } from "./module05e_rotowireProps.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { normalizeSlate } from "./module06_normalization.js";
import { validateNormalizedSlate } from "./module07_validation.js";
import { writeGoogleSheetsFeed, type Module08Result } from "./module08_feedWriter.js";
import { fetchStatcastPreviews, type StatcastPreviewResult } from "./module02e_statcastPreview.js";
import { writeStatcastPreviewFeed, type StatcastPreviewWriterResult } from "./module08b_statcastPreviewWriter.js";
import { verifyRecalculation, type Module09Result } from "./module09_recalculation.js";
import { seedSlateInput, type Module10Result } from "./module10_slateInput.js";
import { extractOutputBoards, type Module11Result } from "./module11_outputExtraction.js";
import { archiveRunBundle, type Module12Result } from "./module12_archival.js";
import { runShadowValidation, type ShadowValidationResult } from "./module12s_shadowValidation.js";
import { logVehicles, type VehicleLogResult } from "./module17_vehiclePostmortem.js";
import { runShadowSettlement, type SettlementResult } from "./module14_shadowSettlement.js";
import { runSurvivalGateReplay, type SurvivalReplayResult } from "./module18_survivalGateReplay.js";
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
    module: "02_pitcher_workload",
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
  /** Module 08b: Statcast game preview fetch + STATCAST_GAME_PREVIEW sheet write */
  module_08b: StatcastPreviewWriterResult;
  /** Module 08b fetch result: per-game Baseball Savant preview data */
  module_08b_preview: StatcastPreviewResult;
  module_09: Module09Result;
  module_09_shadow: ShadowValidationResult;
  module_10: Module10Result;
  module_11: Module11Result;
  module_12: Module12Result;
  /** Module 17: Vehicle log — rows written for this publish run */
  module_17: VehicleLogResult;
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

  const [bullpenResult, startingNineResult, starterOutings, umpireResult, teamRunRates, oddsResult, rotowireProps, rosterNameMap, statcastPreviewFetch] = await Promise.all([
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
    fetchMarketOddsWithFallback(date), // mlbstartingnine primary, OddsAPI fallback
    fetchRotowireProps().catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: Rotowire props fetch threw — skipping (shadow mode)");
      return null as RotowirePropsResult | null;
    }),
    fetchTeamRosters(slateTeamIds, date.slice(0, 4)).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: team roster fetch threw — returning empty map");
      return new Map<string, number>();
    }),
    // Module 02e: Statcast game preview — fail-open; runs in parallel with other fetches
    slate.games.length > 0
      ? fetchStatcastPreviews(slate.games, date).catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: Statcast preview fetch threw — skipping");
          return null as StatcastPreviewResult | null;
        })
      : Promise.resolve(null as StatcastPreviewResult | null),
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

  // Module 02c: resolve lineup batter IDs from roster map, then fetch season hitting stats.
  // Runs concurrently with module 02b — independent requests to the MLB API.
  const batterIdSet = new Set<number>();
  if (startingNineResult) {
    const nameMap = rosterNameMap ?? new Map<string, number>();
    for (const sg of startingNineResult.games) {
      for (const player of [...(sg.away_lineup ?? []), ...(sg.home_lineup ?? [])]) {
        const id = nameMap.get(normalizeForMatch(player.name));
        if (id) batterIdSet.add(id);
      }
    }
  }
  logger.info(
    { batterIds: batterIdSet.size, lineupGames: startingNineResult?.games_matched ?? 0 },
    "Full pipeline: batter IDs resolved from lineup roster map",
  );

  const [pitcherSeasonStats, batterSeasonStats, statcastBatterStats] = await Promise.all([
    fetchPitcherSeasonStats(statIds, date.slice(0, 4)).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: pitcher season stats threw — skipping");
      return null;
    }),
    fetchBatterSeasonStats([...batterIdSet], date.slice(0, 4)).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: batter season stats threw — skipping");
      return null;
    }),
    fetchStatcastBatterLeaderboard(date.slice(0, 4)).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Full pipeline: Statcast batter leaderboard threw — degrading to OPS-only");
      return null;
    }),
  ]);

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
  const shadowSkipped: ShadowValidationResult = {
    status: "failure",
    shadow_timestamp_utc: new Date().toISOString(),
    games_compared: 0,
    avg_delta: null,
    max_abs_delta: null,
    fallback_count: 0,
    rows: [],
    errors: ["Skipped: upstream module failed"],
  };

  if (mod08.status === "failure") {
    logger.error("Full pipeline: Module 08 failed — aborting Sheets workflow");
    return {
      run_timestamp: slate.run_timestamp,
      date,
      pipeline_status: "failure",
      total_games: slate.total_games,
      validation_status: slate.validation.status,
      module_08: mod08,
      module_08b: { status: "failure", write_timestamp_utc: new Date().toISOString(), rows_written: 0, errors: ["Skipped: Module 08 failed"] },
      module_08b_preview: statcastPreviewFetch ?? { status: "failure", fetch_timestamp: new Date().toISOString(), games_expected: 0, games_available: 0, games_parsed: 0, games_missing: 0, games_failed: 0, games_identity_mismatch: 0, games: [] },
      module_09: { status: "error", verification_timestamp_utc: new Date().toISOString(), checks: { game_integration: { status: "error", expected_rows: 0, actual_rows: 0, formula_errors: [] }, game_summary: { status: "error", expected_rows: 0, actual_rows: 0, formula_errors: [] }, consistency_check: { status: "inconsistent", read_1_timestamp: "", read_2_timestamp: "", diff_seconds: 0 } }, recalculation_time_ms: 0, game_summary_rows: [] },
      module_09_shadow: shadowSkipped,
      module_10: { status: "failure", seeding_timestamp_utc: new Date().toISOString(), games_seeded: { new_games: 0, updated_games: 0, total_games: 0 }, rows_written: 0, seed_results: [], errors: [{ module: "10", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      module_11: { status: "failure", extraction_timestamp_utc: new Date().toISOString(), slate_board: [], active_board_snapshot: [], core_count: 0, no_core_count: 0, core_auth_status: "DISABLED_MONOTONICITY_NOT_COMPUTED", monotonicity_verdict: null, monotonicity_override_active: false, error: "Skipped: Module 08 failed" },
      module_12: { status: "failure", archival_timestamp_utc: new Date().toISOString(), bundle_name: `${date}_v01`, bundle_folder_id: "", files_archived: {}, errors: [{ module: "12", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      module_17: { status: "failure", date, publish_ts: new Date().toISOString(), rows_written: 0, rows_skipped: 0, errors: ["Skipped: Module 08 failed"] },
      workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
      errors: [...mod08.errors],
    };
  }

  // Module 08b: Write STATCAST_GAME_PREVIEW sheet — fail-open, runs before module 09
  const previewFetchResult: StatcastPreviewResult = statcastPreviewFetch ?? {
    status: "failure",
    fetch_timestamp: new Date().toISOString(),
    games_expected: slate.games.length,
    games_available: 0,
    games_parsed: 0,
    games_missing: 0,
    games_failed: slate.games.length,
    games_identity_mismatch: 0,
    games: [],
  };
  const mod08b = await writeStatcastPreviewFeed(previewFetchResult, workbookId).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Full pipeline: Module 08b threw — continuing");
      return { status: "failure" as const, write_timestamp_utc: new Date().toISOString(), rows_written: 0, errors: [msg] };
    },
  );
  if (mod08b.status !== "success") {
    allErrors.push({ module: "08b_statcast_preview_writer", error: mod08b.errors[0] ?? "write failed", timestamp: new Date().toISOString() });
  }

  // Module 09: Compute + write GAME_INTEGRATION and GAME_SUMMARY
  // teamRunRates (L10 actual RS) and startingNineResult (park factors) are
  // now consumed by the projection formula — not display-only.
  const mod09 = await verifyRecalculation(
    normalized as Parameters<typeof verifyRecalculation>[0],
    splits,
    workbookId,
    pitcherSeasonStats?.stats ?? new Map(),
    bullpenResult,
    teamRunRates,
    startingNineResult,
    batterSeasonStats?.stats ?? new Map(),
    rosterNameMap ?? new Map(),
    statcastBatterStats?.stats ?? new Map(),
  );
  if (mod09.status === "error") {
    logger.warn({ status: mod09.status }, "Full pipeline: Module 09 computation error — continuing");
  }

  // Module 12s: Shadow validation — compare repaired vs legacy projection per game.
  // Runs after every full publish; does not affect CORE authorization.
  const mod12s = await runShadowValidation(mod09.game_summary_rows, workbookId).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Full pipeline: Module 12s shadow validation threw — continuing");
      return {
        ...shadowSkipped,
        errors: [`Shadow threw: ${msg}`],
      } satisfies ShadowValidationResult;
    },
  );
  if (mod12s.fallback_count > 0) {
    logger.warn(
      { fallback_count: mod12s.fallback_count },
      "Full pipeline: Module 12s — LEAGUE_AVG_FALLBACK games detected in shadow comparison",
    );
  }

  // Module 10: Seed SLATE_INPUT (odds fetched earlier, reused here)
  const mod10 = await seedSlateInput(normalized as Parameters<typeof seedSlateInput>[0], workbookId, oddsMap);
  if (mod10.status === "failure") {
    allErrors.push(...mod10.errors);
  }

  // Module 11: Compute + write SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT
  // rotowireProps is passed for shadow-mode prop comparison signals — no CORE impact.
  //
  // Authorization-integrity note (#44): mod09.game_summary_rows is the in-memory
  // GameSummaryRow[] produced by module09 above.  Module11 receives these objects
  // directly and never re-reads the GAME_SUMMARY sheet.  All survival gate inputs
  // (baseball_only_projection, starter_attack_runs, bullpen_continuation_runs,
  // traffic_conversion_runs, hr_xbh_damage_runs, environment_run_adjustment) are
  // typed as `number` on GameSummaryRow — not optional — so COMPONENT_DATA_UNAVAILABLE
  // cannot fire in a healthy module09 run; it is a defensive guard for future callers.
  const mod11 = await extractOutputBoards(mod09.game_summary_rows, workbookId, rotowireProps, normalized.games);

  // Module 17 (phase 1): Log vehicle selections for this publish run.
  // Non-blocking — failure does not affect CORE authorization.
  const mod17 = await logVehicles(date, mod11.slate_board, { workbookId }).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "Full pipeline: Module 17 vehicle log threw — continuing");
      return {
        status: "failure" as const,
        date,
        publish_ts: new Date().toISOString(),
        rows_written: 0,
        rows_skipped: 0,
        errors: [`Vehicle log threw: ${msg}`],
      } satisfies VehicleLogResult;
    },
  );

  // Overall status before archival (so we can write it into the run log row).
  // mod08 "failure" case is already handled by the early return above;
  // at this point mod08.status is "success" | "partial_failure".
  // A module-11 failure (zero board rows written) is a decision-board outage —
  // it must surface as at least partial_success, never success.
  if (mod11.status === "failure" || mod11.slate_board.length === 0) {
    const m11Err = mod11.error ?? "Module 11 produced zero board rows";
    allErrors.push({ module: "11_output_extraction", error: m11Err, timestamp: new Date().toISOString() });
    logger.error({ err: m11Err }, "Full pipeline: Module 11 failed — decision board not produced");
  }

  const overallStatus =
    mod10.status === "failure"
      ? "failure"
      : mod11.status === "failure" || mod11.slate_board.length === 0
        ? "partial_success"
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
    module_08b: mod08b,
    module_08b_preview: previewFetchResult,
    module_09: mod09,
    module_09_shadow: mod12s,
    module_10: mod10,
    module_11: mod11,
    module_12: mod12,
    module_17: mod17,
    workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
    errors: allErrors,
  };
}

// ─── Daily settlement + survival-gate replay ──────────────────────────────────

export interface DailySettlementResult {
  /** "success" — both modules OK; "partial_failure" — one module failed; "failure" — both failed. */
  status: "success" | "partial_failure" | "failure";
  date: string;
  settlement_status: SettlementResult["status"];
  replay_status: SurvivalReplayResult["status"];
  settlement: SettlementResult;
  survival_replay: SurvivalReplayResult;
  /**
   * Block precision: correct_blocks / (correct_blocks + collateral_blocks).
   * Null when the gate blocked no settled OVERs (zero denominator).
   */
  gate_hit_rate_pct: number | null;
  /** Picks that passed the gate but lost — gate's missed blocks. */
  passed_losses: number;
  /** Picks that passed the gate and won. */
  passed_winners: number;
  /** correct_blocks + collateral_blocks; null when no settled blocked OVERs. */
  gate_denominator: number | null;
  /** OVER rows with a known actual total — sample-size gauge for calibration. */
  total_eligible_settled: number;
  errors: string[];
}

/**
 * Runs the end-of-day settlement pipeline for a given date:
 *   1. Module 14: Shadow settlement — pairs SHADOW_HISTORY projections with
 *      actual MLB final scores and appends settled rows to SHADOW_OUTCOMES.
 *   2. Module 18: Survival gate replay — retroactively grades every OVER pick
 *      for the same date against the survival gate and appends results to
 *      SURVIVAL_GATE_REPLAY (idempotent: rows for this date are replaced).
 *
 * The gate hit-rate (correct_blocks / (correct_blocks + collateral_blocks))
 * is logged and returned so operators can track threshold calibration over time.
 *
 * Called automatically after each day's games complete.  Can also be triggered
 * manually via GET /api/pipeline/settle?date=YYYY-MM-DD.
 */
export async function runDailySettlement(
  date: string,
  workbookId: string = WORKBOOK_ID,
): Promise<DailySettlementResult> {
  logger.info({ date, workbookId }, "Daily settlement: starting settlement + survival replay");
  const errors: string[] = [];

  // Step 1 — Shadow settlement (idempotent: already-settled games are skipped)
  const settlement = await runShadowSettlement(date, { workbookId }).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Daily settlement: Module 14 shadow settlement threw");
      errors.push(`settlement: ${msg}`);
      return {
        status: "failure" as const,
        settle_date: date,
        settlement_timestamp_utc: new Date().toISOString(),
        games_found: 0,
        games_settled: 0,
        games_skipped: 0,
        games_no_actual: 0,
        rows: [],
        errors: [msg],
      } satisfies SettlementResult;
    },
  );

  if (settlement.status !== "failure") {
    logger.info(
      { settled: settlement.games_settled, skipped: settlement.games_skipped },
      "Daily settlement: Module 14 complete",
    );
  }

  // Step 2 — Survival gate replay for the same date (append mode: idempotent by date)
  const survival_replay = await runSurvivalGateReplay(date, date, {
    workbookId,
    writeSheets: true,
    appendMode: true,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Daily settlement: Module 18 survival gate replay threw");
    errors.push(`survival_replay: ${msg}`);
    return {
      status: "failure" as const,
      date_range: { start: date, end: date },
      replay_ts: new Date().toISOString(),
      total_overs: 0,
      total_eligible_settled: 0,
      replayed_core: 0,
      replayed_blocked: 0,
      blocked_prior: 0,
      blocked_env_dependent: 0,
      blocked_baseball_edge: 0,
      blocked_floor_edge: 0,
      core_thesis_correct: 0,
      passed_losses: 0,
      correct_blocks: 0,
      collateral_blocks: 0,
      gate_denominator: null,
      rows: [],
      errors: [msg],
    } satisfies SurvivalReplayResult;
  });

  // Derive top-level summary fields from the replay result.
  const gate_denominator    = survival_replay.gate_denominator;
  const gate_hit_rate_pct   = gate_denominator !== null
    ? Math.round((survival_replay.correct_blocks / gate_denominator) * 1000) / 10
    : null;
  const passed_losses       = survival_replay.passed_losses;
  const passed_winners      = survival_replay.core_thesis_correct;
  const total_eligible_settled = survival_replay.total_eligible_settled;

  // Overall status: success only when both modules succeed; failure when both fail.
  const settleFailed = settlement.status === "failure";
  const replayFailed = survival_replay.status === "failure";
  const overallStatus: DailySettlementResult["status"] =
    settleFailed && replayFailed ? "failure"
    : settleFailed || replayFailed ? "partial_failure"
    : "success";

  logger.info(
    {
      date,
      overall_status: overallStatus,
      settlement_status: settlement.status,
      replay_status: survival_replay.status,
      gate_hit_rate_pct,
      gate_denominator,
      passed_losses,
      passed_winners,
      correct_blocks: survival_replay.correct_blocks,
      collateral_blocks: survival_replay.collateral_blocks,
      total_eligible_settled,
      replayed_core: survival_replay.replayed_core,
      replayed_blocked: survival_replay.replayed_blocked,
    },
    "Daily settlement: complete — survival gate hit-rate logged",
  );

  return {
    status: overallStatus,
    date,
    settlement_status: settlement.status,
    replay_status: survival_replay.status,
    settlement,
    survival_replay,
    gate_hit_rate_pct,
    passed_losses,
    passed_winners,
    gate_denominator,
    total_eligible_settled,
    errors,
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
