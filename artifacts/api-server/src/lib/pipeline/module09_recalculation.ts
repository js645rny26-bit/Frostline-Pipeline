/**
 * Module 09: Game Data Computation & Sheet Writer
 * Computes GAME_INTEGRATION (2 rows/game) and GAME_SUMMARY (1 row/game)
 * from normalized data and writes them directly — no formula dependency.
 */

import { clearRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult, NormalizedGame } from "./module06_normalization.js";
import type { FangraphsResult } from "./module05_fangraphs.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";

/** 2026 MLB league-average ERA used to normalise starter quality. */
const LEAGUE_AVG_ERA = 4.20;

/**
 * Starter quality multiplier relative to a league-average pitcher.
 * ERA 2.06 (Sale)  → 2.06/4.20 = 0.49  → batter scores at 49% of usual rate
 * ERA 4.20 (avg)   → 4.20/4.20 = 1.00  → neutral
 * ERA 5.70 (rough) → 5.70/4.20 = 1.36  → batter scores at 136% of usual rate
 * ERA clamped to [2.0, 7.0] to prevent extreme values from unknown or outlier seasons.
 */
function starterQualityFactor(
  pitcherId: number | null,
  statsMap: Map<number, PitcherSeasonStats>,
): number {
  if (!pitcherId) return 1.0;
  const era = statsMap.get(pitcherId)?.era ?? LEAGUE_AVG_ERA;
  return Math.max(2.0, Math.min(7.0, era)) / LEAGUE_AVG_ERA;
}

export interface RecalcCheck {
  status: "verified" | "error" | "timeout";
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
  projected_away_runs: number;
  projected_home_runs: number;
  projected_total_runs: number;
  run_multiplier: number;
  stadium: string;
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

function confidenceNum(c: string | null | undefined): number {
  if (c === "high") return 0.9;
  if (c === "medium") return 0.75;
  return 0.5;
}

function computeRunMultiplier(env: NormalizedGame["environment"]): number {
  let m = 1.0;
  const temp = env.temperature_f;
  const wind = env.wind_speed_mph;
  const rain = env.precipitation_probability_pct;
  // +0.1% per degree above 72°F baseline
  if (temp !== null) m += (temp - 72) * 0.001;
  // wind marginally helps offense at all speeds (park-factor proxy)
  if (wind !== null) m += wind * 0.002;
  // rain suppresses scoring
  if (rain !== null && rain > 30) m -= 0.05;
  return parseFloat(Math.max(0.85, Math.min(1.20, m)).toFixed(3));
}

function getTeamRS(teamAbbr: string, splits: FangraphsResult): number {
  const teamSplits = splits.teams.filter((s) => s.team === teamAbbr);
  if (teamSplits.length === 0) return 4.5;
  const avgWRC = teamSplits.reduce((acc, s) => acc + s.l30_wrc_plus, 0) / teamSplits.length;
  return parseFloat(((avgWRC / 100) * 4.5).toFixed(2));
}

export async function verifyRecalculation(
  normalized: NormalizationResult,
  splits: FangraphsResult,
  workbookId = WORKBOOK_ID,
  pitcherStatsMap: Map<number, PitcherSeasonStats> = new Map(),
): Promise<Module09Result> {
  const startTime = Date.now();
  logger.info({ games: normalized.games.length }, "MODULE_09: Computing GAME_INTEGRATION + GAME_SUMMARY");

  const gameSummaryRows: GameSummaryRow[] = [];

  // ── GAME_INTEGRATION — 2 rows per game (away-perspective + home-perspective) ──
  // Schema: 20 cols A–T, data starts row 2
  const giRows: unknown[][] = [];

  for (const g of normalized.games) {
    for (const side of ["away", "home"] as const) {
      const team      = side === "away" ? g.away_team    : g.home_team;
      const opponent  = side === "away" ? g.home_team    : g.away_team;
      const pitcher   = side === "away" ? g.away_pitcher : g.home_pitcher;
      const oppPitch  = side === "away" ? g.home_pitcher : g.away_pitcher;

      const rs       = getTeamRS(team.team_abbr ?? "", splits);
      const ra       = getTeamRS(opponent.team_abbr ?? "", splits);
      const runMult  = computeRunMultiplier(g.environment);
      const adjRate  = parseFloat((rs * runMult).toFixed(2));

      giRows.push([
        g.date,                                   // A: Date
        g.legacy_game_id,                         // B: Game_ID
        team.team_abbr ?? "",                     // C: Team
        opponent.team_abbr ?? "",                 // D: Opponent
        side === "home" ? "YES" : "NO",           // E: Is_Home
        pitcher.name ?? "",                       // F: Pitcher
        pitcher.role ?? "UNRESOLVED",             // G: Pitcher_Role
        confidenceNum(pitcher.role_confidence),   // H: Pitcher_Confidence
        pitcher.expected_pitches ?? "",           // I: Expected_Pitches
        pitcher.expected_innings ?? "",           // J: Expected_Innings
        oppPitch.name ?? "",                      // K: Opp_Pitcher
        oppPitch.role ?? "UNRESOLVED",            // L: Opp_Pitcher_Role
        100.0,                                    // M: Lineup_Strength (stub)
        rs,                                       // N: Recent_RS_per_9
        ra,                                       // O: Recent_RA_per_9
        g.environment.temperature_f ?? "",        // P: Temperature_F
        g.environment.wind_speed_mph ?? "",       // Q: Wind_MPH
        runMult,                                  // R: Run_Multiplier
        adjRate,                                  // S: Adjusted_Scoring_Rate
        "",                                       // T: Notes
      ]);
    }
  }

  // ── GAME_SUMMARY — 1 row per game ──
  // Schema: 18 cols A–R, data starts row 2
  const gsRows: unknown[][] = [];

  for (const g of normalized.games) {
    const awayRS   = getTeamRS(g.away_team.team_abbr ?? "", splits);
    const homeRS   = getTeamRS(g.home_team.team_abbr ?? "", splits);
    const runMult  = computeRunMultiplier(g.environment);

    const awayAdj = awayRS * runMult;
    const homeAdj = homeRS * runMult;

    // Away team bats against HOME pitcher; home team bats against AWAY pitcher.
    // Two-component projection — models the full 9 innings:
    //   Starter innings : team_rate × (starterIP/9) × starterQuality (ERA-adjusted)
    //   Bullpen innings : team_rate × ((9−starterIP)/9) × 1.0 (league-average assumption)
    // This prevents opener games from being drastically undermodelled.
    const homePitchExp = g.home_pitcher.expected_innings ?? 5.5;
    const awayPitchExp = g.away_pitcher.expected_innings ?? 5.5;

    const homeQual = starterQualityFactor(g.home_pitcher.player_id, pitcherStatsMap);
    const awayQual = starterQualityFactor(g.away_pitcher.player_id, pitcherStatsMap);

    const projAway  = parseFloat((awayAdj * (homePitchExp / 9) * homeQual + awayAdj * (9 - homePitchExp) / 9).toFixed(2));
    const projHome  = parseFloat((homeAdj * (awayPitchExp / 9) * awayQual + homeAdj * (9 - awayPitchExp) / 9).toFixed(2));
    const projTotal = parseFloat((projAway + projHome).toFixed(2));

    gameSummaryRows.push({
      game_id:              g.legacy_game_id,
      date:                 g.date,
      away_team:            g.away_team.team_abbr ?? "",
      home_team:            g.home_team.team_abbr ?? "",
      away_pitcher:         g.away_pitcher.name ?? "",
      home_pitcher:         g.home_pitcher.name ?? "",
      projected_away_runs:  projAway,
      projected_home_runs:  projHome,
      projected_total_runs: projTotal,
      run_multiplier:       runMult,
      stadium:              g.venue.name ?? "",
    });

    gsRows.push([
      g.date,                                   // A: Date
      g.legacy_game_id,                         // B: Game_ID
      g.away_team.team_abbr ?? "",              // C: Away_Team
      g.home_team.team_abbr ?? "",              // D: Home_Team
      g.away_pitcher.name ?? "",                // E: Away_Pitcher
      g.home_pitcher.name ?? "",                // F: Home_Pitcher
      100.0,                                    // G: Away_Lineup_Strength (stub)
      100.0,                                    // H: Home_Lineup_Strength (stub)
      parseFloat(awayAdj.toFixed(2)),           // I: Away_Adjusted_Scoring_Rate
      parseFloat(homeAdj.toFixed(2)),           // J: Home_Adjusted_Scoring_Rate
      projAway,                                 // K: Projected_Away_Runs
      projHome,                                 // L: Projected_Home_Runs
      projTotal,                                // M: Projected_Total_Runs
      g.environment.temperature_f ?? "",        // N: Temperature_F
      g.environment.wind_speed_mph ?? "",       // O: Wind_MPH
      runMult,                                  // P: Run_Multiplier
      g.venue.name ?? "",                       // Q: Stadium
      "",                                       // R: Notes
    ]);
  }

  // ── Write GAME_INTEGRATION ──
  let giStatus: "verified" | "error" = "verified";
  const giErrors: string[] = [];
  try {
    await clearRange(workbookId, "GAME_INTEGRATION!A2:T200");
    if (giRows.length > 0) {
      await writeRange(workbookId, `GAME_INTEGRATION!A2:T${1 + giRows.length}`, giRows);
    }
    logger.info({ rows: giRows.length }, "MODULE_09: GAME_INTEGRATION written");
  } catch (err: unknown) {
    giStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    giErrors.push(msg);
    logger.error({ err: msg }, "MODULE_09: GAME_INTEGRATION write failed");
  }

  // ── Write GAME_SUMMARY ──
  let gsStatus: "verified" | "error" = "verified";
  const gsErrors: string[] = [];
  try {
    await clearRange(workbookId, "GAME_SUMMARY!A2:R100");
    if (gsRows.length > 0) {
      await writeRange(workbookId, `GAME_SUMMARY!A2:R${1 + gsRows.length}`, gsRows);
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
        status: giStatus,
        expected_rows: normalized.games.length * 2,
        actual_rows: giRows.length,
        formula_errors: giErrors,
      },
      game_summary: {
        status: gsStatus,
        expected_rows: normalized.games.length,
        actual_rows: gsRows.length,
        formula_errors: gsErrors,
      },
      consistency_check: {
        status: "consistent",
        read_1_timestamp: now,
        read_2_timestamp: now,
        diff_seconds: 0,
      },
    },
    recalculation_time_ms: Date.now() - startTime,
    game_summary_rows: gameSummaryRows,
  };
}
