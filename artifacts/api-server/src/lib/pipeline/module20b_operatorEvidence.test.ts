import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_LADDER_AUDIT_HEADERS,
  OPERATOR_EVIDENCE_OVERLAY_HEADERS,
  resolveOperatorEvidenceRows,
  upsertFullLadderAuditRows,
} from "./module20b_operatorEvidence.js";
import { PREGAME_PACKET_HISTORY_HEADERS } from "./module20a_pregamePacket.js";

const date = "2026-08-24";
const gameId = "20260824_TEX_CHW";
const firstPitch = "2026-08-24T23:40:00.000Z";

function packet(status: "OPEN_PROSPECTIVE" | "FROZEN_PREGAME", snapshotTs: string, freezeTs = ""): unknown[] {
  const row = Array(PREGAME_PACKET_HISTORY_HEADERS.length).fill("");
  const index = Object.fromEntries(PREGAME_PACKET_HISTORY_HEADERS.map((name, position) => [name, position]));
  row[index.Date] = date;
  row[index.Game_ID] = gameId;
  row[index.Run_ID] = "run-1";
  row[index.Scheduled_First_Pitch] = firstPitch;
  row[index.Packet_Status] = status;
  row[index.Packet_Snapshot_TS] = snapshotTs;
  row[index.Freeze_TS] = freezeTs;
  row[index.Base_Projection] = 8.5;
  row[index.Operator_Evidence_Fields] = "DIRECTIONAL_TRUTH=OVER; HARD_ROCK_TOTAL_LINES=6.5, 7.5, 8.5; PREFERRED_TOTAL_VEHICLE=OVER 7.5; BET_OR_PASS=PASS";
  return row;
}

test("operator overlays accept only explicit, timestamped pre-first-pitch fields", () => {
  const rows: unknown[][] = [
    [...OPERATOR_EVIDENCE_OVERLAY_HEADERS],
    [date, gameId, "Home starter", "Operator Starter", "2026-08-24T22:00:00.000Z", "MANUAL_OPERATOR", "confirmed"],
    [date, gameId, "Park multiplier", "1.07", "2026-08-24T22:01:00.000Z", "MANUAL_OPERATOR", "official venue note"],
    [date, gameId, "Weather", "late data", "2026-08-24T23:41:00.000Z", "MANUAL_OPERATOR", "too late"],
  ];
  const resolved = resolveOperatorEvidenceRows(rows, date, [{ legacy_game_id: gameId, scheduled_utc_time: firstPitch }]);
  const snapshot = resolved.snapshots.get(gameId);
  assert.equal(snapshot?.fields.get("HOME_STARTER"), "Operator Starter");
  assert.equal(snapshot?.fields.get("PARK_MULTIPLIER"), "1.07");
  assert.equal(snapshot?.field_supplied_ts.get("HOME_STARTER"), "2026-08-24T22:00:00.000Z");
  assert.equal(snapshot?.field_supplied_ts.get("PARK_MULTIPLIER"), "2026-08-24T22:01:00.000Z");
  assert.equal(snapshot?.fields.has("WEATHER"), false);
  assert.ok(resolved.warnings.some((warning) => warning.includes("NOT_PROSPECTIVE")));
});

test("full ladder uses the stored packet and freezes without late reconstruction", () => {
  const open = upsertFullLadderAuditRows([], [packet("OPEN_PROSPECTIVE", "2026-08-24T22:00:00.000Z")], "2026-08-24T22:05:00.000Z");
  assert.equal(open.rowsWritten, 1);
  assert.equal(open.rows[0]![FULL_LADDER_AUDIT_HEADERS.indexOf("Ledger_Status")], "OPEN_PROSPECTIVE");
  assert.equal(open.rows[0]![FULL_LADDER_AUDIT_HEADERS.indexOf("Preferred_Total_Vehicle")], "OVER 7.5");

  const frozen = upsertFullLadderAuditRows(
    open.rows,
    [packet("FROZEN_PREGAME", "2026-08-24T22:00:00.000Z", "2026-08-24T23:41:00.000Z")],
    "2026-08-24T23:42:00.000Z",
  );
  assert.equal(frozen.rowsFrozen, 1);
  assert.equal(frozen.rows[0]![FULL_LADDER_AUDIT_HEADERS.indexOf("Ledger_Status")], "FROZEN_PREGAME");
  const before = [...frozen.rows[0]!];

  const rerun = upsertFullLadderAuditRows(
    frozen.rows,
    [packet("OPEN_PROSPECTIVE", "2026-08-24T23:50:00.000Z")],
    "2026-08-24T23:51:00.000Z",
  );
  assert.deepEqual(rerun.rows[0], before);
});
