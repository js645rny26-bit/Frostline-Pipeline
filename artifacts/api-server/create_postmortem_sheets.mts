/**
 * One-off: Create REGRESSION_REPORT, STARTER_AUDIT, VEHICLE_LOG,
 *          and VEHICLE_POSTMORTEM sheets in the live workbook.
 *
 * Idempotent — if a sheet already exists the batchUpdate error is swallowed.
 *
 * Run from artifacts/api-server/:
 *   ../frostline/node_modules/.bin/tsx create_postmortem_sheets.mts
 */

import { WORKBOOK_ID, batchUpdate, writeRange, expandSheetColumns } from "./src/lib/sheets/client.js";

const WORKBOOK_ID_LOCAL = WORKBOOK_ID;

// ── Sheet definitions ─────────────────────────────────────────────────────────

const SHEETS = [
  {
    id:     91206,
    name:   "REGRESSION_REPORT",
    color:  { red: 0.8, green: 0.4, blue: 0.0 },   // amber — alert surface
    cols:   12,
    header: [
      "Window", "N_Games",
      "MAE", "Median_AE", "Bias",
      "Over_Pct", "Under_Pct", "Miss_4Plus_Pct",
      "MAE_Alert", "Bias_Alert", "Miss_Alert",
      "Report_TS",
    ],
  },
  {
    id:     91207,
    name:   "STARTER_AUDIT",
    color:  { red: 0.2, green: 0.4, blue: 0.8 },   // slate blue — analysis
    cols:   10,
    header: [
      "Pitcher", "N_Games",
      "MAE", "Bias", "Over_Pct", "Under_Pct", "Miss_4Plus_Pct",
      "Bias_Direction",
      "First_Date", "Last_Date",
    ],
  },
  {
    id:     91208,
    name:   "VEHICLE_LOG",
    color:  { red: 0.5, green: 0.2, blue: 0.7 },   // purple — decision log
    cols:   14,
    header: [
      "Date", "Game_ID", "Away_Team", "Home_Team",
      "Vehicle_Type", "Market_Line", "Direction",
      "Projected_Total", "Variance", "Final_Decision", "Core_Blocker",
      "Edge_Strength", "Confidence", "Publish_TS",
    ],
  },
  {
    id:     91209,
    name:   "VEHICLE_POSTMORTEM",
    color:  { red: 0.7, green: 0.1, blue: 0.1 },   // red — graded outcomes
    cols:   17,
    header: [
      "Date", "Game_ID", "Away_Team", "Home_Team",
      "Vehicle_Type", "Market_Line", "Direction",
      "Projected_Total", "Actual_Total", "Error",
      "Final_Decision", "Core_Blocker",
      "Thesis_Correct", "Ticket_Result",
      "Away_Offense_Source", "Home_Offense_Source",
      "Graded_TS",
    ],
  },
];

// ── Add sheets ────────────────────────────────────────────────────────────────

const requests = SHEETS.map((s) => ({
  addSheet: {
    properties: {
      sheetId:  s.id,
      title:    s.name,
      tabColor: s.color,
    },
  },
}));

try {
  await batchUpdate(WORKBOOK_ID_LOCAL, requests);
  console.log("Sheets added.");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("already exists") || msg.includes("already had")) {
    console.log("Sheet(s) already exist — skipping addSheet.");
  } else {
    console.error("batchUpdate error:", msg);
  }
}

// ── Write headers ─────────────────────────────────────────────────────────────

for (const s of SHEETS) {
  try {
    await expandSheetColumns(WORKBOOK_ID_LOCAL, s.name, s.cols);
    const lastCol = String.fromCharCode(64 + s.cols);   // e.g. 14 → N, 17 → Q
    await writeRange(WORKBOOK_ID_LOCAL, `${s.name}!A1:${lastCol}1`, [s.header]);
    console.log(`${s.name}: header written.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${s.name} setup error:`, msg);
  }
}

console.log("Done.");
