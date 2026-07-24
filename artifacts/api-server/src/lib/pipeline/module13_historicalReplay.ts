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
 * L30 data source: current Fangraphs splits (documented proxy — not
 * date-anchored snapshots). Acceptable for early-season validation;
 * note in any published results.
 *
 * Park factors source: mlbstartingnine.com seasonal factors fetched at
 * replay runtime (stable for the season — not day-specific).
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
import { fetchTeamSplitsWithFallback } from "./module05_fangraphs.js";
import { fetchTeamRunRates } from "./module05c_teamRunRates.js";
import { fetchStartingNine } from "./module04c_startingNine.js";
import type { ParkFactors } from "./module04c_startingNine.js";
import { SOURCE_MAPPINGS } from "./config.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MLB_API        = "https://statsapi.mlb.com/api/v1";
const LEAGUE_AVG_RS  = 4.5;
const L30_WEIGHT     = 0.65;
const L10_WEIGHT     = 0.35;
const MIN_L10_GAMES  = 5;
const MAX_DATE_RANGE = 30;

// Park multiplier clamp (matches module09)
const PARK_MIN = 0.85;
const PARK_MAX = 1.15;

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
  | "BLEND_PARK";

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

export interface ReplayResult {
  status: "success" | "partial" | "failure";
  replay_timestamp_utc: string;
  start_date: string;
  end_date: string;
  dates_processed: number;
  total_games: number;
  skipped_games: number;
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

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cur = start;
  while (cur <= end && dates.length < MAX_DATE_RANGE) {
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

// ─── Fetch completed games with scores for a single date ─────────────────────

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

// ─── Compute park multiplier (same formula as module09) ───────────────────────

function parkMultiplierFromFactors(pf: ParkFactors | null): {
  park_runs_pct: number | null;
  park_multiplier: number;
} {
  if (!pf) return { park_runs_pct: null, park_multiplier: 1.0 };
  const mult = parseFloat(
    Math.max(PARK_MIN, Math.min(PARK_MAX, 1 + pf.runs_pct / 100)).toFixed(4),
  );
  return { park_runs_pct: pf.runs_pct, park_multiplier: mult };
}

// ─── L30 rate from Fangraphs splits ──────────────────────────────────────────

function l30Rate(
  teamAbbr: string,
  splitsTeams: Array<{ team: string; l30_wrc_plus: number }>,
): number | null {
  const matching = splitsTeams.filter((s) => s.team === teamAbbr);
  if (matching.length === 0) return null;
  return parseFloat(
    ((matching.reduce((a, s) => a + s.l30_wrc_plus, 0) / matching.length / 100) *
      LEAGUE_AVG_RS).toFixed(3),
  );
}

// ─── Compute 5 variant projections for one game ───────────────────────────────

interface GameProjections {
  projections: Record<ReplayVariantKey, number | null>;
  away_l30: number | null;
  home_l30: number | null;
  away_l10: number | null;
  home_l10: number | null;
  away_offense_source: string;
  home_offense_source: string;
  park_runs_pct: number | null;
  park_multiplier: number;
}

function computeVariants(
  awayAbbr: string,
  homeAbbr: string,
  splitsTeams: Array<{ team: string; l30_wrc_plus: number }>,
  l10Map: Map<string, { games: number; runs_per_game: number }>,
  parkFactors: ParkFactors | null,
): GameProjections {
  const awayL30 = l30Rate(awayAbbr, splitsTeams);
  const homeL30 = l30Rate(homeAbbr, splitsTeams);

  const awayL10Entry = l10Map.get(awayAbbr);
  const homeL10Entry = l10Map.get(homeAbbr);
  const awayL10 = (awayL10Entry?.games ?? 0) >= MIN_L10_GAMES
    ? awayL10Entry!.runs_per_game
    : null;
  const homeL10 = (homeL10Entry?.games ?? 0) >= MIN_L10_GAMES
    ? homeL10Entry!.runs_per_game
    : null;

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

  return {
    projections: {
      LEGACY:     total(awayL30Only, homeL30Only, 1.0),
      L30_PARK:   total(awayL30Only, homeL30Only, park_multiplier),
      L10_PARK:   total(awayL10Only, homeL10Only, park_multiplier),
      BLEND:      total(awayBlend,   homeBlend,   1.0),
      BLEND_PARK: total(awayBlend,   homeBlend,   park_multiplier),
    },
    away_l30: awayL30,
    home_l30: homeL30,
    away_l10: awayL10,
    home_l10: homeL10,
    away_offense_source: awaySource,
    home_offense_source: homeSource,
    park_runs_pct,
    park_multiplier,
  };
}

// ─── Metric computation ───────────────────────────────────────────────────────

const CALIBRATION_BANDS = [
  { min: 0, max: 7, label: "< 7" },
  { min: 7, max: 9, label: "7–8.9" },
  { min: 9, max: 11, label: "9–10.9" },
  { min: 11, max: Infinity, label: "≥ 11" },
];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3))
    : parseFloat(sorted[mid].toFixed(3));
}

function computeMetrics(
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
  await expandSheetColumns(workbookId, REPLAY_RESULTS_SHEET, RESULTS_HEADER.length);
  await clearRange(workbookId, `${REPLAY_RESULTS_SHEET}!A1:X5000`);
  await writeRange(workbookId, `${REPLAY_RESULTS_SHEET}!A1:X1`, [RESULTS_HEADER]);

  const sheetRows = rows.map((r) => [
    r.replay_date,
    r.game_id,
    r.away_team,
    r.home_team,
    r.actual_total,
    r.projections.LEGACY     ?? "",
    r.projections.L30_PARK   ?? "",
    r.projections.L10_PARK   ?? "",
    r.projections.BLEND      ?? "",
    r.projections.BLEND_PARK ?? "",
    r.errors.LEGACY     ?? "",
    r.errors.L30_PARK   ?? "",
    r.errors.L10_PARK   ?? "",
    r.errors.BLEND      ?? "",
    r.errors.BLEND_PARK ?? "",
    r.away_l30_rate ?? "",
    r.home_l30_rate ?? "",
    r.away_l10_rate ?? "",
    r.home_l10_rate ?? "",
    r.away_offense_source,
    r.home_offense_source,
    r.park_runs_pct ?? "",
    r.park_multiplier,
    runTs,
  ]);

  if (sheetRows.length > 0) {
    await writeRange(
      workbookId,
      `${REPLAY_RESULTS_SHEET}!A2:X${1 + sheetRows.length}`,
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
  } = {},
): Promise<ReplayResult> {
  const runTs    = new Date().toISOString();
  const wbId     = options.workbookId ?? WORKBOOK_ID;
  const write    = options.writeSheets ?? false;
  const errors: string[] = [];

  logger.info({ startDate, endDate, writeSheets: write }, "MODULE_13: Historical replay starting");

  const dates = dateRange(startDate, endDate);
  if (dates.length === 0) {
    return {
      status: "failure",
      replay_timestamp_utc: runTs,
      start_date: startDate,
      end_date: endDate,
      dates_processed: 0,
      total_games: 0,
      skipped_games: 0,
      rows: [],
      metrics: [],
      errors: ["No dates in range (check start/end order and MAX_DATE_RANGE cap)"],
    };
  }

  // ── Pre-fetch stable data (current day's values, used for all dates) ──
  logger.info("MODULE_13: Pre-fetching Fangraphs splits and park factors");
  const [splits, startingNine] = await Promise.all([
    fetchTeamSplitsWithFallback().catch((err: unknown) => {
      errors.push(`Fangraphs fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    fetchStartingNine(new Date().toISOString().slice(0, 10)).catch((err: unknown) => {
      errors.push(`StartingNine fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
  ]);

  if (!splits) {
    return {
      status: "failure",
      replay_timestamp_utc: runTs,
      start_date: startDate,
      end_date: endDate,
      dates_processed: 0,
      total_games: 0,
      skipped_games: 0,
      rows: [],
      metrics: [],
      errors,
    };
  }

  // Build park factors map: home_abbr → ParkFactors
  const parkFactorsMap = new Map<string, ParkFactors>();
  for (const g of startingNine?.games ?? []) {
    if (g.home_abbr && g.park_factors) {
      parkFactorsMap.set(g.home_abbr, g.park_factors);
    }
  }
  logger.info({ parkEntries: parkFactorsMap.size }, "MODULE_13: Park factors map built");

  // ── Process each date ──
  const allRows: ReplayGameRow[] = [];
  let totalSkipped = 0;
  let datesProcessed = 0;

  for (const date of dates) {
    logger.info({ date }, "MODULE_13: Processing replay date");

    try {
      // Fetch completed games and L10 rates concurrently
      const [completedGames, runRates] = await Promise.all([
        fetchCompletedGames(date).catch((err: unknown) => {
          errors.push(`Games fetch failed for ${date}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as MlbScheduleGame[];
        }),
        fetchTeamRunRates(date).catch((err: unknown) => {
          errors.push(`RunRates fetch failed for ${date}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ]);

      const l10Map = runRates?.rates ?? new Map();

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

        const actualTotal = awayScore + homeScore;
        const gameId      = `${date}_${awayAbbr}@${homeAbbr}`;
        const parkFactors = parkFactorsMap.get(homeAbbr) ?? null;

        const computed = computeVariants(
          awayAbbr,
          homeAbbr,
          splits.teams,
          l10Map,
          parkFactors,
        );

        const VARIANTS: ReplayVariantKey[] = [
          "LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK",
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
        });
      }

      datesProcessed++;
    } catch (err: unknown) {
      errors.push(`Date ${date} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Compute metrics per variant ──
  const VARIANT_KEYS: ReplayVariantKey[] = [
    "LEGACY", "L30_PARK", "L10_PARK", "BLEND", "BLEND_PARK",
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
    rows:                 allRows,
    metrics,
    errors,
  };
}
