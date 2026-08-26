import assert from "node:assert/strict";
import test from "node:test";

import {
  GAME_TRUTH_REPLAY_HEADERS,
  buildAllocationDiagnostic,
  buildConversionDiagnostic,
  buildGameTruthReplay,
  buildTimingDiagnostic,
  commandTrafficResult,
  gradeThreshold,
  parsePostgameDetailPayload,
  parseFrozenPacketDiagnostics,
  parseHalfNumberLines,
  starterPathEvidence,
  workloadLeashStatus,
  type FrozenPacketDiagnosticInput,
  type PostgameGameDetail,
} from "./module24_postgameDiagnostics.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

const packet: FrozenPacketDiagnosticInput = {
  date: "2026-08-25",
  game_id: "20260825_AAA_BBB",
  away_team: "AAA",
  home_team: "BBB",
  scheduled_first_pitch: "2026-08-25T23:40:00.000Z",
  snapshot_ts: "2026-08-25T22:00:00.000Z",
  projected_away_runs: 5.85,
  projected_home_runs: 3.06,
  projected_total: 8.91,
  away_expected_ip: 6,
  home_expected_ip: 6,
  bullpen_data_status: "AVAILABLE",
  collision_status: "PROSPECTIVE_SHADOW_CANDIDATE",
  collision_traffic_estimate: 0.6,
  collision_damage_estimate: 0.4,
  operator_evidence_status: "NO_OPERATOR_OVERLAY",
  away_lineup_status: "FULL",
  home_lineup_status: "FULL",
};

const deGromDetail: PostgameGameDetail = {
  away: {
    name: "Jacob deGrom",
    innings: 3.67,
    outs: 11,
    pitches: 91,
    bb: 5,
    hbp: 0,
    hits: 6,
    hr: 2,
    xbh: 3,
    runs: 8,
    earned_runs: 8,
    strikeouts: 2,
  },
  home: {
    name: "Control Starter",
    innings: 6,
    outs: 18,
    pitches: 87,
    bb: 0,
    hbp: 0,
    hits: 2,
    hr: 0,
    xbh: 0,
    runs: 0,
    earned_runs: 0,
    strikeouts: 7,
  },
  away_bullpen: [
    {
      name: "Away Reliever",
      innings: 2,
      outs: 6,
      pitches: 29,
      runs: 0,
      earned_runs: 0,
    },
  ],
  home_bullpen: [
    {
      name: "Home Reliever",
      innings: 3,
      outs: 9,
      pitches: 38,
      runs: 0,
      earned_runs: 0,
    },
  ],
  away_batting: {
    hits: 10,
    bb: 2,
    hbp: 0,
    hr: 0,
    xbh: 2,
    strikeouts: 7,
    at_bats: 34,
    balls_in_play: 27,
  },
  home_batting: {
    hits: 6,
    bb: 5,
    hbp: 0,
    hr: 2,
    xbh: 3,
    strikeouts: 6,
    at_bats: 30,
    balls_in_play: 22,
  },
  away_runs_by_inning: new Map([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 0],
  ]),
  home_runs_by_inning: new Map([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 0],
  ]),
  status: "AVAILABLE",
};

test("allocation diagnostics expose a team-allocation reversal without inventing a threshold", () => {
  const row = buildAllocationDiagnostic(
    {
      date: "2026-08-24",
      game_id: "20260824_TEX_CHW",
      away_team: "TEX",
      home_team: "CHW",
      scheduled_first_pitch: "2026-08-24T23:40:00.000Z",
      snapshot_ts: "2026-08-24T22:00:00.000Z",
      projected_away_runs: 2.12,
      projected_home_runs: 4.56,
      projected_total: 6.68,
      away_expected_ip: 5.5,
      home_expected_ip: 5.5,
    },
    {
      actual_away_runs: 11,
      actual_home_runs: 2,
      actual_total: 13,
      settlement_ts: "2026-08-25T12:00:00.000Z",
    },
  );
  assert.equal(row[13], -8.88);
  assert.equal(row[15], 2.56);
  assert.equal(row[24], "TRUE");
  assert.equal(row[25], "TRUE");
});

test("full ladder accepts only executable half-number thresholds and keeps pushes explicit", () => {
  assert.deepEqual(
    parseHalfNumberLines("6.5, 7.5; 8.5 | 8.0"),
    [6.5, 7.5, 8.5],
  );
  assert.equal(gradeThreshold("OVER", 7.5, 8), "WIN");
  assert.equal(gradeThreshold("UNDER", 7.5, 8), "LOSS");
  assert.equal(gradeThreshold("OVER", 8, 8), "PUSH");
  assert.equal(gradeThreshold(null, 7.5, 8), "NOT_GRADABLE");
});

test("only a frozen packet with a genuine pre-first-pitch snapshot is diagnostic eligible", () => {
  const header = [
    "Date",
    "Game_ID",
    "Packet_Status",
    "Scheduled_First_Pitch",
    "Packet_Snapshot_TS",
    "Away_Team",
    "Home_Team",
    "Base_Away_Projection",
    "Base_Home_Projection",
    "Base_Projection",
    "Away_Expected_IP",
    "Home_Expected_IP",
  ];
  const rows: unknown[][] = [
    header,
    [
      "2026-08-24",
      "good",
      "FROZEN_PREGAME",
      "2026-08-24T23:40:00.000Z",
      "2026-08-24T22:00:00.000Z",
      "AAA",
      "BBB",
      4,
      4.5,
      8.5,
      5.5,
      5.4,
    ],
    [
      "2026-08-24",
      "open",
      "OPEN_PROSPECTIVE",
      "2026-08-24T23:40:00.000Z",
      "2026-08-24T22:00:00.000Z",
      "AAA",
      "BBB",
      4,
      4.5,
      8.5,
      5.5,
      5.4,
    ],
    [
      "2026-08-24",
      "late",
      "FROZEN_PREGAME",
      "2026-08-24T23:40:00.000Z",
      "2026-08-24T23:41:00.000Z",
      "AAA",
      "BBB",
      4,
      4.5,
      8.5,
      5.5,
      5.4,
    ],
  ];
  const packets = parseFrozenPacketDiagnostics(rows, "2026-08-24");
  assert.deepEqual([...packets.keys()], ["good"]);
});

test("workload grading is explicit without treating it as generic pitcher failure", () => {
  assert.equal(workloadLeashStatus(5.5, 6), "REACHED_EXPECTED_IP");
  assert.equal(workloadLeashStatus(5.5, 5), "SHORT_OF_EXPECTED_IP");
  assert.equal(workloadLeashStatus(null, 5), "EXPECTED_IP_UNAVAILABLE");
  assert.equal(workloadLeashStatus(5.5, null), "ACTUAL_IP_UNAVAILABLE");
});

test("starter outcome dimensions distinguish deGrom-style command traffic from generic workload failure", () => {
  const path = starterPathEvidence(6, deGromDetail.away);
  assert.equal(path.workload, "SHORT_OF_EXPECTED_IP");
  assert.equal(
    commandTrafficResult(deGromDetail.away),
    "MIXED_WALK_AND_HIT_TRAFFIC",
  );
  assert.equal(path.damage, "HR_DAMAGE_ALLOWED");
  assert.equal(path.run_prevention, "RUNS_ALLOWED");
  assert.match(path.summary, /COMMAND_TRAFFIC=MIXED_WALK_AND_HIT_TRAFFIC/);
  assert.match(path.summary, /RUN_PREVENTION=RUNS_ALLOWED/);
});

test("official boxscore parsing preserves starter, bullpen, batting, and inning detail without inventing contact data", () => {
  const player = (name: string, pitching: Record<string, unknown>) => ({
    person: { fullName: name },
    stats: { pitching },
  });
  const detail = parsePostgameDetailPayload(
    {
      teams: {
        away: {
          pitchers: [1, 2],
          players: {
            ID1: player("Away Starter", {
              gamesStarted: 1,
              inningsPitched: "5.2",
              pitchesThrown: 91,
              baseOnBalls: 2,
              hitBatsmen: 0,
              hits: 5,
              homeRuns: 1,
              doubles: 1,
              triples: 0,
              runs: 3,
              earnedRuns: 3,
              strikeOuts: 7,
            }),
            ID2: player("Away Reliever", {
              gamesStarted: 0,
              inningsPitched: "1.1",
              pitchesThrown: 21,
              baseOnBalls: 1,
              hitBatsmen: 0,
              hits: 1,
              homeRuns: 0,
              doubles: 0,
              triples: 0,
              runs: 0,
              earnedRuns: 0,
              strikeOuts: 2,
            }),
          },
          teamStats: {
            batting: {
              hits: 9,
              baseOnBalls: 3,
              hitByPitch: 1,
              homeRuns: 2,
              doubles: 2,
              triples: 0,
              strikeOuts: 8,
              atBats: 34,
            },
          },
        },
        home: {
          pitchers: [3],
          players: {
            ID3: player("Home Starter", {
              gamesStarted: 1,
              inningsPitched: "7.0",
              pitchesThrown: 95,
              baseOnBalls: 1,
              hitBatsmen: 0,
              hits: 4,
              homeRuns: 0,
              doubles: 1,
              triples: 0,
              runs: 1,
              earnedRuns: 1,
              strikeOuts: 9,
            }),
          },
          teamStats: {
            batting: {
              hits: 6,
              baseOnBalls: 2,
              hitByPitch: 0,
              homeRuns: 0,
              doubles: 1,
              triples: 0,
              strikeOuts: 9,
              atBats: 31,
            },
          },
        },
      },
    },
    {
      innings: [
        { num: 1, away: { runs: 1 }, home: { runs: 0 } },
        { num: 2, away: { runs: 0 }, home: { runs: 1 } },
      ],
    },
  );
  assert.equal(detail.away?.name, "Away Starter");
  assert.equal(detail.away_bullpen[0]?.name, "Away Reliever");
  assert.equal(detail.away_batting?.hits, 9);
  assert.equal(detail.away_batting?.balls_in_play, 24);
  assert.equal(detail.away_runs_by_inning.get(1), 1);
  assert.equal(detail.home_runs_by_inning.get(2), 1);
});

test("Module 24 headers stay exactly aligned with the generated workbook schema", () => {
  const expected = (sheet: string) =>
    WORKBOOK_SCHEMA.find((entry) => entry.name === sheet)?.columns.map(
      (column) => column.name,
    );
  assert.deepEqual(expected("STARTER_OUTCOME_DIAGNOSTICS"), [
    "Date",
    "Game_ID",
    "Team_Side",
    "Team",
    "Starter",
    "Expected_IP",
    "Actual_IP",
    "IP_Delta",
    "Workload_Leash_Status",
    "Actual_Pitches",
    "BB",
    "HBP",
    "Hits",
    "Baserunners",
    "Traffic_Data_Status",
    "Contact_Data_Status",
    "xBA",
    "Hard_Hit_Pct",
    "Balls_In_Play",
    "Damage_Data_Status",
    "HR",
    "Barrels",
    "XBH",
    "Run_Prevention_Data_Status",
    "R",
    "ER",
    "Starter_Window_Runs_Allowed",
    "K",
    "Whiffs",
    "Starter_Exit_Inning",
    "Diagnostic_Status",
    "Settlement_TS",
    "Command_Traffic_Result",
    "Contact_Result",
    "Damage_Result",
    "Run_Prevention_Result",
    "Starter_Path_Summary",
  ]);
  assert.equal(expected("CONVERSION_SETTLEMENT_DIAGNOSTICS")?.[0], "Date");
  assert.equal(expected("GAME_TRUTH_REPLAY_V1")?.at(-1), "Settlement_TS");
});

test("conversion diagnostics preserve a positive frozen traffic signal without turning it into a projection adjustment", () => {
  const evidence = buildConversionDiagnostic(
    packet,
    {
      actual_away_runs: 2,
      actual_home_runs: 8,
    },
    deGromDetail,
    "AWAY",
  );
  assert.equal(evidence.baserunners, 12);
  assert.equal(
    evidence.pregame_traffic_signal_status,
    "POSITIVE_FROZEN_TRAFFIC_CANDIDATE",
  );
  assert.equal(
    evidence.traffic_conversion_flag,
    "FROZEN_TRAFFIC_SIGNAL_WITH_RUN_SHORTFALL",
  );
  assert.equal(
    evidence.conversion_outcome,
    "TRAFFIC_REALIZED_CONVERSION_SHORTFALL",
  );
  assert.equal(packet.projected_total, 8.91);
});

test("game truth replay joins frozen allocation with starter and bullpen timing rather than a postgame replacement projection", () => {
  const outcome = {
    actual_away_runs: 0,
    actual_home_runs: 8,
    actual_total: 8,
    settlement_ts: "2026-08-26T12:00:00.000Z",
  };
  const timing = buildTimingDiagnostic(packet, outcome, deGromDetail);
  assert.equal(timing.away_starter_exit_vs_expected, "EARLIER_THAN_EXPECTED");
  assert.equal(
    timing.expected_leverage_bridge_status,
    "NOT_EVALUABLE_NAMED_BRIDGE_NOT_FROZEN",
  );
  assert.equal(timing.bullpen_deployment_status, "ACTUAL_CHAIN_RECORDED");

  const row = buildGameTruthReplay(packet, outcome, deGromDetail);
  const at = (name: (typeof GAME_TRUTH_REPLAY_HEADERS)[number]) =>
    row[GAME_TRUTH_REPLAY_HEADERS.indexOf(name)];
  assert.equal(at("Frozen_Projected_Total"), 8.91);
  assert.equal(at("Actual_Total"), 8);
  assert.equal(at("Allocation_Sign_Reversal"), "TRUE");
  assert.equal(at("Primary_Scoring_Mechanism"), "STARTER_WINDOW_PRIMARY");
  assert.equal(
    at("Away_Conversion_Outcome"),
    "TRAFFIC_REALIZED_CONVERSION_SHORTFALL",
  );
  assert.match(String(at("Allocation_Reason_Tags")), /ALLOCATION_REVERSAL/);
  assert.match(
    String(at("Away_Starter_Path")),
    /WORKLOAD=SHORT_OF_EXPECTED_IP/,
  );
});
