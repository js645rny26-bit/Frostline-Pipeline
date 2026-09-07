/**
 * Module 02g: Workload State Shadow
 *
 * A frozen, price-blind description of the likely starter workload. It is a
 * research object only: no field here changes active Expected_IP, projection,
 * board authorization, market comparison, or vehicle selection.
 *
 * The first version uses only official MLB game logs through the prior day and
 * the already-classified pitching role. Transaction, rehabilitation, and team
 * handling evidence is deliberately reported as unavailable until an explicit
 * source is connected; it is never converted into a neutral signal.
 */

import type { StarterOuting } from "./module04d_starterPrevOuting.js";
import type {
  PitcherGameLogAppearance,
  PitcherWorkloadData,
  WorkloadResult,
} from "./module02_pitcherWorkload.js";
import type { NormalizedGame } from "./module06_normalization.js";

export type WorkloadStateStatus = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
export type WorkloadConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";

export interface WorkloadState {
  workload_state_status: WorkloadStateStatus;
  projected_ip_shadow: number | null;
  projected_bf_shadow: number | null;
  workload_confidence: WorkloadConfidence;
  role_state: string;
  rest_state: string;
  recent_load_state: string;
  team_handling_state: "NOT_MODELED";
  workload_source_status: string;
  workload_notes: string;
}

export interface WorkloadGameState {
  away: WorkloadState;
  home: WorkloadState;
}

const UNAVAILABLE = (roleState = "UNRESOLVED"): WorkloadState => ({
  workload_state_status: "UNAVAILABLE",
  projected_ip_shadow: null,
  projected_bf_shadow: null,
  workload_confidence: "UNAVAILABLE",
  role_state: roleState,
  rest_state: "UNAVAILABLE",
  recent_load_state: "UNAVAILABLE",
  team_handling_state: "NOT_MODELED",
  workload_source_status: "WORKLOAD_EVIDENCE_UNAVAILABLE",
  workload_notes: "No pregame-safe MLB game-log workload evidence for this expected pitcher.",
});

function round(value: number, decimals = 2): number {
  return Number.parseFloat(value.toFixed(decimals));
}

function baselineIp(role: string, currentExpectedIp: number | null): number | null {
  if (currentExpectedIp !== null && Number.isFinite(currentExpectedIp)) return currentExpectedIp;
  if (role === "OPENER") return 1.2;
  if (role === "BULK" || role === "PIGGYBACK_SECONDARY") return 3;
  if (role === "CONVENTIONAL_STARTER") return 6;
  return null;
}

function relevantAppearances(
  role: string,
  appearances: PitcherGameLogAppearance[],
): PitcherGameLogAppearance[] {
  const starts = appearances.filter((appearance) => appearance.games_started > 0);
  // A scheduled conventional starter is evaluated against previous starts. A
  // planned opener/bulk arm can legitimately be assessed from its appearances.
  return role === "CONVENTIONAL_STARTER" && starts.length > 0 ? starts : appearances;
}

function weightedMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const weights = [0.5, 0.3, 0.2, 0.1, 0.05];
  const used = values.slice(0, weights.length);
  const denominator = used.reduce((sum, _, index) => sum + weights[index]!, 0);
  return denominator === 0
    ? null
    : used.reduce((sum, value, index) => sum + value * weights[index]!, 0) / denominator;
}

function restState(daysRest: number | null): { state: string; adjustment: number } {
  if (daysRest === null) return { state: "REST_UNAVAILABLE", adjustment: 0 };
  if (daysRest <= 3) return { state: "SHORT_REST", adjustment: -0.5 };
  if (daysRest >= 11) return { state: "RETURN_FROM_EXTENDED_REST", adjustment: -0.75 };
  if (daysRest >= 7) return { state: "EXTRA_REST", adjustment: 0 };
  return { state: "STANDARD_REST", adjustment: 0 };
}

function recentLoadState(appearance: PitcherGameLogAppearance | undefined): string {
  if (!appearance) return "RECENT_LOAD_UNAVAILABLE";
  if (appearance.pitch_count === null) return "RECENT_PITCH_COUNT_UNAVAILABLE";
  if (appearance.pitch_count >= 105) return "HEAVY_PREVIOUS_OUTING";
  if (appearance.pitch_count <= 55) return "LIGHT_PREVIOUS_OUTING";
  return "NORMAL_PREVIOUS_OUTING";
}

function clampByRole(value: number, role: string): number {
  if (role === "OPENER") return Math.max(0.7, Math.min(2.25, value));
  if (role === "BULK" || role === "PIGGYBACK_SECONDARY") return Math.max(1.5, Math.min(5, value));
  return Math.max(3, Math.min(7.5, value));
}

function daysBetween(lastDate: string | undefined, gameDate: string): number | null {
  if (!lastDate) return null;
  const last = Date.parse(`${lastDate}T12:00:00.000Z`);
  const game = Date.parse(`${gameDate}T12:00:00.000Z`);
  return Number.isFinite(last) && Number.isFinite(game)
    ? Math.round((game - last) / 86_400_000)
    : null;
}

export function buildWorkloadState(
  role: string,
  currentExpectedIp: number | null,
  gameDate: string,
  workload: PitcherWorkloadData | undefined,
  previousOuting: StarterOuting | undefined,
): WorkloadState {
  const baseline = baselineIp(role, currentExpectedIp);
  if (!baseline || !workload || workload.status === "fetch_error") return UNAVAILABLE(role);

  // Defense in depth: the acquisition module already applies date-minus-one,
  // but a reused or fixture workload object still cannot leak same-day or
  // future appearances into a prospective packet.
  const pregameAppearances = (workload.recent_appearances ?? []).filter(
    (appearance) => appearance.date < gameDate,
  );
  const appearances = relevantAppearances(role, pregameAppearances).slice(0, 5);
  if (appearances.length === 0) return {
    ...UNAVAILABLE(role),
    workload_source_status: `MLB_GAME_LOG_NO_ELIGIBLE_APPEARANCES_THROUGH_${workload.status}`,
    workload_notes: "Expected pitcher has no role-relevant pregame-safe game-log appearances; no shadow workload is invented.",
  };

  const recentIp = weightedMean(appearances.map((appearance) => appearance.innings));
  const latest = appearances[0];
  const daysRest = previousOuting?.days_rest ?? daysBetween(latest?.date, gameDate);
  const rest = restState(daysRest);
  // Five relevant appearances earns full history weight. Smaller samples remain
  // shrunk to the active role baseline rather than becoming a new talent claim.
  const historyWeight = Math.min(appearances.length / 5, 1);
  const rawShadowIp = baseline * (1 - historyWeight) + (recentIp ?? baseline) * historyWeight + rest.adjustment;
  const projectedIp = round(clampByRole(rawShadowIp, role));
  const confidence: WorkloadConfidence = appearances.length >= 5 && daysRest !== null
    ? "HIGH"
    : appearances.length >= 3
      ? "MEDIUM"
      : "LOW";
  // We have official game-log evidence, but transaction/rehab, role-change,
  // and team-handling sources are intentionally not connected yet. Do not
  // label the composite state complete merely because one evidence family is.
  const status: WorkloadStateStatus = "PARTIAL";
  const latestPitchCount = latest?.pitch_count ?? null;
  const sourceStatus = `MLB_STATS_API_GAME_LOG_THROUGH_${workload.status === "active" ? "PRIOR_DAY" : "WIDE_WINDOW"}_NO_TRANSACTION_OR_TEAM_HANDLING_SOURCE`;
  return {
    workload_state_status: status,
    projected_ip_shadow: projectedIp,
    projected_bf_shadow: round(projectedIp * 4.25),
    workload_confidence: confidence,
    role_state: role,
    rest_state: rest.state,
    recent_load_state: recentLoadState(latest),
    team_handling_state: "NOT_MODELED",
    workload_source_status: sourceStatus,
    workload_notes:
      `baseline_ip=${baseline}; role_relevant_appearances=${appearances.length}; ` +
      `weighted_recent_ip=${recentIp === null ? "UNAVAILABLE" : round(recentIp)}; ` +
      `latest_pitch_count=${latestPitchCount ?? "UNAVAILABLE"}; days_rest=${daysRest ?? "UNAVAILABLE"}; ` +
      "transaction_rehab_role_change=UNAVAILABLE; team_handling=NOT_MODELED",
  };
}

export function buildWorkloadGameStates(
  games: NormalizedGame[],
  workload: WorkloadResult,
  previousOutings: ReadonlyMap<number, StarterOuting> = new Map(),
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
        game.date,
        away.player_id === null ? undefined : workloadByPitcher.get(away.player_id),
        away.player_id === null ? undefined : previousOutings.get(away.player_id),
      ),
      home: buildWorkloadState(
        home.role,
        home.expected_innings,
        game.date,
        home.player_id === null ? undefined : workloadByPitcher.get(home.player_id),
        home.player_id === null ? undefined : previousOutings.get(home.player_id),
      ),
    });
  }
  return states;
}
