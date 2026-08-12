import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProspectivePublicationAllowed,
  evaluateTemporalFirewall,
} from "./module00_temporalFirewall.js";

const AUG10 = [{
  legacy_game_id: "20260810_CHC_WSN",
  scheduled_utc_time: "2026-08-10T22:45:00.000Z",
}];

test("August 10 adversarial replay: prospective writes are allowed before first pitch", () => {
  const result = evaluateTemporalFirewall(AUG10, "2026-08-10T22:44:59.999Z");
  assert.equal(result.allowed, true);
  assert.equal(result.code, "PREGAME_MUTATION_ALLOWED");
});

test("August 10 adversarial replay: first pitch closes every mutable pregame path", () => {
  const atPitch = evaluateTemporalFirewall(AUG10, "2026-08-10T22:45:00.000Z");
  const postgame = evaluateTemporalFirewall(AUG10, "2026-08-11T03:00:00.000Z");
  assert.equal(atPitch.allowed, false);
  assert.deepEqual(atPitch.blocked_games, ["20260810_CHC_WSN"]);
  assert.equal(postgame.allowed, false);
  assert.throws(
    () => assertProspectivePublicationAllowed(AUG10, "2026-08-11T03:00:00.000Z"),
    /TEMPORAL_FIREWALL_BLOCKED/,
  );
});

test("missing first-pitch time fails closed instead of creating prospective evidence", () => {
  const result = evaluateTemporalFirewall([
    { legacy_game_id: "20260811_HOU_SFG", scheduled_utc_time: null },
  ], "2026-08-11T12:00:00.000Z");
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missing_time_games, ["20260811_HOU_SFG"]);
});

test("REPLAY and SETTLEMENT surfaces remain explicitly non-pregame", () => {
  assert.equal(evaluateTemporalFirewall(AUG10, "2026-08-11T03:00:00.000Z", "REPLAY").allowed, true);
  assert.equal(evaluateTemporalFirewall(AUG10, "2026-08-11T03:00:00.000Z", "SETTLEMENT").allowed, true);
});
