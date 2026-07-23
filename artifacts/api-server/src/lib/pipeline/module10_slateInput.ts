/**
 * Module 10: SLATE_INPUT Seeding
 * Preserves operator fields for existing games; creates rows for new games.
 * When an oddsMap is provided, new rows are seeded with market line data.
 * Existing rows with null Line/Odds are updated from the odds map (operator
 * overrides — non-null values — are always preserved).
 */

import { readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult } from "./module06_normalization.js";
import type { MarketLine } from "./module05b_marketOdds.js";

export interface SeedResult {
  legacy_game_id: string;
  action: "created" | "updated";
  model_fields_refreshed: string[];
  operator_fields_preserved: string[];
  line_populated?: boolean;
}

export interface Module10Result {
  status: "success" | "failure";
  seeding_timestamp_utc: string;
  games_seeded: {
    new_games: number;
    updated_games: number;
    total_games: number;
  };
  rows_written: number;
  seed_results: SeedResult[];
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

// SLATE_INPUT column indices (0-based)
// A=0: Game_ID, B=1: Date, C=2: Matchup, D=3: Target, E=4: Opposing_Starter
// F=5: Truth_Family, G=6: Event_Score, H=7: Run_Conversion, I=8: Early_Conversion
// J=9: Contact_Quality, K=10: Truth_Score, L=11: Vehicle_Score
// M=12: Confirmation_Gate, N=13: Execution_Status
// O=14: Candidate_Vehicle, P=15: Line, Q=16: Odds, R=17: Market_Available
// S=18: Kill_Flag, T=19: Notes, U=20: Owner, V=21: Manual_Kill_Override, W=22: Model_Freeze_Reason
const OPERATOR_FIELD_INDICES = [14, 15, 16, 17, 18, 19, 20, 21, 22]; // O–W
const MODEL_FIELDS = [
  "Truth_Family", "Event_Score", "Run_Conversion", "Early_Conversion",
  "Contact_Quality", "Truth_Score", "Vehicle_Score", "Confirmation_Gate", "Execution_Status",
];
const OPERATOR_FIELDS = [
  "Candidate_Vehicle", "Line", "Odds", "Market_Available",
  "Kill_Flag", "Notes", "Owner", "Manual_Kill_Override", "Model_Freeze_Reason",
];

// Column indices for line-related operator fields
const COL_CANDIDATE_VEHICLE = 14;
const COL_LINE             = 15;
const COL_ODDS             = 16;
const COL_MARKET_AVAILABLE = 17;

function rowToObject(row: unknown[]): Record<number, unknown> {
  const obj: Record<number, unknown> = {};
  row.forEach((v, i) => { obj[i] = v; });
  return obj;
}

function buildModelDefaults() {
  return ["TBD", 0, 0, 0, "unknown", 0, 0, false, "pending"];
}

function buildOperatorDefaults(gameId: string, line?: MarketLine) {
  const hasLine = !!line;
  return [
    hasLine ? "GAME_TOTAL" : "TBD",            // Candidate_Vehicle
    hasLine ? line.total : null,               // Line
    hasLine ? line.over_odds : null,           // Odds (over, American)
    hasLine,                                   // Market_Available
    false,                                     // Kill_Flag
    hasLine
      ? `Seeded by pipeline; line ${line.total} (${line.bookmaker})`
      : `Seeded by pipeline; awaiting vehicle selection (${gameId})`,
    "Pending",                                 // Owner
    false,                                     // Manual_Kill_Override
    null,                                      // Model_Freeze_Reason
  ];
}

function rowToArray(obj: Record<number, unknown>, maxIdx: number): unknown[] {
  const arr: unknown[] = [];
  for (let i = 0; i <= maxIdx; i++) {
    arr.push(obj[i] ?? null);
  }
  return arr;
}

/** Returns true if the cell value is absent/null/empty string */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

export async function seedSlateInput(
  normalized: NormalizationResult,
  workbookId = WORKBOOK_ID,
  oddsMap: Map<string, MarketLine> = new Map(),
): Promise<Module10Result> {
  logger.info({ games: normalized.games.length, oddsAvailable: oddsMap.size }, "MODULE_10: Seeding SLATE_INPUT");

  const output: Module10Result = {
    status: "success",
    seeding_timestamp_utc: new Date().toISOString(),
    games_seeded: { new_games: 0, updated_games: 0, total_games: 0 },
    rows_written: 0,
    seed_results: [],
    errors: [],
  };

  try {
    // Read existing SLATE_INPUT (including header)
    const existing = await readRange(workbookId, "SLATE_INPUT!A:W");
    const existingRows = existing.values ?? [];
    const dataRows = existingRows.slice(1);

    // Index by Game_ID (column A = index 0)
    const existingByGameId = new Map<string, Record<number, unknown>>();
    for (const row of dataRows) {
      const gameId = String(row[0] ?? "");
      if (gameId) existingByGameId.set(gameId, rowToObject(row));
    }

    const seededRows: unknown[][] = [];

    for (const game of normalized.games) {
      const gameId = game.legacy_game_id;
      const modelValues = buildModelDefaults();
      const marketLine = oddsMap.get(gameId);

      if (existingByGameId.has(gameId)) {
        // EXISTING: refresh model fields, preserve operator fields
        const row = existingByGameId.get(gameId)!;

        // Refresh model fields (indices 5–13)
        modelValues.forEach((v, i) => { row[5 + i] = v; });

        // Back-fill Line/Odds from odds map only if currently blank
        // (preserves anything the operator typed manually)
        let linePopulated = false;
        if (marketLine && isBlank(row[COL_LINE])) {
          // Per-cell backfill: only fill cells that are blank (or still the seeded
          // "TBD" placeholder). An operator-typed Candidate_Vehicle or Odds with the
          // Line left pending must survive the refresh. Market_Available is the one
          // pipeline-maintained flag in the operator range.
          if (isBlank(row[COL_CANDIDATE_VEHICLE]) || row[COL_CANDIDATE_VEHICLE] === "TBD") {
            row[COL_CANDIDATE_VEHICLE] = "GAME_TOTAL";
          }
          row[COL_LINE] = marketLine.total;
          if (isBlank(row[COL_ODDS])) {
            row[COL_ODDS] = marketLine.over_odds;
          }
          row[COL_MARKET_AVAILABLE] = true;
          linePopulated = true;
        }

        seededRows.push(rowToArray(row, 22));
        output.games_seeded.updated_games++;
        output.seed_results.push({
          legacy_game_id: gameId,
          action: "updated",
          model_fields_refreshed: MODEL_FIELDS,
          operator_fields_preserved: OPERATOR_FIELD_INDICES.map((i) => `col_${i}`),
          line_populated: linePopulated,
        });
      } else {
        // NEW: full seed; include odds if available
        const operatorDefaults = buildOperatorDefaults(gameId, marketLine);
        const newRow = [
          gameId,                                                          // A: Game_ID
          game.date,                                                       // B: Date
          `${game.away_team.team_abbr} @ ${game.home_team.team_abbr}`,   // C: Matchup
          "Game/Side",                                                     // D: Target
          game.home_pitcher.name ?? "",                                    // E: Opposing_Starter
          ...modelValues,                                                  // F–N: model fields
          ...operatorDefaults,                                             // O–W: operator defaults
        ];
        seededRows.push(newRow);
        output.games_seeded.new_games++;
        output.seed_results.push({
          legacy_game_id: gameId,
          action: "created",
          model_fields_refreshed: MODEL_FIELDS,
          operator_fields_preserved: OPERATOR_FIELDS,
          line_populated: !!marketLine,
        });
      }
    }

    // Write all rows starting at row 2 (after header)
    if (seededRows.length > 0) {
      await writeRange(
        workbookId,
        `SLATE_INPUT!A2:W${1 + seededRows.length}`,
        seededRows,
      );
    }

    output.rows_written = seededRows.length;
    output.games_seeded.total_games = seededRows.length;

    const linesPopulated = output.seed_results.filter((r) => r.line_populated).length;
    logger.info(
      { new_games: output.games_seeded.new_games, updated: output.games_seeded.updated_games, lines_populated: linesPopulated },
      "MODULE_10: SLATE_INPUT seeding complete",
    );
    return output;

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_10: Seeding failed");
    output.status = "failure";
    output.errors.push({ module: "10_slate_input_seeding", error: message, timestamp: new Date().toISOString() });
    return output;
  }
}
