/**
 * Module 10: SLATE_INPUT Seeding
 * Preserves operator fields for existing games; creates rows for new games.
 * When an oddsMap is provided, new rows are seeded with market line data.
 * Existing rows with null Line/Odds are updated from the odds map (operator
 * overrides — non-null values — are always preserved).
 */

import { readRange, writeRange, clearRange, WORKBOOK_ID } from "../sheets/client.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult } from "./module06_normalization.js";
import type { MarketLine } from "./module05b_marketOdds.js";
import { normalizeFullGameTotalLine } from "./marketLineNormalization.js";

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
// F=5: Truth_Family, G=6: Truth_Score, H=7: Vehicle_Score, I=8: Stability_Score
// J=9: Composite_Score, K=10: Confirmation_Gate, L=11: Score_Decision
// M=12: Score_Blockers, N=13: Execution_Status
// O=14: Candidate_Vehicle, P=15: Line, Q=16: Odds, R=17: Market_Available
// S=18: Kill_Flag, T=19: Notes, U=20: Owner, V=21: Manual_Kill_Override, W=22: Model_Freeze_Reason
// ── Pipeline-maintained pregame lock fields (X–AB) ──────────────────────────
// X=23: Market_Phase, Y=24: Authoritative_Pregame_Total
// Z=25: Authoritative_Over_Odds, AA=26: Authoritative_Under_Odds
// AB=27: Pregame_Line_Locked_TS
const OPERATOR_FIELD_INDICES = [14, 15, 16, 17, 18, 19, 20, 21, 22]; // O–W (operator-owned)
const MODEL_FIELDS = [
  "Truth_Family", "Truth_Score", "Vehicle_Score", "Stability_Score",
  "Composite_Score", "Confirmation_Gate", "Score_Decision", "Score_Blockers", "Execution_Status",
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

// Column indices for pregame lock fields (pipeline-maintained, never operator-overwritten)
const COL_MARKET_PHASE         = 23; // X
const COL_AUTH_PREGAME_TOTAL   = 24; // Y
const COL_AUTH_OVER_ODDS       = 25; // Z
const COL_AUTH_UNDER_ODDS      = 26; // AA
const COL_LINE_LOCKED_TS       = 27; // AB

// ── Market spread / moneyline columns (pipeline-maintained, never operator-set) ──
const COL_AWAY_SPREAD      = 28; // AC: run-line point for away team (+1.5 or -1.5)
const COL_AWAY_SPREAD_ODDS = 29; // AD: American odds for away to cover the spread
const COL_HOME_SPREAD_ODDS = 30; // AE: American odds for home to cover the spread
const COL_AWAY_ML          = 31; // AF: American moneyline for away outright win
const COL_HOME_ML          = 32; // AG: American moneyline for home outright win

// ── Board-lock status (pipeline-maintained, written by module10; finalized by module11) ──
// PRE_LOCK  = board has not yet locked for this game (current time < lock cutoff)
// LOCKED_IN  = game was already CORE when the board locked; stable but still downgradable
// LOCKED_OUT = game was NOT CORE when the board locked; blocked from future promotion
const COL_BOARD_LOCK_STATUS = 33; // AH

const MAX_COL_IDX = 33; // AH

function rowToObject(row: unknown[]): Record<number, unknown> {
  const obj: Record<number, unknown> = {};
  row.forEach((v, i) => { obj[i] = v; });
  return obj;
}

function buildModelDefaults() {
  return ["PENDING", "", "", "", "", false, "PENDING", "AWAITING_MODULE_11", "pending"];
}

function buildOperatorDefaults(gameId: string, line?: MarketLine) {
  const hasLine = !!line;
  return [
    hasLine ? "GAME_TOTAL" : "TBD",            // O: Candidate_Vehicle
    hasLine ? line.total : null,               // P: Line
    hasLine ? line.over_odds : null,           // Q: Odds (over, American)
    hasLine,                                   // R: Market_Available
    false,                                     // S: Kill_Flag
    hasLine
      ? `Seeded by pipeline; line ${line.total} (${line.bookmaker})`
      : `Seeded by pipeline; awaiting vehicle selection (${gameId})`,
    "Pending",                                 // U: Owner
    false,                                     // V: Manual_Kill_Override
    null,                                      // W: Model_Freeze_Reason
    // ── Pregame lock fields (X–AB) — pipeline-maintained, never operator-overwritten ──
    "PREGAME",                                 // X: Market_Phase
    null,                                      // Y: Authoritative_Pregame_Total
    null,                                      // Z: Authoritative_Over_Odds
    null,                                      // AA: Authoritative_Under_Odds
    null,                                      // AB: Pregame_Line_Locked_TS
    // ── Market spread / moneyline (pipeline-maintained, always refreshed) ──
    hasLine ? (line.away_spread ?? null) : null,    // AC: Away_Spread
    hasLine ? (line.away_spread_odds ?? null) : null, // AD: Away_Spread_Odds
    hasLine ? (line.home_spread_odds ?? null) : null, // AE: Home_Spread_Odds
    hasLine ? (line.away_ml ?? null) : null,          // AF: Away_ML
    hasLine ? (line.home_ml ?? null) : null,          // AG: Home_ML
    // ── Board lock status (AH) — seeded PRE_LOCK; finalized to LOCKED_IN/OUT by module11 ──
    "PRE_LOCK",                                       // AH: Board_Lock_Status
  ];
}

/**
 * Determine Market_Phase from the game's MLB Stats API abstract game state.
 * abstractGameState: "Preview" | "Live" | "Final" | null
 */
function deriveMarketPhase(abstractGameState: string | null): "PREGAME" | "LIVE" | "FINAL" {
  if (abstractGameState === "Final") return "FINAL";
  if (abstractGameState === "Live")  return "LIVE";
  return "PREGAME";
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

/**
 * Market representation sanitation for an OPEN full-game total only. Once a
 * game is LIVE/FINAL its stored line is historical pregame evidence and must
 * remain untouched; Module 11 will still fail closed on an invalid value.
 */
function normalizeOpenMarketCell(
  row: Record<number, unknown>,
  column: number,
  gameId: string,
  field: string,
): void {
  if (isBlank(row[column])) return;
  const normalized = normalizeFullGameTotalLine(row[column]);
  if (normalized === null) {
    logger.warn(
      { gameId, field, value: row[column] },
      "MODULE_10: Unsupported non-half full-game total retained for operator review",
    );
    return;
  }
  if (Number(row[column]) !== normalized) {
    logger.info(
      { gameId, field, sourceLine: row[column], executableLine: normalized },
      "MODULE_10: Whole-number total normalized to executable half-number line",
    );
    row[column] = normalized;
  }
}

export async function seedSlateInput(
  normalized: NormalizationResult,
  workbookId = WORKBOOK_ID,
  oddsMap: Map<string, MarketLine> = new Map(),
  protection?: PublicationProtection,
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

  // ── SLATE_INPUT column headers (written every publish to stay in sync) ──────
  const SLATE_INPUT_HEADERS = [
    "Game_ID", "Date", "Matchup", "Target", "Opposing_Starter",
    "Truth_Family", "Truth_Score", "Vehicle_Score", "Stability_Score",
    "Composite_Score", "Confirmation_Gate", "Score_Decision", "Score_Blockers", "Execution_Status",
    "Candidate_Vehicle", "Line", "Odds", "Market_Available",
    "Kill_Flag", "Notes", "Owner", "Manual_Kill_Override", "Model_Freeze_Reason",
    "Market_Phase", "Authoritative_Pregame_Total", "Authoritative_Over_Odds",
    "Authoritative_Under_Odds", "Pregame_Line_Locked_TS",
    "Away_Spread", "Away_Spread_Odds", "Home_Spread_Odds", "Away_ML", "Home_ML",
    "Board_Lock_Status",
  ];
  await writeRange(workbookId, "SLATE_INPUT!A1:AH1", [SLATE_INPUT_HEADERS]).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_10: Could not write SLATE_INPUT headers — continuing");
  });

  try {
    // Read existing SLATE_INPUT data rows — A:AH covers all 34 cols
    const existing = await readRange(workbookId, "SLATE_INPUT!A:AH");
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
        const phase = deriveMarketPhase(game.game_status.abstractGameState);
        const alreadyFrozen = !isBlank(row[COL_LINE_LOCKED_TS]);

        // Refresh model fields (indices 5–13)
        modelValues.forEach((v, i) => { row[5 + i] = v; });

        // Frostline represents executable full-game totals exclusively on
        // Hard Rock half numbers. This prospective-only sanitation keeps a
        // whole-number source/manual entry from reaching the board unchanged.
        if (phase === "PREGAME" && !alreadyFrozen) {
          normalizeOpenMarketCell(row, COL_LINE, gameId, "Line");
          normalizeOpenMarketCell(
            row,
            COL_AUTH_PREGAME_TOTAL,
            gameId,
            "Authoritative_Pregame_Total",
          );
        }

        // Back-fill Line/Odds from odds map only if currently blank
        // (preserves anything the operator typed manually)
        let linePopulated = false;
        if (marketLine && isBlank(row[COL_LINE])) {
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

        // ── Pregame lock logic (pipeline-maintained, X–AB) ─────────────────
        row[COL_MARKET_PHASE] = phase;

        if (phase === "PREGAME" && !alreadyFrozen) {
          // During PREGAME, keep Auth fields as a rolling snapshot of the latest
          // known market line so that the value is correct at the moment of freeze.
          // COL_LINE_LOCKED_TS stays null — its presence is what marks a freeze.
          if (marketLine) {
            row[COL_AUTH_PREGAME_TOTAL] = marketLine.total;
            row[COL_AUTH_OVER_ODDS]     = marketLine.over_odds;
            row[COL_AUTH_UNDER_ODDS]    = -110; // mlbstartingnine doesn't publish under odds separately
          } else if (!isBlank(row[COL_LINE])) {
            // Operator-set or previously back-filled line: use as best-available snapshot
            row[COL_AUTH_PREGAME_TOTAL] = row[COL_LINE];
            row[COL_AUTH_OVER_ODDS]     = isBlank(row[COL_ODDS]) ? -110 : row[COL_ODDS];
            row[COL_AUTH_UNDER_ODDS]    = -110;
          }
        }

        if ((phase === "LIVE" || phase === "FINAL") && !alreadyFrozen) {
          // First LIVE/FINAL publish: stamp the freeze timestamp.
          // Auth total was continuously updated during PREGAME, so it already
          // holds the last pregame line. Only fall back to COL_LINE if somehow
          // no PREGAME publish ever ran for this game (edge case).
          if (isBlank(row[COL_AUTH_PREGAME_TOTAL])) {
            const fallback = row[COL_LINE];
            if (!isBlank(fallback)) {
              row[COL_AUTH_PREGAME_TOTAL] = fallback;
              row[COL_AUTH_OVER_ODDS]     = isBlank(row[COL_ODDS]) ? -110 : row[COL_ODDS];
              row[COL_AUTH_UNDER_ODDS]    = -110;
              logger.warn(
                { gameId, phase, line: fallback },
                "MODULE_10: Auth total sourced from COL_LINE at freeze (no prior PREGAME publish)",
              );
            }
          }
          row[COL_LINE_LOCKED_TS] = new Date().toISOString();
          logger.info(
            { gameId, phase, line: row[COL_AUTH_PREGAME_TOTAL] },
            "MODULE_10: Pregame line frozen",
          );
        }

        // Always refresh market spread/ML — pipeline-managed, never set by operator
        if (marketLine) {
          row[COL_AWAY_SPREAD]      = marketLine.away_spread ?? null;
          row[COL_AWAY_SPREAD_ODDS] = marketLine.away_spread_odds ?? null;
          row[COL_HOME_SPREAD_ODDS] = marketLine.home_spread_odds ?? null;
          row[COL_AWAY_ML]          = marketLine.away_ml ?? null;
          row[COL_HOME_ML]          = marketLine.home_ml ?? null;
        }

        // Board_Lock_Status (AH) — seed PRE_LOCK only when blank.
        // Module11 finalises to LOCKED_IN or LOCKED_OUT; those values must not
        // be overwritten here so the lock persists across pipeline refreshes.
        if (isBlank(row[COL_BOARD_LOCK_STATUS])) {
          row[COL_BOARD_LOCK_STATUS] = "PRE_LOCK";
        }

        seededRows.push(rowToArray(row, MAX_COL_IDX));
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
        // New rows: Market_Phase based on current game state
        const newPhase = deriveMarketPhase(game.game_status.abstractGameState);
        newRow[COL_MARKET_PHASE] = newPhase;

        // Seed Auth fields on creation — consistent with rolling-snapshot approach.
        // PREGAME: populate snapshot now so freeze is accurate when transition fires.
        // LIVE/FINAL: game appeared mid-pipeline; freeze immediately.
        if (marketLine) {
          newRow[COL_AUTH_PREGAME_TOTAL] = marketLine.total;
          newRow[COL_AUTH_OVER_ODDS]     = marketLine.over_odds;
          newRow[COL_AUTH_UNDER_ODDS]    = -110;
        } else if (!isBlank(newRow[COL_LINE])) {
          newRow[COL_AUTH_PREGAME_TOTAL] = newRow[COL_LINE];
          newRow[COL_AUTH_OVER_ODDS]     = isBlank(newRow[COL_ODDS]) ? -110 : newRow[COL_ODDS];
          newRow[COL_AUTH_UNDER_ODDS]    = -110;
        }
        if (newPhase === "LIVE" || newPhase === "FINAL") {
          newRow[COL_LINE_LOCKED_TS] = new Date().toISOString();
        }

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

    const rowsToWrite = protection && protection.protected_game_ids.size > 0
      ? mergeProtectedRows(
          dataRows, seededRows, 0, protection.protected_game_ids, protection.expected_game_ids,
        )
      : seededRows;

    // Write all rows starting at row 2 (after header)
    if (rowsToWrite.length > 0) {
      await writeRange(
        workbookId,
        `SLATE_INPUT!A2:AH${1 + rowsToWrite.length}`,
        rowsToWrite,
      );
    }

    // Clear stale rows from prior dates that are beyond the current slate.
    // Any existing row whose game_id is not in today's normalized slate was
    // left untouched above — purge those trailing rows now.
    if (dataRows.length > rowsToWrite.length) {
      const firstStaleRow = rowsToWrite.length + 2; // 1-based, after header + seeded rows
      const lastStaleRow  = dataRows.length + 1;
      await clearRange(workbookId, `SLATE_INPUT!A${firstStaleRow}:AH${lastStaleRow}`).catch(
        (err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "MODULE_10: Could not clear stale SLATE_INPUT rows — continuing",
          );
        },
      );
      logger.info(
        { cleared: dataRows.length - rowsToWrite.length },
        "MODULE_10: Cleared stale SLATE_INPUT rows from prior dates",
      );
    }

    output.rows_written = rowsToWrite.length;
    output.games_seeded.total_games = rowsToWrite.length;

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
