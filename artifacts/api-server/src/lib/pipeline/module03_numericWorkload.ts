/**
 * Module 03 numeric starter-workload candidate.
 *
 * This is deliberately narrower than role classification.  Role remains a
 * descriptive label; official cutoff-safe MLB game-log evidence estimates the
 * workload.  Role supplies only the prior, bounds, and missing-data fallback.
 */

import type {
  PitcherGameLogAppearance,
  PitcherWorkloadData,
} from "./module02_pitcherWorkload.js";

export const NUMERIC_WORKLOAD_VERSION = "PITCHER_SPECIFIC_WORKLOAD_CANDIDATE_V1";
export const NUMERIC_WORKLOAD_RECENCY_WEIGHTS = [0.5, 0.3, 0.2, 0.1, 0.05] as const;

export type NumericWorkloadStatus =
  | "PITCHER_SPECIFIC"
  | "ROLE_FALLBACK_NO_USABLE_HISTORY";

export interface NumericWorkloadEstimate {
  expected_pitches: number;
  expected_innings: number;
  status: NumericWorkloadStatus;
  relevant_appearances: number;
  recent_ip: number | null;
  recent_pitches: number | null;
  ip_standard_deviation: number | null;
  pitch_standard_deviation: number | null;
  history_weight: number;
  days_rest: number | null;
  rest_state: string;
  notes: string;
}
function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function weightedMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const used = values.slice(0, NUMERIC_WORKLOAD_RECENCY_WEIGHTS.length);
  const denominator = used.reduce(
    (sum, _value, index) => sum + NUMERIC_WORKLOAD_RECENCY_WEIGHTS[index]!,
    0,
  );
  return denominator === 0
    ? null
    : used.reduce(
      (sum, value, index) => sum + value * NUMERIC_WORKLOAD_RECENCY_WEIGHTS[index]!,
      0,
    ) / denominator;
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function daysBetween(lastDate: string | undefined, gameDate: string): number | null {
  if (!lastDate) return null;
  const last = Date.parse(`${lastDate}T12:00:00.000Z`);
  const game = Date.parse(`${gameDate}T12:00:00.000Z`);
  return Number.isFinite(last) && Number.isFinite(game)
    ? Math.round((game - last) / 86_400_000)
    : null;
}

function restState(daysRest: number | null): { state: string; inningsAdjustment: number } {
  if (daysRest === null) return { state: "REST_UNAVAILABLE", inningsAdjustment: 0 };
  if (daysRest <= 3) return { state: "SHORT_REST", inningsAdjustment: -0.5 };
  if (daysRest >= 11) return { state: "RETURN_FROM_EXTENDED_REST", inningsAdjustment: -0.75 };
  if (daysRest >= 7) return { state: "EXTRA_REST", inningsAdjustment: 0 };
  return { state: "STANDARD_REST", inningsAdjustment: 0 };
}

function clampByRole(value: number, role: string): number {
  if (role === "OPENER") return Math.max(0.7, Math.min(2.25, value));
  if (role === "BULK" || role === "PIGGYBACK_SECONDARY") return Math.max(1.5, Math.min(5, value));
  return Math.max(3, Math.min(7.5, value));
}

function relevantAppearances(
  role: string,
  appearances: readonly PitcherGameLogAppearance[],
): PitcherGameLogAppearance[] {
  const starts = appearances.filter((appearance) => appearance.games_started > 0);
  // Preserve the already-commissioned workload-state semantics: a scheduled
  // conventional starter is assessed from previous starts. Planned opener or
  // bulk usage can legitimately include non-start appearances.
  return (role === "CONVENTIONAL_STARTER" && starts.length > 0 ? starts : appearances)
    .slice(0, NUMERIC_WORKLOAD_RECENCY_WEIGHTS.length);
}

/**
 * Estimate the numeric workload from the source already consumed by Module 03.
 * The result is deterministic and has no outcome, market, or environment input.
 */
export function estimatePitcherSpecificWorkload(
  role: string,
  rolePriorPitches: number,
  rolePriorInnings: number,
  gameDate: string,
  dataThroughDate: string,
  workload: PitcherWorkloadData | undefined,
): NumericWorkloadEstimate {
  const fallback = (reason: string): NumericWorkloadEstimate => ({
    expected_pitches: rolePriorPitches,
    expected_innings: rolePriorInnings,
    status: "ROLE_FALLBACK_NO_USABLE_HISTORY",
    relevant_appearances: 0,
    recent_ip: null,
    recent_pitches: null,
    ip_standard_deviation: null,
    pitch_standard_deviation: null,
    history_weight: 0,
    days_rest: null,
    rest_state: "REST_UNAVAILABLE",
    notes: reason,
  });

  if (!workload || workload.status === "fetch_error") {
    return fallback("Official MLB game-log workload unavailable; declared role/return prior retained.");
  }

  const admissible = (workload.recent_appearances ?? [])
    .filter((appearance) => appearance.date < gameDate && appearance.date <= dataThroughDate)
    .sort((left, right) => right.date.localeCompare(left.date));
  const relevant = relevantAppearances(role, admissible);
  const ipValues = relevant.map((appearance) => appearance.innings).filter(Number.isFinite);
  const pitchValues = relevant
    .map((appearance) => appearance.pitch_count)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const recentIp = weightedMean(ipValues);
  const recentPitches = weightedMean(pitchValues);
  if (recentIp === null) {
    return fallback("No role-relevant pregame-safe appearances with usable innings; declared role/return prior retained.");
  }

  const n = relevant.length;
  const historyWeight = Math.min(n / NUMERIC_WORKLOAD_RECENCY_WEIGHTS.length, 1);
  const latest = relevant[0];
  const daysRest = daysBetween(latest?.date, gameDate);
  const rest = restState(daysRest);
  const expectedInnings = clampByRole(
    rolePriorInnings * (1 - historyWeight)
      + recentIp * historyWeight
      + rest.inningsAdjustment,
    role,
  );
  // Fifteen pitches per inning is the existing Module 03 conversion used by
  // its return branch. Here it only translates the existing rest constraint;
  // the center of the pitch estimate comes from actual recent pitch counts.
  const expectedPitches = Math.max(1, Math.round(
    rolePriorPitches * (1 - historyWeight)
      + (recentPitches ?? rolePriorPitches) * historyWeight
      + rest.inningsAdjustment * 15,
  ));
  const ipSd = standardDeviation(ipValues);
  const pitchSd = standardDeviation(pitchValues);

  return {
    expected_pitches: expectedPitches,
    expected_innings: round(expectedInnings),
    status: "PITCHER_SPECIFIC",
    relevant_appearances: n,
    recent_ip: round(recentIp),
    recent_pitches: recentPitches === null ? null : round(recentPitches),
    ip_standard_deviation: ipSd === null ? null : round(ipSd),
    pitch_standard_deviation: pitchSd === null ? null : round(pitchSd),
    history_weight: round(historyWeight, 4),
    days_rest: daysRest,
    rest_state: rest.state,
    notes:
      `source=MLB_STATS_API_GAME_LOG; n=${n}; recent_ip=${round(recentIp)}; `
      + `recent_pitches=${recentPitches === null ? "UNAVAILABLE" : round(recentPitches)}; `
      + `history_weight=${round(historyWeight, 4)}; ip_sd=${ipSd === null ? "UNAVAILABLE" : round(ipSd)}; `
      + `pitch_sd=${pitchSd === null ? "UNAVAILABLE" : round(pitchSd)}; `
      + `days_rest=${daysRest ?? "UNAVAILABLE"}; rest_state=${rest.state}; role=${role}`,
  };
}
