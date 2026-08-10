/**
 * Workbook Setup — creates a brand-new Frostline Pipeline Google Sheets workbook.
 *
 * Strategy:
 *   1. POST /v4/spreadsheets — create the workbook with all sheets, column widths,
 *      frozen rows, and bold header rows in a single API call.
 *   2. batchUpdate — apply per-column number formats (repeatCell requests).
 *   3. writeRange  — populate SCHEMA_REFERENCE with the auto-generated data dictionary.
 *
 * All calls go through the Replit google-sheet connector (Sheets v4 paths only —
 * Drive v3 is not available).
 */

import {
  createSpreadsheet,
  batchUpdate,
  clearRange,
  getSpreadsheetSheetProperties,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import {
  WORKBOOK_SCHEMA,
  WORKBOOK_NAME_TEMPLATE,
  WORKBOOK_SCHEMA_VERSION,
  SECTION_COLORS,
  generateSchemaReferenceRows,
  type SheetDef,
  type ColumnDef,
} from "./workbookSchema.js";

export interface WorkbookCreateResult {
  workbook_id: string;
  workbook_name: string;
  workbook_url: string;
  sheets_created: string[];
  schema_reference_rows: number;
  errors: Array<{ step: string; error: string }>;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function rgb(r: number, g: number, b: number) {
  return { red: r, green: g, blue: b };
}

const WHITE = rgb(1, 1, 1);

// ─── Sheets API cell / column builders ───────────────────────────────────────

function headerCell(text: string, bgColor: { red: number; green: number; blue: number }) {
  return {
    userEnteredValue: { stringValue: text },
    userEnteredFormat: {
      textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 },
      backgroundColor: bgColor,
      verticalAlignment: "MIDDLE",
      horizontalAlignment: "CENTER",
      wrapStrategy: "CLIP",
    },
  };
}

function numberFormatForType(col: ColumnDef): { type: string; pattern: string } | null {
  switch (col.type) {
    case "date":
      return { type: "DATE", pattern: col.format ?? "mm/dd/yyyy" };
    case "number":
      return { type: "NUMBER", pattern: col.format ?? "0.00" };
    case "percent":
      return { type: "NUMBER", pattern: col.format ?? "0.00%" };
    case "currency":
      return { type: "CURRENCY", pattern: col.format ?? "$#,##0" };
    default:
      return null;
  }
}

// ─── Build the `sheets` array for spreadsheets.create ─────────────────────────

function buildSheetCreatePayload(sheet: SheetDef) {
  const bgColor = SECTION_COLORS[sheet.section];
  const colCount = sheet.columns.length;

  return {
    properties: {
      title: sheet.name,
      gridProperties: {
        frozenRowCount: sheet.frozenRows ?? 1,
        rowCount: 1000,
        columnCount: colCount,
      },
    },
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: [
          {
            values: sheet.columns.map((col) => headerCell(col.name, bgColor)),
          },
        ],
        columnMetadata: sheet.columns.map((col) => ({
          pixelSize: col.width ?? 120,
        })),
      },
    ],
  };
}

// ─── Build batchUpdate requests for number formats ───────────────────────────

export function buildNumberFormatRequests(
  sheetId: number,
  sheet: SheetDef,
  totalRows = 999,
): unknown[] {
  const requests: unknown[] = [];
  for (const col of sheet.columns) {
    const fmt = numberFormatForType(col);
    if (!fmt) continue;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: totalRows + 1,
          startColumnIndex: col.index,
          endColumnIndex: col.index + 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: fmt,
          },
        },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  return requests;
}

/**
 * Reapply the declared number formats to selected tabs in an existing workbook.
 * This repairs legacy formatting without recreating tabs or touching values.
 */
export async function applySchemaNumberFormats(
  workbookId: string,
  sheetNames: string[],
  totalRows = 999,
): Promise<void> {
  const requested = new Set(sheetNames);
  const schemaByName = new Map(WORKBOOK_SCHEMA.map((sheet) => [sheet.name, sheet]));
  const properties = await getSpreadsheetSheetProperties(workbookId);
  const requests: unknown[] = [];

  for (const property of properties) {
    if (!requested.has(property.title)) continue;
    const schema = schemaByName.get(property.title);
    if (!schema) throw new Error(`No workbook schema found for sheet ${property.title}`);
    requests.push(...buildNumberFormatRequests(property.sheetId, schema, totalRows));
  }

  const missing = [...requested].filter((name) => !properties.some((sheet) => sheet.title === name));
  if (missing.length > 0) throw new Error(`Workbook sheets not found for format repair: ${missing.join(", ")}`);
  if (requests.length > 0) await batchUpdate(workbookId, requests);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function createOptimizedWorkbook(dateStr?: string): Promise<WorkbookCreateResult> {
  const date = dateStr ?? new Date().toISOString().split("T")[0];
  const workbookName = WORKBOOK_NAME_TEMPLATE.replace("{DATE}", date);

  logger.info({ workbookName }, "WORKBOOK_SETUP: Creating new workbook");

  const errors: Array<{ step: string; error: string }> = [];

  // ── Step 1: Create spreadsheet with all sheets ────────────────────────────
  const sheetPayloads = WORKBOOK_SCHEMA.map(buildSheetCreatePayload);

  const created = await createSpreadsheet(workbookName, sheetPayloads);
  logger.info({ id: created.spreadsheetId, sheets: created.sheets.length }, "WORKBOOK_SETUP: Spreadsheet created");

  // Build sheetId lookup
  const sheetIdMap = new Map<string, number>();
  for (const s of created.sheets) {
    sheetIdMap.set(s.title, s.sheetId);
  }

  // ── Step 2: Apply number formats via batchUpdate ──────────────────────────
  const formatRequests: unknown[] = [];
  for (const sheet of WORKBOOK_SCHEMA) {
    const sheetId = sheetIdMap.get(sheet.name);
    if (sheetId === undefined) continue;
    formatRequests.push(...buildNumberFormatRequests(sheetId, sheet));
  }

  if (formatRequests.length > 0) {
    try {
      await batchUpdate(created.spreadsheetId, formatRequests);
      logger.info({ count: formatRequests.length }, "WORKBOOK_SETUP: Number formats applied");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "WORKBOOK_SETUP: Number format batchUpdate failed (non-fatal)");
      errors.push({ step: "number_formats", error: msg });
    }
  }

  // ── Step 3: Populate SCHEMA_REFERENCE ────────────────────────────────────
  const schemaRows = generateSchemaReferenceRows();
  let schemaRowsWritten = 0;
  try {
    await writeRange(
      created.spreadsheetId,
      "SCHEMA_REFERENCE!A2",
      schemaRows,
    );
    schemaRowsWritten = schemaRows.length;
    logger.info({ rows: schemaRowsWritten }, "WORKBOOK_SETUP: SCHEMA_REFERENCE populated");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "WORKBOOK_SETUP: SCHEMA_REFERENCE write failed (non-fatal)");
    errors.push({ step: "schema_reference", error: msg });
  }

  logger.info(
    { workbookName, id: created.spreadsheetId, errors: errors.length },
    "WORKBOOK_SETUP: Setup complete",
  );

  return {
    workbook_id: created.spreadsheetId,
    workbook_name: workbookName,
    workbook_url: created.spreadsheetUrl,
    sheets_created: created.sheets.map((s) => s.title),
    schema_reference_rows: schemaRowsWritten,
    errors,
  };
}

// ─── Repair: sync SCHEMA_REFERENCE + README to current schema definitions ─────

export interface RepairSchemaResult {
  workbook_id: string;
  schema_reference_rows: number;
  readme_rows: number;
  errors: Array<{ step: string; error: string }>;
}

/**
 * Rewrites SCHEMA_REFERENCE and README in the live workbook so they reflect
 * the current WORKBOOK_SCHEMA definitions and WORKBOOK_SCHEMA_VERSION.
 *
 * Idempotent — safe to run at any time without affecting pipeline data tabs.
 * Targets the workbook configured by WORKBOOK_ID (or the override passed in).
 */
export async function repairWorkbookSchemaReference(
  workbookId = WORKBOOK_ID,
): Promise<RepairSchemaResult> {
  logger.info({ workbookId }, "WORKBOOK_REPAIR: Rewriting SCHEMA_REFERENCE + README");

  const errors: Array<{ step: string; error: string }> = [];

  // ── Step 1: Rewrite SCHEMA_REFERENCE ─────────────────────────────────────
  let schemaRows = 0;
  try {
    await clearRange(workbookId, "SCHEMA_REFERENCE!A2:J10000");
    const rows = generateSchemaReferenceRows();
    if (rows.length > 0) {
      await writeRange(workbookId, "SCHEMA_REFERENCE!A2", rows);
    }
    schemaRows = rows.length;
    logger.info({ rows: schemaRows }, "WORKBOOK_REPAIR: SCHEMA_REFERENCE rewritten");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "WORKBOOK_REPAIR: SCHEMA_REFERENCE write failed");
    errors.push({ step: "schema_reference", error: msg });
  }

  // ── Step 2: Rewrite README with correct schema version ───────────────────
  const readmeRows: string[][] = [
    ["Schema_Version",      String(WORKBOOK_SCHEMA_VERSION)],
    ["Schema_Version_Note",
      "v1 (2026-07-20): initial workbook. "
      + "v2 (2026-07-23): totals expansion — ODDS_HISTORY, RUN_LOG Schema_Version, README. "
      + "v3 (2026-07-24): ANALYSIS sheets added (SHADOW_HISTORY/OUTCOMES, REGRESSION_REPORT, STARTER_AUDIT, VEHICLE_LOG/POSTMORTEM). "
      + "v4 (2026-07-25): SLATE_BOARD Survival_Floor column; park × weather run-addition cap. "
      + "v5 (2026-07-25): Per-game board-lock gate; SLATE_INPUT Board_Lock_Status; SLATE_BOARD Lock_Status. "
      + "v6 (2026-07-25): BOARD_LOCK_STATE sheet; per-game lock governance with operator Late_Change_Reason override. "
      + "v7 (2026-07-25): MONOTONICITY sheet; REPLAY_RESULTS Market_Line + Edge_BLEND_PARK_PITCHER cols. "
      + "v8 (2026-07-25): SURVIVAL_GATE_REPLAY sheet — retroactive survival gate analysis from module18. "
      + "v9 (2026-07-26): SURVIVAL_GATE_REPLAY cols 26–27 away/home offense source; module11 offense-source warnings. "
      + "v10 (2026-07-26): DAILY_MATCHUPS col X renamed Pipeline_Last_Updated; module02_statcast.ts renamed to module02_pitcherWorkload.ts. "
      + "v11 (2026-07-26): STATCAST_GAME_PREVIEW sheet added — per-game Baseball Savant preview ingestion (55 cols). "
      + "v12 (2026-07-26): RUN_LOG cols 30–37 — Statcast_Preview_Status/Games_Expected/Available/Parsed/Missing/Failed/Stale_Count/Identity_Mismatch_Count. "
      + "v13 (2026-07-26): STATCAST_SHADOW_AUDIT sheet (23 cols) — per-game shadow projection via pitcher xwOBA-allowed (Phase 3). Preview_Used_In_Projection = NO; no CORE impact. "
      + "v14 (2026-08-02): Shared environment identity, projection component lineage, populated PLAYER_INTEGRATION, auditable three-score bridge, and semantic current-slate publication validation. "
      + "v15 (2026-07-30): DA-1.1.0 BET/PASS doctrine migration and candidate-score ledger. "
      + "v16 (2026-08-08): Settlement pitcher-chain provenance and independent daily settlement workflow. "
      + "v17 (2026-08-09): Combined frozen-publication and pitcher-provenance outcome schema; aligned 19-column vehicle postmortems; replay provenance; frozen-published regression and projection replay. "
      + "v18 (2026-08-09): Explicit PUSH truth state in vehicle postmortem and survival replay; pushes excluded from directional and gate-performance denominators. "
      + "v19 (2026-08-09): DECISION_AUDIT_LOG required two-phase ledger; pregame model/manual/authorization evidence freezes at board lock and settlement appends independent grading without rewriting reasoning."],
    ["Workbook_Purpose",    "Frostline Pipeline — MLB totals projection and DA-1.1.0 BET/PASS decision publication."],
    ["Operator_Columns",    "Cells highlighted amber are operator-editable. All other cells are pipeline-maintained — do not edit."],
    ["Decision_Doctrine",   "Decision vocabulary is BET | PASS. CORE / NO_CORE remain historical compatibility values in legacy ledgers only."],
    ["Lock_Rules",          "Each game locks independently BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH (default 2 h) before its own first pitch. LOCKED_OUT games cannot be promoted to CORE without a named Late_Change_Reason."],
    ["Schema_Reference",    "See SCHEMA_REFERENCE tab for column-by-column definitions, types, and fill sources."],
    ["Last_Repair_TS",      new Date().toISOString()],
  ];

  let readmeRowsWritten = 0;
  try {
    await clearRange(workbookId, "README!A2:B200");
    await writeRange(workbookId, "README!A2", readmeRows);
    readmeRowsWritten = readmeRows.length;
    logger.info({ rows: readmeRowsWritten }, "WORKBOOK_REPAIR: README rewritten");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "WORKBOOK_REPAIR: README write failed");
    errors.push({ step: "readme", error: msg });
  }

  return {
    workbook_id: workbookId,
    schema_reference_rows: schemaRows,
    readme_rows: readmeRowsWritten,
    errors,
  };
}
