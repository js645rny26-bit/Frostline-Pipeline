/**
 * Module 02g: pitcher-specific workload commissioning shadow.
 *
 * The active Module 03 workload remains unchanged. This object independently
 * freezes the candidate estimate and its source evidence so a prospective
 * settlement can adjudicate it without changing a projection or decision.
 */

import type { PitcherWorkloadData, WorkloadResult } from "./module02_pitcherWorkload.js";
import {
  estimatePitcherSpecificWorkload,
  NUMERIC_WORKLOAD_VERSION,
} from "./module03_numericWorkload.js";
import type { NormalizedGame } from "./module06_normalization.js";

export type WorkloadStateStatus = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
export type WorkloadConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";

export interface WorkloadState {
  workload_state_status: WorkloadStateStatus;
  workload_candidate_version: string;
  workload_candidate_status: string;
  projected_ip_shadow: number | null;
  projected_pitches_shadow: number | null;
  projected_bf_shadow: number | null;
  workload_confidence: WorkloadConfidence;
  role_state: string;
  rest_state: string;
  recent_load_state: string;
  team_handling_state: "NOT_MODELED";
  workload_source_status: string;
  workload_data_through_date: string;
  workload_relevant_appearances: number | null;
  workload_recent_ip: number | null;
  workload_recent_pitches: number | null;
  workload_ip_sd: number | null;
  workload_pitch_sd: number | null;
  workload_history_weight: number | null;
  workload_notes: string;
}

export interface WorkloadGameState {
  away: WorkloadState;
  home: WorkloadState;
}

const unavailable = (roleState = "UNRESOLVED", dataThroughDate = ""): WorkloadState => ({
  workload_state_status: "UNAVAILABLE",
  workload_candidate_version: NUMERIC_WORKLOAD_VERSION,
  workload_candidate_status: "ROLE_FALLBACK_NO_USABLE_HISTORY",
  projected_ip_shadow: null,
  projected_pitches_shadow: null,
  projected_bf_shadow: null,
  workload_confidence: "UNAVAILABLE",
  role_state: roleState,
  rest_state: "UNAVAILABLE",
  recent_load_state: "UNAVAILABLE",
  team_handling_state: "NOT_MODELED",
  workload_source_status: "WORKLOAD_EVIDENCE_UNAVAILABLE",
  workload_data_through_date: dataThroughDate,
  workload_relevant_appearances: null,
  workload_recent_ip: null,
  workload_recent_pitches: null,
  workload_ip_sd: null,
  workload_pitch_sd: null,
  workload_history_weight: null,
  workload_notes: "No pregame-safe MLB game-log workload evidence for this expected pitcher.",
});

function round(value: number, decimals = 2): number {
  return Number.parseFloat(value.toFixed(decimals));
}

function recentLoadState(pitchCount: number | null): string {
  if (pitchCount === null) return "RECENT_PITCH_COUNT_UNAVAILABLE";
  if (pitchCount >= 105) return "HEAVY_RECENT_WORKLOAD";
  if (pitchCount <= 55) return "LIGHT_RECENT_WORKLOAD";
  return "NORMAL_RECENT_WORKLOAD";
}

/** Build one candidate without mutating or replacing active Expected_IP. */
export function buildWorkloadState(
  role: string,
  activeExpectedIp: number | null,
  activeExpectedPitches: number | null,
  gameDate: string,
  dataThroughDate: string,
  workload: PitcherWorkloadData | undefined,
): WorkloadState {
  if (
    activeExpectedIp === null
    || activeExpectedPitches === null
    || !Number.isFinite(activeExpectedIp)
    || !Number.isFinite(activeExpectedPitches)
  ) return unavailable(role, dataThroughDate);

  const estimate = estimatePitcherSpecificWorkload(
    role,
    activeExpectedPitches,
    activeExpectedIp,
    gameDate,
    dataThroughDate,
    workload,
  );
  if (estimate.status !== "PITCHER_SPECIFIC") {
    return {
      ...unavailable(role, dataThroughDate),
      workload_candidate_status: estimate.status,
      projected_ip_shadow: estimate.expected_innings,
      projected_pitches_shadow: estimate.expected_pitches,
      projected_bf_shadow: round(estimate.expected_innings * 4.25),
      rest_state: estimate.rest_state,
      workload_relevant_appearances: estimate.relevant_appearances,
      workload_history_weight: estimate.history_weight,
      workload_notes: estimate.notes,
    };
  }

  const confidence: WorkloadConfidence = estimate.relevant_appearances >= 5 && estimate.days_rest !== null
    ? "HIGH"
    : estimate.relevant_appearances >= 3
      ? "MEDIUM"
      : "LOW";
  return {
    workload_state_status: "PARTIAL",
    workload_candidate_version: NUMERIC_WORKLOAD_VERSION,
    workload_candidate_status: estimate.status,
    projected_ip_shadow: estimate.expected_innings,
    projected_pitches_shadow: estimate.expected_pitches,
    projected_bf_shadow: round(estimate.expected_innings * 4.25),
    workload_confidence: confidence,
    role_state: role,
    rest_state: estimate.rest_state,
    recent_load_state: recentLoadState(estimate.recent_pitches),
    team_handling_state: "NOT_MODELED",
    workload_source_status: "MLB_STATS_API_GAME_LOG_D_MINUS_1_NO_TRANSACTION_OR_TEAM_HANDLING_SOURCE",
    workload_data_through_date: dataThroughDate,
    workload_relevant_appearances: estimate.relevant_appearances,
    workload_recent_ip: estimate.recent_ip,
    workload_recent_pitches: estimate.recent_pitches,
    workload_ip_sd: estimate.ip_standard_deviation,
    workload_pitch_sd: estimate.pitch_standard_deviation,
    workload_history_weight: estimate.history_weight,
    workload_notes: `${estimate.notes}; transaction_rehab_role_change=UNAVAILABLE; team_handling=NOT_MODELED`,
  };
}

export function buildWorkloadGameStates(
  games: NormalizedGame[],
  workload: WorkloadResult,
): Map<string, WorkloadGameState> {
  const workloadByPitcher = new Map(workload.pitchers.map((pitcher) => [pitcher.playerId, pitcher]));
  const states = new Map<string, WorkloadGameState>();
  for (const game of games) {
    const away = game.away_pitcher;
    const home = game.home_pitcher;
    states.set(game.legacy_game_id, {
      away: buildWorkloadState(
        away.role,
        away.expected_innings,
        away.expected_pitches,
        game.date,
        workload.data_through_date,
        away.player_id === null ? undefined : workloadByPitcher.get(away.player_id),
      ),
      home: buildWorkloadState(
        home.role,
        home.expected_innings,
        home.expected_pitches,
        game.date,
        workload.data_through_date,
        home.player_id === null ? undefined : workloadByPitcher.get(home.player_id),
      ),
    });
  }
  return states;
}
