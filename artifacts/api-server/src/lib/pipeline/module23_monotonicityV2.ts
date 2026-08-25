/**
 * Module 23: Monotonicity V2 (shadow-only edge-magnitude calibration)
 *
 * V1's fixed tiers remain the live governance diagnostic. V2 deliberately
 * does not read or write a decision, board, vehicle, market, or projection.
 * It pools adjacent frozen-edge observations with PAVA/isotonic regions and
 * reports CALIBRATED, UNVERIFIED, or ANTI_MONOTONE separately for OVER/UNDER.
 */

import { addSheet, expandSheetColumns, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

const VEHICLE_LOG_SHEET = "VEHICLE_LOG";
const OUTCOMES_SHEET = "SHADOW_OUTCOMES";
const CALIBRATION_SHEET = "MONOTONICITY_V2";
const REPLAY_SHEET = "MONOTONICITY_V2_REPLAY";
const CATASTROPHIC_ERROR = 4;

export const MONOTONICITY_V2_HEADER = [
  "Direction", "Row_Type", "Edge_Min", "Edge_Max", "N_Eligible", "N_Directional", "N_Wins", "N_Pushes",
  "Directional_Accuracy_Pct", "MAE", "Median_AE", "Bias", "Miss_4Plus_Pct",
  "High_Tail_Underprediction_Count", "Low_Tail_Overprojection_Count",
  "Edge_Hit_Correlation", "Hit_CI_Low", "Hit_CI_High", "Edge_AE_Correlation", "AE_CI_Low", "AE_CI_High",
  "V2_State", "Relationship", "V1_Blocked_Winner_Count", "V1_Blocked_Loser_Count",
  "V2_Blocked_Winner_Count", "V2_Blocked_Loser_Count", "V2_Unverified_Count", "V2_Calibrated_Count", "V2_Anti_Monotone_Count", "Report_TS",
] as const;

export const MONOTONICITY_V2_REPLAY_HEADER = [
  "Date", "Game_ID", "Direction", "Raw_Model_Edge", "Frozen_Projection", "Frozen_Market_Line", "Actual_Total",
  "Directional_Result", "Projection_Error", "Abs_Error", "V1_Status", "V1_Blocked", "No_V1_Gate_Counterfactual",
  "V2_State", "V2_Would_Block", "V2_Edge_Credit", "V2_Policy", "Report_TS",
] as const;

export type MonotonicityV2State = "CALIBRATED" | "UNVERIFIED" | "ANTI_MONOTONE";
export type EdgeRelationship = "POSITIVE" | "FLAT" | "NEGATIVE" | "INDETERMINATE";
export type Direction = "OVER" | "UNDER";

export interface MonotonicityV2Observation {
  date: string;
  game_id: string;
  direction: Direction;
  edge: number;
  frozen_projection: number;
  frozen_market_line: number;
  actual_total: number;
  error: number;
  abs_error: number;
  directional_result: "WIN" | "LOSS" | "PUSH";
  v1_status: string;
  v1_blocked: boolean;
}

export interface PooledEdgeRegion {
  edge_min: number;
  edge_max: number;
  observations: MonotonicityV2Observation[];
  fitted_hit_rate_pct: number | null;
}

export interface DirectionalV2Summary {
  direction: Direction;
  state: MonotonicityV2State;
  relationship: EdgeRelationship;
  eligible_n: number;
  directional_n: number;
  directional_wins: number;
  directional_pushes: number;
  directional_accuracy_pct: number | null;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  miss_4plus_pct: number | null;
  high_tail_underprediction_count: number;
  low_tail_overprojection_count: number;
  edge_hit_correlation: number | null;
  hit_ci_low: number | null;
  hit_ci_high: number | null;
  edge_ae_correlation: number | null;
  ae_ci_low: number | null;
  ae_ci_high: number | null;
  v1_blocked_winner_count: number;
  v1_blocked_loser_count: number;
  v2_blocked_winner_count: number;
  v2_blocked_loser_count: number;
  v2_unverified_count: number;
  v2_calibrated_count: number;
  v2_anti_monotone_count: number;
  pooled_regions: PooledEdgeRegion[];
}

export interface MonotonicityV2Result {
  status: "success" | "failure";
  report_timestamp_utc: string;
  eligible_games: number;
  summaries: DirectionalV2Summary[];
  replay_rows: unknown[][];
  errors: string[];
}

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const result = Number.parseFloat(String(value));
  return Number.isFinite(result) ? result : null;
}

function round(value: number): number { return Number.parseFloat(value.toFixed(3)); }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Pearson correlation; null when the observed values cannot support one. */
function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < 4 || xs.length !== ys.length) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]! - xMean;
    const y = ys[i]! - yMean;
    xy += x * y; xx += x * x; yy += y * y;
  }
  if (xx === 0 || yy === 0) return null;
  return xy / Math.sqrt(xx * yy);
}

/** Fisher-transform 95% interval. It is evidence reporting, not a live threshold. */
function correlationInterval(r: number | null, n: number): { low: number | null; high: number | null } {
  if (r === null || n <= 3) return { low: null, high: null };
  // Perfect synthetic or tied-data correlations are still meaningful evidence;
  // clamp only for Fisher-transform numerical stability.
  const bounded = Math.max(-0.999999, Math.min(0.999999, r));
  const z = Math.atanh(bounded);
  const delta = 1.96 / Math.sqrt(n - 3);
  return { low: Math.tanh(z - delta), high: Math.tanh(z + delta) };
}

function deriveState(
  hit: number | null,
  hitInterval: { low: number | null; high: number | null },
  ae: number | null,
  aeInterval: { low: number | null; high: number | null },
): { state: MonotonicityV2State; relationship: EdgeRelationship } {
  // Confidence intervals make sparse evidence explicitly UNVERIFIED instead of
  // smuggling in a replacement minimum-bin threshold.
  if (hit === null || ae === null || hitInterval.low === null || hitInterval.high === null || aeInterval.low === null || aeInterval.high === null) {
    return { state: "UNVERIFIED", relationship: "INDETERMINATE" };
  }
  if (hitInterval.high < 0 || aeInterval.low > 0) return { state: "ANTI_MONOTONE", relationship: "NEGATIVE" };
  if (hitInterval.low > 0 && aeInterval.high < 0) return { state: "CALIBRATED", relationship: "POSITIVE" };
  return { state: "UNVERIFIED", relationship: "FLAT" };
}

/** Pool-adjacent-violators fit for hit reliability: no fixed edge bins required. */
export function poolNearbyEdgeRegions(observations: MonotonicityV2Observation[]): PooledEdgeRegion[] {
  const directional = observations.filter((row) => row.directional_result !== "PUSH").sort((a, b) => a.edge - b.edge);
  const blocks: Array<{ rows: MonotonicityV2Observation[]; wins: number }> = [];
  for (const row of directional) {
    blocks.push({ rows: [row], wins: row.directional_result === "WIN" ? 1 : 0 });
    while (blocks.length >= 2) {
      const previous = blocks[blocks.length - 2]!;
      const current = blocks[blocks.length - 1]!;
      if (previous.wins / previous.rows.length <= current.wins / current.rows.length) break;
      blocks.splice(blocks.length - 2, 2, { rows: [...previous.rows, ...current.rows], wins: previous.wins + current.wins });
    }
  }
  return blocks.map((block) => ({
    edge_min: block.rows[0]!.edge,
    edge_max: block.rows[block.rows.length - 1]!.edge,
    observations: block.rows,
    fitted_hit_rate_pct: round(block.wins / block.rows.length * 100),
  }));
}

export function buildDirectionalV2Summary(direction: Direction, observations: MonotonicityV2Observation[]): DirectionalV2Summary {
  const directional = observations.filter((row) => row.directional_result !== "PUSH");
  const wins = directional.filter((row) => row.directional_result === "WIN").length;
  const pushes = observations.length - directional.length;
  const errors = observations.map((row) => row.error);
  const absErrors = observations.map((row) => row.abs_error);
  const hit = correlation(directional.map((row) => row.edge), directional.map((row) => row.directional_result === "WIN" ? 1 : 0));
  const ae = correlation(directional.map((row) => row.edge), directional.map((row) => row.abs_error));
  const hitInterval = correlationInterval(hit, directional.length);
  const aeInterval = correlationInterval(ae, directional.length);
  const classification = deriveState(hit, hitInterval, ae, aeInterval);
  const v1Blocked = observations.filter((row) => row.v1_blocked);
  const v2Blocked = classification.state === "ANTI_MONOTONE" ? observations : [];
  const counter = (rows: MonotonicityV2Observation[], result: "WIN" | "LOSS") => rows.filter((row) => row.directional_result === result).length;
  return {
    direction,
    state: classification.state,
    relationship: classification.relationship,
    eligible_n: observations.length,
    directional_n: directional.length,
    directional_wins: wins,
    directional_pushes: pushes,
    directional_accuracy_pct: directional.length ? round(wins / directional.length * 100) : null,
    mae: absErrors.length ? round(absErrors.reduce((sum, value) => sum + value, 0) / absErrors.length) : null,
    median_ae: median(absErrors) === null ? null : round(median(absErrors)!),
    bias: errors.length ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
    miss_4plus_pct: absErrors.length ? round(absErrors.filter((value) => value >= CATASTROPHIC_ERROR).length / absErrors.length * 100) : null,
    high_tail_underprediction_count: errors.filter((value) => value <= -CATASTROPHIC_ERROR).length,
    low_tail_overprojection_count: errors.filter((value) => value >= CATASTROPHIC_ERROR).length,
    edge_hit_correlation: hit === null ? null : round(hit),
    hit_ci_low: hitInterval.low === null ? null : round(hitInterval.low),
    hit_ci_high: hitInterval.high === null ? null : round(hitInterval.high),
    edge_ae_correlation: ae === null ? null : round(ae),
    ae_ci_low: aeInterval.low === null ? null : round(aeInterval.low),
    ae_ci_high: aeInterval.high === null ? null : round(aeInterval.high),
    v1_blocked_winner_count: counter(v1Blocked, "WIN"),
    v1_blocked_loser_count: counter(v1Blocked, "LOSS"),
    v2_blocked_winner_count: counter(v2Blocked, "WIN"),
    v2_blocked_loser_count: counter(v2Blocked, "LOSS"),
    v2_unverified_count: classification.state === "UNVERIFIED" ? observations.length : 0,
    v2_calibrated_count: classification.state === "CALIBRATED" ? observations.length : 0,
    v2_anti_monotone_count: classification.state === "ANTI_MONOTONE" ? observations.length : 0,
    pooled_regions: poolNearbyEdgeRegions(observations),
  };
}

function summaryValues(summary: DirectionalV2Summary, type: string, edgeMin: number | null, edgeMax: number | null, observations: MonotonicityV2Observation[], reportTs: string, fittedRate: number | null = null): unknown[] {
  const directional = observations.filter((row) => row.directional_result !== "PUSH");
  const wins = directional.filter((row) => row.directional_result === "WIN").length;
  const errors = observations.map((row) => row.error);
  const abs = observations.map((row) => row.abs_error);
  return [
    summary.direction, type, edgeMin ?? "", edgeMax ?? "", observations.length, directional.length, wins, observations.length - directional.length,
    fittedRate ?? (directional.length ? round(wins / directional.length * 100) : ""),
    abs.length ? round(abs.reduce((sum, value) => sum + value, 0) / abs.length) : "", median(abs) ?? "", errors.length ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : "",
    abs.length ? round(abs.filter((value) => value >= CATASTROPHIC_ERROR).length / abs.length * 100) : "", errors.filter((value) => value <= -CATASTROPHIC_ERROR).length, errors.filter((value) => value >= CATASTROPHIC_ERROR).length,
    summary.edge_hit_correlation ?? "", summary.hit_ci_low ?? "", summary.hit_ci_high ?? "", summary.edge_ae_correlation ?? "", summary.ae_ci_low ?? "", summary.ae_ci_high ?? "",
    summary.state, summary.relationship, summary.v1_blocked_winner_count, summary.v1_blocked_loser_count, summary.v2_blocked_winner_count, summary.v2_blocked_loser_count,
    summary.v2_unverified_count, summary.v2_calibrated_count, summary.v2_anti_monotone_count, reportTs,
  ];
}

export function buildMonotonicityV2Replay(observations: MonotonicityV2Observation[], summaries: DirectionalV2Summary[], reportTs: string): unknown[][] {
  const stateByDirection = new Map(summaries.map((summary) => [summary.direction, summary]));
  return observations.map((row) => {
    const summary = stateByDirection.get(row.direction)!;
    const v2WouldBlock = summary.state === "ANTI_MONOTONE";
    return [
      row.date, row.game_id, row.direction, row.edge, row.frozen_projection, row.frozen_market_line, row.actual_total,
      row.directional_result, row.error, row.abs_error, row.v1_status, row.v1_blocked ? "TRUE" : "FALSE",
      row.v1_blocked ? "WOULD_ALLOW_V1_BLOCKED_CANDIDATE" : "NOT_APPLICABLE",
      summary.state, v2WouldBlock ? "TRUE" : "FALSE", summary.state === "CALIBRATED" ? "EDGE_CREDIT" : "NONE",
      v2WouldBlock ? "WOULD_BLOCK_ANTI_MONOTONE" : summary.state === "UNVERIFIED" ? "UNVERIFIED_NO_EDGE_CREDIT" : "CALIBRATED_EDGE_CREDIT_ONLY", reportTs,
    ];
  });
}

/** Parses only frozen VEHICLE_LOG records joined to settled actual totals. */
export function parseFrozenMonotonicityV2Observations(vehicleRows: unknown[][], outcomeRows: unknown[][]): MonotonicityV2Observation[] {
  const actualByGame = new Map<string, number>();
  for (const row of outcomeRows) {
    const game = String(row[1] ?? "").trim();
    const actual = numberOrNull(row[5]);
    if (game && actual !== null) actualByGame.set(game, actual);
  }
  const seen = new Set<string>();
  const output: MonotonicityV2Observation[] = [];
  for (const row of vehicleRows) {
    const date = String(row[0] ?? "").trim();
    const game = String(row[1] ?? "").trim();
    const direction = String(row[6] ?? "").trim() as Direction;
    const line = numberOrNull(row[5]);
    const projection = numberOrNull(row[7]);
    const variance = numberOrNull(row[8]);
    const blocker = String(row[10] ?? "").trim();
    if (!date || !game || seen.has(game) || (direction !== "OVER" && direction !== "UNDER") || line === null || projection === null || variance === null) continue;
    const actual = actualByGame.get(game);
    if (actual === undefined) continue;
    seen.add(game);
    const result = actual === line ? "PUSH" : direction === "OVER" ? actual > line ? "WIN" : "LOSS" : actual < line ? "WIN" : "LOSS";
    const error = projection - actual;
    const v1Blocked = blocker.startsWith("DISABLED_MONOTONICITY_");
    output.push({
      date, game_id: game, direction, edge: Math.abs(variance), frozen_projection: projection, frozen_market_line: line, actual_total: actual,
      error: round(error), abs_error: round(Math.abs(error)), directional_result: result,
      v1_status: v1Blocked ? blocker : "NOT_BLOCKED", v1_blocked: v1Blocked,
    });
  }
  return output;
}

export function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|\b400\b|sheet\s+"?[^"]+"?\s+not found/i.test(message);
}

async function ensureSheet(workbookId: string, sheet: string, columns: number): Promise<void> {
  try {
    await expandSheetColumns(workbookId, sheet, columns);
  } catch (error: unknown) {
    // Google Sheets uses this named-tab message for a brand-new workbook;
    // it is not necessarily surfaced as an HTTP 400 range error.
    if (!isMissingSheetError(error)) throw error;
    await addSheet(workbookId, sheet);
    await expandSheetColumns(workbookId, sheet, columns);
  }
}

export async function runMonotonicityV2(options: { workbookId?: string } = {}): Promise<MonotonicityV2Result> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const reportTs = new Date().toISOString();
  try {
    const [vehicles, outcomes] = await Promise.all([
      readRange(workbookId, `${VEHICLE_LOG_SHEET}!A2:N20000`),
      readRange(workbookId, `${OUTCOMES_SHEET}!A2:H20000`),
    ]);
    const observations = parseFrozenMonotonicityV2Observations(vehicles.values ?? [], outcomes.values ?? []);
    const summaries = (["OVER", "UNDER"] as Direction[]).map((direction) => buildDirectionalV2Summary(direction, observations.filter((row) => row.direction === direction)));
    const replay = buildMonotonicityV2Replay(observations, summaries, reportTs);
    const calibrationRows: unknown[][] = [];
    for (const summary of summaries) {
      const directionObservations = observations.filter((row) => row.direction === summary.direction);
      calibrationRows.push(summaryValues(summary, "SUMMARY", null, null, directionObservations, reportTs));
      for (const region of summary.pooled_regions) calibrationRows.push(summaryValues(summary, "POOLED_REGION", region.edge_min, region.edge_max, region.observations, reportTs, region.fitted_hit_rate_pct));
    }
    await ensureSheet(workbookId, CALIBRATION_SHEET, MONOTONICITY_V2_HEADER.length);
    await ensureSheet(workbookId, REPLAY_SHEET, MONOTONICITY_V2_REPLAY_HEADER.length);
    await writeRange(workbookId, `${CALIBRATION_SHEET}!A1`, [Array.from(MONOTONICITY_V2_HEADER), ...calibrationRows]);
    await writeRange(workbookId, `${REPLAY_SHEET}!A1`, [Array.from(MONOTONICITY_V2_REPLAY_HEADER), ...replay]);
    logger.info({ eligible_games: observations.length, replay_rows: replay.length }, "MODULE_23: Monotonicity V2 written (shadow-only)");
    return { status: "success", report_timestamp_utc: reportTs, eligible_games: observations.length, summaries, replay_rows: replay, errors: [] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, "MODULE_23: Monotonicity V2 failed");
    return { status: "failure", report_timestamp_utc: reportTs, eligible_games: 0, summaries: [], replay_rows: [], errors: [message] };
  }
}
