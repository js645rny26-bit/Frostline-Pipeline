/**
 * One-off: Create SHADOW_HISTORY and SHADOW_OUTCOMES sheets in the live workbook.
 * Idempotent — addSheet uses fixed sheetIds; if the sheet already exists the
 * batchUpdate will error on that sheet only, which we swallow.
 *
 * Run from artifacts/api-server/:
 *   ../frostline/node_modules/.bin/tsx create_shadow_sheets.mts
 */

import { WORKBOOK_ID, readRange, writeRange, expandSheetColumns } from "./src/lib/sheets/client.js";

const WORKBOOK_ID_LOCAL = WORKBOOK_ID;

// ── Sheet definitions ─────────────────────────────────────────────────────────

const SHEETS = [
  {
    id:     91204,
    name:   "SHADOW_HISTORY",
    color:  { red: 0.078, green: 0.533, blue: 0.533 }, // deep teal
    cols:   23,
    header: [
      "Date","Game_ID","Away_Team","Home_Team","Away_Pitcher","Home_Pitcher",
      "Repaired_Projected_Total","Legacy_Projected_Total","Delta_Repaired_Minus_Legacy",
      "Away_Offense_Source","Home_Offense_Source","Away_L30_Rate","Home_L30_Rate",
      "Away_L10_Rate","Home_L10_Rate","Away_Offense_Rate_Used","Home_Offense_Rate_Used",
      "Legacy_Multiplier","Park_Multiplier","Weather_Multiplier","Repaired_Multiplier",
      "Park_Source_Status","Snapshot_TS",
    ],
  },
  {
    id:     91205,
    name:   "SHADOW_OUTCOMES",
    color:  { red: 0.078, green: 0.533, blue: 0.533 }, // deep teal
    cols:   12,
    header: [
      "Date","Game_ID","Away_Team","Home_Team",
      "Repaired_Projected_Total","Actual_Total",
      "Error","Abs_Error",
      "Park_Source_Status","Away_Offense_Source","Home_Offense_Source",
      "Settlement_TS",
    ],
  },
];

// ── Add sheets ────────────────────────────────────────────────────────────────

const { batchUpdate } = await import("./src/lib/sheets/client.js");

const requests = SHEETS.map(s => ({
  addSheet: {
    properties: {
      sheetId: s.id,
      title:   s.name,
      tabColor: s.color,
    },
  },
}));

try {
  await batchUpdate(WORKBOOK_ID_LOCAL, requests);
  console.log("Sheets added.");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // Conflict (sheet already exists) is acceptable
  if (msg.includes("already exists") || msg.includes("already had")) {
    console.log("Sheet(s) already exist — skipping addSheet.");
  } else {
    console.error("batchUpdate error:", msg);
  }
}

// ── Ensure headers + column widths ───────────────────────────────────────────

for (const s of SHEETS) {
  try {
    await expandSheetColumns(WORKBOOK_ID_LOCAL, s.name, s.cols);
    const existing = await readRange(WORKBOOK_ID_LOCAL, `${s.name}!A1:A1`);
    const hasHeader = ((existing.values ?? []) as string[][])[0]?.[0] === s.header[0];
    if (!hasHeader) {
      await writeRange(WORKBOOK_ID_LOCAL, `${s.name}!A1:${String.fromCharCode(64 + s.cols)}1`, [s.header]);
      console.log(`${s.name}: header written.`);
    } else {
      console.log(`${s.name}: header already present.`);
    }
  } catch (err: unknown) {
    console.error(`${s.name} setup error:`, err instanceof Error ? err.message : String(err));
  }
}

console.log("Done.");
