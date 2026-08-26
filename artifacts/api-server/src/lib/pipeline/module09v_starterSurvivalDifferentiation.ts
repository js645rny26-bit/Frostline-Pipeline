/**
 * Module 09v: SSAT v1/v2 differentiation audit.
 *
 * This module measures whether the empirical v2 challenger actually differs
 * from v1 enough to earn separate interpretive weight. It is a shadow-only
 * diagnostic: it cannot alter GAME_SUMMARY, a vehicle, market, BET/PASS, or
 * authorization. Until a future commissioning decision says otherwise, v1 and
 * v2 are one starter-survival evidence family for manual review.
 */
import { addSheet, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { STARTER_SURVIVAL_V2_HISTORY_SHEET, type StarterSurvivalV2Row } from "./module09u_starterSurvivalV2Shadow.js";

export const STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_SHEET = "STARTER_SURVIVAL_DIFFERENTIATION_AUDIT";
export const STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_HEADERS = ["Scope", "Scope_Date", "Analysis_TS", "Eligible_Game_Count", "V1_V2_Pearson_R", "Mean_Abs_V1_V2_Diff", "Identical_Total_Count", "Identical_Total_Pct", "Within_0_10_Count", "Within_0_10_Pct", "Within_0_25_Count", "Within_0_25_Pct", "Within_0_50_Count", "Within_0_50_Pct", "Starter_Probability_Slot_Count", "Unique_Survival_Probability_Count", "Repeated_Probability_Group_Count", "Repeated_Probability_Slot_Count", "Repeated_Probability_Slot_Pct", "Largest_Probability_Value", "Largest_Probability_Starter_Count", "Largest_Probability_Game_Count", "Cohort_Metadata_Status", "Repeated_Probability_Profile_Summary", "Starter_Quality_Probability_R", "Opponent_Pressure_Probability_R", "Analysis_Status", "Interpretation"];

type SsatScope = "CURRENT_DATE" | "ALL_PROSPECTIVE_HISTORY";

export interface StarterSurvivalDifferentiationInput {
  date: string;
  game_id: string;
  ssat_v1_total: number | null;
  ssat_v2_total: number | null;
  calibration_status: string;
  away_starter_survival_prob: number | null;
  home_starter_survival_prob: number | null;
  away_starter_quality: number | null;
  home_starter_quality: number | null;
  away_opponent_pressure: number | null;
  home_opponent_pressure: number | null;
  away_calibration_cohort: string;
  home_calibration_cohort: string;
  away_cohort_observations: number | null;
  home_cohort_observations: number | null;
  away_cohort_failures: number | null;
  home_cohort_failures: number | null;
}

export interface StarterSurvivalDifferentiationAuditRow {
  scope: SsatScope;
  scope_date: string;
  analysis_ts: string;
  eligible_game_count: number;
  v1_v2_pearson_r: number | null;
  mean_abs_v1_v2_diff: number | null;
  identical_total_count: number;
  identical_total_pct: number | null;
  within_0_10_count: number;
  within_0_10_pct: number | null;
  within_0_25_count: number;
  within_0_25_pct: number | null;
  within_0_50_count: number;
  within_0_50_pct: number | null;
  starter_probability_slot_count: number;
  unique_survival_probability_count: number;
  repeated_probability_group_count: number;
  repeated_probability_slot_count: number;
  repeated_probability_slot_pct: number | null;
  largest_probability_value: number | null;
  largest_probability_starter_count: number;
  largest_probability_game_count: number;
  cohort_metadata_status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE";
  repeated_probability_profile_summary: string;
  starter_quality_probability_r: number | null;
  opponent_pressure_probability_r: number | null;
  analysis_status: "OBSERVATIONAL_ONLY" | "INSUFFICIENT_COMPARISONS";
  interpretation: string;
}

export interface StarterSurvivalDifferentiationResult {
  status: "success" | "partial";
  rows_written: number;
  errors: string[];
  rows: StarterSurvivalDifferentiationAuditRow[];
}

interface ProbabilitySlot {
  game_id: string;
  probability: number;
  starter_quality: number | null;
  opponent_pressure: number | null;
  cohort: string;
  observations: number | null;
  failures: number | null;
}

const PROSPECTIVE_CANDIDATE = "PROSPECTIVE_SHADOW_CANDIDATE";
const EPSILON = 1e-9;

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function round(value: number, places = 4): number {
  return Number.parseFloat(value.toFixed(places));
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : null;
}

/** Pearson r with no invented result when either series has no variation. */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let xSquared = 0;
  let ySquared = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const xDelta = xs[index]! - meanX;
    const yDelta = ys[index]! - meanY;
    numerator += xDelta * yDelta;
    xSquared += xDelta * xDelta;
    ySquared += yDelta * yDelta;
  }
  const denominator = Math.sqrt(xSquared * ySquared);
  return denominator > EPSILON ? round(numerator / denominator) : null;
}

function inputsFromV2Row(row: StarterSurvivalV2Row): StarterSurvivalDifferentiationInput {
  return {
    date: row.date,
    game_id: row.game_id,
    ssat_v1_total: row.ssat_v1_total,
    ssat_v2_total: row.ssat_v2_total,
    calibration_status: row.calibration_status,
    away_starter_survival_prob: row.away_starter_survival_prob,
    home_starter_survival_prob: row.home_starter_survival_prob,
    away_starter_quality: row.away_starter_quality,
    home_starter_quality: row.home_starter_quality,
    away_opponent_pressure: row.away_opponent_pressure,
    home_opponent_pressure: row.home_opponent_pressure,
    away_calibration_cohort: row.away_calibration_cohort,
    home_calibration_cohort: row.home_calibration_cohort,
    away_cohort_observations: row.away_cohort_observations,
    home_cohort_observations: row.home_cohort_observations,
    away_cohort_failures: row.away_cohort_failures,
    home_cohort_failures: row.home_cohort_failures,
  };
}

/** Parses only columns that were frozen in the v2 history surface. */
export function parseStarterSurvivalV2History(rows: unknown[][]): StarterSurvivalDifferentiationInput[] {
  return rows
    .map((row) => ({
      date: stringValue(row[0]),
      game_id: stringValue(row[1]),
      ssat_v1_total: numberOrNull(row[4]),
      ssat_v2_total: numberOrNull(row[5]),
      calibration_status: stringValue(row[31]),
      away_starter_survival_prob: numberOrNull(row[12]),
      home_starter_survival_prob: numberOrNull(row[13]),
      away_starter_quality: numberOrNull(row[36]),
      home_starter_quality: numberOrNull(row[37]),
      away_opponent_pressure: numberOrNull(row[38]),
      home_opponent_pressure: numberOrNull(row[39]),
      away_calibration_cohort: stringValue(row[40]),
      home_calibration_cohort: stringValue(row[41]),
      away_cohort_observations: numberOrNull(row[42]),
      home_cohort_observations: numberOrNull(row[43]),
      away_cohort_failures: numberOrNull(row[44]),
      home_cohort_failures: numberOrNull(row[45]),
    }))
    .filter((row) => Boolean(row.date && row.game_id));
}

function buildProbabilitySlots(records: StarterSurvivalDifferentiationInput[]): ProbabilitySlot[] {
  return records
    .filter((record) => record.calibration_status === PROSPECTIVE_CANDIDATE)
    .flatMap((record) => {
      const sides: Array<{
        probability: number | null;
        starter_quality: number | null;
        opponent_pressure: number | null;
        cohort: string;
        observations: number | null;
        failures: number | null;
      }> = [
        {
          probability: record.away_starter_survival_prob,
          starter_quality: record.away_starter_quality,
          opponent_pressure: record.away_opponent_pressure,
          cohort: record.away_calibration_cohort,
          observations: record.away_cohort_observations,
          failures: record.away_cohort_failures,
        },
        {
          probability: record.home_starter_survival_prob,
          starter_quality: record.home_starter_quality,
          opponent_pressure: record.home_opponent_pressure,
          cohort: record.home_calibration_cohort,
          observations: record.home_cohort_observations,
          failures: record.home_cohort_failures,
        },
      ];
      return sides.filter((side): side is typeof side & { probability: number } => side.probability !== null).map((side) => ({ game_id: record.game_id, ...side }));
    });
}

function profileSummary(repeatedGroups: Array<{ probability: number; slots: ProbabilitySlot[] }>): string {
  if (repeatedGroups.length === 0) return "NONE";
  return repeatedGroups
    .sort((left, right) => right.slots.length - left.slots.length || left.probability - right.probability)
    .map((group) => {
      const games = new Set(group.slots.map((slot) => slot.game_id)).size;
      const cohorts = [...new Set(group.slots.map((slot) => slot.cohort).filter(Boolean))].sort().join("/") || "UNRECORDED";
      const observations = [...new Set(group.slots.map((slot) => slot.observations).filter((value): value is number => value !== null))].sort((a, b) => a - b).join("/") || "UNRECORDED";
      const failures = [...new Set(group.slots.map((slot) => slot.failures).filter((value): value is number => value !== null))].sort((a, b) => a - b).join("/") || "UNRECORDED";
      return `${group.probability.toFixed(4)}: ${group.slots.length} starter slots/${games} games; cohorts=${cohorts}; observations=${observations}; failures=${failures}`;
    })
    .join(" | ");
}

/**
 * Computes observations only. There are deliberately no materiality bands,
 * automatic retirement rules, or inference that a correlation is causal.
 */
export function buildStarterSurvivalDifferentiationAuditRow(records: StarterSurvivalDifferentiationInput[], scope: SsatScope, scopeDate: string, analysisTs: string): StarterSurvivalDifferentiationAuditRow {
  const prospective = records.filter((record) => record.calibration_status === PROSPECTIVE_CANDIDATE);
  const comparisons = prospective.filter((record) => record.ssat_v1_total !== null && record.ssat_v2_total !== null);
  const differences = comparisons.map((record) => Math.abs(record.ssat_v1_total! - record.ssat_v2_total!));
  const slots = buildProbabilitySlots(prospective);
  const probabilityGroups = new Map<string, { probability: number; slots: ProbabilitySlot[] }>();
  for (const slot of slots) {
    const groupKey = slot.probability.toFixed(4);
    const group = probabilityGroups.get(groupKey) ?? {
      probability: slot.probability,
      slots: [],
    };
    group.slots.push(slot);
    probabilityGroups.set(groupKey, group);
  }
  const repeatedGroups = [...probabilityGroups.values()].filter((group) => new Set(group.slots.map((slot) => slot.game_id)).size > 1);
  const repeatedSlots = repeatedGroups.reduce((sum, group) => sum + group.slots.length, 0);
  const largestGroup = [...probabilityGroups.values()].sort((left, right) => right.slots.length - left.slots.length || left.probability - right.probability)[0];
  const metadataSlots = slots.filter((slot) => slot.observations !== null && slot.failures !== null && Boolean(slot.cohort));
  const cohortMetadataStatus = slots.length === 0 ? "NOT_APPLICABLE" : metadataSlots.length === slots.length ? "COMPLETE" : metadataSlots.length > 0 ? "PARTIAL" : "UNAVAILABLE";
  const qualityPairs = slots.filter((slot) => slot.starter_quality !== null);
  const pressurePairs = slots.filter((slot) => slot.opponent_pressure !== null);
  const within = (limit: number) => differences.filter((difference) => difference <= limit + EPSILON).length;
  const analysisStatus = comparisons.length >= 2 ? "OBSERVATIONAL_ONLY" : "INSUFFICIENT_COMPARISONS";

  return {
    scope,
    scope_date: scopeDate,
    analysis_ts: analysisTs,
    eligible_game_count: comparisons.length,
    v1_v2_pearson_r: pearsonCorrelation(
      comparisons.map((record) => record.ssat_v1_total!),
      comparisons.map((record) => record.ssat_v2_total!),
    ),
    mean_abs_v1_v2_diff: differences.length > 0 ? round(differences.reduce((sum, difference) => sum + difference, 0) / differences.length, 4) : null,
    identical_total_count: within(0),
    identical_total_pct: percent(within(0), comparisons.length),
    within_0_10_count: within(0.1),
    within_0_10_pct: percent(within(0.1), comparisons.length),
    within_0_25_count: within(0.25),
    within_0_25_pct: percent(within(0.25), comparisons.length),
    within_0_50_count: within(0.5),
    within_0_50_pct: percent(within(0.5), comparisons.length),
    starter_probability_slot_count: slots.length,
    unique_survival_probability_count: probabilityGroups.size,
    repeated_probability_group_count: repeatedGroups.length,
    repeated_probability_slot_count: repeatedSlots,
    repeated_probability_slot_pct: percent(repeatedSlots, slots.length),
    largest_probability_value: largestGroup?.probability ?? null,
    largest_probability_starter_count: largestGroup?.slots.length ?? 0,
    largest_probability_game_count: largestGroup ? new Set(largestGroup.slots.map((slot) => slot.game_id)).size : 0,
    cohort_metadata_status: cohortMetadataStatus,
    repeated_probability_profile_summary: profileSummary(repeatedGroups),
    starter_quality_probability_r: pearsonCorrelation(
      qualityPairs.map((slot) => slot.starter_quality!),
      qualityPairs.map((slot) => slot.probability),
    ),
    opponent_pressure_probability_r: pearsonCorrelation(
      pressurePairs.map((slot) => slot.opponent_pressure!),
      pressurePairs.map((slot) => slot.probability),
    ),
    analysis_status: analysisStatus,
    interpretation: "V1 and V2 are one SSAT evidence family for manual review; this observational audit cannot change a projection, vehicle, BET/PASS, authorization, or retire either challenger automatically.",
  };
}

function rowKey(scope: string, scopeDate: string): string {
  return `${scope}|${scopeDate}`;
}

function rowValues(row: StarterSurvivalDifferentiationAuditRow): unknown[] {
  return [row.scope, row.scope_date, row.analysis_ts, row.eligible_game_count, row.v1_v2_pearson_r ?? "", row.mean_abs_v1_v2_diff ?? "", row.identical_total_count, row.identical_total_pct ?? "", row.within_0_10_count, row.within_0_10_pct ?? "", row.within_0_25_count, row.within_0_25_pct ?? "", row.within_0_50_count, row.within_0_50_pct ?? "", row.starter_probability_slot_count, row.unique_survival_probability_count, row.repeated_probability_group_count, row.repeated_probability_slot_count, row.repeated_probability_slot_pct ?? "", row.largest_probability_value ?? "", row.largest_probability_starter_count, row.largest_probability_game_count, row.cohort_metadata_status, row.repeated_probability_profile_summary, row.starter_quality_probability_r ?? "", row.opponent_pressure_probability_r ?? "", row.analysis_status, row.interpretation];
}

export async function computeAndWriteStarterSurvivalDifferentiationAudit(currentV2Rows: StarterSurvivalV2Row[], date: string, workbookId = WORKBOOK_ID): Promise<StarterSurvivalDifferentiationResult> {
  const analysisTs = new Date().toISOString();
  try {
    const historyResponse = await readRange(workbookId, `${STARTER_SURVIVAL_V2_HISTORY_SHEET}!A1:AT10000`);
    const historicalRecords = parseStarterSurvivalV2History((historyResponse.values ?? []).slice(1) as unknown[][]);
    const currentRecords = currentV2Rows.map(inputsFromV2Row);
    const rows = [buildStarterSurvivalDifferentiationAuditRow(currentRecords, "CURRENT_DATE", date, analysisTs), buildStarterSurvivalDifferentiationAuditRow(historicalRecords, "ALL_PROSPECTIVE_HISTORY", "ALL", analysisTs)];
    let existing: unknown[][] = [];
    try {
      existing = (await readRange(workbookId, `${STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_SHEET}!A1:AB1000`)).values ?? [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
      await addSheet(workbookId, STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_SHEET);
    }
    const replacementKeys = new Set(rows.map((row) => rowKey(row.scope, row.scope_date)));
    const retained = existing.slice(1).filter((row) => !replacementKeys.has(rowKey(stringValue(row[0]), stringValue(row[1]))));
    await writeRange(workbookId, `${STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_SHEET}!A1`, [STARTER_SURVIVAL_DIFFERENTIATION_AUDIT_HEADERS, ...retained, ...rows.map(rowValues)]);
    return { status: "success", rows_written: rows.length, errors: [], rows };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "partial", rows_written: 0, errors: [message], rows: [] };
  }
}
