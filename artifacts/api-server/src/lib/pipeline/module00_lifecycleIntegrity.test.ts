import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTemporalFirewall } from "./module00_temporalFirewall.js";
import {
  DECISION_AUDIT_INDEX as C,
  settleDecisionAuditRows,
  upsertDecisionAuditPregameRows,
  type DecisionAuditPregameInput,
} from "./module20_decisionAuditLog.js";
import { selectNewImmutableVehicleRows } from "./module17_vehiclePostmortem.js";
import type { SettlementRow } from "./module14_shadowSettlement.js";

test("August 10 adversarial lifecycle preserves the original prospective state through settlement", () => {
  const gameId = "20260810_CHC_WSN";
  const firstPitch = "2026-08-10T22:45:00.000Z";
  const projectionTs = "2026-08-10T20:39:00.000Z";
  const finalDecisionTs = "2026-08-10T20:40:00.000Z";
  const freezeTs = "2026-08-10T20:40:30.000Z";
  const publicationTs = "2026-08-10T20:41:00.000Z";
  const settlementTs = "2026-08-11T03:00:00.000Z";

  assert.equal(evaluateTemporalFirewall([
    { legacy_game_id: gameId, scheduled_utc_time: firstPitch },
  ], projectionTs).allowed, true);

  const input: DecisionAuditPregameInput = {
    date: "2026-08-10", game_id: gameId, away_team: "CHC", home_team: "WSN",
    scheduled_first_pitch: firstPitch, run_id: "RUN_AUG10", model_version: "DA-1.1.0",
    lock_status: "LOCKED_IN", projected_away_runs: 4.2, projected_home_runs: 3.7,
    projected_total: 7.9, market_line: 8.5, direction: "UNDER", vehicle: "GAME_TOTAL",
    model_confidence: 0.74, model_blocker: "", statcast_preview_available: "AVAILABLE",
    model_decision: "CORE", projection_generated_ts: projectionTs,
    final_decision_ts: finalDecisionTs,
  };
  const frozen = upsertDecisionAuditPregameRows([], [input], freezeTs);
  const frozenPregame = structuredClone(frozen.rows[0]!.slice(0, 34));

  const vehicle = [[
    "2026-08-10", gameId, "CHC", "WSN", "GAME_TOTAL", 8.5, "UNDER", 7.9,
    -0.6, "CORE", "", "BUY", 0.74, publicationTs,
  ]];
  const lateVehicle = [[
    "2026-08-10", gameId, "CHC", "WSN", "GAME_TOTAL", 9, "OVER", 11.2,
    2.2, "NO_CORE", "LATE", "LEAN", 0.61, settlementTs,
  ]];

  assert.equal(evaluateTemporalFirewall([
    { legacy_game_id: gameId, scheduled_utc_time: firstPitch },
  ], settlementTs).allowed, false);
  const immutable = selectNewImmutableVehicleRows(vehicle, lateVehicle);
  assert.equal(immutable.protectedRows, 1);
  assert.deepEqual(immutable.newRows, []);

  const outcome = {
    date: "2026-08-10", game_id: gameId, away_team: "CHC", home_team: "WSN",
    repaired_projected_total: 7.9, actual_away_runs: 3, actual_home_runs: 2,
    actual_total: 5, error: 2.9, abs_error: 2.9, park_source_status: "VENUE_FACTOR_USED",
    away_offense_source: "BLENDED", home_offense_source: "BLENDED", settlement_ts: settlementTs,
    frozen_published_total: 7.9, frozen_error: 2.9, frozen_abs_error: 2.9,
    frozen_projection_source: "FROZEN_VEHICLE_LOG", repaired_minus_frozen: 0,
    frozen_market_line: 8.5, settlement_market_line: 8.5, frozen_ticket_result: "WIN",
    settlement_ticket_result: "WIN", projection_audit_status: "MATCHES_PUBLISHED",
    projected_away_starter: "Away Starter", projected_home_starter: "Home Starter",
    actual_away_starter: "Away Starter", actual_home_starter: "Home Starter",
    away_starter_match_status: "MATCH", home_starter_match_status: "MATCH",
    away_bulk_pitcher: "", home_bulk_pitcher: "", away_pitcher_chain: "",
    home_pitcher_chain: "", pitcher_provenance_status: "COMPLETE",
  } satisfies SettlementRow;
  const settled = settleDecisionAuditRows(frozen.rows, [outcome], settlementTs);

  assert.deepEqual(settled.rows[0]!.slice(0, 34), frozenPregame);
  assert.equal(settled.rows[0]![C.SETTLEMENT_TS], settlementTs);
  assert.equal(settled.rows[0]![C.FROZEN_TS], projectionTs);
  assert.equal(settled.rows[0]![C.FINAL_TS], finalDecisionTs);
  assert.equal(settled.rows[0]![C.FREEZE_TS], freezeTs);
  assert.ok(Date.parse(projectionTs) < Date.parse(finalDecisionTs));
  assert.ok(Date.parse(finalDecisionTs) < Date.parse(freezeTs));
  assert.ok(Date.parse(freezeTs) < Date.parse(publicationTs));
  assert.ok(Date.parse(publicationTs) < Date.parse(firstPitch));
  assert.ok(Date.parse(firstPitch) < Date.parse(settlementTs));
});
