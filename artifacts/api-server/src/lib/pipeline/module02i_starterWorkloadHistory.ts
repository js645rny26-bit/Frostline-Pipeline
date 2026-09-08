/** Append-only derived appearance ledger for Starter Workload Estimator V1. */

import {
  addSheet,
  appendRange,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import type { SWEAppearance } from "./module02i_starterWorkloadEstimator.js";

export const SWE_APPEARANCE_HISTORY_SHEET = "SWE_APPEARANCE_HISTORY_V1";
export const SWE_APPEARANCE_HISTORY_HEADERS = [
  "Game_Date", "Game_PK", "Pitcher_MLBAM_ID", "Pitches_Thrown", "Batters_Faced",
  "Outs_Recorded", "Innings_Pitched", "Max_Through_Order", "Started_Game",
  "Pitcher_Days_Since_Prev_Game", "Outs_Status", "Data_Through_Date",
  "SWE_Version",
] as const;

function text(value: unknown): string { return String(value ?? "").trim(); }
function numeric(value: unknown): number | null {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureSheet(workbookId: string): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((sheet) => sheet.title === SWE_APPEARANCE_HISTORY_SHEET)) {
    await addSheet(workbookId, SWE_APPEARANCE_HISTORY_SHEET);
    await writeRange(workbookId, `${SWE_APPEARANCE_HISTORY_SHEET}!A1`, [Array.from(SWE_APPEARANCE_HISTORY_HEADERS)]);
  } else {
    const existing = await readRange(workbookId, `${SWE_APPEARANCE_HISTORY_SHEET}!A1:M1`);
    const header = existing.values?.[0]?.map(text) ?? [];
    if (!SWE_APPEARANCE_HISTORY_HEADERS.every((name, index) => header[index] === name)) {
      await writeRange(workbookId, `${SWE_APPEARANCE_HISTORY_SHEET}!A1`, [Array.from(SWE_APPEARANCE_HISTORY_HEADERS)]);
    }
  }
  await expandSheetColumns(workbookId, SWE_APPEARANCE_HISTORY_SHEET, SWE_APPEARANCE_HISTORY_HEADERS.length);
}

function rowKey(appearance: Pick<SWEAppearance, "game_date" | "game_pk" | "pitcher_id">): string {
  return `${appearance.game_date}|${appearance.game_pk}|${appearance.pitcher_id}`;
}

export function parseSWEAppearanceHistory(rows: unknown[][]): SWEAppearance[] {
  const [header = [], ...data] = rows;
  const index = new Map((header as unknown[]).map((name, position) => [text(name), position]));
  const value = (row: unknown[], name: string) => row[index.get(name) ?? -1];
  const appearances = new Map<string, SWEAppearance>();
  for (const row of data) {
    const gameDate = text(value(row, "Game_Date"));
    const gamePk = numeric(value(row, "Game_PK"));
    const pitcherId = numeric(value(row, "Pitcher_MLBAM_ID"));
    if (!gameDate || gamePk === null || pitcherId === null) continue;
    const appearance: SWEAppearance = {
      game_date: gameDate, game_pk: gamePk, pitcher_id: pitcherId,
      pitches_thrown: numeric(value(row, "Pitches_Thrown")) ?? 0,
      batters_faced: numeric(value(row, "Batters_Faced")) ?? 0,
      outs_recorded: numeric(value(row, "Outs_Recorded")),
      innings_pitched: numeric(value(row, "Innings_Pitched")),
      max_thruorder: numeric(value(row, "Max_Through_Order")),
      started_game: text(value(row, "Started_Game")) === "TRUE",
      pitcher_days_since_prev_game: numeric(value(row, "Pitcher_Days_Since_Prev_Game")),
      outs_status: text(value(row, "Outs_Status")) === "OUTS_UNRESOLVED" ? "OUTS_UNRESOLVED" : "AVAILABLE",
    };
    appearances.set(rowKey(appearance), appearance);
  }
  return [...appearances.values()];
}

export async function loadSWEAppearanceHistory(workbookId = WORKBOOK_ID): Promise<SWEAppearance[]> {
  try {
    const rows = (await readRange(workbookId, `${SWE_APPEARANCE_HISTORY_SHEET}!A1:M20000`)).values ?? [];
    return parseSWEAppearanceHistory(rows as unknown[][]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("400") || message.includes("Unable to parse range")) return [];
    throw error;
  }
}

/** Stores only fresh source-derived appearances; existing records are never rewritten. */
export async function persistSWEAppearanceHistory(
  incoming: readonly SWEAppearance[],
  dataThroughDate: string,
  workbookId = WORKBOOK_ID,
): Promise<{ rows_written: number; errors: string[] }> {
  const errors: string[] = [];
  try {
    await ensureSheet(workbookId);
    const existing = await loadSWEAppearanceHistory(workbookId);
    const known = new Set(existing.map(rowKey));
    const fresh = incoming.filter((appearance) => !known.has(rowKey(appearance)));
    if (fresh.length > 0) {
      await appendRange(workbookId, `${SWE_APPEARANCE_HISTORY_SHEET}!A:M`, fresh.map((appearance) => [
        appearance.game_date, appearance.game_pk, appearance.pitcher_id,
        appearance.pitches_thrown, appearance.batters_faced,
        appearance.outs_recorded ?? "", appearance.innings_pitched ?? "", appearance.max_thruorder ?? "",
        appearance.started_game ? "TRUE" : "FALSE", appearance.pitcher_days_since_prev_game ?? "",
        appearance.outs_status, dataThroughDate, "1.0.0",
      ]));
    }
    return { rows_written: fresh.length, errors };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { rows_written: 0, errors };
  }
}
