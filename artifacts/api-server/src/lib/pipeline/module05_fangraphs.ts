/**
 * Module 05: Team L30 Offensive Rates
 * Fetches real MLB Stats API schedule data to compute each team's actual
 * runs-scored per game over the trailing 30 days, then back-calculates a
 * wRC+-equivalent so module09 can consume it without interface changes.
 *
 * Conversion:  l30_wrc_plus_equiv = (rs_per_game / LEAGUE_AVG_RS) × 100
 * Inverse:     rs_per_game = (l30_wrc_plus / 100) × LEAGUE_AVG_RS   ← module09 formula
 * Round-trip:  lossless (modulo toFixed(1) rounding on wRC+ ≈ ±0.02 RS/G)
 *
 * Teams with fewer than MIN_L30_GAMES finals in the window are excluded from
 * the teams[] array; module09 treats their l30Valid = false and falls back to
 * L10_ONLY or LEAGUE_AVG_FALLBACK.
 *
 * Cache: in-memory, scoped to the calendar date (today's games reuse one fetch).
 */

import { logger } from "../../lib/logger.js";
import { fetchTeamRunRates } from "./module05c_teamRunRates.js";

// Must match module09_recalculation.ts constant — round-trip depends on it.
const LEAGUE_AVG_RS = 4.5;

/** Minimum L30 finals required for a team's rate to be considered valid. */
const MIN_L30_GAMES = 15;

/** Calendar days to look back for the L30 window. */
const L30_LOOKBACK_DAYS = 30;

/** Max games sampled per team within the window. */
const L30_LAST_N = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamSplitData {
  team: string;
  split: string;
  season_wrc_plus: number;
  season_k_pct: number;
  season_bb_pct: number;
  season_iso: number;
  l30_wrc_plus: number;
  l30_k_pct: number;
  l30_bb_pct: number;
  l30_iso: number;
  l14_wrc_plus: number;
  l14_k_pct: number;
  l14_bb_pct: number;
  l14_iso: number;
  /** How many completed games fed into l30_wrc_plus. */
  games_sampled: number;
  /** "valid" | "insufficient_games" | "fallback_excluded" */
  l30_source_status: string;
}

export interface FangraphsResult {
  retrieval_timestamp_utc: string;
  refresh_date: string;
  teams: TeamSplitData[];
  status: string;
  retrieval_source: string;
  freshness_status: string;
  /** How many of the 30 MLB teams have valid (≥MIN_L30_GAMES) L30 data. */
  l30_teams_sampled: number;
  error?: string;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cachedData: FangraphsResult | null = null;
let cacheDate: string | null = null;

// ─── Implementation ───────────────────────────────────────────────────────────

export async function fetchTeamSplitsWithFallback(): Promise<FangraphsResult> {
  const today = new Date().toISOString().split("T")[0]!;

  if (cachedData && cacheDate === today) {
    logger.info(
      { teams: cachedData.l30_teams_sampled },
      "MODULE_05: Returning same-day L30 cache",
    );
    return { ...cachedData, retrieval_source: "mlb_api_l30_cached", freshness_status: "valid" };
  }

  logger.info(
    { lookbackDays: L30_LOOKBACK_DAYS, lastN: L30_LAST_N, minGames: MIN_L30_GAMES },
    "MODULE_05: Fetching L30 run rates from MLB Stats API",
  );

  const ratesResult = await fetchTeamRunRates(today, {
    lookbackDays: L30_LOOKBACK_DAYS,
    lastN: L30_LAST_N,
  });

  if (ratesResult.status !== "success") {
    const result: FangraphsResult = {
      retrieval_timestamp_utc: new Date().toISOString(),
      refresh_date: today,
      teams: [],
      status: "failure",
      retrieval_source: "mlb_api_l30_live",
      freshness_status: "error",
      l30_teams_sampled: 0,
      error: ratesResult.error ?? "MLB Stats API fetch failed",
    };
    logger.warn({ error: result.error }, "MODULE_05: L30 fetch failed — teams[] empty, module09 will fall back per team");
    return result;
  }

  const teams: TeamSplitData[] = [];
  let insufficientCount = 0;

  for (const [abbr, rate] of ratesResult.rates) {
    if (rate.games < MIN_L30_GAMES) {
      insufficientCount++;
      logger.debug(
        { team: abbr, games: rate.games, required: MIN_L30_GAMES },
        "MODULE_05: Team excluded from L30 — insufficient games",
      );
      continue;
    }

    // Back-calculate a wRC+-equivalent so module09's existing formula is unchanged:
    //   module09 computes: (l30_wrc_plus / 100) × LEAGUE_AVG_RS
    //   which inverts to:   rs_per_game  (round-trip exact modulo toFixed(1))
    const wrcEquiv = parseFloat(((rate.runs_per_game / LEAGUE_AVG_RS) * 100).toFixed(1));

    teams.push({
      team:             abbr,
      split:            "L30_actual",      // no pitcher-hand breakdown from this source
      season_wrc_plus:  0,                  // not available from this source
      season_k_pct:     0,
      season_bb_pct:    0,
      season_iso:       0,
      l30_wrc_plus:     wrcEquiv,
      l30_k_pct:        0,
      l30_bb_pct:       0,
      l30_iso:          0,
      l14_wrc_plus:     0,
      l14_k_pct:        0,
      l14_bb_pct:       0,
      l14_iso:          0,
      games_sampled:    rate.games,
      l30_source_status: "valid",
    });
  }

  logger.info(
    { valid: teams.length, insufficient: insufficientCount, total: ratesResult.rates.size },
    "MODULE_05: L30 team data built",
  );

  const fresh: FangraphsResult = {
    retrieval_timestamp_utc: new Date().toISOString(),
    refresh_date:            today,
    teams,
    status:                  "success",
    retrieval_source:        "mlb_api_l30_live",
    freshness_status:        "current",
    l30_teams_sampled:       teams.length,
  };

  cachedData = fresh;
  cacheDate  = today;

  return fresh;
}
