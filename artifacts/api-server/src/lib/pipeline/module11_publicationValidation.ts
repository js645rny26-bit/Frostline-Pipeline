/** Semantic, current-slate validation for workbook publication. */

export interface PublicationValidationInput {
  date: string;
  expected_game_ids: string[];
  expected_active_game_ids: string[];
  slate_board_rows: unknown[][];
  slate_input_rows: unknown[][];
  active_board_rows: unknown[][];
}

export interface PublicationValidationResult {
  status: "PASS" | "FAIL";
  expected_games: number;
  board_games: number;
  slate_input_games: number;
  active_games: number;
  errors: string[];
}

type PublicationReadback = Pick<
  PublicationValidationInput,
  "slate_board_rows" | "slate_input_rows" | "active_board_rows"
>;

type PublicationValidationIdentity = Pick<
  PublicationValidationInput,
  "date" | "expected_game_ids" | "expected_active_game_ids"
>;

export interface PublicationValidationRetryOptions {
  max_attempts?: number;
  initial_delay_ms?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isNumericCell(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  const rendered = text(value).replaceAll(",", "");
  if (!rendered) return false;
  // A legacy percent cell can render a valid score of 50 as "5,000.0%".
  // The format is repaired during publication, but validation must recognize
  // the numeric readback so it does not misdiagnose present values as missing.
  const normalized = rendered.endsWith("%") ? rendered.slice(0, -1) : rendered;
  return Number.isFinite(Number(normalized));
}

export function normalizeSheetDate(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }
  return raw;
}

function nonEmptyRows(rows: unknown[][], idColumn: number): unknown[][] {
  return rows.filter((row) => text(row[idColumn]) !== "");
}

function compareExactIds(label: string, expected: string[], actual: string[], errors: string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  if (duplicates.length > 0) errors.push(`${label}: duplicate Game_ID values: ${[...new Set(duplicates)].join(", ")}`);
  if (missing.length > 0) errors.push(`${label}: missing Game_ID values: ${missing.join(", ")}`);
  if (unexpected.length > 0) errors.push(`${label}: unexpected Game_ID values: ${[...new Set(unexpected)].join(", ")}`);
}

function validateDates(label: string, date: string, rows: unknown[][], dateColumn: number, errors: string[]): void {
  const stale = rows
    .map((row) => ({ id: text(row[dateColumn === 0 ? 1 : 0]), date: normalizeSheetDate(row[dateColumn]) }))
    .filter((entry) => entry.date !== date);
  if (stale.length > 0) {
    errors.push(`${label}: non-current dates: ${stale.map((entry) => `${entry.id || "UNKNOWN"}=${entry.date || "BLANK"}`).join(", ")}`);
  }
}

/**
 * Validates the actual rows read back from Sheets, not merely the arrays that
 * were intended for writing. Header rows must be removed by the caller.
 */
export function validateCurrentSlatePublication(input: PublicationValidationInput): PublicationValidationResult {
  const errors: string[] = [];
  const expectedIds = [...new Set(input.expected_game_ids)];
  if (expectedIds.length !== input.expected_game_ids.length) {
    errors.push("EXPECTED: duplicate Game_ID values in current slate");
  }

  const boardRows = nonEmptyRows(input.slate_board_rows, 1); // A=Date, B=Game_ID
  const slateRows = nonEmptyRows(input.slate_input_rows, 0); // A=Game_ID, B=Date
  const activeRows = nonEmptyRows(input.active_board_rows, 1); // A=Date, B=Game_ID

  const boardIds = boardRows.map((row) => text(row[1]));
  const slateIds = slateRows.map((row) => text(row[0]));
  const activeIds = activeRows.map((row) => text(row[1]));

  compareExactIds("SLATE_BOARD", expectedIds, boardIds, errors);
  compareExactIds("SLATE_INPUT", expectedIds, slateIds, errors);
  compareExactIds("ACTIVE_BOARD_SNAPSHOT", [...new Set(input.expected_active_game_ids)], activeIds, errors);
  validateDates("SLATE_BOARD", input.date, boardRows, 0, errors);
  validateDates("SLATE_INPUT", input.date, slateRows, 1, errors);
  validateDates("ACTIVE_BOARD_SNAPSHOT", input.date, activeRows, 0, errors);

  // SLATE_BOARD scoring columns AI:AW (indices 34-48) are mandatory for every game.
  for (const row of boardRows) {
    const id = text(row[1]);
    const scoreValues = row.slice(35, 39); // AJ:AM = Truth, Vehicle, Stability, Composite
    if (scoreValues.length < 4 || scoreValues.some((value) => !isNumericCell(value))) {
      errors.push(`SLATE_BOARD: incomplete score values for ${id}`);
    }
    if (!text(row[41])) errors.push(`SLATE_BOARD: missing Score_Decision for ${id}`); // AP
    if (!text(row[47])) errors.push(`SLATE_BOARD: missing Run_ID for ${id}`); // AV
    if (!text(row[48])) errors.push(`SLATE_BOARD: missing Model_Version for ${id}`); // AW
  }

  // SLATE_INPUT model bridge F:N must be populated by Module 11.
  for (const row of slateRows) {
    const id = text(row[0]);
    const scoreValues = row.slice(6, 10); // G:J
    if (scoreValues.length < 4 || scoreValues.some((value) => !isNumericCell(value))) {
      errors.push(`SLATE_INPUT: incomplete score bridge for ${id}`);
    }
    if (!text(row[11])) errors.push(`SLATE_INPUT: missing Score_Decision for ${id}`); // L
  }

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    expected_games: expectedIds.length,
    board_games: boardRows.length,
    slate_input_games: slateRows.length,
    active_games: activeRows.length,
    errors,
  };
}

/**
 * Sheets may briefly return the pre-write value snapshot immediately after a
 * successful values.update call. Re-read a bounded number of times and still
 * fail closed if the workbook never reaches the intended semantic state.
 */
export async function validateCurrentSlatePublicationWithRetry(
  identity: PublicationValidationIdentity,
  loadReadback: () => Promise<PublicationReadback>,
  options: PublicationValidationRetryOptions = {},
): Promise<PublicationValidationResult> {
  const maxAttempts = Math.max(1, options.max_attempts ?? 4);
  const initialDelayMs = Math.max(0, options.initial_delay_ms ?? 250);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let result: PublicationValidationResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rows = await loadReadback();
    result = validateCurrentSlatePublication({ ...identity, ...rows });
    if (result.status === "PASS" || attempt === maxAttempts) return result;
    await sleep(initialDelayMs * (2 ** (attempt - 1)));
  }

  throw new Error("Publication validation produced no result");
}
