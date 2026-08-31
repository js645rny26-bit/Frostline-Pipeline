/**
 * Module 20b: operator evidence and full-total-ladder history.
 *
 * This module deliberately records operator-supplied pregame facts without
 * silently teaching them to the live projection.  A source is authoritative
 * for the fields it explicitly supplies, not for every other field on the
 * game.  The packet records that distinction so settlement can separate stale
 * input from model error.
 *
 * FULL_LADDER_AUDIT is a shadow ledger for the manual, price-blind total
 * tournament.  It is never a wager ledger and cannot authorize BET/PASS.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { isAtOrAfterFirstPitch } from "./module00_temporalFirewall.js";
import {
  normalizeFullGameTotalLine,
  normalizeFullGameTotalVehicle,
  normalizeHardRockTotalLineList,
} from "./marketLineNormalization.js";
import {
  PREGAME_PACKET_HISTORY_HEADERS,
  PREGAME_PACKET_HISTORY_SHEET,
} from "./module20a_pregamePacket.js";
import type { NormalizedGame } from "./module06_normalization.js";

export const OPERATOR_EVIDENCE_OVERLAY_SHEET = "OPERATOR_EVIDENCE_OVERLAY";
export const FULL_LADDER_AUDIT_SHEET = "FULL_LADDER_AUDIT";

/**
 * One row is one explicit operator-supplied field.  This is intentionally
 * narrow: blank fields never overwrite anything and an overlay cannot imply
 * authority over adjacent fields.
 */
export const OPERATOR_EVIDENCE_OVERLAY_HEADERS = [
  "Date", "Game_ID", "Field_Name", "Field_Value", "Supplied_TS", "Source", "Evidence_Note",
] as const;

export const FULL_LADDER_AUDIT_HEADERS = [
  "Date", "Game_ID", "Run_ID", "Scheduled_First_Pitch", "Snapshot_TS", "Freeze_TS", "Ledger_Status",
  "Directional_Truth", "Run_Band_Low", "Run_Band_Center", "Run_Band_High",
  "Available_HardRock_Total_Lines", "Preferred_Total_Vehicle", "BET_or_PASS", "Named_Blocker",
  "Current_Price", "Reasoning_Source", "Operator_Evidence_Provenance", "Decision_Notes",
  "Manual_Audit_Status", "Ticket_Status", "Settlement_TS", "Selected_Vehicle_Result",
  "Ledger_Settlement_Status",
] as const;

const OVERLAY_INDEX = Object.fromEntries(
  OPERATOR_EVIDENCE_OVERLAY_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof OPERATOR_EVIDENCE_OVERLAY_HEADERS)[number], number>;
const LADDER_INDEX = Object.fromEntries(
  FULL_LADDER_AUDIT_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof FULL_LADDER_AUDIT_HEADERS)[number], number>;
const PACKET_INDEX = Object.fromEntries(
  PREGAME_PACKET_HISTORY_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof PREGAME_PACKET_HISTORY_HEADERS)[number], number>;

export const OPERATOR_OVERLAY_FIELDS = [
  "AWAY_LINEUP", "HOME_LINEUP", "AWAY_STARTER", "HOME_STARTER",
  "AWAY_STARTER_ROLE", "HOME_STARTER_ROLE", "STADIUM", "PARK_MULTIPLIER",
  "WEATHER", "ROOF_STATUS", "WIND_DISPOSITION", "ENVIRONMENT_CERTAINTY",
  "UMPIRE", "AWAY_BULLPEN_STATE", "HOME_BULLPEN_STATE", "HARD_ROCK_TOTAL_LINES",
  "CURRENT_HARD_ROCK_LINE", "CURRENT_PRICE", "DIRECTIONAL_TRUTH", "RUN_BAND_LOW",
  "RUN_BAND_CENTER", "RUN_BAND_HIGH", "PREFERRED_TOTAL_VEHICLE", "BET_OR_PASS",
  "NAMED_BLOCKER", "REASONING_SOURCE", "DECISION_NOTES",
] as const;

export type OperatorOverlayField = (typeof OPERATOR_OVERLAY_FIELDS)[number];
export type FullLadderStatus = "OPEN_PROSPECTIVE" | "FROZEN_PREGAME";

export interface OperatorEvidenceSnapshot {
  fields: Map<OperatorOverlayField, string>;
  /** Timestamp for the surviving value of each explicitly supplied field. */
  field_supplied_ts: Map<OperatorOverlayField, string>;
  source: "MANUAL_OPERATOR";
  supplied_ts: string;
  provenance: string;
  reauthorization_status: "NOT_REQUIRED" | "REAUTHORIZATION_REQUIRED";
}

export interface OperatorEvidenceLoadResult {
  snapshots: Map<string, OperatorEvidenceSnapshot>;
  warnings: string[];
}

export interface FullLadderAuditResult {
  status: "success" | "failure";
  date: string;
  rows_written: number;
  rows_updated: number;
  rows_frozen: number;
  warnings: string[];
  errors: string[];
}

function normalizeField(value: unknown): OperatorOverlayField | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/^AVAILABLE_HARDROCK_TOTAL_LINES$/, "HARD_ROCK_TOTAL_LINES")
    .replace(/^CURRENT_MARKET_LINE$/, "CURRENT_HARD_ROCK_LINE");
  return (OPERATOR_OVERLAY_FIELDS as readonly string[]).includes(normalized)
    ? normalized as OperatorOverlayField
    : null;
}

function key(date: unknown, gameId: unknown): string {
  return `${String(date ?? "").trim()}|${String(gameId ?? "").trim()}`;
}

function text(value: unknown): string { return String(value ?? "").trim(); }

function parseNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function pad(values: unknown[], length: number): unknown[] {
  const row = values.slice(0, length);
  while (row.length < length) row.push("");
  return row;
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((value, index) => [text(value), index]));
}

function valueByHeader(row: unknown[], index: Map<string, number>, name: string): unknown {
  return row[index.get(name) ?? -1];
}

function strictlyBeforeFirstPitch(suppliedTs: string, firstPitch: string): boolean {
  const suppliedMs = Date.parse(suppliedTs);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(suppliedMs) && Number.isFinite(firstPitchMs) && suppliedMs < firstPitchMs;
}

/**
 * Normalize only the explicit full-game Hard Rock fields. The source row is
 * still retained verbatim in OPERATOR_EVIDENCE_OVERLAY; this returns the
 * executable representation that downstream prospective packets may use.
 */
function normalizeOperatorMarketValue(
  field: OperatorOverlayField,
  raw: string,
): string | null {
  if (field === "CURRENT_HARD_ROCK_LINE") {
    const line = normalizeFullGameTotalLine(raw);
    return line === null ? null : line.toFixed(1);
  }
  if (field === "HARD_ROCK_TOTAL_LINES") {
    const numericTokens = raw.match(/\d+(?:\.\d+)?/g) ?? [];
    if (
      numericTokens.length === 0
      || numericTokens.some((token) => normalizeFullGameTotalLine(token) === null)
    ) return null;
    return normalizeHardRockTotalLineList(raw);
  }
  if (field === "PREFERRED_TOTAL_VEHICLE") {
    const token = raw.match(/\d+(?:\.\d+)?/);
    if (!token || normalizeFullGameTotalLine(token[0]) === null) return null;
    return normalizeFullGameTotalVehicle(raw);
  }
  return raw;
}

/**
 * Pure overlay resolver used by the runtime reader and deterministic tests.
 * Later duplicate field rows win only when they are still genuinely pregame.
 */
export function resolveOperatorEvidenceRows(
  rows: unknown[][],
  date: string,
  games: Pick<NormalizedGame, "legacy_game_id" | "scheduled_utc_time">[],
): OperatorEvidenceLoadResult {
  const warnings: string[] = [];
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const firstPitchByGame = new Map(games.map((game) => [game.legacy_game_id, game.scheduled_utc_time ?? ""]));
  const gathered = new Map<string, Array<{ field: OperatorOverlayField; value: string; suppliedTs: string; note: string }>>();

  for (const row of data) {
    if (text(valueByHeader(row, index, "Date")) !== date) continue;
    const gameId = text(valueByHeader(row, index, "Game_ID"));
    const field = normalizeField(valueByHeader(row, index, "Field_Name"));
    const rawValue = text(valueByHeader(row, index, "Field_Value"));
    const suppliedTs = text(valueByHeader(row, index, "Supplied_TS"));
    const source = text(valueByHeader(row, index, "Source"));
    const firstPitch = firstPitchByGame.get(gameId);
    if (!gameId || !field || !rawValue) continue;
    if (source && source !== "MANUAL_OPERATOR") {
      warnings.push(`OPERATOR_EVIDENCE_IGNORED_SOURCE: ${gameId}/${field} source=${source}`);
      continue;
    }
    if (!firstPitch || !strictlyBeforeFirstPitch(suppliedTs, firstPitch)) {
      warnings.push(`OPERATOR_EVIDENCE_NOT_PROSPECTIVE: ${gameId}/${field}`);
      continue;
    }
    const value = normalizeOperatorMarketValue(field, rawValue);
    if (value === null) {
      warnings.push(`OPERATOR_EVIDENCE_INVALID_HARD_ROCK_TOTAL: ${gameId}/${field}=${rawValue}`);
      continue;
    }
    const bucket = gathered.get(gameId) ?? [];
    bucket.push({ field, value, suppliedTs, note: text(valueByHeader(row, index, "Evidence_Note")) });
    gathered.set(gameId, bucket);
  }

  const snapshots = new Map<string, OperatorEvidenceSnapshot>();
  for (const [gameId, items] of gathered) {
    const ordered = [...items].sort((left, right) => Date.parse(left.suppliedTs) - Date.parse(right.suppliedTs));
    const fields = new Map<OperatorOverlayField, string>();
    const fieldSuppliedTs = new Map<OperatorOverlayField, string>();
    for (const item of ordered) {
      fields.set(item.field, item.value);
      fieldSuppliedTs.set(item.field, item.suppliedTs);
    }
    const latestTs = ordered.at(-1)?.suppliedTs ?? "";
    const provenance = ordered
      .map((item) => `${item.field}=${item.value}${item.note ? ` (${item.note})` : ""}`)
      .join("; ");
    snapshots.set(gameId, {
      fields,
      field_supplied_ts: fieldSuppliedTs,
      source: "MANUAL_OPERATOR",
      supplied_ts: latestTs,
      provenance,
      reauthorization_status: fields.size > 0 ? "REAUTHORIZATION_REQUIRED" : "NOT_REQUIRED",
    });
  }
  return { snapshots, warnings };
}

async function ensureSheet(workbookId: string, sheet: string, columns: number): Promise<void> {
  const properties = await getSpreadsheetSheetProperties(workbookId);
  if (!properties.some((item) => item.title === sheet)) await addSheet(workbookId, sheet);
  await expandSheetColumns(workbookId, sheet, columns);
}

export async function loadOperatorEvidence(
  date: string,
  games: Pick<NormalizedGame, "legacy_game_id" | "scheduled_utc_time">[],
  options: { workbookId?: string } = {},
): Promise<OperatorEvidenceLoadResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  await ensureSheet(workbookId, OPERATOR_EVIDENCE_OVERLAY_SHEET, OPERATOR_EVIDENCE_OVERLAY_HEADERS.length);
  const response = await readRange(workbookId, `${OPERATOR_EVIDENCE_OVERLAY_SHEET}!A1:G5000`);
  const rows = (response.values ?? []) as unknown[][];
  if (rows.length === 0) {
    await writeRange(workbookId, `${OPERATOR_EVIDENCE_OVERLAY_SHEET}!A1`, [Array.from(OPERATOR_EVIDENCE_OVERLAY_HEADERS)]);
    return { snapshots: new Map(), warnings: [] };
  }
  return resolveOperatorEvidenceRows(rows, date, games);
}

function packetValue(row: unknown[], name: keyof typeof PACKET_INDEX): unknown {
  return row[PACKET_INDEX[name]];
}

function parsePacketOperatorFields(packet: unknown[]): Map<OperatorOverlayField, string> {
  const raw = text(packetValue(packet, "Operator_Evidence_Fields"));
  const fields = new Map<OperatorOverlayField, string>();
  for (const entry of raw.split(";")) {
    const divider = entry.indexOf("=");
    if (divider <= 0) continue;
    const field = normalizeField(entry.slice(0, divider));
    const value = entry.slice(divider + 1).trim();
    if (field && value) fields.set(field, value);
  }
  return fields;
}

function ladderValue(fields: Map<OperatorOverlayField, string>, field: OperatorOverlayField, fallback = ""): string {
  return fields.get(field) ?? fallback;
}

function manualAuditStatus(row: unknown[]): string {
  const required = [
    LADDER_INDEX.Directional_Truth,
    LADDER_INDEX.Available_HardRock_Total_Lines,
    LADDER_INDEX.Preferred_Total_Vehicle,
    LADDER_INDEX.BET_or_PASS,
  ];
  return required.every((index) => text(row[index])) ? "MANUAL_AUDIT_RECORDED" : "MANUAL_AUDIT_PENDING";
}

function ladderKey(row: unknown[]): string {
  return key(row[LADDER_INDEX.Date], row[LADDER_INDEX.Game_ID]);
}

/**
 * Upsert one pregame ladder record per packet.  An OPEN ledger can update only
 * from the packet's pregame state.  A frozen packet promotes the stored ledger
 * without reading live operator input; postgame evidence is never involved.
 */
export function upsertFullLadderAuditRows(
  existingRows: unknown[][],
  packetRows: unknown[][],
  snapshotTs: string,
): { rows: unknown[][]; rowsWritten: number; rowsUpdated: number; rowsFrozen: number } {
  const rows = existingRows.map((row) => pad(row, FULL_LADDER_AUDIT_HEADERS.length));
  const byKey = new Map(rows.map((row, index) => [ladderKey(row), index]));
  let rowsWritten = 0;
  let rowsUpdated = 0;
  let rowsFrozen = 0;

  for (const rawPacket of packetRows) {
    const packet = pad(rawPacket, PREGAME_PACKET_HISTORY_HEADERS.length);
    const date = text(packetValue(packet, "Date"));
    const gameId = text(packetValue(packet, "Game_ID"));
    const firstPitch = text(packetValue(packet, "Scheduled_First_Pitch"));
    const packetStatus = text(packetValue(packet, "Packet_Status"));
    const packetSnapshot = text(packetValue(packet, "Packet_Snapshot_TS"));
    if (!date || !gameId || !firstPitch || !packetSnapshot) continue;
    const rowKey = key(date, gameId);
    const existingIndex = byKey.get(rowKey);
    const existing = existingIndex === undefined ? undefined : rows[existingIndex];
    if (text(existing?.[LADDER_INDEX.Ledger_Status]) === "FROZEN_PREGAME") continue;

    const fields = parsePacketOperatorFields(packet);
    const next = existing ? [...existing] : Array(FULL_LADDER_AUDIT_HEADERS.length).fill("");
    next[LADDER_INDEX.Date] = date;
    next[LADDER_INDEX.Game_ID] = gameId;
    next[LADDER_INDEX.Run_ID] = packetValue(packet, "Run_ID");
    next[LADDER_INDEX.Scheduled_First_Pitch] = firstPitch;
    next[LADDER_INDEX.Snapshot_TS] = packetSnapshot;
    next[LADDER_INDEX.Directional_Truth] = ladderValue(fields, "DIRECTIONAL_TRUTH", text(next[LADDER_INDEX.Directional_Truth]));
    next[LADDER_INDEX.Run_Band_Low] = ladderValue(fields, "RUN_BAND_LOW", text(next[LADDER_INDEX.Run_Band_Low]));
    next[LADDER_INDEX.Run_Band_Center] = ladderValue(
      fields,
      "RUN_BAND_CENTER",
      text(next[LADDER_INDEX.Run_Band_Center]) || text(packetValue(packet, "Base_Projection")),
    );
    next[LADDER_INDEX.Run_Band_High] = ladderValue(fields, "RUN_BAND_HIGH", text(next[LADDER_INDEX.Run_Band_High]));
    next[LADDER_INDEX.Available_HardRock_Total_Lines] = ladderValue(fields, "HARD_ROCK_TOTAL_LINES", text(next[LADDER_INDEX.Available_HardRock_Total_Lines]));
    next[LADDER_INDEX.Preferred_Total_Vehicle] = ladderValue(fields, "PREFERRED_TOTAL_VEHICLE", text(next[LADDER_INDEX.Preferred_Total_Vehicle]));
    next[LADDER_INDEX.BET_or_PASS] = ladderValue(fields, "BET_OR_PASS", text(next[LADDER_INDEX.BET_or_PASS]) || "PASS");
    next[LADDER_INDEX.Named_Blocker] = ladderValue(fields, "NAMED_BLOCKER", text(next[LADDER_INDEX.Named_Blocker]));
    next[LADDER_INDEX.Current_Price] = ladderValue(fields, "CURRENT_PRICE", text(next[LADDER_INDEX.Current_Price]));
    next[LADDER_INDEX.Reasoning_Source] = ladderValue(fields, "REASONING_SOURCE", text(next[LADDER_INDEX.Reasoning_Source]) || "UNRESOLVED");
    next[LADDER_INDEX.Operator_Evidence_Provenance] = text(packetValue(packet, "Operator_Evidence_Fields"));
    next[LADDER_INDEX.Decision_Notes] = ladderValue(fields, "DECISION_NOTES", text(next[LADDER_INDEX.Decision_Notes]));
    next[LADDER_INDEX.Manual_Audit_Status] = manualAuditStatus(next);
    next[LADDER_INDEX.Ticket_Status] = text(next[LADDER_INDEX.Ticket_Status]) || "NO_WAGER_REPORTED";

    if (packetStatus === "FROZEN_PREGAME") {
      next[LADDER_INDEX.Ledger_Status] = "FROZEN_PREGAME";
      next[LADDER_INDEX.Freeze_TS] = packetValue(packet, "Freeze_TS") || snapshotTs;
      rowsFrozen++;
    } else if (!isAtOrAfterFirstPitch(firstPitch, snapshotTs)) {
      next[LADDER_INDEX.Ledger_Status] = "OPEN_PROSPECTIVE";
    } else {
      // A packet may only be OPEN here if the packet lifecycle writer was not
      // invoked.  Do not create a new ladder record from it after first pitch.
      continue;
    }

    if (existingIndex === undefined) {
      rows.push(next);
      byKey.set(rowKey, rows.length - 1);
      rowsWritten++;
    } else {
      rows[existingIndex] = next;
      rowsUpdated++;
    }
  }
  return { rows, rowsWritten, rowsUpdated, rowsFrozen };
}

export async function syncFullLadderAudit(
  date: string,
  options: { workbookId?: string; snapshotTs?: string } = {},
): Promise<FullLadderAuditResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const snapshotTs = options.snapshotTs ?? new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    await ensureSheet(workbookId, FULL_LADDER_AUDIT_SHEET, FULL_LADDER_AUDIT_HEADERS.length);
    const packetResponse = await readRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1:CA5000`);
    const packetRows = ((packetResponse.values ?? []) as unknown[][]).slice(1)
      .filter((row) => text(row[PACKET_INDEX.Date]) === date);
    const existingResponse = await readRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1:X5000`);
    const existingRaw = (existingResponse.values ?? []) as unknown[][];
    const existing = existingRaw.length > 0 ? existingRaw.slice(1) : [];
    const mutation = upsertFullLadderAuditRows(existing, packetRows, snapshotTs);
    await writeRange(workbookId, `${FULL_LADDER_AUDIT_SHEET}!A1`, [
      Array.from(FULL_LADDER_AUDIT_HEADERS),
      ...mutation.rows,
    ]);
    return {
      status: "success", date, rows_written: mutation.rowsWritten, rows_updated: mutation.rowsUpdated,
      rows_frozen: mutation.rowsFrozen, warnings, errors,
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { status: "failure", date, rows_written: 0, rows_updated: 0, rows_frozen: 0, warnings, errors };
  }
}

export function operatorPacketFields(snapshot: OperatorEvidenceSnapshot | undefined): {
  status: string; fields: string; source: string; suppliedTs: string; reauthorizationStatus: string;
} {
  if (!snapshot || snapshot.fields.size === 0) {
    return { status: "NO_OPERATOR_OVERLAY", fields: "", source: "", suppliedTs: "", reauthorizationStatus: "NOT_REQUIRED" };
  }
  return {
    status: "MANUAL_OPERATOR_CAPTURED",
    fields: [...snapshot.fields.entries()].map(([field, value]) => `${field}=${value}`).join("; "),
    source: snapshot.source,
    suppliedTs: snapshot.supplied_ts,
    reauthorizationStatus: snapshot.reauthorization_status,
  };
}

/** Maps only explicit operator fields onto packet representation values. */
export function operatorField(snapshot: OperatorEvidenceSnapshot | undefined, field: OperatorOverlayField): string | undefined {
  return snapshot?.fields.get(field);
}

export function operatorNumericField(snapshot: OperatorEvidenceSnapshot | undefined, field: OperatorOverlayField): number | undefined {
  const value = operatorField(snapshot, field);
  const parsed = value === undefined ? null : parseNumber(value);
  return parsed === null ? undefined : parsed;
}
