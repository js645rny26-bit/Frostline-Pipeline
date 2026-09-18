/**
 * Module 02k: cutoff-safe batter damage evidence derived from the retained
 * SOURCE_SAVANT_PITCH_LEVEL response.
 *
 * This module produces factual batted-ball counts and exact-lineup aggregates.
 * It has no projection, board, market, or authorization consumer.
 */

import { createHash } from "node:crypto";
import type { LineupPlayer, StartingNineGame } from "./module04c_startingNine.js";
import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import { FROSTLINE_BATTING_ORDER_WEIGHTS, previousIsoDate } from "./module02j_batterVsHand.js";

export const BATTER_DAMAGE_VERSION = "1.1.0";
export const HARD_HIT_EXIT_VELOCITY_MPH = 95;

/**
 * Minimum batted-ball sample that can be called usable in Patch B research.
 *
 * This is an outcome-independent precision rule, not a fitted baseball
 * coefficient.  For a binomial rate, the worst-case normal-approximation
 * 95% margin of error occurs at p=0.5.  Requiring that margin to be no wider
 * than 20 percentage points gives:
 *
 *   ceil(1.96^2 * 0.5 * 0.5 / 0.20^2) = 25 BBE.
 *
 * Raw counts and rates remain visible below this threshold, but those rows
 * are LOW_SAMPLE and cannot satisfy a future mapping gate.
 */
export const BATTER_DAMAGE_USABLE_BBE_MIN = 25;

export type BatterDamageSampleStatus = "NO_SAMPLE" | "LOW_SAMPLE" | "USABLE_SAMPLE";
export type DamageLineupState = "PROJECTED" | "CONFIRMED" | "PARTIAL" | "UNKNOWN";

/**
 * Exact, MLBAM-verified identities for names that the projected-lineup source
 * emits differently from (or outside) the active-roster name map.  This is an
 * exact alias registry, never fuzzy matching.
 */
export const PATCH_B_VERIFIED_MLBAM_IDENTITIES = new Map<string, number>([
  ["dansby swanson", 621020],
  ["kike hernandez", 571771],
  ["enrique hernandez", 571771],
]);

export interface BatterDamageDailyAggregate {
  game_date: string;
  batter_mlbam_id: number;
  bbe: number;
  hard_hits: number;
  barrels: number;
  barrel_known_bbe: number;
  xbh: number;
  home_runs: number;
  exit_velocity_sum: number;
}

export interface BatterDamageIntegrity {
  pitch_rows_inspected: number;
  pa_groups_inspected: number;
  batted_ball_events: number;
  duplicate_batted_ball_rows: number;
  batted_ball_outcomes_missing_exit_velocity: number;
}

export interface BatterDamageProfile {
  batter_mlbam_id: number;
  bbe: number;
  hard_hits: number;
  hard_hit_pct: number | null;
  barrels: number;
  barrel_known_bbe: number;
  barrel_pct: number | null;
  xbh: number;
  xbh_pct: number | null;
  home_runs: number;
  hr_pct: number | null;
  avg_exit_velocity: number | null;
  status: "OBSERVED" | "NO_BATTED_BALL_SAMPLE";
  sample_status: BatterDamageSampleStatus;
}

export interface BatterDamageDataset {
  version: typeof BATTER_DAMAGE_VERSION;
  requested_through_date: string;
  actual_data_through_date: string | null;
  freshness_lag_days: number | null;
  freshness_status: "CURRENT" | "STALE_1D" | "STALE_GT_1D" | "NO_SOURCE_DATA";
  league_hard_hit_pct: number | null;
  profiles: Map<number, BatterDamageProfile>;
  integrity: BatterDamageIntegrity;
  deterministic_hash: string;
}

export interface DamageLineupProfile {
  weighted_hard_hit_pct: number | null;
  total_bbe: number;
  lineup_hitters: number;
  lineup_weight_total: number;
  matched_mlbam_hitters: number;
  observed_hitters: number;
  low_sample_hitters: number;
  usable_sample_hitters: number;
  no_sample_hitters: number;
  identity_coverage: number;
  observed_coverage: number;
  weighted_observed_coverage: number;
  weighted_usable_coverage: number;
  missing_hitters: string[];
  driver_trace: string;
  status: "AVAILABLE" | "PARTIAL_IDENTITY" | "NO_SOURCE_DATA" | "NO_LINEUP";
}

const BATTED_BALL_OUTCOMES = new Set([
  "field_out", "force_out", "grounded_into_double_play", "double_play",
  "triple_play", "fielders_choice", "fielders_choice_out", "field_error",
  "single", "double", "triple", "home_run", "sac_fly", "sac_fly_double_play",
]);

function numeric(value: string | undefined): number | null {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pitchNumber(event: SavantPitchLevelEvent): number {
  return numeric(event.raw.get("pitch_number")) ?? -1;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function normalizeName(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

export function resolvePatchBDamageIdentity(
  name: string,
  nameToIdMap: ReadonlyMap<string, number>,
): number | undefined {
  const normalized = normalizeName(name);
  return nameToIdMap.get(normalized) ?? PATCH_B_VERIFIED_MLBAM_IDENTITIES.get(normalized);
}

export function classifyBatterDamageSample(bbe: number): BatterDamageSampleStatus {
  if (bbe <= 0) return "NO_SAMPLE";
  return bbe < BATTER_DAMAGE_USABLE_BBE_MIN ? "LOW_SAMPLE" : "USABLE_SAMPLE";
}

/** Preserve the exact pregame lineup state available when the row is built. */
export function resolveDamageLineupState(card: StartingNineGame | undefined): DamageLineupState {
  if (!card) return "UNKNOWN";
  const awayCount = card.away_lineup.slice(0, 9).length;
  const homeCount = card.home_lineup.slice(0, 9).length;
  if (awayCount === 0 && homeCount === 0) return "UNKNOWN";
  const awayStatus = card.away_lineup_status ?? card.lineup_status;
  const homeStatus = card.home_lineup_status ?? card.lineup_status;
  if (awayCount < 9 || homeCount < 9 || awayStatus !== homeStatus) return "PARTIAL";
  return awayStatus === "official" ? "CONFIRMED" : "PROJECTED";
}

function emptyIntegrity(): BatterDamageIntegrity {
  return {
    pitch_rows_inspected: 0,
    pa_groups_inspected: 0,
    batted_ball_events: 0,
    duplicate_batted_ball_rows: 0,
    batted_ball_outcomes_missing_exit_velocity: 0,
  };
}

/** One Statcast batted ball per (game_pk, at_bat_number), never one per pitch. */
export function deriveBatterDamageDailyAggregates(
  events: readonly SavantPitchLevelEvent[],
): { aggregates: BatterDamageDailyAggregate[]; integrity: BatterDamageIntegrity } {
  const integrity = emptyIntegrity();
  integrity.pitch_rows_inspected = events.length;
  const groups = new Map<string, SavantPitchLevelEvent[]>();
  for (const event of events) {
    const key = `${event.game_pk}|${event.at_bat_number}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  integrity.pa_groups_inspected = groups.size;

  const byBatter = new Map<string, BatterDamageDailyAggregate>();
  for (const group of groups.values()) {
    const withExitVelocity = group
      .filter((event) => numeric(event.raw.get("launch_speed")) !== null)
      .sort((a, b) => pitchNumber(b) - pitchNumber(a));
    if (withExitVelocity.length > 1) integrity.duplicate_batted_ball_rows += withExitVelocity.length - 1;
    const chosen = withExitVelocity[0];
    if (!chosen) {
      if (group.some((event) => BATTED_BALL_OUTCOMES.has(event.events.trim()))) {
        integrity.batted_ball_outcomes_missing_exit_velocity++;
      }
      continue;
    }
    const exitVelocity = numeric(chosen.raw.get("launch_speed"));
    if (exitVelocity === null) continue;
    integrity.batted_ball_events++;
    const eventName = chosen.events.trim();
    const launchSpeedAngle = numeric(chosen.raw.get("launch_speed_angle"));
    const key = `${chosen.game_date}|${chosen.batter}`;
    const aggregate = byBatter.get(key) ?? {
      game_date: chosen.game_date,
      batter_mlbam_id: chosen.batter,
      bbe: 0,
      hard_hits: 0,
      barrels: 0,
      barrel_known_bbe: 0,
      xbh: 0,
      home_runs: 0,
      exit_velocity_sum: 0,
    };
    aggregate.bbe++;
    aggregate.exit_velocity_sum += exitVelocity;
    if (exitVelocity >= HARD_HIT_EXIT_VELOCITY_MPH) aggregate.hard_hits++;
    if (launchSpeedAngle !== null) {
      aggregate.barrel_known_bbe++;
      if (launchSpeedAngle === 6) aggregate.barrels++;
    }
    if (eventName === "double" || eventName === "triple" || eventName === "home_run") aggregate.xbh++;
    if (eventName === "home_run") aggregate.home_runs++;
    byBatter.set(key, aggregate);
  }

  return {
    aggregates: [...byBatter.values()].sort((a, b) =>
      a.game_date.localeCompare(b.game_date) || a.batter_mlbam_id - b.batter_mlbam_id),
    integrity,
  };
}

export function assertBatterDamageCutoff(
  rows: readonly Pick<BatterDamageDailyAggregate, "game_date">[],
  requestedThroughDate: string,
): void {
  const violation = rows.find((row) => row.game_date > requestedThroughDate);
  if (violation) throw new Error(`BATTER_DAMAGE_CUTOFF_VIOLATION: ${violation.game_date} exceeds ${requestedThroughDate}`);
}

export function buildBatterDamageDataset(
  rows: readonly BatterDamageDailyAggregate[],
  slateDate: string,
  integrity: BatterDamageIntegrity = emptyIntegrity(),
  requiredBatterIds: readonly number[] = [],
): BatterDamageDataset {
  const requested = previousIsoDate(slateDate);
  assertBatterDamageCutoff(rows, requested);
  const currentYear = slateDate.slice(0, 4);
  const eligible = rows.filter((row) => row.game_date <= requested && row.game_date.startsWith(`${currentYear}-`));
  const actual = eligible.reduce<string | null>((latest, row) => !latest || row.game_date > latest ? row.game_date : latest, null);
  const summed = new Map<number, BatterDamageDailyAggregate>();
  for (const row of eligible) {
    const total = summed.get(row.batter_mlbam_id) ?? {
      game_date: row.game_date, batter_mlbam_id: row.batter_mlbam_id,
      bbe: 0, hard_hits: 0, barrels: 0, barrel_known_bbe: 0,
      xbh: 0, home_runs: 0, exit_velocity_sum: 0,
    };
    total.bbe += row.bbe;
    total.hard_hits += row.hard_hits;
    total.barrels += row.barrels;
    total.barrel_known_bbe += row.barrel_known_bbe;
    total.xbh += row.xbh;
    total.home_runs += row.home_runs;
    total.exit_velocity_sum += row.exit_velocity_sum;
    summed.set(row.batter_mlbam_id, total);
  }
  const league = [...summed.values()].reduce((acc, row) => ({
    bbe: acc.bbe + row.bbe,
    hardHits: acc.hardHits + row.hard_hits,
  }), { bbe: 0, hardHits: 0 });
  const leagueHardHitPct = league.bbe > 0 ? round(100 * league.hardHits / league.bbe) : null;
  const ids = new Set([...summed.keys(), ...requiredBatterIds.filter((id) => id > 0)]);
  const profiles = new Map<number, BatterDamageProfile>();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const row = summed.get(id);
    const bbe = row?.bbe ?? 0;
    profiles.set(id, {
      batter_mlbam_id: id,
      bbe,
      hard_hits: row?.hard_hits ?? 0,
      hard_hit_pct: bbe > 0 ? round(100 * (row?.hard_hits ?? 0) / bbe) : null,
      barrels: row?.barrels ?? 0,
      barrel_known_bbe: row?.barrel_known_bbe ?? 0,
      barrel_pct: (row?.barrel_known_bbe ?? 0) > 0 ? round(100 * (row?.barrels ?? 0) / row!.barrel_known_bbe) : null,
      xbh: row?.xbh ?? 0,
      xbh_pct: bbe > 0 ? round(100 * (row?.xbh ?? 0) / bbe) : null,
      home_runs: row?.home_runs ?? 0,
      hr_pct: bbe > 0 ? round(100 * (row?.home_runs ?? 0) / bbe) : null,
      avg_exit_velocity: bbe > 0 ? round((row?.exit_velocity_sum ?? 0) / bbe) : null,
      status: bbe > 0 ? "OBSERVED" : "NO_BATTED_BALL_SAMPLE",
      sample_status: classifyBatterDamageSample(bbe),
    });
  }
  const lag = actual === null
    ? null
    : Math.round((Date.parse(`${requested}T12:00:00Z`) - Date.parse(`${actual}T12:00:00Z`)) / 86_400_000);
  if (lag !== null && lag < 0) throw new Error(`BATTER_DAMAGE_CUTOFF_VIOLATION: actual ${actual}, requested ${requested}`);
  const freshnessStatus = lag === null ? "NO_SOURCE_DATA" : lag === 0 ? "CURRENT" : lag === 1 ? "STALE_1D" : "STALE_GT_1D";
  const hash = createHash("sha256").update(JSON.stringify({
    version: BATTER_DAMAGE_VERSION,
    requested,
    actual,
    leagueHardHitPct,
    profiles: [...profiles.values()],
  })).digest("hex");
  return {
    version: BATTER_DAMAGE_VERSION,
    requested_through_date: requested,
    actual_data_through_date: actual,
    freshness_lag_days: lag,
    freshness_status: freshnessStatus,
    league_hard_hit_pct: leagueHardHitPct,
    profiles,
    integrity,
    deterministic_hash: hash,
  };
}

/** Batting-order weighted factual hard-hit profile; no run conversion occurs here. */
export function buildDamageLineupProfile(
  lineup: readonly LineupPlayer[],
  nameToIdMap: ReadonlyMap<string, number>,
  dataset: BatterDamageDataset | null,
): DamageLineupProfile {
  const empty = (status: DamageLineupProfile["status"]): DamageLineupProfile => ({
    weighted_hard_hit_pct: null,
    total_bbe: 0,
    lineup_hitters: lineup.slice(0, 9).length,
    lineup_weight_total: 0,
    matched_mlbam_hitters: 0,
    observed_hitters: 0,
    low_sample_hitters: 0,
    usable_sample_hitters: 0,
    no_sample_hitters: 0,
    identity_coverage: 0,
    observed_coverage: 0,
    weighted_observed_coverage: 0,
    weighted_usable_coverage: 0,
    missing_hitters: lineup.map((player) => player.name),
    driver_trace: "",
    status,
  });
  if (lineup.length === 0) return empty("NO_LINEUP");
  if (!dataset || dataset.league_hard_hit_pct === null) return empty("NO_SOURCE_DATA");
  let weightTotal = 0;
  let hardHitSum = 0;
  let totalBbe = 0;
  let matched = 0;
  let observed = 0;
  let lowSample = 0;
  let usableSample = 0;
  let noSample = 0;
  let observedWeight = 0;
  let usableWeight = 0;
  const missing: string[] = [];
  const drivers: string[] = [];
  const slots = lineup.slice(0, 9);
  for (let index = 0; index < slots.length; index++) {
    const player = slots[index]!;
    const slot = Math.max(0, Math.min(8, (player.batting_order || index + 1) - 1));
    const weight = FROSTLINE_BATTING_ORDER_WEIGHTS[slot] ?? 1;
    weightTotal += weight;
    const id = resolvePatchBDamageIdentity(player.name, nameToIdMap);
    const profile = id ? dataset.profiles.get(id) : null;
    if (!id) {
      missing.push(player.name);
      hardHitSum += dataset.league_hard_hit_pct * weight;
      drivers.push(`${slot + 1}:UNRESOLVED:MISSING_IDENTITY:IMPUTED=LEAGUE=${dataset.league_hard_hit_pct}`);
      continue;
    }
    matched++;
    if (!profile) {
      noSample++;
      hardHitSum += dataset.league_hard_hit_pct * weight;
      drivers.push(`${slot + 1}:${id}:BBE=0:HH=0:HH_PCT=MISSING:STATUS=NO_SOURCE_PROFILE:SAMPLE_STATUS=NO_SAMPLE:IMPUTED=LEAGUE=${dataset.league_hard_hit_pct}`);
      continue;
    }
    totalBbe += profile.bbe;
    if (profile.hard_hit_pct !== null) {
      observed++;
      observedWeight += weight;
    }
    if (profile.sample_status === "USABLE_SAMPLE") {
      usableSample++;
      usableWeight += weight;
    } else if (profile.sample_status === "LOW_SAMPLE") {
      lowSample++;
    } else {
      noSample++;
    }
    const hardHitPct = profile.hard_hit_pct ?? dataset.league_hard_hit_pct;
    hardHitSum += hardHitPct * weight;
    drivers.push(`${slot + 1}:${id}:BBE=${profile.bbe}:HH=${profile.hard_hits}:HH_PCT=${profile.hard_hit_pct ?? "MISSING"}:STATUS=${profile.status}:SAMPLE_STATUS=${profile.sample_status}${profile.hard_hit_pct === null ? `:IMPUTED=LEAGUE=${dataset.league_hard_hit_pct}` : ""}`);
  }
  return {
    weighted_hard_hit_pct: weightTotal > 0 ? round(hardHitSum / weightTotal) : null,
    total_bbe: totalBbe,
    lineup_hitters: slots.length,
    lineup_weight_total: weightTotal,
    matched_mlbam_hitters: matched,
    observed_hitters: observed,
    low_sample_hitters: lowSample,
    usable_sample_hitters: usableSample,
    no_sample_hitters: noSample,
    identity_coverage: slots.length > 0 ? round(matched / slots.length) : 0,
    observed_coverage: slots.length > 0 ? round(observed / slots.length) : 0,
    weighted_observed_coverage: weightTotal > 0 ? round(observedWeight / weightTotal) : 0,
    weighted_usable_coverage: weightTotal > 0 ? round(usableWeight / weightTotal) : 0,
    missing_hitters: missing,
    driver_trace: drivers.join(" | "),
    status: matched === slots.length ? "AVAILABLE" : "PARTIAL_IDENTITY",
  };
}
