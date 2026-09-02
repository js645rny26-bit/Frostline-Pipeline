import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStrictStructuralEligibility,
  selectLastLegitimatePregameSnapshot,
  STRICT_STRUCTURAL_COHORT_VERSION,
} from "./strictStructuralEligibilityShared.js";

const truth = [
  "STARTERS_RESOLVED=PASS(R/R)",
  "EXPECTED_INNINGS_PRESENT=PASS(6/6)",
  "BULLPEN_USABLE=PASS(both)",
  "OFFENSE_SOURCE_USABLE=PASS(BLENDED/BLENDED)",
  "LINEUP_DATA_USABLE=PASS(FULL/FULL)",
  "PARK_SOURCE_USABLE=PASS(SEASONAL_FACTOR_USED)",
].join(" | ");

const stability = [
  "LINEUPS_OFFICIAL=PASS(official/official)",
  "LINEUPS_FULL=PASS(FULL/FULL)",
  "OFFENSE_SOURCES_BLENDED=PASS(BLENDED/BLENDED)",
  "WEATHER_RESOLVED_OR_NEUTRAL=PASS(LIVE)",
  "ENVIRONMENT_CERTAINTY=PASS(HIGH)",
  "WEATHER_VEHICLE_ACTIVE=PASS(ACTIVE)",
].join(" | ");

const complete = {
  core_packet_status: "COMPLETE",
  truth_checks: truth,
  stability_checks: stability,
  opener_chain_state: "NO_OPENER_IDENTIFIED",
  away_lineup_status: "FULL",
  home_lineup_status: "FULL",
  away_lineup_coverage: 1,
  home_lineup_coverage: 1,
  environment_certainty: "HIGH",
  weather_vehicle_status: "ACTIVE",
  stability_score: 100,
};

test("all fourteen strict checks must pass and raw evidence remains frozen in the vector", () => {
  const result = classifyStrictStructuralEligibility(complete);
  assert.equal(result.cohort_version, STRICT_STRUCTURAL_COHORT_VERSION);
  assert.equal(result.verdict, "STRICT_STRUCTURAL_ELIGIBLE");
  assert.equal(result.exclusion_reasons, "");
  assert.equal(Object.values(result.checks).every((state) => state === "PASS"), true);
  assert.match(result.check_vector, /OPENER_CHAIN_CLEAN=PASS\(NO_OPENER_IDENTIFIED\)/);
  assert.match(result.check_vector, /LINEUPS_FULL=PASS\(AWAY_FULL_1\/HOME_FULL_1\)/);
});

test("each named strict criterion is independently required", () => {
  const cases: Array<[string, Partial<typeof complete>]> = [
    ["CORE_PACKET_COMPLETE", { core_packet_status: "MARKET_SNAPSHOT_MISSING" }],
    ["STARTERS_RESOLVED", { truth_checks: truth.replace("STARTERS_RESOLVED=PASS", "STARTERS_RESOLVED=FAIL") }],
    ["EXPECTED_INNINGS_PRESENT", { truth_checks: truth.replace("EXPECTED_INNINGS_PRESENT=PASS", "EXPECTED_INNINGS_PRESENT=FAIL") }],
    ["OPENER_CHAIN_CLEAN", { opener_chain_state: "OPENER_CHAIN_UNCERTAINTY" }],
    ["BULLPEN_USABLE", { truth_checks: truth.replace("BULLPEN_USABLE=PASS", "BULLPEN_USABLE=FAIL") }],
    ["OFFENSE_SOURCE_USABLE", { truth_checks: truth.replace("OFFENSE_SOURCE_USABLE=PASS", "OFFENSE_SOURCE_USABLE=FAIL") }],
    ["LINEUP_DATA_USABLE", { truth_checks: truth.replace("LINEUP_DATA_USABLE=PASS", "LINEUP_DATA_USABLE=FAIL") }],
    ["PARK_SOURCE_USABLE", { truth_checks: truth.replace("PARK_SOURCE_USABLE=PASS", "PARK_SOURCE_USABLE=FAIL") }],
    ["LINEUPS_OFFICIAL", { stability_checks: stability.replace("LINEUPS_OFFICIAL=PASS", "LINEUPS_OFFICIAL=FAIL") }],
    ["LINEUPS_FULL", { home_lineup_coverage: 0.8888888889 }],
    ["OFFENSE_SOURCES_BLENDED", { stability_checks: stability.replace("OFFENSE_SOURCES_BLENDED=PASS", "OFFENSE_SOURCES_BLENDED=FAIL") }],
    ["WEATHER_RESOLVED_OR_NEUTRAL", { stability_checks: stability.replace("WEATHER_RESOLVED_OR_NEUTRAL=PASS", "WEATHER_RESOLVED_OR_NEUTRAL=FAIL") }],
    ["ENVIRONMENT_CERTAINTY_HIGH", { environment_certainty: "MEDIUM" }],
    ["WEATHER_VEHICLE_ACTIVE", { weather_vehicle_status: "CAUTION" }],
  ];

  for (const [criterion, overrides] of cases) {
    const result = classifyStrictStructuralEligibility({ ...complete, ...overrides });
    assert.equal(result.verdict, "STRICT_STRUCTURAL_EXCLUDED", criterion);
    assert.notEqual(result.checks[criterion as keyof typeof result.checks], "PASS", criterion);
  }
});

test("strict cohort excludes partial lineup, opener uncertainty, incomplete environment, and inactive weather", () => {
  const result = classifyStrictStructuralEligibility({
    ...complete,
    opener_chain_state: "OPENER_CHAIN_UNCERTAINTY",
    home_lineup_status: "PARTIAL",
    home_lineup_coverage: 0.8888888889,
    environment_certainty: "MEDIUM",
    weather_vehicle_status: "FREEZE_WEATHER_DEPENDENT",
  });
  assert.equal(result.verdict, "STRICT_STRUCTURAL_EXCLUDED");
  assert.deepEqual(result.exclusion_reasons.split("; "), [
    "OPENER_CHAIN_CLEAN=FAIL",
    "LINEUPS_FULL=FAIL",
    "ENVIRONMENT_CERTAINTY_HIGH=FAIL",
    "WEATHER_VEHICLE_ACTIVE=FAIL",
  ]);
  assert.match(result.check_vector, /LINEUPS_FULL=FAIL\(AWAY_FULL_1\/HOME_PARTIAL_0\.8888888889\)/);
});

test("MEDIUM and LOW environment certainty always fail the strict cohort", () => {
  for (const certainty of ["MEDIUM", "LOW"]) {
    const result = classifyStrictStructuralEligibility({ ...complete, environment_certainty: certainty });
    assert.equal(result.verdict, "STRICT_STRUCTURAL_EXCLUDED", certainty);
    assert.equal(result.checks.ENVIRONMENT_CERTAINTY_HIGH, "FAIL", certainty);
  }
});

test("missing source evidence fails strict eligibility rather than receiving an inferred pass", () => {
  const result = classifyStrictStructuralEligibility({
    ...complete,
    truth_checks: "STARTERS_RESOLVED=PASS(R/R)",
    stability_checks: "LINEUPS_OFFICIAL=PASS(official/official)",
    environment_certainty: "",
    weather_vehicle_status: "",
  });
  assert.equal(result.verdict, "STRICT_STRUCTURAL_EXCLUDED");
  assert.equal(result.checks.BULLPEN_USABLE, "MISSING");
  assert.equal(result.checks.OFFENSE_SOURCES_BLENDED, "MISSING");
  assert.equal(result.checks.ENVIRONMENT_CERTAINTY_HIGH, "MISSING");
  assert.equal(result.checks.WEATHER_VEHICLE_ACTIVE, "MISSING");
});

test("stability score is only a consistency diagnostic and cannot change membership", () => {
  const result = classifyStrictStructuralEligibility({ ...complete, stability_score: 83.33 });
  assert.equal(result.verdict, "STRICT_STRUCTURAL_ELIGIBLE");
  assert.match(result.check_vector, /STABILITY_VECTOR_INCONSISTENT=TRUE\(Stability_Score=83\.33\)/);
});

test("last legitimate pre-first-pitch snapshot wins without fallback to an earlier qualifying snapshot", () => {
  const selected = selectLastLegitimatePregameSnapshot([
    {
      packet_snapshot_ts: "2026-09-02T21:00:00.000Z",
      scheduled_first_pitch: "2026-09-02T23:10:00.000Z",
      value: "EARLIER_QUALIFYING",
    },
    {
      packet_snapshot_ts: "2026-09-02T22:55:00.000Z",
      scheduled_first_pitch: "2026-09-02T23:10:00.000Z",
      value: "LATER_EXCLUDED",
    },
    {
      packet_snapshot_ts: "2026-09-02T23:11:00.000Z",
      scheduled_first_pitch: "2026-09-02T23:10:00.000Z",
      value: "POST_START_REJECTED",
    },
  ]);
  assert.equal(selected?.value, "LATER_EXCLUDED");
});

test("no legitimate pre-first-pitch packet has no membership snapshot", () => {
  assert.equal(selectLastLegitimatePregameSnapshot([
    {
      packet_snapshot_ts: "2026-09-02T23:10:00.000Z",
      scheduled_first_pitch: "2026-09-02T23:10:00.000Z",
      value: "AT_FIRST_PITCH",
    },
  ]), null);
});
