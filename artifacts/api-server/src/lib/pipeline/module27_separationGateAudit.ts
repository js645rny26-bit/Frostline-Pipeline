/**
 * Module 27: Separation Gate Audit V1
 *
 * A pre-registered, shadow-only study of whether absolute projection
 * separation improves directional reliability *inside* a price-blind
 * structural cohort. It observes the existing 1.5 boundary; it neither
 * changes nor validates that operational boundary by itself.
 *
 * Reference-market observations remain useful research rows, but they are
 * never silently counted as literal Hard Rock calibration evidence.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

export const SEPARATION_GATE_AUDIT_SHEET = "SEPARATION_GATE_AUDIT_V1";
export const SEPARATION_GATE_AUDIT_SUMMARY_SHEET = "SEPARATION_GATE_AUDIT_SUMMARY_V1";

export const SEPARATION_GATE_AUDIT_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Frozen_Engine_Version",
  "Frozen_Schema_Version",
  "Pre_Registration_Version",
  "Price_Blind_Structural_Eligibility_Status",
  "Price_Blind_Structural_Failed_Checks",
  "Frozen_Projected_Total",
  "Separation_Query_Line",
  "Separation_Market_Provenance",
  "Separation_Hard_Rock_Calibration_Status",
  "Separation_Continuous",
  "Separation_Cohort",
  "Separation_Adjacent_Threshold_Cohort",
  "Separation_Research_Tag",
  "Direction_From_Queried_Line",
  "Actual_Total",
  "Directional_Result",
  "Total_Error",
  "Total_Abs_Error",
  "Settlement_TS",
  "Replay_Status",
] as const;

export const SEPARATION_GATE_AUDIT_SUMMARY_HEADERS = [
  "Evidence_Population",
  "Separation_Cohort",
  "Adjacent_Threshold_Cohort",
  "Eligible_N",
  "Directional_Eligible_N",
  "Directional_Wins",
  "Directional_Losses",
  "Directional_Pushes",
  "Directional_Win_Rate",
  "Wilson_95_Lower",
  "Wilson_95_Upper",
  "Mean_Abs_Center_Error",
  "Median_Abs_Center_Error",
  "Signed_Center_Bias",
  "Major_Miss_4Plus_Count",
  "Major_Miss_4Plus_Rate",
  "Probability_Layer_Status",
  "Research_Status",
  "Replay_TS",
] as const;

interface FrozenSeparationPacket {
  date: string;
  game_id: string;
  snapshot_ts: string;
  engine_version: string;
  schema_version: number | null;
  pre_registration_version: string;
  structural_eligibility_status: string;
  structural_failed_checks: string;
  projected_total: number;
  query_line: number | null;
  market_provenance: string;
  hard_rock_calibration_status: string;
  separation: number | null;
  separation_cohort: string;
  adjacent_threshold_cohort: string;
  research_tag: string;
}

interface SettledGameTruth {
  date: string;
  game_id: string;
  snapshot_ts: string;
  actual_total: number;
  total_error: number;
  total_abs_error: number;
  settlement_ts: string;
}

export interface SeparationGateAuditResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  frozen_packets_seen: number;
  structural_eligible_packets_seen: number;
  eligible_games: number;
  replay_rows_written: number;
  summary_rows_written: number;
  snapshot_mismatches: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function key(date: string, gameId: string): string {
  return `${date}|${gameId}`;
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((name, index) => [text(name), index]));
}

function value(row: unknown[], index: ReadonlyMap<string, number>, name: string): unknown {
  const column = index.get(name);
  return column === undefined ? undefined : row[column];
}

function isValidBeforeFirstPitch(snapshotTs: string, firstPitch: string): boolean {
  const snapshotMs = Date.parse(snapshotTs);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
}

/** Read only frozen v46+ prospective records. Missing fields are not backfilled. */
export function parseFrozenSeparationPackets(rows: unknown[][]): Map<string, FrozenSeparationPacket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const packets = new Map<string, FrozenSeparationPacket>();
  const latestSnapshotMs = new Map<string, number>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const projectedTotal = numeric(value(row, index, "Base_Projection"));
    const observationKey = key(date, gameId);
    const snapshotMs = Date.parse(snapshotTs);
    const preRegistrationVersion = text(value(row, index, "Separation_Pre_Registration_Version"));
    if (
      !date || !gameId || !snapshotTs || !preRegistrationVersion
      || text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME"
      || !isValidBeforeFirstPitch(snapshotTs, firstPitch)
      || projectedTotal === null
      || !Number.isFinite(snapshotMs)
      || snapshotMs < (latestSnapshotMs.get(observationKey) ?? Number.NEGATIVE_INFINITY)
    ) continue;
    packets.set(observationKey, {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      engine_version: text(value(row, index, "Engine_Version")),
      schema_version: numeric(value(row, index, "Schema_Version")),
      pre_registration_version: preRegistrationVersion,
      structural_eligibility_status: text(value(row, index, "Price_Blind_Structural_Eligibility_Status")),
      structural_failed_checks: text(value(row, index, "Price_Blind_Structural_Failed_Checks")),
      projected_total: projectedTotal,
      query_line: numeric(value(row, index, "Separation_Query_Line")),
      market_provenance: text(value(row, index, "Separation_Market_Provenance")),
      hard_rock_calibration_status: text(value(row, index, "Separation_Hard_Rock_Calibration_Status")),
      separation: numeric(value(row, index, "Separation_Continuous")),
      separation_cohort: text(value(row, index, "Separation_Cohort")),
      adjacent_threshold_cohort: text(value(row, index, "Separation_Adjacent_Threshold_Cohort")),
      research_tag: text(value(row, index, "Separation_Research_Tag")),
    });
    latestSnapshotMs.set(observationKey, snapshotMs);
  }
  return packets;
}

/** Module 24 is the canonical settled frozen-packet outcome join. */
export function parseSettledSeparationGameTruth(rows: unknown[][]): Map<string, SettledGameTruth> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const games = new Map<string, SettledGameTruth>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Frozen_Packet_Snapshot_TS"));
    const actualTotal = numeric(value(row, index, "Actual_Total"));
    const totalError = numeric(value(row, index, "Total_Error"));
    const totalAbsError = numeric(value(row, index, "Total_Abs_Error"));
    if (
      !date || !gameId || !snapshotTs || actualTotal === null
      || totalError === null || totalAbsError === null
      || text(value(row, index, "Replay_Status")) !== "FROZEN_PACKET_AND_FINAL_VERIFIED"
    ) continue;
    games.set(key(date, gameId), {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      actual_total: actualTotal,
      total_error: totalError,
      total_abs_error: totalAbsError,
      settlement_ts: text(value(row, index, "Settlement_TS")),
    });
  }
  return games;
}

function directionFromQueriedLine(projectedTotal: number, queryLine: number | null): "OVER" | "UNDER" | "NO_EDGE" {
  if (queryLine === null) return "NO_EDGE";
  if (projectedTotal > queryLine) return "OVER";
  if (projectedTotal < queryLine) return "UNDER";
  return "NO_EDGE";
}

function directionalResult(
  direction: "OVER" | "UNDER" | "NO_EDGE",
  actualTotal: number,
  queryLine: number | null,
): "WIN" | "LOSS" | "PUSH" | "NO_DIRECTION" {
  if (direction === "NO_EDGE" || queryLine === null) return "NO_DIRECTION";
  if (actualTotal === queryLine) return "PUSH";
  return (direction === "OVER" && actualTotal > queryLine)
    || (direction === "UNDER" && actualTotal < queryLine)
    ? "WIN"
    : "LOSS";
}

export function buildSeparationGateAuditRows(
  packets: ReadonlyMap<string, FrozenSeparationPacket>,
  settledGames: ReadonlyMap<string, SettledGameTruth>,
): { rows: unknown[][]; snapshot_mismatches: number; structural_eligible_packets_seen: number } {
  const rows: unknown[][] = [];
  let snapshotMismatches = 0;
  let structuralEligiblePacketsSeen = 0;
  for (const [observationKey, packet] of packets) {
    if (packet.structural_eligibility_status === "PRICE_BLIND_STRUCTURAL_ELIGIBLE") {
      structuralEligiblePacketsSeen++;
    }
    const settled = settledGames.get(observationKey);
    if (!settled) continue;
    if (packet.snapshot_ts !== settled.snapshot_ts) {
      snapshotMismatches++;
      continue;
    }
    const direction = directionFromQueriedLine(packet.projected_total, packet.query_line);
    rows.push([
      packet.date,
      packet.game_id,
      packet.snapshot_ts,
      packet.engine_version,
      packet.schema_version ?? "",
      packet.pre_registration_version,
      packet.structural_eligibility_status,
      packet.structural_failed_checks,
      packet.projected_total,
      packet.query_line ?? "",
      packet.market_provenance,
      packet.hard_rock_calibration_status,
      packet.separation ?? "",
      packet.separation_cohort,
      packet.adjacent_threshold_cohort,
      packet.research_tag,
      direction,
      settled.actual_total,
      directionalResult(direction, settled.actual_total, packet.query_line),
      settled.total_error,
      settled.total_abs_error,
      settled.settlement_ts,
      "FROZEN_SEPARATION_RESEARCH_ONLY",
    ]);
  }
  return { rows, snapshot_mismatches: snapshotMismatches, structural_eligible_packets_seen: structuralEligiblePacketsSeen };
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round3(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : round3((ordered[middle - 1]! + ordered[middle]!) / 2);
}

/** Wilson 95% interval excludes pushes, exactly like directional win rate. */
export function wilson95(wins: number, eligible: number): { lower: number | null; upper: number | null } {
  if (eligible <= 0) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const z2 = z ** 2;
  const p = wins / eligible;
  const denominator = 1 + z2 / eligible;
  const center = (p + z2 / (2 * eligible)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * eligible)) / eligible);
  return { lower: round3(center - margin), upper: round3(center + margin) };
}

function auditValue(row: unknown[], name: (typeof SEPARATION_GATE_AUDIT_HEADERS)[number]): unknown {
  return row[SEPARATION_GATE_AUDIT_HEADERS.indexOf(name)];
}

function isStructuralEligible(row: unknown[]): boolean {
  return auditValue(row, "Price_Blind_Structural_Eligibility_Status") === "PRICE_BLIND_STRUCTURAL_ELIGIBLE";
}

function hasDirectionalResult(row: unknown[]): boolean {
  const result = auditValue(row, "Directional_Result");
  return result === "WIN" || result === "LOSS" || result === "PUSH";
}

type EvidencePopulation =
  | "ALL_STRUCTURAL_ELIGIBLE_RESEARCH"
  | "LITERAL_HARD_ROCK_HALF_TOTAL_CALIBRATION"
  | "REFERENCE_ONLY_RESEARCH";

function populationRows(rows: unknown[][], population: EvidencePopulation): unknown[][] {
  return rows.filter((row) => {
    if (!isStructuralEligible(row) || !hasDirectionalResult(row)) return false;
    if (population === "ALL_STRUCTURAL_ELIGIBLE_RESEARCH") return true;
    if (population === "LITERAL_HARD_ROCK_HALF_TOTAL_CALIBRATION") {
      return auditValue(row, "Separation_Hard_Rock_Calibration_Status") === "LITERAL_HARD_ROCK_HALF_TOTAL";
    }
    return auditValue(row, "Separation_Market_Provenance") === "REFERENCE_ONLY_RESEARCH";
  });
}

function summaryRow(
  population: EvidencePopulation,
  rows: unknown[][],
  separationCohort: string,
  adjacentCohort: string,
  replayTs: string,
): unknown[] {
  const directional = rows.filter(hasDirectionalResult);
  const wins = directional.filter((row) => auditValue(row, "Directional_Result") === "WIN").length;
  const losses = directional.filter((row) => auditValue(row, "Directional_Result") === "LOSS").length;
  const pushes = directional.filter((row) => auditValue(row, "Directional_Result") === "PUSH").length;
  const denominator = wins + losses;
  const interval = wilson95(wins, denominator);
  const absErrors = rows
    .map((row) => numeric(auditValue(row, "Total_Abs_Error")))
    .filter((value): value is number => value !== null);
  const signedErrors = rows
    .map((row) => numeric(auditValue(row, "Total_Error")))
    .filter((value): value is number => value !== null);
  const majorMisses = absErrors.filter((error) => error >= 4).length;
  return [
    population,
    separationCohort,
    adjacentCohort,
    rows.length,
    denominator,
    wins,
    losses,
    pushes,
    denominator === 0 ? "" : round3(wins / denominator),
    interval.lower ?? "",
    interval.upper ?? "",
    mean(absErrors) ?? "",
    median(absErrors) ?? "",
    mean(signedErrors) ?? "",
    majorMisses,
    absErrors.length === 0 ? "" : round3(majorMisses / absErrors.length),
    "NOT_AVAILABLE_NO_PROBABILITY_LAYER",
    "PRE_REGISTERED_RESEARCH_ONLY_NO_THRESHOLD_CHANGE",
    replayTs,
  ];
}

/**
 * The fixed summary includes all five pre-registered bins and the explicit
 * adjacent-boundary comparison (1.25-1.49 vs 1.50-1.74) for each evidence
 * population. Empty bins stay visible as N=0 rather than disappearing.
 */
export function buildSeparationGateAuditSummary(rows: unknown[][], replayTs: string): unknown[][] {
  const cohorts = [
    "LOW_UNDER_0.75",
    "MODERATE_0.75_1.24",
    "NEAR_BOUNDARY_1.25_1.49",
    "CURRENT_QUALIFIED_1.50_1.99",
    "LARGE_2.00_PLUS",
  ];
  const adjacent = ["NEAR_BOUNDARY_1.25_1.49", "ADJACENT_ABOVE_1.50_1.74"];
  const populations: EvidencePopulation[] = [
    "ALL_STRUCTURAL_ELIGIBLE_RESEARCH",
    "LITERAL_HARD_ROCK_HALF_TOTAL_CALIBRATION",
    "REFERENCE_ONLY_RESEARCH",
  ];
  const summaries: unknown[][] = [];
  for (const population of populations) {
    const eligible = populationRows(rows, population);
    for (const cohort of cohorts) {
      summaries.push(summaryRow(
        population,
        eligible.filter((row) => auditValue(row, "Separation_Cohort") === cohort),
        cohort,
        "NOT_ADJACENT_COMPARISON",
        replayTs,
      ));
    }
    for (const cohort of adjacent) {
      summaries.push(summaryRow(
        population,
        eligible.filter((row) => auditValue(row, "Separation_Adjacent_Threshold_Cohort") === cohort),
        "ADJACENT_BOUNDARY_COMPARISON",
        cohort,
        replayTs,
      ));
    }
  }
  return summaries;
}

async function ensureSheets(
  workbookId: string,
  sheetsToEnsure: Array<{ sheet: string; column_count: number }>,
): Promise<void> {
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const { sheet } of sheetsToEnsure) {
    if (!existing.has(sheet)) {
      await addSheet(workbookId, sheet);
      existing.add(sheet);
    }
  }
  await Promise.all(sheetsToEnsure.map(({ sheet, column_count }) =>
    expandSheetColumns(workbookId, sheet, column_count)));
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message);
}

async function readOptionalSheet(workbookId: string, range: string, warnings: string[]): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    warnings.push(`MISSING_SEPARATION_AUDIT_SOURCE: ${range}`);
    return [];
  }
}

export async function runSeparationGateAudit(
  options: { workbookId?: string } = {},
): Promise<SeparationGateAuditResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTimestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetRows, gameTruthRows] = await Promise.all([
      readOptionalSheet(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`, warnings),
      readOptionalSheet(workbookId, "GAME_TRUTH_REPLAY_V1!A1:AZ10000", warnings),
    ]);
    const packets = parseFrozenSeparationPackets(packetRows);
    const settledGames = parseSettledSeparationGameTruth(gameTruthRows);
    const replay = buildSeparationGateAuditRows(packets, settledGames);
    if (replay.snapshot_mismatches > 0) {
      warnings.push(`FROZEN_PACKET_SNAPSHOT_MISMATCH: ${replay.snapshot_mismatches} separation joins were excluded`);
    }
    const summaryRows = buildSeparationGateAuditSummary(replay.rows, replayTimestamp);
    await ensureSheets(workbookId, [
      { sheet: SEPARATION_GATE_AUDIT_SHEET, column_count: SEPARATION_GATE_AUDIT_HEADERS.length },
      { sheet: SEPARATION_GATE_AUDIT_SUMMARY_SHEET, column_count: SEPARATION_GATE_AUDIT_SUMMARY_HEADERS.length },
    ]);
    await Promise.all([
      writeRange(workbookId, `${SEPARATION_GATE_AUDIT_SHEET}!A1`, [
        Array.from(SEPARATION_GATE_AUDIT_HEADERS), ...replay.rows,
      ]),
      writeRange(workbookId, `${SEPARATION_GATE_AUDIT_SUMMARY_SHEET}!A1`, [
        Array.from(SEPARATION_GATE_AUDIT_SUMMARY_HEADERS), ...summaryRows,
      ]),
    ]);
    logger.info(
      { frozen_packets_seen: packets.size, eligible_games: replay.rows.length, summary_rows: summaryRows.length },
      "MODULE_27: separation gate audit written (pre-registered, shadow-only)",
    );
    return {
      status: "success",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: packets.size,
      structural_eligible_packets_seen: replay.structural_eligible_packets_seen,
      eligible_games: replay.rows.length,
      replay_rows_written: replay.rows.length,
      summary_rows_written: summaryRows.length,
      snapshot_mismatches: replay.snapshot_mismatches,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_27: separation gate audit failed");
    return {
      status: "failure",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: 0,
      structural_eligible_packets_seen: 0,
      eligible_games: 0,
      replay_rows_written: 0,
      summary_rows_written: 0,
      snapshot_mismatches: 0,
      warnings,
      errors,
    };
  }
}
