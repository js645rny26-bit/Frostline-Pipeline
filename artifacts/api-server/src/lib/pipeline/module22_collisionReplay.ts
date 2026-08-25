/**
 * Module 22: Collision Replay V1
 *
 * Aggregates only preserved, settled collision candidates. It evaluates the
 * existing xwOBA, traffic, damage, tail-only, and combined shadow views beside
 * the frozen base projection. This module is deliberately read-only with
 * respect to every active projection, board, authorization, and vehicle path.
 */

import { addSheet, expandSheetColumns, readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

const SOURCE_SHEET = "COLLISION_CALIBRATION_REPORT";
const TARGET_SHEET = "COLLISION_REPLAY_V1";
const CATASTROPHIC_ERROR = 4;

export const COLLISION_REPLAY_V1_HEADER = [
  "Scope", "Candidate", "N_Eligible", "N_Allocation",
  "MAE", "Median_AE", "Bias", "Miss_4Plus_Count", "Miss_4Plus_Pct",
  "High_Tail_Underprediction_Count", "Low_Tail_Overprojection_Count",
  "Directional_N", "Directional_Wins", "Directional_Pushes", "Directional_Accuracy_Pct",
  "False_Over_Creation_Count", "Fragile_Under_Base_Count", "Fragile_Under_Averted_Count",
  "Allocation_MAE", "Report_TS",
] as const;

export type CollisionCandidate = "BASE" | "XWOBA_ONLY" | "TRAFFIC_ONLY" | "DAMAGE_ONLY" | "COMBINED_TAIL_ONLY" | "COMBINED";
export type CollisionScope = "ALL_ELIGIBLE" | "POSITIVE_TAIL" | "ZERO_TAIL" | "NEGATIVE_TAIL";

export interface CollisionReplayObservation {
  base: number;
  baseAway: number;
  baseHome: number;
  xwoba: number | null;
  xwobaAway: number | null;
  xwobaHome: number | null;
  traffic: number | null;
  trafficAway: number | null;
  trafficHome: number | null;
  damage: number | null;
  damageAway: number | null;
  damageHome: number | null;
  combinedTail: number | null;
  combinedTailAway: number | null;
  combinedTailHome: number | null;
  combined: number | null;
  combinedAway: number | null;
  combinedHome: number | null;
  actual: number;
  actualAway: number;
  actualHome: number;
  marketLine: number | null;
  tailAdjustment: number;
}

export interface CollisionReplayRow {
  scope: CollisionScope;
  candidate: CollisionCandidate;
  n_eligible: number;
  n_allocation: number;
  mae: number | null;
  median_ae: number | null;
  bias: number | null;
  miss_4plus_count: number;
  miss_4plus_pct: number | null;
  high_tail_underprediction_count: number;
  low_tail_overprojection_count: number;
  directional_n: number;
  directional_wins: number;
  directional_pushes: number;
  directional_accuracy_pct: number | null;
  false_over_creation_count: number;
  fragile_under_base_count: number;
  fragile_under_averted_count: number;
  allocation_mae: number | null;
}

export interface CollisionReplayResult {
  status: "success" | "failure";
  report_timestamp_utc: string;
  source_rows: number;
  eligible_games: number;
  rows: CollisionReplayRow[];
  errors: string[];
}

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[midpoint - 1]! + ordered[midpoint]!) / 2
    : ordered[midpoint]!;
}

function projectionDirection(projection: number, line: number | null): "OVER" | "UNDER" | "NONE" {
  if (line === null || Math.abs(projection - line) < 0.005) return "NONE";
  return projection > line ? "OVER" : "UNDER";
}

function actualDirection(actual: number, line: number): "OVER" | "UNDER" | "PUSH" {
  if (actual === line) return "PUSH";
  return actual > line ? "OVER" : "UNDER";
}

function candidateValues(
  observation: CollisionReplayObservation,
  candidate: CollisionCandidate,
): { total: number | null; away: number | null; home: number | null } {
  switch (candidate) {
    case "BASE": return { total: observation.base, away: observation.baseAway, home: observation.baseHome };
    case "XWOBA_ONLY": return { total: observation.xwoba, away: observation.xwobaAway, home: observation.xwobaHome };
    case "TRAFFIC_ONLY": return { total: observation.traffic, away: observation.trafficAway, home: observation.trafficHome };
    case "DAMAGE_ONLY": return { total: observation.damage, away: observation.damageAway, home: observation.damageHome };
    case "COMBINED_TAIL_ONLY": return { total: observation.combinedTail, away: observation.combinedTailAway, home: observation.combinedTailHome };
    case "COMBINED": return { total: observation.combined, away: observation.combinedAway, home: observation.combinedHome };
  }
}

function inScope(observation: CollisionReplayObservation, scope: CollisionScope): boolean {
  if (scope === "ALL_ELIGIBLE") return true;
  if (scope === "POSITIVE_TAIL") return observation.tailAdjustment > 0;
  if (scope === "NEGATIVE_TAIL") return observation.tailAdjustment < 0;
  return observation.tailAdjustment === 0;
}

/** Pure aggregate used by deterministic tests and the settlement-only writer. */
export function buildCollisionReplayRows(observations: CollisionReplayObservation[]): CollisionReplayRow[] {
  const scopes: CollisionScope[] = ["ALL_ELIGIBLE", "POSITIVE_TAIL", "ZERO_TAIL", "NEGATIVE_TAIL"];
  const candidates: CollisionCandidate[] = ["BASE", "XWOBA_ONLY", "TRAFFIC_ONLY", "DAMAGE_ONLY", "COMBINED_TAIL_ONLY", "COMBINED"];

  return scopes.flatMap((scope) => candidates.map((candidate) => {
    const scoped = observations.filter((observation) => inScope(observation, scope));
    const evaluated = scoped.flatMap((observation) => {
      const values = candidateValues(observation, candidate);
      return values.total === null ? [] : [{ observation, values }];
    });
    const errors = evaluated.map(({ observation, values }) => values.total! - observation.actual);
    const absErrors = errors.map(Math.abs);
    const allocations = evaluated.flatMap(({ observation, values }) =>
      values.away === null || values.home === null
        ? []
        : [(Math.abs(values.away - observation.actualAway) + Math.abs(values.home - observation.actualHome)) / 2],
    );
    let directionalN = 0;
    let directionalWins = 0;
    let directionalPushes = 0;
    let falseOverCreation = 0;
    let fragileUnderBase = 0;
    let fragileUnderAverted = 0;
    for (const { observation, values } of evaluated) {
      if (observation.marketLine === null) continue;
      const baseDirection = projectionDirection(observation.base, observation.marketLine);
      const candidateDirection = projectionDirection(values.total!, observation.marketLine);
      const realized = actualDirection(observation.actual, observation.marketLine);
      if (baseDirection === "UNDER" && realized === "OVER") {
        fragileUnderBase++;
        if (candidateDirection !== "UNDER") fragileUnderAverted++;
      }
      if (candidateDirection === "OVER" && realized === "UNDER") falseOverCreation++;
      if (candidateDirection === "NONE") continue;
      if (realized === "PUSH") {
        directionalPushes++;
        continue;
      }
      directionalN++;
      if (candidateDirection === realized) directionalWins++;
    }
    return {
      scope,
      candidate,
      n_eligible: evaluated.length,
      n_allocation: allocations.length,
      mae: absErrors.length ? round(absErrors.reduce((sum, value) => sum + value, 0) / absErrors.length) : null,
      median_ae: median(absErrors) === null ? null : round(median(absErrors)!),
      bias: errors.length ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
      miss_4plus_count: absErrors.filter((value) => value >= CATASTROPHIC_ERROR).length,
      miss_4plus_pct: absErrors.length ? round(absErrors.filter((value) => value >= CATASTROPHIC_ERROR).length / absErrors.length * 100) : null,
      high_tail_underprediction_count: errors.filter((value) => value <= -CATASTROPHIC_ERROR).length,
      low_tail_overprojection_count: errors.filter((value) => value >= CATASTROPHIC_ERROR).length,
      directional_n: directionalN,
      directional_wins: directionalWins,
      directional_pushes: directionalPushes,
      directional_accuracy_pct: directionalN ? round(directionalWins / directionalN * 100) : null,
      false_over_creation_count: falseOverCreation,
      fragile_under_base_count: fragileUnderBase,
      fragile_under_averted_count: fragileUnderAverted,
      allocation_mae: allocations.length ? round(allocations.reduce((sum, value) => sum + value, 0) / allocations.length) : null,
    };
  }));
}

/** Reads the settled report by header so old, shorter rows remain explicit gaps. */
export function parseCollisionReplayObservations(rows: unknown[][]): CollisionReplayObservation[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((value, position) => [String(value ?? "").trim(), position]));
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const numeric = (row: unknown[], name: string) => numberOrNull(value(row, name));
  return data.flatMap((row): CollisionReplayObservation[] => {
    if (String(value(row, "Calibration_Status") ?? "") !== "SETTLED") return [];
    if (String(value(row, "Preview_Availability") ?? "") !== "AVAILABLE") return [];
    const base = numeric(row, "Base_Projection");
    const baseAway = numeric(row, "Base_Away_Projection");
    const baseHome = numeric(row, "Base_Home_Projection");
    const actual = numeric(row, "Actual_Total");
    const actualAway = numeric(row, "Actual_Away_Runs");
    const actualHome = numeric(row, "Actual_Home_Runs");
    const tailAdjustment = numeric(row, "Combined_Tail_Adjustment");
    const traffic = numeric(row, "Traffic_Only_Projection");
    const damage = numeric(row, "Damage_Only_Projection");
    const tailOnly = numeric(row, "Combined_Tail_Only_Projection");
    if (base === null || baseAway === null || baseHome === null || actual === null || actualAway === null || actualHome === null || tailAdjustment === null) return [];
    const trafficAway = numeric(row, "Traffic_Away_Evidence_Projection");
    const trafficHome = numeric(row, "Traffic_Home_Evidence_Projection");
    const damageAway = numeric(row, "Damage_Away_Evidence_Projection");
    const damageHome = numeric(row, "Damage_Home_Evidence_Projection");
    return [{
      base, baseAway, baseHome,
      xwoba: numeric(row, "xwOBA_Shadow_Projection"),
      xwobaAway: numeric(row, "xwOBA_Away_Evidence_Projection"),
      xwobaHome: numeric(row, "xwOBA_Home_Evidence_Projection"),
      traffic, trafficAway, trafficHome,
      damage, damageAway, damageHome,
      combinedTail: tailOnly,
      combinedTailAway: trafficAway === null || damageAway === null ? null : trafficAway + damageAway - baseAway,
      combinedTailHome: trafficHome === null || damageHome === null ? null : trafficHome + damageHome - baseHome,
      combined: numeric(row, "Collision_Estimated_Projection"),
      combinedAway: numeric(row, "Collision_Away_Evidence_Projection"), combinedHome: numeric(row, "Collision_Home_Evidence_Projection"),
      actual, actualAway, actualHome,
      marketLine: numeric(row, "Frozen_Market_Line"),
      tailAdjustment,
    }];
  });
}

function values(row: CollisionReplayRow, reportTs: string): unknown[] {
  return [
    row.scope, row.candidate, row.n_eligible, row.n_allocation,
    row.mae ?? "", row.median_ae ?? "", row.bias ?? "", row.miss_4plus_count, row.miss_4plus_pct ?? "",
    row.high_tail_underprediction_count, row.low_tail_overprojection_count,
    row.directional_n, row.directional_wins, row.directional_pushes, row.directional_accuracy_pct ?? "",
    row.false_over_creation_count, row.fragile_under_base_count, row.fragile_under_averted_count,
    row.allocation_mae ?? "", reportTs,
  ];
}

/** Google Sheets reports a missing tab by name, not consistently as HTTP 400. */
export function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|\b400\b|sheet\s+"?[^"]+"?\s+not found/i.test(message);
}

async function ensureCollisionReplaySheet(workbookId: string): Promise<void> {
  try {
    await expandSheetColumns(workbookId, TARGET_SHEET, COLLISION_REPLAY_V1_HEADER.length);
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    await addSheet(workbookId, TARGET_SHEET);
    await expandSheetColumns(workbookId, TARGET_SHEET, COLLISION_REPLAY_V1_HEADER.length);
  }
}

export async function runCollisionReplayV1(options: { workbookId?: string } = {}): Promise<CollisionReplayResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const reportTs = new Date().toISOString();
  try {
    let source: unknown[][] = [];
    try {
      source = (await readRange(workbookId, `${SOURCE_SHEET}!A1:AM10000`)).values ?? [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Unable to parse range") && !message.includes("400")) throw error;
    }
    const observations = parseCollisionReplayObservations(source);
    const rows = buildCollisionReplayRows(observations);
    await ensureCollisionReplaySheet(workbookId);
    await writeRange(workbookId, `${TARGET_SHEET}!A1`, [Array.from(COLLISION_REPLAY_V1_HEADER), ...rows.map((row) => values(row, reportTs))]);
    logger.info({ eligible_games: observations.length, metric_rows: rows.length }, "MODULE_22: Collision Replay V1 written");
    return { status: "success", report_timestamp_utc: reportTs, source_rows: Math.max(source.length - 1, 0), eligible_games: observations.length, rows, errors: [] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, "MODULE_22: Collision Replay V1 failed");
    return { status: "failure", report_timestamp_utc: reportTs, source_rows: 0, eligible_games: 0, rows: [], errors: [message] };
  }
}
