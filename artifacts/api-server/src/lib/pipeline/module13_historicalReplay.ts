/**
 * Module 13: Historical Replay
 * Runs the 5-variant projection model over a range of completed past dates
 * and computes the 8 primary metrics for each variant.
 *
 * Purpose: validate the 65/35 blend weights and park factor integration
 * against ground truth (actual game totals) before canonising parameters.
 *
 * 5 variants (all use neutral weather = 1.0; historical weather is not stored):
 *   1. LEGACY          — L30-only offense, no park factor (1.0)
 *   2. L30_PARK        — L30-only offense, park factor applied
 *   3. L10_PARK        — L10-actual offense, park factor applied
 *   4. BLEND           — 65% L30 + 35% L10, no park factor (1.0)
 *   5. BLEND_PARK      — 65% L30 + 35% L10, park factor applied  ← current repaired candidate
 *
 * Projection formula (simplified — no pitcher ERA or bullpen adjustment):
 *   projected_total = (away_offense_adj + home_offense_adj)
 *   where offense_adj = offense_rate × environment_multiplier
 *
 * Simplification rationale: pitcher quality and bullpen effects are held
 * constant across variants. Only offense rate and park factor differ. The
 * simplified formula cleanly isolates each variable's contribution.
 * Absolute projected values will differ from the live pipeline's output;
 * only relative variant differences are meaningful.
 *
 * L30 data source: MLB Stats API actual runs scored per game over the 30
 * calendar days before each replay date (date-anchored — no lookahead, no
 * proxy). NOTE: this intentionally differs from production module 09, whose
 * L30 leg is wRC+-derived from module 05 — which is currently a STUB emitting
 * identical splits for all 30 teams (see module05_fangraphs.ts header). The
 * replay therefore measures the blend design with a REAL L30 signal; the
 * production L30 source needs its own repair before the blend behaves the
 * same way live.
 *
 * Park factors source: mlbstartingnine.com. The site serves only the CURRENT
 * day's page (the ?date query param is ignored), so historical venue coverage
 * is impossible from this source. Venues absent from today's slate get a
 * neutral 1.0 multiplier; coverage below PARK_MIN_VENUES_WARN is flagged in
 * result errors.
 *
 * L10 data source: MLB Stats API game logs as of each replay date. Accurate.
 *
 * 8 primary metrics (per variant):
 *   1. MAE              — mean absolute error
 *   2. Median AE        — median absolute error
 *   3. Bias             — mean (projected − actual); positive = overprojection
 *   4. Miss_4Plus_Pct   — % of games where |error| ≥ 4 runs
 *   5. Overproject_Pct  — % of games where projected > actual
 *   6. Underproject_Pct — % of games where projected < actual
 *   7. Directional_Acc  — % correct vs closing market total (skipped when odds absent)
 *   8. Calibration      — MAE breakdown by projection band (< 7, 7–9, 9–11, ≥ 11)
 */

import { clearRange, expandSheetColumns, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import { fetchTeamRunRates } from "./module05c_teamRunRates.js";
import { SEASONAL_PARK_FACTORS_2026 } from "./module04d_parkFactors.js";
import type { ParkFactors } from "./module04c_startingNine.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { fetchPitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MLB_API        = "https://statsapi.mlb.com/api/v1";
const LEAGUE_AVG_RS  = 4.5;
const L30_WEIGHT     = 0.65;
const L10_WEIGHT     = 0.35;
const MIN_L10_GAMES  = 5;
const MAX_DATE_RANGE = 30;

// ── Pitcher quality constants (must stay in sync with module09) ──
const LEAGUE_AVG_ERA      = 4.20;
const LEAGUE_AVG_K_BB_PCT = 0.148;
const K_BB_BLEND_WEIGHT   = 0.70;

// Park multiplier clamp (matches module09)
const PARK_MIN = 0.85;
const PARK_MAX = 1.15;

// L30-actual offense window (MLB Stats API schedule-range, date-anchored)
const L30_LOOKBACK_DAYS = 30; // calendar window before each replay date
const L30_LAST_N        = 30; // effectively uncapped within the window (~27 games)
const MIN_L30_GAMES     = 15; // below this, L30 treated as missing

// PARK_MIN_VENUES_WARN removed — park factors now come from static 2026 seasonal table (all 30 venues)

const REPLAY_RESULTS_SHEET = "REPLAY_RESULTS";
const REPLAY_METRICS_SHEET = "REPLAY_METRICS";

const RESULTS_HEADER: string[] = [
  "Replay_Date", "Game_ID", "Away_Team", "Home_Team",
  "Actual_Total",
  "Legacy_Projected", "L30_Park_Projected", "L10_Park_Projected",
  "Blend_Projected",  "Blend_Park_Projected",
  "Legacy_Error",     "L30_Park_Error",      "L10_Park_Error",
  "Blend_Error",      "Blend_Park_Error",
  "Away_L30_Rate",    "Home_L30_Rate",
  "Away_L10_Rate",    "Home_L10_Rate",
  "Away_Offense_Source", "Home_Offense_Source",
  "Park_Runs_Pct",    "Park_Multiplier",
  "Park_Source_Status",
  // ── Step-6 pitcher columns ──
  "Away_Starter_Quality",
  "Home_Starter_Quality",
  "Blend_Park_Pitcher_Projected",
  "Blend_Park_Pitcher_Error",
  "Replay_Run_TS",
];

const METRICS_HEADER: string[] = [
  "Variant", "Games_Count",
  "MAE", "Median_AE", "Bias",
  "Miss_4Plus_Pct", "Overproject_Pct", "Underproject_Pct",
  "Replay_Run_TS",
];

// ─── Team name → abbr map (same as module05c) ────────────────────────────────

const FULL_NAME_TO_ABBR: Record<string, string> = {};
for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
  FULL_NAME_TO_ABBR[full_name.toLowerCase()] = canonical_abbr;
}
{
  const ath = Object.entries(FULL_NAME_TO_ABBR).find(([n]) => n.includes("athletics"));
  if (ath) FULL_NAME_TO_ABBR["athletics"] = ath[1];
}

function teamAbbrFromName(name: string | undefined): string | null {
  if (!name) return null;
  return FULL_NAME_TO_ABBR[name.toLowerCase()] ?? null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReplayVariantKey =
  | "LEGACY"
  | "L30_PARK"
  | "L10_PARK"
  | "BLEND"
  | "BLEND_PARK"
  | "BLEND_PARK_PITCHER";

export interface ReplayGameRow {
  replay_date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  actual_total: number;
  projections: Record<ReplayVariantKey, number | null>;
  errors: Record<ReplayVariantKey, number | null>;    // projected - actual
  away_l30_rate: number | null;
  home_l30_rate: number | null;
  away_l10_rate: number | null;
  home_l10_rate: number | null;
  away_offense_source: string;
  home_offense_source: string;
  park_runs_pct: number | null;
  park_multiplier: number;
  /** Source of the park factor used for this game's row */
  park_source_status: "SEASONAL_FACTOR_USED" | "MISSING_PARK_DATA";
  /** Quality factor of the AWAY starter (faces HOME batters). 1.0 = league avg; > 1.0 = permissive. */
  away_starter_quality: number;
  /** Quality factor of the HOME starter (faces AWAY batters). 1.0 = league avg; > 1.0 = permissive. */
  home_starter_quality: number;
}

export interface CalibrationBand {
  /** Lower bound (inclusive) */
  min: number;
  /** Upper bound (exclusive, or Infinity) */
  max: number;
  label: string;
  games: number;
  mae: number | null;
}

export interface VariantMetrics {
  variant: ReplayVariantKey;
  games_count: number;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  miss_4plus_pct: number | null;
  overproject_pct: number | null;
  underproject_pct: number | null;
  calibration: CalibrationBand[];
}

export interface ParkSourceCounts {
  venue_factor_used: number;
  seasonal_factor_used: number;
  missing_park_data: number;
}

export interface ReplayResult {
  status: "success" | "partial" | "failure";
  replay_timestamp_utc: string;
  start_date: string;
  end_date: string;
  dates_processed: number;
  total_games: number;
  skipped_games: number;
  /** Park factor source breakdown across all game rows */
  park_source_counts: ParkSourceCounts;
  rows: ReplayGameRow[];
  metrics: VariantMetrics[];
  errors: string[];
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dateRange(start: string, end: string, maxDates = MAX_DATE_RANGE): string[] {
  const dates: string[] = [];
  let cur = start;
  while (cur <= end && dates.length < maxDates) {
    dates.push(cur);
    cur = shiftDate(cur, 1);
  }
  return dates;
}

// ─── MLB API types ────────────────────────────────────────────────────────────

interface MlbScheduleGame {
  gamePk?: number;
  officialDate?: string;
  status?: { abstractGameState?: string };
  teams?: {
    away?: { score?: number; team?: { name?: string } };
    home?: { score?: number; team?: { name?: string } };
  };
  venue?: { name?: string };
}

// ─── Starter quality factor (identical formula to module09's starterQualityFactor) ──

function replayStarterQualityFactor(
  pitcherId: number | null,
  statsMap: Map<number, PitcherSeasonStats>,
): number {
  if (!pitcherId) return 1.0;
  const stats = statsMap.get(pitcherId);
  if (!stats) return 1.0;

  const fipOrEra  = stats.fip ?? stats.era ?? LEAGUE_AVG_ERA;
  const clamped   = Math.max(2.0, Math.min(7.0, fipOrEra));
  const fipFactor = clamped / LEAGUE_AVG_ERA;

  const kPct  = stats.k_pct;
  const bbPct = stats.bb_pct;
  if (kPct === null || bbPct === null) {
    return Math.max(0.40, Math.min(1.80, fipFactor));
  }

  const kBBAdj    = (kPct - bbPct - LEAGUE_AVG_K_BB_PCT) * K_BB_BLEND_WEIGHT;
  const composite = fipFactor * (1 - kBBAdj);
  return Math.max(0.40, Math.min(1.80, parseFloat(composite.toFixed(4))));
}

// ─── Fetch completed games with scores for a single date ─────────────────────
// NOTE: the schedule endpoint's `hydrate=boxscore` embedding returns an empty
// object for completed games. Starter IDs are fetched separately via the
// direct /game/{pk}/boxscore endpoint (see fetchGameBoxscoreStarters below).

async function fetchCompletedGames(date: string): Promise<MlbScheduleGame[]> {
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=linescore`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const json = await res.json() as { dates?: Array<{ games?: MlbScheduleGame[] }> };
    const games: MlbScheduleGame[] = [];
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.status?.abstractGameState === "Final") games.push(g);
      }
    }
    return games;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Batch-fetch starter pitcher IDs from individual game boxscores ───────────
// /game/{pk}/boxscore reliably returns teams.away.pitchers / teams.home.pitchers
// as arrays of player IDs in order of appearance; the first element is the starter.

const BOXSCORE_CHUNK = 20;

interface GameStarters {
  awayStarterId: number | null;
  homeStarterId: number | null;
}

async function fetchGameBoxscoreStarters(
  gamePks: number[],
): Promise<Map<number, GameStarters>> {
  const starterMap = new Map<number, GameStarters>();
  const unique = [...new Set(gamePks.filter((pk) => pk > 0))];

  for (let i = 0; i < unique.length; i += BOXSCORE_CHUNK) {
    const chunk = unique.slice(i, i + BOXSCORE_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(async (pk) => {
        const res = await fetch(`${MLB_API}/game/${pk}/boxscore`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) throw new Error(`MLB boxscore ${res.status} pk=${pk}`);
        const json = await res.json() as {
          teams?: {
            away?: { pitchers?: number[] };
            home?: { pitchers?: number[] };
          };
        };
        return {
          pk,
          awayStarterId: json.teams?.away?.pitchers?.[0] ?? null,
          homeStarterId: json.teams?.home?.pitchers?.[0] ?? null,
        };
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        starterMap.set(r.value.pk, {
          awayStarterId: r.value.awayStarterId,
          homeStarterId: r.value.homeStarterId,
        });
      }
    }
  }

  return starterMap;
}

// ─── Compute park multiplier (same formula as module09) ───────────────────────

export function parkMultiplierFromFactors(pf: ParkFactors | null): {
  park_runs_pct: number | null;
  park_multiplier: number;
} {
  if (!pf) return { park_runs_pct: null, park_multiplier: 1.0 };
  const mult = parseFloat(
    Math.max(PARK_MIN, Math.min(PARK_MAX, 1 + pf.runs_pct / 100)).toFixed(4),
  );
  return { park_runs_pct: pf.runs_pct, park_multiplier: mult };
}

// ─── Offense rate lookup (shared by L30 and L10 maps) ────────────────────────

export function rateFromMap(
  teamAbbr: string,
  rateMap: Map<string, { games: number; runs_per_game: number }>,
  minGames: number,
): number | null {
  const entry = rateMap.get(teamAbbr);
  return entry !== undefined && entry.games >= minGames
    ? entry.runs_per_game
    : null;
}

// ─── Compute 5 variant projections for one game ───────────────────────────────

export interface GameProjections {
  projections: Record<ReplayVariantKey, number | null>;
  away_l30: number | null;
  home_l30: number | null;
  away_l10: number | null;
  home_l10: number | null;
  away_offense_source: string;
  home_offense_source: string;
  park_runs_pct: number | null;
  park_multiplier: number;
  /** Quality factor of the away starter (1.0 = league avg; > 1.0 = permissive). */
  away_starter_quality: number;
  /** Quality factor of the home starter (1.0 = league avg; > 1.0 = permissive). */
  home_starter_quality: number;
}

export function computeVariants(
  awayAbbr: string,
  homeAbbr: string,
  l30Map: Map<string, { games: number; runs_per_game: number }>,
  l10Map: Map<string, { games: number; runs_per_game: number }>,
  parkFactors: ParkFactors | null,
  /** Quality factor for the AWAY team's starter (faces home batters). 1.0 when unknown. */
  awayStarterQual = 1.0,
  /** Quality factor for the HOME team's starter (faces away batters). 1.0 when unknown. */
  homeStarterQual = 1.0,
): GameProjections {
  const awayL30 = rateFromMap(awayAbbr, l30Map, MIN_L30_GAMES);
  const homeL30 = rateFromMap(homeAbbr, l30Map, MIN_L30_GAMES);
  const awayL10 = rateFromMap(awayAbbr, l10Map, MIN_L10_GAMES);
  const homeL10 = rateFromMap(homeAbbr, l10Map, MIN_L10_GAMES);

  // Blend (offensive rate used when both present)
  const awayBlend = awayL30 !== null && awayL10 !== null
    ? parseFloat((L30_WEIGHT * awayL30 + L10_WEIGHT * awayL10).toFixed(3))
    : awayL30 ?? awayL10 ?? LEAGUE_AVG_RS;
  const homeBlend = homeL30 !== null && homeL10 !== null
    ? parseFloat((L30_WEIGHT * homeL30 + L10_WEIGHT * homeL10).toFixed(3))
    : homeL30 ?? homeL10 ?? LEAGUE_AVG_RS;

  // Offense sources for audit columns
  const awaySource =
    awayL30 !== null && awayL10 !== null ? "BLENDED" :
    awayL30 !== null                     ? "L30_ONLY" :
    awayL10 !== null                     ? "L10_ONLY" : "LEAGUE_AVG_FALLBACK";
  const homeSource =
    homeL30 !== null && homeL10 !== null ? "BLENDED" :
    homeL30 !== null                     ? "L30_ONLY" :
    homeL10 !== null                     ? "L10_ONLY" : "LEAGUE_AVG_FALLBACK";

  const { park_runs_pct, park_multiplier } = parkMultiplierFromFactors(parkFactors);

  // L10-only rates (fallback to league avg when absent)
  const awayL10Only = awayL10 ?? LEAGUE_AVG_RS;
  const homeL10Only = homeL10 ?? LEAGUE_AVG_RS;
  const awayL30Only = awayL30 ?? LEAGUE_AVG_RS;
  const homeL30Only = homeL30 ?? LEAGUE_AVG_RS;

  function total(awayRate: number, homeRate: number, mult: number): number {
    return parseFloat((awayRate * mult + homeRate * mult).toFixed(2));
  }

  // BLEND_PARK_PITCHER: each team's offense adjusted by the OPPOSING starter's quality.
  // Away team bats against HOME starter (homeStarterQual); home team bats against AWAY starter (awayStarterQual).
  const projAwayPitcher  = awayBlend * park_multiplier * homeStarterQual;
  const projHomePitcher  = homeBlend * park_multiplier * awayStarterQual;
  const blendParkPitcher = parseFloat((projAwayPitcher + projHomePitcher).toFixed(2));

  return {
    projections: {
      LEGACY:              total(awayL30Only, homeL30Only, 1.0),
      L30_PARK:            total(awayL30Only, homeL30Only, park_multiplier),
      L10_PARK:            total(awayL10Only, homeL10Only, park_multiplier),
      BLEND:               total(awayBlend,   homeBlend,   1.0),
      BLEND_PARK:          total(awayBlend,   homeBlend,   park_multiplier),
      BLEND_PARK_PITCHER:  blendParkPitcher,
    },
    away_l30: awayL30,
    home_l30: homeL30,
    away_l10: awayL10,
    home_l10: homeL10,
    away_offense_source: awaySource,
    home_offense_source: homeSource,
    park_runs_pct,
    park_multiplier,
    away_starter_quality: awayStarterQual,
    home_starter_quality: homeStarterQual,
  };
}

// ─── Metric computation ───────────────────────────────────────────────────────

const CALIBRATION_BANDS = [
  { min: 0, max: 7, label: "< 7" },
  { min: 7, max: 9, label: "7–8.9" },
  { min: 9, max: 11, label: "9–10.9" },
  { min: 11, max: Infinity, label: "≥ 11" },
];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3))
    : parseFloat(sorted[mid].toFixed(3));
}

export function computeMetrics(
  variant: ReplayVariantKey,
  rows: ReplayGameRow[],
  runTs: string,
): VariantMetrics {
  const eligible = rows.filter((r) => r.projections[variant] !== null);
  if (eligible.length === 0) {
    return {
      variant,
      games_count: 0,
      mae: null, median_ae: null, bias: null,
      miss_4plus_pct: null, overproject_pct: null, underproject_pct: null,
      calibration: [],
    };
  }

  const errs     = eligible.map((r) => r.errors[variant]!);
  const absErrs  = errs.map(Math.abs);

  const mae       = parseFloat((absErrs.reduce((a, b) => a + b, 0) / absErrs.length).toFixed(3));
  const medianAE  = median(absErrs);
  const bias      = parseFloat((errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3));
  const miss4     = parseFloat(((absErrs.filter((e) => e >= 4).length / absErrs.length) * 100).toFixed(1));
  const overPct   = parseFloat(((errs.filter((e) => e > 0).length / errs.length) * 100).toFixed(1));
  const underPct  = parseFloat(((errs.filter((e) => e < 0).length / errs.length) * 100).toFixed(1));

  const calibration: CalibrationBand[] = CALIBRATION_BANDS.map((band) => {
    const inBand = eligible.filter((r) => {
      const p = r.projections[variant]!;
      return p >= band.min && p < band.max;
    });
    const bandAbs = inBand.map((r) => Math.abs(r.errors[variant]!));
    const bandMAE = bandAbs.length > 0
      ? parseFloat((bandAbs.reduce((a, b) => a + b, 0) / bandAbs.length).toFixed(3))
      : null;
    return {
      min:   band.min,
      max:   band.max,
      label: band.label,
      games: inBand.length,
      mae:   bandMAE,
    };
  });

  return {
    variant,
    games_count:     eligible.length,
    mae,
    median_ae:       medianAE,
    bias,
    miss_4plus_pct:  miss4,
    overproject_pct:  overPct,
    underproject_pct: underPct,
    calibration,
  };

  void runTs; // used by caller for sheet write only
}

// ─── Sheets writers ───────────────────────────────────────────────────────────

async function writeResultsSheet(
  rows: ReplayGameRow[],
  runTs: string,
  workbookId: string,
): Promise<void> {
  // 29 data cols (A–AC) + Replay_Run_TS (AD) = 30 total
  await expandSheetColumns(workbookId, REPLAY_RESULTS_SHEET, RESULTS_HEADER.length);
  await clearRange(workbookId, `${REPLAY_RESULTS_SHEET}!A1:AD5000`);
  await writeRange(workbookId, `${REPLAY_RESULTS_SHEET}!A1:AD1`, [RESULTS_HEADER]);

  const sheetRows = rows.map((r) => [
    r.replay_date,
    r.game_id,
    r.away_team,
    r.home_team,
    r.actual_total,
    r.projections.LEGACY              ?? "",
    r.projections.L30_PARK            ?? "",
    r.projections.L10_PARK            ?? "",
    r.projections.BLEND               ?? "",
    r.projections.BLEND_PARK          ?? "",
    r.errors.LEGACY                   ?? "",
    r.errors.L30_PARK                 ?? "",
    r.errors.L10_PARK                 ?? "",
    r.errors.BLEND                    ?? "",
    r.errors.BLEND_PARK               ?? "",
    r.away_l30_rate                   ?? "",
    r.home_l30_rate                   ?? "",
    r.away_l10_rate                   ?? "",
    r.home_l10_rate                   ?? "",
    r.away_offense_source,
    r.home_offense_source,
    r.park_runs_pct                   ?? "",
    r.park_multiplier,
    r.park_source_status,
    // ── Step-6 pitcher columns ──
    r.away_starter_quality,
    r.home_starter_quality,
    r.projections.BLEND_PARK_PITCHER  ?? "",
    r.errors.BLEND_PARK_PITCHER       ?? "",
    runTs,
  ]);

  if (sheetRows.length > 0) {
    await writeRange(
      workbookId,
      `${REPLAY_RESULTS_SHEET}!A2:AD${1 + sheetRows.length}`,
      sheetRows,
    );
  }
}

async function writeMetricsSheet(
  metrics: VariantMetrics[],
  runTs: string,
  workbookId: string,
): Promise<void> {
  await expandSheetColumns(workbookId, REPLAY_METRICS_SHEET, METRICS_HEADER.length);
  await clearRange(workbookId, `${REPLAY_METRICS_SHEET}!A1:I20`);
  await writeRange(workbookId, `${REPLAY_METRICS_SHEET}!A1:I1`, [METRICS_HEADER]);

  const sheetRows = metrics.map((m) => [
    m.variant,
    m.games_count,
    m.mae        ?? "",
    m.median_ae  ?? "",
    m.bias       ?? "",
    m.miss_4plus_pct  ?? "",
    m.overproject_pct ?? "",
    m.underproject_pct ?? "",
    runTs,
  ]);

  if (sheetRows.length > 0) {
    await writeRange(
      workbookId,
      `${REPLAY_METRICS_SHEET}!A2:I${1 + sheetRows.length}`,
      sheetRows,
    );
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runHistoricalReplay(
  startDate: string,
  endDate: string,
  options: {
    writeSheets?: boolean;
    workbookId?: string;
    /** Override the default 30-date cap. Hard ceiling: 120. */
    maxDates?: number;
  } = {},
): Promise<ReplayResult> {
  const runTs    = new Date().toISOString();
  const wbId     = options.workbookId ?? WORKBOOK_ID;
  const write    = options.writeSheets ?? false;
  const maxDates = Math.min(options.maxDates ?? MAX_DATE_RANGE, 120);
  const errors: string[] = [];

  logger.info({ startDate, endDate, writeSheets: write, maxDates }, "MODULE_13: Historical replay starting");

  const dates = dateRange(startDate, endDate, maxDates);
  if (dates.length === 0) {
    return {
      status: "failure",
      replay_timestamp_utc: runTs,
      start_date: startDate,
      end_date: endDate,
      dates_processed: 0,
      total_games: 0,
      skipped_games: 0,
      park_source_counts: { venue_factor_used: 0, seasonal_factor_used: 0, missing_park_data: 0 },
      rows: [],
      metrics: [],
      errors: ["No dates in range (check start/end order and MAX_DATE_RANGE cap)"],
    };
  }

  // ── Build park factors map: home_abbr → ParkFactors ──
  // Uses the static 2026 seasonal table (module04d) — all 30 MLB venues.
  // The previous mlbstartingnine.com source was today-only and unsuitable
  // for historical replay (it returned 5/30 venues at early-morning fetch time).
  const parkFactorsMap = new Map<string, ParkFactors>(
    Object.entries(SEASONAL_PARK_FACTORS_2026),
  );
  logger.info({ parkEntries: parkFactorsMap.size }, "MODULE_13: Park factors map built (static 2026 seasonal, all 30 venues)");

  // ─────────────────────────────────────────────────────────────────────────
  // Two-phase approach so pitcher stats can be batch-fetched once for the
  // entire date range rather than one call per game/date.
  //
  // Phase 1: Collect completed games + run rates for every date.
  //          Starter IDs are extracted from boxscore hydration in fetchCompletedGames.
  // Phase 2: Batch-fetch pitcher season stats for all unique starter IDs.
  // Phase 3: Compute projections (including BLEND_PARK_PITCHER) for every game.
  // ─────────────────────────────────────────────────────────────────────────

  interface DateData {
    date: string;
    completedGames: MlbScheduleGame[];
    l10Map: Map<string, { games: number; runs_per_game: number }>;
    l30Map: Map<string, { games: number; runs_per_game: number }>;
  }

  // ── Phase 1: fetch date data sequentially (respect MLB API rate limits) ──
  const dateDataArr: DateData[] = [];
  let datesProcessed = 0;

  for (const date of dates) {
    logger.info({ date }, "MODULE_13: Fetching date data (phase 1)");
    try {
      const [completedGames, runRates, l30Rates] = await Promise.all([
        fetchCompletedGames(date).catch((err: unknown) => {
          errors.push(`Games fetch failed for ${date}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as MlbScheduleGame[];
        }),
        fetchTeamRunRates(date).catch((err: unknown) => {
          errors.push(`RunRates fetch failed for ${date}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
        fetchTeamRunRates(date, { lookbackDays: L30_LOOKBACK_DAYS, lastN: L30_LAST_N }).catch((err: unknown) => {
          errors.push(`L30 rates fetch failed for ${date}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ]);

      if (runRates?.status === "failure") {
        errors.push(`L10 rates failed for ${date}: ${(runRates as { error?: string }).error ?? "unknown"}`);
      }
      if (l30Rates?.status === "failure") {
        errors.push(`L30 rates failed for ${date}: ${(l30Rates as { error?: string }).error ?? "unknown"}`);
      }

      dateDataArr.push({
        date,
        completedGames,
        l10Map: runRates?.rates ?? new Map(),
        l30Map: l30Rates?.rates ?? new Map(),
      });
      datesProcessed++;
    } catch (err: unknown) {
      errors.push(`Date ${date} phase-1 fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Phase 2a: collect all gamePks and batch-fetch starter IDs from boxscores ──
  const allGamePks = dateDataArr.flatMap((d) =>
    d.completedGames.map((g) => g.gamePk).filter((pk): pk is number => pk !== undefined),
  );

  let gameStarterMap = new Map<number, GameStarters>();
  if (allGamePks.length > 0) {
    logger.info({ games: allGamePks.length }, "MODULE_13: Batch-fetching game boxscore starters (phase 2a)");
    gameStarterMap = await fetchGameBoxscoreStarters(allGamePks).catch((err: unknown) => {
      errors.push(`Boxscore starter fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return new Map<number, GameStarters>();
    });
    logger.info({ resolved: gameStarterMap.size, requested: allGamePks.length }, "MODULE_13: Boxscore starters resolved");
  }

  // ── Phase 2b: collect unique starter pitcher IDs and batch-fetch season stats ──
  const allPitcherIds = new Set<number>();
  for (const { awayStarterId, homeStarterId } of gameStarterMap.values()) {
    if (awayStarterId) allPitcherIds.add(awayStarterId);
    if (homeStarterId) allPitcherIds.add(homeStarterId);
  }

  let pitcherStatsMap = new Map<number, PitcherSeasonStats>();
  if (allPitcherIds.size > 0) {
    const season = dates[0]!.slice(0, 4);
    logger.info({ pitchers: allPitcherIds.size, season }, "MODULE_13: Batch-fetching pitcher season stats (phase 2b)");
    const statsResult = await fetchPitcherSeasonStats([...allPitcherIds], season).catch((err: unknown) => {
      errors.push(`Pitcher stats fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { stats: new Map<number, PitcherSeasonStats>(), fetched: 0, errors: [] as string[], status: "failure" as const, season };
    });
    pitcherStatsMap = statsResult.stats;
    logger.info(
      { fetched: pitcherStatsMap.size, requested: allPitcherIds.size },
      "MODULE_13: Pitcher season stats ready",
    );
  }

  // ── Phase 3: compute projections across all collected game data ──
  const allRows: ReplayGameRow[] = [];
  let totalSkipped = 0;

  for (const { date, completedGames, l10Map, l30Map } of dateDataArr) {
    for (const game of completedGames) {
      const awayScore = game.teams?.away?.score;
      const homeScore = game.teams?.home?.score;

      if (awayScore == null || homeScore == null) {
        totalSkipped++;
        continue;
      }

      const awayAbbr = teamAbbrFromName(game.teams?.away?.team?.name);
      const homeAbbr = teamAbbrFromName(game.teams?.home?.team?.name);

      if (!awayAbbr || !homeAbbr) {
        totalSkipped++;
        errors.push(`Could not resolve team abbr for game ${game.gamePk} on ${date}`);
        continue;
      }

      const actualTotal      = awayScore + homeScore;
      const gameId           = `${date}_${awayAbbr}@${homeAbbr}`;
      const parkFactors      = parkFactorsMap.get(homeAbbr) ?? null;
      const parkSourceStatus = parkFactors !== null
        ? "SEASONAL_FACTOR_USED" as const
        : "MISSING_PARK_DATA" as const;

      // Resolve starter quality factors for BLEND_PARK_PITCHER variant
      const starters    = game.gamePk !== undefined ? gameStarterMap.get(game.gamePk) : undefined;
      const awayStarterQual = replayStarterQualityFactor(starters?.awayStarterId ?? null, pitcherStatsMap);
      const homeStarterQual = replayStarterQualityFactor(starters?.homeStarterId ?? null, pitcherStatsMap);

      const computed = computeVariants(
        awayAbbr, homeAbbr,
        l30Map, l10Map,
        parkFactors,
        awayStarterQual, homeStarterQual,
      );

      const VARIANTS: ReplayVariantKey[] = [
        "LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK", "BLEND_PARK_PITCHER",
      ];
      const errs: Record<ReplayVariantKey, number | null> = {} as Record<ReplayVariantKey, number | null>;
      for (const v of VARIANTS) {
        const p = computed.projections[v];
        errs[v] = p !== null ? parseFloat((p - actualTotal).toFixed(2)) : null;
      }

      allRows.push({
        replay_date:          date,
        game_id:              gameId,
        away_team:            awayAbbr,
        home_team:            homeAbbr,
        actual_total:         actualTotal,
        projections:          computed.projections,
        errors:               errs,
        away_l30_rate:        computed.away_l30,
        home_l30_rate:        computed.home_l30,
        away_l10_rate:        computed.away_l10,
        home_l10_rate:        computed.home_l10,
        away_offense_source:  computed.away_offense_source,
        home_offense_source:  computed.home_offense_source,
        park_runs_pct:        computed.park_runs_pct,
        park_multiplier:      computed.park_multiplier,
        park_source_status:   parkSourceStatus,
        away_starter_quality: computed.away_starter_quality,
        home_starter_quality: computed.home_starter_quality,
      });
    }
  }

  // ── Compute metrics per variant ──
  const VARIANT_KEYS: ReplayVariantKey[] = [
    "LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK", "BLEND_PARK_PITCHER",
  ];
  const metrics = VARIANT_KEYS.map((v) => computeMetrics(v, allRows, runTs));

  logger.info(
    {
      dates: datesProcessed,
      games: allRows.length,
      skipped: totalSkipped,
      metrics: metrics.map((m) => ({ variant: m.variant, mae: m.mae, bias: m.bias })),
    },
    "MODULE_13: Historical replay complete",
  );

  // ── Optionally write to Sheets ──
  if (write && allRows.length > 0) {
    try {
      await writeResultsSheet(allRows, runTs, wbId);
      await writeMetricsSheet(metrics, runTs, wbId);
      logger.info("MODULE_13: Replay results written to Sheets");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sheets write failed: ${msg}`);
      logger.error({ err: msg }, "MODULE_13: Replay Sheets write failed");
    }
  }

  // ── Aggregate park source counts across all rows ──
  const parkSourceCounts: ParkSourceCounts = {
    venue_factor_used:    0,
    seasonal_factor_used: 0,
    missing_park_data:    0,
  };
  for (const r of allRows) {
    if      (r.park_source_status === "SEASONAL_FACTOR_USED") parkSourceCounts.seasonal_factor_used++;
    else if (r.park_source_status === "MISSING_PARK_DATA")    parkSourceCounts.missing_park_data++;
    // VENUE_FACTOR_USED is not emitted by the replay path (live-scrape only runs in module09)
    else                                                       parkSourceCounts.venue_factor_used++;
  }

  const status =
    allRows.length === 0         ? "failure"  :
    errors.length > 0            ? "partial"  : "success";

  return {
    status,
    replay_timestamp_utc: runTs,
    start_date:           startDate,
    end_date:             endDate,
    dates_processed:      datesProcessed,
    total_games:          allRows.length,
    skipped_games:        totalSkipped,
    park_source_counts:   parkSourceCounts,
    rows:                 allRows,
    metrics,
    errors,
  };
}
