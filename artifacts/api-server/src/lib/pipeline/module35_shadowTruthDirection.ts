/**
 * Module 35: Shadow Truth Direction V1.
 *
 * Research-only prospective ledger. It reuses the existing Module 11
 * projection-versus-line direction rule, freezes that opinion independently
 * of BET/PASS/NO_CALL, and grades only the exact literal line stored before
 * first pitch. It has no consumer in projection, board, vehicle, stake, or
 * authorization code.
 */

import {
  addSheet,
  clearRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import {
  pregamePacketHistoryRange,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import type { SettlementRow } from "./module14_shadowSettlement.js";
import { directionFromProjectionAndLine } from "./module11_outputExtraction.js";

export const SHADOW_TRUTH_DIRECTION_SHEET = "SHADOW_TRUTH_DIRECTION_V1";
export const SHADOW_TRUTH_SUMMARY_SHEET = "SHADOW_TRUTH_SUMMARY_V1";
export const SHADOW_TRUTH_DIRECTION_VERSION = "SHADOW_TRUTH_DIRECTION_V1_2026-09-17";

export const SHADOW_TRUTH_DIRECTION_HEADERS = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Packet_Snapshot_TS", "Packet_Freeze_TS", "Confirmation_Ready",
  "Operational_Decision", "Operational_Final_Decision", "Operational_Blocker",
  "Shadow_Truth_Direction", "Shadow_Truth_Source", "Shadow_Truth_Confidence",
  "Shadow_Truth_Line", "Shadow_Truth_Line_Source", "Shadow_Truth_Line_Status",
  "Shadow_Truth_Frozen_TS", "Shadow_Truth_Record_Status", "Shadow_Truth_Notes",
  "Frozen_Price_Blind_Total", "Frozen_Variance", "Starter_Bullpen_Reliance_State",
  "Distribution_Structure_Status", "Distribution_Risk_Tags", "Actual_Total",
  "Shadow_Truth_Result", "Settlement_TS", "Research_Status",
  "Record_Integrity_Status", "Version",
] as const;

export const SHADOW_TRUTH_SUMMARY_HEADERS = [
  "Date", "Summary_Dimension", "Cohort", "Confirmation_Ready_Games",
  "Shadow_Directions_Frozen", "Correct", "Incorrect", "Push", "Ungradable",
  "Directional_Eligible_N", "Directional_Accuracy", "Research_Status",
  "Summary_Notes", "Replay_TS",
] as const;

type Direction = "OVER" | "UNDER" | "NONE";
export type OperationalDecision = "BET" | "PASS" | "NO_CALL" | "PENDING";
export type ShadowTruthResult = "CORRECT" | "INCORRECT" | "PUSH" | "UNGRADABLE" | "";

export interface ShadowTruthRecord {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  scheduled_first_pitch: string;
  packet_snapshot_ts: string;
  packet_freeze_ts: string;
  confirmation_ready: boolean;
  operational_decision: OperationalDecision;
  operational_final_decision: string;
  operational_blocker: string;
  direction: Direction;
  direction_source: string;
  confidence: number | null;
  line: number | null;
  line_source: string;
  line_status: string;
  frozen_ts: string;
  record_status: string;
  notes: string;
  frozen_total: number | null;
  frozen_variance: number | null;
  starter_bullpen_reliance_state: string;
  distribution_structure_status: string;
  distribution_risk_tags: string;
  actual_total: number | null;
  result: ShadowTruthResult;
  settlement_ts: string;
  integrity_status: string;
}

export interface ShadowTruthDirectionResult {
  status: "success" | "failure";
  phase: "pregame" | "settlement";
  date: string;
  rows_written: number;
  rows_updated: number;
  rows_frozen: number;
  rows_settled: number;
  rows_preserved: number;
  audit_gaps: number;
  summary_rows_written: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match ? `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : "";
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((value, index) => [text(value), index]));
}

function field(row: unknown[], index: Map<string, number>, name: string): unknown {
  return row[index.get(name) ?? -1];
}

function isBeforeFirstPitch(firstPitch: string, nowIso: string): boolean {
  const firstPitchMs = Date.parse(firstPitch);
  const nowMs = Date.parse(nowIso);
  return Number.isFinite(firstPitchMs) && Number.isFinite(nowMs) && nowMs < firstPitchMs;
}

function normalizeDirection(value: unknown): Direction {
  const normalized = text(value).toUpperCase();
  return normalized === "OVER" || normalized === "UNDER" ? normalized : "NONE";
}

export function resolveOperationalDecision(
  scoreDecision: unknown,
  finalDecision: unknown,
  ladderTruth?: unknown,
  ladderExecution?: unknown,
): OperationalDecision {
  if (text(ladderTruth).toUpperCase() === "NO_CALL") return "NO_CALL";
  const ladder = text(ladderExecution).toUpperCase();
  if (ladder === "BET" || ladder === "PASS") return ladder;
  const score = text(scoreDecision).toUpperCase();
  if (score === "BET" || score === "PASS" || score === "PENDING") return score;
  const final = text(finalDecision).toUpperCase();
  return final === "CORE" ? "BET" : final === "NO_CORE" ? "PASS" : "PENDING";
}

export function gradeShadowTruth(
  direction: Direction,
  line: number | null,
  actualTotal: number | null,
): Exclude<ShadowTruthResult, ""> {
  if ((direction !== "OVER" && direction !== "UNDER") || line === null || actualTotal === null) return "UNGRADABLE";
  if (actualTotal === line) return "PUSH";
  if (direction === "OVER") return actualTotal > line ? "CORRECT" : "INCORRECT";
  return actualTotal < line ? "CORRECT" : "INCORRECT";
}

interface LiteralLineSelection {
  line: number | null;
  source: string;
  status: string;
}

export function selectLiteralShadowLine(packet: Record<string, unknown>): LiteralLineSelection {
  const executable = numeric(packet.Executable_Market_Line);
  if (executable !== null && text(packet.Executable_Market_Status) === "LITERAL_EXECUTABLE_HARD_ROCK_CAPTURED") {
    return {
      line: executable,
      source: text(packet.Executable_Market_Source) || "LITERAL_EXECUTABLE_HARD_ROCK",
      status: "LITERAL_EXECUTABLE_HARD_ROCK",
    };
  }
  const literalReferenceAvailable = numeric(packet.Reference_Market_Line) !== null
    && text(packet.Reference_Market_Representation_Status) === "LITERAL_REFERENCE";
  return {
    line: null,
    source: "",
    status: literalReferenceAvailable
      ? "MISSING_EXECUTABLE_LINE_REFERENCE_NOT_SUBSTITUTED"
      : "MISSING_LITERAL_EXECUTABLE_LINE",
  };
}

function packetObject(row: unknown[], index: Map<string, number>): Record<string, unknown> {
  return Object.fromEntries([...index].map(([name, column]) => [name, row[column]]));
}

export function packetToRecord(
  row: unknown[],
  index: Map<string, number>,
  nowIso: string,
  ladder?: { truth: string; execution: string },
): ShadowTruthRecord | null {
  const date = canonicalDate(field(row, index, "Date"));
  const gameId = text(field(row, index, "Game_ID"));
  if (!date || !gameId) return null;
  const packetStatus = text(field(row, index, "Packet_Status"));
  const firstPitch = text(field(row, index, "Scheduled_First_Pitch"));
  // Creation is prospective only. FROZEN_PREGAME rows are accepted later
  // solely to validate/finalize a record that already existed in this ledger;
  // they can never create a missing shadow direction after first pitch.
  if (packetStatus !== "OPEN_PROSPECTIVE" || !isBeforeFirstPitch(firstPitch, nowIso)) return null;

  const packet = packetObject(row, index);
  const lineSelection = selectLiteralShadowLine(packet);
  const frozenTotal = numeric(field(row, index, "Base_Projection"));
  // When executable evidence exists, apply the same Module 11 direction rule
  // to that literal frozen line. When it does not, preserve any already-stored
  // upstream direction for audit visibility but leave the row ungradable; a
  // reference/proxy line is never substituted as the grading line.
  const upstreamDirection = normalizeDirection(field(row, index, "Direction"));
  const direction = lineSelection.line === null
    ? upstreamDirection
    : directionFromProjectionAndLine(frozenTotal, lineSelection.line);
  const finalDecision = text(field(row, index, "Final_Decision"));
  const operationalDecision = resolveOperationalDecision(
    field(row, index, "Score_Decision"), finalDecision, ladder?.truth, ladder?.execution,
  );
  const confirmationReady = text(field(row, index, "Core_Packet_Status")) === "COMPLETE"
    && finalDecision !== "PENDING";
  const packetSnapshotTs = text(field(row, index, "Packet_Snapshot_TS"));
  const packetFreezeTs = text(field(row, index, "Freeze_TS"));
  const missingDirection = direction === "NONE";
  const missingLine = lineSelection.line === null;
  const evidenceStatus = missingLine
    ? "UNGRADABLE_MISSING_LITERAL_LINE"
    : missingDirection
      ? "UNGRADABLE_NO_AUTHORITATIVE_FORCED_DIRECTION"
      : packetStatus;
  const notes = [
    lineSelection.status === "MISSING_EXECUTABLE_LINE_REFERENCE_NOT_SUBSTITUTED"
      ? "A literal reference line exists but is not substituted for missing executable Hard Rock evidence; settlement remains UNGRADABLE."
      : "",
    missingDirection ? "Existing Module 11 direction rule has no preference at an exact projection/line tie; no tie-break was invented." : "",
    "Research-only; no projection, vehicle, stake, BET/PASS, NO_CALL, or authorization consumer.",
  ].filter(Boolean).join(" ");

  return {
    date, game_id: gameId,
    away_team: text(field(row, index, "Away_Team")),
    home_team: text(field(row, index, "Home_Team")),
    scheduled_first_pitch: firstPitch,
    packet_snapshot_ts: packetSnapshotTs,
    packet_freeze_ts: packetFreezeTs,
    confirmation_ready: confirmationReady,
    operational_decision: operationalDecision,
    operational_final_decision: finalDecision,
    operational_blocker: text(field(row, index, "Final_Blocker")),
    direction,
    direction_source: lineSelection.line === null
      ? "PREGAME_PACKET_HISTORY.DIRECTION_UPSTREAM_AUDIT_ONLY"
      : "MODULE_11_DIRECTION_RULE_APPLIED_TO_LITERAL_EXECUTABLE_LINE",
    confidence: numeric(field(row, index, "Confidence")),
    line: lineSelection.line,
    line_source: lineSelection.source,
    line_status: lineSelection.status,
    frozen_ts: "",
    record_status: evidenceStatus,
    notes,
    frozen_total: frozenTotal,
    frozen_variance: lineSelection.line === null || frozenTotal === null ? null : frozenTotal - lineSelection.line,
    starter_bullpen_reliance_state: text(field(row, index, "Starter_Bullpen_Reliance_State")),
    distribution_structure_status: text(field(row, index, "Distribution_Structure_Status")),
    distribution_risk_tags: text(field(row, index, "Distribution_Risk_Tags")),
    actual_total: null,
    result: "",
    settlement_ts: "",
    integrity_status: "PASS",
  };
}

function recordToRow(record: ShadowTruthRecord): unknown[] {
  return [
    record.date, record.game_id, record.away_team, record.home_team, record.scheduled_first_pitch,
    record.packet_snapshot_ts, record.packet_freeze_ts, record.confirmation_ready ? "TRUE" : "FALSE",
    record.operational_decision, record.operational_final_decision, record.operational_blocker,
    record.direction === "NONE" ? "" : record.direction, record.direction_source,
    record.confidence ?? "", record.line ?? "", record.line_source, record.line_status,
    record.frozen_ts, record.record_status, record.notes, record.frozen_total ?? "",
    record.frozen_variance ?? "", record.starter_bullpen_reliance_state,
    record.distribution_structure_status, record.distribution_risk_tags,
    record.actual_total ?? "", record.result, record.settlement_ts, "RESEARCH_ONLY",
    record.integrity_status, SHADOW_TRUTH_DIRECTION_VERSION,
  ];
}

function rowToRecord(row: unknown[], index: Map<string, number>): ShadowTruthRecord | null {
  const date = canonicalDate(field(row, index, "Date"));
  const gameId = text(field(row, index, "Game_ID"));
  if (!date || !gameId) return null;
  return {
    date, game_id: gameId, away_team: text(field(row, index, "Away_Team")), home_team: text(field(row, index, "Home_Team")),
    scheduled_first_pitch: text(field(row, index, "Scheduled_First_Pitch")),
    packet_snapshot_ts: text(field(row, index, "Packet_Snapshot_TS")), packet_freeze_ts: text(field(row, index, "Packet_Freeze_TS")),
    confirmation_ready: text(field(row, index, "Confirmation_Ready")) === "TRUE",
    operational_decision: resolveOperationalDecision(field(row, index, "Operational_Decision"), ""),
    operational_final_decision: text(field(row, index, "Operational_Final_Decision")),
    operational_blocker: text(field(row, index, "Operational_Blocker")),
    direction: normalizeDirection(field(row, index, "Shadow_Truth_Direction")),
    direction_source: text(field(row, index, "Shadow_Truth_Source")), confidence: numeric(field(row, index, "Shadow_Truth_Confidence")),
    line: numeric(field(row, index, "Shadow_Truth_Line")), line_source: text(field(row, index, "Shadow_Truth_Line_Source")),
    line_status: text(field(row, index, "Shadow_Truth_Line_Status")), frozen_ts: text(field(row, index, "Shadow_Truth_Frozen_TS")),
    record_status: text(field(row, index, "Shadow_Truth_Record_Status")), notes: text(field(row, index, "Shadow_Truth_Notes")),
    frozen_total: numeric(field(row, index, "Frozen_Price_Blind_Total")), frozen_variance: numeric(field(row, index, "Frozen_Variance")),
    starter_bullpen_reliance_state: text(field(row, index, "Starter_Bullpen_Reliance_State")),
    distribution_structure_status: text(field(row, index, "Distribution_Structure_Status")),
    distribution_risk_tags: text(field(row, index, "Distribution_Risk_Tags")), actual_total: numeric(field(row, index, "Actual_Total")),
    result: text(field(row, index, "Shadow_Truth_Result")) as ShadowTruthResult,
    settlement_ts: text(field(row, index, "Settlement_TS")), integrity_status: text(field(row, index, "Record_Integrity_Status")),
  };
}

export function mergeProspectiveRecords(
  existing: ShadowTruthRecord[],
  candidates: ShadowTruthRecord[],
): { records: ShadowTruthRecord[]; written: number; updated: number; preserved: number } {
  const byKey = new Map<string, ShadowTruthRecord>();
  for (const record of existing) {
    const key = `${record.date}|${record.game_id}`;
    if (byKey.has(key)) throw new Error(`DUPLICATE_SHADOW_TRUTH_RECORD: ${key}`);
    byKey.set(key, record);
  }
  const candidateKeys = new Set<string>();
  let written = 0;
  let updated = 0;
  let preserved = 0;
  for (const candidate of candidates) {
    const key = `${candidate.date}|${candidate.game_id}`;
    if (candidateKeys.has(key)) throw new Error(`DUPLICATE_SHADOW_TRUTH_CANDIDATE: ${key}`);
    candidateKeys.add(key);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, candidate);
      written++;
      continue;
    }
    if (current.frozen_ts || current.result || current.record_status === "FROZEN_PREGAME") {
      preserved++;
      continue;
    }
    byKey.set(key, candidate);
    updated++;
  }
  return { records: [...byKey.values()].sort((a, b) => `${a.date}|${a.game_id}`.localeCompare(`${b.date}|${b.game_id}`)), written, updated, preserved };
}

export function settleRecords(
  existing: ShadowTruthRecord[],
  packetRows: unknown[][],
  outcomes: SettlementRow[],
  date: string,
): { records: ShadowTruthRecord[]; frozen: number; settled: number; auditGaps: number } {
  const packetHeader = packetRows[0] ?? [];
  const packetIndex = headerIndex(packetHeader);
  const packetByGame = new Map<string, unknown[]>();
  for (const row of packetRows.slice(1)) {
    if (canonicalDate(field(row, packetIndex, "Date")) !== date) continue;
    const gameId = text(field(row, packetIndex, "Game_ID"));
    if (!gameId) continue;
    if (packetByGame.has(gameId)) throw new Error(`DUPLICATE_PREGAME_PACKET_AT_SHADOW_SETTLEMENT: ${date}|${gameId}`);
    packetByGame.set(gameId, row);
  }
  const outcomeByGame = new Map<string, SettlementRow>();
  for (const outcome of outcomes) {
    if (outcome.date !== date) continue;
    if (outcomeByGame.has(outcome.game_id)) throw new Error(`DUPLICATE_SETTLEMENT_OUTCOME_AT_SHADOW_SETTLEMENT: ${date}|${outcome.game_id}`);
    outcomeByGame.set(outcome.game_id, outcome);
  }
  let frozen = 0;
  let settled = 0;
  let auditGaps = 0;
  const records = existing.map((record) => {
    if (record.date !== date) return record;
    const packet = packetByGame.get(record.game_id);
    const outcome = outcomeByGame.get(record.game_id);
    if (!outcome) return record;
    if (!packet) {
      auditGaps++;
      return { ...record, actual_total: outcome.actual_total, result: "UNGRADABLE" as const, settlement_ts: outcome.settlement_ts, integrity_status: "PACKET_NOT_FOUND_AT_SETTLEMENT" };
    }
    const packetStatus = text(field(packet, packetIndex, "Packet_Status"));
    const freezeTs = text(field(packet, packetIndex, "Freeze_TS"));
    const snapshotTs = text(field(packet, packetIndex, "Packet_Snapshot_TS"));
    if (packetStatus !== "FROZEN_PREGAME" || !freezeTs || snapshotTs !== record.packet_snapshot_ts) {
      auditGaps++;
      return { ...record, actual_total: outcome.actual_total, result: "UNGRADABLE" as const, settlement_ts: outcome.settlement_ts, integrity_status: "FROZEN_PACKET_LINEAGE_MISMATCH" };
    }
    const wasFrozen = Boolean(record.frozen_ts);
    const result = gradeShadowTruth(record.direction, record.line, outcome.actual_total);
    if (!wasFrozen) frozen++;
    settled++;
    return {
      ...record, packet_freeze_ts: freezeTs, frozen_ts: freezeTs,
      record_status: "FROZEN_PREGAME", actual_total: outcome.actual_total,
      result, settlement_ts: outcome.settlement_ts, integrity_status: "PASS",
    };
  });
  for (const outcome of outcomes) {
    if (outcome.date !== date) continue;
    if (!existing.some((record) => record.date === date && record.game_id === outcome.game_id)) auditGaps++;
  }
  return { records, frozen, settled, auditGaps };
}

function summaryRow(date: string, dimension: string, cohort: string, records: ShadowTruthRecord[], timestamp: string): unknown[] {
  const ready = records.filter((record) => record.confirmation_ready);
  const frozen = ready.filter((record) => record.frozen_ts && (record.direction === "OVER" || record.direction === "UNDER"));
  const correct = frozen.filter((record) => record.result === "CORRECT").length;
  const incorrect = frozen.filter((record) => record.result === "INCORRECT").length;
  const push = frozen.filter((record) => record.result === "PUSH").length;
  const ungradable = ready.filter((record) => record.result === "UNGRADABLE" || !record.frozen_ts || record.direction === "NONE").length;
  const eligible = correct + incorrect;
  return [
    date, dimension, cohort, ready.length, frozen.length, correct, incorrect, push, ungradable,
    eligible, eligible ? correct / eligible : "", "RESEARCH_ONLY",
    "Shadow truth never authorizes a wager or changes BET/PASS/NO_CALL. PUSH and UNGRADABLE are excluded from directional accuracy.",
    timestamp,
  ];
}

export function buildSummaryRows(records: ShadowTruthRecord[], timestamp: string): unknown[][] {
  const settledDates = [...new Set(records.filter((record) => record.settlement_ts).map((record) => record.date))].sort();
  const rows: unknown[][] = [];
  for (const date of settledDates) {
    const dateRecords = records.filter((record) => record.date === date);
    rows.push(summaryRow(date, "OVERALL", "ALL_CONFIRMATION_READY", dateRecords, timestamp));
    for (const cohort of ["BET", "PASS", "NO_CALL", "PENDING"] as const) {
      rows.push(summaryRow(date, "OPERATIONAL_DECISION", cohort, dateRecords.filter((record) => record.operational_decision === cohort), timestamp));
    }
    for (const cohort of [...new Set(dateRecords.map((record) => record.distribution_structure_status).filter(Boolean))].sort()) {
      rows.push(summaryRow(date, "DISTRIBUTION_STRUCTURE", cohort, dateRecords.filter((record) => record.distribution_structure_status === cohort), timestamp));
    }
    for (const cohort of [...new Set(dateRecords.map((record) => record.starter_bullpen_reliance_state).filter(Boolean))].sort()) {
      rows.push(summaryRow(date, "STARTER_BULLPEN_RELIANCE", cohort, dateRecords.filter((record) => record.starter_bullpen_reliance_state === cohort), timestamp));
    }
  }
  return rows;
}

function columnLabel(columnCount: number): string {
  let value = columnCount;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

async function ensureSheets(workbookId: string): Promise<void> {
  const specs = [
    [SHADOW_TRUTH_DIRECTION_SHEET, SHADOW_TRUTH_DIRECTION_HEADERS.length],
    [SHADOW_TRUTH_SUMMARY_SHEET, SHADOW_TRUTH_SUMMARY_HEADERS.length],
  ] as const;
  const existing = new Set((await getSpreadsheetSheetProperties(workbookId)).map((sheet) => sheet.title));
  for (const [sheet] of specs) if (!existing.has(sheet)) await addSheet(workbookId, sheet);
  await Promise.all(specs.map(([sheet, columns]) => expandSheetColumns(workbookId, sheet, columns)));
}

async function readLedger(workbookId: string): Promise<ShadowTruthRecord[]> {
  try {
    const values = ((await readRange(workbookId, `${SHADOW_TRUTH_DIRECTION_SHEET}!A1:${columnLabel(SHADOW_TRUTH_DIRECTION_HEADERS.length)}5000`)).values ?? []) as unknown[][];
    const index = headerIndex(values[0] ?? []);
    return values.slice(1).flatMap((row) => {
      const record = rowToRecord(row, index);
      return record ? [record] : [];
    });
  } catch (error: unknown) {
    if (/unable to parse range|not found/i.test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  }
}

async function readLadder(workbookId: string): Promise<Map<string, { truth: string; execution: string }>> {
  try {
    const values = ((await readRange(workbookId, "FULL_LADDER_AUDIT!A1:Z5000")).values ?? []) as unknown[][];
    const index = headerIndex(values[0] ?? []);
    return new Map(values.slice(1).map((row) => [
      `${canonicalDate(field(row, index, "Date"))}|${text(field(row, index, "Game_ID"))}`,
      { truth: text(field(row, index, "Directional_Truth")), execution: text(field(row, index, "BET_or_PASS")) },
    ]));
  } catch (error: unknown) {
    if (/unable to parse range|not found/i.test(error instanceof Error ? error.message : String(error))) return new Map();
    throw error;
  }
}

async function writeResearchSheets(workbookId: string, records: ShadowTruthRecord[], timestamp: string): Promise<number> {
  await ensureSheets(workbookId);
  const summary = buildSummaryRows(records, timestamp);
  // Write the complete replacement before removing any stale tail. A transient
  // write failure therefore leaves the prior prospective ledger intact rather
  // than clearing immutable evidence first.
  await writeRange(workbookId, `${SHADOW_TRUTH_DIRECTION_SHEET}!A1`, [Array.from(SHADOW_TRUTH_DIRECTION_HEADERS), ...records.map(recordToRow)]);
  await writeRange(workbookId, `${SHADOW_TRUTH_SUMMARY_SHEET}!A1`, [Array.from(SHADOW_TRUTH_SUMMARY_HEADERS), ...summary]);
  const directionTailStart = records.length + 2;
  const summaryTailStart = summary.length + 2;
  if (directionTailStart <= 5000) {
    await clearRange(workbookId, `${SHADOW_TRUTH_DIRECTION_SHEET}!A${directionTailStart}:${columnLabel(SHADOW_TRUTH_DIRECTION_HEADERS.length)}5000`);
  }
  if (summaryTailStart <= 5000) {
    await clearRange(workbookId, `${SHADOW_TRUTH_SUMMARY_SHEET}!A${summaryTailStart}:${columnLabel(SHADOW_TRUTH_SUMMARY_HEADERS.length)}5000`);
  }
  return summary.length;
}

export async function syncShadowTruthDirectionPregame(
  date: string,
  options: { workbookId?: string; nowIso?: string } = {},
): Promise<ShadowTruthDirectionResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetValues, existing, ladder] = await Promise.all([
      readRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(5000)}`).then((response) => (response.values ?? []) as unknown[][]),
      readLedger(workbookId), readLadder(workbookId),
    ]);
    const packetIndex = headerIndex(packetValues[0] ?? []);
    const candidates = packetValues.slice(1).flatMap((row) => {
      if (canonicalDate(field(row, packetIndex, "Date")) !== date) return [];
      const gameId = text(field(row, packetIndex, "Game_ID"));
      const record = packetToRecord(row, packetIndex, nowIso, ladder.get(`${date}|${gameId}`));
      return record ? [record] : [];
    });
    const merged = mergeProspectiveRecords(existing, candidates);
    const summaryRows = await writeResearchSheets(workbookId, merged.records, nowIso);
    logger.info({ date, written: merged.written, updated: merged.updated, preserved: merged.preserved }, "MODULE_35: shadow truth pregame sync complete");
    return { status: "success", phase: "pregame", date, rows_written: merged.written, rows_updated: merged.updated, rows_frozen: 0, rows_settled: 0, rows_preserved: merged.preserved, audit_gaps: 0, summary_rows_written: summaryRows, warnings, errors };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { status: "failure", phase: "pregame", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0, rows_preserved: 0, audit_gaps: 0, summary_rows_written: 0, warnings, errors };
  }
}

export async function settleShadowTruthDirection(
  date: string,
  outcomes: SettlementRow[],
  options: { workbookId?: string } = {},
): Promise<ShadowTruthDirectionResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const timestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetValues, existing] = await Promise.all([
      readRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(5000)}`).then((response) => (response.values ?? []) as unknown[][]),
      readLedger(workbookId),
    ]);
    const settled = settleRecords(existing, packetValues, outcomes, date);
    const summaryRows = await writeResearchSheets(workbookId, settled.records, timestamp);
    logger.info({ date, frozen: settled.frozen, settled: settled.settled, audit_gaps: settled.auditGaps }, "MODULE_35: shadow truth settlement complete");
    return { status: "success", phase: "settlement", date, rows_written: 0, rows_updated: settled.settled, rows_frozen: settled.frozen, rows_settled: settled.settled, rows_preserved: existing.length - settled.settled, audit_gaps: settled.auditGaps, summary_rows_written: summaryRows, warnings, errors };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { status: "failure", phase: "settlement", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0, rows_preserved: 0, audit_gaps: 0, summary_rows_written: 0, warnings, errors };
  }
}
