/**
 * Pipeline Runner
 * Orchestrates all 7 modules and returns the full slate result.
 */

import { getTodayDateStr } from "./config.js";
import { baseGameId, fetchMlbSchedule } from "./module01_mlbStatsApi.js";
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
import { computeAndWriteStatcastShadow, type StatcastShadowResult } from "./module09s_statcastShadow.js";
import { computeAndWriteStarterSurvivalShadow, type StarterSurvivalResult } from "./module09t_starterSurvivalShadow.js";
import { computeAndWriteStarterSurvivalV2Shadow, type StarterSurvivalV2Result } from "./module09u_starterSurvivalV2Shadow.js";
import { computeAndWriteStarterSurvivalDifferentiationAudit, type StarterSurvivalDifferentiationResult } from "./module09v_starterSurvivalDifferentiation.js";
import { logVehicles, runPostmortem, type VehicleLogResult, type PostmortemResult } from "./module17_vehiclePostmortem.js";
import { runShadowSettlement, type SettlementResult } from "./module14_shadowSettlement.js";
import { runRegressionReport, type RegressionReportResult } from "./module15_regressionReport.js";
import { runStarterAudit, type StarterAuditResult } from "./module16_starterAudit.js";
import { runSurvivalGateReplay, type SurvivalReplayResult } from "./module18_survivalGateReplay.js";
import { runCollisionReplayV1, type CollisionReplayResult } from "./module22_collisionReplay.js";
import { runMonotonicityV2, type MonotonicityV2Result } from "./module23_monotonicityV2.js";
import { runPostgameDiagnostics, type PostgameDiagnosticsResult } from "./module24_postgameDiagnostics.js";
import { runDistributionWidthReplay, type DistributionWidthReplayResult } from "./module25_distributionWidthReplay.js";
import {
  runFailureClassificationReplay,
  syncFailureClassificationShadow,
  type FailureClassificationReplayResult,
  type FailureClassificationShadowResult,
} from "./module26_failureClassification.js";
import {
  logDecisionAuditPregame,
  settleDecisionAuditLog,
  type DecisionAuditWriteResult,
} from "./module20_decisionAuditLog.js";
import {
  finalizePregamePacketHistory,
  writePregamePacketHistory,
  type PregamePacketFinalizationResult,
  type PregamePacketResult,
} from "./module20a_pregamePacket.js";
import {
  loadOperatorEvidence,
  syncFullLadderAudit,
  type FullLadderAuditResult,
  type OperatorEvidenceLoadResult,
} from "./module20b_operatorEvidence.js";
import { WORKBOOK_ID } from "../sheets/client.js";
import {
  repairWorkbookSchemaReference,
  type RepairSchemaResult,
} from "../workbook/workbookSetup.js";
import { logger } from "../../lib/logger.js";
import { assertProspectivePublicationAllowed, isAtOrAfterFirstPitch } from "./module00_temporalFirewall.js";
import { buildPublicationProtection, filterMutablePublicationGames } from "./module00_scopedPublication.js";

/** Covers a paced write stage plus one full Google quota-retry window. */
const PROSPECTIVE_WRITE_GUARD_MS = 3 * 60_000;

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
    fetchTeamSplitsWithFallback(date),
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
  /** Module 09s: Statcast shadow audit — per-game xwOBA shadow projection. Shadow-only; no CORE impact. */
  module_09s_statcast_shadow: StatcastShadowResult;
  /** Module 09t: four-state starter-survival challenger. Shadow-only; no board impact. */
  module_09t_starter_survival_shadow: StarterSurvivalResult;
  /** Module 09u: empirical SSAT v2 challenger. Shadow-only; no board impact. */
  module_09u_starter_survival_v2_shadow: StarterSurvivalV2Result;
  /** Module 09v: observational SSAT v1/v2 differentiation audit. */
  module_09v_starter_survival_differentiation: StarterSurvivalDifferentiationResult;
  module_10: Module10Result;
  module_11: Module11Result;
  module_12: Module12Result;
  /** Module 17: Vehicle log — rows written for this publish run */
  module_17: VehicleLogResult;
  /** Module 20: immutable pregame decision-audit snapshot. */
  module_20_decision_audit: DecisionAuditWriteResult;
  /** Module 20a: immutable, self-contained dependent pregame packet. */
  module_20a_pregame_packet: PregamePacketResult;
  /** Module 26: price-blind structural-failure labels derived from the packet only. */
  module_26_failure_classification: FailureClassificationShadowResult;
  /** Module 20b: durable manual/operator evidence and full-total-ladder ledger. */
  module_20b_full_ladder_audit: FullLadderAuditResult;
  /** Schema/reference documentation refreshed from the runtime workbook schema. */
  module_schema_documentation: RepairSchemaResult;
  workbook_url: string;
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

export async function runFullPipeline(dateStr?: string, workbookId = WORKBOOK_ID): Promise<PublishResult> {
  const date = dateStr ?? getTodayDateStr();
  logger.info({ date, workbookId }, "Full pipeline: starting 12-module run");

  // Modules 01–07
  const slate = await runPipeline(date);
  // P0 temporal firewall: partition a staggered slate game-by-game. Started or
  // time-unresolved games are protected and carried forward verbatim; later
  // games remain eligible for prospective refresh. If none remain mutable the
  // guard fails before any workbook write.
  const temporal = assertProspectivePublicationAllowed(slate.games, new Date().toISOString());
  const mutableIds = new Set(temporal.mutable_games);
  const protectedIds = new Set([...temporal.blocked_games, ...temporal.missing_time_games]);
  const mutableGames = slate.games.filter((game) => mutableIds.has(game.legacy_game_id));
  const publicationProtectionNow = () => buildPublicationProtection(
    slate.games,
    new Date().toISOString(),
    PROSPECTIVE_WRITE_GUARD_MS,
  );
  const initialWriteProtection = publicationProtectionNow();
  logger.info({
    mutable_games: mutableGames.length,
    protected_games: protectedIds.size,
    protected_for_next_write: initialWriteProtection.protected_game_ids.size,
    temporal_code: temporal.code,
  }, "Full pipeline: game-granular temporal scope established");
  const normalized = { games: mutableGames, normalization_timestamp_utc: slate.run_timestamp, status: "success" };
  const splits = await fetchTeamSplitsWithFallback(date);

  const allErrors: Array<{ module: string; error: string; timestamp: string }> = [];

  // Module 04b + 04c: Bullpen usage and Starting Nine — fetch in parallel, both non-blocking
  const slateTeamIds = Array.from(
    new Set(
      mutableGames
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
    mutableGames.length > 0
      ? fetchStatcastPreviews(mutableGames, date).catch((err: unknown) => {
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
  const oddsWriteProtection = publicationProtectionNow();
  const oddsMutableIds = new Set(
    slate.games
      .map((game) => game.legacy_game_id)
      .filter((gameId) => !oddsWriteProtection.protected_game_ids.has(gameId)),
  );
  // Odds providers identify a game by date + teams. That is unambiguous for
  // regular games but not for a doubleheader. Route a line only when it maps
  // to exactly one mutable official game; withholding an ambiguous line is
  // safer than attaching Game 1's market to Game 2.
  const scopedOddsLines = oddsResult.lines.flatMap((line) => {
    const matches = slate.games.filter(
      (game) => baseGameId(game.legacy_game_id) === line.game_id
        && oddsMutableIds.has(game.legacy_game_id),
    );
    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.warn(
          { base_game_id: line.game_id, games: matches.map((game) => game.legacy_game_id) },
          "Full pipeline: ambiguous doubleheader market withheld",
        );
      }
      return [];
    }
    return [{ ...line, game_id: matches[0]!.legacy_game_id }];
  });
  const scopedOddsResult = { ...oddsResult, lines: scopedOddsLines };
  const oddsMap = buildOddsMap(scopedOddsResult);
  if (oddsResult.status === "success") {
    logger.info({ lines: oddsMap.size, remaining: oddsResult.requests_remaining }, "Full pipeline: Market odds fetched");
  } else if (oddsResult.status === "error") {
    logger.warn({ err: oddsResult.error }, "Full pipeline: Market odds fetch failed — continuing without lines");
  }
  const lineMovement = await trackLineMovement(scopedOddsResult, workbookId);

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

  // Sources can take long enough for an initially mutable game to enter the
  // prospective write guard before the first Sheets mutation. Scope the feed
  // here, then carry the compatible scope into Module 09.
  const feedWriteProtection = publicationProtectionNow();
  const feedGames = filterMutablePublicationGames(mutableGames, feedWriteProtection);
  const feedNormalized = { ...normalized, games: feedGames };

  // Module 08: Write feeds to Google Sheets
  const mod08 = await writeGoogleSheetsFeed(
    feedNormalized as Parameters<typeof writeGoogleSheetsFeed>[0],
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
    feedWriteProtection,
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
      module_09s_statcast_shadow: { status: "skipped", write_timestamp_utc: new Date().toISOString(), rows_computed: 0, rows_written: 0, collision_history_rows_written: 0, errors: ["Skipped: Module 08 failed"], shadow_rows: [] },
      module_09t_starter_survival_shadow: { status: "partial", rows_computed: 0, rows_written: 0, errors: ["Skipped: Module 08 failed"], rows: [] },
      module_09u_starter_survival_v2_shadow: { status: "partial", rows_computed: 0, rows_written: 0, errors: ["Skipped: Module 08 failed"], rows: [] },
      module_09v_starter_survival_differentiation: { status: "partial", rows_written: 0, errors: ["Skipped: Module 08 failed"], rows: [] },
      module_10: { status: "failure", seeding_timestamp_utc: new Date().toISOString(), games_seeded: { new_games: 0, updated_games: 0, total_games: 0 }, rows_written: 0, seed_results: [], errors: [{ module: "10", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      module_11: { status: "failure", extraction_timestamp_utc: new Date().toISOString(), slate_board: [], active_board_snapshot: [], core_count: 0, no_core_count: 0, core_auth_status: "DISABLED_MONOTONICITY_NOT_COMPUTED", monotonicity_verdict: null, monotonicity_override_active: false, publication_validation: { status: "FAIL", expected_games: 0, board_games: 0, slate_input_games: 0, active_games: 0, errors: ["Skipped: Module 08 failed"] }, error: "Skipped: Module 08 failed" },
      module_12: { status: "failure", archival_timestamp_utc: new Date().toISOString(), bundle_name: `${date}_v01`, bundle_folder_id: "", files_archived: {}, errors: [{ module: "12", error: "Skipped: Module 08 failed", timestamp: new Date().toISOString() }] },
      module_17: { status: "failure", date, publish_ts: new Date().toISOString(), rows_written: 0, rows_skipped: 0, errors: ["Skipped: Module 08 failed"] },
      module_20_decision_audit: { status: "failure", phase: "pregame", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0, duplicates_removed: 0, audit_gaps: 0, warnings: [], errors: ["Skipped: Module 08 failed"] },
      module_20a_pregame_packet: { status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_skipped_after_first_pitch: 0, warnings: [], errors: ["Skipped: Module 08 failed"] },
      module_26_failure_classification: { status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen_preserved: 0, packets_ineligible: 0, warnings: [], errors: ["Skipped: Module 08 failed"] },
      module_20b_full_ladder_audit: { status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, warnings: [], errors: ["Skipped: Module 08 failed"] },
      module_schema_documentation: {
        workbook_id: workbookId,
        schema_reference_rows: 0,
        readme_rows: 0,
        model_input_catalog_rows: 0,
        source_freshness_gaps: [],
        errors: [{ step: "schema_documentation", error: "Skipped: Module 08 failed" }],
      },
      workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
      errors: [...mod08.errors],
    };
  }

  // Module 08b: Write STATCAST_GAME_PREVIEW sheet — fail-open, runs before module 09
  const previewFetchResult: StatcastPreviewResult = statcastPreviewFetch ?? {
    status: "failure",
    fetch_timestamp: new Date().toISOString(),
    games_expected: mutableGames.length,
    games_available: 0,
    games_parsed: 0,
    games_missing: 0,
    games_failed: mutableGames.length,
    games_identity_mismatch: 0,
    games: [],
  };
  const mod08b = await writeStatcastPreviewFeed(previewFetchResult, workbookId, publicationProtectionNow()).catch(
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
  // Re-check at the calculation boundary. Games that entered the guard while
  // feeds were written retain any legitimate earlier source row, but receive
  // no new projection or prospective snapshot.
  const recalculationProtection = publicationProtectionNow();
  const recalculationGames = filterMutablePublicationGames(feedGames, recalculationProtection);
  const recalculationNormalized = { ...feedNormalized, games: recalculationGames };
  const mod09 = await verifyRecalculation(
    recalculationNormalized as Parameters<typeof verifyRecalculation>[0],
    splits,
    workbookId,
    pitcherSeasonStats?.stats ?? new Map(),
    bullpenResult,
    teamRunRates,
    startingNineResult,
    batterSeasonStats?.stats ?? new Map(),
    rosterNameMap ?? new Map(),
    statcastBatterStats?.stats ?? new Map(),
    recalculationProtection,
  );
  if (mod09.status === "error") {
    const mod09Errors = [
      ...mod09.checks.game_integration.formula_errors,
      ...mod09.checks.game_summary.formula_errors,
    ];
    allErrors.push({
      module: "09_recalculation",
      error: mod09Errors.join("; ") || "Module 09 projection lineage validation failed",
      timestamp: new Date().toISOString(),
    });
    logger.error({ errors: mod09Errors }, "Full pipeline: Module 09 failed semantic write validation");
  }

  // Module 09s: Statcast shadow audit — per-game xwOBA shadow projection.
  // Fail-open; shadow-only (no live board or CORE impact).
  const mod09s = await computeAndWriteStatcastShadow(
    mod09.game_summary_rows,
    previewFetchResult,
    workbookId,
    publicationProtectionNow(),
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Full pipeline: Module 09s shadow audit threw — continuing");
    return {
      status: "partial" as const,
      write_timestamp_utc: new Date().toISOString(),
      rows_computed: 0,
      rows_written: 0,
      collision_history_rows_written: 0,
      errors: [`Module 09s threw: ${msg}`],
      shadow_rows: [],
    } satisfies StatcastShadowResult;
  });

  // Module 09t is a prospective-only calibration challenger. It writes no
  // active projection, authorization, vehicle, or market field.
  const mod09t = await computeAndWriteStarterSurvivalShadow(
    mod09.game_summary_rows,
    previewFetchResult,
    workbookId,
    publicationProtectionNow(),
    new Map(recalculationGames.map((game) => [game.legacy_game_id, game.scheduled_utc_time])),
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Full pipeline: Module 09t starter survival shadow threw — continuing");
    return {
      status: "partial" as const,
      rows_computed: 0,
      rows_written: 0,
      errors: [`Module 09t threw: ${msg}`],
      rows: [],
    } satisfies StarterSurvivalResult;
  });

  // Module 09u is SSAT v2. It calibrates only from strictly earlier settled
  // observations and writes a standalone history surface. It is not an input
  // to Module 09, Module 11, vehicle selection, or authorization.
  const mod09u = await computeAndWriteStarterSurvivalV2Shadow(
    mod09.game_summary_rows,
    recalculationGames,
    workbookId,
    publicationProtectionNow(),
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Full pipeline: Module 09u starter survival v2 shadow threw — continuing");
    return {
      status: "partial" as const,
      rows_computed: 0,
      rows_written: 0,
      errors: [`Module 09u threw: ${msg}`],
      rows: [],
    } satisfies StarterSurvivalV2Result;
  });

  // Module 09v measures whether v2 differs from v1 enough to deserve a
  // separate interpretive vote. It is observational only and is intentionally
  // not an input to any projection, vehicle, market, or authorization module.
  const mod09v = await computeAndWriteStarterSurvivalDifferentiationAudit(
    mod09u.rows,
    date,
    workbookId,
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Full pipeline: Module 09v SSAT differentiation audit threw — continuing");
    return {
      status: "partial" as const,
      rows_written: 0,
      errors: [`Module 09v threw: ${msg}`],
      rows: [],
    } satisfies StarterSurvivalDifferentiationResult;
  });

  // Module 12s: Shadow validation — compare repaired vs legacy projection per game.
  // Runs after every full publish; does not affect CORE authorization.
  const mod12s = await runShadowValidation(mod09.game_summary_rows, workbookId, publicationProtectionNow()).catch(
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
  const mod10 = await seedSlateInput(
    recalculationNormalized as Parameters<typeof seedSlateInput>[0],
    workbookId,
    oddsMap,
    publicationProtectionNow(),
  );
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
  const mod11 = await extractOutputBoards(
    mod09.game_summary_rows,
    workbookId,
    rotowireProps,
    recalculationNormalized.games,
    publicationProtectionNow(),
  );

  // Module 17 (phase 1): Log vehicle selections for this publish run.
  // Non-blocking — failure does not affect CORE authorization.
  const publishVehicleLog = async (): Promise<VehicleLogResult> => {
    const currentProtection = publicationProtectionNow();
    const publishableBoard = mod11.slate_board.filter(
      (entry) => !currentProtection.protected_game_ids.has(entry.legacy_game_id),
    );
    return logVehicles(date, publishableBoard, { workbookId }).catch(
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
  };

  // Module 20 (pregame): required decision-learning ledger. It observes the
  // already-computed model/board state and never feeds back into projections,
  // gates, board decisions, or lock state.
  const decisionAuditProtection = publicationProtectionNow();
  const decisionAuditCheckedAt = new Date().toISOString();
  // The three-minute write guard also protects games that are merely close to
  // first pitch. Those remain legitimate OPEN rows, not audit gaps. Only an
  // actual first-pitch crossing (or a missing time) can create an AUDIT_GAP.
  const auditGapGameIds = new Set(
    slate.games
      .filter((game) => decisionAuditProtection.protected_game_ids.has(game.legacy_game_id))
      .filter((game) => !game.scheduled_utc_time || isAtOrAfterFirstPitch(game.scheduled_utc_time, decisionAuditCheckedAt))
      .map((game) => game.legacy_game_id),
  );
  const mod20 = await logDecisionAuditPregame(
    date,
    mod11.slate_board,
    mod09.game_summary_rows,
    slate.games,
    previewFetchResult,
    {
      workbookId,
      // A board row may be absent because the game was already protected when
      // this run began. Record that absence as an AUDIT_GAP after first pitch;
      // do not manufacture a late projection or board row to fill it.
      protectedGameIds: auditGapGameIds,
    },
  ).catch((err: unknown): DecisionAuditWriteResult => {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "failure", phase: "pregame", date,
      rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0,
      duplicates_removed: 0, audit_gaps: 0, warnings: [], errors: [msg],
    };
  });
  if (mod20.status !== "success") {
    allErrors.push({
      module: "20_decision_audit_pregame",
      error: mod20.errors.join("; ") || "Decision audit pregame write failed",
      timestamp: new Date().toISOString(),
    });
  }

  // One self-contained packet preserves the exact state held by all dependent
  // pregame surfaces. It must exist before vehicle publication, otherwise a
  // later settlement could only see fragments of a valid board decision.
  // Packet lifecycle must not depend on whether the decision-audit writer had
  // fresh board rows for every protected game.  A delayed first post-start run
  // often has no mutable TEX-CHW-style board input, but it may still hold a
  // legitimate OPEN_PROSPECTIVE packet that must be promoted unchanged.  The
  // packet writer only reads its own stored pre-first-pitch snapshot for that
  // transition; it never copies current/live inputs into a protected game.
  const operatorEvidence: OperatorEvidenceLoadResult = await loadOperatorEvidence(
    date,
    slate.games,
    { workbookId },
  ).catch((err: unknown): OperatorEvidenceLoadResult => {
    const msg = err instanceof Error ? err.message : String(err);
    allErrors.push({ module: "20b_operator_evidence", error: msg, timestamp: new Date().toISOString() });
    return { snapshots: new Map(), warnings: [`OPERATOR_EVIDENCE_UNAVAILABLE: ${msg}`] };
  });
  for (const warning of operatorEvidence.warnings) {
    logger.warn({ warning }, "Full pipeline: Module 20b operator evidence warning");
  }

  const mod20a: PregamePacketResult = await writePregamePacketHistory(
    date,
    mod09.game_summary_rows,
    mod11.slate_board,
    slate.games,
    mod09s.shadow_rows,
    mod09t.rows,
    mod09u.rows,
    { workbookId, operatorEvidenceByGame: operatorEvidence.snapshots },
  );
  if (mod20a.status !== "success") {
    allErrors.push({
      module: "20a_pregame_packet",
      error: mod20a.errors.join("; ") || "Pregame packet write failed",
      timestamp: new Date().toISOString(),
    });
  }

  // Module 26 is an explicitly price-blind, shadow-only classification of the
  // pregame packet. It cannot feed projection math, market comparison, board
  // authorization, or vehicle publication. It runs after packet capture so
  // every label is traceable to the exact stored pre-first-pitch state.
  const mod26 = mod20a.status === "success"
    ? await syncFailureClassificationShadow(date, { workbookId })
    : {
      status: "failure" as const,
      date,
      rows_written: 0,
      rows_updated: 0,
      rows_frozen_preserved: 0,
      packets_ineligible: 0,
      warnings: [],
      errors: ["Failure classification blocked: pregame packet write did not complete"],
    } satisfies FailureClassificationShadowResult;
  if (mod26.status !== "success") {
    allErrors.push({
      module: "26_failure_classification",
      error: mod26.errors.join("; ") || "Failure classification shadow write failed",
      timestamp: new Date().toISOString(),
    });
  }

  // This is a shadow-only, immutable record of the price-blind manual full
  // total ladder. It uses the packet just written above, never current/live
  // game state, and does not participate in projection or authorization.
  const mod20b: FullLadderAuditResult = mod20a.status === "success"
    ? await syncFullLadderAudit(date, { workbookId })
    : {
      status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen: 0,
      warnings: [], errors: ["Full ladder audit blocked: pregame packet write did not complete"],
    };
  if (mod20b.status !== "success") {
    allErrors.push({
      module: "20b_full_ladder_audit",
      error: mod20b.errors.join("; ") || "Full ladder audit write failed",
      timestamp: new Date().toISOString(),
    });
  }

  // Keep the in-workbook road map and column reference synchronized with the
  // runtime schema during ordinary pregame publication as well as settlement.
  // This metadata write is idempotent and never touches game-state tabs.
  const schemaDocumentation = await repairWorkbookSchemaReference(workbookId, date).catch(
    (err: unknown): RepairSchemaResult => {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        workbook_id: workbookId,
        schema_reference_rows: 0,
        readme_rows: 0,
        model_input_catalog_rows: 0,
        source_freshness_gaps: [],
        errors: [{ step: "schema_documentation", error: msg }],
      };
    },
  );
  if (schemaDocumentation.errors.length > 0) {
    allErrors.push({
      module: "schema_documentation",
      error: schemaDocumentation.errors
        .map(({ step, error }) => `${step}: ${error}`)
        .join("; "),
      timestamp: new Date().toISOString(),
    });
  }

  // Publish the immutable vehicle record only after the coherent audit and
  // full dependent packet freeze. This enforces projection -> decision ->
  // packet freeze -> vehicle publication chronology.
  const mod17: VehicleLogResult = mod20.status === "success" && mod20a.status === "success"
    ? await publishVehicleLog()
    : {
      status: "failure",
      date,
      publish_ts: new Date().toISOString(),
      rows_written: 0,
      rows_skipped: mod11.slate_board.length,
      errors: ["Vehicle publication blocked: decision-audit or pregame-packet freeze did not complete"],
    };

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
      : mod09.status === "error" || mod11.status === "failure" || mod11.slate_board.length === 0 || mod20.status !== "success" || mod20a.status !== "success" || mod20b.status !== "success" || schemaDocumentation.errors.length > 0
        ? "partial_success"
        : mod08.status === "partial_failure"
          ? "partial_success"
          : "success";

  // Module 12: Append run log row to RUN_LOG sheet (non-blocking — failure is advisory)
  const mod12 = await archiveRunBundle(
    slate, mod08, mod09, mod10, mod11, overallStatus, 1, workbookId,
    previewFetchResult,
    {
      mutable_games_at_start: mutableGames.length,
      protected_games_at_start: protectedIds.size,
      feed_writable_games: feedGames.length,
      projection_writable_games: recalculationGames.length,
      audit_gap_games: mod20.audit_gaps,
    },
  );
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
    module_09s_statcast_shadow: mod09s,
    module_09t_starter_survival_shadow: mod09t,
    module_09u_starter_survival_v2_shadow: mod09u,
    module_09v_starter_survival_differentiation: mod09v,
    module_10: mod10,
    module_11: mod11,
    module_12: mod12,
    module_17: mod17,
    module_20_decision_audit: mod20,
    module_20a_pregame_packet: mod20a,
    module_26_failure_classification: mod26,
    module_20b_full_ladder_audit: mod20b,
    module_schema_documentation: schemaDocumentation,
    workbook_url: `https://docs.google.com/spreadsheets/d/${workbookId}`,
    errors: allErrors,
  };
}

// ─── Daily settlement + survival-gate replay ──────────────────────────────────

export interface DailySettlementResult {
  /** Success requires every settlement and postgame-diagnostic module to complete. */
  status: "success" | "partial_failure" | "failure";
  date: string;
  settlement_status: SettlementResult["status"];
  regression_status: RegressionReportResult["status"];
  starter_audit_status: StarterAuditResult["status"];
  postmortem_status: PostmortemResult["status"];
  replay_status: SurvivalReplayResult["status"];
  collision_replay_status: CollisionReplayResult["status"];
  monotonicity_v2_status: MonotonicityV2Result["status"];
  decision_audit_status: DecisionAuditWriteResult["status"];
  postgame_diagnostics_status: PostgameDiagnosticsResult["status"];
  distribution_width_replay_status: DistributionWidthReplayResult["status"];
  failure_classification_status: FailureClassificationShadowResult["status"];
  failure_classification_replay_status: FailureClassificationReplayResult["status"];
  packet_finalization_status: PregamePacketFinalizationResult["status"];
  full_ladder_sync_status: FullLadderAuditResult["status"];
  /** Schema documentation is refreshed by pregame publication, never settlement. */
  schema_documentation_status: "not_run";
  settlement: SettlementResult;
  regression: RegressionReportResult;
  starter_audit: StarterAuditResult;
  vehicle_postmortem: PostmortemResult;
  survival_replay: SurvivalReplayResult;
  collision_replay: CollisionReplayResult;
  monotonicity_v2: MonotonicityV2Result;
  decision_audit: DecisionAuditWriteResult;
  postgame_diagnostics: PostgameDiagnosticsResult;
  distribution_width_replay: DistributionWidthReplayResult;
  failure_classification: FailureClassificationShadowResult;
  failure_classification_replay: FailureClassificationReplayResult;
  packet_finalization: PregamePacketFinalizationResult;
  full_ladder_sync: FullLadderAuditResult;
  schema_documentation: RepairSchemaResult;
  module_statuses: Array<{ module: string; status: string }>;
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
 * Runs the end-of-day settlement feedback loop for a given date:
 *   1. Module 14 records final scores and actual pitching provenance.
 *   2. Module 20 appends actuals and grades the frozen reasoning ledger.
 *   3. Module 15 refreshes regression and calibration output.
 *   4. Module 16 audits the actual starters who appeared.
 *   5. Module 17 grades the frozen vehicle decisions.
 *   6. Module 18 replays the survival gate.
 *   7. Module 22 aggregates only preserved collision candidates for replay.
 *   8. Module 23 records a shadow-only edge-magnitude calibration and replay.
 *   9. Module 24 writes frozen-packet game-truth diagnostics.
 *  10. Module 25 replays frozen uncertainty evidence against realized error
 *      width. It remains research-only and never produces a live adjustment.
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
  logger.info({ date, workbookId }, "Daily settlement: starting complete feedback loop");
  const errors: string[] = [];

  // Settlement may only complete the lifecycle of a packet that was already
  // written before first pitch. It never refreshes or reconstructs pregame
  // evidence from current, live, or final-game surfaces.
  const packet_finalization = await finalizePregamePacketHistory(date, { workbookId }).catch(
    (err: unknown): PregamePacketFinalizationResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`packet_finalization: ${msg}`);
      return { status: "failure", date, rows_frozen: 0, rows_rejected: 0, warnings: [], errors: [msg] };
    },
  );

  // A ladder is a dependent pregame artifact. Once its backing packet freezes,
  // expose only the already-stored prospective record; settlement never creates
  // or fills a ladder after results are known.
  const full_ladder_sync = await syncFullLadderAudit(date, { workbookId }).catch(
    (err: unknown): FullLadderAuditResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`full_ladder_sync: ${msg}`);
      return { status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, warnings: [], errors: [msg] };
    },
  );

  // Promote only the already-stored pregame packet, then refresh its
  // price-blind failure labels. This never reads current game state or results.
  const failure_classification = await syncFailureClassificationShadow(date, { workbookId }).catch(
    (err: unknown): FailureClassificationShadowResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`failure_classification: ${msg}`);
      return {
        status: "failure", date, rows_written: 0, rows_updated: 0,
        rows_frozen_preserved: 0, packets_ineligible: 0, warnings: [], errors: [msg],
      };
    },
  );

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
        games_updated: 0,
        games_skipped: 0,
        games_no_actual: 0,
        games_provenance_incomplete: 0,
        rows: [],
        warnings: [],
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

  // Module 22 reads the collision settlement report written by Module 14.
  // It is a shadow-only aggregate and cannot alter any pregame artifact.
  const collision_replay = await runCollisionReplayV1({ workbookId }).catch((err: unknown): CollisionReplayResult => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`collision_replay: ${msg}`);
    return { status: "failure", report_timestamp_utc: new Date().toISOString(), source_rows: 0, eligible_games: 0, rows: [], errors: [msg] };
  });

  // Module 23 is a separate shadow experiment: UNVERIFIED is informational,
  // never an authorization veto. It reads frozen vehicle/outcome records only.
  const monotonicity_v2 = await runMonotonicityV2({ workbookId }).catch((err: unknown): MonotonicityV2Result => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`monotonicity_v2: ${msg}`);
    return { status: "failure", report_timestamp_utc: new Date().toISOString(), eligible_games: 0, summaries: [], replay_rows: [], errors: [msg] };
  });

  const decision_audit = await settleDecisionAuditLog(date, settlement.rows, { workbookId }).catch(
    (err: unknown): DecisionAuditWriteResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`decision_audit: ${msg}`);
      return {
        status: "failure", phase: "settlement", date,
        rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0,
        duplicates_removed: 0, audit_gaps: 0, warnings: [], errors: [msg],
      };
    },
  );

  // Module 24 is observational only: it joins the frozen packet to official
  // final detail so allocation, starter, bullpen, and full-ladder learning no
  // longer depends on conversation memory or a repaired projection.
  const postgame_diagnostics = await runPostgameDiagnostics(date, settlement.rows, { workbookId }).catch(
    (err: unknown): PostgameDiagnosticsResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`postgame_diagnostics: ${msg}`);
      return {
        status: "failure", date, allocation_rows_written: 0, starter_rows_written: 0,
          timing_rows_written: 0, conversion_rows_written: 0, game_truth_rows_written: 0,
          ladder_rows_written: 0, frozen_packet_games: 0,
        warnings: [], errors: [msg],
      };
    },
  );

  // Module 25 replays the complete frozen-packet history, including the
  // current Module 24 rows, to test conditional error width without changing
  // any current projection, distribution, or decision output.
  const distribution_width_replay = await runDistributionWidthReplay({ workbookId }).catch(
    (err: unknown): DistributionWidthReplayResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`distribution_width_replay: ${msg}`);
      return {
        status: "failure",
        replay_timestamp_utc: new Date().toISOString(),
        frozen_packets_seen: 0,
        eligible_games: 0,
        replay_rows_written: 0,
        summary_rows_written: 0,
        warnings: [],
        errors: [msg],
      };
    },
  );

  // Module 26 consumes its own immutable labels and the canonical Module 24
  // game-truth replay. It is descriptive evidence only and cannot issue a
  // projection, market, vehicle, or authorization change.
  const failure_classification_replay = await runFailureClassificationReplay({ workbookId }).catch(
    (err: unknown): FailureClassificationReplayResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`failure_classification_replay: ${msg}`);
      return {
        status: "failure", replay_timestamp_utc: new Date().toISOString(),
        frozen_classifications_seen: 0, eligible_games: 0, replay_rows_written: 0,
        snapshot_mismatches: 0, warnings: [], errors: [msg],
      };
    },
  );

  // Steps 2-4 consume the outcome snapshot and write their audit sheets.
  const regression = await runRegressionReport({ workbookId, writeSheets: true }).catch(
    (err: unknown): RegressionReportResult => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`regression: ${msg}`);
      return {
        status: "failure", report_timestamp_utc: new Date().toISOString(),
        total_outcomes: 0, windows: [], monotonicity: null, errors: [msg],
      };
    },
  );

  const starter_audit = await runStarterAudit({
    workbookId,
    writeSheets: true,
    minGames: 1,
  }).catch((err: unknown): StarterAuditResult => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`starter_audit: ${msg}`);
    return {
      status: "failure", audit_timestamp_utc: new Date().toISOString(),
      total_settled_games: 0, pitchers_audited: 0, flagged_pitchers: 0,
      rows: [], errors: [msg],
    };
  });

  const vehicle_postmortem = await runPostmortem(date, {
    workbookId,
    writeSheets: true,
  }).catch((err: unknown): PostmortemResult => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`vehicle_postmortem: ${msg}`);
    return {
      status: "failure", graded_date: date, graded_ts: new Date().toISOString(),
      games_graded: 0, games_no_outcome: 0,
      core_bets: 0, core_covered: 0, core_missed: 0, core_push: 0,
      thesis_correct_pct: null, rows: [], errors: [msg],
    };
  });

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

  // Settlement grades immutable prospective evidence. Schema/reference and
  // catalog refreshes belong to the pregame publication or explicit repair
  // path; running them here adds mutable work and can exhaust Sheets read
  // quota after every settlement module has already completed.
  const schema_documentation_status = "not_run" as const;
  const schema_documentation: RepairSchemaResult = {
    workbook_id: workbookId,
    schema_reference_rows: 0,
    readme_rows: 0,
    model_input_catalog_rows: 0,
    source_freshness_gaps: [],
    errors: [],
  };

  // Derive top-level summary fields from the replay result.
  const gate_denominator    = survival_replay.gate_denominator;
  const gate_hit_rate_pct   = gate_denominator !== null
    ? Math.round((survival_replay.correct_blocks / gate_denominator) * 1000) / 10
    : null;
  const passed_losses       = survival_replay.passed_losses;
  const passed_winners      = survival_replay.core_thesis_correct;
  const total_eligible_settled = survival_replay.total_eligible_settled;

  // Overall status is fail-closed: every module must report success.
  const module_statuses = [
    { module: "MODULE_20A_PACKET_FINALIZATION", status: packet_finalization.status },
    { module: "MODULE_20B_FULL_LADDER_FREEZE", status: full_ladder_sync.status },
    { module: "MODULE_14_SHADOW_SETTLEMENT", status: settlement.status },
    { module: "MODULE_15_REGRESSION_REPORT", status: regression.status },
    { module: "MODULE_16_STARTER_AUDIT", status: starter_audit.status },
    { module: "MODULE_17_VEHICLE_POSTMORTEM", status: vehicle_postmortem.status },
    { module: "MODULE_18_SURVIVAL_GATE_REPLAY", status: survival_replay.status },
    { module: "MODULE_22_COLLISION_REPLAY_V1", status: collision_replay.status },
    { module: "MODULE_23_MONOTONICITY_V2", status: monotonicity_v2.status },
    { module: "MODULE_20_DECISION_AUDIT_SETTLEMENT", status: decision_audit.status },
    { module: "MODULE_24_POSTGAME_DIAGNOSTICS", status: postgame_diagnostics.status },
    { module: "MODULE_25_DISTRIBUTION_WIDTH_REPLAY", status: distribution_width_replay.status },
    { module: "MODULE_26_FAILURE_CLASSIFICATION", status: failure_classification.status },
    { module: "MODULE_26_FAILURE_CLASSIFICATION_REPLAY", status: failure_classification_replay.status },
  ];
  errors.push(...packet_finalization.errors.map((message) => `packet_finalization: ${message}`));
  errors.push(...full_ladder_sync.errors.map((message) => `full_ladder_sync: ${message}`));
  errors.push(...settlement.errors.map((message) => `settlement: ${message}`));
  errors.push(...regression.errors.map((message) => `regression: ${message}`));
  errors.push(...starter_audit.errors.map((message) => `starter_audit: ${message}`));
  errors.push(...vehicle_postmortem.errors.map((message) => `vehicle_postmortem: ${message}`));
  errors.push(...survival_replay.errors.map((message) => `survival_replay: ${message}`));
  errors.push(...collision_replay.errors.map((message) => `collision_replay: ${message}`));
  errors.push(...monotonicity_v2.errors.map((message) => `monotonicity_v2: ${message}`));
  errors.push(...decision_audit.errors.map((message) => `decision_audit: ${message}`));
  errors.push(...postgame_diagnostics.errors.map((message) => `postgame_diagnostics: ${message}`));
  errors.push(...distribution_width_replay.errors.map((message) => `distribution_width_replay: ${message}`));
  errors.push(...failure_classification.errors.map((message) => `failure_classification: ${message}`));
  errors.push(...failure_classification_replay.errors.map((message) => `failure_classification_replay: ${message}`));

  const failedCount = module_statuses.filter((module) => module.status === "failure").length;
  const incompleteCount = module_statuses.filter((module) => module.status !== "success").length;
  const overallStatus: DailySettlementResult["status"] =
    incompleteCount === 0 ? "success"
    : failedCount === module_statuses.length ? "failure"
    : "partial_failure";

  logger.info(
    {
      date,
      overall_status: overallStatus,
      settlement_status: settlement.status,
      regression_status: regression.status,
      starter_audit_status: starter_audit.status,
      postmortem_status: vehicle_postmortem.status,
      replay_status: survival_replay.status,
      collision_replay_status: collision_replay.status,
      monotonicity_v2_status: monotonicity_v2.status,
      decision_audit_status: decision_audit.status,
      postgame_diagnostics_status: postgame_diagnostics.status,
      distribution_width_replay_status: distribution_width_replay.status,
      failure_classification_status: failure_classification.status,
      failure_classification_replay_status: failure_classification_replay.status,
      packet_finalization_status: packet_finalization.status,
      full_ladder_sync_status: full_ladder_sync.status,
      schema_documentation_status,
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
    regression_status: regression.status,
    starter_audit_status: starter_audit.status,
    postmortem_status: vehicle_postmortem.status,
    replay_status: survival_replay.status,
    collision_replay_status: collision_replay.status,
    monotonicity_v2_status: monotonicity_v2.status,
    decision_audit_status: decision_audit.status,
    postgame_diagnostics_status: postgame_diagnostics.status,
    distribution_width_replay_status: distribution_width_replay.status,
    failure_classification_status: failure_classification.status,
    failure_classification_replay_status: failure_classification_replay.status,
    packet_finalization_status: packet_finalization.status,
    full_ladder_sync_status: full_ladder_sync.status,
    schema_documentation_status,
    settlement,
    regression,
    starter_audit,
    vehicle_postmortem,
    survival_replay,
    collision_replay,
    monotonicity_v2,
    decision_audit,
    postgame_diagnostics,
    distribution_width_replay,
    failure_classification,
    failure_classification_replay,
    packet_finalization,
    full_ladder_sync,
    schema_documentation,
    module_statuses,
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
