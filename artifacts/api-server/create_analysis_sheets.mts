/**
 * One-off: create the three ANALYSIS sheets (SHADOW_VALIDATION, REPLAY_RESULTS,
 * REPLAY_METRICS) in the LIVE workbook. workbookSetup only applies to new
 * workbooks, so schema additions need a live one-off (see replit.md / memory).
 *
 * Run: ../frostline/node_modules/.bin/tsx create_analysis_sheets.mts
 */

import { batchUpdate, writeRange, WORKBOOK_ID } from "./src/lib/sheets/client.js";
import { WORKBOOK_SCHEMA, SECTION_COLORS } from "./src/lib/workbook/workbookSchema.js";

const WHITE = { red: 1, green: 1, blue: 1 };

const TARGETS: Array<[string, number]> = [
  ["SHADOW_VALIDATION", 91201],
  ["REPLAY_RESULTS", 91202],
  ["REPLAY_METRICS", 91203],
];

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function numberFormatForType(col: { type: string; format?: string }): { type: string; pattern: string } | null {
  switch (col.type) {
    case "date":     return { type: "DATE", pattern: col.format ?? "mm/dd/yyyy" };
    case "number":   return { type: "NUMBER", pattern: col.format ?? "0.00" };
    case "percent":  return { type: "NUMBER", pattern: col.format ?? "0.00%" };
    case "currency": return { type: "CURRENCY", pattern: col.format ?? "$#,##0" };
    default:         return null;
  }
}

async function main(): Promise<void> {
  for (const [name, sheetId] of TARGETS) {
    const def = WORKBOOK_SCHEMA.find((s) => s.name === name);
    if (!def) {
      console.log(`SKIP ${name}: not in WORKBOOK_SCHEMA`);
      continue;
    }
    const color = SECTION_COLORS[def.section];
    const nCols = def.columns.length;

    // 1. Create the sheet (fails if it already exists → caught and reported)
    try {
      await batchUpdate(WORKBOOK_ID, [
        {
          addSheet: {
            properties: {
              sheetId,
              title: name,
              tabColor: color,
              gridProperties: {
                frozenRowCount: def.frozenRows ?? 1,
                rowCount: 1000,
                columnCount: nCols,
              },
            },
          },
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${name}: addSheet failed (${msg.includes("already exists") ? "already exists — skipping create" : msg})`);
      if (!msg.includes("already exists")) continue;
    }

    // 2. Header row values
    await writeRange(WORKBOOK_ID, `${name}!A1:${colLetter(nCols)}1`, [
      def.columns.map((c) => c.name),
    ]);

    // 3. Header formatting, column widths, number formats
    const fmtRequests: unknown[] = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: nCols },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 },
              backgroundColor: color,
              verticalAlignment: "MIDDLE",
              horizontalAlignment: "CENTER",
              wrapStrategy: "CLIP",
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor,verticalAlignment,horizontalAlignment,wrapStrategy)",
        },
      },
      ...def.columns.map((col) => ({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: col.index, endIndex: col.index + 1 },
          properties: { pixelSize: col.width ?? 120 },
          fields: "pixelSize",
        },
      })),
    ];
    for (const col of def.columns) {
      const fmt = numberFormatForType(col);
      if (!fmt) continue;
      fmtRequests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: col.index, endColumnIndex: col.index + 1 },
          cell: { userEnteredFormat: { numberFormat: fmt } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    await batchUpdate(WORKBOOK_ID, fmtRequests);
    console.log(`OK ${name}: created with ${nCols} cols, section ${def.section}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
