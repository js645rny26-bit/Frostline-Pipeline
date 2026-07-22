/**
 * Module 10: SLATE_INPUT Seeding
 * Preserves operator fields for existing games; creates rows for new games.
 */

import { readRange, writeRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult } from "./module06_normalization.js";

export interface SeedResult {
  legacy_game_id: string;
  action: "created" | "updated";
  model_fields_refreshed: string[];
  operator_fields_preserved: string[];
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

function rowToObject(row: unknown[]): Record<number, unknown> {
  const obj: Record<number, unknown> = {};
  row.forEach((v, i) => { obj[i] = v; });
  return obj;
}

function buildModelDefaults() {
  return ["TBD", 0, 0, 0, "unknown", 0, 0, false, "pending"];
}

function buildOperatorDefaults(gameId: string) {
  return ["TBD", null, null, false, false, `Seeded by pipeline; awaiting vehicle selection (${gameId})`, "Pending", false, null];
}

function rowToArray(obj: Record<number, unknown>, maxIdx: number): unknown[] {
  const arr: unknown[] = [];
  for (let i = 0; i <= maxIdx; i++) {
    arr.push(obj[i] ?? null);
  }
  return arr;
}

export async function seedSlateInput(normalized: NormalizationResult, workbookId = WORKBOOK_ID): Promise<Module10Result> {
  logger.info({ games: normalized.games.length }, "MODULE_10: Seeding SLATE_INPUT");

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
    const header = existingRows[0] ?? [];
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

      if (existingByGameId.has(gameId)) {
        // EXISTING: update model fields, preserve operator fields
        const existing = existingByGameId.get(gameId)!;

        // Refresh model fields (indices 5–13)
        modelValues.forEach((v, i) => { existing[5 + i] = v; });

        // Operator fields untouched (already in the object)
        seededRows.push(rowToArray(existing, 22));
        output.games_seeded.updated_games++;
        output.seed_results.push({
          legacy_game_id: gameId,
          action: "updated",
          model_fields_refreshed: MODEL_FIELDS,
          operator_fields_preserved: OPERATOR_FIELD_INDICES.map((i) => `col_${i}`),
        });
      } else {
        // NEW: full seed with defaults
        const operatorDefaults = buildOperatorDefaults(gameId);
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

    logger.info({ new_games: output.games_seeded.new_games, updated: output.games_seeded.updated_games }, "MODULE_10: SLATE_INPUT seeding complete");
    return output;

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_10: Seeding failed");
    output.status = "failure";
    output.errors.push({ module: "10_slate_input_seeding", error: message, timestamp: new Date().toISOString() });
    return output;
  }
}
