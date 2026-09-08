/**
 * Module 02i: Starter Workload Estimator V1 (SWE)
 *
 * A price-blind, source-only innings estimator.  It is intentionally a
 * shadow instrument: active Expected_IP, survival, collision, projection,
 * authorization, and the board do not import this module.  The implementation
 * follows the frozen v1 protocol; changing a formula requires a new version.
 */

import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import type { NormalizedGame } from "./module06_normalization.js";

export const SWE_VERSION = "1.0.0";
export const SWE_WINDOW_WEIGHTS = { L3: 0.5, L5: 0.3, SEASON: 0.2 } as const;
export const SWE_SHRINKAGE_K = 4;
export const SWE_OPENER_BOUND_IP = 2.5;

export type SWEStatus =
  | "ESTIMATED"
  | "SHRUNK"
  | "ROLE_BOUNDED"
  | "INSUFFICIENT_HISTORY"
  | "OUTS_UNRESOLVED";

export interface SWEAppearance {
  game_date: string;
  game_pk: number;
  pitcher_id: number;
  pitches_thrown: number;
  batters_faced: number;
  outs_recorded: number | null;
  innings_pitched: number | null;
  max_thruorder: number | null;
  started_game: boolean;
  pitcher_days_since_prev_game: number | null;
  outs_status: "AVAILABLE" | "OUTS_UNRESOLVED";
}

export interface SWEStarterState {
  expected_ip: number | null;
  status: SWEStatus;
  n_starts: number;
  l3_ip: number | null;
  l5_ip: number | null;
  season_ip: number | null;
  shrinkage_weight: number | null;
  role_prior_used: number | null;
  data_through_date: string;
  role: string;
  notes: string;
}

export interface SWEGameState {
  away: SWEStarterState;
  home: SWEStarterState;
}

interface PlateAppearance {
  game_date: string;
  game_pk: number;
  pitcher_id: number;
  inning: number;
  inning_topbot: string;
  at_bat_number: number;
  outs_when_up: number | null;
  max_thruorder: number | null;
  pitcher_days_since_prev_game: number | null;
  pitches_thrown: number;
}

function rawNumber(event: SavantPitchLevelEvent, name: string): number | null {
  const value = Number.parseFloat(String(event.raw.get(name) ?? "").trim());
  return Number.isFinite(value) ? value : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function appearanceKey(event: SavantPitchLevelEvent): string | null {
  const inning = rawNumber(event, "inning");
  const atBat = rawNumber(event, "at_bat_number");
  const half = String(event.raw.get("inning_topbot") ?? "").trim();
  return inning === null || atBat === null || !half
    ? null
    : `${event.game_pk}|${inning}|${half}|${atBat}`;
}

/**
 * Reconstruct pitcher appearances from raw pitch events.  Outs deliberately
 * use the next plate appearance's `outs_when_up`, never a guessed event map.
 */
export function deriveSWEAppearances(
  events: readonly SavantPitchLevelEvent[],
  dataThroughDate: string,
): SWEAppearance[] {
  const plateAppearances = new Map<string, PlateAppearance>();
  for (const event of events) {
    if (event.game_date > dataThroughDate) continue;
    const key = appearanceKey(event);
    if (!key) continue;
    const inning = rawNumber(event, "inning");
    const atBat = rawNumber(event, "at_bat_number");
    const half = String(event.raw.get("inning_topbot") ?? "").trim();
    if (inning === null || atBat === null || !half) continue;
    const existing = plateAppearances.get(key);
    if (existing) {
      existing.pitches_thrown++;
      continue;
    }
    plateAppearances.set(key, {
      game_date: event.game_date,
      game_pk: event.game_pk,
      pitcher_id: event.pitcher,
      inning,
      inning_topbot: half,
      at_bat_number: atBat,
      outs_when_up: rawNumber(event, "outs_when_up"),
      max_thruorder: rawNumber(event, "n_throughorder_pitcher"),
      pitcher_days_since_prev_game: rawNumber(event, "pitcher_days_since_prev_game"),
      pitches_thrown: 1,
    });
  }

  const byGame = new Map<number, PlateAppearance[]>();
  for (const pa of plateAppearances.values()) {
    const list = byGame.get(pa.game_pk) ?? [];
    list.push(pa);
    byGame.set(pa.game_pk, list);
  }

  const aggregates = new Map<string, {
    game_date: string; game_pk: number; pitcher_id: number; pitches: number;
    batters: number; outs: number; unresolved: boolean; maxTto: number | null;
    daysSincePrev: number | null; started: boolean;
  }>();
  for (const gamePas of byGame.values()) {
    gamePas.sort((a, b) => a.at_bat_number - b.at_bat_number || a.inning - b.inning);
    const firstPaByHalf = new Map<string, number>();
    for (const pa of gamePas) {
      if (pa.inning === 1 && !firstPaByHalf.has(pa.inning_topbot)) {
        firstPaByHalf.set(pa.inning_topbot, pa.at_bat_number);
      }
    }
    for (let index = 0; index < gamePas.length; index++) {
      const pa = gamePas[index]!;
      const next = gamePas[index + 1];
      const nextSameHalf = next
        && next.inning === pa.inning
        && next.inning_topbot === pa.inning_topbot;
      // A later PA in the other half (or a later inning) proves this half
      // inning ended and therefore ends at three outs. A final-game PA has no
      // such proof: it may be a walkoff, so it remains unresolved rather than
      // being assigned a fabricated third out.
      const endingOuts = nextSameHalf
        ? next!.outs_when_up
        : next ? 3 : null;
      const paOuts = pa.outs_when_up === null || endingOuts === null
        ? null
        : endingOuts - pa.outs_when_up;
      const key = `${pa.game_date}|${pa.game_pk}|${pa.pitcher_id}`;
      const aggregate = aggregates.get(key) ?? {
        game_date: pa.game_date, game_pk: pa.game_pk, pitcher_id: pa.pitcher_id,
        pitches: 0, batters: 0, outs: 0, unresolved: false, maxTto: null,
        daysSincePrev: null, started: false,
      };
      aggregate.pitches += pa.pitches_thrown;
      aggregate.batters++;
      if (paOuts === null || paOuts < 0 || paOuts > 3) aggregate.unresolved = true;
      else aggregate.outs += paOuts;
      aggregate.maxTto = aggregate.maxTto === null
        ? pa.max_thruorder
        : pa.max_thruorder === null ? aggregate.maxTto : Math.max(aggregate.maxTto, pa.max_thruorder);
      aggregate.daysSincePrev ??= pa.pitcher_days_since_prev_game;
      aggregate.started ||= pa.inning === 1 && firstPaByHalf.get(pa.inning_topbot) === pa.at_bat_number;
      aggregates.set(key, aggregate);
    }
  }
  return [...aggregates.values()]
    .map((appearance): SWEAppearance => ({
      game_date: appearance.game_date,
      game_pk: appearance.game_pk,
      pitcher_id: appearance.pitcher_id,
      pitches_thrown: appearance.pitches,
      batters_faced: appearance.batters,
      outs_recorded: appearance.unresolved ? null : appearance.outs,
      innings_pitched: appearance.unresolved ? null : round(appearance.outs / 3),
      max_thruorder: appearance.maxTto,
      started_game: appearance.started,
      pitcher_days_since_prev_game: appearance.daysSincePrev,
      outs_status: appearance.unresolved ? "OUTS_UNRESOLVED" : "AVAILABLE",
    }))
    .sort((a, b) => a.game_date.localeCompare(b.game_date) || a.game_pk - b.game_pk || a.pitcher_id - b.pitcher_id);
}

function validStarts(
  appearances: readonly SWEAppearance[],
  pitcherId: number,
  slateDate: string,
): SWEAppearance[] {
  return appearances
    .filter((appearance) =>
      appearance.pitcher_id === pitcherId
      && appearance.game_date < slateDate
      && appearance.started_game
      && appearance.outs_status === "AVAILABLE"
      && appearance.innings_pitched !== null,
    )
    .sort((a, b) => b.game_date.localeCompare(a.game_date) || b.game_pk - a.game_pk);
}

function rawEstimate(starts: readonly SWEAppearance[]): {
  raw: number | null; l3: number | null; l5: number | null; season: number | null;
} {
  const values = starts.map((start) => start.innings_pitched!).filter(Number.isFinite);
  const l3 = values.length >= 3 ? mean(values.slice(0, 3)) : null;
  const l5 = values.length >= 5 ? mean(values.slice(0, 5)) : null;
  const season = values.length >= 1 ? mean(values) : null;
  const terms: Array<[number, number | null]> = [
    [SWE_WINDOW_WEIGHTS.L3, l3], [SWE_WINDOW_WEIGHTS.L5, l5], [SWE_WINDOW_WEIGHTS.SEASON, season],
  ];
  const denominator = terms.reduce((sum, [weight, value]) => sum + (value === null ? 0 : weight), 0);
  return {
    l3: l3 === null ? null : round(l3), l5: l5 === null ? null : round(l5),
    season: season === null ? null : round(season),
    raw: denominator === 0 ? null : round(terms.reduce((sum, [weight, value]) => sum + (value === null ? 0 : weight * value), 0) / denominator),
  };
}

function insufficient(role: string, prior: number | null, dataThroughDate: string, note: string, status: SWEStatus = "INSUFFICIENT_HISTORY"): SWEStarterState {
  const roleFallback = role === "OPENER" ? 1.2 : role === "BULK" ? 3 : prior;
  return {
    expected_ip: roleFallback === null ? null : round(roleFallback), status, n_starts: 0,
    l3_ip: null, l5_ip: null, season_ip: null, shrinkage_weight: null,
    role_prior_used: prior, data_through_date: dataThroughDate, role, notes: note,
  };
}

export function estimateStarterWorkload(
  pitcherId: number | null,
  role: string,
  slateDate: string,
  dataThroughDate: string,
  appearances: readonly SWEAppearance[],
  conventionalRolePrior: number | null,
): SWEStarterState {
  if (pitcherId === null || role === "UNRESOLVED") {
    return insufficient(role, conventionalRolePrior, dataThroughDate, "No resolved scheduled role/pitcher ID; SWE does not substitute an active role lookup.");
  }
  const unresolvedOuts = appearances.some((appearance) =>
    appearance.pitcher_id === pitcherId && appearance.game_date < slateDate && appearance.outs_status === "OUTS_UNRESOLVED",
  );
  const starts = validStarts(appearances, pitcherId, slateDate);
  const windows = rawEstimate(starts);
  if (windows.raw === null) {
    return insufficient(
      role, conventionalRolePrior, dataThroughDate,
      unresolvedOuts ? "Only OUTS_UNRESOLVED prior appearances available; no innings are imputed." : "No eligible prior source-only starts through cutoff.",
      unresolvedOuts ? "OUTS_UNRESOLVED" : "INSUFFICIENT_HISTORY",
    );
  }
  const n = starts.length;
  if (role === "OPENER") {
    if (n < 3) return insufficient(role, conventionalRolePrior, dataThroughDate, "Opener has fewer than three eligible starts; fixed designed-role prior retained.");
    return { expected_ip: round(Math.min(windows.raw, SWE_OPENER_BOUND_IP)), status: "ROLE_BOUNDED", n_starts: n, l3_ip: windows.l3, l5_ip: windows.l5, season_ip: windows.season, shrinkage_weight: null, role_prior_used: conventionalRolePrior, data_through_date: dataThroughDate, role, notes: `Opener branch: min(raw_estimate=${windows.raw}, ${SWE_OPENER_BOUND_IP}).` };
  }
  if (role === "BULK") {
    if (n < 3) return insufficient(role, conventionalRolePrior, dataThroughDate, "Bulk arm has fewer than three eligible starts; fixed designed-role prior retained.");
    return { expected_ip: windows.raw, status: "ESTIMATED", n_starts: n, l3_ip: windows.l3, l5_ip: windows.l5, season_ip: windows.season, shrinkage_weight: null, role_prior_used: conventionalRolePrior, data_through_date: dataThroughDate, role, notes: "Bulk branch: raw start-window estimate." };
  }
  if (role !== "CONVENTIONAL_STARTER" || conventionalRolePrior === null) {
    return insufficient(role, conventionalRolePrior, dataThroughDate, "Conventional role prior is unavailable from source-only conventional-start history.");
  }
  const shrinkageWeight = n / (n + SWE_SHRINKAGE_K);
  return {
    expected_ip: round(shrinkageWeight * windows.raw + (1 - shrinkageWeight) * conventionalRolePrior),
    status: "SHRUNK", n_starts: n, l3_ip: windows.l3, l5_ip: windows.l5, season_ip: windows.season,
    shrinkage_weight: round(shrinkageWeight), role_prior_used: conventionalRolePrior,
    data_through_date: dataThroughDate, role,
    notes: `Conventional branch: raw=${windows.raw}; n=${n}; k=${SWE_SHRINKAGE_K}; prior=${round(conventionalRolePrior)}.`,
  };
}

/** Builds one same-slate role prior and two frozen shadow states per game. */
export function buildStarterWorkloadEstimatorStates(
  games: readonly NormalizedGame[],
  appearances: readonly SWEAppearance[],
  slateDate: string,
  dataThroughDate: string,
): { states: Map<string, SWEGameState>; conventional_role_prior: number | null; distinct_expected_ip: number } {
  const conventionalIds = new Set<number>();
  for (const game of games) {
    if (game.away_pitcher.role === "CONVENTIONAL_STARTER" && game.away_pitcher.player_id !== null) conventionalIds.add(game.away_pitcher.player_id);
    if (game.home_pitcher.role === "CONVENTIONAL_STARTER" && game.home_pitcher.player_id !== null) conventionalIds.add(game.home_pitcher.player_id);
  }
  const priorValues = appearances
    .filter((appearance) => conventionalIds.has(appearance.pitcher_id) && appearance.game_date < slateDate && appearance.started_game && appearance.outs_status === "AVAILABLE")
    .map((appearance) => appearance.innings_pitched)
    .filter((value): value is number => value !== null);
  const prior = mean(priorValues);
  const states = new Map<string, SWEGameState>();
  const expected = new Set<number>();
  for (const game of games) {
    const away = estimateStarterWorkload(game.away_pitcher.player_id, game.away_pitcher.role, slateDate, dataThroughDate, appearances, prior);
    const home = estimateStarterWorkload(game.home_pitcher.player_id, game.home_pitcher.role, slateDate, dataThroughDate, appearances, prior);
    if (away.expected_ip !== null) expected.add(away.expected_ip);
    if (home.expected_ip !== null) expected.add(home.expected_ip);
    states.set(game.legacy_game_id, { away, home });
  }
  return { states, conventional_role_prior: prior === null ? null : round(prior), distinct_expected_ip: expected.size };
}
