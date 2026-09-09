/** Read-only BVH commissioning audit. Never writes or reconstructs workbook state. */

import { readRange, WORKBOOK_ID } from "../lib/sheets/client.js";
import { BVH_BATTER_SPLIT_HEADERS, BVH_DAILY_HISTORY_HEADERS } from "../lib/pipeline/module02j_batterVsHandHistory.js";
import { BVH_PROJECTION_HISTORY_HEADERS } from "../lib/pipeline/module09b_bvhIntegration.js";
import { WORKBOOK_SCHEMA_VERSION } from "../lib/workbook/workbookSchema.js";

function text(value: unknown): string { return String(value ?? "").trim(); }
function headerMatches(actual: readonly unknown[], expected: readonly string[]): boolean {
  return expected.every((name, index) => text(actual[index]) === name);
}
function columnIndex(headers: readonly unknown[], name: string): number {
  return headers.findIndex((value) => text(value) === name);
}

async function main(): Promise<void> {
  const [packet, lineups, sources, daily, splits, projections, schema] = await Promise.all([
    readRange(WORKBOOK_ID, "PREGAME_PACKET_HISTORY!A1:EZ5000"),
    readRange(WORKBOOK_ID, "TODAY_LINEUPS!A1:T1000"),
    readRange(WORKBOOK_ID, "SOURCE_ACQUISITION_LOG!A1:P5000"),
    readRange(WORKBOOK_ID, "BVH_DAILY_HISTORY_V1!A1:O50000"),
    readRange(WORKBOOK_ID, "BVH_BATTER_SPLITS_V1!A1:AH5000"),
    readRange(WORKBOOK_ID, "BVH_PROJECTION_HISTORY_V1!A1:AQ5000"),
    readRange(WORKBOOK_ID, "SCHEMA_REFERENCE!A1:J10000"),
  ]);
  const packetRows = packet.values ?? [];
  const lineupRows = lineups.values ?? [];
  const sourceRows = sources.values ?? [];
  const packetHeaders = (packetRows[0] ?? []).map(text);
  const lineupHeaders = (lineupRows[0] ?? []).map(text);
  const dailyRows = daily.values ?? [];
  const splitRows = splits.values ?? [];
  const projectionRows = projections.values ?? [];
  const splitHeaders = splitRows[0] ?? [];
  const projectionHeaders = projectionRows[0] ?? [];
  const hitterIdentityFields = packetHeaders.filter((header) =>
    /batter|hitter|player.*id|lineup.*name|batting.*order/i.test(header));
  const savantRows = sourceRows.slice(1).filter((row) => text(row[1]) === "SOURCE_SAVANT_PITCH_LEVEL");
  const dates = new Set(packetRows.slice(1).map((row) => text(row[0]).slice(0, 10)).filter(Boolean));
  const activeIndex = columnIndex(projectionHeaders, "Active_Input");
  const integrationIndex = columnIndex(projectionHeaders, "Integration_Status");
  const hashIndex = columnIndex(projectionHeaders, "BVH_Deterministic_Hash");
  const lhpIndex = columnIndex(splitHeaders, "Shrunk_vs_LHP_OPS");
  const rhpIndex = columnIndex(splitHeaders, "Shrunk_vs_RHP_OPS");
  const unclassifiedIndex = columnIndex(splitHeaders, "BVH_Unclassified_Events");
  const schemaCells = new Set((schema.values ?? []).flat().map(text));
  const candidateRows = projectionRows.slice(1);
  const splitData = splitRows.slice(1);
  const failures: string[] = [];
  if (!headerMatches(lineupHeaders, [
    "Date", "Game_ID", "Team", "Batting_Order", "Player_Name", "Player_ID", "Position",
    "vs_LHP_OPS", "vs_RHP_OPS",
  ])) failures.push("TODAY_LINEUPS_BVH_HEADER_MISMATCH");
  if (!headerMatches(dailyRows[0] ?? [], BVH_DAILY_HISTORY_HEADERS)) failures.push("BVH_DAILY_HISTORY_HEADER_MISMATCH");
  if (!headerMatches(splitHeaders, BVH_BATTER_SPLIT_HEADERS)) failures.push("BVH_BATTER_SPLITS_HEADER_MISMATCH");
  if (!headerMatches(projectionHeaders, BVH_PROJECTION_HISTORY_HEADERS)) failures.push("BVH_PROJECTION_HISTORY_HEADER_MISMATCH");
  if (dailyRows.length <= 1) failures.push("BVH_DAILY_HISTORY_EMPTY");
  if (splitData.length === 0) failures.push("BVH_BATTER_SPLITS_EMPTY");
  if (candidateRows.length === 0) failures.push("BVH_PROJECTION_HISTORY_EMPTY");
  if (activeIndex < 0 || candidateRows.some((row) => text(row[activeIndex]) !== "NO")) failures.push("BVH_ACTIVE_INPUT_NOT_QUARANTINED");
  if (integrationIndex < 0 || candidateRows.some((row) => text(row[integrationIndex]) !== "BUILD_TEST_COPY")) failures.push("BVH_INTEGRATION_STATUS_INVALID");
  if (hashIndex < 0 || candidateRows.some((row) => !text(row[hashIndex]))) failures.push("BVH_PROJECTION_HASH_MISSING");
  if (unclassifiedIndex < 0 || splitData.some((row) => Number(row[unclassifiedIndex] ?? 0) !== 0)) failures.push("BVH_UNCLASSIFIED_EVENT_PRESENT");
  for (const required of ["BVH_DAILY_HISTORY_V1", "BVH_BATTER_SPLITS_V1", "BVH_PROJECTION_HISTORY_V1", "BVH_PROJECTION_REPLAY_V1", "BVH_PROJECTION_SUMMARY_V1"]) {
    if (!schemaCells.has(required)) failures.push(`SCHEMA_REFERENCE_MISSING_${required}`);
  }
  const report = {
    status: failures.length === 0 ? "BVH_TEST_COPY_COMMISSIONING_PASS" : "BVH_TEST_COPY_COMMISSIONING_FAIL",
    failures,
    workbook_id: WORKBOOK_ID,
    schema_version: WORKBOOK_SCHEMA_VERSION,
    packet_rows: Math.max(0, packetRows.length - 1),
    packet_dates: [...dates].sort(),
    frozen_packet_hitter_identity_fields: hitterIdentityFields,
    today_lineups_headers: lineupHeaders,
    today_lineups_rows: Math.max(0, lineupRows.length - 1),
    bvh_daily_history_rows: Math.max(0, dailyRows.length - 1),
    bvh_batter_split_rows: splitData.length,
    bvh_projection_candidate_rows: candidateRows.length,
    bvh_active_input_values: [...new Set(candidateRows.map((row) => text(row[activeIndex])))].sort(),
    bvh_integration_status_values: [...new Set(candidateRows.map((row) => text(row[integrationIndex])))].sort(),
    bvh_projection_hash_count: new Set(candidateRows.map((row) => text(row[hashIndex])).filter(Boolean)).size,
    bvh_distinct_lhp_values: new Set(splitData.map((row) => text(row[lhpIndex])).filter(Boolean)).size,
    bvh_distinct_rhp_values: new Set(splitData.map((row) => text(row[rhpIndex])).filter(Boolean)).size,
    retained_savant_pitch_level_snapshots: savantRows.length,
    savant_pitch_level_snapshots: savantRows.slice(-10).map((row) => ({
      snapshot_id: text(row[0]), fetch_ts: text(row[3]), data_through: text(row[4]),
      row_count: text(row[7]), status: text(row[12]), raw_storage: text(row[14]),
    })),
    historical_replay_status: hitterIdentityFields.length > 0
      ? "FROZEN_LINEUP_IDENTITY_FIELDS_PRESENT"
      : "BLOCKED_NO_FROZEN_HITTER_IDENTITY",
  };
  process.stdout.write(JSON.stringify(report, null, 2));
  if (process.argv.includes("--assert") && failures.length > 0) process.exitCode = 1;
}

await main();
