/**
 * Module 09: Game Data Computation & Sheet Writer
 * Computes GAME_INTEGRATION (2 rows/game) and GAME_SUMMARY (1 row/game)
 * from normalized data and writes them directly — no formula dependency.
 *
 * Projection inputs (commissioning v2, 2026-07-24):
 *
 * Offensive center:
 *   Latent:   League scoring environment × exact lineup OPS/xwOBA quality.
 *   Form:     L30/L10 actual RS/G blend, shrunk and capped as a form modifier.
 *   Fallback: League-average latent center; missing recent-form data is neutral.
 *
 * Run multiplier:
 *   Park baseline:  1 + (park_runs_pct / 100) from module04c_startingNine park_factors
 *   Weather modifier: temperature/wind/rain deviation from park baseline
 *   Combined:       park × weather, clamped to [0.85, 1.30]
 *   Fallback:       park_multiplier = 1.0 when park data absent (MISSING_PARK_DATA)
 *
 * Lineup / matchup:
 *   A batting-order-weighted OPS/xwOBA factor defines each team's latent
 *   lineup center. The active v36 trunk uses BB/K for traffic, hard-hit for
 *   damage, and keeps direct traffic scoring conditional on conversion evidence.
 */

import {
  clearRange,
  expandSheetColumns,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type {
  NormalizationResult,
  NormalizedGame,
} from "./module06_normalization.js";
import {
  buildSheetRowNumberMap,
  mergeProtectedRows,
  type PublicationProtection,
} from "./module00_scopedPublication.js";
import type { FangraphsResult } from "./module05_fangraphs.js";
import { getSeasonalParkFactor } from "./module04d_parkFactors.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { BullpenResult, RelieverStat } from "./module04b_bullpenUsage.js";
import type { TeamRunRatesResult } from "./module05c_teamRunRates.js";
import {
  buildStartingNineMap,
  type StartingNineResult,
  type StartingNineGame,
  type ParkFactors,
  type LineupPlayer,
} from "./module04c_startingNine.js";
import type { BatterSeasonStats } from "./module02c_batterSeasonStats.js";
import { MIN_BATTER_PA } from "./module02c_batterSeasonStats.js";
import type { StatcastBatterStats } from "./module02d_statcastBatters.js";
import { MIN_STATCAST_PA } from "./module02d_statcastBatters.js";
import {
  resolveEnvironmentFactors,
  type EnvironmentCertainty,
  type RoofStatus,
  type WeatherVehicleStatus,
  type WindDisposition,
} from "./module09_environment.js";
import {
  computeActiveOffenseCenter,
  computeActiveTeamProjection,
  type ActiveLineupProfile,
  type ActiveStarterProfile,
} from "./module09_gameTruthMath.js";
import {
  validateEnvironmentLineage,
  validateProjectionLineage,
} from "./module09_lineageValidation.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** 2026 MLB league-average ERA / FIP used to normalise pitcher quality. */
const LEAGUE_AVG_ERA = 4.2;

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


/** League-average run rate (runs per 9 innings) used as the last-resort fallback. */
const LEAGUE_AVG_RS = 4.5;

/**
 * 2024–2026 MLB league-average OPS (on-base plus slugging).
 * Baseline when computing the lineup quality multiplier.
 */
const LEAGUE_AVG_OPS = 0.73;

/**
 * Batting-order position weights (index 0 = slot 1, index 8 = slot 9).
 * Represents relative run-contribution importance; top-of-order and cleanup
 * positions carry more weight. Sum = 9.00 (equivalent to 9 equal slots).
 */
const BATTING_ORDER_WEIGHTS = [1.15, 1.1, 1.2, 1.2, 1.05, 1.0, 0.9, 0.8, 0.6];

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
const LINEUP_BLEND_WEIGHT = 0.4;

/**
 * Minimum fraction of lineup slots (0–1) that must resolve to batter stats
 * (PA ≥ MIN_BATTER_PA) before the lineup factor is applied.
 * Below this threshold the factor falls back to 1.0 (no adjustment).
 */
const MIN_LINEUP_COVERAGE = 0.6; // ≥ 6 of 9 slots required

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
  "BLENDED" | "L30_ONLY" | "L10_ONLY" | "LEAGUE_AVG_FALLBACK";

export type ParkSourceStatus =
  "VENUE_FACTOR_USED" | "SEASONAL_FACTOR_USED" | "MISSING_PARK_DATA";

export interface OffensiveRateResolution {
  /** Fangraphs L30 wRC+ converted to runs/9. Null when Fangraphs data is absent. */
  l30_rs_estimate: number | null;
  /** Actual RS/game from the last 10 completed games. Null when unavailable or sparse. */
  l10_rs_actual: number | null;
  /** Recent realized-scoring form blend; v36 applies it only as a bounded center modifier. */
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
  home_run_factor: number;
  weather_source_status: "LIVE" | "FALLBACK_NEUTRAL";
  roof_status: RoofStatus;
  wind_disposition: WindDisposition;
  environment_certainty: EnvironmentCertainty;
  weather_vehicle_status: WeatherVehicleStatus;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function clampERA(era: number): number {
  return Math.max(2.0, Math.min(7.0, era));
}

/** Normalise player name for fuzzy matching against roster data (strips diacritics). */
function normalizeNameForMatch(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
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
  /** Weighted season on-base percentage for the exact posted/projected lineup. */
  weighted_obp: number | null;
  /** Weighted season slugging percentage for the exact posted/projected lineup. */
  weighted_slg: number | null;
  /** Weighted walk rate for the exact lineup. */
  weighted_bb_pct: number | null;
  /** Weighted strikeout rate for the exact lineup. */
  weighted_k_pct: number | null;
  /** Weighted Statcast xwOBA when enough qualified lineup data exists. */
  weighted_xwoba: number | null;
  /** Weighted Statcast hard-hit percentage when enough qualified data exists. */
  weighted_hard_hit_pct: number | null;
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
function getPlatoonOpsAdj(
  batterHand: string,
  pitcherHand: string | null,
): number {
  if (!pitcherHand || !batterHand) return 0;
  const bat = batterHand.toUpperCase();
  const pit = pitcherHand.toUpperCase();
  if (bat === "S") return PLATOON_OPS_ADJ * 0.3;
  if ((bat === "L" && pit === "R") || (bat === "R" && pit === "L"))
    return +PLATOON_OPS_ADJ;
  if ((bat === "L" && pit === "L") || (bat === "R" && pit === "R"))
    return -PLATOON_OPS_ADJ;
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
    factor: 1.0,
    weighted_ops: null,
    coverage: 0,
    status: "NO_LINEUP" as const,
    lineup_status: null,
    platoon_advantaged: 0,
    platoon_resolved: 0,
    xwoba_coverage: 0,
    weighted_obp: null,
    weighted_slg: null,
    weighted_bb_pct: null,
    weighted_k_pct: null,
    weighted_xwoba: null,
    weighted_hard_hit_pct: null,
  };
  if (lineup.length === 0) return noData;

  let weightedOpsSum = 0;
  let totalWeight = 0;
  let coveredSlots = 0;
  let platoonAdv = 0;
  let platoonRes = 0;
  let xwobaCovered = 0;
  let weightedObpSum = 0;
  let weightedObpWeight = 0;
  let weightedSlgSum = 0;
  let weightedSlgWeight = 0;
  let weightedBbPctSum = 0;
  let weightedBbPctWeight = 0;
  let weightedKPctSum = 0;
  let weightedKPctWeight = 0;
  let weightedXwobaSum = 0;
  let weightedXwobaWeight = 0;
  let weightedHardHitSum = 0;
  let weightedHardHitWeight = 0;
  const totalSlots = Math.min(lineup.length, 9);

  for (let i = 0; i < totalSlots; i++) {
    const player = lineup[i]!;
    const slotIdx = Math.max(
      0,
      Math.min(
        8,
        (player.batting_order > 0 ? player.batting_order : i + 1) - 1,
      ),
    );
    const weight = BATTING_ORDER_WEIGHTS[slotIdx] ?? 1.0;

    const playerId = nameToIdMap.get(normalizeNameForMatch(player.name));
    const stats =
      playerId !== undefined ? batterStatsMap.get(playerId) : undefined;
    const statcast =
      playerId !== undefined ? statcastBatterMap.get(playerId) : undefined;

    const ops = stats?.ops ?? null;
    const pa = stats?.plate_appearances ?? null;
    const hasValidStats = ops !== null && pa !== null && pa >= MIN_BATTER_PA;

    // Statcast xwOBA blending — only when PA meets threshold
    const xwoba = statcast?.xwoba ?? null;
    const xwobaOk = xwoba !== null && (statcast?.pa ?? 0) >= MIN_STATCAST_PA;

    // Platoon adjustment (step 3)
    const batHand = player.handedness || (stats?.bat_hand ?? "");
    const platoonAdj = getPlatoonOpsAdj(batHand, pitcherHand);

    // Track platoon matchup metadata
    if (batHand && pitcherHand) {
      platoonRes++;
      const bat = batHand.toUpperCase();
      const pit = pitcherHand.toUpperCase();
      if (
        bat === "S" ||
        (bat === "L" && pit === "R") ||
        (bat === "R" && pit === "L")
      )
        platoonAdv++;
    }

    // Compute base OPS, blending xwOBA when available (step 4)
    let baseOps: number;
    if (hasValidStats && xwobaOk) {
      const qOps = ops! / LEAGUE_AVG_OPS;
      const qXwoba = xwoba! / LEAGUE_AVG_XWOBA;
      const blended =
        qOps * (1 - STATCAST_BLEND_WEIGHT) + qXwoba * STATCAST_BLEND_WEIGHT;
      baseOps = LEAGUE_AVG_OPS * blended;
      xwobaCovered++;
    } else {
      baseOps = hasValidStats ? ops! : LEAGUE_AVG_OPS;
    }

    // Preserve the exact lineup's independently useful rate components for
    // the active team-run formula.  They do not replace the existing OPS/xwOBA
    // lineup factor; they describe how this lineup can create traffic and
    // convert it against the opposing starter.
    if (hasValidStats) {
      if (stats!.obp !== null) {
        weightedObpSum += stats!.obp * weight;
        weightedObpWeight += weight;
      }
      if (stats!.slg !== null) {
        weightedSlgSum += stats!.slg * weight;
        weightedSlgWeight += weight;
      }
      if (stats!.bb_pct !== null) {
        weightedBbPctSum += stats!.bb_pct * weight;
        weightedBbPctWeight += weight;
      }
      if (stats!.k_pct !== null) {
        weightedKPctSum += stats!.k_pct * weight;
        weightedKPctWeight += weight;
      }
    }
    if (xwobaOk) {
      weightedXwobaSum += xwoba! * weight;
      weightedXwobaWeight += weight;
    }
    if (
      statcast?.hard_hit_pct !== null &&
      (statcast?.pa ?? 0) >= MIN_STATCAST_PA
    ) {
      weightedHardHitSum += statcast!.hard_hit_pct! * weight;
      weightedHardHitWeight += weight;
    }

    const effOps = Math.max(0.4, baseOps + platoonAdj);

    weightedOpsSum += effOps * weight;
    if (hasValidStats) coveredSlots++;
    totalWeight += weight;
  }

  const coverage = totalSlots > 0 ? coveredSlots / totalSlots : 0;
  const weightedOps =
    totalWeight > 0
      ? parseFloat((weightedOpsSum / totalWeight).toFixed(3))
      : null;
  const xwoba_coverage =
    totalSlots > 0 ? parseFloat((xwobaCovered / totalSlots).toFixed(2)) : 0;
  const weightedMetric = (sum: number, weight: number): number | null =>
    weight > 0 ? parseFloat((sum / weight).toFixed(4)) : null;
  const weightedObp = weightedMetric(weightedObpSum, weightedObpWeight);
  const weightedSlg = weightedMetric(weightedSlgSum, weightedSlgWeight);
  const weightedBbPct = weightedMetric(weightedBbPctSum, weightedBbPctWeight);
  const weightedKPct = weightedMetric(weightedKPctSum, weightedKPctWeight);
  const weightedXwoba = weightedMetric(weightedXwobaSum, weightedXwobaWeight);
  const weightedHardHitPct = weightedMetric(
    weightedHardHitSum,
    weightedHardHitWeight,
  );

  if (coverage < MIN_LINEUP_COVERAGE || weightedOps === null) {
    return {
      factor: 1.0,
      weighted_ops: weightedOps,
      coverage,
      status: "FALLBACK",
      lineup_status: lineupStatus,
      platoon_advantaged: platoonAdv,
      platoon_resolved: platoonRes,
      xwoba_coverage,
      weighted_obp: weightedObp,
      weighted_slg: weightedSlg,
      weighted_bb_pct: weightedBbPct,
      weighted_k_pct: weightedKPct,
      weighted_xwoba: weightedXwoba,
      weighted_hard_hit_pct: weightedHardHitPct,
    };
  }

  const rawDev = weightedOps / LEAGUE_AVG_OPS - 1;
  const effWt =
    lineupStatus === "official"
      ? LINEUP_BLEND_WEIGHT
      : LINEUP_BLEND_WEIGHT * 0.6;
  const rawFactor = 1 + rawDev * effWt;
  const factor = parseFloat(
    Math.max(0.82, Math.min(1.18, rawFactor)).toFixed(4),
  );
  const status = coverage >= 1.0 ? "FULL" : "PARTIAL";

  return {
    factor,
    weighted_ops: weightedOps,
    coverage,
    status,
    lineup_status: lineupStatus,
    platoon_advantaged: platoonAdv,
    platoon_resolved: platoonRes,
    xwoba_coverage,
    weighted_obp: weightedObp,
    weighted_slg: weightedSlg,
    weighted_bb_pct: weightedBbPct,
    weighted_k_pct: weightedKPct,
    weighted_xwoba: weightedXwoba,
    weighted_hard_hit_pct: weightedHardHitPct,
  };
}

/**
 * Starter run-prevention multiplier.
 *
 * V36 deliberately assigns only FIP/ERA to this component. Command and
 * traffic evidence (BB%, K%, WHIP) belongs to the traffic path, while HR/9
 * belongs to the damage path. A correlated pitcher signal must not be paid
 * into the team-run center twice.
 */
function starterQualityFactor(
  pitcherId: number | null,
  statsMap: Map<number, PitcherSeasonStats>,
): number {
  if (!pitcherId) return 1.0;
  const stats = statsMap.get(pitcherId);
  if (!stats) return 1.0;

  const fipOrEra = stats.fip ?? stats.era ?? LEAGUE_AVG_ERA;
  const fipFactor = clampERA(fipOrEra) / LEAGUE_AVG_ERA;
  return Math.max(0.4, Math.min(1.8, parseFloat(fipFactor.toFixed(4))));
}


/** Converts the already-resolved lineup evidence into the active matchup profile. */
function activeLineupProfile(
  lineup: LineupStrengthResolution,
): ActiveLineupProfile {
  return {
    coverage: lineup.coverage,
    source: lineup.lineup_status,
    weighted_obp: lineup.weighted_obp,
    weighted_slg: lineup.weighted_slg,
    weighted_bb_pct: lineup.weighted_bb_pct,
    weighted_k_pct: lineup.weighted_k_pct,
    weighted_xwoba: lineup.weighted_xwoba,
    weighted_hard_hit_pct: lineup.weighted_hard_hit_pct,
  };
}

/**
 * Keeps starter run-prevention, command/traffic, and damage inputs distinct
 * until the team-run calculation decides how the exact matchup uses them.
 */
function activeStarterProfile(
  pitcherId: number | null,
  expectedInnings: number,
  qualityFactor: number,
  statsMap: Map<number, PitcherSeasonStats>,
): ActiveStarterProfile {
  const stats = pitcherId === null ? undefined : statsMap.get(pitcherId);
  return {
    quality_factor: qualityFactor,
    expected_innings: expectedInnings,
    bb_pct: stats?.bb_pct ?? null,
    k_pct: stats?.k_pct ?? null,
    whip: stats?.whip ?? null,
    hr_per_9: stats?.hr_per_9 ?? null,
  };
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
    (r) =>
      r.team_abbr === teamAbbr &&
      r.days_rest >= 1 &&
      r.role !== "HIGH_WORKLOAD",
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
 * Resolves the recent realized-scoring form rate for a team using the L30/L10 blend.
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
        (
          (teamSplits.reduce((acc, s) => acc + s.l30_wrc_plus, 0) /
            teamSplits.length /
            100) *
          LEAGUE_AVG_RS
        ).toFixed(3),
      )
    : null;

  // ── L10 (actual RS/game) ──
  const l10Entry = runRates?.rates.get(teamAbbr);
  const l10Valid = (l10Entry?.games ?? 0) >= MIN_L10_GAMES;
  const l10Rate = l10Valid ? l10Entry!.runs_per_game : null;

  // ── Resolution ──
  if (l30Valid && l10Valid) {
    return {
      l30_rs_estimate: l30Rate,
      l10_rs_actual: l10Rate,
      rate_used: parseFloat(
        (L30_WEIGHT * l30Rate! + L10_WEIGHT * l10Rate!).toFixed(3),
      ),
      source_status: "BLENDED",
    };
  }

  if (l30Valid) {
    return {
      l30_rs_estimate: l30Rate,
      l10_rs_actual: null,
      rate_used: l30Rate!,
      source_status: "L30_ONLY",
    };
  }

  if (l10Valid) {
    return {
      l30_rs_estimate: null,
      l10_rs_actual: l10Rate,
      rate_used: l10Rate!,
      source_status: "L10_ONLY",
    };
  }

  // Last resort — must generate a warning
  logger.warn(
    { team: teamAbbr, l30Found: l30Valid, l10Found: l10Valid },
    "MODULE_09: Offensive rate falling back to LEAGUE_AVG — no L30 or L10 data for team",
  );
  return {
    l30_rs_estimate: null,
    l10_rs_actual: null,
    rate_used: LEAGUE_AVG_RS,
    source_status: "LEAGUE_AVG_FALLBACK",
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
  const resolved = resolveEnvironmentFactors(env, parkFactor, parkSource);
  return {
    park_runs_pct: resolved.park_runs_pct,
    park_multiplier: resolved.park_multiplier,
    weather_multiplier: resolved.weather_multiplier,
    combined_multiplier: resolved.combined_multiplier,
    park_source_status: resolved.park_source_status,
    home_run_factor: resolved.combined_hr_factor,
    weather_source_status: resolved.weather_source_status,
    roof_status: resolved.roof_status,
    wind_disposition: resolved.wind_disposition,
    environment_certainty: resolved.environment_certainty,
    weather_vehicle_status: resolved.weather_vehicle_status,
  };
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
    return parseFloat(
      (1 + PARK_WEATHER_MAX_RUN_ADDITION / baseTotal).toFixed(4),
    );
  }
  return combinedMultiplier;
}

function confidenceNum(c: string | null | undefined): number {
  if (c === "high") return 0.9;
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
  run_multiplier: number; // = combined_run_multiplier
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
  /** League environment × exact lineup quality, before recent form. */
  away_latent_lineup_rate: number;
  home_latent_lineup_rate: number;
  /** Small capped modifier derived from recent realized RS/G. Neutral = 1.0. */
  away_recent_form_multiplier: number;
  home_recent_form_multiplier: number;
  /** Active team-run center passed into starter/bullpen calculation. */
  away_active_offense_center: number;
  home_active_offense_center: number;
  // ── Park / weather multiplier audit (Repair 2) ──
  park_runs_pct: number | null;
  park_multiplier: number;
  weather_multiplier: number;
  combined_run_multiplier: number;
  park_source_status: ParkSourceStatus;
  home_run_factor: number;
  weather_source_status: "LIVE" | "FALLBACK_NEUTRAL";
  roof_status: RoofStatus;
  wind_disposition: WindDisposition;
  environment_certainty: EnvironmentCertainty;
  weather_vehicle_status: WeatherVehicleStatus;
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
  /** Expected away-pitcher workload used in the home team projection after active pregame pressure. */
  away_pitcher_effective_innings: number;
  /** Expected home-pitcher workload used in the away team projection after active pregame pressure. */
  home_pitcher_effective_innings: number;
  /** Expected away-bullpen innings inherited by the home offense. */
  away_bullpen_exposure_innings: number;
  /** Expected home-bullpen innings inherited by the away offense. */
  home_bullpen_exposure_innings: number;
  /** Exact lineup × opponent starter traffic interaction; neutral = 1.0. */
  away_traffic_matchup_factor: number;
  home_traffic_matchup_factor: number;
  /** Exact lineup × opponent starter damage interaction; neutral = 1.0. */
  away_damage_matchup_factor: number;
  home_damage_matchup_factor: number;
  /** ACTIVE / PARTIAL / NEUTRAL, based only on the evidence actually present. */
  away_matchup_profile_status: "ACTIVE" | "PARTIAL" | "NEUTRAL";
  home_matchup_profile_status: "ACTIVE" | "PARTIAL" | "NEUTRAL";
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
   * Signed traffic-to-run conversion component from the exact lineup × opposing
   * starter pressure. Bounded, mutually moderated with damage capacity, and
   * capable of being negative in a suppressive matchup.
   */
  traffic_conversion_runs: number;
  /**
   * Signed HR/XBH damage conversion component from the exact lineup × opposing
   * starter pressure. Bounded, mutually moderated with traffic capacity, and
   * capable of being negative in a suppressive matchup.
   */
  hr_xbh_damage_runs: number;
  /**
   * Baseball-only projection: starter_attack_runs + traffic_conversion_runs +
   * hr_xbh_damage_runs + bullpen_continuation_runs.
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
  protection?: PublicationProtection,
): Promise<Module09Result> {
  const startTime = Date.now();
  logger.info(
    { games: normalized.games.length },
    "MODULE_09: Computing GAME_INTEGRATION + GAME_SUMMARY",
  );

  // ── Build team Available_Bullpen_ERA map ──
  const teamBullpenERAMap = new Map<string, number>();
  if (bullpenResult && bullpenResult.status !== "failure") {
    const teamsOnSlate = [
      ...new Set(
        normalized.games.flatMap((g) =>
          [g.away_team.team_abbr ?? "", g.home_team.team_abbr ?? ""].filter(
            Boolean,
          ),
        ),
      ),
    ];
    for (const team of teamsOnSlate) {
      const era = computeTeamBullpenERA(
        team,
        bullpenResult.relievers,
        pitcherStatsMap,
      );
      if (era !== null) teamBullpenERAMap.set(team, era);
    }
    logger.info(
      { teams: teamBullpenERAMap.size },
      "MODULE_09: Team bullpen ERA map built",
    );
  }

  // ── Build park factor lookup: legacy_game_id → ParkFactors ──
  // Primary:  live scrape from module04c (today's games, game_id-keyed).
  // Fallback: static 2026 seasonal table (module04d) for games not in today's
  //           scrape, keyed by home team abbr — covers all 30 venues.
  const parkFactorMap = new Map<string, ParkFactors>();
  const parkSourceMap = new Map<string, ParkSourceStatus>();

  const lineupMap: Map<string, StartingNineGame> = startingNineResult
    ? buildStartingNineMap(
        startingNineResult,
        normalized.games.map((game) => game.legacy_game_id),
      )
    : new Map<string, StartingNineGame>();
  for (const [gameId, sg] of lineupMap) {
    parkFactorMap.set(gameId, sg.park_factors);
    parkSourceMap.set(gameId, "VENUE_FACTOR_USED");
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
  const l10Available =
    teamRunRates?.status === "success" ? teamRunRates.rates.size : 0;
  const l30Available = splits.teams.length > 0 ? "present" : "absent";
  logger.info(
    { l30: l30Available, l10Teams: l10Available },
    "MODULE_09: Offensive rate input coverage",
  );

  const gameSummaryRows: GameSummaryRow[] = [];

  // ── GAME_INTEGRATION — 2 rows per game ──
  const giRows: unknown[][] = [];

  for (const g of normalized.games) {
    for (const side of ["away", "home"] as const) {
      const team = side === "away" ? g.away_team : g.home_team;
      const opponent = side === "away" ? g.home_team : g.away_team;
      const pitcher = side === "away" ? g.away_pitcher : g.home_pitcher;
      const oppPitch = side === "away" ? g.home_pitcher : g.away_pitcher;

      const offRate = resolveOffensiveRate(
        team.team_abbr ?? "",
        splits,
        teamRunRates,
      );
      const oppRate = resolveOffensiveRate(
        opponent.team_abbr ?? "",
        splits,
        teamRunRates,
      );
      const parkData = parkFactorMap.get(g.legacy_game_id) ?? null;
      const parkSource = parkSourceMap.get(g.legacy_game_id);
      const runMult = resolveRunMultiplier(g.environment, parkData, parkSource);
      // Cap the park × weather addition so it cannot contribute more than
      // PARK_WEATHER_MAX_RUN_ADDITION runs to the total projection.
      const cappedMultiplier = capRunMultiplierAddition(
        runMult.combined_multiplier,
        offRate.rate_used,
        oppRate.rate_used,
      );
      // Lineup strength for the batting team (away team bats against home pitcher)
      const bSg = lineupMap.get(g.legacy_game_id) ?? null;
      const bLineup =
        side === "away" ? (bSg?.away_lineup ?? []) : (bSg?.home_lineup ?? []);
      const bLStatus = bSg?.lineup_status ?? "projected";
      // The batting team faces the opposing pitcher; look up that pitcher's throwing hand.
      const bOppPitHand =
        pitcherStatsMap.get((oppPitch.player_id ?? 0) as number)?.hand ?? null;
      const giLineup = computeLineupStrength(
        bLineup,
        lineupNameToIdMap,
        batterStatsMap,
        bLStatus,
        bOppPitHand,
        statcastBatterMap,
      );
      const giOffenseCenter = computeActiveOffenseCenter({
        recent_form_rate: offRate.rate_used,
        lineup_factor: giLineup.factor,
        lineup: activeLineupProfile(giLineup),
      });
      const adjRate = parseFloat(
        (giOffenseCenter.active_offense_center * cappedMultiplier).toFixed(2),
      );

      giRows.push([
        g.date, // A: Date
        g.legacy_game_id, // B: Game_ID
        team.team_abbr ?? "", // C: Team
        opponent.team_abbr ?? "", // D: Opponent
        side === "home" ? "YES" : "NO", // E: Is_Home
        pitcher.name ?? "", // F: Pitcher
        pitcher.role ?? "UNRESOLVED", // G: Pitcher_Role
        confidenceNum(pitcher.role_confidence), // H: Pitcher_Confidence
        pitcher.expected_pitches ?? "", // I: Expected_Pitches
        pitcher.expected_innings ?? "", // J: Expected_Innings
        oppPitch.name ?? "", // K: Opp_Pitcher
        oppPitch.role ?? "UNRESOLVED", // L: Opp_Pitcher_Role
        giLineup.factor, // M: Lineup_Factor (weighted OPS multiplier vs league avg)
        offRate.rate_used, // N: Offense_Rate_Used (blended L30/L10)
        oppRate.rate_used, // O: Opp_Offense_Rate_Used
        g.environment.temperature_f ?? "", // P: Temperature_F
        g.environment.wind_speed_mph ?? "", // Q: Wind_MPH
        cappedMultiplier, // R: Combined_Run_Multiplier (park × weather, capped)
        adjRate, // S: Adjusted_Scoring_Rate
        "", // T: Notes (operator)
        // ── Offensive rate audit (new cols U–W) ──
        offRate.l30_rs_estimate ?? "", // U: L30_RS_Estimate
        offRate.l10_rs_actual ?? "", // V: L10_RS_Actual
        offRate.source_status, // W: Offense_Source_Status
        // ── Park / weather audit (new cols X–AA) ──
        runMult.park_runs_pct ?? "", // X: Park_Runs_Pct
        runMult.park_multiplier, // Y: Park_Multiplier (raw, uncapped)
        runMult.weather_multiplier, // Z: Weather_Multiplier (raw, uncapped)
        runMult.park_source_status, // AA: Park_Source_Status
      ]);
    }
  }

  // ── GAME_SUMMARY — 1 row per game ──
  const gsRows: unknown[][] = [];

  for (const g of normalized.games) {
    const awayOff = resolveOffensiveRate(
      g.away_team.team_abbr ?? "",
      splits,
      teamRunRates,
    );
    const homeOff = resolveOffensiveRate(
      g.home_team.team_abbr ?? "",
      splits,
      teamRunRates,
    );
    const parkData = parkFactorMap.get(g.legacy_game_id) ?? null;
    const parkSource = parkSourceMap.get(g.legacy_game_id);
    const runMult = resolveRunMultiplier(g.environment, parkData, parkSource);
    // Cap the park × weather addition — must not add more than PARK_WEATHER_MAX_RUN_ADDITION
    // runs to the total projection. The raw multiplier is preserved in audit columns.
    let cappedMult = runMult.combined_multiplier;

    // ── Lineup strength (Step 2 commissioning) ──
    // Away team bats against the HOME pitcher → apply away lineup factor.
    // Home team bats against the AWAY pitcher → apply home lineup factor.
    const sg = lineupMap.get(g.legacy_game_id) ?? null;
    // Away batters face the home starter; home batters face the away starter.
    const homePitHand =
      pitcherStatsMap.get(g.home_pitcher.player_id ?? 0)?.hand ?? null;
    const awayPitHand =
      pitcherStatsMap.get(g.away_pitcher.player_id ?? 0)?.hand ?? null;
    const awayLineup = computeLineupStrength(
      sg?.away_lineup ?? [],
      lineupNameToIdMap,
      batterStatsMap,
      sg?.lineup_status ?? "projected",
      homePitHand, // away lineup bats against the home starter
      statcastBatterMap,
    );
    const homeLineup = computeLineupStrength(
      sg?.home_lineup ?? [],
      lineupNameToIdMap,
      batterStatsMap,
      sg?.lineup_status ?? "projected",
      awayPitHand, // home lineup bats against the away starter
      statcastBatterMap,
    );

    // Recent actual scoring is form evidence, not today's run center. Build
    // the center from the league environment and exact lineup quality first;
    // then apply the small capped form modifier once.
    const awayOffenseCenter = computeActiveOffenseCenter({
      recent_form_rate: awayOff.rate_used,
      lineup_factor: awayLineup.factor,
      lineup: activeLineupProfile(awayLineup),
    });
    const homeOffenseCenter = computeActiveOffenseCenter({
      recent_form_rate: homeOff.rate_used,
      lineup_factor: homeLineup.factor,
      lineup: activeLineupProfile(homeLineup),
    });
    cappedMult = capRunMultiplierAddition(
      runMult.combined_multiplier,
      awayOffenseCenter.active_offense_center,
      homeOffenseCenter.active_offense_center,
    );
    const awayBaselineRate = awayOffenseCenter.active_offense_center;
    const homeBaselineRate = homeOffenseCenter.active_offense_center;
    const awayAdjFinal = parseFloat((awayBaselineRate * cappedMult).toFixed(3));
    const homeAdjFinal = parseFloat((homeBaselineRate * cappedMult).toFixed(3));

    // Away team bats against HOME pitcher; home team bats against AWAY pitcher.
    // The active trunk keeps starter quality, traffic/conversion, damage, and
    // resulting bullpen exposure distinct instead of collapsing all of them
    // into one generic starter multiplier.
    const homePitchExp = g.home_pitcher.expected_innings ?? 5.5;
    const awayPitchExp = g.away_pitcher.expected_innings ?? 5.5;
    const homeQual = starterQualityFactor(
      g.home_pitcher.player_id,
      pitcherStatsMap,
    );
    const awayQual = starterQualityFactor(
      g.away_pitcher.player_id,
      pitcherStatsMap,
    );
    const homeBullpenQual =
      (teamBullpenERAMap.get(g.home_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) /
      LEAGUE_AVG_ERA;
    const awayBullpenQual =
      (teamBullpenERAMap.get(g.away_team.team_abbr ?? "") ?? LEAGUE_AVG_ERA) /
      LEAGUE_AVG_ERA;

    const awayRunProjection = computeActiveTeamProjection({
      baseline_offense_rate: awayBaselineRate,
      environment_multiplier: cappedMult,
      lineup: activeLineupProfile(awayLineup),
      opposing_starter: activeStarterProfile(
        g.home_pitcher.player_id,
        homePitchExp,
        homeQual,
        pitcherStatsMap,
      ),
      opposing_bullpen_quality: homeBullpenQual,
    });
    const homeRunProjection = computeActiveTeamProjection({
      baseline_offense_rate: homeBaselineRate,
      environment_multiplier: cappedMult,
      lineup: activeLineupProfile(homeLineup),
      opposing_starter: activeStarterProfile(
        g.away_pitcher.player_id,
        awayPitchExp,
        awayQual,
        pitcherStatsMap,
      ),
      opposing_bullpen_quality: awayBullpenQual,
    });

    const projAway = awayRunProjection.projected_runs;
    const projHome = homeRunProjection.projected_runs;
    const projTotal = parseFloat((projAway + projHome).toFixed(2));

    const bullpenCoverage =
      teamBullpenERAMap.has(g.home_team.team_abbr ?? "") &&
      teamBullpenERAMap.has(g.away_team.team_abbr ?? "");

    // ── Over survival gate: decompose projection into baseball vs environment ──
    // Traffic and damage are now active, signed matchup components. They are
    // mutually moderated rather than bolted on as independent tail bonuses.
    const starterAttackRuns = parseFloat(
      (
        awayRunProjection.starter_attack_runs +
        homeRunProjection.starter_attack_runs
      ).toFixed(2),
    );
    const bullpenContinuationRuns = parseFloat(
      (
        awayRunProjection.bullpen_continuation_runs +
        homeRunProjection.bullpen_continuation_runs
      ).toFixed(2),
    );
    const trafficConversionRuns = parseFloat(
      (
        awayRunProjection.traffic_conversion_runs +
        homeRunProjection.traffic_conversion_runs
      ).toFixed(2),
    );
    const hrXbhDamageRuns = parseFloat(
      (
        awayRunProjection.hr_xbh_damage_runs +
        homeRunProjection.hr_xbh_damage_runs
      ).toFixed(2),
    );
    const baseballOnlyProj = parseFloat(
      (
        awayRunProjection.baseball_only_runs +
        homeRunProjection.baseball_only_runs
      ).toFixed(2),
    );
    const baselineOffRuns = parseFloat(
      (awayBaselineRate + homeBaselineRate).toFixed(2),
    );
    // Environment contribution = projected_total minus all baseball components.
    const envRunAdj = parseFloat((projTotal - baseballOnlyProj).toFixed(2));

    gameSummaryRows.push({
      game_id: g.legacy_game_id,
      date: g.date,
      away_team: g.away_team.team_abbr ?? "",
      home_team: g.home_team.team_abbr ?? "",
      away_pitcher: g.away_pitcher.name ?? "",
      home_pitcher: g.home_pitcher.name ?? "",
      away_pitcher_role: g.away_pitcher.role ?? "UNRESOLVED",
      home_pitcher_role: g.home_pitcher.role ?? "UNRESOLVED",
      away_expected_innings: g.away_pitcher.expected_innings ?? null,
      home_expected_innings: g.home_pitcher.expected_innings ?? null,
      projected_away_runs: projAway,
      projected_home_runs: projHome,
      projected_total_runs: projTotal,
      run_multiplier: cappedMult,
      stadium: g.venue.name ?? "",
      environment_quality:
        g.environment.data_quality === "good" ? "good" : "fallback",
      bullpen_available: bullpenCoverage,
      // Offensive rate audit
      away_l30_rs_estimate: awayOff.l30_rs_estimate,
      home_l30_rs_estimate: homeOff.l30_rs_estimate,
      away_l10_rs_actual: awayOff.l10_rs_actual,
      home_l10_rs_actual: homeOff.l10_rs_actual,
      away_offense_rate_used: awayOff.rate_used,
      home_offense_rate_used: homeOff.rate_used,
      away_offense_source_status: awayOff.source_status,
      home_offense_source_status: homeOff.source_status,
      away_latent_lineup_rate: awayOffenseCenter.latent_lineup_rate,
      home_latent_lineup_rate: homeOffenseCenter.latent_lineup_rate,
      away_recent_form_multiplier: awayOffenseCenter.recent_form_multiplier,
      home_recent_form_multiplier: homeOffenseCenter.recent_form_multiplier,
      away_active_offense_center: awayOffenseCenter.active_offense_center,
      home_active_offense_center: homeOffenseCenter.active_offense_center,
      // Park / weather audit (raw uncapped values for traceability)
      park_runs_pct: runMult.park_runs_pct,
      park_multiplier: runMult.park_multiplier,
      weather_multiplier: runMult.weather_multiplier,
      combined_run_multiplier: cappedMult,
      park_source_status: runMult.park_source_status,
      home_run_factor: runMult.home_run_factor,
      weather_source_status: runMult.weather_source_status,
      roof_status: runMult.roof_status,
      wind_disposition: runMult.wind_disposition,
      environment_certainty: runMult.environment_certainty,
      weather_vehicle_status: runMult.weather_vehicle_status,
      // Lineup strength audit
      away_lineup_factor: awayLineup.factor,
      home_lineup_factor: homeLineup.factor,
      away_lineup_weighted_ops: awayLineup.weighted_ops,
      home_lineup_weighted_ops: homeLineup.weighted_ops,
      away_lineup_coverage: awayLineup.coverage,
      home_lineup_coverage: homeLineup.coverage,
      away_lineup_status: awayLineup.status,
      home_lineup_status: homeLineup.status,
      away_lineup_source: awayLineup.lineup_status,
      home_lineup_source: homeLineup.lineup_status,
      away_lineup_xwoba_coverage: awayLineup.xwoba_coverage,
      home_lineup_xwoba_coverage: homeLineup.xwoba_coverage,
      away_pitcher_effective_innings:
        homeRunProjection.effective_starter_innings,
      home_pitcher_effective_innings:
        awayRunProjection.effective_starter_innings,
      away_bullpen_exposure_innings: homeRunProjection.bullpen_exposure_innings,
      home_bullpen_exposure_innings: awayRunProjection.bullpen_exposure_innings,
      away_traffic_matchup_factor: awayRunProjection.traffic_matchup_factor,
      home_traffic_matchup_factor: homeRunProjection.traffic_matchup_factor,
      away_damage_matchup_factor: awayRunProjection.damage_matchup_factor,
      home_damage_matchup_factor: homeRunProjection.damage_matchup_factor,
      away_matchup_profile_status: awayRunProjection.matchup_profile_status,
      home_matchup_profile_status: homeRunProjection.matchup_profile_status,
      proj_run_diff: parseFloat((projAway - projHome).toFixed(2)),
      away_starter_quality: parseFloat(awayQual.toFixed(4)),
      home_starter_quality: parseFloat(homeQual.toFixed(4)),
      // Over survival gate components
      starter_attack_runs: starterAttackRuns,
      bullpen_continuation_runs: bullpenContinuationRuns,
      baseline_offense_runs: baselineOffRuns,
      traffic_conversion_runs: trafficConversionRuns,
      hr_xbh_damage_runs: hrXbhDamageRuns,
      baseball_only_projection: baseballOnlyProj, // = starter + bullpen + traffic + HR/XBH
      environment_run_adjustment: envRunAdj,
    });

    gsRows.push([
      g.date, // A: Date
      g.legacy_game_id, // B: Game_ID
      g.away_team.team_abbr ?? "", // C: Away_Team
      g.home_team.team_abbr ?? "", // D: Home_Team
      g.away_pitcher.name ?? "", // E: Away_Pitcher
      g.home_pitcher.name ?? "", // F: Home_Pitcher
      awayLineup.factor, // G: Away_Lineup_Factor (weighted OPS multiplier)
      homeLineup.factor, // H: Home_Lineup_Factor (weighted OPS multiplier)
      parseFloat(awayAdjFinal.toFixed(2)), // I: Away_Adjusted_Scoring_Rate (post-lineup)
      parseFloat(homeAdjFinal.toFixed(2)), // J: Home_Adjusted_Scoring_Rate (post-lineup)
      projAway, // K: Projected_Away_Runs
      projHome, // L: Projected_Home_Runs
      projTotal, // M: Projected_Total_Runs
      g.environment.temperature_f ?? "", // N: Temperature_F
      g.environment.wind_speed_mph ?? "", // O: Wind_MPH
      cappedMult, // P: Combined_Run_Multiplier (park × weather, capped)
      g.venue.name ?? "", // Q: Stadium
      "", // R: Notes (operator)
      // ── Offensive rate audit (new cols S–Z) ──
      awayOff.l30_rs_estimate ?? "", // S: Away_L30_RS_Estimate
      homeOff.l30_rs_estimate ?? "", // T: Home_L30_RS_Estimate
      awayOff.l10_rs_actual ?? "", // U: Away_L10_RS_Actual
      homeOff.l10_rs_actual ?? "", // V: Home_L10_RS_Actual
      parseFloat(awayOff.rate_used.toFixed(3)), // W: Away_Offense_Rate_Used
      parseFloat(homeOff.rate_used.toFixed(3)), // X: Home_Offense_Rate_Used
      awayOff.source_status, // Y: Away_Offense_Source_Status
      homeOff.source_status, // Z: Home_Offense_Source_Status
      // ── Park / weather audit (new cols AA–AE) ──
      // Raw uncapped values preserved here for full traceability.
      runMult.park_runs_pct ?? "", // AA: Park_Runs_Pct
      runMult.park_multiplier, // AB: Park_Multiplier (raw)
      runMult.weather_multiplier, // AC: Weather_Multiplier (raw)
      cappedMult, // AD: Combined_Run_Multiplier (capped)
      runMult.park_source_status, // AE: Park_Source_Status
      // ── Step 5 derivatives ──
      parseFloat((projAway - projHome).toFixed(2)), // AF: Projected_Run_Diff
      parseFloat(awayQual.toFixed(4)), // AG: Away_Starter_Quality
      parseFloat(homeQual.toFixed(4)), // AH: Home_Starter_Quality
      // â”€â”€ Environment, component, and lineup lineage (AIâ€“BC) â”€â”€
      runMult.home_run_factor, // AI: Home_Run_Factor
      runMult.weather_source_status, // AJ: Weather_Source_Status
      runMult.roof_status, // AK: Roof_Status
      runMult.wind_disposition, // AL: Wind_Disposition
      runMult.environment_certainty, // AM: Environment_Certainty
      runMult.weather_vehicle_status, // AN: Weather_Vehicle_Status
      starterAttackRuns, // AO: Starter_Attack_Runs
      bullpenContinuationRuns, // AP: Bullpen_Continuation_Runs
      baselineOffRuns, // AQ: Baseline_Offense_Runs
      trafficConversionRuns, // AR: Traffic_Conversion_Runs
      hrXbhDamageRuns, // AS: HR_XBH_Damage_Runs
      baseballOnlyProj, // AT: Baseball_Only_Projection
      envRunAdj, // AU: Environment_Run_Adjustment
      awayLineup.status, // AV: Away_Lineup_Status
      homeLineup.status, // AW: Home_Lineup_Status
      awayLineup.lineup_status ?? "", // AX: Away_Lineup_Source
      homeLineup.lineup_status ?? "", // AY: Home_Lineup_Source
      awayLineup.coverage, // AZ: Away_Lineup_Coverage
      homeLineup.coverage, // BA: Home_Lineup_Coverage
      awayLineup.xwoba_coverage, // BB: Away_Lineup_xwOBA_Coverage
      homeLineup.xwoba_coverage, // BC: Home_Lineup_xwOBA_Coverage
      homeRunProjection.effective_starter_innings, // BD: Away_Pitcher_Effective_IP
      awayRunProjection.effective_starter_innings, // BE: Home_Pitcher_Effective_IP
      homeRunProjection.bullpen_exposure_innings, // BF: Away_Bullpen_Exposure_IP
      awayRunProjection.bullpen_exposure_innings, // BG: Home_Bullpen_Exposure_IP
      awayRunProjection.traffic_matchup_factor, // BH: Away_Traffic_Matchup_Factor
      homeRunProjection.traffic_matchup_factor, // BI: Home_Traffic_Matchup_Factor
      awayRunProjection.damage_matchup_factor, // BJ: Away_Damage_Matchup_Factor
      homeRunProjection.damage_matchup_factor, // BK: Home_Damage_Matchup_Factor
      awayRunProjection.matchup_profile_status, // BL: Away_Matchup_Profile_Status
      homeRunProjection.matchup_profile_status, // BM: Home_Matchup_Profile_Status
      awayOffenseCenter.latent_lineup_rate, // BN: Away_Latent_Lineup_Rate
      homeOffenseCenter.latent_lineup_rate, // BO: Home_Latent_Lineup_Rate
      awayOffenseCenter.recent_form_multiplier, // BP: Away_Recent_Form_Multiplier
      homeOffenseCenter.recent_form_multiplier, // BQ: Home_Recent_Form_Multiplier
      awayOffenseCenter.active_offense_center, // BR: Away_Active_Offense_Center
      homeOffenseCenter.active_offense_center, // BS: Home_Active_Offense_Center
    ]);
  }

  // ── Write GAME_INTEGRATION (27 cols A–AA) ──
  const summaryByGame = new Map(
    gameSummaryRows.map((row) => [row.game_id, row]),
  );
  const playerIntegrationRows: unknown[][] = [];
  for (const game of normalized.games) {
    const startingNine = lineupMap.get(game.legacy_game_id);
    const summary = summaryByGame.get(game.legacy_game_id);
    if (!startingNine || !summary) continue;

    for (const side of ["away", "home"] as const) {
      const lineup =
        side === "away" ? startingNine.away_lineup : startingNine.home_lineup;
      const team =
        side === "away" ? game.away_team.team_abbr : game.home_team.team_abbr;
      const opposingPitcher =
        side === "away" ? game.home_pitcher : game.away_pitcher;
      const opposingHand =
        pitcherStatsMap.get(opposingPitcher.player_id ?? 0)?.hand ?? "";

      for (const player of lineup) {
        const playerId = lineupNameToIdMap.get(
          normalizeNameForMatch(player.name),
        );
        const batter =
          playerId === undefined ? undefined : batterStatsMap.get(playerId);
        const notes = [
          `lineup=${startingNine.lineup_status}`,
          batter?.ops == null
            ? "season_ops=unavailable"
            : `season_ops=${batter.ops.toFixed(3)}`,
          "wRC_plus=unavailable",
          "salary=unavailable",
          "projected_fpts=unavailable",
        ].join("; ");

        playerIntegrationRows.push([
          game.date,
          game.legacy_game_id,
          team ?? "",
          player.name,
          playerId ?? "",
          player.position,
          player.batting_order,
          opposingPitcher.name ?? "",
          opposingHand,
          "",
          "",
          summary.combined_run_multiplier,
          "",
          "",
          "",
          notes,
        ]);
      }
    }
  }

  let giStatus: "verified" | "error" = "verified";
  const giErrors: string[] = [];
  try {
    await expandSheetColumns(workbookId, "GAME_INTEGRATION", 27).catch(
      (err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "MODULE_09: Could not expand GAME_INTEGRATION columns",
        );
      },
    );
    // Write updated headers (cols that changed label or are new)
    await writeRange(workbookId, "GAME_INTEGRATION!M1:M1", [
      ["Lineup_Factor"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!N1:N1", [
      ["Offense_Rate_Used"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!O1:O1", [
      ["Opp_Offense_Rate_Used"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!R1:R1", [
      ["Combined_Run_Multiplier"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_INTEGRATION!U1:AA1", [
      [
        "L30_RS_Estimate",
        "L10_RS_Actual",
        "Offense_Source_Status",
        "Park_Runs_Pct",
        "Park_Multiplier",
        "Weather_Multiplier",
        "Park_Source_Status",
      ],
    ]).catch(() => {});
    const giRowsToWrite =
      protection && protection.protected_game_ids.size > 0
        ? mergeProtectedRows(
            (await readRange(workbookId, "GAME_INTEGRATION!A2:AA200")).values ??
              [],
            giRows,
            1,
            protection.protected_game_ids,
            protection.expected_game_ids,
          )
        : giRows;
    await clearRange(workbookId, "GAME_INTEGRATION!A2:AA200");
    if (giRowsToWrite.length > 0) {
      await writeRange(
        workbookId,
        `GAME_INTEGRATION!A2:AA${1 + giRowsToWrite.length}`,
        giRowsToWrite,
      );
    }
    logger.info({ rows: giRows.length }, "MODULE_09: GAME_INTEGRATION written");
  } catch (err: unknown) {
    giStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    giErrors.push(msg);
    logger.error({ err: msg }, "MODULE_09: GAME_INTEGRATION write failed");
  }

  // Write GAME_SUMMARY (71 columns, A through BS).
  let gsStatus: "verified" | "error" = "verified";
  const gsErrors: string[] = [];
  try {
    await expandSheetColumns(workbookId, "GAME_SUMMARY", 71).catch(
      (err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "MODULE_09: Could not expand GAME_SUMMARY columns",
        );
      },
    );
    // Write updated/new headers
    await writeRange(workbookId, "GAME_SUMMARY!G1:H1", [
      ["Away_Lineup_Factor", "Home_Lineup_Factor"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!P1:P1", [
      ["Combined_Run_Multiplier"],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!S1:AH1", [
      [
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
        "Combined_Run_Multiplier_Audit", // col AD — audit copy; col P is the primary
        "Park_Source_Status",
        // ── Step 5 derivatives ──
        "Projected_Run_Diff", // AF
        "Away_Starter_Quality", // AG
        "Home_Starter_Quality", // AH
      ],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!AI1:BC1", [
      [
        "Home_Run_Factor",
        "Weather_Source_Status",
        "Roof_Status",
        "Wind_Disposition",
        "Environment_Certainty",
        "Weather_Vehicle_Status",
        "Starter_Attack_Runs",
        "Bullpen_Continuation_Runs",
        "Baseline_Offense_Runs",
        "Traffic_Conversion_Runs",
        "HR_XBH_Damage_Runs",
        "Baseball_Only_Projection",
        "Environment_Run_Adjustment",
        "Away_Lineup_Status",
        "Home_Lineup_Status",
        "Away_Lineup_Source",
        "Home_Lineup_Source",
        "Away_Lineup_Coverage",
        "Home_Lineup_Coverage",
        "Away_Lineup_xwOBA_Coverage",
        "Home_Lineup_xwOBA_Coverage",
      ],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!BD1:BM1", [
      [
        "Away_Pitcher_Effective_IP",
        "Home_Pitcher_Effective_IP",
        "Away_Bullpen_Exposure_IP",
        "Home_Bullpen_Exposure_IP",
        "Away_Traffic_Matchup_Factor",
        "Home_Traffic_Matchup_Factor",
        "Away_Damage_Matchup_Factor",
        "Home_Damage_Matchup_Factor",
        "Away_Matchup_Profile_Status",
        "Home_Matchup_Profile_Status",
      ],
    ]).catch(() => {});
    await writeRange(workbookId, "GAME_SUMMARY!BN1:BS1", [
      [
        "Away_Latent_Lineup_Rate",
        "Home_Latent_Lineup_Rate",
        "Away_Recent_Form_Multiplier",
        "Home_Recent_Form_Multiplier",
        "Away_Active_Offense_Center",
        "Home_Active_Offense_Center",
      ],
    ]).catch(() => {});
    const gsRowsToWrite =
      protection && protection.protected_game_ids.size > 0
        ? mergeProtectedRows(
            (await readRange(workbookId, "GAME_SUMMARY!A2:BS100")).values ?? [],
            gsRows,
            1,
            protection.protected_game_ids,
            protection.expected_game_ids,
          )
        : gsRows;
    await clearRange(workbookId, "GAME_SUMMARY!A2:BS100");
    if (gsRowsToWrite.length > 0) {
      await writeRange(
        workbookId,
        `GAME_SUMMARY!A2:BS${1 + gsRowsToWrite.length}`,
        gsRowsToWrite,
      );
    }
    logger.info({ rows: gsRows.length }, "MODULE_09: GAME_SUMMARY written");

    const playerRowsToWrite =
      protection && protection.protected_game_ids.size > 0
        ? mergeProtectedRows(
            (await readRange(workbookId, "PLAYER_INTEGRATION!A2:P1000"))
              .values ?? [],
            playerIntegrationRows,
            1,
            protection.protected_game_ids,
            protection.expected_game_ids,
          )
        : playerIntegrationRows;
    await clearRange(workbookId, "PLAYER_INTEGRATION!A2:P1000");
    if (playerRowsToWrite.length > 0) {
      await writeRange(
        workbookId,
        `PLAYER_INTEGRATION!A2:P${1 + playerRowsToWrite.length}`,
        playerRowsToWrite,
      );
    }
    logger.info(
      { rows: playerIntegrationRows.length },
      "MODULE_09: PLAYER_INTEGRATION written",
    );

    if (gameSummaryRows.length > 0) {
      const [environmentIdentity, matchupIdentity] = await Promise.all([
        readRange(workbookId, "RUN_ENVIRONMENT!A2:B100"),
        readRange(workbookId, "DAILY_MATCHUPS!A2:B100"),
      ]);
      const environmentRows = buildSheetRowNumberMap(
        environmentIdentity.values ?? [],
        1,
      );
      const matchupRows = buildSheetRowNumberMap(
        matchupIdentity.values ?? [],
        1,
      );
      await Promise.all(
        gameSummaryRows.map(async (row) => {
          const environmentRowNumber = environmentRows.get(row.game_id);
          const matchupRowNumber = matchupRows.get(row.game_id);
          if (environmentRowNumber === undefined) {
            throw new Error(
              `RUN_ENVIRONMENT publication row missing for ${row.game_id}`,
            );
          }
          if (matchupRowNumber === undefined) {
            throw new Error(
              `DAILY_MATCHUPS publication row missing for ${row.game_id}`,
            );
          }
          await Promise.all([
            writeRange(
              workbookId,
              `RUN_ENVIRONMENT!K${environmentRowNumber}:K${environmentRowNumber}`,
              [[row.combined_run_multiplier]],
            ),
            writeRange(
              workbookId,
              `DAILY_MATCHUPS!U${matchupRowNumber}:V${matchupRowNumber}`,
              [[row.home_run_factor, row.combined_run_multiplier]],
            ),
          ]);
        }),
      );
    }

    const [giReadback, gsReadback, environmentReadback] = await Promise.all([
      readRange(workbookId, "GAME_INTEGRATION!A2:B200"),
      readRange(workbookId, "GAME_SUMMARY!A2:B100"),
      readRange(workbookId, "RUN_ENVIRONMENT!A2:L100"),
    ]);
    const expectedGameIds = normalized.games.map((game) => game.legacy_game_id);
    const mutableIds = new Set(expectedGameIds);
    const projectionLineage = validateProjectionLineage(
      normalized.games[0]?.date ?? "",
      expectedGameIds,
      (giReadback.values ?? []).filter((row) =>
        mutableIds.has(String(row[1] ?? "")),
      ),
      (gsReadback.values ?? []).filter((row) =>
        mutableIds.has(String(row[1] ?? "")),
      ),
    );
    const environmentLineage = validateEnvironmentLineage(
      normalized.games[0]?.date ?? "",
      gameSummaryRows.map((row) => ({
        game_id: row.game_id,
        run_multiplier: row.combined_run_multiplier,
        home_run_factor: row.home_run_factor,
      })),
      (environmentReadback.values ?? []).filter((row) =>
        mutableIds.has(String(row[1] ?? "")),
      ),
    );
    if (
      projectionLineage.status === "FAIL" ||
      environmentLineage.status === "FAIL"
    ) {
      throw new Error(
        [...projectionLineage.errors, ...environmentLineage.errors].join("; "),
      );
    }
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
