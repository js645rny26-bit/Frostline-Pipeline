/**
 * Module 38: Starter Window Discrimination Audit V1.
 *
 * Settlement-only research. Every predictor is read from an immutable,
 * legitimate pre-first-pitch packet. Outcomes are exact MLB play-by-play runs
 * scored while the opposing designated starter was actually on the mound.
 * No row is an active projection, coefficient, market, confidence, or decision
 * input.
 */

import {
  addSheet, clearRange, expandSheetColumns, getSpreadsheetSheetProperties,
  readRange, writeRange, WORKBOOK_ID,
} from "../sheets/client.js";
import { pregamePacketHistoryRange, PREGAME_PACKET_HISTORY_SHEET } from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

export const STARTER_WINDOW_ERROR_SHEET = "STARTER_WINDOW_ERROR_V1";
export const STARTER_WINDOW_ERROR_SUMMARY_SHEET = "STARTER_WINDOW_ERROR_SUMMARY_V1";
export const STARTER_WINDOW_FAILURE_BUCKETS_SHEET = "STARTER_WINDOW_FAILURE_BUCKETS_V1";
export const STARTER_WINDOW_PAIR_AUDIT_SHEET = "STARTER_WINDOW_PAIR_AUDIT_V1";
export const STARTER_WINDOW_FEATURE_GOV_SHEET = "STARTER_WINDOW_FEATURE_GOV_V1";
export const STARTER_WINDOW_REPLAY_SHEET = "STARTER_WINDOW_REPLAY_V1";
export const STARTER_WINDOW_VERSION = "STARTER_WINDOW_DISCRIMINATION_V1_2026-09-20";
export const STARTER_WINDOW_ACTIVE_INPUT = "NO" as const;
export const STARTER_WINDOW_COMMISSIONING_STATUS = "RESEARCH_ONLY_NOT_COMMISSIONED" as const;
export const STARTER_WINDOW_MIN_INTERPRETABLE_N = 30;
export const STARTER_WINDOW_BUCKET_DERIVATION_THROUGH_DATE = "2026-09-17";

export const STARTER_WINDOW_ERROR_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Batting_Team", "Opposing_Team", "Opposing_Starter",
  "Opposing_Starter_Role", "Frozen_Packet_Snapshot_TS", "Frozen_Expected_IP",
  "Frozen_Effective_IP", "Frozen_Starter_Quality", "Frozen_Starter_Quality_Source",
  "Frozen_Active_Offense_Center", "Frozen_Traffic_Factor", "Frozen_Damage_Factor",
  "Frozen_Run_Multiplier", "Projected_Starter_Base_Runs", "Projected_Traffic_Runs",
  "Projected_Damage_Runs", "Frozen_Expected_Starter_Window_Runs", "Actual_Starter_IP",
  "Actual_Starter_Window_Runs", "Starter_Window_Error", "Starter_Window_Abs_Error",
  "Workload_Shortfall_IP", "Outcome_State", "Tail_4Plus", "Tail_5Plus", "Tail_6Plus",
  "Quality_Bucket", "Traffic_Bucket", "Damage_Bucket", "Offense_Bucket",
  "Expected_Workload_Bucket", "Actual_Workload_Bucket", "Pressure_Shape",
  "Traffic_Damage_CoSign", "Lineup_Status", "Matchup_Profile_Status",
  "Frozen_Probability_Status", "Feature_Lineage_Status", "Actual_Lineage_Status",
  "Research_Status", "Active_Input", "Replay_TS",
] as const;

export const STARTER_WINDOW_ERROR_SUMMARY_HEADERS = [
  "Dimension", "Cohort", "N", "Slate_N", "Signed_Bias", "MAE", "Median_AE", "RMSE",
  "Failure_Frequency", "Mean_Runs_Conditional_On_Failure", "Tail_4Plus_Rate",
  "Tail_5Plus_Rate", "Tail_6Plus_Rate", "Quiet_Window_False_Positive_Rate",
  "Detonation_False_Negative_Rate", "Bias_CI_Lower", "Bias_CI_Upper",
  "Uncertainty_Method", "Interpretation_Status", "Instrumentation_Status",
  "Probability_Calibration_Status", "Commissioning_Status", "Notes", "Replay_TS",
] as const;

export const STARTER_WINDOW_FAILURE_BUCKETS_HEADERS = [
  "Feature", "Bucket", "N", "Failure_N", "Failure_Frequency", "Mean_Expected_Runs",
  "Mean_Actual_Runs", "Mean_Runs_Conditional_On_Failure", "Tail_4Plus_Rate",
  "Tail_5Plus_Rate", "Tail_6Plus_Rate", "Expected_Survival_Rate",
  "Observed_Survival_Rate", "Expected_Failure_Rate", "Observed_Failure_Rate",
  "Probability_Metric_Status", "Discrimination_Status", "Instrumentation_Status",
  "Bucket_Cutpoint_Source", "Notes", "Replay_TS",
] as const;

export const STARTER_WINDOW_PAIR_AUDIT_HEADERS = [
  "Date", "Game_ID", "Case_Type", "Team_Side", "Opposing_Starter",
  "Frozen_Expected_Starter_Window_Runs", "Actual_Starter_Window_Runs",
  "Starter_Window_Error", "Frozen_Expected_IP", "Actual_Starter_IP", "Outcome_State",
  "Pregame_Mechanism_Source", "Pregame_Mechanism", "Mechanism_Grade",
  "Case_Interpretation", "No_Outcome_Fitting_Status", "Replay_TS",
] as const;

export const STARTER_WINDOW_FEATURE_GOV_HEADERS = [
  "Feature", "Source", "Freshness", "Pregame_Availability", "Leakage_Risk",
  "Current_Active_Use", "Research_Eligibility", "Instrumentation_Status",
  "Commissioning_Status", "Fallback_Behavior", "Notes", "Audit_TS",
] as const;

export const STARTER_WINDOW_REPLAY_HEADERS = [
  "Date", "Game_ID", "Team_Side", "Frozen_Packet_Snapshot_TS", "Opposing_Starter",
  "Opposing_Starter_Role", "Frozen_Expected_Starter_Window_Runs",
  "Actual_Starter_Window_Runs", "Signed_Error", "Absolute_Error", "Outcome_State",
  "Actual_Starter_IP", "Frozen_Expected_IP", "Workload_Shortfall_IP", "Quality_Bucket",
  "Traffic_Bucket", "Damage_Bucket", "Offense_Bucket", "Expected_Workload_Bucket",
  "Pressure_Shape", "Replay_Status", "Active_Input", "Replay_TS",
] as const;

type Side = "AWAY" | "HOME";
type OutcomeState = "FAILURE" | "SURVIVAL" | "MIXED";
type Bucket = "LOW" | "MID" | "HIGH" | "UNAVAILABLE" | "INSTRUMENTATION_DEAD";

export interface StarterWindowObservation {
  date: string; game_id: string; side: Side; batting_team: string; opposing_team: string;
  opposing_starter: string; opposing_role: string; snapshot_ts: string;
  expected_ip: number; effective_ip: number; quality: number; quality_source: string;
  offense_center: number; traffic_factor: number; damage_factor: number; run_multiplier: number;
  projected_base: number; projected_traffic: number; projected_damage: number;
  expected_runs: number; actual_ip: number; actual_runs: number; error: number; abs_error: number;
  workload_shortfall: number; outcome: OutcomeState; lineup_status: string;
  matchup_status: string; quality_bucket: Bucket; traffic_bucket: Bucket;
  damage_bucket: Bucket; offense_bucket: Bucket; expected_workload_bucket: Bucket;
  actual_workload_bucket: Bucket; pressure_shape: string; cosign: string;
}

type Cutpoints = { low: number; high: number };
type CutpointSet = Record<"quality" | "traffic" | "offense" | "expected_workload" | "actual_workload", Cutpoints | null>;

function text(v: unknown): string { return v === null || v === undefined ? "" : String(v).trim(); }
function num(v: unknown): number | null { if (v === "" || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v: number, d = 6): number { return Number(v.toFixed(d)); }
function idx(header: readonly unknown[]): Map<string, number> { return new Map(header.map((v, i) => [text(v), i])); }
function val(row: readonly unknown[], index: ReadonlyMap<string, number>, name: string): unknown { const i = index.get(name); return i === undefined ? undefined : row[i]; }
function mean(xs: readonly number[]): number | null { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function median(xs: readonly number[]): number | null { if (!xs.length) return null; const s = [...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]!:((s[m-1]!+s[m]!)/2); }
function quantile(xs: readonly number[], p: number): number | null { if (!xs.length) return null; const s=[...xs].sort((a,b)=>a-b); const pos=(s.length-1)*p; const lo=Math.floor(pos), hi=Math.ceil(pos); return lo===hi?s[lo]!:s[lo]!+(s[hi]!-s[lo]!)*(pos-lo); }
function tertiles(xs: readonly number[]): Cutpoints | null { const low=quantile(xs,1/3), high=quantile(xs,2/3); return low===null||high===null?null:{low,high}; }
function bucket(v: number, c: Cutpoints | null): Bucket { return !c ? "UNAVAILABLE" : v<=c.low?"LOW":v<=c.high?"MID":"HIGH"; }

function packetBeforeFirstPitch(row: readonly unknown[], i: ReadonlyMap<string, number>): boolean {
  const snapshot = Date.parse(text(val(row,i,"Packet_Snapshot_TS")));
  const pitch = Date.parse(text(val(row,i,"Scheduled_First_Pitch")));
  return Number.isFinite(snapshot) && Number.isFinite(pitch) && snapshot < pitch;
}

function sideRaw(row: readonly unknown[], i: ReadonlyMap<string, number>, side: Side) {
  const away = side === "AWAY";
  const opposing = away ? "Home" : "Away";
  return {
    date: text(val(row,i,"Date")), game_id: text(val(row,i,"Game_ID")), side,
    batting_team: text(val(row,i,away?"Away_Team":"Home_Team")),
    opposing_team: text(val(row,i,away?"Home_Team":"Away_Team")),
    opposing_starter: text(val(row,i,`${opposing}_Starter`)),
    opposing_role: text(val(row,i,`${opposing}_Starter_Role`)),
    snapshot_ts: text(val(row,i,"Packet_Snapshot_TS")),
    expected_ip: num(val(row,i,`${opposing}_Expected_IP`)),
    effective_ip: num(val(row,i,`${opposing}_Pitcher_Effective_IP`)),
    quality: num(val(row,i,`${opposing}_Starter_Quality`)),
    quality_source: text(val(row,i,`${opposing}_Starter_Quality_Source`)),
    offense_center: num(val(row,i,`${side === "AWAY" ? "Away" : "Home"}_Active_Offense_Center`)),
    traffic_factor: num(val(row,i,`${side === "AWAY" ? "Away" : "Home"}_Traffic_Matchup_Factor`)),
    damage_factor: num(val(row,i,`${side === "AWAY" ? "Away" : "Home"}_Damage_Matchup_Factor`)),
    run_multiplier: num(val(row,i,"Run_Multiplier")),
    lineup_status: text(val(row,i,`${side === "AWAY" ? "Away" : "Home"}_Lineup_Status`)),
    matchup_status: text(val(row,i,`${side === "AWAY" ? "Away" : "Home"}_Matchup_Profile_Status`)),
  };
}

export function deriveCutpoints(packetRows: unknown[][], coverageRows: unknown[][]): CutpointSet {
  const raw = parseStarterWindowObservations(packetRows, coverageRows, null, false);
  const derivation = raw.filter(r => r.date <= STARTER_WINDOW_BUCKET_DERIVATION_THROUGH_DATE);
  return {
    quality: tertiles(derivation.map(r=>r.quality)), traffic: tertiles(derivation.map(r=>r.traffic_factor)),
    offense: tertiles(derivation.map(r=>r.offense_center)), expected_workload: tertiles(derivation.map(r=>r.expected_ip)),
    actual_workload: tertiles(derivation.map(r=>r.actual_ip)),
  };
}

export function parseStarterWindowObservations(
  packetRows: unknown[][], coverageRows: unknown[][], cutpoints: CutpointSet | null = null,
  assignBuckets = true,
): StarterWindowObservation[] {
  const [ph=[], ...pd] = packetRows; const pi=idx(ph);
  const packets = new Map<string, unknown[]>();
  for (const row of pd) {
    const game=text(val(row,pi,"Game_ID"));
    if (!game || text(val(row,pi,"Packet_Status"))!=="FROZEN_PREGAME" || !packetBeforeFirstPitch(row,pi)) continue;
    packets.set(game,row);
  }
  const [ch=[], ...cd]=coverageRows; const ci=idx(ch); const out: StarterWindowObservation[]=[];
  for (const crow of cd) {
    if (text(val(crow,ci,"Phase_Row_Usable"))!=="TRUE") continue;
    const game=text(val(crow,ci,"Game_ID")); const prow=packets.get(game); if (!prow) continue;
    for (const side of ["AWAY","HOME"] as const) {
      const raw=sideRaw(prow,pi,side);
      const actualRuns=num(val(crow,ci,side==="AWAY"?"Actual_Away_Offense_Starter_Window_Runs":"Actual_Home_Offense_Starter_Window_Runs"));
      const actualIp=num(val(crow,ci,side==="AWAY"?"Actual_Home_Starter_IP":"Actual_Away_Starter_IP"));
      if ([raw.expected_ip,raw.effective_ip,raw.quality,raw.offense_center,raw.traffic_factor,raw.damage_factor,raw.run_multiplier,actualRuns,actualIp].some(v=>v===null)) continue;
      const base=raw.offense_center!*(raw.effective_ip!/9)*raw.quality!;
      const traffic=base*(raw.traffic_factor!-1);
      const damage=(base+traffic)*(raw.damage_factor!-1);
      const expected=(base+traffic+damage)*raw.run_multiplier!;
      const error=expected-actualRuns!; const shortfall=Math.max(0,raw.expected_ip!-actualIp!);
      const outcome: OutcomeState = actualRuns!>=4 || shortfall>=2 ? "FAILURE" : actualRuns!<=2 && actualIp!>=raw.expected_ip!-0.5 ? "SURVIVAL" : "MIXED";
      const cp=cutpoints;
      out.push({
        ...raw, expected_ip:raw.expected_ip!, effective_ip:raw.effective_ip!, quality:raw.quality!, offense_center:raw.offense_center!,
        traffic_factor:raw.traffic_factor!, damage_factor:raw.damage_factor!, run_multiplier:raw.run_multiplier!,
        projected_base:round(base), projected_traffic:round(traffic), projected_damage:round(damage), expected_runs:round(expected),
        actual_ip:actualIp!, actual_runs:actualRuns!, error:round(error), abs_error:round(Math.abs(error)), workload_shortfall:round(shortfall), outcome,
        quality_bucket:assignBuckets?bucket(raw.quality!,cp?.quality??null):"UNAVAILABLE",
        traffic_bucket:assignBuckets?bucket(raw.traffic_factor!,cp?.traffic??null):"UNAVAILABLE",
        damage_bucket:raw.damage_factor===1?"INSTRUMENTATION_DEAD":assignBuckets?bucket(raw.damage_factor!,null):"UNAVAILABLE",
        offense_bucket:assignBuckets?bucket(raw.offense_center!,cp?.offense??null):"UNAVAILABLE",
        expected_workload_bucket:assignBuckets?bucket(raw.expected_ip!,cp?.expected_workload??null):"UNAVAILABLE",
        actual_workload_bucket:assignBuckets?bucket(actualIp!,cp?.actual_workload??null):"UNAVAILABLE",
        pressure_shape:"PENDING_PAIR_CLASSIFICATION", cosign:raw.damage_factor===1?"INSTRUMENTATION_DEAD":"OBSERVED",
      });
    }
  }
  const byGame=new Map<string,StarterWindowObservation[]>(); for(const r of out){const a=byGame.get(r.game_id)??[];a.push(r);byGame.set(r.game_id,a);}
  for(const pair of byGame.values()) if(pair.length===2){const [a,b]=pair; const delta=Math.abs(a!.expected_runs-b!.expected_runs); const shape=delta>=0.75?"ONE_SIDED_PRESSURE":"TWO_SIDED_PRESSURE"; a!.pressure_shape=shape;b!.pressure_shape=shape;}
  return out;
}

function seeded(seed:number){return()=>{seed|=0;seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function slateBootstrap(rows: readonly StarterWindowObservation[]): [number|null,number|null] {
  const dates=[...new Set(rows.map(r=>r.date))]; if(rows.length<STARTER_WINDOW_MIN_INTERPRETABLE_N||dates.length<5)return[null,null];
  const groups=new Map(dates.map(d=>[d,rows.filter(r=>r.date===d)])); const rand=seeded(38012026); const vals:number[]=[];
  for(let k=0;k<2000;k++){const sample:StarterWindowObservation[]=[];for(let j=0;j<dates.length;j++) sample.push(...(groups.get(dates[Math.floor(rand()*dates.length)]!)??[])); const m=mean(sample.map(r=>r.error));if(m!==null)vals.push(m);}
  return [quantile(vals,.025),quantile(vals,.975)];
}

function metrics(rows: readonly StarterWindowObservation[]) {
  const errors=rows.map(r=>r.error), failures=rows.filter(r=>r.outcome==="FAILURE"); const [lo,hi]=slateBootstrap(rows);
  const quietFp=rows.filter(r=>r.expected_runs>=4&&r.actual_runs<=2).length/Math.max(rows.length,1);
  const detFn=rows.filter(r=>r.expected_runs<4&&r.actual_runs>=4).length/Math.max(rows.length,1);
  return { n:rows.length, slates:new Set(rows.map(r=>r.date)).size, bias:mean(errors), mae:mean(errors.map(Math.abs)), med:median(errors.map(Math.abs)), rmse:Math.sqrt(mean(errors.map(e=>e*e))??0),
    failure:failures.length/Math.max(rows.length,1), conditional:mean(failures.map(r=>r.actual_runs)), t4:rows.filter(r=>r.actual_runs>=4).length/Math.max(rows.length,1), t5:rows.filter(r=>r.actual_runs>=5).length/Math.max(rows.length,1), t6:rows.filter(r=>r.actual_runs>=6).length/Math.max(rows.length,1), quietFp,detFn,lo,hi };
}

function groupRows(rows: readonly StarterWindowObservation[]): Array<[string,string,StarterWindowObservation[],string]> {
  const dims: Array<[string,(r:StarterWindowObservation)=>string,string]> = [
    ["OVERALL",()=>"ALL","LIVE_VARYING"],["STARTER_QUALITY",r=>r.quality_bucket,"LIVE_VARYING"],
    ["TRAFFIC_MATCHUP",r=>r.traffic_bucket,"LIVE_VARYING"],["DAMAGE_MATCHUP",r=>r.damage_bucket,"INSTRUMENTATION_DEAD"],
    ["OPPONENT_OFFENSE",r=>r.offense_bucket,"LIVE_VARYING"],["EXPECTED_WORKLOAD",r=>r.expected_workload_bucket,"LIVE_VARYING"],
    ["ACTUAL_WORKLOAD_POSTGAME",r=>r.actual_workload_bucket,"OUTCOME_LABEL_ONLY"],["STARTER_ROLE",r=>r.opposing_role||"UNRESOLVED","LIVE_VARYING"],
    ["PRESSURE_SHAPE",r=>r.pressure_shape,"LIVE_VARYING"],["OUTCOME_STATE",r=>r.outcome,"OUTCOME_LABEL_ONLY"],
  ];
  const result:Array<[string,string,StarterWindowObservation[],string]>=[];
  for(const [d,fn,status] of dims){const map=new Map<string,StarterWindowObservation[]>();for(const r of rows){const c=fn(r);const a=map.get(c)??[];a.push(r);map.set(c,a);}for(const [c,a] of map)result.push([d,c,a,status]);}
  return result;
}

function summaryRows(rows: readonly StarterWindowObservation[], ts:string): unknown[][] {
  return groupRows(rows).map(([dimension,cohort,group,instrument])=>{const m=metrics(group);const interpretable=group.length>=STARTER_WINDOW_MIN_INTERPRETABLE_N&&instrument!=="INSTRUMENTATION_DEAD";
    return [dimension,cohort,m.n,m.slates,m.bias===null?"":round(m.bias),m.mae===null?"":round(m.mae),m.med===null?"":round(m.med),round(m.rmse),round(m.failure),m.conditional===null?"":round(m.conditional),round(m.t4),round(m.t5),round(m.t6),round(m.quietFp),round(m.detFn),m.lo??"",m.hi??"",m.lo===null?"CI_UNAVAILABLE":"SLATE_DATE_BLOCK_BOOTSTRAP_2000",interpretable?"INTERPRETABLE":"DESCRIPTIVE_ONLY",instrument,"UNAVAILABLE_NO_FROZEN_STARTER_PROBABILITIES",STARTER_WINDOW_COMMISSIONING_STATUS,instrument==="INSTRUMENTATION_DEAD"?"A zero contribution is not evidence that damage is unimportant; the active channel is inert.":"No coefficient or active consumer.",ts];});
}

function failureRows(rows: readonly StarterWindowObservation[], ts:string): unknown[][] {
  return groupRows(rows).filter(([d])=>!["ACTUAL_WORKLOAD_POSTGAME","OUTCOME_STATE"].includes(d)).map(([feature,b,group,instrument])=>{const m=metrics(group);const survival=group.filter(r=>r.outcome==="SURVIVAL").length/Math.max(group.length,1);return [feature,b,m.n,group.filter(r=>r.outcome==="FAILURE").length,round(m.failure),round(mean(group.map(r=>r.expected_runs))??0),round(mean(group.map(r=>r.actual_runs))??0),m.conditional===null?"":round(m.conditional),round(m.t4),round(m.t5),round(m.t6),"",round(survival),"",round(m.failure),"UNAVAILABLE_NO_FROZEN_STARTER_PROBABILITIES",group.length>=STARTER_WINDOW_MIN_INTERPRETABLE_N&&instrument!=="INSTRUMENTATION_DEAD"?"DESCRIPTIVE_DISCRIMINATION_INTERPRETABLE":"DESCRIPTIVE_ONLY",instrument,feature==="OVERALL"?"N/A":`PREDICTOR_TERTILES_DERIVED_THROUGH_${STARTER_WINDOW_BUCKET_DERIVATION_THROUGH_DATE}`,instrument==="INSTRUMENTATION_DEAD"?"Cannot attribute a null effect to a frozen-neutral channel.":"Failure = 4+ on-mound runs OR >=2 IP shortfall; survival = <=2 runs and reached expected IP within 0.5.",ts];});
}

const CASES: Record<string,{type:string;source:string;mechanism:string;grade:string;interpretation:string}> = {
  "20260919_OAK_CLE":{type:"UNDERPROJECTED_FAILURE_TAIL",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Cleveland attack potential against Lopez",grade:"PREDECLARED_MECHANISM_PARTIAL",interpretation:"Named attack path occurred; dual-starter severity exceeded the named path."},
  "20260919_MIA_SDP":{type:"UNDERPROJECTED_DUAL_FAILURE",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Perez walk/barrel/workload risk",grade:"PREDECLARED_MECHANISM_PARTIAL",interpretation:"Perez branch occurred; Mize failure materially added an unanticipated path."},
  "20260919_SFG_LAD":{type:"UNDERPROJECTED_ASYMMETRIC_FAILURE",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Dodgers one-team-clear path through Marte and SF depth",grade:"PREDECLARED_MECHANISM_PARTIAL",interpretation:"Named Dodgers path occurred; trusted Skubal suppression also failed."},
  "20260919_MIN_LAA":{type:"UNDERPROJECTED_SUPPRESSION_FAILURE",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Two-starter suppression",grade:"PREDECLARED_MECHANISM_MISS",interpretation:"Detmers did not deliver the named suppression state."},
  "20260919_CHC_CIN":{type:"INVERSE_OVERPROJECTED_CONTROL",source:"NO_VERIFIABLE_PREDECLARED_MECHANISM",mechanism:"",grade:"POSTHOC_ONLY",interpretation:"Inverse control only; no causal credit assigned."},
  "20260919_SEA_COL":{type:"INVERSE_CONVERSION_CONTROL",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Quintana shorter-workload branch",grade:"PREDECLARED_MECHANISM_PARTIAL",interpretation:"Short workload occurred; bullpen conversion did not."},
  "20260919_TOR_TEX":{type:"CANCELLATION_CONTROL",source:"USER_SUPPLIED_PREGAME_CASE_NOTE",mechanism:"Soriano failure branch",grade:"PREDECLARED_MECHANISM_PARTIAL",interpretation:"Named failure occurred; opposing chain suppression offset it."},
  "20260919_ATL_HOU":{type:"CANCELLATION_CONTROL",source:"NO_VERIFIABLE_PREDECLARED_MECHANISM",mechanism:"",grade:"POSTHOC_ONLY",interpretation:"Accurate total hid opposing phase errors; no causal credit assigned."},
};

function observationRow(r:StarterWindowObservation,ts:string):unknown[]{return [r.date,r.game_id,r.side,r.batting_team,r.opposing_team,r.opposing_starter,r.opposing_role,r.snapshot_ts,r.expected_ip,r.effective_ip,r.quality,r.quality_source,r.offense_center,r.traffic_factor,r.damage_factor,r.run_multiplier,r.projected_base,r.projected_traffic,r.projected_damage,r.expected_runs,r.actual_ip,r.actual_runs,r.error,r.abs_error,r.workload_shortfall,r.outcome,r.actual_runs>=4?"TRUE":"FALSE",r.actual_runs>=5?"TRUE":"FALSE",r.actual_runs>=6?"TRUE":"FALSE",r.quality_bucket,r.traffic_bucket,r.damage_bucket,r.offense_bucket,r.expected_workload_bucket,r.actual_workload_bucket,r.pressure_shape,r.cosign,r.lineup_status,r.matchup_status,"UNAVAILABLE_NO_FROZEN_STARTER_PROBABILITIES","FROZEN_PREGAME_PACKET_ONLY","MLB_STATSAPI_PBP_CURRENT_PITCHER_EXACT",STARTER_WINDOW_COMMISSIONING_STATUS,STARTER_WINDOW_ACTIVE_INPUT,ts];}
function replayRow(r:StarterWindowObservation,ts:string):unknown[]{return [r.date,r.game_id,r.side,r.snapshot_ts,r.opposing_starter,r.opposing_role,r.expected_runs,r.actual_runs,r.error,r.abs_error,r.outcome,r.actual_ip,r.expected_ip,r.workload_shortfall,r.quality_bucket,r.traffic_bucket,r.damage_bucket,r.offense_bucket,r.expected_workload_bucket,r.pressure_shape,"EXACT_FROZEN_LINEAGE_RESEARCH_ONLY",STARTER_WINDOW_ACTIVE_INPUT,ts];}
function pairRows(rows:readonly StarterWindowObservation[],ts:string):unknown[][]{return rows.filter(r=>CASES[r.game_id]).map(r=>{const c=CASES[r.game_id]!;return[r.date,r.game_id,c.type,r.side,r.opposing_starter,r.expected_runs,r.actual_runs,r.error,r.expected_ip,r.actual_ip,r.outcome,c.source,c.mechanism,c.grade,c.interpretation,"NO_COEFFICIENT_TUNING_CASE_NOT_USED_AS_TARGET",ts];});}

function featureGovRows(rows:readonly StarterWindowObservation[],ts:string):unknown[][] {
  const damageDead=rows.length>0&&rows.every(r=>r.damage_factor===1&&r.projected_damage===0);
  const common=(feature:string,source:string,availability:string,active:string,eligibility:string,status:string,fallback:string,notes:string)=>[feature,source,"FROZEN_PACKET_SNAPSHOT",availability,"POSTGAME_LABEL_JOIN_ONLY",active,eligibility,status,STARTER_WINDOW_COMMISSIONING_STATUS,fallback,notes,ts];
  return [
    common("BASELINE_STARTER_QUALITY","PREGAME_PACKET_HISTORY Away/Home_Starter_Quality + Source","KNOWN_PREGAME","YES_STARTER_RUN_PREVENTION","ELIGIBLE","LIVE_ACTIVE_VARYING","LEAGUE_NEUTRAL_IF_SOURCE_MISSING","One correlated FIP/ERA/xERA fallback family."),
    common("PROJECTED_WORKLOAD_LEASH","PREGAME_PACKET_HISTORY Expected_IP + Pitcher_Effective_IP","KNOWN_PREGAME","YES","ELIGIBLE","LIVE_ACTIVE_VARYING","ROLE/MISSING FALLBACK PRESERVED","SWE remains separate and is not blended."),
    common("TRAFFIC_EXPECTATION","PREGAME_PACKET_HISTORY Traffic_Matchup_Factor","KNOWN_PREGAME","YES","ELIGIBLE","LIVE_ACTIVE_VARYING","NEUTRAL_IF_PROFILE_UNAVAILABLE","Factor is an active signed component."),
    common("DAMAGE_EXPECTATION","PREGAME_PACKET_HISTORY Damage_Matchup_Factor + HR_XBH_Damage_Runs","KNOWN_PREGAME","FROZEN_ZERO_PENDING_PATCH_B","NOT_INTERPRETABLE",damageDead?"INSTRUMENTATION_DEAD":"LIVE_ACTIVE_VARYING","FAIL_CLOSED_NEUTRAL","Zero cannot be interpreted as evidence against damage."),
    common("CONVERSION_EXPECTATION","Derived frozen Traffic_Conversion_Runs side component","KNOWN_PREGAME","YES","PARTIAL_ONLY","INSTRUMENTATION_PARTIAL","NEUTRAL_WITHOUT_COSIGN","Raw conversion probability is not frozen; only signed run component is recoverable."),
    common("SURVIVAL_PROBABILITY","None at starter-side level","NOT_PERSISTED","NO","INELIGIBLE","MISSING","NO_SUBSTITUTION","SSAT is game-level family evidence and is not a starter-side calibrated probability here."),
    common("FAILURE_PROBABILITY","None at starter-side level","NOT_PERSISTED","NO","INELIGIBLE","MISSING","NO_SUBSTITUTION","No probability calibration metrics manufactured."),
    common("FAILURE_SEVERITY_TAIL","Exact PBP outcome label only","POSTGAME_LABEL_ONLY","NO","ELIGIBLE_AS_OUTCOME_ONLY","LIVE_OUTCOME_LABEL","NO_PREGAME_SUBSTITUTION","Observed 4+/5+/6+ rates diagnose tail compression; not a predictor."),
    common("OPPONENT_OFFENSIVE_SHAPE","PREGAME_PACKET_HISTORY Active_Offense_Center + pair pressure shape","KNOWN_PREGAME","YES_BASELINE","ELIGIBLE","LIVE_ACTIVE_VARYING","NEUTRAL_IF_MISSING","One-sided/two-sided shape uses only frozen expected starter windows."),
    common("K_WHIFF_BUCKET","No frozen starter-side K/whiff field in packet","NOT_PERSISTED","INDIRECT_ONLY","INELIGIBLE","MISSING","NO_BACKFILL","Cannot test low-K/high-whiff interactions without a frozen field."),
    common("BB_RAW_BUCKET","No frozen starter-side BB field in packet","NOT_PERSISTED","INDIRECT_TRAFFIC_FACTOR_ONLY","INELIGIBLE","MISSING","NO_BACKFILL","Traffic factor may vary but cannot be decomposed into raw BB causes."),
    common("BARREL_HARD_HIT_BUCKET","Patch B factual rows unmapped; packet damage channel frozen neutral","NOT_ACTIVE_MAPPED","NO","INELIGIBLE",damageDead?"INSTRUMENTATION_DEAD":"INSTRUMENTATION_PARTIAL","NO_IMPUTED_SIGNAL","Patch B remains Active_Input=NO and NOT_MAPPED_PENDING_COMMISSIONING."),
    common("HANDEDNESS_MATCHUP","No direct side-level handedness field in eligible historical packets","PARTIAL_NOT_UNIFORM","COARSE_PATH_EMBEDDED","DESCRIPTIVE_UNAVAILABLE","INSTRUMENTATION_PARTIAL","NO_RECONSTRUCTION","BVH is shadow-only; historical player identities are incomplete."),
  ];
}

async function ensure(workbookId:string,sheets:Array<[string,number]>){const existing=new Set((await getSpreadsheetSheetProperties(workbookId)).map(s=>s.title));for(const [name] of sheets)if(!existing.has(name)){await addSheet(workbookId,name);existing.add(name);}await Promise.all(sheets.map(([name,n])=>expandSheetColumns(workbookId,name,n)));}
async function optional(workbookId:string,range:string,warnings:string[]){try{return ((await readRange(workbookId,range)).values??[]) as unknown[][];}catch(e){warnings.push(`MISSING_STARTER_WINDOW_SOURCE:${range}:${e instanceof Error?e.message:String(e)}`);return[];}}

export interface StarterWindowDiscriminationResult { status:"success"|"failure"; replay_timestamp_utc:string; eligible_side_rows:number; eligible_games:number; summary_rows_written:number; pair_rows_written:number; exact_lineage_pct:number; active_input:"NO"; commissioning_status:string; warnings:string[]; errors:string[]; }

export async function runStarterWindowDiscrimination(options:{workbookId?:string}={}):Promise<StarterWindowDiscriminationResult>{
  const workbookId=options.workbookId??WORKBOOK_ID, ts=new Date().toISOString(), warnings:string[]=[], errors:string[]=[];
  try{
    const [packets,coverage]=await Promise.all([optional(workbookId,`${PREGAME_PACKET_HISTORY_SHEET}!${pregamePacketHistoryRange(10000)}`,warnings),optional(workbookId,"BULLPEN_PHASE_COVERAGE_V1!A1:AZ10000",warnings)]);
    const cuts=deriveCutpoints(packets,coverage); const rows=parseStarterWindowObservations(packets,coverage,cuts,true);
    const sheets:Array<[string,number]>=[[STARTER_WINDOW_ERROR_SHEET,STARTER_WINDOW_ERROR_HEADERS.length],[STARTER_WINDOW_ERROR_SUMMARY_SHEET,STARTER_WINDOW_ERROR_SUMMARY_HEADERS.length],[STARTER_WINDOW_FAILURE_BUCKETS_SHEET,STARTER_WINDOW_FAILURE_BUCKETS_HEADERS.length],[STARTER_WINDOW_PAIR_AUDIT_SHEET,STARTER_WINDOW_PAIR_AUDIT_HEADERS.length],[STARTER_WINDOW_FEATURE_GOV_SHEET,STARTER_WINDOW_FEATURE_GOV_HEADERS.length],[STARTER_WINDOW_REPLAY_SHEET,STARTER_WINDOW_REPLAY_HEADERS.length]];
    await ensure(workbookId,sheets); await Promise.all(sheets.map(([name])=>clearRange(workbookId,`${name}!A1:AZ10000`)));
    const summaries=summaryRows(rows,ts), pairs=pairRows(rows,ts);
    await Promise.all([
      writeRange(workbookId,`${STARTER_WINDOW_ERROR_SHEET}!A1`,[Array.from(STARTER_WINDOW_ERROR_HEADERS),...rows.map(r=>observationRow(r,ts))]),
      writeRange(workbookId,`${STARTER_WINDOW_ERROR_SUMMARY_SHEET}!A1`,[Array.from(STARTER_WINDOW_ERROR_SUMMARY_HEADERS),...summaries]),
      writeRange(workbookId,`${STARTER_WINDOW_FAILURE_BUCKETS_SHEET}!A1`,[Array.from(STARTER_WINDOW_FAILURE_BUCKETS_HEADERS),...failureRows(rows,ts)]),
      writeRange(workbookId,`${STARTER_WINDOW_PAIR_AUDIT_SHEET}!A1`,[Array.from(STARTER_WINDOW_PAIR_AUDIT_HEADERS),...pairs]),
      writeRange(workbookId,`${STARTER_WINDOW_FEATURE_GOV_SHEET}!A1`,[Array.from(STARTER_WINDOW_FEATURE_GOV_HEADERS),...featureGovRows(rows,ts)]),
      writeRange(workbookId,`${STARTER_WINDOW_REPLAY_SHEET}!A1`,[Array.from(STARTER_WINDOW_REPLAY_HEADERS),...rows.map(r=>replayRow(r,ts))]),
    ]);
    logger.info({side_rows:rows.length,games:new Set(rows.map(r=>r.game_id)).size},"MODULE_38: starter-window discrimination audit written");
    return{status:"success",replay_timestamp_utc:ts,eligible_side_rows:rows.length,eligible_games:new Set(rows.map(r=>r.game_id)).size,summary_rows_written:summaries.length,pair_rows_written:pairs.length,exact_lineage_pct:rows.length?100:0,active_input:"NO",commissioning_status:STARTER_WINDOW_COMMISSIONING_STATUS,warnings,errors};
  }catch(e){const m=e instanceof Error?e.message:String(e);errors.push(m);logger.error({err:m},"MODULE_38 failed");return{status:"failure",replay_timestamp_utc:ts,eligible_side_rows:0,eligible_games:0,summary_rows_written:0,pair_rows_written:0,exact_lineage_pct:0,active_input:"NO",commissioning_status:STARTER_WINDOW_COMMISSIONING_STATUS,warnings,errors};}
}
