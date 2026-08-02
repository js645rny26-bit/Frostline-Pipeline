import { normalizeSheetDate } from "./module11_publicationValidation.js";

export interface LineageValidationResult {
  status: "PASS" | "FAIL";
  errors: string[];
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function dataRows(rows: unknown[][], idColumn: number): unknown[][] {
  return rows.filter((row) => text(row[idColumn]) !== "");
}

/** Validate exactly two GAME_INTEGRATION rows and one GAME_SUMMARY row per current game. */
export function validateProjectionLineage(
  date: string,
  expectedGameIds: string[],
  gameIntegrationRows: unknown[][],
  gameSummaryRows: unknown[][],
): LineageValidationResult {
  const errors: string[] = [];
  const expected = new Set(expectedGameIds);
  const giRows = dataRows(gameIntegrationRows, 1); // A=Date, B=Game_ID
  const gsRows = dataRows(gameSummaryRows, 1); // A=Date, B=Game_ID

  for (const id of expected) {
    const giCount = giRows.filter((row) => text(row[1]) === id).length;
    const gsCount = gsRows.filter((row) => text(row[1]) === id).length;
    if (giCount !== 2) errors.push(`GAME_INTEGRATION: ${id} expected 2 rows, found ${giCount}`);
    if (gsCount !== 1) errors.push(`GAME_SUMMARY: ${id} expected 1 row, found ${gsCount}`);
  }

  for (const [label, rows] of [["GAME_INTEGRATION", giRows], ["GAME_SUMMARY", gsRows]] as const) {
    for (const row of rows) {
      const id = text(row[1]);
      if (!expected.has(id)) errors.push(`${label}: unexpected Game_ID ${id}`);
      const rowDate = normalizeSheetDate(row[0]);
      if (rowDate !== date) errors.push(`${label}: ${id} has date ${rowDate || "BLANK"}, expected ${date}`);
    }
  }

  return { status: errors.length === 0 ? "PASS" : "FAIL", errors };
}

/** Validate RUN_ENVIRONMENT identity and its authoritative multiplier against Module 09. */
export function validateEnvironmentLineage(
  date: string,
  expected: Array<{ game_id: string; run_multiplier: number; home_run_factor: number }>,
  runEnvironmentRows: unknown[][],
  tolerance = 0.0001,
): LineageValidationResult {
  const errors: string[] = [];
  const rows = dataRows(runEnvironmentRows, 1); // A=Date, B=Game_ID, J=HR, K=Run
  const byId = new Map(rows.map((row) => [text(row[1]), row]));

  for (const game of expected) {
    const row = byId.get(game.game_id);
    if (!row) {
      errors.push(`RUN_ENVIRONMENT: missing Game_ID ${game.game_id}`);
      continue;
    }
    const rowDate = normalizeSheetDate(row[0]);
    if (rowDate !== date) errors.push(`RUN_ENVIRONMENT: ${game.game_id} has date ${rowDate || "BLANK"}, expected ${date}`);
    const hrFactor = Number(row[9]);
    const runMultiplier = Number(row[10]);
    if (!Number.isFinite(hrFactor) || Math.abs(hrFactor - game.home_run_factor) > tolerance) {
      errors.push(`RUN_ENVIRONMENT: ${game.game_id} HR factor mismatch sheet=${text(row[9])} module09=${game.home_run_factor}`);
    }
    if (!Number.isFinite(runMultiplier) || Math.abs(runMultiplier - game.run_multiplier) > tolerance) {
      errors.push(`RUN_ENVIRONMENT: ${game.game_id} run multiplier mismatch sheet=${text(row[10])} module09=${game.run_multiplier}`);
    }
  }

  for (const row of rows) {
    const id = text(row[1]);
    if (!expected.some((game) => game.game_id === id)) errors.push(`RUN_ENVIRONMENT: unexpected Game_ID ${id}`);
  }

  return { status: errors.length === 0 ? "PASS" : "FAIL", errors };
}
