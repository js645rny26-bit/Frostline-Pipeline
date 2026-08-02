import assert from "node:assert/strict";
import test from "node:test";
import { resolveDecisionScores, type DecisionScoreInput } from "./module11_decisionScoring.js";

const complete: DecisionScoreInput = {
  evidence: {
    game_id: "2026/08/02-A-B",
    date: "2026-08-02",
    away_pitcher_role: "CONVENTIONAL_STARTER",
    home_pitcher_role: "CONVENTIONAL_STARTER",
    away_expected_innings: 5.5,
    home_expected_innings: 6,
    bullpen_available: true,
    away_offense_source_status: "BLENDED",
    home_offense_source_status: "BLENDED",
    park_source_status: "VENUE_FACTOR_USED",
    away_lineup_status: "FULL",
    home_lineup_status: "FULL",
    away_lineup_source: "official",
    home_lineup_source: "official",
    weather_source_status: "LIVE",
    environment_certainty: "HIGH",
    weather_vehicle_status: "ACTIVE",
  },
  projected_total: 10.5,
  market_line: 8.5,
  direction: "OVER",
  final_decision: "CORE",
  core_blocker: "",
  survival_check: "PASS",
  survival_failure_reason: "",
  lock_status: "PRE_LOCK",
  calculated_ts: "2026-08-02T12:00:00.000Z",
  run_id: "RUN_TEST",
};

test("complete evidence translates existing gates into auditable scores", () => {
  const result = resolveDecisionScores(complete);
  assert.equal(result.truth_score, 100);
  assert.equal(result.stability_score, 100);
  assert.equal(result.vehicle_score, 66.67);
  assert.equal(result.composite_score, 66.67);
  assert.equal(result.score_decision, "BET");
  assert.equal(result.confirmation_gate, true);
});

test("vehicle scoring uses the existing STRONG_BUY boundary and clamps", () => {
  assert.equal(resolveDecisionScores({ ...complete, projected_total: 10 }).vehicle_score, 50);
  assert.equal(resolveDecisionScores({ ...complete, projected_total: 11.5 }).vehicle_score, 100);
  assert.equal(resolveDecisionScores({ ...complete, projected_total: 15 }).vehicle_score, 100);
});

test("composite is weakest-link and cannot average away unstable evidence", () => {
  const result = resolveDecisionScores({
    ...complete,
    evidence: {
      ...complete.evidence,
      away_lineup_source: "projected",
      home_lineup_source: "projected",
      environment_certainty: "LOW",
      weather_vehicle_status: "FREEZE_WEATHER_DEPENDENT",
    },
  });
  assert.equal(result.stability_score, 50);
  assert.equal(result.composite_score, 50);
  assert.ok(result.score_blockers.includes("LINEUPS_OFFICIAL"));
  assert.ok(result.score_blockers.includes("ENVIRONMENT_CERTAINTY"));
  assert.ok(result.score_blockers.includes("WEATHER_VEHICLE_ACTIVE"));
});

test("fallback-neutral weather stays explicit and lowers only stability", () => {
  const result = resolveDecisionScores({
    ...complete,
    evidence: {
      ...complete.evidence,
      weather_source_status: "FALLBACK_NEUTRAL",
      environment_certainty: "LOW",
      weather_vehicle_status: "FREEZE_WEATHER_DEPENDENT",
    },
  });
  assert.equal(result.truth_score, 100);
  assert.match(result.stability_components, /WEATHER_RESOLVED_OR_NEUTRAL=PASS\(FALLBACK_NEUTRAL\)/);
  assert.ok(result.stability_score < 100);
});

test("final gated decision maps exactly to BET, PASS, or PENDING", () => {
  const pass = resolveDecisionScores({ ...complete, final_decision: "NO_CORE", core_blocker: "UNRESOLVED_STARTER" });
  const pending = resolveDecisionScores({ ...complete, market_line: null, direction: "NONE", final_decision: "PENDING" });
  assert.equal(pass.score_decision, "PASS");
  assert.equal(pass.confirmation_gate, false);
  assert.equal(pending.score_decision, "PENDING");
  assert.equal(pending.truth_family, "NO_MARKET");
  assert.equal(pending.vehicle_score, 0);
});
