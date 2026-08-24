import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectionalV2Summary,
  buildMonotonicityV2Replay,
  parseFrozenMonotonicityV2Observations,
  poolNearbyEdgeRegions,
  type MonotonicityV2Observation,
} from "./module23_monotonicityV2.js";

function observation(index: number, edge: number, result: "WIN" | "LOSS" | "PUSH", absError = 2, v1Blocked = false): MonotonicityV2Observation {
  return {
    date: "2026-08-24", game_id: `G${index}`, direction: "OVER", edge,
    frozen_projection: 8 + edge, frozen_market_line: 8, actual_total: result === "WIN" ? 9 : result === "LOSS" ? 7 : 8,
    error: result === "WIN" ? -absError : absError, abs_error: absError, directional_result: result,
    v1_status: v1Blocked ? "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE" : "NOT_BLOCKED", v1_blocked: v1Blocked,
  };
}

test("V2 keeps sparse evidence UNVERIFIED and never makes it a shadow block", () => {
  const summary = buildDirectionalV2Summary("OVER", [observation(1, 1.5, "WIN"), observation(2, 2.5, "LOSS")]);
  assert.equal(summary.state, "UNVERIFIED");
  const replay = buildMonotonicityV2Replay([observation(1, 1.5, "WIN")], [summary], "2026-08-24T00:00:00.000Z");
  assert.equal(replay[0]![14], "FALSE");
  assert.equal(replay[0]![15], "NONE");
  assert.equal(replay[0]![16], "UNVERIFIED_NO_EDGE_CREDIT");
});

test("V2 identifies strong anti-monotone frozen evidence without using a fixed tier minimum", () => {
  const rows = Array.from({ length: 36 }, (_, index) => observation(index, index + 1, index < 18 ? "WIN" : "LOSS", index + 1));
  const summary = buildDirectionalV2Summary("OVER", rows);
  assert.equal(summary.state, "ANTI_MONOTONE");
  assert.equal(summary.relationship, "NEGATIVE");
  assert.equal(summary.v2_blocked_winner_count, 18);
  assert.equal(summary.v2_blocked_loser_count, 18);
});

test("PAVA pools adjacent reliability violations instead of requiring fixed edge tiers", () => {
  const rows = [observation(1, 1, "WIN"), observation(2, 2, "LOSS"), observation(3, 3, "LOSS"), observation(4, 4, "WIN")];
  const regions = poolNearbyEdgeRegions(rows);
  assert.equal(regions.length, 2);
  assert.equal(regions[0]!.edge_min, 1);
  assert.equal(regions[0]!.edge_max, 3);
  assert.equal(regions[0]!.fitted_hit_rate_pct, 33.333);
});

test("replay retains V1 wall winners and parses only frozen vehicle snapshots", () => {
  const vehicleRows: unknown[][] = [
    ["2026-08-24", "G1", "A", "H", "GAME_TOTAL", 7.5, "OVER", 9.5, 2, "NO_CORE", "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"],
    ["2026-08-24", "G1", "A", "H", "GAME_TOTAL", 7.5, "OVER", 12, 4, "NO_CORE", "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"],
    ["2026-08-24", "G2", "A", "H", "GAME_TOTAL", 8, "NONE", 9, 1, "NO_CORE", ""],
  ];
  const outcomes: unknown[][] = [["2026-08-24", "G1", "A", "H", 9.5, 10]];
  const parsed = parseFrozenMonotonicityV2Observations(vehicleRows, outcomes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.v1_blocked, true);
  assert.equal(parsed[0]!.directional_result, "WIN");
  const summary = buildDirectionalV2Summary("OVER", parsed);
  assert.equal(summary.v1_blocked_winner_count, 1);
});
