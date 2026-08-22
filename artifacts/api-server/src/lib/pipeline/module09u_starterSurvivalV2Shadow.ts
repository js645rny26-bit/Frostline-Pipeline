/**
 * Module 09u: SSAT v2 starter-survival / failure-severity challenger.
 *
 * This is intentionally a separate candidate from Module 09t (SSAT v1). It
 * never changes the active projection, market, vehicle, or authorization.
 *
 * V2 refuses the old Projected_IP / 9 proxy. It estimates survival and failure
 * shortfall only from strictly earlier settled starter observations. The first
 * v2 runs may therefore be explicitly insufficient rather than fabricated.
 */
import { addSheet, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type { PublicationProtection } from "./module00_scopedPublication.js";

const V1_HISTORY_SHEET = "STARTER_SURVIVAL_CALIBRATION_HISTORY";
const V1_REPORT_SHEET = "STARTER_SURVIVAL_CALIBRATION_REPORT";
export const STARTER_SURVIVAL_V2_HISTORY_SHEET = "STARTER_SURVIVAL_V2_CALIBRATION_HISTORY";
export const STARTER_SURVIVAL_V2_HISTORY_HEADERS = [
  "Date", "Game_ID", "Scheduled_First_Pitch", "Base_Projected_Total", "SSAT_V1_Total", "SSAT_V2_Total",
  "Away_Starter_Role", "Home_Starter_Role", "Away_Expected_Survival_Innings", "Home_Expected_Survival_Innings",
  "Away_Expected_Failure_Innings", "Home_Expected_Failure_Innings", "Away_Starter_Survival_Prob", "Home_Starter_Survival_Prob",
  "Away_Starter_Failure_Shortfall", "Home_Starter_Failure_Shortfall", "Away_Starter_Failure_Run_Cost", "Home_Starter_Failure_Run_Cost",
  "P_SS", "P_FS", "P_SF", "P_FF", "T_SS", "T_FS", "T_SF", "T_FF",
  "Away_Starter_FDS", "Home_Starter_FDS", "Game_FDS", "Calibration_Cohort", "Snapshot_TS", "Calibration_Status",
  "Away_Expected_Pitches", "Home_Expected_Pitches", "Away_Workload_Flags", "Home_Workload_Flags",
  "Away_Starter_Quality", "Home_Starter_Quality", "Away_Opponent_Pressure", "Home_Opponent_Pressure",
];

export type StarterSurvivalV2Status =
  | "PROSPECTIVE_SHADOW_CANDIDATE"
  | "INSUFFICIENT_EMPIRICAL_HISTORY"
  | "POST_FIRST_PITCH_REJECTED"
  | "INSUFFICIENT_INPUT";

export interface StarterSurvivalTrainingObservation {
  date: string;
  expected_innings: number;
  actual_innings: number;
  actual_total: number;
  dual_survival_total: number;
  role?: string;
}

export interface EmpiricalStarterCalibration {
  survival_probability: number;
  expected_failure_shortfall: number;
  expected_failure_run_cost: number;
  cohort: "ROLE_AND_WORKLOAD" | "WORKLOAD" | "ROLE" | "GLOBAL";
  observations: number;
  failures: number;
}

export interface StarterSurvivalV2Row {
  date: string;
  game_id: string;
  scheduled_first_pitch: string;
  base_projected_total: number;
  ssat_v1_total: number | null;
  ssat_v2_total: number | null;
  away_starter_role: string;
  home_starter_role: string;
  away_expected_survival_innings: number | null;
  home_expected_survival_innings: number | null;
  away_expected_failure_innings: number | null;
  home_expected_failure_innings: number | null;
  away_starter_survival_prob: number | null;
  home_starter_survival_prob: number | null;
  away_starter_failure_shortfall: number | null;
  home_starter_failure_shortfall: number | null;
  away_starter_failure_run_cost: number | null;
  home_starter_failure_run_cost: number | null;
  p_ss: number | null;
  p_fs: number | null;
  p_sf: number | null;
  p_ff: number | null;
  t_ss: number | null;
  t_fs: number | null;
  t_sf: number | null;
  t_ff: number | null;
  away_starter_fds: number | null;
  home_starter_fds: number | null;
  game_fds: number | null;
  calibration_cohort: string;
  snapshot_ts: string;
  calibration_status: StarterSurvivalV2Status;
  away_expected_pitches: number | null;
  home_expected_pitches: number | null;
  away_workload_flags: string;
  home_workload_flags: string;
  away_starter_quality: number;
  home_starter_quality: number;
  away_opponent_pressure: number;
  home_opponent_pressure: number;
}

export interface StarterSurvivalV2Result {
  status: "success" | "partial";
  rows_computed: number;
  rows_written: number;
  errors: string[];
  rows: StarterSurvivalV2Row[];
}

const round = (value: number, places = 4) => Number.parseFloat(value.toFixed(places));
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const numberOrNull = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Uses exact role/workload history when it exists, then progressively broader
 * empirical cohorts. There are no hand-tuned weights or numeric cutoffs.
 */
export function calibrateStarterFromHistory(
  observations: StarterSurvivalTrainingObservation[],
  expectedInnings: number,
  role: string,
): EmpiricalStarterCalibration | null {
  const valid = observations.filter((row) => row.expected_innings >= 0 && row.actual_innings >= 0);
  if (valid.length === 0) return null;
  const exactWorkload = (row: StarterSurvivalTrainingObservation) => Math.abs(row.expected_innings - expectedInnings) < 0.005;
  const sameRole = (row: StarterSurvivalTrainingObservation) => Boolean(role) && row.role === role;
  const roleAndWorkload = valid.filter((row) => sameRole(row) && exactWorkload(row));
  const workload = valid.filter(exactWorkload);
  const roleRows = valid.filter(sameRole);
  const candidates: Array<{ rows: StarterSurvivalTrainingObservation[]; cohort: EmpiricalStarterCalibration["cohort"] }> = [
    { rows: roleAndWorkload, cohort: "ROLE_AND_WORKLOAD" },
    { rows: workload, cohort: "WORKLOAD" },
    { rows: roleRows, cohort: "ROLE" },
    { rows: valid, cohort: "GLOBAL" },
  ];
  // Failure severity is undefined without at least one observed failure. Move
  // to a broader *empirical* cohort; never inject an arbitrary shortfall.
  const selectedCandidate = candidates.find((candidate) => candidate.rows.some((row) => row.actual_innings < row.expected_innings));
  if (!selectedCandidate) return null;
  const selected = selectedCandidate.rows;
  const cohort = selectedCandidate.cohort;
  const failures = selected.filter((row) => row.actual_innings < row.expected_innings);
  const survivalProbability = selected.filter((row) => row.actual_innings >= row.expected_innings).length / selected.length;
  const shortfall = failures.reduce((sum, row) => sum + Math.max(row.expected_innings - row.actual_innings, 0), 0) / failures.length;
  const runCost = failures.reduce((sum, row) => sum + Math.max(row.actual_total - row.dual_survival_total, 0), 0) / failures.length;
  return {
    survival_probability: round(clamp01(survivalProbability)),
    expected_failure_shortfall: round(shortfall, 2),
    expected_failure_run_cost: round(runCost, 2),
    cohort,
    observations: selected.length,
    failures: failures.length,
  };
}

function inputsAvailable(summary: GameSummaryRow): boolean {
  return [summary.away_expected_innings, summary.home_expected_innings, summary.projected_away_runs,
    summary.projected_home_runs, summary.away_offense_rate_used, summary.home_offense_rate_used,
    summary.away_lineup_factor, summary.home_lineup_factor, summary.combined_run_multiplier,
    summary.away_starter_quality, summary.home_starter_quality].every((value) => typeof value === "number" && Number.isFinite(value));
}

function deriveBullpenQuality(projectedRuns: number, rate: number, starterIp: number, starterQuality: number): number | null {
  const bullpenShare = (9 - starterIp) / 9;
  if (rate <= 0 || bullpenShare <= 0) return null;
  return (projectedRuns / rate - (starterIp / 9) * starterQuality) / bullpenShare;
}

function branchTotal(summary: GameSummaryRow, awayStarterIp: number, homeStarterIp: number, awayBullpenQuality: number, homeBullpenQuality: number): number {
  const awayRate = summary.away_offense_rate_used * summary.combined_run_multiplier * summary.away_lineup_factor;
  const homeRate = summary.home_offense_rate_used * summary.combined_run_multiplier * summary.home_lineup_factor;
  const awayRuns = awayRate * ((homeStarterIp / 9) * summary.home_starter_quality + ((9 - homeStarterIp) / 9) * homeBullpenQuality);
  const homeRuns = homeRate * ((awayStarterIp / 9) * summary.away_starter_quality + ((9 - awayStarterIp) / 9) * awayBullpenQuality);
  return round(awayRuns + homeRuns, 2);
}

function roleForGame(game: NormalizedGame | undefined, side: "away" | "home"): string {
  return game?.[`${side}_pitcher`].role ?? "UNRESOLVED";
}

function expectedPitchesForGame(game: NormalizedGame | undefined, side: "away" | "home"): number | null {
  return game?.[`${side}_pitcher`].expected_pitches ?? null;
}

function workloadFlagsForGame(game: NormalizedGame | undefined, side: "away" | "home"): string {
  return game?.[`${side}_pitcher`].workload_flags.join(";") ?? "";
}

function blankRow(summary: GameSummaryRow, scheduledFirstPitch: string, snapshotTs: string, game?: NormalizedGame): StarterSurvivalV2Row {
  return {
    date: summary.date, game_id: summary.game_id, scheduled_first_pitch: scheduledFirstPitch,
    base_projected_total: summary.projected_total_runs, ssat_v1_total: null, ssat_v2_total: null,
    away_starter_role: roleForGame(game, "away"), home_starter_role: roleForGame(game, "home"),
    away_expected_survival_innings: summary.away_expected_innings, home_expected_survival_innings: summary.home_expected_innings,
    away_expected_failure_innings: null, home_expected_failure_innings: null,
    away_starter_survival_prob: null, home_starter_survival_prob: null,
    away_starter_failure_shortfall: null, home_starter_failure_shortfall: null,
    away_starter_failure_run_cost: null, home_starter_failure_run_cost: null,
    p_ss: null, p_fs: null, p_sf: null, p_ff: null, t_ss: null, t_fs: null, t_sf: null, t_ff: null,
    away_starter_fds: null, home_starter_fds: null, game_fds: null,
    calibration_cohort: "", snapshot_ts: snapshotTs, calibration_status: "INSUFFICIENT_INPUT",
    away_expected_pitches: expectedPitchesForGame(game, "away"), home_expected_pitches: expectedPitchesForGame(game, "home"),
    away_workload_flags: workloadFlagsForGame(game, "away"), home_workload_flags: workloadFlagsForGame(game, "home"),
    away_starter_quality: summary.away_starter_quality, home_starter_quality: summary.home_starter_quality,
    away_opponent_pressure: round(summary.home_offense_rate_used * summary.home_lineup_factor),
    home_opponent_pressure: round(summary.away_offense_rate_used * summary.away_lineup_factor),
  };
}

export function computeStarterSurvivalV2Row(
  summary: GameSummaryRow,
  scheduledFirstPitch: string,
  snapshotTs: string,
  history: StarterSurvivalTrainingObservation[],
  game?: NormalizedGame,
  ssatV1Total: number | null = null,
): StarterSurvivalV2Row {
  const base = blankRow(summary, scheduledFirstPitch, snapshotTs, game);
  if (!inputsAvailable(summary) || !scheduledFirstPitch || !Number.isFinite(Date.parse(scheduledFirstPitch))) return base;
  if (Date.parse(snapshotTs) >= Date.parse(scheduledFirstPitch)) return { ...base, calibration_status: "POST_FIRST_PITCH_REJECTED" };
  const awayIp = summary.away_expected_innings!;
  const homeIp = summary.home_expected_innings!;
  const awayCalibration = calibrateStarterFromHistory(history, awayIp, base.away_starter_role);
  const homeCalibration = calibrateStarterFromHistory(history, homeIp, base.home_starter_role);
  if (!awayCalibration || !homeCalibration) return { ...base, calibration_status: "INSUFFICIENT_EMPIRICAL_HISTORY" };
  const awayRate = summary.away_offense_rate_used * summary.combined_run_multiplier * summary.away_lineup_factor;
  const homeRate = summary.home_offense_rate_used * summary.combined_run_multiplier * summary.home_lineup_factor;
  const awayBullpenQuality = deriveBullpenQuality(summary.projected_home_runs, homeRate, awayIp, summary.away_starter_quality);
  const homeBullpenQuality = deriveBullpenQuality(summary.projected_away_runs, awayRate, homeIp, summary.home_starter_quality);
  if (awayBullpenQuality === null || homeBullpenQuality === null) return base;
  const awayFailureIp = Math.max(awayIp - awayCalibration.expected_failure_shortfall, 0);
  const homeFailureIp = Math.max(homeIp - homeCalibration.expected_failure_shortfall, 0);
  const pA = awayCalibration.survival_probability;
  const pH = homeCalibration.survival_probability;
  const pSS = pA * pH, pFS = (1 - pA) * pH, pSF = pA * (1 - pH), pFF = (1 - pA) * (1 - pH);
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
    ...base, ssat_v1_total: ssatV1Total, ssat_v2_total: ssat,
    away_expected_failure_innings: round(awayFailureIp, 2), home_expected_failure_innings: round(homeFailureIp, 2),
    away_starter_survival_prob: pA, home_starter_survival_prob: pH,
    away_starter_failure_shortfall: awayCalibration.expected_failure_shortfall,
    home_starter_failure_shortfall: homeCalibration.expected_failure_shortfall,
    away_starter_failure_run_cost: awayCalibration.expected_failure_run_cost,
    home_starter_failure_run_cost: homeCalibration.expected_failure_run_cost,
    p_ss: round(pSS), p_fs: round(pFS), p_sf: round(pSF), p_ff: round(pFF),
    t_ss: tSS, t_fs: tFS, t_sf: tSF, t_ff: tFF,
    away_starter_fds: round(Math.max(awayFailureTotal - awaySurvivalTotal, 0) / Math.max(awayFailureTotal, 1)),
    home_starter_fds: round(Math.max(homeFailureTotal - homeSurvivalTotal, 0) / Math.max(homeFailureTotal, 1)),
    game_fds: round(Math.max(ssat - tSS, 0) / Math.max(ssat, 1)),
    calibration_cohort: `${awayCalibration.cohort}|${homeCalibration.cohort}`,
    calibration_status: "PROSPECTIVE_SHADOW_CANDIDATE",
  };
}

function key(date: string, gameId: string): string { return `${date}|${gameId}`; }

/** Builds two starter observations per prior settled v1 game. */
export function parseV1TrainingObservations(historyRows: unknown[][], reportRows: unknown[][], beforeDate: string, beforeTs: string): StarterSurvivalTrainingObservation[] {
  const histories = new Map<string, unknown[]>();
  for (const row of historyRows) {
    const date = String(row[0] ?? "");
    const gameId = String(row[1] ?? "");
    if (!date || !gameId || date >= beforeDate || String(row[21] ?? "") !== "PROSPECTIVE_SHADOW_CANDIDATE") continue;
    histories.set(key(date, gameId), row);
  }
  const observations: StarterSurvivalTrainingObservation[] = [];
  for (const report of reportRows) {
    const date = String(report[0] ?? "");
    const gameId = String(report[1] ?? "");
    const history = histories.get(key(date, gameId));
    const settlementMs = Date.parse(String(report[22] ?? ""));
    if (!history || String(report[23] ?? "") !== "SETTLED" || !Number.isFinite(settlementMs) || settlementMs >= Date.parse(beforeTs)) continue;
    const actualTotal = numberOrNull(report[7]);
    const dualSurvivalTotal = numberOrNull(history[13]);
    const awayExpected = numberOrNull(history[5]);
    const homeExpected = numberOrNull(history[6]);
    const awayActual = numberOrNull(report[14]);
    const homeActual = numberOrNull(report[15]);
    if (actualTotal === null || dualSurvivalTotal === null) continue;
    if (awayExpected !== null && awayActual !== null) observations.push({ date, expected_innings: awayExpected, actual_innings: awayActual, actual_total: actualTotal, dual_survival_total: dualSurvivalTotal });
    if (homeExpected !== null && homeActual !== null) observations.push({ date, expected_innings: homeExpected, actual_innings: homeActual, actual_total: actualTotal, dual_survival_total: dualSurvivalTotal });
  }
  return observations;
}

function rowValues(row: StarterSurvivalV2Row): unknown[] {
  return [row.date, row.game_id, row.scheduled_first_pitch, row.base_projected_total, row.ssat_v1_total ?? "", row.ssat_v2_total ?? "",
    row.away_starter_role, row.home_starter_role, row.away_expected_survival_innings ?? "", row.home_expected_survival_innings ?? "",
    row.away_expected_failure_innings ?? "", row.home_expected_failure_innings ?? "", row.away_starter_survival_prob ?? "", row.home_starter_survival_prob ?? "",
    row.away_starter_failure_shortfall ?? "", row.home_starter_failure_shortfall ?? "", row.away_starter_failure_run_cost ?? "", row.home_starter_failure_run_cost ?? "",
    row.p_ss ?? "", row.p_fs ?? "", row.p_sf ?? "", row.p_ff ?? "", row.t_ss ?? "", row.t_fs ?? "", row.t_sf ?? "", row.t_ff ?? "",
    row.away_starter_fds ?? "", row.home_starter_fds ?? "", row.game_fds ?? "", row.calibration_cohort, row.snapshot_ts, row.calibration_status,
    row.away_expected_pitches ?? "", row.home_expected_pitches ?? "", row.away_workload_flags, row.home_workload_flags,
    row.away_starter_quality, row.home_starter_quality, row.away_opponent_pressure, row.home_opponent_pressure];
}

export async function computeAndWriteStarterSurvivalV2Shadow(
  summaries: GameSummaryRow[], games: NormalizedGame[], workbookId = WORKBOOK_ID, protection?: PublicationProtection,
): Promise<StarterSurvivalV2Result> {
  const snapshotTs = new Date().toISOString();
  try {
    const [v1History, v1Report] = await Promise.all([
      readRange(workbookId, `${V1_HISTORY_SHEET}!A1:V10000`),
      readRange(workbookId, `${V1_REPORT_SHEET}!A1:X10000`),
    ]);
    const date = summaries[0]?.date ?? "";
    const history = parseV1TrainingObservations(
      ((v1History.values ?? []) as unknown[][]).slice(1),
      ((v1Report.values ?? []) as unknown[][]).slice(1),
      date,
      snapshotTs,
    );
    const gamesById = new Map(games.map((game) => [game.legacy_game_id, game]));
    const ssatV1ByGame = new Map(((v1History.values ?? []) as unknown[][]).slice(1)
      .filter((row) => String(row[0] ?? "") === date && String(row[21] ?? "") === "PROSPECTIVE_SHADOW_CANDIDATE")
      .map((row) => [String(row[1] ?? ""), numberOrNull(row[4])]));
    const rows = summaries.map((summary) => {
      const game = gamesById.get(summary.game_id);
      return computeStarterSurvivalV2Row(summary, game?.scheduled_utc_time ?? "", snapshotTs, history, game, ssatV1ByGame.get(summary.game_id) ?? null);
    });
    // Persist explicit pregame insufficiency too. It is evidence that v2
    // declined to manufacture a candidate, while post-first-pitch rows remain
    // excluded so settlement cannot masquerade as a prospective snapshot.
    const incoming = rows
      .filter((row) => row.calibration_status !== "POST_FIRST_PITCH_REJECTED")
      .filter((row) => !protection?.protected_game_ids.has(row.game_id));
    let existing: unknown[][] = [];
    try {
      existing = (await readRange(workbookId, `${STARTER_SURVIVAL_V2_HISTORY_SHEET}!A1:AN10000`)).values ?? [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
      await addSheet(workbookId, STARTER_SURVIVAL_V2_HISTORY_SHEET);
    }
    const incomingKeys = new Set(incoming.map((row) => key(row.date, row.game_id)));
    const retained = existing.slice(1).filter((row) => !incomingKeys.has(key(String(row[0] ?? ""), String(row[1] ?? ""))));
    await writeRange(workbookId, `${STARTER_SURVIVAL_V2_HISTORY_SHEET}!A1`, [STARTER_SURVIVAL_V2_HISTORY_HEADERS, ...retained, ...incoming.map(rowValues)]);
    return { status: "success", rows_computed: rows.length, rows_written: incoming.length, errors: [], rows };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, "MODULE_09u: starter survival v2 shadow failed");
    return { status: "partial", rows_computed: 0, rows_written: 0, errors: [message], rows: [] };
  }
}
