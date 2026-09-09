/** Read-only BVH commissioning audit. Never writes or reconstructs workbook state. */

import { readRange, WORKBOOK_ID } from "../lib/sheets/client.js";

function text(value: unknown): string { return String(value ?? "").trim(); }

async function main(): Promise<void> {
  const [packet, lineups, sources] = await Promise.all([
    readRange(WORKBOOK_ID, "PREGAME_PACKET_HISTORY!A1:EZ5000"),
    readRange(WORKBOOK_ID, "TODAY_LINEUPS!A1:T1000"),
    readRange(WORKBOOK_ID, "SOURCE_ACQUISITION_LOG!A1:P5000"),
  ]);
  const packetRows = packet.values ?? [];
  const lineupRows = lineups.values ?? [];
  const sourceRows = sources.values ?? [];
  const packetHeaders = (packetRows[0] ?? []).map(text);
  const hitterIdentityFields = packetHeaders.filter((header) =>
    /batter|hitter|player.*id|lineup.*name|batting.*order/i.test(header));
  const savantRows = sourceRows.slice(1).filter((row) => text(row[1]) === "SOURCE_SAVANT_PITCH_LEVEL");
  const dates = new Set(packetRows.slice(1).map((row) => text(row[0]).slice(0, 10)).filter(Boolean));
  process.stdout.write(JSON.stringify({
    workbook_id: WORKBOOK_ID,
    packet_rows: Math.max(0, packetRows.length - 1),
    packet_dates: [...dates].sort(),
    frozen_packet_hitter_identity_fields: hitterIdentityFields,
    today_lineups_headers: (lineupRows[0] ?? []).map(text),
    today_lineups_rows: Math.max(0, lineupRows.length - 1),
    retained_savant_pitch_level_snapshots: savantRows.length,
    savant_pitch_level_snapshots: savantRows.slice(-10).map((row) => ({
      snapshot_id: text(row[0]), fetch_ts: text(row[3]), data_through: text(row[4]),
      row_count: text(row[7]), status: text(row[12]), raw_storage: text(row[14]),
    })),
    historical_replay_status: hitterIdentityFields.length > 0
      ? "FROZEN_LINEUP_IDENTITY_FIELDS_PRESENT"
      : "BLOCKED_NO_FROZEN_HITTER_IDENTITY",
  }, null, 2));
}

await main();
