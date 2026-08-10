/**
 * Module 20: Decision Audit Log
 *
 * Required two-phase evidence ledger:
 *   - Pregame: freezes model state while preserving operator-entered manual and
 *     authorization fields. Once the board lock fires, pregame columns are
 *     immutable.
 *   - Settlement: appends actuals and deterministic grading only. Pregame
 *     reasoning is never reconstructed or rewritten after the result is known.
 *
 * This module is observational. It does not alter projections, gates, board
 * decisions, lock state, or workbook publication targets.
 */

import {
  addSheet,
  batchUpdate,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { SECTION_COLORS, WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";
import { logger } from "../../lib/logger.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type { SlateBoardEntry } from "./module11_outputExtraction.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type { StatcastPreviewResult } from "./module02e_statcastPreview.js";
import type { SettlementRow } from "./module14_shadowSettlement.js";

export const DECISION_AUDIT_SHEET = "DECISION_AUDIT_LOG";
export const DECISION_AUDIT_COLS = 50;

export const DECISION_AUDIT_HEADER = [
  "Date", "Game_ID", "Away_Team", "Home_Team", "Scheduled_First_Pitch",
  "Run_ID", "Model_Version", "Audit_Status",
  "Frozen_Projected_Away_Runs", "Frozen_Projected_Home_Runs",
  "Frozen_Projected_Total", "Frozen_Market_Line", "Frozen_Model_Direction",
  "Frozen_Model_Vehicle", "Frozen_Model_Confidence", "Frozen_Model_Blocker",
  "Frozen_Model_TS",
  "Manual_Game_Truth", "Manual_Away_Run_View", "Manual_Home_Run_View",
  "Manual_Total_View", "Manual_Preferred_Vehicle", "Manual_Allocation_Disagreement",
  "Manual_Disagreement_Reason", "Manual_Confidence", "Statcast_Preview_Available",
  "Manual_Overlay_TS",
  "Final_Reasoning_Source", "Final_Vehicle", "Final_Decision",
  "Final_Authorization_Confidence", "Final_Blocker", "Final_Decision_Notes",
  "Final_Decision_TS",
  "Actual_Away_Runs", "Actual_Home_Runs", "Actual_Total", "Ticket_Result",
  "Settlement_TS",
  "Model_Truth_Grade", "Manual_Truth_Grade", "Model_Allocation_Error",
  "Manual_Allocation_Error", "Allocation_Winner", "Vehicle_Capture_Grade",
  "Authorization_Grade",
  "Outcome_Tag", "Failure_or_Survival_Mechanism", "One_Sentence_Lesson", "Graded_TS",
] as const;

export type DecisionAuditStatus = "OPEN" | "FROZEN" | "SETTLED";
export type FinalReasoningSource =
  | "MODEL"
  | "MANUAL"
  | "MODEL_MANUAL_AGREEMENT"
  | "MODEL_WITH_MANUAL_DOWNGRADE"
  | "MANUAL_OVERRIDE"
  | "SPLIT_DECISION"
  | "UNRESOLVED";
export type FinalAuditDecision = "CORE" | "NO CORE";
export type AllocationWinner = "MODEL" | "MANUAL" | "TIE" | "BOTH_WRONG" | "NOT_COMPARABLE";
export type AuditTicketResult = "WIN" | "LOSS" | "PUSH" | "NO_WAGER" | "PENDING";
export type AuthorizationGrade =
  | "CORRECT_AUTHORIZE"
  | "CORRECT_PASS"
  | "QUESTIONABLE_AUTHORIZE"
  | "QUESTIONABLE_PASS"
  | "NOT_GRADABLE";
export type TruthGrade = "CORRECT" | "INCORRECT" | "PUSH" | "NOT_GRADABLE";

export const FINAL_REASONING_SOURCES = [
  "MODEL", "MANUAL", "MODEL_MANUAL_AGREEMENT", "MODEL_WITH_MANUAL_DOWNGRADE",
  "MANUAL_OVERRIDE", "SPLIT_DECISION", "UNRESOLVED",
] as const satisfies readonly FinalReasoningSource[];
export const FINAL_AUDIT_DECISIONS = ["CORE", "NO CORE"] as const satisfies readonly FinalAuditDecision[];
export const ALLOCATION_WINNERS = [
  "MODEL", "MANUAL", "TIE", "BOTH_WRONG", "NOT_COMPARABLE",
] as const satisfies readonly AllocationWinner[];
export const AUDIT_TICKET_RESULTS = [
  "WIN", "LOSS", "PUSH", "NO_WAGER", "PENDING",
] as const satisfies readonly AuditTicketResult[];
export const AUTHORIZATION_GRADES = [
  "CORRECT_AUTHORIZE", "CORRECT_PASS", "QUESTIONABLE_AUTHORIZE",
  "QUESTIONABLE_PASS", "NOT_GRADABLE",
] as const satisfies readonly AuthorizationGrade[];

export const DECISION_AUDIT_INDEX = {
  DATE: 0,
  GAME_ID: 1,
  AWAY_TEAM: 2,
  HOME_TEAM: 3,
  SCHEDULED_FIRST_PITCH: 4,
  RUN_ID: 5,
  MODEL_VERSION: 6,
  AUDIT_STATUS: 7,
  FROZEN_AWAY: 8,
  FROZEN_HOME: 9,
  FROZEN_TOTAL: 10,
  FROZEN_LINE: 11,
  FROZEN_DIRECTION: 12,
  FROZEN_VEHICLE: 13,
  FROZEN_CONFIDENCE: 14,
  FROZEN_BLOCKER: 15,
  FROZEN_TS: 16,
  MANUAL_TRUTH: 17,
  MANUAL_AWAY: 18,
  MANUAL_HOME: 19,
  MANUAL_TOTAL: 20,
  MANUAL_VEHICLE: 21,
  MANUAL_ALLOCATION_DISAGREEMENT: 22,
  MANUAL_DISAGREEMENT_REASON: 23,
  MANUAL_CONFIDENCE: 24,
  STATCAST_AVAILABLE: 25,
  MANUAL_TS: 26,
  FINAL_REASONING_SOURCE: 27,
  FINAL_VEHICLE: 28,
  FINAL_DECISION: 29,
  FINAL_CONFIDENCE: 30,
  FINAL_BLOCKER: 31,
  FINAL_NOTES: 32,
  FINAL_TS: 33,
  ACTUAL_AWAY: 34,
  ACTUAL_HOME: 35,
  ACTUAL_TOTAL: 36,
  TICKET_RESULT: 37,
  SETTLEMENT_TS: 38,
  MODEL_TRUTH_GRADE: 39,
  MANUAL_TRUTH_GRADE: 40,
  MODEL_ALLOCATION_ERROR: 41,
  MANUAL_ALLOCATION_ERROR: 42,
  ALLOCATION_WINNER: 43,
  VEHICLE_CAPTURE_GRADE: 44,
  AUTHORIZATION_GRADE: 45,
  OUTCOME_TAG: 46,
  MECHANISM: 47,
  LESSON: 48,
  GRADED_TS: 49,
} as const;

export interface DecisionAuditPregameInput {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  scheduled_first_pitch: string;
  run_id: string;
  model_version: string;
  lock_status: SlateBoardEntry["lock_status"];
  projected_away_runs: number;
  projected_home_runs: number;
  projected_total: number;
  market_line: number | null;
  direction: SlateBoardEntry["direction"];
  vehicle: string;
  model_confidence: number;
  model_blocker: string;
  statcast_preview_available: string;
  model_decision: SlateBoardEntry["final_decision"];
}

export interface DecisionAuditWriteResult {
  status: "success" | "partial" | "failure";
  phase: "pregame" | "settlement";
  date: string;
  rows_written: number;
  rows_updated: number;
  rows_frozen: number;
  rows_settled: number;
  duplicates_removed: number;
  errors: string[];
}

interface RowMutationResult {
  rows: unknown[][];
  rowsWritten: number;
  rowsUpdated: number;
  rowsFrozen: number;
  rowsSettled: number;
  duplicatesRemoved: number;
}

function padRow(raw: unknown[]): unknown[] {
  const row = raw.slice(0, DECISION_AUDIT_COLS);
  while (row.length < DECISION_AUDIT_COLS) row.push("");
  return row;
}

function rowKey(date: unknown, gameId: unknown): string {
  return `${String(date ?? "")}_${String(gameId ?? "")}`;
}

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function confidenceToTen(confidence: number): number {
  const scaled = confidence <= 1 ? confidence * 10 : confidence;
  return Math.max(1, Math.min(10, Math.round(scaled)));
}

function defaultDecision(decision: SlateBoardEntry["final_decision"]): FinalAuditDecision {
  return decision === "CORE" ? "CORE" : "NO CORE";
}

function controlledValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value ?? "").trim() as T;
  return allowed.includes(text) ? text : fallback;
}

function manualDirection(value: unknown): "OVER" | "UNDER" | "NONE" {
  const text = String(value ?? "").toUpperCase();
  if (/\bOVER\b/.test(text)) return "OVER";
  if (/\bUNDER\b/.test(text)) return "UNDER";
  return "NONE";
}

export function gradeAuditTruth(
  direction: unknown,
  marketLine: number | null,
  actualTotal: number,
): TruthGrade {
  const normalized = String(direction ?? "").toUpperCase();
  if (marketLine === null || (normalized !== "OVER" && normalized !== "UNDER")) return "NOT_GRADABLE";
  if (actualTotal === marketLine) return "PUSH";
  if (normalized === "OVER") return actualTotal > marketLine ? "CORRECT" : "INCORRECT";
  return actualTotal < marketLine ? "CORRECT" : "INCORRECT";
}

function allocationError(
  projectedAway: number | null,
  projectedHome: number | null,
  actualAway: number,
  actualHome: number,
): number | null {
  if (projectedAway === null || projectedHome === null) return null;
  return round2(Math.abs(projectedAway - actualAway) + Math.abs(projectedHome - actualHome));
}

function chooseAllocationWinner(
  modelError: number | null,
  manualError: number | null,
  modelTruth: TruthGrade,
  manualTruth: TruthGrade,
): AllocationWinner {
  if (modelError === null || manualError === null) return "NOT_COMPARABLE";
  if (modelTruth === "INCORRECT" && manualTruth === "INCORRECT") return "BOTH_WRONG";
  if (modelError === manualError) return "TIE";
  return modelError < manualError ? "MODEL" : "MANUAL";
}

function ticketResult(row: unknown[], actualTotal: number): AuditTicketResult {
  const decision = controlledValue(row[DECISION_AUDIT_INDEX.FINAL_DECISION], FINAL_AUDIT_DECISIONS, "NO CORE");
  if (decision !== "CORE") return "NO_WAGER";
  const line = numberOrNull(row[DECISION_AUDIT_INDEX.FROZEN_LINE]);
  const source = controlledValue(
    row[DECISION_AUDIT_INDEX.FINAL_REASONING_SOURCE],
    FINAL_REASONING_SOURCES,
    "UNRESOLVED",
  );
  const direction = source === "MANUAL" || source === "MANUAL_OVERRIDE"
    ? manualDirection(row[DECISION_AUDIT_INDEX.MANUAL_TRUTH])
    : source === "SPLIT_DECISION" || source === "UNRESOLVED"
      ? "NONE"
      : row[DECISION_AUDIT_INDEX.FROZEN_DIRECTION];
  const truth = gradeAuditTruth(direction, line, actualTotal);
  if (truth === "PUSH") return "PUSH";
  if (truth === "CORRECT") return "WIN";
  if (truth === "INCORRECT") return "LOSS";
  return "PENDING";
}

function gradeAuthorization(row: unknown[], result: AuditTicketResult): AuthorizationGrade {
  const decision = controlledValue(row[DECISION_AUDIT_INDEX.FINAL_DECISION], FINAL_AUDIT_DECISIONS, "NO CORE");
  const source = controlledValue(
    row[DECISION_AUDIT_INDEX.FINAL_REASONING_SOURCE],
    FINAL_REASONING_SOURCES,
    "UNRESOLVED",
  );
  const blocker = String(row[DECISION_AUDIT_INDEX.FINAL_BLOCKER] ?? "").trim();
  if (result === "PUSH" || result === "PENDING") return "NOT_GRADABLE";
  if (decision === "CORE") {
    // Authorization quality is a pregame-process grade, not a ticket-result
    // alias. A valid, unblocked authorization remains valid after a loss.
    return blocker || source === "UNRESOLVED" || source === "SPLIT_DECISION"
      ? "QUESTIONABLE_AUTHORIZE"
      : "CORRECT_AUTHORIZE";
  }
  // A result alone cannot invalidate a pregame pass. A named pregame blocker is
  // the auditable evidence required to call the pass correct. QUESTIONABLE_PASS
  // is intentionally never inferred from a passed winner.
  return blocker || source === "UNRESOLVED" || source === "SPLIT_DECISION"
    ? "CORRECT_PASS"
    : "NOT_GRADABLE";
}

function vehicleCaptureGrade(decision: FinalAuditDecision, result: AuditTicketResult): string {
  if (decision === "NO CORE") return "NO_AUTHORIZED_VEHICLE";
  if (result === "WIN") return "VEHICLE_CAPTURED";
  if (result === "LOSS") return "VEHICLE_MISSED";
  if (result === "PUSH") return "VEHICLE_PUSH";
  return "NOT_GRADABLE";
}

function outcomeTag(model: TruthGrade, manual: TruthGrade, result: AuditTicketResult): string {
  if (result === "PUSH" || model === "PUSH" || manual === "PUSH") return "PUSH";
  if (model === "CORRECT" && manual === "CORRECT") return "BOTH_CORRECT";
  if (model === "INCORRECT" && manual === "INCORRECT") return "BOTH_WRONG";
  if (model === "CORRECT") return "MODEL_CORRECT";
  if (manual === "CORRECT") return "MANUAL_CORRECT";
  return "NOT_GRADABLE";
}

function diagnostic(result: AuditTicketResult, authorization: AuthorizationGrade): { mechanism: string; lesson: string } {
  if (result === "PUSH") return {
    mechanism: "MARKET_LINE_PUSH",
    lesson: "The result landed on the frozen line; the decision remains neutral rather than a failed thesis.",
  };
  if (authorization === "CORRECT_PASS") return {
    mechanism: "RECORDED_BLOCKER_PRESERVED_PASS",
    lesson: "The recorded pregame blocker governed the pass; the final score alone does not invalidate it.",
  };
  if (authorization === "CORRECT_AUTHORIZE") return {
    mechanism: "AUTHORIZED_VEHICLE_CAPTURED",
    lesson: "The authorized vehicle captured the frozen pregame direction.",
  };
  if (authorization === "QUESTIONABLE_AUTHORIZE") return {
    mechanism: "AUTHORIZED_VEHICLE_MISSED",
    lesson: "Review the pregame authorization evidence without rewriting it from the result.",
  };
  return {
    mechanism: "NOT_GRADABLE",
    lesson: "The frozen record lacks enough pregame evidence for a decision-quality grade.",
  };
}

function dedupeRows(existingRows: unknown[][]): { rows: unknown[][]; duplicatesRemoved: number } {
  const byKey = new Map<string, unknown[]>();
  const order: string[] = [];
  let duplicatesRemoved = 0;
  for (const raw of existingRows) {
    const row = padRow(raw);
    const key = rowKey(row[DECISION_AUDIT_INDEX.DATE], row[DECISION_AUDIT_INDEX.GAME_ID]);
    if (key === "_") continue;
    if (byKey.has(key)) duplicatesRemoved++;
    else order.push(key);
    byKey.set(key, row);
  }
  return { rows: order.map((key) => byKey.get(key)!), duplicatesRemoved };
}

export function upsertDecisionAuditPregameRows(
  existingRows: unknown[][],
  inputs: DecisionAuditPregameInput[],
  ts: string,
): RowMutationResult {
  const deduped = dedupeRows(existingRows);
  const rows = deduped.rows;
  const index = new Map(rows.map((row, position) => [
    rowKey(row[DECISION_AUDIT_INDEX.DATE], row[DECISION_AUDIT_INDEX.GAME_ID]), position,
  ]));
  let rowsWritten = 0;
  let rowsUpdated = 0;
  let rowsFrozen = 0;

  for (const input of inputs) {
    const key = rowKey(input.date, input.game_id);
    const position = index.get(key);
    const existing = position === undefined ? undefined : rows[position];
    const existingStatus = String(existing?.[DECISION_AUDIT_INDEX.AUDIT_STATUS] ?? "");
    if (existing && (existingStatus === "FROZEN" || existingStatus === "SETTLED")) {
      rowsFrozen++;
      continue;
    }

    const isLocked = input.lock_status !== "PRE_LOCK";
    const status: DecisionAuditStatus = isLocked ? "FROZEN" : "OPEN";
    const manual = existing ? existing.slice(17, 27) : ["", "", "", "", "", "", "", "", input.statcast_preview_available, ""];
    while (manual.length < 10) manual.push("");
    if (!String(manual[8] ?? "")) manual[8] = input.statcast_preview_available;

    const defaultFinal: unknown[] = [
      "MODEL", input.vehicle, defaultDecision(input.model_decision), confidenceToTen(input.model_confidence),
      input.model_blocker, "", ts,
    ];
    const final = existing ? existing.slice(27, 34) : defaultFinal;
    while (final.length < 7) final.push("");
    final[0] = controlledValue(final[0], FINAL_REASONING_SOURCES, "UNRESOLVED");
    final[2] = controlledValue(final[2], FINAL_AUDIT_DECISIONS, defaultDecision(input.model_decision));
    const finalConfidence = numberOrNull(final[3]);
    final[3] = finalConfidence === null ? confidenceToTen(input.model_confidence) : Math.max(1, Math.min(10, Math.round(finalConfidence)));

    const settlement = existing ? existing.slice(34, 50) : Array(16).fill("");
    while (settlement.length < 16) settlement.push("");
    const row = [
      input.date, input.game_id, input.away_team, input.home_team, input.scheduled_first_pitch,
      input.run_id, input.model_version, status,
      round2(input.projected_away_runs), round2(input.projected_home_runs), round2(input.projected_total),
      input.market_line ?? "", input.direction, input.vehicle,
      confidenceToTen(input.model_confidence), input.model_blocker, ts,
      ...manual, ...final, ...settlement,
    ].slice(0, DECISION_AUDIT_COLS);

    if (position === undefined) {
      index.set(key, rows.length);
      rows.push(row);
      rowsWritten++;
    } else {
      rows[position] = row;
      rowsUpdated++;
    }
    if (status === "FROZEN") rowsFrozen++;
  }

  return {
    rows, rowsWritten, rowsUpdated, rowsFrozen, rowsSettled: 0,
    duplicatesRemoved: deduped.duplicatesRemoved,
  };
}

export function settleDecisionAuditRows(
  existingRows: unknown[][],
  outcomes: SettlementRow[],
  ts: string,
): RowMutationResult {
  const deduped = dedupeRows(existingRows);
  const rows = deduped.rows;
  const index = new Map(rows.map((row, position) => [
    rowKey(row[DECISION_AUDIT_INDEX.DATE], row[DECISION_AUDIT_INDEX.GAME_ID]), position,
  ]));
  let rowsUpdated = 0;
  let rowsSettled = 0;

  for (const outcome of outcomes) {
    const position = index.get(rowKey(outcome.date, outcome.game_id));
    if (position === undefined) continue;
    const current = padRow(rows[position]!);
    if (String(current[DECISION_AUDIT_INDEX.GRADED_TS] ?? "").trim()) {
      rowsSettled++;
      continue;
    }

    const modelTruth = gradeAuditTruth(
      current[DECISION_AUDIT_INDEX.FROZEN_DIRECTION],
      numberOrNull(current[DECISION_AUDIT_INDEX.FROZEN_LINE]),
      outcome.actual_total,
    );
    const manualTruth = gradeAuditTruth(
      manualDirection(current[DECISION_AUDIT_INDEX.MANUAL_TRUTH]),
      numberOrNull(current[DECISION_AUDIT_INDEX.FROZEN_LINE]),
      outcome.actual_total,
    );
    const modelAllocationError = allocationError(
      numberOrNull(current[DECISION_AUDIT_INDEX.FROZEN_AWAY]),
      numberOrNull(current[DECISION_AUDIT_INDEX.FROZEN_HOME]),
      outcome.actual_away_runs,
      outcome.actual_home_runs,
    );
    const manualAllocationError = allocationError(
      numberOrNull(current[DECISION_AUDIT_INDEX.MANUAL_AWAY]),
      numberOrNull(current[DECISION_AUDIT_INDEX.MANUAL_HOME]),
      outcome.actual_away_runs,
      outcome.actual_home_runs,
    );
    const result = ticketResult(current, outcome.actual_total);
    const finalDecision = controlledValue(
      current[DECISION_AUDIT_INDEX.FINAL_DECISION],
      FINAL_AUDIT_DECISIONS,
      "NO CORE",
    );
    const authorization = gradeAuthorization(current, result);
    const diagnosis = diagnostic(result, authorization);

    current[DECISION_AUDIT_INDEX.ACTUAL_AWAY] = outcome.actual_away_runs;
    current[DECISION_AUDIT_INDEX.ACTUAL_HOME] = outcome.actual_home_runs;
    current[DECISION_AUDIT_INDEX.ACTUAL_TOTAL] = outcome.actual_total;
    current[DECISION_AUDIT_INDEX.TICKET_RESULT] = result;
    current[DECISION_AUDIT_INDEX.SETTLEMENT_TS] = outcome.settlement_ts || ts;
    current[DECISION_AUDIT_INDEX.MODEL_TRUTH_GRADE] = modelTruth;
    current[DECISION_AUDIT_INDEX.MANUAL_TRUTH_GRADE] = manualTruth;
    current[DECISION_AUDIT_INDEX.MODEL_ALLOCATION_ERROR] = modelAllocationError ?? "";
    current[DECISION_AUDIT_INDEX.MANUAL_ALLOCATION_ERROR] = manualAllocationError ?? "";
    current[DECISION_AUDIT_INDEX.ALLOCATION_WINNER] = chooseAllocationWinner(
      modelAllocationError, manualAllocationError, modelTruth, manualTruth,
    );
    current[DECISION_AUDIT_INDEX.VEHICLE_CAPTURE_GRADE] = vehicleCaptureGrade(finalDecision, result);
    current[DECISION_AUDIT_INDEX.AUTHORIZATION_GRADE] = authorization;
    current[DECISION_AUDIT_INDEX.OUTCOME_TAG] = outcomeTag(modelTruth, manualTruth, result);
    current[DECISION_AUDIT_INDEX.MECHANISM] = diagnosis.mechanism;
    current[DECISION_AUDIT_INDEX.LESSON] = diagnosis.lesson;
    current[DECISION_AUDIT_INDEX.GRADED_TS] = ts;
    rows[position] = current;
    rowsUpdated++;
    rowsSettled++;
  }

  return {
    rows, rowsWritten: 0, rowsUpdated, rowsFrozen: 0, rowsSettled,
    duplicatesRemoved: deduped.duplicatesRemoved,
  };
}

function buildPregameInputs(
  date: string,
  slateBoard: SlateBoardEntry[],
  summaries: GameSummaryRow[],
  games: NormalizedGame[],
  previews: StatcastPreviewResult,
): DecisionAuditPregameInput[] {
  const summaryByGame = new Map(summaries.map((summary) => [summary.game_id, summary]));
  const gameById = new Map(games.map((game) => [game.legacy_game_id, game]));
  const previewByGame = new Map(previews.games.map((preview) => [preview.game_id, preview.preview_availability]));
  return slateBoard.flatMap((entry) => {
    const summary = summaryByGame.get(entry.legacy_game_id);
    if (!summary) return [];
    return [{
      date,
      game_id: entry.legacy_game_id,
      away_team: entry.away_team,
      home_team: entry.home_team,
      scheduled_first_pitch: gameById.get(entry.legacy_game_id)?.scheduled_utc_time ?? "",
      run_id: entry.run_id,
      model_version: entry.model_version,
      lock_status: entry.lock_status,
      projected_away_runs: summary.projected_away_runs,
      projected_home_runs: summary.projected_home_runs,
      projected_total: entry.projected_total,
      market_line: entry.market_line,
      direction: entry.direction,
      vehicle: entry.vehicle_type,
      model_confidence: entry.confidence,
      model_blocker: entry.core_blocker,
      statcast_preview_available: previewByGame.get(entry.legacy_game_id) ?? "UNAVAILABLE",
      model_decision: entry.final_decision,
    } satisfies DecisionAuditPregameInput];
  });
}

async function ensureDecisionAuditSheet(workbookId: string): Promise<void> {
  let properties = await getSpreadsheetSheetProperties(workbookId);
  let property = properties.find((sheet) => sheet.title === DECISION_AUDIT_SHEET);
  let created = false;
  if (!property) {
    await addSheet(workbookId, DECISION_AUDIT_SHEET);
    created = true;
    properties = await getSpreadsheetSheetProperties(workbookId);
    property = properties.find((sheet) => sheet.title === DECISION_AUDIT_SHEET);
  }
  if (!property) throw new Error(`${DECISION_AUDIT_SHEET} could not be created`);
  await expandSheetColumns(workbookId, DECISION_AUDIT_SHEET, DECISION_AUDIT_COLS);

  if (created) {
    const schema = WORKBOOK_SCHEMA.find((sheet) => sheet.name === DECISION_AUDIT_SHEET);
    const widths = schema?.columns.map((column) => column.width ?? 120) ?? Array(DECISION_AUDIT_COLS).fill(120);
    const validations = [
      [DECISION_AUDIT_INDEX.AUDIT_STATUS, ["OPEN", "FROZEN", "SETTLED"]],
      [DECISION_AUDIT_INDEX.FINAL_REASONING_SOURCE, [...FINAL_REASONING_SOURCES]],
      [DECISION_AUDIT_INDEX.FINAL_DECISION, [...FINAL_AUDIT_DECISIONS]],
      [DECISION_AUDIT_INDEX.TICKET_RESULT, [...AUDIT_TICKET_RESULTS]],
      [DECISION_AUDIT_INDEX.ALLOCATION_WINNER, [...ALLOCATION_WINNERS]],
      [DECISION_AUDIT_INDEX.AUTHORIZATION_GRADE, [...AUTHORIZATION_GRADES]],
    ] as Array<[number, string[]]>;
    const analysisColor = SECTION_COLORS.ANALYSIS;
    await batchUpdate(workbookId, [
      {
        repeatCell: {
          range: { sheetId: property.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: DECISION_AUDIT_COLS },
          cell: { userEnteredFormat: { backgroundColor: analysisColor, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "CLIP" } },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
        },
      },
      {
        repeatCell: {
          range: { sheetId: property.sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 17, endColumnIndex: 34 },
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.96, blue: 0.82 } } },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: property.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      ...widths.map((pixelSize, index) => ({
        updateDimensionProperties: {
          range: { sheetId: property!.sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      })),
      ...validations.map(([columnIndex, values]) => ({
        setDataValidation: {
          range: { sheetId: property!.sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: values.map((value) => ({ userEnteredValue: value })) }, strict: true, showCustomUi: true },
        },
      })),
      ...[DECISION_AUDIT_INDEX.FROZEN_CONFIDENCE, DECISION_AUDIT_INDEX.MANUAL_CONFIDENCE, DECISION_AUDIT_INDEX.FINAL_CONFIDENCE].map((columnIndex) => ({
        setDataValidation: {
          range: { sheetId: property!.sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
          rule: { condition: { type: "NUMBER_BETWEEN", values: [{ userEnteredValue: "1" }, { userEnteredValue: "10" }] }, strict: true, showCustomUi: true },
        },
      })),
    ]);
  }
}

async function readAuditRows(workbookId: string): Promise<unknown[][]> {
  const response = await readRange(workbookId, `${DECISION_AUDIT_SHEET}!A1:AX5000`);
  return ((response.values ?? []) as unknown[][]).slice(1);
}

async function writeAuditRows(workbookId: string, rows: unknown[][], priorRowCount: number): Promise<void> {
  const blanks = Array.from(
    { length: Math.max(0, priorRowCount - rows.length) },
    () => Array(DECISION_AUDIT_COLS).fill(""),
  );
  await writeRange(workbookId, `${DECISION_AUDIT_SHEET}!A1`, [
    [...DECISION_AUDIT_HEADER],
    ...rows.map(padRow),
    ...blanks,
  ]);
}

export async function logDecisionAuditPregame(
  date: string,
  slateBoard: SlateBoardEntry[],
  summaries: GameSummaryRow[],
  games: NormalizedGame[],
  previews: StatcastPreviewResult,
  options: { workbookId?: string } = {},
): Promise<DecisionAuditWriteResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];
  try {
    await ensureDecisionAuditSheet(workbookId);
    const existing = await readAuditRows(workbookId);
    const inputs = buildPregameInputs(date, slateBoard, summaries, games, previews);
    if (inputs.length !== slateBoard.length) {
      errors.push(
        `Decision audit input mismatch: ${inputs.length}/${slateBoard.length} board games have projection summaries`,
      );
    }
    const mutation = upsertDecisionAuditPregameRows(
      existing,
      inputs,
      new Date().toISOString(),
    );
    await writeAuditRows(workbookId, mutation.rows, existing.length);
    return {
      status: errors.length === 0 ? "success" : "partial", phase: "pregame", date,
      rows_written: mutation.rowsWritten, rows_updated: mutation.rowsUpdated,
      rows_frozen: mutation.rowsFrozen, rows_settled: 0,
      duplicates_removed: mutation.duplicatesRemoved, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ date, error: message }, "MODULE_20: Decision audit pregame write failed");
    return {
      status: "failure", phase: "pregame", date,
      rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0,
      duplicates_removed: 0, errors,
    };
  }
}

export async function settleDecisionAuditLog(
  date: string,
  outcomes: SettlementRow[],
  options: { workbookId?: string } = {},
): Promise<DecisionAuditWriteResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const errors: string[] = [];
  try {
    await ensureDecisionAuditSheet(workbookId);
    const existing = await readAuditRows(workbookId);
    const mutation = settleDecisionAuditRows(existing, outcomes, new Date().toISOString());
    const expectedKeys = new Set(outcomes.map((outcome) => rowKey(outcome.date, outcome.game_id)));
    const existingKeys = new Set(existing.map((row) => rowKey(
      row[DECISION_AUDIT_INDEX.DATE],
      row[DECISION_AUDIT_INDEX.GAME_ID],
    )));
    const unmatched = [...expectedKeys].filter((key) => !existingKeys.has(key));
    if (unmatched.length > 0) {
      errors.push(`Missing frozen decision-audit rows for ${unmatched.length} settled game(s): ${unmatched.join(", ")}`);
    }
    await writeAuditRows(workbookId, mutation.rows, existing.length);
    return {
      status: errors.length === 0 ? "success" : "partial", phase: "settlement", date,
      rows_written: 0, rows_updated: mutation.rowsUpdated,
      rows_frozen: 0, rows_settled: mutation.rowsSettled,
      duplicates_removed: mutation.duplicatesRemoved, errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ date, error: message }, "MODULE_20: Decision audit settlement write failed");
    return {
      status: "failure", phase: "settlement", date,
      rows_written: 0, rows_updated: 0, rows_frozen: 0, rows_settled: 0,
      duplicates_removed: 0, errors,
    };
  }
}
