import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  HUMAN_GAME_TRUTH_AUDIT_HEADERS,
  SEPT14_HUMAN_AUDIT,
  SLATE_SIZE_DIAGNOSTIC_HEADERS,
  SLATE_SIZE_SUMMARY_HEADERS,
  buildSlateSizeSummaryRows,
  humanAuditRows,
  parseSlateDiagnostics,
  selectSlateSizeVerdict,
  slateSizeBucket,
} from "./module34_slateSizeDiagnostic.js";
import { GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS } from "./module29_gameTruthDistributionResearch.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import { RUN_LOG_HEADERS } from "./module12_archival.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";

function row(headers: readonly string[], values: Record<string, unknown>): unknown[] {
  return headers.map((header) => values[header] ?? "");
}

function slate(date: string, games: number, mae: number): unknown[] {
  return row(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS, {
    Date: date, Frozen_Games: games, Frozen_Projected_Run_Sum: games * 8,
    Actual_Run_Sum: games * 9, Aggregate_Error_Model_Minus_Actual: -games,
    Per_Game_MAE: mae, Per_Game_RMSE: mae + 1, Median_Absolute_Error: mae,
    Misses_GE_3: 1, Misses_GE_4: 1, Misses_GE_5: 0,
    Projected_Actual_Spearman_Rho: 0.1, Allocation_Eligible_Games: games,
    Higher_Scoring_Side_Correct: games - 1, Allocation_Sign_Reversals: 1,
  });
}

function packet(date: string, game: string): unknown[] {
  return row(PREGAME_PACKET_HISTORY_HEADERS, {
    Date: date, Game_ID: game, Packet_Status: "FROZEN_PREGAME",
    Away_Lineup_Status: "FULL", Home_Lineup_Status: "CONFIRMED",
    Away_Lineup_Coverage: 1, Home_Lineup_Coverage: 1,
    Away_Starter_Role: "CONVENTIONAL_STARTER", Home_Starter_Role: "OPENER",
    Weather_Vehicle_Status: "ACTIVE", Bullpen_Data_Status: "AVAILABLE",
  });
}

function runLog(date: string): unknown[] {
  return row(RUN_LOG_HEADERS, {
    Date: date, Publication_Scope: "FULL_PREGAME_SCOPE",
    Statcast_Preview_Games_Expected: 10, Statcast_Preview_Games_Parsed: 10,
    Projection_Writable_Games: 10, Protected_Games_At_Start: 0,
  });
}

test("Module 34 keeps research-only workbook surfaces through schema v70", () => {
  assert.equal(WORKBOOK_SCHEMA_VERSION, 70);
  for (const [sheet, headers] of [
    ["SLATE_SIZE_DIAGNOSTIC_V1", SLATE_SIZE_DIAGNOSTIC_HEADERS],
    ["SLATE_SIZE_SUMMARY_V1", SLATE_SIZE_SUMMARY_HEADERS],
    ["HUMAN_GAME_TRUTH_AUDIT_V1", HUMAN_GAME_TRUTH_AUDIT_HEADERS],
  ] as const) {
    assert.deepEqual(
      WORKBOOK_SCHEMA.find((definition) => definition.name === sheet)?.columns.map((column) => column.name),
      Array.from(headers),
    );
  }
});

test("fixed slate-size buckets are not outcome-optimized", () => {
  assert.equal(slateSizeBucket(10), "<=10");
  assert.equal(slateSizeBucket(11), "11-12");
  assert.equal(slateSizeBucket(12), "11-12");
  assert.equal(slateSizeBucket(13), "13-16");
  assert.equal(slateSizeBucket(16), "13-16");
  assert.equal(slateSizeBucket(17), "17+");
});

test("parser joins only frozen composition and logged pregame observability", () => {
  const date = "2026-09-14";
  const parsed = parseSlateDiagnostics(
    [Array.from(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS), slate(date, 10, 3.91)],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS), packet(date, "20260914_AAA_BBB")],
    [Array.from(RUN_LOG_HEADERS), runLog(date)],
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.confirmed_lineup_rate, 1);
  assert.equal(parsed[0]!.opener_bulk_rate, 0.5);
  assert.equal(parsed[0]!.bullpen_available_rate, 1);
  assert.equal(parsed[0]!.statcast_coverage, 1);
  assert.equal(parsed[0]!.composition_status, "AVAILABLE_FROM_FROZEN_PACKETS");
});

test("summary uses game-weighted MAE and labels sparse cells descriptive", () => {
  const parsed = parseSlateDiagnostics([
    Array.from(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS),
    slate("2026-09-01", 5, 4),
    slate("2026-09-02", 10, 2),
  ]);
  const summary = buildSlateSizeSummaryRows(parsed, "2026-09-15T12:00:00.000Z");
  const small = summary.find((value) => value[1] === "<=10")!;
  const weightedMaeIndex = SLATE_SIZE_SUMMARY_HEADERS.indexOf("Weighted_Game_MAE");
  const statusIndex = SLATE_SIZE_SUMMARY_HEADERS.indexOf("Cell_Status");
  assert.equal(small[weightedMaeIndex], 2.666667);
  assert.equal(small[statusIndex], "SMALL_SAMPLE_DESCRIPTIVE");
  assert.equal(selectSlateSizeVerdict(parsed), "CONTINUE_SHADOW");
});

test("date-like slate bucket labels are escaped for literal Google Sheets text", () => {
  const parsed = parseSlateDiagnostics([
    Array.from(GAME_TRUTH_SLATE_DIAGNOSTICS_HEADERS),
    slate("2026-09-01", 11, 3),
  ]);
  const summary = buildSlateSizeSummaryRows(parsed, "2026-09-15T12:00:00.000Z");
  const elevenToTwelve = summary.find((value) => value[1] === "'11-12");
  assert.ok(elevenToTwelve);
});

test("September 14 human audit preserves 3-6-1 truth and 1-4 bet record", () => {
  assert.equal(SEPT14_HUMAN_AUDIT.length, 10);
  const rows = humanAuditRows("2026-09-15T12:00:00.000Z");
  const truthStatus = HUMAN_GAME_TRUTH_AUDIT_HEADERS.indexOf("Human_Settlement");
  const execution = HUMAN_GAME_TRUTH_AUDIT_HEADERS.indexOf("Human_Execution");
  assert.equal(rows.filter((value) => value[truthStatus] === "CORRECT").length, 3);
  assert.equal(rows.filter((value) => value[truthStatus] === "INCORRECT").length, 6);
  assert.equal(rows.filter((value) => value[truthStatus] === "NO_CALL").length, 1);
  const bets = rows.filter((value) => value[execution] === "BET");
  assert.equal(bets.length, 5);
  assert.equal(bets.filter((value) => value[truthStatus] === "CORRECT").length, 1);
  assert.equal(bets.filter((value) => value[truthStatus] === "INCORRECT").length, 4);
  const nyy = rows.find((value) => value[1] === "20260914_NYY_MIN")!;
  assert.equal(nyy[HUMAN_GAME_TRUTH_AUDIT_HEADERS.indexOf("Frozen_Pipeline_Market_Line")], 7.5);
  assert.equal(nyy[HUMAN_GAME_TRUTH_AUDIT_HEADERS.indexOf("Operator_Execution_Market_Line")], 8.5);
});

test("slate-size research has no active projection, board, packet, or market consumer", () => {
  for (const module of [
    "module09_recalculation.ts", "module11_outputExtraction.ts",
    "module17_vehiclePostmortem.ts", "module20a_pregamePacket.ts",
    "module20b_operatorEvidence.ts",
  ]) {
    const source = readFileSync(new URL(`./${module}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /SLATE_SIZE_DIAGNOSTIC|SlateSizeDiagnostic|runSlateSizeDiagnostic/);
  }
});
