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

import { createSpreadsheet, batchUpdate, writeRange } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import {
  WORKBOOK_SCHEMA,
  WORKBOOK_NAME_TEMPLATE,
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

function buildNumberFormatRequests(
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
