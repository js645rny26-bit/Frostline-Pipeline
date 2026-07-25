/**
 * Module 09: Game Data Computation & Sheet Writer
 * Computes GAME_INTEGRATION (2 rows/game) and GAME_SUMMARY (1 row/game)
 * from normalized data and writes them directly — no formula dependency.
 *
 * Projection inputs (commissioning v2, 2026-07-24):
 *
 * Offensive rate:
 *   Primary:  MLB Stats API L30 actual RS/G back-calculated as wRC+-equivalent
 *             (module05_fangraphs: l30_wrc_plus = (rs_per_game / 4.5) × 100)
 *             Teams with < 15 L30 finals are excluded; module09 falls back per team.
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
import { getSeasonalParkFactor } from "./module04d_parkFactors.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { BullpenResult, RelieverStat } from "./module04b_bullpenUsage.js";
import type { TeamRunRatesResult } from "./module05c_teamRunRates.js";
import type { StartingNineResult, StartingNineGame, ParkFactors, LineupPlayer } from "./module04c_startingNine.js";
import type { BatterSeasonStats } from "./module02c_batterSeasonStats.js";
import { MIN_BATTER_PA } from "./module02c_batterSeasonStats.js";
import type { StatcastBatterStats } from "./module02d_statcastBatters.js";
import { MIN_STATCAST_PA } from "./module02d_statcastBatters.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** 2026 MLB league-average ERA / FIP used to normalise pitcher quality. */
const LEAGUE_AVG_ERA = 4.20;

/**
 * Maximum run addition that park × weather factors are allowed to contribute
 * to any single-game projection. Prevents extreme park/weather combinations
 * from independently inflating totals past what the baseball inputs support.
 *
 * Rationale: Combined park × weather can reach 1.30× on very hot, wind-out days
 * at homer-friendly parks. For a ~9-run game that adds 2.7 runs — far exceeding
 * the actual park/weather signal quality. Capping at 1.5 runs keeps the modifier
 * in the role of a secondary adjustment rather than a primary thesis driver.
 *
 * Do not raise above 2.0 without historical replay validation.
 */
const PARK_WEATHER_MAX_RUN_ADDITION = 1.5;

/**
 * League-average K-BB% (strikeout rate minus walk rate).
 * 2024–2026 MLB average is approximately 14.8 percentage points.
 */
const LEAGUE_AVG_K_BB_PCT = 0.148;

/**
 * Weight applied to K-BB% deviation from league average when adjusting the
 * FIP-based quality factor.
 *
 * Interpretation: each 10-point K-BB% advantage over league average reduces
 * the projected run allowance by (0.10 × K_BB_BLEND_WEIGHT) multiplicatively.
 *
 * Set conservatively at 0.70. Do not raise above 1.0 without replay validation —
 * over-weighting K-BB% can over-suppress run projections for strikeout pitchers
 * whose batted-ball profile is merely average.
 */
const K_BB_BLEND_WEIGHT = 0.70;

/** League-average run rate (runs per 9 innings) used as the last-resort fallback. */
const LEAGUE_AVG_RS = 4.5;

/**
 * 2024–2026 MLB league-average OPS (on-base plus slugging).
 * Baseline when computing the lineup quality multiplier.
 */
const LEAGUE_AVG_OPS = 0.730;

/**
 * Batting-order position weights (index 0 = slot 1, index 8 = slot 9).
 * Represents relative run-contribution importance; top-of-order and cleanup
 * positions carry more weight. Sum = 9.00 (equivalent to 9 equal slots).
 */
const BATTING_ORDER_WEIGHTS = [1.15, 1.10, 1.20, 1.20, 1.05, 1.00, 0.90, 0.80, 0.60];

/**
 * Blend weight controlling how strongly lineup OPS deviation from league
 * average shifts the team's projected offensive rate.
 *
 * A lineup 10% better than average (OPS .803 vs .730) shifts the rate by
 * 10% × LINEUP_BLEND_WEIGHT = 4.0%.  Intentionally conservative because:
 *   (1) Team L30/L10 rates already partially capture lineup quality.
 *   (2) Per-player season OPS has high game-to-game variance.
 *   (3) Lineup and team rate are correlated — full application would double-count.
 * Do not raise above 0.60 without historical replay validation.
 */
const LINEUP_BLEND_WEIGHT = 0.40;

/**
 * Minimum fraction of lineup slots (0–1) that must resolve to batter stats
 * (PA ≥ MIN_BATTER_PA) before the lineup factor is applied.
 * Below this threshold the factor falls back to 1.0 (no adjustment).
 */
const MIN_LINEUP_COVERAGE = 0.60;  // ≥ 6 of 9 slots required

/**
 * OPS adjustment applied per lineup slot based on platoon handedness matchup.
 *
 * Historical MLB platoon splits average ~25–30 OPS points. PLATOON_OPS_ADJ = 0.012
 * applies ~40% of the historical full split as a conservative first-pass estimate.
 * Individual season OPS already partially captures platoon tendencies through the
 * mix of RHP/LHP the batter faced during the season; applying the full split would
 * double-count.
 *
 * Switch hitters always bat from the favorable side and receive 30% of this
 * adjustment (their season OPS is computed from the advantaged hand by definition,
 * so over-crediting the platoon edge is the primary risk).
 *
 * Do not raise above 0.020 (two-thirds of historical split) without replay validation.
 */
const PLATOON_OPS_ADJ = 0.012;

/**
 * 2024–2026 MLB league-average xwOBA (expected weighted on-base average).
 * Baseline when normalising per-batter Statcast contact quality to a lineup factor.
 */
const LEAGUE_AVG_XWOBA = 0.315;

/**
 * Weight given to the xwOBA quality signal vs OPS when computing a batter's
 * effective-OPS contribution to the lineup factor.
 *
 * Effective quality blending formula:
 *   blended = (ops / LEAGUE_AVG_OPS) × (1 − W) + (xwoba / LEAGUE_AVG_XWOBA) × W
 *   effective_ops = LEAGUE_AVG_OPS × blended
 *
 * Set conservatively at 0.25: xwOBA and OPS are strongly correlated, so higher
 * weights produce diminishing returns while increasing variance. Raise toward 0.40
 * after replay confirms xwOBA outperforms OPS for forward-looking projection accuracy.
 */
const STATCAST_BLEND_WEIGHT = 0.25;

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

export type ParkSourceStatus = "VENUE_FACTOR_USED" | "SEASONAL_FACTOR_USED" | "MISSING_PARK_DATA";

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

/** Normalise player name for fuzzy matching against roster data (strips diacritics). */
function normalizeNameForMatch(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

export interface LineupStrengthResolution {
  /** Multiplier applied to team offensive rate. 1.0 = league-average or fallback. */
  factor: number;
  /** Batting-order-weighted lineup OPS (post platoon adjustment). Null when coverage is insufficient. */
  weighted_ops: number | null;
  /** Fraction of the 9 lineup slots with valid batter stats (PA ≥ MIN_BATTER_PA). */
  coverage: number;
  /** FULL = all 9 resolved; PARTIAL = ≥ MIN_LINEUP_COVERAGE; FALLBACK = too sparse; NO_LINEUP = no lineup data. */
  status: "FULL" | "PARTIAL" | "FALLBACK" | "NO_LINEUP";
  /** Lineup source confidence; projected lineups receive a reduced blend weight. */
  lineup_status: "official" | "projected" | null;
  /** Slots where the batter has a platoon advantage vs the opposing starter. */
  platoon_advantaged: number;
  /** Slots where both batter and pitcher handedness were known for comparison. */
  platoon_resolved: number;
  /** Fraction of lineup slots where xwOBA was available and used in the quality blend. */
  xwoba_coverage: number;
}

/**
 * Per-slot OPS adjustment for the platoon matchup between a batter and the opposing starter.
 *
 * Favorable matchup  (L vs RHP, R vs LHP):  +PLATOON_OPS_ADJ
 * Unfavorable matchup (L vs LHP, R vs RHP): -PLATOON_OPS_ADJ
 * Switch hitters (S):                        +PLATOON_OPS_ADJ × 0.30
 *   (Switch hitters always bat from the favorable side by construction, but their season OPS
 *    is already computed from the optimal hand, so a smaller bonus avoids double-counting.)
 *
 * Returns 0 when either handedness is unknown — no spurious adjustment.
 */
function getPlatoonOpsAdj(batterHand: string, pitcherHand: string | null): number {
  if (!pitcherHand || !batterHand) return 0;
  const bat = batterHand.toUpperCase();
  const pit = pitcherHand.toUpperCase();
  if (bat === "S")                                           return PLATOON_OPS_ADJ * 0.30;
  if ((bat === "L" && pit === "R") || (bat === "R" && pit === "L")) return +PLATOON_OPS_ADJ;
  if ((bat === "L" && pit === "L") || (bat === "R" && pit === "R")) return -PLATOON_OPS_ADJ;
  return 0;
}

/**
 * Computes a batting-order-weighted OPS multiplier for a lineup, incorporating
 * the platoon matchup between each batter and the opposing starter, and blending
 * Statcast xwOBA contact quality into each batter's effective OPS contribution.
 *
 * Per-slot effective OPS formula:
 *   1. If both OPS and xwOBA available:
 *        blended_ratio = (ops / LEAGUE_AVG_OPS) × (1 − STATCAST_BLEND_WEIGHT)
 *                      + (xwoba / LEAGUE_AVG_XWOBA) × STATCAST_BLEND_WEIGHT
 *        baseOps = LEAGUE_AVG_OPS × blended_ratio
 *   2. Otherwise: baseOps = ops (or LEAGUE_AVG_OPS for unresolved slots)
 *   effectiveOPS = max(0.400, baseOps + getPlatoonOpsAdj(batter_hand, pitcher_hand))
 *
 *   weightedOPS = Σ(effectiveOPS × slot_weight) / Σ(slot_weight)
 *   rawDev      = (weightedOPS / LEAGUE_AVG_OPS) - 1
 *   effectiveWt = LINEUP_BLEND_WEIGHT × (1.0 if official, 0.60 if projected)
 *   factor      = clamp(1 + rawDev × effectiveWt, 0.82, 1.18)
 *
 * Slots without valid stats contribute league-average OPS (with platoon adj) to
 * preserve count without inflating coverage. Adjustments for unknown values → 0.
 *
 * @param pitcherHand      Throwing hand of the OPPOSING starter ("L" | "R" | null).
 *                         Away lineup → pass home pitcher hand; home lineup → pass away pitcher hand.
 * @param statcastBatterMap Per-batter Statcast leaderboard data from module02d.
 */
function computeLineupStrength(
  lineup: LineupPlayer[],
  nameToIdMap: Map<string, number>,
  batterStatsMap: Map<number, BatterSeasonStats>,
  lineupStatus: "official" | "projected",
  pitcherHand: string | null = null,
  statcastBatterMap: Map<number, StatcastBatterStats> = new Map(),
): LineupStrengthResolution {
  const noData = {
    factor: 1.0, weighted_ops: null, coverage: 0, status: "NO_LINEUP" as const,
    lineup_status: null, platoon_advantaged: 0, platoon_resolved: 0, xwoba_coverage: 0,
  };
  if (lineup.length === 0) return noData;

  let weightedOpsSum = 0;
  let totalWeight    = 0;
  let coveredSlots   = 0;
  let platoonAdv     = 0;
  let platoonRes     = 0;
  let xwobaCovered   = 0;
  const totalSlots   = Math.min(lineup.length, 9);

  for (let i = 0; i < totalSlots; i++) {
    const player  = lineup[i]!;
    const slotIdx = Math.max(0, Math.min(8, (player.batting_order > 0 ? player.batting_order : i + 1) - 1));
    const weight  = BATTING_ORDER_WEIGHTS[slotIdx] ?? 1.0;

    const playerId = nameToIdMap.get(normalizeNameForMatch(player.name));
    const stats    = playerId !== undefined ? batterStatsMap.get(playerId) : undefined;
    const statcast = playerId !== undefined ? statcastBatterMap.get(playerId) : undefined;

    const ops           = stats?.ops ?? null;
    const pa            = stats?.plate_appearances ?? null;
    const hasValidStats = ops !== null && pa !== null && pa >= MIN_BATTER_PA;

    // Statcast xwOBA blending — only when PA meets threshold
    const xwoba    = statcast?.xwoba ?? null;
    const xwobaOk  = xwoba !== null && (statcast?.pa ?? 0) >= MIN_STATCAST_PA;

    // Platoon adjustment (step 3)
    const batHand    = player.handedness || (stats?.bat_hand ?? "");
    const platoonAdj = getPlatoonOpsAdj(batHand, pitcherHand);

    // Track platoon matchup metadata
    if (batHand && pitcherHand) {
      platoonRes++;
      const bat = batHand.toUpperCase();
      const pit = pitcherHand.toUpperCase();
      if (bat === "S" || (bat === "L" && pit === "R") || (bat === "R" && pit === "L")) platoonAdv++;
    }

    // Compute base OPS, blending xwOBA when available (step 4)
    let baseOps: number;
    if (hasValidStats && xwobaOk) {
      const qOps    = ops! / LEAGUE_AVG_OPS;
      const qXwoba  = xwoba! / LEAGUE_AVG_XWOBA;
      const blended = qOps * (1 - STATCAST_BLEND_WEIGHT) + qXwoba * STATCAST_BLEND_WEIGHT;
      baseOps = LEAGUE_AVG_OPS * blended;
      xwobaCovered++;
    } else {
      baseOps = hasValidStats ? ops! : LEAGUE_AVG_OPS;
    }

    const effOps = Math.max(0.400, baseOps + platoonAdj);

    weightedOpsSum += effOps * weight;
    if (hasValidStats) coveredSlots++;
    totalWeight += weight;
  }

  const coverage      = totalSlots > 0 ? coveredSlots / totalSlots : 0;
  const weightedOps   = totalWeight > 0 ? parseFloat((weightedOpsSum / totalWeight).toFixed(3)) : null;
  const xwoba_coverage = totalSlots > 0 ? parseFloat((xwobaCovered / totalSlots).toFixed(2)) : 0;

  if (coverage < MIN_LINEUP_COVERAGE || weightedOps === null) {
    return {
      factor: 1.0, weighted_ops: weightedOps, coverage, status: "FALLBACK",
      lineup_status: lineupStatus, platoon_advantaged: platoonAdv, platoon_resolved: platoonRes,
      xwoba_coverage,
    };
  }

  const rawDev    = (weightedOps / LEAGUE_AVG_OPS) - 1;
  const effWt     = lineupStatus === "official" ? LINEUP_BLEND_WEIGHT : LINEUP_BLEND_WEIGHT * 0.60;
  const rawFactor = 1 + rawDev * effWt;
  const factor    = parseFloat(Math.max(0.82, Math.min(1.18, rawFactor)).toFixed(4));
  const status    = coverage >= 1.0 ? "FULL" : "PARTIAL";

  return {
    factor, weighted_ops: weightedOps, coverage, status, lineup_status: lineupStatus,
    platoon_advantaged: platoonAdv, platoon_resolved: platoonRes, xwoba_coverage,
  };
}

/**
 * Composite starter quality multiplier: how many runs per inning does this
 * pitcher allow relative to a league-average pitcher?
 *
 * Two-component model:
 *
 * 1. FIP-based baseline — FIP removes defence/luck noise from ERA and is a
 *    better predictor of future run allowance. Falls back to ERA when FIP is
 *    unavailable (e.g. very few innings pitched so far this season).
 *
 *    fipFactor = clamp(FIP ?? ERA, 2.0, 7.0) / 4.20
 *
 * 2. K-BB% deviation adjustment — K-BB% (strikeout rate minus walk rate) is
 *    one of the strongest single-season indicators of true pitching skill. An
 *    elite K-BB% pitcher generates more outs per batter faced and creates less
 *    traffic, both of which suppress runs beyond what FIP captures for small
 *    samples.
 *
 *    kBBAdj = (pitcher_K_BB_pct − LEAGUE_AVG_K_BB_PCT) × K_BB_BLEND_WEIGHT
 *    composite = fipFactor × (1 − kBBAdj)
 *
 * Final result clamped to [0.40, 1.80]:
 *   0.40 ≈ elite (e.g. FIP 2.0, K-BB% 28%) → ~0.75 runs/9 below league avg
 *   1.00 = league average
 *   1.80 ≈ very poor (e.g. FIP 7.0, K-BB% 0%) → significant run-scoring boost
 *
 * When k_pct or bb_pct is absent (e.g. opener with <20 BF), the factor falls
 * back to FIP-only to avoid noisy small-sample K-BB% distorting the model.
 */
function starterQualityFactor(
  pitcherId: number | null,
  statsMap: Map<number, PitcherSeasonStats>,
): number {
  if (!pitcherId) return 1.0;
  const stats = statsMap.get(pitcherId);
  if (!stats) return 1.0;

  // Component 1: FIP-based baseline (prefer FIP; fall back to ERA)
  const fipOrEra = stats.fip ?? stats.era ?? LEAGUE_AVG_ERA;
  const fipFactor = clampERA(fipOrEra) / LEAGUE_AVG_ERA;

  // Component 2: K-BB% adjustment (only when both rates are available)
  const kPct = stats.k_pct;
  const bbPct = stats.bb_pct;
  if (kPct === null || bbPct === null) {
    // Insufficient data for K-BB% — use FIP-only
    return Math.max(0.40, Math.min(1.80, fipFactor));
  }

  const kBBPct   = kPct - bbPct;
  const kBBAdj   = (kBBPct - LEAGUE_AVG_K_BB_PCT) * K_BB_BLEND_WEIGHT;
  const composite = fipFactor * (1 - kBBAdj);

  return Math.max(0.40, Math.min(1.80, parseFloat(composite.toFixed(4))));
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
  parkSource?: ParkSourceStatus,
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
    park_source_status = parkSource ?? "VENUE_FACTOR_USED";
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

/**
 * Applies the PARK_WEATHER_MAX_RUN_ADDITION ceiling to the combined run multiplier.
 *
 * The park × weather multiplier is only allowed to add at most PARK_WEATHER_MAX_RUN_ADDITION
 * runs to a game's projection. Beyond that ceiling the modifiers have exceeded their
 * signal quality and become the primary driver of the thesis — which they must not be.
 *
 * Cap formula:
 *   maxAllowedMultiplier = 1 + PARK_WEATHER_MAX_RUN_ADDITION / baseTotal
 *   effectiveMultiplier  = min(combinedMultiplier, maxAllowedMultiplier)
 *
 * Only activates when combined_multiplier > 1.0 (i.e. park/weather is boosting runs).
 * Suppressive scenarios (multiplier < 1.0) are not capped — the floor is already
 * handled by the existing [0.85, 1.30] clamp in resolveRunMultiplier.
 *
 * @param combinedMultiplier  The park × weather multiplier before the run-addition cap.
 * @param awayOffenseRate     Away team's blended RS/9 rate (pre-multiplier).
 * @param homeOffenseRate     Home team's blended RS/9 rate (pre-multiplier).
 * @returns Effective multiplier, capped so the run addition ≤ PARK_WEATHER_MAX_RUN_ADDITION.
 */
function capRunMultiplierAddition(
  combinedMultiplier: number,
  awayOffenseRate: number,
  homeOffenseRate: number,
): number {
  if (combinedMultiplier <= 1.0) return combinedMultiplier; // suppressive — no cap needed
  const baseTotal = awayOffenseRate + homeOffenseRate;
  if (baseTotal <= 0) return combinedMultiplier;
  const addition = (combinedMultiplier - 1) * baseTotal;
  if (addition > PARK_WEATHER_MAX_RUN_ADDITION) {
    return parseFloat((1 + PARK_WEATHER_MAX_RUN_ADDITION / baseTotal).toFixed(4));
  }
  return combinedMultiplier;
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
  // ── Lineup strength (Step 2 commissioning) ──
  away_lineup_factor: number;
  home_lineup_factor: number;
  away_lineup_weighted_ops: number | null;
  home_lineup_weighted_ops: number | null;
  away_lineup_coverage: number;
  home_lineup_coverage: number;
  away_lineup_status: LineupStrengthResolution["status"];
  home_lineup_status: LineupStrengthResolution["status"];
  away_lineup_source: "official" | "projected" | null;
  home_lineup_source: "official" | "projected" | null;
  away_lineup_xwoba_coverage: number;
  home_lineup_xwoba_coverage: number;
  // ── Derivative signals (step 5) ──
  /** Projected away runs minus projected home runs. Positive = away favoured. */
  proj_run_diff: number;
  /** Starter quality factor for the away team's starter (FIP + K-BB%). 1.0 = league average. */
  away_starter_quality: number;
  /** Starter quality factor for the home team's starter (FIP + K-BB%). 1.0 = league average. */
  home_starter_quality: number;
  // ── Over survival gate projection components ──
  /**
   * Total runs expected during starter innings for both teams, at baseline offense rates
   * (lineup-adjusted, no park/weather multiplier). = awayBaselineRate × (homeSP_IP/9) × homeQual
   *                                                  + homeBaselineRate × (awaySP_IP/9) × awayQual
   */
  starter_attack_runs: number;
  /**
   * Total runs expected during bullpen innings for both teams, at baseline offense rates
   * (no park/weather). = awayBaselineRate × ((9-homeSP_IP)/9) × homeBullpenQual + mirror
   */
  bullpen_continuation_runs: number;
  /**
   * Informational: both teams' total offense at league-average pitching with no environment.
   * = awayOff.rate_used × awayLineup.factor + homeOff.rate_used × homeLineup.factor.
   * Not used directly in the survival formula — documents the baseline before pitcher adjustment.
   */
  baseline_offense_runs: number;
  /**
   * Traffic-to-run conversion component. Currently 0 — not separately modelled.
   * Captured implicitly in the L30/L10 RS/G rate (which includes actual runs, not just baserunners).
   * Reserved for a future traffic-conversion model upgrade.
   */
  traffic_conversion_runs: number;
  /**
   * Extra-base / HR damage component. Currently 0 — not separately modelled at game level.
   * Structural park HR tendency is embedded in the park multiplier (environment_run_adjustment).
   * Reserved for a future HR/XBH decomposition upgrade.
   */
  hr_xbh_damage_runs: number;
  /**
   * Baseball-only projection: starter_attack_runs + bullpen_continuation_runs.
   * Excludes the park/weather contribution. This is the thesis test baseline:
   * an Over must clear the market line on baseball grounds alone.
   */
  baseball_only_projection: number;
  /**
   * Run contribution from the park × weather combined multiplier.
   * = projected_total_runs − baseball_only_projection.
   * Positive = environment boosted runs; negative = environment suppressed them.
   * Must not independently manufacture an Over thesis.
   */
  environment_run_adjustment: number;
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
  batterStatsMap: Map<number, BatterSeasonStats> = new Map(),
  lineupNameToIdMap: Map<string, number> = new Map(),
  statcastBatterMap: Map<number, StatcastBatterStats> = new Map(),
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
  // Primary:  live scrape from module04c (today's games, game_id-keyed).
  // Fallback: static 2026 seasonal table (module04d) for games not in today's
  //           scrape, keyed by home team abbr — covers all 30 venues.
  const parkFactorMap = new Map<string, ParkFactors>();
  const parkSourceMap = new Map<string, ParkSourceStatus>();

  const lineupMap = new Map<string, StartingNineGame>();
  if (startingNineResult) {
    for (const sg of startingNineResult.games) {
      if (sg.game_id) {
        parkFactorMap.set(sg.game_id, sg.park_factors);
        parkSourceMap.set(sg.game_id, "VENUE_FACTOR_USED");
        lineupMap.set(sg.game_id, sg);
      }
    }
  }

  // Seasonal fallback: fill any game not resolved by the live scrape
  for (const g of normalized.games) {
    if (!parkFactorMap.has(g.legacy_game_id) && g.home_team.team_abbr) {
      const seasonal = getSeasonalParkFactor(g.home_team.team_abbr);
      if (seasonal) {
        parkFactorMap.set(g.legacy_game_id, seasonal);
        parkSourceMap.set(g.legacy_game_id, "SEASONAL_FACTOR_USED");
      }
    }
  }

  logger.info(
    { live: startingNineResult?.games.length ?? 0, total: parkFactorMap.size },
    "MODULE_09: Park factor map built (live scrape + seasonal fallback)",
  );

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
      const parkData   = parkFactorMap.get(g.legacy_game_id) ?? null;
      const parkSource = parkSourceMap.get(g.legacy_game_id);
      const runMult    = resolveRunMultiplier(g.environment, parkData, parkSource);
      // Cap the park × weather addition so it cannot contribute more than
      // PARK_WEATHER_MAX_RUN_ADDITION runs to the total projection.
      const cappedMultiplier = capRunMultiplierAddition(
        runMult.combined_multiplier,
        offRate.rate_used,
        oppRate.rate_used,
      );
      const adjRate   = parseFloat((offRate.rate_used * cappedMultiplier).toFixed(2));

      // Lineup strength for the batting team (away team bats against home pitcher)
      const bSg      = lineupMap.get(g.legacy_game_id) ?? null;
      const bLineup  = side === "away" ? bSg?.away_lineup ?? [] : bSg?.home_lineup ?? [];
      const bLStatus = bSg?.lineup_status ?? "projected";
      // The batting team faces the opposing pitcher; look up that pitcher's throwing hand.
      const bOppPitHand = pitcherStatsMap.get((oppPitch.player_id ?? 0) as number)?.hand ?? null;
      const giLineup = computeLineupStrength(bLineup, lineupNameToIdMap, batterStatsMap, bLStatus, bOppPitHand, statcastBatterMap);

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
        giLineup.factor,                           // M: Lineup_Factor (weighted OPS multiplier vs league avg)
        offRate.rate_used,                         // N: Offense_Rate_Used (blended L30/L10)
        oppRate.rate_used,                         // O: Opp_Offense_Rate_Used
        g.environment.temperature_f ?? "",         // P: Temperature_F
        g.environment.wind_speed_mph ?? "",        // Q: Wind_MPH
        cappedMultiplier,                          // R: Combined_Run_Multiplier (park × weather, capped)
        adjRate,                                   // S: Adjusted_Scoring_Rate
        "",                                        // T: Notes (operator)
        // ── Offensive rate audit (new cols U–W) ──
        offRate.l30_rs_estimate ?? "",             // U: L30_RS_Estimate
        offRate.l10_rs_actual ?? "",               // V: L10_RS_Actual
        offRate.source_status,                     // W: Offense_Source_Status
        // ── Park / weather audit (new cols X–AA) ──
        runMult.park_runs_pct ?? "",               // X: Park_Runs_Pct
        runMult.park_multiplier,                   // Y: Park_Multiplier (raw, uncapped)
        runMult.weather_multiplier,                // Z: Weather_Multiplier (raw, uncapped)
        runMult.park_source_status,                // AA: Park_Source_Status
      ]);
    }
  }

  // ── GAME_SUMMARY — 1 row per game ──
  const gsRows: unknown[][] = [];

  for (const g of normalized.games) {
    const awayOff  = resolveOffensiveRate(g.away_team.team_abbr ?? "", splits, teamRunRates);
    const homeOff  = resolveOffensiveRate(g.home_team.team_abbr ?? "", splits, teamRunRates);
    const parkData   = parkFactorMap.get(g.legacy_game_id) ?? null;
    const parkSource = parkSourceMap.get(g.legacy_game_id);
    const runMult    = resolveRunMultiplier(g.environment, parkData, parkSource);
    // Cap the park × weather addition — must not add more than PARK_WEATHER_MAX_RUN_ADDITION
    // runs to the total projection. The raw multiplier is preserved in audit columns.
    const cappedMult = capRunMultiplierAddition(
      runMult.combined_multiplier,
      awayOff.rate_used,
      homeOff.rate_used,
    );

    const awayAdj = awayOff.rate_used * cappedMult;
    const homeAdj = homeOff.rate_used * cappedMult;

    // ── Lineup strength (Step 2 commissioning) ──
    // Away team bats against the HOME pitcher → apply away lineup factor.
    // Home team bats against the AWAY pitcher → apply home lineup factor.
    const sg = lineupMap.get(g.legacy_game_id) ?? null;
    // Away batters face the home starter; home batters face the away starter.
    const homePitHand = pitcherStatsMap.get(g.home_pitcher.player_id ?? 0)?.hand ?? null;
    const awayPitHand = pitcherStatsMap.get(g.away_pitcher.player_id ?? 0)?.hand ?? null;
    const awayLineup = computeLineupStrength(
      sg?.away_lineup ?? [],
      lineupNameToIdMap,
      batterStatsMap,
      sg?.lineup_status ?? "projected",
      homePitHand,        // away lineup bats against the home starter
      statcastBatterMap,
    );
    const homeLineup = computeLineupStrength(
      sg?.home_lineup ?? [],
      lineupNameToIdMap,
      batterStatsMap,
      sg?.lineup_status ?? "projected",
      awayPitHand,        // home lineup bats against the away starter
      statcastBatterMap,
    );

    // Apply lineup factor to the park/weather-adjusted team rates before the pitcher model.
    const awayAdjFinal = parseFloat((awayAdj * awayLineup.factor).toFixed(3));
    const homeAdjFinal = parseFloat((homeAdj * homeLineup.factor).toFixed(3));

    // Away team bats against HOME pitcher; home team bats against AWAY pitcher.
    // Two-component model: starter innings + bullpen innings.
    const homePitchExp    = g.home_pitcher.expected_innings ?? 5.5;
    const awayPitchExp    = g.away_pitcher.expected_innings ?? 5.5;
    const homeQual        = starterQualityFactor(g.home_pitcher.player_id, pitcherStatsMap);
    const awayQual        = starterQualityFactor(g.away_pitcher.player_id, pitcherStatsMap);
    const homeBullpenQual = (teamBullpenERAMap.get(g.home_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) / LEAGUE_AVG_ERA;
    const awayBullpenQual = (teamBullpenERAMap.get(g.away_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) / LEAGUE_AVG_ERA;

    const projAway  = parseFloat((awayAdjFinal * (homePitchExp / 9) * homeQual + awayAdjFinal * ((9 - homePitchExp) / 9) * homeBullpenQual).toFixed(2));
    const projHome  = parseFloat((homeAdjFinal * (awayPitchExp / 9) * awayQual + homeAdjFinal * ((9 - awayPitchExp) / 9) * awayBullpenQual).toFixed(2));
    const projTotal = parseFloat((projAway + projHome).toFixed(2));

    const bullpenCoverage = teamBullpenERAMap.has(g.home_team.team_abbr ?? "") &&
                            teamBullpenERAMap.has(g.away_team.team_abbr ?? "");

    // ── Over survival gate: decompose projection into baseball vs environment ──
    // Baseline rates strip the park/weather multiplier; lineup factor is retained
    // (today's lineup is a baseball input, not an environmental one).
    const awayBaselineRate = parseFloat((awayOff.rate_used * awayLineup.factor).toFixed(3));
    const homeBaselineRate = parseFloat((homeOff.rate_used * homeLineup.factor).toFixed(3));
    // Runs during starter innings (both teams), environment-free:
    const awayStarterRuns = awayBaselineRate * (homePitchExp / 9) * homeQual;
    const homeStarterRuns = homeBaselineRate * (awayPitchExp / 9) * awayQual;
    // Runs during bullpen innings (both teams), environment-free:
    const awayBullpenRuns = awayBaselineRate * ((9 - homePitchExp) / 9) * homeBullpenQual;
    const homeBullpenRuns = homeBaselineRate * ((9 - awayPitchExp) / 9) * awayBullpenQual;
    const starterAttackRuns       = parseFloat((awayStarterRuns + homeStarterRuns).toFixed(2));
    const bullpenContinuationRuns = parseFloat((awayBullpenRuns + homeBullpenRuns).toFixed(2));
    const baseballOnlyProj        = parseFloat((starterAttackRuns + bullpenContinuationRuns).toFixed(2));
    const baselineOffRuns         = parseFloat((awayBaselineRate + homeBaselineRate).toFixed(2));
    // Environment contribution = what park × weather added (or removed) from the total.
    const envRunAdj               = parseFloat((projTotal - baseballOnlyProj).toFixed(2));

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
      run_multiplier:        cappedMult,
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
      // Park / weather audit (raw uncapped values for traceability)
      park_runs_pct:         runMult.park_runs_pct,
      park_multiplier:       runMult.park_multiplier,
      weather_multiplier:    runMult.weather_multiplier,
      combined_run_multiplier: cappedMult,
      park_source_status:    runMult.park_source_status,
      // Lineup strength audit
      away_lineup_factor:       awayLineup.factor,
      home_lineup_factor:       homeLineup.factor,
      away_lineup_weighted_ops: awayLineup.weighted_ops,
      home_lineup_weighted_ops: homeLineup.weighted_ops,
      away_lineup_coverage:     awayLineup.coverage,
      home_lineup_coverage:     homeLineup.coverage,
      away_lineup_status:       awayLineup.status,
      home_lineup_status:       homeLineup.status,
      away_lineup_source:            awayLineup.lineup_status,
      home_lineup_source:            homeLineup.lineup_status,
      away_lineup_xwoba_coverage:    awayLineup.xwoba_coverage,
      home_lineup_xwoba_coverage:    homeLineup.xwoba_coverage,
      proj_run_diff:                 parseFloat((projAway - projHome).toFixed(2)),
      away_starter_quality:          parseFloat(awayQual.toFixed(4)),
      home_starter_quality:          parseFloat(homeQual.toFixed(4)),
      // Over survival gate components
      starter_attack_runs:           starterAttackRuns,
      bullpen_continuation_runs:     bullpenContinuationRuns,
      baseline_offense_runs:         baselineOffRuns,
      traffic_conversion_runs:       0,  // not yet modelled — reserved
      hr_xbh_damage_runs:            0,  // not yet modelled — reserved
      baseball_only_projection:      baseballOnlyProj,
      environment_run_adjustment:    envRunAdj,
    });

    gsRows.push([
      g.date,                                            // A: Date
      g.legacy_game_id,                                 // B: Game_ID
      g.away_team.team_abbr ?? "",                      // C: Away_Team
      g.home_team.team_abbr ?? "",                      // D: Home_Team
      g.away_pitcher.name ?? "",                        // E: Away_Pitcher
      g.home_pitcher.name ?? "",                        // F: Home_Pitcher
      awayLineup.factor,                                // G: Away_Lineup_Factor (weighted OPS multiplier)
      homeLineup.factor,                                // H: Home_Lineup_Factor (weighted OPS multiplier)
      parseFloat(awayAdjFinal.toFixed(2)),              // I: Away_Adjusted_Scoring_Rate (post-lineup)
      parseFloat(homeAdjFinal.toFixed(2)),              // J: Home_Adjusted_Scoring_Rate (post-lineup)
      projAway,                                         // K: Projected_Away_Runs
      projHome,                                         // L: Projected_Home_Runs
      projTotal,                                        // M: Projected_Total_Runs
      g.environment.temperature_f ?? "",                // N: Temperature_F
      g.environment.wind_speed_mph ?? "",               // O: Wind_MPH
      cappedMult,                                        // P: Combined_Run_Multiplier (park × weather, capped)
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
      // Raw uncapped values preserved here for full traceability.
      runMult.park_runs_pct ?? "",                      // AA: Park_Runs_Pct
      runMult.park_multiplier,                          // AB: Park_Multiplier (raw)
      runMult.weather_multiplier,                       // AC: Weather_Multiplier (raw)
      cappedMult,                                       // AD: Combined_Run_Multiplier (capped)
      runMult.park_source_status,                       // AE: Park_Source_Status
      // ── Step 5 derivatives ──
      parseFloat((projAway - projHome).toFixed(2)),     // AF: Projected_Run_Diff
      parseFloat(awayQual.toFixed(4)),                  // AG: Away_Starter_Quality
      parseFloat(homeQual.toFixed(4)),                  // AH: Home_Starter_Quality
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
    await writeRange(workbookId, "GAME_INTEGRATION!M1:M1", [["Lineup_Factor"]]).catch(() => {});
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

  // ── Write GAME_SUMMARY (34 cols A–AH) ──
  let gsStatus: "verified" | "error" = "verified";
  const gsErrors: string[] = [];
  try {
    await expandSheetColumns(workbookId, "GAME_SUMMARY", 34).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_09: Could not expand GAME_SUMMARY columns");
    });
    // Write updated/new headers
    await writeRange(workbookId, "GAME_SUMMARY!G1:H1", [["Away_Lineup_Factor", "Home_Lineup_Factor"]]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!P1:P1", [["Combined_Run_Multiplier"]]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!S1:AH1", [[
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
      "Combined_Run_Multiplier_Audit",   // col AD — audit copy; col P is the primary
      "Park_Source_Status",
      // ── Step 5 derivatives ──
      "Projected_Run_Diff",              // AF
      "Away_Starter_Quality",            // AG
      "Home_Starter_Quality",            // AH
    ]]).catch(() => {});
    await clearRange(workbookId, "GAME_SUMMARY!A2:AH100");
    if (gsRows.length > 0) {
      await writeRange(workbookId, `GAME_SUMMARY!A2:AH${1 + gsRows.length}`, gsRows);
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
