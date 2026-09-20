import assert from "node:assert/strict";
import test from "node:test";
import {
  BULLPEN_PHASE_ANALYSIS_HEADERS,
  BULLPEN_PHASE_COVERAGE_HEADERS,
  BULLPEN_PHASE_COVERAGE_SUMMARY_HEADERS,
  BULLPEN_PHASE_REPLAY_HEADERS,
  MIN_INTERPRETABLE_CELL_N,
  buildPhaseCorpusInputs,
  buildLosoSlateEnvironments,
  buildPhaseAnalysisRows,
  evaluateCoverage,
  reconstructPhaseFromPlayByPlay,
  scheduleGamePkMap,
  selectPrimaryVerdict,
  type PhaseAnalysisRow,
  type PhaseCorpusInput,
  type PhaseCoverageRecord,
  type PhaseReplayRecord,
  type WorkloadState,
} from "./module32_bullpenPhaseAnalysis.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";
import {
  ALLOCATION_SETTLEMENT_HEADERS,
  STARTER_OUTCOME_HEADERS,
} from "./module24_postgameDiagnostics.js";
import { OUTCOMES_HEADER } from "./module14_shadowSettlement.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";

function rowFromHeaders(
  headers: readonly string[],
  fields: Record<string, unknown>,
): unknown[] {
  return headers.map((header) => fields[header] ?? "");
}

function corpusInput(
  date = "2026-09-01",
  gameId = "20260901_NYY_BOS",
  actualTotal = 8,
): PhaseCorpusInput {
  return {
    date,
    game_id: gameId,
    snapshot_ts: `${date}T12:00:00.000Z`,
    away_role: "CONVENTIONAL_STARTER",
    home_role: "CONVENTIONAL_STARTER",
    away_expected_ip: 6,
    home_expected_ip: 6,
    starter_attack_runs: 5,
    bullpen_continuation_runs: 3,
    actual_total: actualTotal,
    actual_away_ip: 6,
    actual_home_ip: 6,
    actual_away_ip_status: "DIRECT_MLB_BOXSCORE",
    actual_home_ip_status: "DIRECT_MLB_BOXSCORE",
    away_starter_match: "MATCH",
    home_starter_match: "MATCH",
  };
}

function coverageRecord(index: number, usable = true): PhaseCoverageRecord {
  const date = `2026-08-${String(1 + (index % 20)).padStart(2, "0")}`;
  return {
    ...corpusInput(date, `${date.replaceAll("-", "")}_NYY_BOS_${index}`),
    game_pk: 1000 + index,
    reconstruction: {
      status: "RECONSTRUCTED_VALIDATED",
      actual_starter_window_runs: 5,
      actual_away_offense_starter_window_runs: 3,
      actual_home_offense_starter_window_runs: 2,
      actual_post_starter_runs: 3,
      inherited_runner_crossings: 0,
      actual_total_from_pbp: 8,
    },
    phase_row_usable: usable,
    exclusion_reason: usable ? "" : "STARTER_IDENTITY_MISMATCH_MATCH",
    away_shortfall_ip: 0,
    home_shortfall_ip: 0,
    max_shortfall_ip: 0,
    workload_state: "REACHED_OR_EXCEEDED",
  };
}

function replayRecord(
  index: number,
  workload: WorkloadState,
  environment: "LOW_NORMAL" | "HIGH" | "EXTREME",
  starterError: number,
  bullpenError: number,
): PhaseReplayRecord {
  const date = `2026-08-${String(1 + (index % 20)).padStart(2, "0")}`;
  const base = coverageRecord(index);
  return {
    ...base,
    date,
    workload_state: workload,
    starter_phase_error: starterError,
    bullpen_phase_error: bullpenError,
    paired_loss_difference: Math.abs(bullpenError) - Math.abs(starterError),
    environment: {
      date,
      slate_runs_per_game: 9,
      loso_corpus_n_slates: 19,
      loso_mean_runs_per_game: 8,
      loso_sd_runs_per_game: 1,
      slate_z_loso:
        environment === "EXTREME" ? 2 : environment === "HIGH" ? 1 : 0,
      bucket: environment,
    },
  };
}

function analysisRow(
  environment: PhaseAnalysisRow["environment_bucket"],
  workload: PhaseAnalysisRow["workload_state"],
  n: number,
  pairedDifference: number,
  ciLower: number | null,
): PhaseAnalysisRow {
  return {
    row_type:
      environment === "ALL" && workload === "ALL"
        ? "OVERALL"
        : environment === "ALL"
          ? "WORKLOAD_MAIN_EFFECT"
          : workload === "ALL"
            ? "ENVIRONMENT_MAIN_EFFECT"
            : "INTERACTION_CELL",
    environment_bucket: environment,
    workload_state: workload,
    n,
    n_slates: 10,
    starter_bias: 0,
    starter_mae: 1,
    starter_rmse: 1,
    bullpen_bias: 0,
    bullpen_mae: 1 + pairedDifference,
    bullpen_rmse: 1 + pairedDifference,
    paired_loss_difference: pairedDifference,
    ci_lower: ciLower,
    ci_upper: ciLower === null ? null : ciLower + 1,
    uncertainty_method:
      ciLower === null ? "CI_UNAVAILABLE" : "SLATE_DATE_BLOCK_BOOTSTRAP_5000",
    cell_status:
      n < MIN_INTERPRETABLE_CELL_N ? "INSUFFICIENT_CELL" : "INTERPRETABLE",
  };
}

test("phase reconstruction assigns inherited runs to the pitcher actually on the mound", () => {
  const result = reconstructPhaseFromPlayByPlay(
    {
      allPlays: [
        {
          about: { halfInning: "top" },
          matchup: { pitcher: { id: 20 } },
          runners: [
            {
              movement: { end: "score" },
              details: { isScoringEvent: true, responsiblePitcher: { id: 20 } },
            },
          ],
        },
        {
          about: { halfInning: "bottom" },
          matchup: { pitcher: { id: 10 } },
          runners: [],
        },
        {
          about: { halfInning: "top" },
          matchup: { pitcher: { id: 21 } },
          runners: [
            {
              movement: { end: "score" },
              details: { isScoringEvent: true, responsiblePitcher: { id: 20 } },
            },
          ],
        },
      ],
    },
    2,
  );
  assert.equal(result.status, "RECONSTRUCTED_VALIDATED");
  assert.equal(result.actual_starter_window_runs, 1);
  assert.equal(result.actual_away_offense_starter_window_runs, 1);
  assert.equal(result.actual_home_offense_starter_window_runs, 0);
  assert.equal(result.actual_post_starter_runs, 1);
  assert.equal(result.inherited_runner_crossings, 1);
});

test("phase reconstruction fails closed when play-by-play scoring does not reconcile", () => {
  const result = reconstructPhaseFromPlayByPlay(
    {
      allPlays: [
        {
          about: { halfInning: "top" },
          matchup: { pitcher: { id: 20 } },
          runners: [],
        },
        {
          about: { halfInning: "bottom" },
          matchup: { pitcher: { id: 10 } },
          runners: [],
        },
      ],
    },
    1,
  );
  assert.equal(result.status, "PLAY_BY_PLAY_TOTAL_MISMATCH");
  assert.equal(result.actual_starter_window_runs, null);
  assert.equal(result.actual_post_starter_runs, null);
});

test("coverage gate requires both 100 usable games and 50 percent corpus coverage", () => {
  const belowN = evaluateCoverage(
    Array.from({ length: 99 }, (_, index) => coverageRecord(index)),
  );
  assert.equal(belowN.coverage_pct, 100);
  assert.equal(belowN.verdict, "INSUFFICIENT_PHASE_INSTRUMENTATION");

  const exactFloor = evaluateCoverage(
    Array.from({ length: 200 }, (_, index) =>
      coverageRecord(index, index < 100),
    ),
  );
  assert.equal(exactFloor.usable_n, 100);
  assert.equal(exactFloor.coverage_pct, 50);
  assert.equal(exactFloor.verdict, "PASS");

  const belowCoverage = evaluateCoverage(
    Array.from({ length: 202 }, (_, index) =>
      coverageRecord(index, index < 100),
    ),
  );
  assert.equal(belowCoverage.usable_n, 100);
  assert.ok(belowCoverage.coverage_pct < 50);
  assert.equal(belowCoverage.verdict, "INSUFFICIENT_PHASE_INSTRUMENTATION");
});

test("legacy blank starter diagnostic status retains direct numeric MLB boxscore IP", () => {
  const date = "2026-09-01";
  const gameId = "20260901_NYY_BOS";
  const packetRows = [
    Array.from(PREGAME_PACKET_HISTORY_HEADERS),
    rowFromHeaders(PREGAME_PACKET_HISTORY_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Packet_Status: "FROZEN_PREGAME",
      Packet_Snapshot_TS: `${date}T12:00:00.000Z`,
      Scheduled_First_Pitch: `${date}T23:00:00.000Z`,
      Away_Starter_Role: "CONVENTIONAL_STARTER",
      Home_Starter_Role: "CONVENTIONAL_STARTER",
      Away_Expected_IP: 6,
      Home_Expected_IP: 6,
      Starter_Attack_Runs: 5,
      Bullpen_Continuation_Runs: 3,
    }),
  ];
  const allocationRows = [
    Array.from(ALLOCATION_SETTLEMENT_HEADERS),
    rowFromHeaders(ALLOCATION_SETTLEMENT_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Actual_Total: 8,
      Diagnostic_Status: "FROZEN_PACKET_VERIFIED",
    }),
  ];
  const starterRows = [
    Array.from(STARTER_OUTCOME_HEADERS),
    rowFromHeaders(STARTER_OUTCOME_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Team_Side: "AWAY",
      Actual_IP: 5.6667,
      Diagnostic_Status: "",
    }),
    rowFromHeaders(STARTER_OUTCOME_HEADERS, {
      Date: date,
      Game_ID: gameId,
      Team_Side: "HOME",
      Actual_IP: 6,
      Diagnostic_Status: "",
    }),
  ];
  const outcomeRows = [
    OUTCOMES_HEADER,
    rowFromHeaders(OUTCOMES_HEADER, {
      Date: date,
      Game_ID: gameId,
      Away_Starter_Match_Status: "MATCH",
      Home_Starter_Match_Status: "MATCH",
    }),
  ];
  const inputs = buildPhaseCorpusInputs(
    packetRows,
    allocationRows,
    starterRows,
    outcomeRows,
  );
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.actual_away_ip, 5.6667);
  assert.equal(inputs[0]!.actual_away_ip_status, "DIRECT_MLB_BOXSCORE");
  assert.equal(inputs[0]!.actual_home_ip_status, "DIRECT_MLB_BOXSCORE");
});

test("LOSO environment removes the evaluated slate from its own mean and SD", () => {
  const environments = buildLosoSlateEnvironments([
    corpusInput("2026-09-01", "20260901_A_B", 10),
    corpusInput("2026-09-02", "20260902_A_B", 6),
    corpusInput("2026-09-03", "20260903_A_B", 8),
  ]);
  const first = environments.get("2026-09-01")!;
  assert.equal(first.loso_corpus_n_slates, 2);
  assert.equal(first.loso_mean_runs_per_game, 7);
  assert.equal(first.loso_sd_runs_per_game, 1.4142);
  assert.equal(first.slate_z_loso, 2.1213);
  assert.equal(first.bucket, "EXTREME");
});

test("interaction cells are descriptive only below N=15 and interpretable at N=15", () => {
  const rows = [
    ...Array.from({ length: 14 }, (_, index) =>
      replayRecord(index, "MATERIALLY_SHORT", "HIGH", 1, 2),
    ),
    ...Array.from({ length: 15 }, (_, index) =>
      replayRecord(20 + index, "MODERATELY_SHORT", "LOW_NORMAL", 1, 2),
    ),
  ];
  const analysis = buildPhaseAnalysisRows(rows);
  const highMaterial = analysis.find(
    (row) =>
      row.environment_bucket === "HIGH" &&
      row.workload_state === "MATERIALLY_SHORT",
  )!;
  const lowModerate = analysis.find(
    (row) =>
      row.environment_bucket === "LOW_NORMAL" &&
      row.workload_state === "MODERATELY_SHORT",
  )!;
  assert.equal(highMaterial.n, 14);
  assert.equal(highMaterial.cell_status, "INSUFFICIENT_CELL");
  assert.equal(highMaterial.ci_lower, null);
  assert.equal(lowModerate.n, 15);
  assert.equal(lowModerate.cell_status, "INTERPRETABLE");
  assert.notEqual(lowModerate.ci_lower, null);
});

test("supported verdict requires material-shortfall evidence outside extreme slates", () => {
  const rows = [
    analysisRow("ALL", "ALL", 231, 0.18, -0.18),
    analysisRow("ALL", "MATERIALLY_SHORT", 71, 1.14, 0.55),
    analysisRow("LOW_NORMAL", "REACHED_OR_EXCEEDED", 41, -0.2, -0.96),
    analysisRow("LOW_NORMAL", "MODERATELY_SHORT", 94, -0.46, -0.82),
    analysisRow("LOW_NORMAL", "MATERIALLY_SHORT", 51, 0.92, 0.29),
  ];
  assert.equal(
    selectPrimaryVerdict("PASS", rows),
    "BULLPEN_STATE_HYPOTHESIS_SUPPORTED",
  );
  assert.equal(
    selectPrimaryVerdict("INSUFFICIENT_PHASE_INSTRUMENTATION", rows),
    "INSUFFICIENT_PHASE_INSTRUMENTATION",
  );
});

test("schedule resolver preserves doubleheader game identity", () => {
  const result = scheduleGamePkMap("2026-08-29", {
    dates: [
      {
        games: [
          {
            gamePk: 1,
            gameNumber: 1,
            teams: {
              away: { team: { abbreviation: "BOS" } },
              home: { team: { abbreviation: "NYY" } },
            },
          },
          {
            gamePk: 2,
            gameNumber: 2,
            teams: {
              away: { team: { abbreviation: "BOS" } },
              home: { team: { abbreviation: "NYY" } },
            },
          },
        ],
      },
    ],
  });
  assert.equal(result.get("20260829_BOS_NYY__G1"), 1);
  assert.equal(result.get("20260829_BOS_NYY__G2"), 2);
  assert.equal(result.has("20260829_BOS_NYY"), false);
});

test("v63 workbook schema exactly matches all bullpen phase output contracts", () => {
  const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["BULLPEN_PHASE_COVERAGE_V1", BULLPEN_PHASE_COVERAGE_HEADERS],
    [
      "BULLPEN_PHASE_COVERAGE_SUMMARY_V1",
      BULLPEN_PHASE_COVERAGE_SUMMARY_HEADERS,
    ],
    ["BULLPEN_PHASE_REPLAY_V1", BULLPEN_PHASE_REPLAY_HEADERS],
    ["BULLPEN_PHASE_ANALYSIS_V1", BULLPEN_PHASE_ANALYSIS_HEADERS],
  ];
  for (const [name, headers] of expected) {
    const sheet = WORKBOOK_SCHEMA.find((candidate) => candidate.name === name);
    assert.ok(sheet, `${name} missing from schema`);
    assert.deepEqual(
      sheet.columns.map((column) => column.name),
      Array.from(headers),
    );
  }
});
