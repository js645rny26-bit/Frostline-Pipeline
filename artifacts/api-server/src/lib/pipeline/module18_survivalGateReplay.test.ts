import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySurvivalReplayDiagnostics,
  gradeReplayThesis,
  pitcherProvenanceFlag,
  summarizeThesisOutcomes,
} from "./module18_survivalGateReplay.js";
import { selectCanonicalVehicleRows } from "./module17_vehiclePostmortem.js";

function legacyVehicleRow(date: string, gameId: string, publishTs: string, projectedTotal: number): unknown[] {
  return [
    date, gameId, "AAA", "BBB", "FULL_GAME_TOTAL", 8.5, "OVER", projectedTotal,
    1.5, "NO_CORE", "", "", "", publishTs,
  ];
}

test("survival replay preserves Over and Under pushes", () => {
  assert.equal(gradeReplayThesis("OVER", 9, 9), "PUSH");
  assert.equal(gradeReplayThesis("UNDER", 9, 9), "PUSH");
});

test("pushes are excluded from survival-gate win/loss denominators", () => {
  assert.deepEqual(summarizeThesisOutcomes([
    { thesis_correct: true },
    { thesis_correct: false },
    { thesis_correct: "PUSH" },
    { thesis_correct: null },
  ]), { wins: 1, losses: 1, pushes: 1 });
});

test("complete matched pitcher provenance is explicit", () => {
  assert.equal(pitcherProvenanceFlag({
    provenance_status: "COMPLETE",
    away_match_status: "MATCH",
    home_match_status: "MATCH",
  }), "COMPLETE_MATCH");
});

test("unresolved pregame starter cannot be labeled complete", () => {
  assert.equal(pitcherProvenanceFlag({
    provenance_status: "PARTIAL",
    away_match_status: "UNRESOLVED",
    home_match_status: "MATCH",
  }), "PARTIAL_PREGAME_STARTER_UNRESOLVED");
});

test("missing settlement provenance is explicitly unavailable", () => {
  assert.equal(pitcherProvenanceFlag(undefined), "UNAVAILABLE");
});

test("legacy latest-snapshot selection remains a warning without degrading replay execution", () => {
  const early = legacyVehicleRow("2026-07-28", "20260728_CLE_CIN", "2026-07-28T15:00:00.000Z", 8.1);
  const late = legacyVehicleRow("2026-07-28", "20260728_CLE_CIN", "2026-07-28T16:00:00.000Z", 8.8);
  const integrity = selectCanonicalVehicleRows([early, late]);
  const diagnostics = classifySurvivalReplayDiagnostics([], integrity.warnings);

  assert.deepEqual(integrity.rows, [late]);
  assert.equal(integrity.rejected.length, 0);
  assert.match(diagnostics.warnings[0] ?? "", /VEHICLE_LOG_LEGACY_PUBLISH_TS_SELECTION/);
  assert.equal(diagnostics.status, "success");
  assert.deepEqual(diagnostics.errors, []);
});

test("ambiguous legacy snapshot collision remains rejected but does not alone fail replay execution", () => {
  const first = legacyVehicleRow("2026-07-29", "20260729_ATL_NYM", "2026-07-29T15:59:42.730Z", 9.26);
  const second = legacyVehicleRow("2026-07-29", "20260729_ATL_NYM", "2026-07-29T15:59:42.730Z", 7.39);
  const integrity = selectCanonicalVehicleRows([first, second]);
  const diagnostics = classifySurvivalReplayDiagnostics([], integrity.warnings);

  assert.deepEqual(integrity.rows, []);
  assert.deepEqual(integrity.rejected, [{
    date: "2026-07-29", game_id: "20260729_ATL_NYM", reason: "VEHICLE_LOG_SNAPSHOT_COLLISION",
  }]);
  assert.match(diagnostics.warnings[0] ?? "", /VEHICLE_LOG_SNAPSHOT_COLLISION/);
  assert.equal(diagnostics.status, "success");
});

test("a genuine Module 18 error remains a partial result even when warnings are present", () => {
  const diagnostics = classifySurvivalReplayDiagnostics(
    ["Sheet write failed: controlled fixture failure"],
    ["VEHICLE_LOG_SNAPSHOT_COLLISION: controlled fixture warning"],
  );

  assert.equal(diagnostics.status, "partial");
  assert.equal(diagnostics.errors.length, 1);
  assert.equal(diagnostics.warnings.length, 1);
});
