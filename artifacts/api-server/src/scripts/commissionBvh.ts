/**
 * Network-only BVH data-layer commissioning. Fetches cutoff-safe historical
 * Savant days into memory, never writes a workbook, and reports real-slate
 * identity, coverage, non-degeneracy, freshness, and reproducibility.
 */

import { fetchMlbSchedule } from "../lib/pipeline/module01_mlbStatsApi.js";
import { fetchTeamRosters, fetchBatterSeasonStats, normalizeForMatch } from "../lib/pipeline/module02c_batterSeasonStats.js";
import { fetchPitcherSeasonStats } from "../lib/pipeline/module02b_pitcherSeasonStats.js";
import { fetchStartingNine, buildStartingNineMap } from "../lib/pipeline/module04c_startingNine.js";
import { fetchSavantPitchLevelDay } from "../lib/pipeline/module02h_savantPitchLevel.js";
import {
  buildBVHDatasetFromDailyAggregates,
  buildBVHLineupProfile,
  deriveBVHDailyAggregates,
  previousIsoDate,
  type BVHDailyAggregate,
  type BVHPAIntegrity,
} from "../lib/pipeline/module02j_batterVsHand.js";

function dates(start: string, end: string): string[] {
  const result: string[] = [];
  let cursor = new Date(`${start}T12:00:00.000Z`);
  const last = new Date(`${end}T12:00:00.000Z`);
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return result;
}

async function scheduledRegularSeasonDates(start: string, end: string): Promise<string[]> {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("gameType", "R");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`BVH_COMMISSIONING_SCHEDULE_HTTP_${response.status}`);
  const payload = await response.json() as { dates?: Array<{ date?: string; games?: unknown[] }> };
  return (payload.dates ?? [])
    .filter((entry) => entry.date && (entry.games?.length ?? 0) > 0)
    .map((entry) => entry.date!)
    .filter((date) => date >= start && date <= end)
    .sort();
}

function blankIntegrity(): BVHPAIntegrity {
  return {
    pitch_rows_inspected: 0, terminal_pa_count: 0, no_terminal_event_count: 0,
    multiple_terminal_event_count: 0, malformed_pa_count: 0,
    unclassified_events: 0, unclassified_event_values: [],
    excluded_non_pa_events: 0, excluded_non_pa_event_values: [],
  };
}

function addIntegrity(target: BVHPAIntegrity, source: BVHPAIntegrity): void {
  target.pitch_rows_inspected += source.pitch_rows_inspected;
  target.terminal_pa_count += source.terminal_pa_count;
  target.no_terminal_event_count += source.no_terminal_event_count;
  target.multiple_terminal_event_count += source.multiple_terminal_event_count;
  target.malformed_pa_count += source.malformed_pa_count;
  target.unclassified_events += source.unclassified_events;
  target.unclassified_event_values = [...new Set([...target.unclassified_event_values, ...source.unclassified_event_values])].sort();
  target.excluded_non_pa_events += source.excluded_non_pa_events;
  target.excluded_non_pa_event_values = [...new Set([...target.excluded_non_pa_event_values, ...source.excluded_non_pa_event_values])].sort();
}

async function main(): Promise<void> {
  const slateDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const startDate = process.argv[3] ?? `${slateDate.slice(0, 4)}-03-20`;
  const endDate = process.argv[4] ?? previousIsoDate(slateDate);
  const calendarDates = dates(startDate, endDate);
  const allDates = await scheduledRegularSeasonDates(startDate, endDate);
  const aggregates: BVHDailyAggregate[] = [];
  const integrity = blankIntegrity();
  const sourceFailures: Array<{ date: string; status: string; errors: string[] }> = [];
  let cursor = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (cursor < allDates.length) {
      const date = allDates[cursor++]!;
      const source = await fetchSavantPitchLevelDay(date);
      if (source.status !== "success") sourceFailures.push({ date, status: source.status, errors: source.errors });
      const daily = deriveBVHDailyAggregates(source.events);
      aggregates.push(...daily.aggregates);
      addIntegrity(integrity, daily.integrity);
    }
  });
  await Promise.all(workers);

  const [schedule, startingNine] = await Promise.all([fetchMlbSchedule(slateDate), fetchStartingNine(slateDate)]);
  const teamIds = [...new Set(schedule.games.flatMap((game) => [game.awayTeam.id, game.homeTeam.id]).filter((id): id is number => id !== null))];
  const roster = await fetchTeamRosters(teamIds, slateDate.slice(0, 4));
  const lineupMap = buildStartingNineMap(startingNine, schedule.games.map((game) => game.legacy_game_id));
  const batterIds = new Set<number>();
  for (const game of lineupMap.values()) {
    for (const player of [...game.away_lineup, ...game.home_lineup]) {
      const id = roster.get(normalizeForMatch(player.name));
      if (id) batterIds.add(id);
    }
  }
  const pitcherIds = schedule.games.flatMap((game) => [game.awayProbablePitcher.id, game.homeProbablePitcher.id]).filter((id): id is number => id !== null);
  const [batterStats, pitcherStats] = await Promise.all([
    fetchBatterSeasonStats([...batterIds], slateDate.slice(0, 4)),
    fetchPitcherSeasonStats(pitcherIds, slateDate.slice(0, 4)),
  ]);
  const dataset = buildBVHDatasetFromDailyAggregates(aggregates, slateDate, integrity, [...batterIds]);
  const rerun = buildBVHDatasetFromDailyAggregates([...aggregates].reverse(), slateDate, integrity, [...batterIds]);

  const profiles = schedule.games.flatMap((game) => {
    const lineup = lineupMap.get(game.legacy_game_id);
    if (!lineup) return [];
    const homeHand = pitcherStats.stats.get(game.homeProbablePitcher.id ?? 0)?.hand ?? game.homeProbablePitcher.hand;
    const awayHand = pitcherStats.stats.get(game.awayProbablePitcher.id ?? 0)?.hand ?? game.awayProbablePitcher.hand;
    return [
      { game_id: game.legacy_game_id, side: "AWAY", profile: buildBVHLineupProfile(lineup.away_lineup, homeHand, roster, batterStats.stats, dataset) },
      { game_id: game.legacy_game_id, side: "HOME", profile: buildBVHLineupProfile(lineup.home_lineup, awayHand, roster, batterStats.stats, dataset) },
    ];
  });
  const lineupHitters = profiles.length * 9;
  const matched = profiles.reduce((sum, entry) => sum + entry.profile.matched_mlbam_hitters, 0);
  const noSample = profiles.reduce((sum, entry) => sum + entry.profile.no_sample_count, 0);
  const rValues = [...batterIds].map((id) => dataset.estimates.get(id)?.vs_rhp?.shrunk_ops).filter((value): value is number => value !== undefined);
  const lValues = [...batterIds].map((id) => dataset.estimates.get(id)?.vs_lhp?.shrunk_ops).filter((value): value is number => value !== undefined);
  const spotChecks = [...batterIds].map((id) => dataset.estimates.get(id)).filter((value) => value?.vs_lhp && value.vs_rhp)
    .sort((a, b) => Math.abs((b!.vs_lhp!.shrunk_ops - b!.vs_rhp!.shrunk_ops)) - Math.abs((a!.vs_lhp!.shrunk_ops - a!.vs_rhp!.shrunk_ops)))
    .slice(0, 3).map((entry) => ({
      batter_mlbam_id: entry!.batter_mlbam_id,
      batter_name: batterStats.stats.get(entry!.batter_mlbam_id)?.name ?? "",
      vs_lhp: entry!.vs_lhp,
      vs_rhp: entry!.vs_rhp,
      directional_difference_lhp_minus_rhp: Number((entry!.vs_lhp!.shrunk_ops - entry!.vs_rhp!.shrunk_ops).toFixed(6)),
    }));

  const summaryOnly = process.argv.includes("--summary-only");
  process.stdout.write(JSON.stringify({
    version: dataset.version,
    status: sourceFailures.length === 0 && integrity.unclassified_events === 0 && dataset.deterministic_hash === rerun.deterministic_hash
      ? "PARSER_COMMISSIONING_PASS" : "PARSER_COMMISSIONING_REVIEW_REQUIRED",
    requested_slate_date: slateDate, requested_history_start: startDate, requested_history_end: endDate,
    calendar_dates_in_range: calendarDates.length, dates_requested: allDates.length, source_failures: sourceFailures,
    cutoff: { requested_through: dataset.requested_through_date, actual_through: dataset.actual_data_through_date, lag_days: dataset.freshness_lag_days, status: dataset.freshness_status },
    pa_integrity: integrity,
    deterministic: { first_hash: dataset.deterministic_hash, reordered_hash: rerun.deterministic_hash, identical: dataset.deterministic_hash === rerun.deterministic_hash },
    slate_coverage: { games: schedule.total_games, lineup_profiles: profiles.length, total_lineup_slots: lineupHitters, matched_mlbam_hitters: matched, identity_coverage: lineupHitters > 0 ? matched / lineupHitters : 0, no_split_sample_count: noSample },
    non_degeneracy: { vs_rhp_distinct_unrounded: new Set(rValues).size, vs_lhp_distinct_unrounded: new Set(lValues).size },
    profiles: summaryOnly ? undefined : profiles,
    manual_spot_check_candidates: spotChecks,
  }, null, 2));
}

await main();
