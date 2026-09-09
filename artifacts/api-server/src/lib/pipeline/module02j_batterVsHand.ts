/**
 * Module 02j: Batter-vs-Hand Performance Split (BVH) V1.
 *
 * One cutoff-safe Savant pitch-event family is reduced to one terminal event
 * per plate appearance, accumulated by MLBAM batter ID and opposing pitcher
 * hand, and shrunk toward a documented same-hand prior.  The module contains
 * no market input and no independent run adjustment.
 */

import { createHash } from "node:crypto";
import type { BatterSeasonStats } from "./module02c_batterSeasonStats.js";
import type { SavantPitchLevelEvent } from "./module02h_savantPitchLevel.js";
import type { LineupPlayer } from "./module04c_startingNine.js";

export const BVH_VERSION = "1.0.0";
export const BVH_SHRINKAGE_K = 150;
export const BVH_PLAYER_HISTORICAL_MIN_PA = 200;
export const BVH_OBSERVED_COVERAGE_MIN_PA = 50;
export const BVH_BATTING_ORDER_WEIGHT_SOURCE = "FROSTLINE_EXISTING_V36_WEIGHTS";
export const FROSTLINE_BATTING_ORDER_WEIGHTS = [1.15, 1.1, 1.2, 1.2, 1.05, 1.0, 0.9, 0.8, 0.6] as const;

export type BVHHand = "L" | "R";
export type BVHStatus = "OBSERVED_SHRUNK" | "NO_SPLIT_SAMPLE";
export type BVHPriorSource = "PLAYER_HISTORICAL" | "LEAGUE_BASELINE";
export type BVHFreshnessStatus = "CURRENT" | "STALE_1D" | "STALE_GT_1D" | "NO_SOURCE_DATA";

export interface BVHCounts {
  pa: number;
  ab: number;
  hits: number;
  bb: number;
  ibb: number;
  hbp: number;
  sf: number;
  total_bases: number;
}

export interface BVHDailyAggregate extends BVHCounts {
  game_date: string;
  batter_mlbam_id: number;
  pitcher_hand: BVHHand;
}

export interface BVHPAIntegrity {
  pitch_rows_inspected: number;
  terminal_pa_count: number;
  no_terminal_event_count: number;
  multiple_terminal_event_count: number;
  malformed_pa_count: number;
  unclassified_events: number;
  unclassified_event_values: string[];
  excluded_non_pa_events: number;
  excluded_non_pa_event_values: string[];
}

export interface BVHRateLine extends BVHCounts {
  obp: number | null;
  slg: number | null;
  ops: number | null;
}

export interface BVHHandEstimate {
  batter_mlbam_id: number;
  pitcher_hand: BVHHand;
  raw: BVHRateLine;
  prior_ops: number;
  prior_source: BVHPriorSource;
  shrinkage_weight: number;
  shrunk_ops: number;
  status: BVHStatus;
}

export interface BVHBatterEstimate {
  batter_mlbam_id: number;
  vs_lhp: BVHHandEstimate | null;
  vs_rhp: BVHHandEstimate | null;
}

export interface BVHDataset {
  version: typeof BVH_VERSION;
  requested_through_date: string;
  actual_data_through_date: string | null;
  freshness_lag_days: number | null;
  freshness_status: BVHFreshnessStatus;
  league_baseline_lhp: number | null;
  league_baseline_rhp: number | null;
  estimates: Map<number, BVHBatterEstimate>;
  integrity: BVHPAIntegrity;
  deterministic_hash: string;
}

export interface BVHLineupProfile {
  opposing_pitcher_hand: BVHHand | null;
  weighted_shrunk_ops: number | null;
  performance_matchup_factor: number;
  mean_raw_pa: number;
  no_sample_count: number;
  observed_50_pa_coverage: number;
  identity_coverage: number;
  matched_mlbam_hitters: number;
  missing_hitters: string[];
  /** Frozen slot-level MLBAM/sample/value trace for manual replay review. */
  driver_trace: string;
  chain_uncertainty: boolean;
  status: "AVAILABLE" | "PARTIAL_IDENTITY" | "HAND_UNRESOLVED" | "NO_SOURCE_DATA" | "NO_LINEUP";
  batting_order_weight_source: typeof BVH_BATTING_ORDER_WEIGHT_SOURCE;
}

const EMPTY_COUNTS: Readonly<BVHCounts> = Object.freeze({
  pa: 0, ab: 0, hits: 0, bb: 0, ibb: 0, hbp: 0, sf: 0, total_bases: 0,
});

const AB_EVENTS = new Set([
  "strikeout", "field_out", "force_out", "grounded_into_double_play",
  "double_play", "triple_play", "fielders_choice", "fielders_choice_out",
  "field_error", "single", "double", "triple", "home_run", "other_out",
  // MLB's compound event is still one strikeout/at-bat for the batter; the
  // second out belongs to the baserunning state, not the hitter rate line.
  "strikeout_double_play",
]);
const OBP_NON_AB_EVENTS = new Set(["walk", "intent_walk", "hit_by_pitch"]);
const DENOM_EXCLUDED_EVENTS = new Set(["sac_bunt", "catcher_interf"]);
const SF_EVENTS = new Set(["sac_fly", "sac_fly_double_play"]);
// Savant can terminate an event record without recording an official batter
// PA (for example, a mid-PA substitution). Preserve and count the occurrence,
// but never put it into PA/AB/OBP/SLG denominators.
const EXCLUDED_NON_PA_EVENTS = new Set(["truncated_pa"]);
const KNOWN_EVENTS = new Set([...AB_EVENTS, ...OBP_NON_AB_EVENTS, ...DENOM_EXCLUDED_EVENTS, ...SF_EVENTS]);

function blankCounts(): BVHCounts { return { ...EMPTY_COUNTS }; }
function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }
function normalizeHand(value: string): BVHHand | null {
  const hand = value.trim().toUpperCase();
  return hand === "L" || hand === "R" ? hand : null;
}
function isoDayMs(value: string): number {
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
export function previousIsoDate(date: string): string {
  const parsed = isoDayMs(date);
  if (!Number.isFinite(parsed)) throw new Error(`BVH_INVALID_SLATE_DATE: ${date}`);
  return new Date(parsed - 86_400_000).toISOString().slice(0, 10);
}

function eventPitchNumber(event: SavantPitchLevelEvent): number {
  const parsed = Number.parseInt(String(event.raw.get("pitch_number") ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function terminalSignature(event: SavantPitchLevelEvent): string {
  return [event.batter, event.pitcher, event.p_throws, event.events, eventPitchNumber(event)].join("|");
}

function countEvent(counts: BVHCounts, event: string): boolean {
  if (!KNOWN_EVENTS.has(event)) return false;
  counts.pa++;
  if (AB_EVENTS.has(event)) counts.ab++;
  if (event === "single" || event === "double" || event === "triple" || event === "home_run") counts.hits++;
  if (event === "walk") counts.bb++;
  if (event === "intent_walk") counts.ibb++;
  if (event === "hit_by_pitch") counts.hbp++;
  if (SF_EVENTS.has(event)) counts.sf++;
  if (event === "single") counts.total_bases += 1;
  if (event === "double") counts.total_bases += 2;
  if (event === "triple") counts.total_bases += 3;
  if (event === "home_run") counts.total_bases += 4;
  return true;
}

function addCounts(target: BVHCounts, source: BVHCounts): void {
  target.pa += source.pa;
  target.ab += source.ab;
  target.hits += source.hits;
  target.bb += source.bb;
  target.ibb += source.ibb;
  target.hbp += source.hbp;
  target.sf += source.sf;
  target.total_bases += source.total_bases;
}

export function rateLine(counts: BVHCounts): BVHRateLine {
  const obpDenominator = counts.ab + counts.bb + counts.ibb + counts.hbp + counts.sf;
  const obp = obpDenominator > 0
    ? (counts.hits + counts.bb + counts.ibb + counts.hbp) / obpDenominator
    : null;
  const slg = counts.ab > 0 ? counts.total_bases / counts.ab : null;
  return {
    ...counts,
    obp: obp === null ? null : round(obp),
    slg: slg === null ? null : round(slg),
    ops: obp === null || slg === null ? null : round(obp + slg),
  };
}

/**
 * Reduces pitches to one deterministically selected terminal row per PA and
 * aggregates the recognized outcome using (game_pk, at_bat_number) identity.
 */
export function deriveBVHDailyAggregates(
  events: readonly SavantPitchLevelEvent[],
): { aggregates: BVHDailyAggregate[]; integrity: BVHPAIntegrity } {
  const integrity: BVHPAIntegrity = {
    pitch_rows_inspected: events.length,
    terminal_pa_count: 0,
    no_terminal_event_count: 0,
    multiple_terminal_event_count: 0,
    malformed_pa_count: 0,
    unclassified_events: 0,
    unclassified_event_values: [],
    excluded_non_pa_events: 0,
    excluded_non_pa_event_values: [],
  };
  const unclassified = new Set<string>();
  const excludedNonPa = new Set<string>();
  const paGroups = new Map<string, SavantPitchLevelEvent[]>();
  for (const event of events) {
    const key = `${event.game_pk}|${event.at_bat_number}`;
    const group = paGroups.get(key) ?? [];
    group.push(event);
    paGroups.set(key, group);
  }
  const aggregateMap = new Map<string, BVHDailyAggregate>();
  for (const group of paGroups.values()) {
    const terminalBySignature = new Map<string, SavantPitchLevelEvent>();
    for (const event of group) {
      if (event.events.trim()) terminalBySignature.set(terminalSignature(event), event);
    }
    const terminal = [...terminalBySignature.values()].sort((a, b) =>
      eventPitchNumber(b) - eventPitchNumber(a)
      || terminalSignature(a).localeCompare(terminalSignature(b))
    );
    if (terminal.length === 0) {
      integrity.no_terminal_event_count++;
      integrity.malformed_pa_count++;
      continue;
    }
    if (terminal.length > 1) integrity.multiple_terminal_event_count++;
    const chosen = terminal[0]!;
    integrity.terminal_pa_count++;
    const hand = normalizeHand(chosen.p_throws);
    if (!hand || !chosen.batter || !chosen.game_date) {
      integrity.malformed_pa_count++;
      continue;
    }
    const eventName = chosen.events.trim();
    if (EXCLUDED_NON_PA_EVENTS.has(eventName)) {
      integrity.excluded_non_pa_events++;
      excludedNonPa.add(eventName);
      continue;
    }
    const counts = blankCounts();
    if (!countEvent(counts, eventName)) {
      integrity.unclassified_events++;
      unclassified.add(eventName || "<BLANK>");
      continue;
    }
    const key = `${chosen.game_date}|${chosen.batter}|${hand}`;
    const aggregate = aggregateMap.get(key) ?? {
      game_date: chosen.game_date,
      batter_mlbam_id: chosen.batter,
      pitcher_hand: hand,
      ...blankCounts(),
    };
    addCounts(aggregate, counts);
    aggregateMap.set(key, aggregate);
  }
  integrity.unclassified_event_values = [...unclassified].sort();
  integrity.excluded_non_pa_event_values = [...excludedNonPa].sort();
  const aggregates = [...aggregateMap.values()].sort((a, b) =>
    a.game_date.localeCompare(b.game_date)
    || a.batter_mlbam_id - b.batter_mlbam_id
    || a.pitcher_hand.localeCompare(b.pitcher_hand)
  );
  return { aggregates, integrity };
}

function aggregateKey(batter: number, hand: BVHHand): string { return `${batter}|${hand}`; }

function sumAggregates(rows: readonly BVHDailyAggregate[]): Map<string, BVHCounts> {
  const result = new Map<string, BVHCounts>();
  for (const row of rows) {
    const key = aggregateKey(row.batter_mlbam_id, row.pitcher_hand);
    const counts = result.get(key) ?? blankCounts();
    addCounts(counts, row);
    result.set(key, counts);
  }
  return result;
}

function leagueLine(rows: readonly BVHDailyAggregate[], hand: BVHHand): BVHRateLine {
  const counts = blankCounts();
  for (const row of rows) if (row.pitcher_hand === hand) addCounts(counts, row);
  return rateLine(counts);
}

function emptyIntegrity(): BVHPAIntegrity {
  return {
    pitch_rows_inspected: 0, terminal_pa_count: 0, no_terminal_event_count: 0,
    multiple_terminal_event_count: 0, malformed_pa_count: 0,
    unclassified_events: 0, unclassified_event_values: [],
    excluded_non_pa_events: 0, excluded_non_pa_event_values: [],
  };
}

export function assertBVHCutoff(
  rows: readonly Pick<BVHDailyAggregate, "game_date">[],
  requestedThroughDate: string,
): void {
  const violating = rows.find((row) => row.game_date > requestedThroughDate);
  if (violating) {
    throw new Error(`BVH_CUTOFF_VIOLATION: ${violating.game_date} exceeds ${requestedThroughDate}`);
  }
}

function freshness(requested: string, actual: string | null): { lag: number | null; status: BVHFreshnessStatus } {
  if (!actual) return { lag: null, status: "NO_SOURCE_DATA" };
  const days = Math.round((isoDayMs(requested) - isoDayMs(actual)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) throw new Error(`BVH_CUTOFF_VIOLATION: actual ${actual}, requested ${requested}`);
  return { lag: days, status: days === 0 ? "CURRENT" : days === 1 ? "STALE_1D" : "STALE_GT_1D" };
}

export function buildBVHDatasetFromDailyAggregates(
  rows: readonly BVHDailyAggregate[],
  slateDate: string,
  integrity: BVHPAIntegrity = emptyIntegrity(),
  requiredBatterIds: readonly number[] = [],
): BVHDataset {
  const requested = previousIsoDate(slateDate);
  assertBVHCutoff(rows, requested);
  const eligible = rows.filter((row) => row.game_date <= requested);
  const actual = eligible.reduce<string | null>((latest, row) => !latest || row.game_date > latest ? row.game_date : latest, null);
  const currentYear = slateDate.slice(0, 4);
  const current = eligible.filter((row) => row.game_date.startsWith(`${currentYear}-`));
  const historical = eligible.filter((row) => !row.game_date.startsWith(`${currentYear}-`));
  const currentBy = sumAggregates(current);
  const historicalBy = sumAggregates(historical);
  const leagueL = leagueLine(current, "L");
  const leagueR = leagueLine(current, "R");
  const leagueBaselineL = leagueL.ops;
  const leagueBaselineR = leagueR.ops;
  const batterIds = new Set<number>();
  for (const row of eligible) batterIds.add(row.batter_mlbam_id);
  for (const batter of requiredBatterIds) if (Number.isFinite(batter) && batter > 0) batterIds.add(batter);

  const estimate = (batter: number, hand: BVHHand): BVHHandEstimate | null => {
    const league = hand === "L" ? leagueBaselineL : leagueBaselineR;
    const raw = rateLine(currentBy.get(aggregateKey(batter, hand)) ?? blankCounts());
    const historic = rateLine(historicalBy.get(aggregateKey(batter, hand)) ?? blankCounts());
    const playerPriorEligible = historic.pa >= BVH_PLAYER_HISTORICAL_MIN_PA && historic.ops !== null;
    if (!playerPriorEligible && league === null) return null;
    const priorOps = playerPriorEligible ? historic.ops! : league!;
    const priorSource: BVHPriorSource = playerPriorEligible ? "PLAYER_HISTORICAL" : "LEAGUE_BASELINE";
    const weight = raw.pa / (raw.pa + BVH_SHRINKAGE_K);
    const observedOps = raw.ops ?? priorOps;
    return {
      batter_mlbam_id: batter,
      pitcher_hand: hand,
      raw,
      prior_ops: round(priorOps),
      prior_source: priorSource,
      shrinkage_weight: round(weight),
      shrunk_ops: round(weight * observedOps + (1 - weight) * priorOps),
      status: raw.pa > 0 ? "OBSERVED_SHRUNK" : "NO_SPLIT_SAMPLE",
    };
  };

  const estimates = new Map<number, BVHBatterEstimate>();
  for (const batter of [...batterIds].sort((a, b) => a - b)) {
    estimates.set(batter, { batter_mlbam_id: batter, vs_lhp: estimate(batter, "L"), vs_rhp: estimate(batter, "R") });
  }
  const freshnessState = freshness(requested, actual);
  const hashPayload = [...estimates.values()].map((entry) => ({
    batter: entry.batter_mlbam_id,
    l: entry.vs_lhp && [entry.vs_lhp.raw.pa, entry.vs_lhp.raw.obp, entry.vs_lhp.raw.slg, entry.vs_lhp.prior_ops, entry.vs_lhp.prior_source, entry.vs_lhp.shrinkage_weight, entry.vs_lhp.shrunk_ops, entry.vs_lhp.status],
    r: entry.vs_rhp && [entry.vs_rhp.raw.pa, entry.vs_rhp.raw.obp, entry.vs_rhp.raw.slg, entry.vs_rhp.prior_ops, entry.vs_rhp.prior_source, entry.vs_rhp.shrinkage_weight, entry.vs_rhp.shrunk_ops, entry.vs_rhp.status],
  }));
  const deterministicHash = createHash("sha256").update(JSON.stringify({
    version: BVH_VERSION, requested, actual, leagueBaselineL, leagueBaselineR, estimates: hashPayload,
  })).digest("hex");
  return {
    version: BVH_VERSION,
    requested_through_date: requested,
    actual_data_through_date: actual,
    freshness_lag_days: freshnessState.lag,
    freshness_status: freshnessState.status,
    league_baseline_lhp: leagueBaselineL,
    league_baseline_rhp: leagueBaselineR,
    estimates,
    integrity,
    deterministic_hash: deterministicHash,
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/**
 * Converts batter-level split evidence into a dimensionless starter-window
 * matchup factor relative to each hitter's established season OPS. Missing
 * identity is explicit and receives a neutral 1.0 slot contribution.
 */
export function buildBVHLineupProfile(
  lineup: readonly LineupPlayer[],
  opposingPitcherHand: string | null,
  nameToIdMap: ReadonlyMap<string, number>,
  batterStatsMap: ReadonlyMap<number, BatterSeasonStats>,
  dataset: BVHDataset | null,
  chainUncertainty = false,
): BVHLineupProfile {
  const hand = normalizeHand(opposingPitcherHand ?? "");
  const empty = (status: BVHLineupProfile["status"]): BVHLineupProfile => ({
    opposing_pitcher_hand: hand,
    weighted_shrunk_ops: null,
    performance_matchup_factor: 1,
    mean_raw_pa: 0,
    no_sample_count: 0,
    observed_50_pa_coverage: 0,
    identity_coverage: 0,
    matched_mlbam_hitters: 0,
    missing_hitters: lineup.map((player) => player.name),
    driver_trace: "",
    chain_uncertainty: chainUncertainty,
    status,
    batting_order_weight_source: BVH_BATTING_ORDER_WEIGHT_SOURCE,
  });
  if (lineup.length === 0) return empty("NO_LINEUP");
  if (!hand) return empty("HAND_UNRESOLVED");
  const league = hand === "L" ? dataset?.league_baseline_lhp : dataset?.league_baseline_rhp;
  if (!dataset || league === null || league === undefined) return empty("NO_SOURCE_DATA");

  let totalWeight = 0;
  let opsSum = 0;
  let factorSum = 0;
  let rawPaSum = 0;
  let matched = 0;
  let observed50 = 0;
  let noSample = 0;
  const missing: string[] = [];
  const drivers: string[] = [];
  const slots = lineup.slice(0, 9);
  for (let index = 0; index < slots.length; index++) {
    const player = slots[index]!;
    const slot = Math.max(0, Math.min(8, (player.batting_order || index + 1) - 1));
    const weight = FROSTLINE_BATTING_ORDER_WEIGHTS[slot] ?? 1;
    totalWeight += weight;
    const id = nameToIdMap.get(normalizeName(player.name));
    const split = id === undefined ? null : dataset.estimates.get(id);
    const estimate = hand === "L" ? split?.vs_lhp : split?.vs_rhp;
    if (!id || !estimate) {
      missing.push(player.name);
      opsSum += league * weight;
      factorSum += weight;
      drivers.push(`${slot + 1}:${id ?? "UNRESOLVED"}:MISSING:PRIOR=${round(league)}`);
      continue;
    }
    matched++;
    rawPaSum += estimate.raw.pa;
    if (estimate.raw.pa >= BVH_OBSERVED_COVERAGE_MIN_PA) observed50++;
    if (estimate.status === "NO_SPLIT_SAMPLE") noSample++;
    const stableOps = batterStatsMap.get(id)?.ops ?? league;
    const factor = stableOps > 0 ? estimate.shrunk_ops / stableOps : 1;
    drivers.push(
      `${slot + 1}:${id}:PA=${estimate.raw.pa}:SHRUNK=${estimate.shrunk_ops}:STABLE=${round(stableOps)}:RATIO=${round(factor)}:${estimate.status}`,
    );
    opsSum += estimate.shrunk_ops * weight;
    factorSum += factor * weight;
  }
  const total = slots.length;
  return {
    opposing_pitcher_hand: hand,
    weighted_shrunk_ops: totalWeight > 0 ? round(opsSum / totalWeight) : null,
    performance_matchup_factor: totalWeight > 0 ? round(factorSum / totalWeight) : 1,
    mean_raw_pa: matched > 0 ? round(rawPaSum / matched, 2) : 0,
    no_sample_count: noSample,
    observed_50_pa_coverage: total > 0 ? round(observed50 / total) : 0,
    identity_coverage: total > 0 ? round(matched / total) : 0,
    matched_mlbam_hitters: matched,
    missing_hitters: missing,
    driver_trace: drivers.join(" | "),
    chain_uncertainty: chainUncertainty,
    status: matched === total ? "AVAILABLE" : "PARTIAL_IDENTITY",
    batting_order_weight_source: BVH_BATTING_ORDER_WEIGHT_SOURCE,
  };
}
