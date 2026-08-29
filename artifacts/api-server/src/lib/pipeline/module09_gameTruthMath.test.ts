import assert from "node:assert/strict";
import test from "node:test";
import {
  computeActiveOffenseCenter,
  computeActiveTeamProjection,
  MAX_RECENT_FORM_EFFECT,
  RECENT_FORM_WEIGHT,
  type ActiveTeamProjectionInput,
} from "./module09_gameTruthMath.js";

function input(
  overrides: Partial<ActiveTeamProjectionInput> = {},
): ActiveTeamProjectionInput {
  return {
    baseline_offense_rate: 4.5,
    environment_multiplier: 1,
    lineup: {
      coverage: 0,
      source: null,
      weighted_obp: null,
      weighted_slg: null,
      weighted_bb_pct: null,
      weighted_k_pct: null,
      weighted_xwoba: null,
      weighted_hard_hit_pct: null,
    },
    opposing_starter: {
      quality_factor: 1,
      expected_innings: 6,
      bb_pct: null,
      k_pct: null,
      whip: null,
      hr_per_9: null,
    },
    opposing_bullpen_quality: 1,
    ...overrides,
  };
}

test("neutral or unavailable matchup inputs preserve the established rate split", () => {
  const result = computeActiveTeamProjection(
    input({ environment_multiplier: 1.1 }),
  );

  assert.equal(result.starter_attack_runs, 3);
  assert.equal(result.bullpen_continuation_runs, 1.5);
  assert.equal(result.traffic_conversion_runs, 0);
  assert.equal(result.hr_xbh_damage_runs, 0);
  assert.equal(result.effective_starter_innings, 6);
  assert.equal(result.bullpen_exposure_innings, 3);
  assert.equal(result.baseball_only_runs, 4.5);
  assert.equal(result.projected_runs, 4.95);
  assert.equal(result.matchup_profile_status, "NEUTRAL");
});

test("same frozen active inputs reproduce the exact same price-blind team projection", () => {
  const frozenInput = input({
    environment_multiplier: 0.96,
    lineup: {
      coverage: 1,
      source: "official",
      weighted_obp: 0.337,
      weighted_slg: 0.431,
      weighted_bb_pct: 0.086,
      weighted_k_pct: 0.217,
      weighted_xwoba: 0.329,
      weighted_hard_hit_pct: 42.1,
    },
    opposing_starter: {
      quality_factor: 0.91,
      expected_innings: 5.7,
      bb_pct: 0.074,
      k_pct: 0.239,
      whip: 1.14,
      hr_per_9: 0.91,
    },
    opposing_bullpen_quality: 1.04,
  });
  const first = computeActiveTeamProjection(frozenInput);
  const replay = computeActiveTeamProjection({ ...frozenInput });
  assert.deepEqual(replay, first);
});

test("recent scoring is a bounded form modifier rather than the active offensive center", () => {
  const hot = computeActiveOffenseCenter({
    recent_form_rate: 6.3,
    lineup_factor: 1.04,
    lineup: { coverage: 1, source: "official" },
  });
  const cold = computeActiveOffenseCenter({
    recent_form_rate: 3.3,
    lineup_factor: 0.96,
    lineup: { coverage: 1, source: "official" },
  });

  assert.equal(hot.latent_lineup_rate, 4.68);
  assert.ok(hot.recent_form_multiplier <= 1 + MAX_RECENT_FORM_EFFECT);
  assert.ok(hot.active_offense_center < 5.1);
  assert.equal(cold.latent_lineup_rate, 4.32);
  assert.ok(cold.recent_form_multiplier >= 1 - MAX_RECENT_FORM_EFFECT);
  assert.ok(cold.active_offense_center > 3.97);
  assert.equal(RECENT_FORM_WEIGHT, 0.2);
});

test("missing exact lineup evidence uses a league center rather than recent conversion as talent", () => {
  const center = computeActiveOffenseCenter({
    recent_form_rate: 6.5,
    lineup_factor: 1.18,
    lineup: { coverage: 0, source: null },
  });

  assert.equal(center.latent_lineup_rate, 4.5);
  assert.equal(center.recent_form_multiplier, 1.08);
  assert.equal(center.active_offense_center, 4.86);
});

test("traffic and damage only strengthen a starter window when both sides of the matchup support them", () => {
  const result = computeActiveTeamProjection(
    input({
      lineup: {
        coverage: 1,
        source: "official",
        weighted_obp: 0.36,
        weighted_slg: 0.48,
        weighted_bb_pct: 0.11,
        weighted_k_pct: 0.18,
        weighted_xwoba: 0.36,
        weighted_hard_hit_pct: 50,
      },
      opposing_starter: {
        quality_factor: 1,
        expected_innings: 6,
        bb_pct: 0.12,
        k_pct: 0.18,
        whip: 1.55,
        hr_per_9: 1.5,
      },
    }),
  );

  assert.ok(result.traffic_matchup_factor > 1);
  assert.ok(result.damage_matchup_factor > 1);
  assert.ok(result.traffic_conversion_runs > 0);
  assert.ok(result.hr_xbh_damage_runs > 0);
  assert.ok(result.effective_starter_innings < 6);
  assert.ok(result.bullpen_exposure_innings > 3);
  assert.equal(
    result.effective_starter_innings + result.bullpen_exposure_innings,
    9,
  );
  assert.equal(result.matchup_profile_status, "ACTIVE");
});

test("a lineup without matching starter evidence stays neutral instead of posing as a matchup read", () => {
  const result = computeActiveTeamProjection(
    input({
      lineup: {
        coverage: 1,
        source: "official",
        weighted_obp: 0.36,
        weighted_slg: 0.48,
        weighted_bb_pct: 0.11,
        weighted_k_pct: 0.18,
        weighted_xwoba: 0.36,
        weighted_hard_hit_pct: 50,
      },
    }),
  );

  assert.equal(result.traffic_conversion_runs, 0);
  assert.equal(result.hr_xbh_damage_runs, 0);
  assert.equal(result.effective_starter_innings, 6);
  assert.equal(result.matchup_profile_status, "NEUTRAL");
});

test("positive traffic moves workload before it earns a direct run boost", () => {
  const trafficOnly = computeActiveTeamProjection(
    input({
      lineup: {
        coverage: 1,
        source: "official",
        weighted_obp: 0.35,
        weighted_slg: 0.4,
        weighted_bb_pct: 0.12,
        weighted_k_pct: 0.18,
        weighted_xwoba: 0.315,
        weighted_hard_hit_pct: 40,
      },
      opposing_starter: {
        quality_factor: 1,
        expected_innings: 6,
        bb_pct: 0.12,
        k_pct: 0.18,
        whip: 1.55,
        hr_per_9: 1.15,
      },
    }),
  );

  assert.ok(trafficOnly.effective_starter_innings < 6);
  assert.ok(trafficOnly.bullpen_exposure_innings > 3);
  assert.equal(trafficOnly.traffic_conversion_runs, 0);
});

test("suppression evidence can lower the starter window rather than making every profile an Over bonus", () => {
  const result = computeActiveTeamProjection(
    input({
      lineup: {
        coverage: 1,
        source: "official",
        weighted_obp: 0.28,
        weighted_slg: 0.35,
        weighted_bb_pct: 0.06,
        weighted_k_pct: 0.28,
        weighted_xwoba: 0.28,
        weighted_hard_hit_pct: 32,
      },
      opposing_starter: {
        quality_factor: 1,
        expected_innings: 6,
        bb_pct: 0.05,
        k_pct: 0.28,
        whip: 1.0,
        hr_per_9: 0.7,
      },
    }),
  );

  assert.ok(result.traffic_matchup_factor < 1);
  assert.ok(result.damage_matchup_factor < 1);
  assert.ok(result.traffic_conversion_runs < 0);
  assert.ok(result.hr_xbh_damage_runs < 0);
  assert.equal(result.effective_starter_innings, 6);
  assert.ok(result.projected_runs < 4.5);
});

test("components reconcile to the baseball-only and final team projections", () => {
  const result = computeActiveTeamProjection(
    input({
      environment_multiplier: 1.08,
      lineup: {
        coverage: 1,
        source: "official",
        weighted_obp: 0.345,
        weighted_slg: 0.44,
        weighted_bb_pct: 0.095,
        weighted_k_pct: 0.2,
        weighted_xwoba: 0.335,
        weighted_hard_hit_pct: 45,
      },
      opposing_starter: {
        quality_factor: 1.08,
        expected_innings: 5.5,
        bb_pct: 0.1,
        k_pct: 0.2,
        whip: 1.38,
        hr_per_9: 1.3,
      },
      opposing_bullpen_quality: 1.12,
    }),
  );

  const components =
    result.starter_attack_runs +
    result.bullpen_continuation_runs +
    result.traffic_conversion_runs +
    result.hr_xbh_damage_runs;
  assert.ok(Math.abs(components - result.baseball_only_runs) < 0.001);
  assert.equal(
    result.projected_runs,
    Number((result.baseball_only_runs * 1.08).toFixed(2)),
  );
});

test("partial projected lineup data is attenuated rather than treated as a full confirmed matchup", () => {
  const profile = {
    coverage: 0.6,
    source: "projected" as const,
    weighted_obp: 0.335,
    weighted_slg: 0.425,
    weighted_bb_pct: 0.09,
    weighted_k_pct: 0.205,
    weighted_xwoba: 0.325,
    weighted_hard_hit_pct: 42,
  };
  const starter = {
    quality_factor: 1,
    expected_innings: 6,
    bb_pct: 0.09,
    k_pct: 0.215,
    whip: 1.35,
    hr_per_9: 1.2,
  };
  const partial = computeActiveTeamProjection(
    input({ lineup: profile, opposing_starter: starter }),
  );
  const official = computeActiveTeamProjection(
    input({
      lineup: { ...profile, coverage: 1, source: "official" },
      opposing_starter: starter,
    }),
  );

  assert.equal(partial.matchup_profile_status, "PARTIAL");
  assert.ok(partial.traffic_conversion_runs < official.traffic_conversion_runs);
  assert.ok(partial.hr_xbh_damage_runs < official.hr_xbh_damage_runs);
});
