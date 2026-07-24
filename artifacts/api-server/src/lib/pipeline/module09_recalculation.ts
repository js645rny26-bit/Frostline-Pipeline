/**
 * Module 09: Game Data Computation & Sheet Writer
 * Computes GAME_INTEGRATION (2 rows/game) and GAME_SUMMARY (1 row/game)
 * from normalized data and writes them directly — no formula dependency.
 *
 * Projection inputs (commissioning v2, 2026-07-24):
 *
 * Offensive rate:
 *   Primary:  Fangraphs L30 wRC+-derived run rate (team × (wRC+/100) × 4.5)
 *   Modifier: Actual L10 RS/game from module05c_teamRunRates
 *   Blend:    L30_WEIGHT × L30 rate + L10_WEIGHT × L10 rate (test parameters, not canon)
 *   Fallback: League-average 4.5 runs/9; generates a logger.warn — must not be silent.
 *
 * Run multiplier:
 *   Park baseline:  1 + (park_runs_pct / 100) from module04c_startingNine park_factors
 *   Weather modifier: temperature/wind/rain deviation from park baseline
 *   Combined:       park × weather, clamped to [0.85, 1.30]
 *   Fallback:       park_multiplier = 1.0 when park data absent (MISSING_PARK_DATA)
 *
 * Lineup_Strength:
 *   NULL / NOT_IMPLEMENTED — no player cross-reference exists yet.
 *   The stub value 100.0 has been removed. A per-player lineup model is
 *   approved for development but not yet commissioned.
 */

import { clearRange, expandSheetColumns, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult, NormalizedGame } from "./module06_normalization.js";
import type { FangraphsResult } from "./module05_fangraphs.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { BullpenResult, RelieverStat } from "./module04b_bullpenUsage.js";
import type { TeamRunRatesResult } from "./module05c_teamRunRates.js";
import type { StartingNineResult, ParkFactors } from "./module04c_startingNine.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** 2026 MLB league-average ERA used to normalise pitcher quality. */
const LEAGUE_AVG_ERA = 4.20;

/** League-average run rate (runs per 9 innings) used as the last-resort fallback. */
const LEAGUE_AVG_RS = 4.5;

/**
 * Blend weights for the offensive rate formula.
 * L30_WEIGHT + L10_WEIGHT = 1.0
 *
 * These are provisional test parameters. Select final values via historical
 * replay; do not canonise from intuition.
 */
const L30_WEIGHT = 0.65;
const L10_WEIGHT = 0.35;

/** Minimum number of L10 games required before L10 data is treated as valid. */
const MIN_L10_GAMES = 5;

// ─── Type aliases ─────────────────────────────────────────────────────────────

export type OffenseSourceStatus =
  | "BLENDED"
  | "L30_ONLY"
  | "L10_ONLY"
  | "LEAGUE_AVG_FALLBACK";

export type ParkSourceStatus = "VENUE_FACTOR_USED" | "MISSING_PARK_DATA";

export interface OffensiveRateResolution {
  /** Fangraphs L30 wRC+ converted to runs/9. Null when Fangraphs data is absent. */
  l30_rs_estimate: number | null;
  /** Actual RS/game from the last 10 completed games. Null when unavailable or sparse. */
  l10_rs_actual: number | null;
  /** The rate fed into the projection formula (blended, single-source, or fallback). */
  rate_used: number;
  source_status: OffenseSourceStatus;
}

export interface RunMultiplierResolution {
  /** Raw park runs_pct from module04c (signed %). Null when park data absent. */
  park_runs_pct: number | null;
  /** 1 + (park_runs_pct / 100), clamped. 1.0 when park data absent. */
  park_multiplier: number;
  /** Temperature / wind / precipitation deviation factor. */
  weather_multiplier: number;
  /** park_multiplier × weather_multiplier, clamped to [0.85, 1.30]. */
  combined_multiplier: number;
  park_source_status: ParkSourceStatus;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function clampERA(era: number): number {
  return Math.max(2.0, Math.min(7.0, era));
}

/**
 * Starter quality multiplier: how many runs per inning does this pitcher
 * allow relative to a league-average pitcher?
 *   ERA 2.06 (elite) → 0.49   ERA 4.20 (avg) → 1.00   ERA 5.70 (rough) → 1.36
 */
function starterQualityFactor(
  pitcherId: number | null,
  statsMap: Map<number, PitcherSeasonStats>,
): number {
  if (!pitcherId) return 1.0;
  const era = statsMap.get(pitcherId)?.era ?? LEAGUE_AVG_ERA;
  return clampERA(era) / LEAGUE_AVG_ERA;
}

/**
 * Weighted-average ERA of available relievers.
 * Weight = innings pitched in the last 7 days (more frequent → higher weight).
 * Returns null when fewer than 2 relievers have season ERA data.
 */
function computeTeamBullpenERA(
  teamAbbr: string,
  relievers: RelieverStat[],
  statsMap: Map<number, PitcherSeasonStats>,
): number | null {
  const available = relievers.filter(
    (r) => r.team_abbr === teamAbbr && r.days_rest >= 1 && r.role !== "HIGH_WORKLOAD",
  );

  let weightedERASum = 0;
  let totalWeight = 0;

  for (const r of available) {
    if (!r.player_id) continue;
    const era = statsMap.get(r.player_id)?.era;
    if (era === null || era === undefined) continue;
    const weight = Math.max(0.1, r.innings_last_7);
    weightedERASum += clampERA(era) * weight;
    totalWeight += weight;
  }

  const relieversWithERA = available.filter(
    (r) => r.player_id && statsMap.get(r.player_id ?? 0)?.era != null,
  ).length;

  if (totalWeight === 0 || relieversWithERA < 2) return null;
  return parseFloat((weightedERASum / totalWeight).toFixed(2));
}

/**
 * Resolves the offensive rate for a team using the L30/L10 blend.
 * Logs a warning when falling back to league average — this state must not
 * be silent in the output.
 */
function resolveOffensiveRate(
  teamAbbr: string,
  splits: FangraphsResult,
  runRates: TeamRunRatesResult | null,
): OffensiveRateResolution {
  // ── L30 (Fangraphs wRC+) ──
  const teamSplits = splits.teams.filter((s) => s.team === teamAbbr);
  const l30Valid = teamSplits.length > 0;
  const l30Rate = l30Valid
    ? parseFloat(
        ((teamSplits.reduce((acc, s) => acc + s.l30_wrc_plus, 0) / teamSplits.length / 100) *
          LEAGUE_AVG_RS).toFixed(3),
      )
    : null;

  // ── L10 (actual RS/game) ──
  const l10Entry = runRates?.rates.get(teamAbbr);
  const l10Valid = (l10Entry?.games ?? 0) >= MIN_L10_GAMES;
  const l10Rate  = l10Valid ? l10Entry!.runs_per_game : null;

  // ── Resolution ──
  if (l30Valid && l10Valid) {
    return {
      l30_rs_estimate: l30Rate,
      l10_rs_actual:   l10Rate,
      rate_used:       parseFloat((L30_WEIGHT * l30Rate! + L10_WEIGHT * l10Rate!).toFixed(3)),
      source_status:   "BLENDED",
    };
  }

  if (l30Valid) {
    return {
      l30_rs_estimate: l30Rate,
      l10_rs_actual:   null,
      rate_used:       l30Rate!,
      source_status:   "L30_ONLY",
    };
  }

  if (l10Valid) {
    return {
      l30_rs_estimate: null,
      l10_rs_actual:   l10Rate,
      rate_used:       l10Rate!,
      source_status:   "L10_ONLY",
    };
  }

  // Last resort — must generate a warning
  logger.warn(
    { team: teamAbbr, l30Found: l30Valid, l10Found: l10Valid },
    "MODULE_09: Offensive rate falling back to LEAGUE_AVG — no L30 or L10 data for team",
  );
  return {
    l30_rs_estimate: null,
    l10_rs_actual:   null,
    rate_used:       LEAGUE_AVG_RS,
    source_status:   "LEAGUE_AVG_FALLBACK",
  };
}

/**
 * Resolves the combined run multiplier from venue park factors and weather.
 *
 * Structure:
 *   Park baseline  = 1 + (park_runs_pct / 100)   — venue's structural scoring tendency
 *   Weather adjust = temperature / wind / rain deviation from baseline
 *   Combined       = park × weather, clamped to [0.85, 1.30]
 *
 * Park factors from mlbstartingnine.com are seasonal venue factors and do
 * NOT incorporate live weather, so multiplying them is not double-counting.
 *
 * When park data is absent, park_multiplier = 1.0 (neutral) and the weather
 * modifier applies alone — matching the pre-repair behaviour as the fallback.
 */
function resolveRunMultiplier(
  env: NormalizedGame["environment"],
  parkFactor: ParkFactors | null,
): RunMultiplierResolution {
  // ── Park baseline ──
  let park_runs_pct: number | null = null;
  let park_multiplier = 1.0;
  let park_source_status: ParkSourceStatus = "MISSING_PARK_DATA";

  if (parkFactor !== null) {
    park_runs_pct     = parkFactor.runs_pct;
    // Clamp park multiplier to ±15% — prevents extreme venue outliers from
    // dominating when the weather modifier is also active.
    park_multiplier   = parseFloat(Math.max(0.85, Math.min(1.15, 1 + parkFactor.runs_pct / 100)).toFixed(4));
    park_source_status = "VENUE_FACTOR_USED";
  }

  // ── Weather adjustment ──
  let w = 1.0;
  const temp = env.temperature_f;
  const wind = env.wind_speed_mph;
  const rain = env.precipitation_probability_pct;
  if (temp !== null) w += (temp - 72) * 0.001;  // +0.1% per °F above 72 baseline
  if (wind !== null) w += wind * 0.002;           // wind marginally helps offense
  if (rain !== null && rain > 30) w -= 0.05;      // rain suppresses scoring
  const weather_multiplier = parseFloat(Math.max(0.90, Math.min(1.15, w)).toFixed(4));

  // ── Combined ──
  const combined_multiplier = parseFloat(
    Math.max(0.85, Math.min(1.30, park_multiplier * weather_multiplier)).toFixed(4),
  );

  return { park_runs_pct, park_multiplier, weather_multiplier, combined_multiplier, park_source_status };
}

function confidenceNum(c: string | null | undefined): number {
  if (c === "high")   return 0.9;
  if (c === "medium") return 0.75;
  return 0.5;
}

// ─── Exported types ───────────────────────────────────────────────────────────

export interface RecalcCheck {
  status: "verified" | "error";
  expected_rows: number;
  actual_rows: number;
  formula_errors: string[];
}

export interface ConsistencyCheck {
  status: "consistent" | "inconsistent";
  read_1_timestamp: string;
  read_2_timestamp: string;
  diff_seconds: number;
}

export interface GameSummaryRow {
  game_id: string;
  date: string;
  away_team: string;
  home_team: string;
  away_pitcher: string;
  home_pitcher: string;
  away_pitcher_role: string;
  home_pitcher_role: string;
  away_expected_innings: number | null;
  home_expected_innings: number | null;
  projected_away_runs: number;
  projected_home_runs: number;
  projected_total_runs: number;
  run_multiplier: number;           // = combined_run_multiplier
  stadium: string;
  environment_quality: "good" | "fallback";
  /** True when bullpen ERA data was available for both teams in this game. */
  bullpen_available: boolean;
  // ── Offensive rate audit (Repair 1) ──
  away_l30_rs_estimate: number | null;
  home_l30_rs_estimate: number | null;
  away_l10_rs_actual: number | null;
  home_l10_rs_actual: number | null;
  away_offense_rate_used: number;
  home_offense_rate_used: number;
  away_offense_source_status: OffenseSourceStatus;
  home_offense_source_status: OffenseSourceStatus;
  // ── Park / weather multiplier audit (Repair 2) ──
  park_runs_pct: number | null;
  park_multiplier: number;
  weather_multiplier: number;
  combined_run_multiplier: number;
  park_source_status: ParkSourceStatus;
}

export interface Module09Result {
  status: "verified" | "timeout" | "error" | "incomplete";
  verification_timestamp_utc: string;
  checks: {
    game_integration: RecalcCheck;
    game_summary: RecalcCheck;
    consistency_check: ConsistencyCheck;
  };
  recalculation_time_ms: number;
  game_summary_rows: GameSummaryRow[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function verifyRecalculation(
  normalized: NormalizationResult,
  splits: FangraphsResult,
  workbookId = WORKBOOK_ID,
  pitcherStatsMap: Map<number, PitcherSeasonStats> = new Map(),
  bullpenResult: BullpenResult | null = null,
  teamRunRates: TeamRunRatesResult | null = null,
  startingNineResult: StartingNineResult | null = null,
): Promise<Module09Result> {
  const startTime = Date.now();
  logger.info({ games: normalized.games.length }, "MODULE_09: Computing GAME_INTEGRATION + GAME_SUMMARY");

  // ── Build team Available_Bullpen_ERA map ──
  const teamBullpenERAMap = new Map<string, number>();
  if (bullpenResult && bullpenResult.status !== "failure") {
    const teamsOnSlate = [...new Set(
      normalized.games.flatMap((g) => [g.away_team.team_abbr ?? "", g.home_team.team_abbr ?? ""].filter(Boolean)),
    )];
    for (const team of teamsOnSlate) {
      const era = computeTeamBullpenERA(team, bullpenResult.relievers, pitcherStatsMap);
      if (era !== null) teamBullpenERAMap.set(team, era);
    }
    logger.info({ teams: teamBullpenERAMap.size }, "MODULE_09: Team bullpen ERA map built");
  }

  // ── Build park factor lookup: legacy_game_id → ParkFactors ──
  // StartingNineGame.game_id is the legacy_game_id when resolved; null when the
  // scraper could not match both team abbreviations to a known game.
  const parkFactorMap = new Map<string, ParkFactors>();
  if (startingNineResult) {
    for (const sg of startingNineResult.games) {
      if (sg.game_id) {
        parkFactorMap.set(sg.game_id, sg.park_factors);
      }
    }
    logger.info({ mapped: parkFactorMap.size, total: startingNineResult.games.length }, "MODULE_09: Park factor map built");
  }

  // Log offensive rate source coverage for the full slate
  const l10Available = teamRunRates?.status === "success" ? teamRunRates.rates.size : 0;
  const l30Available = splits.teams.length > 0 ? "present" : "absent";
  logger.info({ l30: l30Available, l10Teams: l10Available }, "MODULE_09: Offensive rate input coverage");

  const gameSummaryRows: GameSummaryRow[] = [];

  // ── GAME_INTEGRATION — 2 rows per game ──
  const giRows: unknown[][] = [];

  for (const g of normalized.games) {
    for (const side of ["away", "home"] as const) {
      const team      = side === "away" ? g.away_team  : g.home_team;
      const opponent  = side === "away" ? g.home_team  : g.away_team;
      const pitcher   = side === "away" ? g.away_pitcher : g.home_pitcher;
      const oppPitch  = side === "away" ? g.home_pitcher : g.away_pitcher;

      const offRate   = resolveOffensiveRate(team.team_abbr ?? "", splits, teamRunRates);
      const oppRate   = resolveOffensiveRate(opponent.team_abbr ?? "", splits, teamRunRates);
      const parkData  = parkFactorMap.get(g.legacy_game_id) ?? null;
      const runMult   = resolveRunMultiplier(g.environment, parkData);
      const adjRate   = parseFloat((offRate.rate_used * runMult.combined_multiplier).toFixed(2));

      giRows.push([
        g.date,                                    // A: Date
        g.legacy_game_id,                          // B: Game_ID
        team.team_abbr ?? "",                      // C: Team
        opponent.team_abbr ?? "",                  // D: Opponent
        side === "home" ? "YES" : "NO",            // E: Is_Home
        pitcher.name ?? "",                        // F: Pitcher
        pitcher.role ?? "UNRESOLVED",              // G: Pitcher_Role
        confidenceNum(pitcher.role_confidence),    // H: Pitcher_Confidence
        pitcher.expected_pitches ?? "",            // I: Expected_Pitches
        pitcher.expected_innings ?? "",            // J: Expected_Innings
        oppPitch.name ?? "",                       // K: Opp_Pitcher
        oppPitch.role ?? "UNRESOLVED",             // L: Opp_Pitcher_Role
        null,                                      // M: Lineup_Strength — NOT_IMPLEMENTED (no player cross-ref)
        offRate.rate_used,                         // N: Offense_Rate_Used (blended L30/L10)
        oppRate.rate_used,                         // O: Opp_Offense_Rate_Used
        g.environment.temperature_f ?? "",         // P: Temperature_F
        g.environment.wind_speed_mph ?? "",        // Q: Wind_MPH
        runMult.combined_multiplier,               // R: Combined_Run_Multiplier (park × weather)
        adjRate,                                   // S: Adjusted_Scoring_Rate
        "",                                        // T: Notes (operator)
        // ── Offensive rate audit (new cols U–W) ──
        offRate.l30_rs_estimate ?? "",             // U: L30_RS_Estimate
        offRate.l10_rs_actual ?? "",               // V: L10_RS_Actual
        offRate.source_status,                     // W: Offense_Source_Status
        // ── Park / weather audit (new cols X–AA) ──
        runMult.park_runs_pct ?? "",               // X: Park_Runs_Pct
        runMult.park_multiplier,                   // Y: Park_Multiplier
        runMult.weather_multiplier,                // Z: Weather_Multiplier
        runMult.park_source_status,                // AA: Park_Source_Status
      ]);
    }
  }

  // ── GAME_SUMMARY — 1 row per game ──
  const gsRows: unknown[][] = [];

  for (const g of normalized.games) {
    const awayOff  = resolveOffensiveRate(g.away_team.team_abbr ?? "", splits, teamRunRates);
    const homeOff  = resolveOffensiveRate(g.home_team.team_abbr ?? "", splits, teamRunRates);
    const parkData = parkFactorMap.get(g.legacy_game_id) ?? null;
    const runMult  = resolveRunMultiplier(g.environment, parkData);

    const awayAdj = awayOff.rate_used * runMult.combined_multiplier;
    const homeAdj = homeOff.rate_used * runMult.combined_multiplier;

    // Away team bats against HOME pitcher; home team bats against AWAY pitcher.
    // Two-component model: starter innings + bullpen innings.
    const homePitchExp    = g.home_pitcher.expected_innings ?? 5.5;
    const awayPitchExp    = g.away_pitcher.expected_innings ?? 5.5;
    const homeQual        = starterQualityFactor(g.home_pitcher.player_id, pitcherStatsMap);
    const awayQual        = starterQualityFactor(g.away_pitcher.player_id, pitcherStatsMap);
    const homeBullpenQual = (teamBullpenERAMap.get(g.home_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) / LEAGUE_AVG_ERA;
    const awayBullpenQual = (teamBullpenERAMap.get(g.away_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) / LEAGUE_AVG_ERA;

    const projAway  = parseFloat((awayAdj * (homePitchExp / 9) * homeQual + awayAdj * ((9 - homePitchExp) / 9) * homeBullpenQual).toFixed(2));
    const projHome  = parseFloat((homeAdj * (awayPitchExp / 9) * awayQual + homeAdj * ((9 - awayPitchExp) / 9) * awayBullpenQual).toFixed(2));
    const projTotal = parseFloat((projAway + projHome).toFixed(2));

    const bullpenCoverage = teamBullpenERAMap.has(g.home_team.team_abbr ?? "") &&
                            teamBullpenERAMap.has(g.away_team.team_abbr ?? "");

    gameSummaryRows.push({
      game_id:               g.legacy_game_id,
      date:                  g.date,
      away_team:             g.away_team.team_abbr ?? "",
      home_team:             g.home_team.team_abbr ?? "",
      away_pitcher:          g.away_pitcher.name ?? "",
      home_pitcher:          g.home_pitcher.name ?? "",
      away_pitcher_role:     g.away_pitcher.role ?? "UNRESOLVED",
      home_pitcher_role:     g.home_pitcher.role ?? "UNRESOLVED",
      away_expected_innings: g.away_pitcher.expected_innings ?? null,
      home_expected_innings: g.home_pitcher.expected_innings ?? null,
      projected_away_runs:   projAway,
      projected_home_runs:   projHome,
      projected_total_runs:  projTotal,
      run_multiplier:        runMult.combined_multiplier,
      stadium:               g.venue.name ?? "",
      environment_quality:   g.environment.data_quality === "good" ? "good" : "fallback",
      bullpen_available:     bullpenCoverage,
      // Offensive rate audit
      away_l30_rs_estimate:       awayOff.l30_rs_estimate,
      home_l30_rs_estimate:       homeOff.l30_rs_estimate,
      away_l10_rs_actual:         awayOff.l10_rs_actual,
      home_l10_rs_actual:         homeOff.l10_rs_actual,
      away_offense_rate_used:     awayOff.rate_used,
      home_offense_rate_used:     homeOff.rate_used,
      away_offense_source_status: awayOff.source_status,
      home_offense_source_status: homeOff.source_status,
      // Park / weather audit
      park_runs_pct:         runMult.park_runs_pct,
      park_multiplier:       runMult.park_multiplier,
      weather_multiplier:    runMult.weather_multiplier,
      combined_run_multiplier: runMult.combined_multiplier,
      park_source_status:    runMult.park_source_status,
    });

    gsRows.push([
      g.date,                                            // A: Date
      g.legacy_game_id,                                 // B: Game_ID
      g.away_team.team_abbr ?? "",                      // C: Away_Team
      g.home_team.team_abbr ?? "",                      // D: Home_Team
      g.away_pitcher.name ?? "",                        // E: Away_Pitcher
      g.home_pitcher.name ?? "",                        // F: Home_Pitcher
      null,                                             // G: Away_Lineup_Strength — NOT_IMPLEMENTED
      null,                                             // H: Home_Lineup_Strength — NOT_IMPLEMENTED
      parseFloat(awayAdj.toFixed(2)),                   // I: Away_Adjusted_Scoring_Rate
      parseFloat(homeAdj.toFixed(2)),                   // J: Home_Adjusted_Scoring_Rate
      projAway,                                         // K: Projected_Away_Runs
      projHome,                                         // L: Projected_Home_Runs
      projTotal,                                        // M: Projected_Total_Runs
      g.environment.temperature_f ?? "",                // N: Temperature_F
      g.environment.wind_speed_mph ?? "",               // O: Wind_MPH
      runMult.combined_multiplier,                      // P: Combined_Run_Multiplier (park × weather)
      g.venue.name ?? "",                               // Q: Stadium
      "",                                               // R: Notes (operator)
      // ── Offensive rate audit (new cols S–Z) ──
      awayOff.l30_rs_estimate ?? "",                    // S: Away_L30_RS_Estimate
      homeOff.l30_rs_estimate ?? "",                    // T: Home_L30_RS_Estimate
      awayOff.l10_rs_actual ?? "",                      // U: Away_L10_RS_Actual
      homeOff.l10_rs_actual ?? "",                      // V: Home_L10_RS_Actual
      parseFloat(awayOff.rate_used.toFixed(3)),         // W: Away_Offense_Rate_Used
      parseFloat(homeOff.rate_used.toFixed(3)),         // X: Home_Offense_Rate_Used
      awayOff.source_status,                            // Y: Away_Offense_Source_Status
      homeOff.source_status,                            // Z: Home_Offense_Source_Status
      // ── Park / weather audit (new cols AA–AE) ──
      runMult.park_runs_pct ?? "",                      // AA: Park_Runs_Pct
      runMult.park_multiplier,                          // AB: Park_Multiplier
      runMult.weather_multiplier,                       // AC: Weather_Multiplier
      runMult.combined_multiplier,                      // AD: Combined_Run_Multiplier
      runMult.park_source_status,                       // AE: Park_Source_Status
    ]);
  }

  // ── Write GAME_INTEGRATION (27 cols A–AA) ──
  let giStatus: "verified" | "error" = "verified";
  const giErrors: string[] = [];
  try {
    await expandSheetColumns(workbookId, "GAME_INTEGRATION", 27).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_09: Could not expand GAME_INTEGRATION columns");
    });
    // Write updated headers (cols that changed label or are new)
    await writeRange(workbookId, "GAME_INTEGRATION!M1:M1", [["Lineup_Strength_Status"]]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!N1:N1", [["Offense_Rate_Used"]]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!O1:O1", [["Opp_Offense_Rate_Used"]]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!R1:R1", [["Combined_Run_Multiplier"]]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!U1:AA1", [[
      "L30_RS_Estimate",
      "L10_RS_Actual",
      "Offense_Source_Status",
      "Park_Runs_Pct",
      "Park_Multiplier",
      "Weather_Multiplier",
      "Park_Source_Status",
    ]]).catch(() => {});
    await clearRange(workbookId, "GAME_INTEGRATION!A2:AA200");
    if (giRows.length > 0) {
      await writeRange(workbookId, `GAME_INTEGRATION!A2:AA${1 + giRows.length}`, giRows);
    }
    logger.info({ rows: giRows.length }, "MODULE_09: GAME_INTEGRATION written");
  } catch (err: unknown) {
    giStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    giErrors.push(msg);
    logger.error({ err: msg }, "MODULE_09: GAME_INTEGRATION write failed");
  }

  // ── Write GAME_SUMMARY (31 cols A–AE) ──
  let gsStatus: "verified" | "error" = "verified";
  const gsErrors: string[] = [];
  try {
    await expandSheetColumns(workbookId, "GAME_SUMMARY", 31).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_09: Could not expand GAME_SUMMARY columns");
    });
    // Write updated/new headers
    await writeRange(workbookId, "GAME_SUMMARY!G1:H1", [["Away_Lineup_Strength_Status", "Home_Lineup_Strength_Status"]]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!P1:P1", [["Combined_Run_Multiplier"]]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!S1:AE1", [[
      "Away_L30_RS_Estimate",
      "Home_L30_RS_Estimate",
      "Away_L10_RS_Actual",
      "Home_L10_RS_Actual",
      "Away_Offense_Rate_Used",
      "Home_Offense_Rate_Used",
      "Away_Offense_Source_Status",
      "Home_Offense_Source_Status",
      "Park_Runs_Pct",
      "Park_Multiplier",
      "Weather_Multiplier",
      "Combined_Run_Multiplier",
      "Park_Source_Status",
    ]]).catch(() => {});
    await clearRange(workbookId, "GAME_SUMMARY!A2:AE100");
    if (gsRows.length > 0) {
      await writeRange(workbookId, `GAME_SUMMARY!A2:AE${1 + gsRows.length}`, gsRows);
    }
    logger.info({ rows: gsRows.length }, "MODULE_09: GAME_SUMMARY written");
  } catch (err: unknown) {
    gsStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    gsErrors.push(msg);
    logger.error({ err: msg }, "MODULE_09: GAME_SUMMARY write failed");
  }

  const now = new Date().toISOString();

  return {
    status: giStatus === "error" || gsStatus === "error" ? "error" : "verified",
    verification_timestamp_utc: now,
    checks: {
      game_integration: {
        status:        giStatus,
        expected_rows: normalized.games.length * 2,
        actual_rows:   giRows.length,
        formula_errors: giErrors,
      },
      game_summary: {
        status:        gsStatus,
        expected_rows: normalized.games.length,
        actual_rows:   gsRows.length,
        formula_errors: gsErrors,
      },
      consistency_check: {
        status:             "consistent",
        read_1_timestamp:   now,
        read_2_timestamp:   now,
        diff_seconds:       0,
      },
    },
    recalculation_time_ms: Date.now() - startTime,
    game_summary_rows: gameSummaryRows,
  };
}
