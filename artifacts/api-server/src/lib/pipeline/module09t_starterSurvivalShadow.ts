/**
 * Module 09t: starter-survival / failure dependency shadow challenger.
 *
 * TEMPORARY STARTER_SURVIVAL_PROBABILITY MODEL
 * p = clamp(Projected_Starter_Innings / 9, 0, 1).
 * This is a transparent shadow default, not a production coefficient. It
 * assumes Frostline's current workload estimate is calibrated; it does not
 * model injury, manager decisions, or within-start performance variance.
 */
import { addSheet, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type { StatcastPreviewResult } from "./module02e_statcastPreview.js";
import type { PublicationProtection } from "./module00_scopedPublication.js";

export const STARTER_FAILURE_INNINGS_DELTA = 1.0;
export const STARTER_SURVIVAL_HISTORY_SHEET = "STARTER_SURVIVAL_CALIBRATION_HISTORY";

export const STARTER_SURVIVAL_HISTORY_HEADERS = [
  "Date", "Game_ID", "Scheduled_First_Pitch", "Base_Projected_Total", "Starter_Survival_Adjusted_Total",
  "Away_Starter_Survival_Workload", "Home_Starter_Survival_Workload", "Away_Starter_Survival_Prob", "Home_Starter_Survival_Prob",
  "P_SS", "P_FS", "P_SF", "P_FF", "T_SS", "T_FS", "T_SF", "T_FF",
  "Away_Starter_FDS", "Home_Starter_FDS", "Game_FDS", "Snapshot_TS", "Calibration_Status",
  "Away_Starter_Role", "Home_Starter_Role",
];

export type StarterSurvivalStatus = "PROSPECTIVE_SHADOW_CANDIDATE" | "POST_FIRST_PITCH_REJECTED" | "INSUFFICIENT_INPUT";

export interface StarterSurvivalRow {
  date: string; game_id: string; scheduled_first_pitch: string;
  base_projected_total: number; starter_survival_adjusted_total: number | null;
  away_starter_survival_workload: number | null; home_starter_survival_workload: number | null;
  away_starter_survival_prob: number | null; home_starter_survival_prob: number | null;
  p_ss: number | null; p_fs: number | null; p_sf: number | null; p_ff: number | null;
  t_ss: number | null; t_fs: number | null; t_sf: number | null; t_ff: number | null;
  away_starter_fds: number | null; home_starter_fds: number | null; game_fds: number | null;
  snapshot_ts: string; calibration_status: StarterSurvivalStatus;
  /** Frozen pregame role evidence for prospective empirical V2 training. */
  away_starter_role: string; home_starter_role: string;
}

export interface StarterSurvivalResult { status: "success" | "partial"; rows_computed: number; rows_written: number; errors: string[]; rows: StarterSurvivalRow[]; }

const round = (value: number, places = 4) => Number.parseFloat(value.toFixed(places));
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Temporary documented probability default; this never feeds Module 09. */
export function starterSurvivalProbability(projectedInnings: number): number {
  return round(clamp01(projectedInnings / 9));
}

export function failureWorkload(survivalWorkload: number): number {
  return Math.max(survivalWorkload - STARTER_FAILURE_INNINGS_DELTA, 0);
}

/** The only per-branch mutable inputs: starter innings and inherited bullpen innings. */
export function starterSurvivalBranchWorkloads(starterWorkload: number): { survival_starter: number; survival_bullpen: number; failure_starter: number; failure_bullpen: number } {
  const failureStarter = failureWorkload(starterWorkload);
  return {
    survival_starter: starterWorkload,
    survival_bullpen: 9 - starterWorkload,
    failure_starter: failureStarter,
    failure_bullpen: 9 - failureStarter,
  };
}

function inputsAvailable(summary: GameSummaryRow): boolean {
  return [summary.away_expected_innings, summary.home_expected_innings, summary.projected_away_runs,
    summary.projected_home_runs, summary.away_offense_rate_used, summary.home_offense_rate_used,
    summary.away_lineup_factor, summary.home_lineup_factor, summary.combined_run_multiplier,
    summary.away_starter_quality, summary.home_starter_quality].every((value) => typeof value === "number" && Number.isFinite(value));
}

/** Reconstruct current bullpen quality from the active Module 09 team allocation. */
function deriveBullpenQuality(projectedRuns: number, rate: number, starterIp: number, starterQuality: number): number | null {
  const bullpenShare = (9 - starterIp) / 9;
  if (rate <= 0 || bullpenShare <= 0) return null;
  return (projectedRuns / rate - (starterIp / 9) * starterQuality) / bullpenShare;
}

function branchTotal(
  summary: GameSummaryRow,
  awayStarterIp: number,
  homeStarterIp: number,
  awayBullpenQuality: number,
  homeBullpenQuality: number,
): number {
  const awayRate = summary.away_offense_rate_used * summary.combined_run_multiplier * summary.away_lineup_factor;
  const homeRate = summary.home_offense_rate_used * summary.combined_run_multiplier * summary.home_lineup_factor;
  const awayRuns = awayRate * ((homeStarterIp / 9) * summary.home_starter_quality + ((9 - homeStarterIp) / 9) * homeBullpenQuality);
  const homeRuns = homeRate * ((awayStarterIp / 9) * summary.away_starter_quality + ((9 - awayStarterIp) / 9) * awayBullpenQuality);
  return round(awayRuns + homeRuns, 2);
}

export function computeStarterSurvivalRow(
  summary: GameSummaryRow,
  scheduledFirstPitch: string,
  snapshotTs: string,
  probabilities?: { away: number; home: number },
): StarterSurvivalRow {
  const base: StarterSurvivalRow = {
    date: summary.date, game_id: summary.game_id, scheduled_first_pitch: scheduledFirstPitch,
    base_projected_total: summary.projected_total_runs, starter_survival_adjusted_total: null,
    away_starter_survival_workload: summary.away_expected_innings, home_starter_survival_workload: summary.home_expected_innings,
    away_starter_survival_prob: null, home_starter_survival_prob: null,
    p_ss: null, p_fs: null, p_sf: null, p_ff: null, t_ss: null, t_fs: null, t_sf: null, t_ff: null,
    away_starter_fds: null, home_starter_fds: null, game_fds: null, snapshot_ts: snapshotTs,
    calibration_status: "INSUFFICIENT_INPUT",
    away_starter_role: summary.away_pitcher_role || "UNRESOLVED",
    home_starter_role: summary.home_pitcher_role || "UNRESOLVED",
  };
  if (!inputsAvailable(summary) || !scheduledFirstPitch || !Number.isFinite(Date.parse(scheduledFirstPitch))) return base;
  if (Date.parse(snapshotTs) >= Date.parse(scheduledFirstPitch)) return { ...base, calibration_status: "POST_FIRST_PITCH_REJECTED" };
  const awayIp = summary.away_expected_innings!;
  const homeIp = summary.home_expected_innings!;
  const awayRate = summary.away_offense_rate_used * summary.combined_run_multiplier * summary.away_lineup_factor;
  const homeRate = summary.home_offense_rate_used * summary.combined_run_multiplier * summary.home_lineup_factor;
  const awayBullpenQuality = deriveBullpenQuality(summary.projected_home_runs, homeRate, awayIp, summary.away_starter_quality);
  const homeBullpenQuality = deriveBullpenQuality(summary.projected_away_runs, awayRate, homeIp, summary.home_starter_quality);
  if (awayBullpenQuality === null || homeBullpenQuality === null) return base;
  const pA = clamp01(probabilities?.away ?? starterSurvivalProbability(awayIp));
  const pH = clamp01(probabilities?.home ?? starterSurvivalProbability(homeIp));
  const pSS = pA * pH, pFS = (1 - pA) * pH, pSF = pA * (1 - pH), pFF = (1 - pA) * (1 - pH);
  const awayFailureIp = failureWorkload(awayIp), homeFailureIp = failureWorkload(homeIp);
  const tSS = branchTotal(summary, awayIp, homeIp, awayBullpenQuality, homeBullpenQuality);
  const tFS = branchTotal(summary, awayFailureIp, homeIp, awayBullpenQuality, homeBullpenQuality);
  const tSF = branchTotal(summary, awayIp, homeFailureIp, awayBullpenQuality, homeBullpenQuality);
  const tFF = branchTotal(summary, awayFailureIp, homeFailureIp, awayBullpenQuality, homeBullpenQuality);
  const ssat = round(pSS * tSS + pFS * tFS + pSF * tSF + pFF * tFF, 2);
  const awayFailureTotal = pH * tFS + (1 - pH) * tFF;
  const awaySurvivalTotal = pH * tSS + (1 - pH) * tSF;
  const homeFailureTotal = pA * tSF + (1 - pA) * tFF;
  const homeSurvivalTotal = pA * tSS + (1 - pA) * tFS;
  return {
    ...base, away_starter_survival_prob: round(pA), home_starter_survival_prob: round(pH),
    p_ss: round(pSS), p_fs: round(pFS), p_sf: round(pSF), p_ff: round(pFF), t_ss: tSS, t_fs: tFS, t_sf: tSF, t_ff: tFF,
    starter_survival_adjusted_total: ssat,
    away_starter_fds: round(Math.max(awayFailureTotal - awaySurvivalTotal, 0) / Math.max(awayFailureTotal, 1)),
    home_starter_fds: round(Math.max(homeFailureTotal - homeSurvivalTotal, 0) / Math.max(homeFailureTotal, 1)),
    game_fds: round(Math.max(ssat - tSS, 0) / Math.max(ssat, 1)),
    calibration_status: "PROSPECTIVE_SHADOW_CANDIDATE",
  };
}

function rowValues(row: StarterSurvivalRow): unknown[] {
  return [row.date, row.game_id, row.scheduled_first_pitch, row.base_projected_total, row.starter_survival_adjusted_total ?? "",
    row.away_starter_survival_workload ?? "", row.home_starter_survival_workload ?? "", row.away_starter_survival_prob ?? "", row.home_starter_survival_prob ?? "",
    row.p_ss ?? "", row.p_fs ?? "", row.p_sf ?? "", row.p_ff ?? "", row.t_ss ?? "", row.t_fs ?? "", row.t_sf ?? "", row.t_ff ?? "",
    row.away_starter_fds ?? "", row.home_starter_fds ?? "", row.game_fds ?? "", row.snapshot_ts, row.calibration_status,
    row.away_starter_role, row.home_starter_role];
}

export async function computeAndWriteStarterSurvivalShadow(
  summaries: GameSummaryRow[], previews: StatcastPreviewResult, workbookId = WORKBOOK_ID,
  protection?: PublicationProtection, scheduledFirstPitches: ReadonlyMap<string, string | null> = new Map(),
): Promise<StarterSurvivalResult> {
  const snapshotTs = new Date().toISOString();
  const previewsByGame = new Map(previews.games.map((game) => [game.game_id, game]));
  const rows = summaries.map((summary) => computeStarterSurvivalRow(
    summary,
    previewsByGame.get(summary.game_id)?.scheduled_first_pitch ?? scheduledFirstPitches.get(summary.game_id) ?? "",
    snapshotTs,
  ));
  const incoming = rows.filter((row) => row.calibration_status === "PROSPECTIVE_SHADOW_CANDIDATE")
    .filter((row) => !protection?.protected_game_ids.has(row.game_id));
  try {
    let existing: unknown[][] = [];
    try {
      existing = (await readRange(workbookId, `${STARTER_SURVIVAL_HISTORY_SHEET}!A1:X10000`)).values ?? [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
      await addSheet(workbookId, STARTER_SURVIVAL_HISTORY_SHEET);
    }
    const retained = existing.slice(1).filter((value) => {
      const key = `${String(value[0] ?? "")}|${String(value[1] ?? "")}`;
      return !incoming.some((row) => `${row.date}|${row.game_id}` === key);
    });
    await writeRange(workbookId, `${STARTER_SURVIVAL_HISTORY_SHEET}!A1`, [STARTER_SURVIVAL_HISTORY_HEADERS, ...retained, ...incoming.map(rowValues)]);
    return { status: "success", rows_computed: rows.length, rows_written: incoming.length, errors: [], rows };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, "MODULE_09t: starter survival shadow write failed");
    return { status: "partial", rows_computed: rows.length, rows_written: 0, errors: [message], rows };
  }
}
