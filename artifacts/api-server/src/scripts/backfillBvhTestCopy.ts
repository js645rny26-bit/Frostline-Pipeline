/**
 * Explicit BVH V1 history loader for a disposable/non-canonical workbook.
 *
 * Usage:
 *   tsx src/scripts/backfillBvhTestCopy.ts START END SLATE_DATE WORKBOOK_ID
 *
 * Every scheduled regular-season day is fetched independently. The untouched
 * Savant response is retained before its PA aggregates can be appended. This
 * script never publishes projections and hard-rejects the canonical workbook.
 */

import { CANONICAL_WORKBOOK_ID } from "../lib/sheets/client.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fetchSavantPitchLevelDay } from "../lib/pipeline/module02h_savantPitchLevel.js";
import { persistSourceSnapshot } from "../lib/pipeline/module02_sourceSnapshots.js";
import {
  buildBVHDatasetFromDailyAggregates,
  deriveBVHDailyAggregates,
  type BVHPAIntegrity,
} from "../lib/pipeline/module02j_batterVsHand.js";
import {
  loadBVHDailyHistory,
  persistBVHDailyHistory,
  selectCanonicalBVHDailyHistory,
  writeBVHBatterSplits,
} from "../lib/pipeline/module02j_batterVsHandHistory.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CALENDAR_DAYS = 31;

function dayNumber(value: string): number {
  return Math.floor(Date.parse(`${value}T12:00:00.000Z`) / 86_400_000);
}

export function assertBVHBackfillRequest(
  startDate: string,
  endDate: string,
  slateDate: string,
  workbookId: string,
): void {
  if (![startDate, endDate, slateDate].every((value) => ISO_DATE.test(value))) {
    throw new Error("BVH_BACKFILL_INVALID_DATE: expected YYYY-MM-DD");
  }
  if (startDate > endDate) throw new Error("BVH_BACKFILL_INVALID_RANGE: start exceeds end");
  if (endDate >= slateDate) throw new Error("BVH_BACKFILL_CUTOFF_VIOLATION: end must be before slate date");
  const span = dayNumber(endDate) - dayNumber(startDate) + 1;
  if (!Number.isFinite(span) || span < 1 || span > MAX_CALENDAR_DAYS) {
    throw new Error(`BVH_BACKFILL_RANGE_LIMIT: maximum ${MAX_CALENDAR_DAYS} calendar days per run`);
  }
  if (!workbookId) throw new Error("BVH_BACKFILL_WORKBOOK_REQUIRED");
  if (workbookId === CANONICAL_WORKBOOK_ID) {
    throw new Error("BVH_BACKFILL_CANONICAL_FORBIDDEN: use a disposable/test workbook");
  }
}

async function scheduledDates(startDate: string, endDate: string): Promise<string[]> {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("gameType", "R");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`BVH_BACKFILL_SCHEDULE_HTTP_${response.status}`);
  const payload = await response.json() as { dates?: Array<{ date?: string; games?: unknown[] }> };
  return (payload.dates ?? [])
    .filter((entry) => entry.date && (entry.games?.length ?? 0) > 0)
    .map((entry) => entry.date!)
    .filter((date) => date >= startDate && date <= endDate)
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
  const [startDate = "", endDate = "", slateDate = "", workbookId = ""] = process.argv.slice(2);
  assertBVHBackfillRequest(startDate, endDate, slateDate, workbookId);
  const dates = await scheduledDates(startDate, endDate);
  const integrity = blankIntegrity();
  const days: Array<{ date: string; pitch_rows: number; aggregate_rows: number; source_snapshot_id: string }> = [];

  for (const date of dates) {
    const source = await fetchSavantPitchLevelDay(date);
    if (source.status !== "success" || !source.source_snapshot) {
      throw new Error(`BVH_BACKFILL_SOURCE_FAILURE: ${date}: ${source.errors.join(" | ") || source.status}`);
    }
    const retained = await persistSourceSnapshot(source.source_snapshot, workbookId);
    if (retained.status !== "success") {
      throw new Error(`BVH_BACKFILL_RAW_RETENTION_FAILURE: ${date}: ${retained.errors.join(" | ")}`);
    }
    const daily = deriveBVHDailyAggregates(source.events);
    addIntegrity(integrity, daily.integrity);
    if (daily.integrity.unclassified_events > 0) {
      throw new Error(
        `BVH_BACKFILL_UNCLASSIFIED_EVENT: ${date}: ${daily.integrity.unclassified_event_values.join(" | ")}`,
      );
    }
    const persisted = await persistBVHDailyHistory(
      daily.aggregates,
      retained.snapshot_id,
      source.source_snapshot.fetch_timestamp_utc,
      date,
      workbookId,
    );
    if (persisted.errors.length > 0) {
      throw new Error(`BVH_BACKFILL_DERIVED_RETENTION_FAILURE: ${date}: ${persisted.errors.join(" | ")}`);
    }
    days.push({
      date,
      pitch_rows: source.events.length,
      aggregate_rows: daily.aggregates.length,
      source_snapshot_id: retained.snapshot_id,
    });
  }

  const history = selectCanonicalBVHDailyHistory(await loadBVHDailyHistory(workbookId));
  const dataset = buildBVHDatasetFromDailyAggregates(history, slateDate, integrity);
  await writeBVHBatterSplits(dataset, workbookId);
  process.stdout.write(JSON.stringify({
    status: "success",
    mode: "DISPOSABLE_TEST_COPY_ONLY",
    workbook_id: workbookId,
    start_date: startDate,
    end_date: endDate,
    slate_date: slateDate,
    scheduled_days: dates.length,
    days,
    integrity,
    total_history_rows: history.length,
    batter_estimates: dataset.estimates.size,
    requested_through_date: dataset.requested_through_date,
    actual_data_through_date: dataset.actual_data_through_date,
    freshness_status: dataset.freshness_status,
    deterministic_hash: dataset.deterministic_hash,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
