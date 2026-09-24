import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";
import {
  applyObjectivePostmortemGrades, deriveCutpoints, parseStarterWindowObservations,
  STARTER_WINDOW_ACTIVE_INPUT, STARTER_WINDOW_COMMISSIONING_STATUS,
  STARTER_WINDOW_ERROR_HEADERS, STARTER_WINDOW_ERROR_SHEET,
  STARTER_WINDOW_ERROR_SUMMARY_HEADERS, STARTER_WINDOW_ERROR_SUMMARY_SHEET,
  STARTER_WINDOW_FAILURE_BUCKETS_HEADERS, STARTER_WINDOW_FAILURE_BUCKETS_SHEET,
  STARTER_WINDOW_PAIR_AUDIT_HEADERS, STARTER_WINDOW_PAIR_AUDIT_SHEET,
  STARTER_WINDOW_FEATURE_GOV_HEADERS, STARTER_WINDOW_FEATURE_GOV_SHEET,
  STARTER_WINDOW_REPLAY_HEADERS, STARTER_WINDOW_REPLAY_SHEET,
} from "./module37_starterWindowDiscrimination.js";
import { GAME_TRUTH_REPLAY_HEADERS } from "./module24_postgameDiagnostics.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";

function row(headers: readonly string[], values: Record<string, unknown>): unknown[] {
  return headers.map(h => values[h] ?? "");
}

const coverageHeaders = [
  "Date","Game_ID","Phase_Row_Usable","Actual_Away_Offense_Starter_Window_Runs",
  "Actual_Home_Offense_Starter_Window_Runs","Actual_Away_Starter_IP","Actual_Home_Starter_IP",
  "Actual_Starter_Window_Runs","Actual_Post_Starter_Runs",
];

function packet(overrides: Record<string, unknown> = {}): unknown[] {
  return row(PREGAME_PACKET_HISTORY_HEADERS, {
    Date:"2026-09-01",Game_ID:"20260901_AAA_BBB",Away_Team:"AAA",Home_Team:"BBB",
    Scheduled_First_Pitch:"2026-09-01T23:00:00.000Z",Packet_Status:"FROZEN_PREGAME",
    Packet_Snapshot_TS:"2026-09-01T20:00:00.000Z",Away_Starter:"Away Starter",Home_Starter:"Home Starter",
    Away_Starter_Role:"CONVENTIONAL_STARTER",Home_Starter_Role:"CONVENTIONAL_STARTER",
    Away_Expected_IP:6,Home_Expected_IP:6,Away_Pitcher_Effective_IP:5.8,Home_Pitcher_Effective_IP:5.5,
    Away_Starter_Quality:0.9,Home_Starter_Quality:1.2,Away_Starter_Quality_Source:"FIP",Home_Starter_Quality_Source:"FIP",
    Away_Active_Offense_Center:4.5,Home_Active_Offense_Center:4.2,
    Away_Traffic_Matchup_Factor:1.1,Home_Traffic_Matchup_Factor:0.95,
    Away_Damage_Matchup_Factor:1,Home_Damage_Matchup_Factor:1,Run_Multiplier:1,
    Away_Lineup_Status:"FULL",Home_Lineup_Status:"FULL",Away_Matchup_Profile_Status:"ACTIVE",Home_Matchup_Profile_Status:"ACTIVE",
    ...overrides,
  });
}

test("starter-window audit derives side expectations from frozen inputs and exact on-mound outcomes", () => {
  const packets=[Array.from(PREGAME_PACKET_HISTORY_HEADERS),packet({
    SSAT_V2_Home_Workload_Failure_Probability:0.42,
    SSAT_V2_Home_Whole_Game_Failure_Run_Cost:3.25,
    SSAT_V2_Home_Calibration_Cohort:"ROLE_AND_WORKLOAD",
    SSAT_V2_Home_Cohort_Observations:48,
    SSAT_V2_Home_Cohort_Failures:20,
    SSAT_V2_Starter_Window_Use_Status:"PROXY_ONLY_NOT_STARTER_SCORING_CALIBRATED",
  })];
  const coverage=[coverageHeaders,row(coverageHeaders,{Date:"2026-09-01",Game_ID:"20260901_AAA_BBB",Phase_Row_Usable:"TRUE",Actual_Away_Offense_Starter_Window_Runs:5,Actual_Home_Offense_Starter_Window_Runs:1,Actual_Away_Starter_IP:6,Actual_Home_Starter_IP:4})];
  const cuts=deriveCutpoints(packets,coverage);
  const observations=parseStarterWindowObservations(packets,coverage,cuts);
  assert.equal(observations.length,2);
  const away=observations.find(r=>r.side==="AWAY")!;
  assert.equal(away.opposing_starter,"Home Starter");
  assert.equal(away.actual_runs,5);
  assert.equal(away.actual_ip,4);
  assert.equal(away.outcome,"FAILURE");
  assert.equal(away.run_outcome,"DETONATION");
  assert.equal(away.workload_outcome,"MATERIALLY_SHORT");
  assert.equal(away.normalized_expected_runs,2.42);
  assert.equal(away.normalized_error,-2.58);
  assert.equal(away.material_error_state,"UNDERPROJECTED_2PLUS");
  assert.equal(away.projected_damage,0);
  assert.equal(away.damage_bucket,"INSTRUMENTATION_DEAD");
  assert.equal(away.failure_probability_proxy,0.42);
  assert.equal(away.failure_run_cost_proxy,3.25);
  assert.equal(away.failure_proxy_cohort,"ROLE_AND_WORKLOAD");
  assert.equal(away.failure_proxy_observations,48);
  assert.equal(away.failure_proxy_failures,20);
  assert.equal(away.failure_proxy_status,"PROXY_ONLY_NOT_STARTER_SCORING_CALIBRATED");
  const home=observations.find(r=>r.side==="HOME")!;
  assert.equal(home.failure_probability_proxy,null);
  assert.equal(home.failure_run_cost_proxy,null);
});

test("post-first-pitch packets and rows without exact phase evidence fail closed", () => {
  const late=packet({Packet_Snapshot_TS:"2026-09-02T00:00:00.000Z"});
  const packets=[Array.from(PREGAME_PACKET_HISTORY_HEADERS),late];
  const coverage=[coverageHeaders,row(coverageHeaders,{Game_ID:"20260901_AAA_BBB",Phase_Row_Usable:"TRUE",Actual_Away_Offense_Starter_Window_Runs:5,Actual_Home_Offense_Starter_Window_Runs:1,Actual_Away_Starter_IP:6,Actual_Home_Starter_IP:4})];
  assert.deepEqual(parseStarterWindowObservations(packets,coverage),[]);
});

test("Module 37 starter-window discrimination support is research-only", () => {
  assert.equal(STARTER_WINDOW_ACTIVE_INPUT,"NO");
  assert.equal(STARTER_WINDOW_COMMISSIONING_STATUS,"RESEARCH_ONLY_NOT_COMMISSIONED");
});

test("schema v76 exposes exactly the six frozen Module 37 supporting research sheets", () => {
  assert.equal(WORKBOOK_SCHEMA_VERSION,76);
  for (const [name,headers] of [
    [STARTER_WINDOW_ERROR_SHEET,STARTER_WINDOW_ERROR_HEADERS],
    [STARTER_WINDOW_ERROR_SUMMARY_SHEET,STARTER_WINDOW_ERROR_SUMMARY_HEADERS],
    [STARTER_WINDOW_FAILURE_BUCKETS_SHEET,STARTER_WINDOW_FAILURE_BUCKETS_HEADERS],
    [STARTER_WINDOW_PAIR_AUDIT_SHEET,STARTER_WINDOW_PAIR_AUDIT_HEADERS],
    [STARTER_WINDOW_FEATURE_GOV_SHEET,STARTER_WINDOW_FEATURE_GOV_HEADERS],
    [STARTER_WINDOW_REPLAY_SHEET,STARTER_WINDOW_REPLAY_HEADERS],
  ] as const) {
    assert.deepEqual(WORKBOOK_SCHEMA.find(s=>s.name===name)?.columns.map(c=>c.name),Array.from(headers));
  }
});

test("objective postmortem grades every frozen game from exact phase evidence without inventing vehicle or causal detail", () => {
  const frozen=packet({
    Starter_Attack_Runs:6.4,
    Traffic_Conversion_Runs:0,
    HR_XBH_Damage_Runs:0,
    Bullpen_Continuation_Runs:3.3,
    Run_Multiplier:1,
    Direction:"OVER",
    Final_Decision:"NO_CORE",
    Final_Blocker:"INSUFFICIENT_PROJECTION_SEPARATION",
    Primary_Grade_Market_Line:"",
    Primary_Grade_Market_Source:"HARD_ROCK_FLORIDA_REQUIRED",
    Primary_Grade_Market_Status:"NO_LITERAL_EXECUTABLE_HARD_ROCK_LINE",
  });
  const truth=row(GAME_TRUTH_REPLAY_HEADERS,{
    Date:"2026-09-01",Game_ID:"20260901_AAA_BBB",Frozen_Projected_Total:9.25,
    Actual_Total:10,Total_Abs_Error:0.75,Allocation_Sign_Reversal:"FALSE",
    Replay_Status:"FROZEN_PACKET_AND_FINAL_VERIFIED",Settlement_TS:"2026-09-02T04:00:00.000Z",
  });
  const exact=row(coverageHeaders,{
    Date:"2026-09-01",Game_ID:"20260901_AAA_BBB",Phase_Row_Usable:"TRUE",
    Actual_Starter_Window_Runs:7,Actual_Post_Starter_Runs:3,
  });
  const graded=applyObjectivePostmortemGrades(
    [Array.from(GAME_TRUTH_REPLAY_HEADERS),truth],
    [Array.from(PREGAME_PACKET_HISTORY_HEADERS),frozen],
    [coverageHeaders,exact],
  );
  const result=graded[1]!;
  const at=(name:(typeof GAME_TRUTH_REPLAY_HEADERS)[number])=>result[GAME_TRUTH_REPLAY_HEADERS.indexOf(name)];
  assert.equal(at("Objective_Game_Truth_Grade"),"GAME_TRUTH_PROXY_MATCH");
  assert.equal(at("Objective_Phase_Mechanism_Proxy_Grade"),"PHASE_PROXY_MATCH");
  assert.equal(at("Objective_Vehicle_Capture_Grade"),"UNGRADABLE_NO_LITERAL_EXECUTABLE_LINE");
  assert.equal(at("Objective_Authorization_Blocker_Grade"),"PASS_DEFENSIBLE_INDETERMINATE");
  assert.equal(at("Pregame_Causal_Detail_Status"),"NOT_FROZEN_CAUSAL_DETAIL_UNAVAILABLE");
});

test("active projection and board modules have no Module 37 starter-window discrimination consumer", () => {
  for (const file of ["module09_recalculation.ts","module11_outputExtraction.ts"]) {
    const source=readFileSync(new URL(`./${file}`,import.meta.url),"utf8");
    assert.doesNotMatch(source,/STARTER_WINDOW_(ERROR|REPLAY|FAILURE_BUCKETS)|module37_starterWindowDiscrimination/);
    assert.doesNotMatch(source,/SSAT_V2_(Away|Home)_Workload_Failure_Probability|SSAT_V2_(Away|Home)_Whole_Game_Failure_Run_Cost/);
  }
});
