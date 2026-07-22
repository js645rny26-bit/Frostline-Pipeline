/**
 * Module 11: Output Extraction
 * Reads SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT after recalculation.
 * Converts raw sheet values to typed JSON for API response / mobile display.
 */

import { readRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

export interface SlateBoardEntry {
  legacy_game_id: string;
  matchup: string;
  final_decision: "CORE" | "NOT_CORE" | "PENDING";
  truth_score: number;
  vehicle_score: number;
  best_vehicle_decision: string;
  not_core_reason?: string;
  confidence: "high" | "moderate" | "low";
}

export interface ActiveBoardEntry {
  date: string;
  game_id: string;
  matchup: string;
  decision: "CORE" | "NOT_CORE" | "PENDING";
  side_lean?: string;
  total_lean?: string;
  away_confidence: string;
  home_confidence: string;
}

export interface Module11Result {
  status: "success" | "failure";
  extraction_timestamp_utc: string;
  slate_board: SlateBoardEntry[];
  active_board_snapshot: ActiveBoardEntry[];
  core_count: number;
  not_core_count: number;
  error?: string;
}

// Column maps — match actual SLATE_BOARD and ACTIVE_BOARD_SNAPSHOT layouts
const SLATE_BOARD_COLS = {
  GAME_ID: 1,       // B
  MATCHUP: 2,       // C
  FINAL_DECISION: 10, // K
  TRUTH_SCORE: 15,  // P
  VEHICLE_SCORE: 16, // Q
  BEST_VEHICLE: 17, // R
  NOT_CORE_REASON: 18, // S
};

const ACTIVE_BOARD_COLS = {
  DATE: 0,           // A
  GAME_ID: 1,        // B
  MATCHUP: 2,        // C
  DECISION: 3,       // D
  SIDE_LEAN: 4,      // E
  TOTAL_LEAN: 5,     // F
  AWAY_CONFIDENCE: 6, // G
  HOME_CONFIDENCE: 7, // H
};

function determineConfidence(truthScore: number): "high" | "moderate" | "low" {
  if (truthScore >= 80) return "high";
  if (truthScore >= 65) return "moderate";
  return "low";
}

function parseNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v);
}

export async function extractOutputBoards(): Promise<Module11Result> {
  logger.info("MODULE_11: Extracting output boards");

  const output: Module11Result = {
    status: "success",
    extraction_timestamp_utc: new Date().toISOString(),
    slate_board: [],
    active_board_snapshot: [],
    core_count: 0,
    not_core_count: 0,
  };

  try {
    // Read SLATE_BOARD
    const slateBoardData = await readRange(WORKBOOK_ID, "SLATE_BOARD!A:Z");
    const slateBoardRows = (slateBoardData.values ?? []).slice(1); // skip header

    for (const row of slateBoardRows) {
      const gameId = parseStr(row[SLATE_BOARD_COLS.GAME_ID]);
      if (!gameId) continue;

      const rawDecision = parseStr(row[SLATE_BOARD_COLS.FINAL_DECISION]).toUpperCase();
      const decision: SlateBoardEntry["final_decision"] =
        rawDecision === "CORE" ? "CORE" : rawDecision === "NOT_CORE" ? "NOT_CORE" : "PENDING";

      const entry: SlateBoardEntry = {
        legacy_game_id: gameId,
        matchup: parseStr(row[SLATE_BOARD_COLS.MATCHUP]),
        final_decision: decision,
        truth_score: parseNum(row[SLATE_BOARD_COLS.TRUTH_SCORE]),
        vehicle_score: parseNum(row[SLATE_BOARD_COLS.VEHICLE_SCORE]),
        best_vehicle_decision: parseStr(row[SLATE_BOARD_COLS.BEST_VEHICLE]),
        confidence: determineConfidence(parseNum(row[SLATE_BOARD_COLS.TRUTH_SCORE])),
      };

      if (decision === "NOT_CORE") {
        entry.not_core_reason = parseStr(row[SLATE_BOARD_COLS.NOT_CORE_REASON]);
      }

      output.slate_board.push(entry);
      if (decision === "CORE") output.core_count++;
      if (decision === "NOT_CORE") output.not_core_count++;
    }

    // Read ACTIVE_BOARD_SNAPSHOT
    const activeBoardData = await readRange(WORKBOOK_ID, "ACTIVE_BOARD_SNAPSHOT!A:Z");
    const activeBoardRows = (activeBoardData.values ?? []).slice(1);

    for (const row of activeBoardRows) {
      const gameId = parseStr(row[ACTIVE_BOARD_COLS.GAME_ID]);
      if (!gameId) continue;

      const rawDecision = parseStr(row[ACTIVE_BOARD_COLS.DECISION]).toUpperCase();
      const decision: ActiveBoardEntry["decision"] =
        rawDecision === "CORE" ? "CORE" : rawDecision === "NOT_CORE" ? "NOT_CORE" : "PENDING";

      output.active_board_snapshot.push({
        date: parseStr(row[ACTIVE_BOARD_COLS.DATE]),
        game_id: gameId,
        matchup: parseStr(row[ACTIVE_BOARD_COLS.MATCHUP]),
        decision,
        side_lean: parseStr(row[ACTIVE_BOARD_COLS.SIDE_LEAN]) || undefined,
        total_lean: parseStr(row[ACTIVE_BOARD_COLS.TOTAL_LEAN]) || undefined,
        away_confidence: parseStr(row[ACTIVE_BOARD_COLS.AWAY_CONFIDENCE]),
        home_confidence: parseStr(row[ACTIVE_BOARD_COLS.HOME_CONFIDENCE]),
      });
    }

    logger.info({
      slateBoardRows: output.slate_board.length,
      core: output.core_count,
      notCore: output.not_core_count,
    }, "MODULE_11: Extraction complete");

    return output;

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_11: Extraction failed");
    output.status = "failure";
    output.error = message;
    return output;
  }
}
