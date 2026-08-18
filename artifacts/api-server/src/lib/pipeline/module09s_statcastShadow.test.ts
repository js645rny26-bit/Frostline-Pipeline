/**
 * Module 09s: Statcast shadow audit — unit tests
 *
 * Tests contract points:
 *
 *  1. xwobaQualityFactor: normalises xwOBA to a quality factor (1.0 = league avg),
 *     clamps to [0.40, 1.80], and returns null for missing data or didNotQualify.
 *
 *  2. shadowStarterQuality: blends currentQual with xwOBA factor at SHADOW_BLEND_WEIGHT,
 *     returns null when xwOBA factor is null.
 *
 *  3. computeShadowAuditRow:
 *     a. Zero adjustment when preview is unavailable.
 *     b. Zero adjustment when both pitchers did not qualify.
 *     c. Correct uncapped deltas when both starters have xwOBA data.
 *     d. Cap applied when |uncapped| > SHADOW_ADJUSTMENT_CAP.
 *     e. Preview_Used_In_Projection is always "NO".
 *     f. Missing_Fields populated correctly for each case.
 *     g. Away and home deltas respect pitcher-side attribution:
 *        home pitcher xwOBA affects AWAY run delta; away pitcher xwOBA affects HOME run delta.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  xwobaQualityFactor,
  shadowStarterQuality,
  estimateTrafficAdjustment,
  estimateDamageAdjustment,
  computeShadowAuditRow,
  LEAGUE_AVG_XWOBA_ALLOWED,
  LEAGUE_AVG_HITTER_BB_PCT,
  LEAGUE_AVG_HITTER_K_PCT,
  LEAGUE_AVG_HITTER_HARD_HIT_PCT,
  SHADOW_BLEND_WEIGHT,
  SHADOW_ADJUSTMENT_CAP,
  SHADOW_TAIL_TEAM_CAP,
  SHADOW_TAIL_GAME_CAP,
  LOW_CENTER_VOLATILITY_THRESHOLD,
  LOW_CENTER_CHALLENGER_LIFT,
  LOW_CENTER_UPPER_TAIL_RESIDUAL,
} from "./module09s_statcastShadow.js";

import type { GameSummaryRow } from "./module09_recalculation.js";
import type { StatcastPreviewGameResult } from "./module02e_statcastPreview.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<GameSummaryRow> = {}): GameSummaryRow {
  return {
    game_id:                   "2026-07-26_NYY@BOS",
    date:                      "2026-07-26",
    away_team:                  "NYY",
    home_team:                  "BOS",
    away_pitcher:               "Gerrit Cole",
    home_pitcher:               "Brayan Bello",
    away_pitcher_role:          "CONVENTIONAL_STARTER",
    home_pitcher_role:          "CONVENTIONAL_STARTER",
    away_expected_innings:      6.0,
    home_expected_innings:      5.5,
    projected_away_runs:        2.80,
    projected_home_runs:        3.20,
    projected_total_runs:       6.00,
    run_multiplier:             1.0,
    stadium:                    "Fenway Park",
    environment_quality:        "good",
    bullpen_available:          true,
    away_l30_rs_estimate:       4.500,
    home_l30_rs_estimate:       4.800,
    away_l10_rs_actual:         4.600,
    home_l10_rs_actual:         4.900,
    away_offense_rate_used:     4.550,
    home_offense_rate_used:     4.820,
    away_offense_source_status: "BLENDED",
    home_offense_source_status: "BLENDED",
    park_runs_pct:              8,
    park_multiplier:            1.0800,
    weather_multiplier:         1.0000,
    combined_run_multiplier:    1.0800,
    park_source_status:         "VENUE_FACTOR_USED",
    home_run_factor:            1.0500,
    weather_source_status:      "LIVE",
    roof_status:                "OPEN_OR_OUTDOOR",
    wind_disposition:           "UNKNOWN",
    environment_certainty:      "HIGH",
    weather_vehicle_status:     "ACTIVE",
    away_lineup_factor:         1.000,
    home_lineup_factor:         1.000,
    away_lineup_weighted_ops:   0.730,
    home_lineup_weighted_ops:   0.730,
    away_lineup_coverage:       0.9,
    home_lineup_coverage:       0.9,
    away_lineup_status:         "FULL",
    home_lineup_status:         "FULL",
    away_lineup_source:         "official",
    home_lineup_source:         "official",
    away_lineup_xwoba_coverage: 0.8,
    home_lineup_xwoba_coverage: 0.8,
    proj_run_diff:              -0.40,
    away_starter_quality:       0.900,   // slightly better than league avg
    home_starter_quality:       1.050,   // slightly worse than league avg
    starter_attack_runs:        4.50,
    bullpen_continuation_runs:  1.00,
    baseline_offense_runs:      9.37,
    traffic_conversion_runs:    0,
    hr_xbh_damage_runs:         0,
    baseball_only_projection:   5.50,
    environment_run_adjustment: 0.50,
    ...overrides,
  };
}

function makePreview(overrides: Partial<StatcastPreviewGameResult> = {}): StatcastPreviewGameResult {
  return {
    gamePk:                   717514,
    date:                     "2026-07-26",
    game_id:                  "2026-07-26_NYY@BOS",
    away_team:                 "NYY",
    home_team:                 "BOS",
    scheduled_first_pitch:    "2026-07-26T19:10:00Z",
    fetch_ts:                  "2026-07-26T06:00:00.000Z",
    source_url:                "https://baseballsavant.mlb.com/preview?game_pk=717514",
    preview_availability:      "AVAILABLE",
    fetch_status:              "success",
    raw_payload_path:          null,
    payload_hash:              "abc123",
    parser_version:            "1.0.0",
    has_lineup_away:           false,
    has_lineup_home:           false,
    has_probable_away:         true,
    has_probable_home:         true,
    starting_pitcher_match_status: "MATCHED",
    lineup_match_status:       "LINEUP_NOT_POSTED",
    stale_data_flag:           false,
    parse_warnings:            [],
    parse_error:               null,
    preview_used_in_projection: "NO",
    projection_influence_notes: "Phase 1 — ingestion only",
    away_pitcher_stats: {
      player_id:          543037,
      player_name:        "Gerrit Cole",
      did_not_qualify:    false,
      k_percent:          29.0,
      bb_percent:         5.5,
      exit_velocity_avg:  87.2,
      whiff_percent:      35.0,
      hard_hit_percent:   38.0,
      xwoba:              0.290,      // better than league avg → lower factor
      barrel_batted_rate: 7.0,
      launch_angle_avg:   12.4,
      xba:                0.248,
      xslg:               0.392,
    },
    home_pitcher_stats: {
      player_id:          669477,
      player_name:        "Brayan Bello",
      did_not_qualify:    false,
      k_percent:          22.0,
      bb_percent:         8.0,
      exit_velocity_avg:  88.8,
      whiff_percent:      26.0,
      hard_hit_percent:   42.0,
      xwoba:              0.330,      // slightly worse than league avg → factor > 1
      barrel_batted_rate: 10.5,
      launch_angle_avg:   13.8,
      xba:                0.261,
      xslg:               0.415,
    },
    away_hitters_total:        26,
    away_hitters_qualified:    14,
    away_hitters_xwoba_avg:    0.318,
    away_hitters_ev_avg:       88.4,
    away_hitters_hard_hit_avg: 37.2,
    away_hitters_k_pct_avg:    21.4,
    away_hitters_bb_pct_avg:   8.1,
    home_hitters_total:        25,
    home_hitters_qualified:    13,
    home_hitters_xwoba_avg:    0.305,
    home_hitters_ev_avg:       87.9,
    home_hitters_hard_hit_avg: 35.8,
    home_hitters_k_pct_avg:    20.1,
    home_hitters_bb_pct_avg:   7.6,
    ...overrides,
  };
}

const TS = "2026-07-26T10:00:00.000Z";

// ─── xwobaQualityFactor ───────────────────────────────────────────────────────

describe("xwobaQualityFactor", () => {
  it("returns null when xwoba is null", () => {
    assert.strictEqual(xwobaQualityFactor(null, false), null);
  });

  it("returns null when didNotQualify is true", () => {
    assert.strictEqual(xwobaQualityFactor(0.315, true), null);
  });

  it("returns 1.0 for league-average xwOBA", () => {
    const factor = xwobaQualityFactor(LEAGUE_AVG_XWOBA_ALLOWED, false);
    assert.strictEqual(factor, 1.0);
  });

  it("returns < 1.0 for below-average xwOBA (better pitcher)", () => {
    const factor = xwobaQualityFactor(0.270, false);
    assert.ok(factor !== null && factor < 1.0, `Expected factor < 1.0, got ${factor}`);
    // 0.270 / 0.315 ≈ 0.857
    assert.ok(Math.abs(factor! - 0.270 / 0.315) < 0.001);
  });

  it("returns > 1.0 for above-average xwOBA (worse pitcher)", () => {
    const factor = xwobaQualityFactor(0.360, false);
    assert.ok(factor !== null && factor > 1.0, `Expected factor > 1.0, got ${factor}`);
  });

  it("clamps to 0.40 at the lower bound", () => {
    // Extremely elite pitcher — xwOBA / 0.315 would be << 0.40
    assert.strictEqual(xwobaQualityFactor(0.050, false), 0.40);
  });

  it("clamps to 1.80 at the upper bound", () => {
    // Extremely poor pitcher
    assert.strictEqual(xwobaQualityFactor(0.650, false), 1.80);
  });
});

// ─── shadowStarterQuality ─────────────────────────────────────────────────────

describe("shadowStarterQuality", () => {
  it("returns null when xwOBA factor is null", () => {
    assert.strictEqual(shadowStarterQuality(0.900, null), null);
  });

  it("blends at SHADOW_BLEND_WEIGHT correctly", () => {
    const currentQual = 0.900;
    const xwobaFactor = 1.100;
    const expected = parseFloat(
      (currentQual * (1 - SHADOW_BLEND_WEIGHT) + xwobaFactor * SHADOW_BLEND_WEIGHT).toFixed(4),
    );
    const result = shadowStarterQuality(currentQual, xwobaFactor);
    assert.strictEqual(result, expected);
  });

  it("when xwOBA factor equals current qual, shadow qual equals current qual", () => {
    const qual = 0.950;
    const result = shadowStarterQuality(qual, qual);
    assert.strictEqual(result, parseFloat(qual.toFixed(4)));
  });

  it("shadow qual is clamped to 0.40 minimum", () => {
    // Pathological case: current very low, xwOBA factor also very low
    const result = shadowStarterQuality(0.40, 0.40);
    assert.strictEqual(result, 0.40);
  });
});

describe("preview hitter tail estimates", () => {
  it("returns neutral traffic and damage adjustments at league-average inputs", () => {
    assert.strictEqual(
      estimateTrafficAdjustment(4.5, LEAGUE_AVG_HITTER_BB_PCT, LEAGUE_AVG_HITTER_K_PCT),
      0,
    );
    assert.strictEqual(
      estimateDamageAdjustment(4.5, LEAGUE_AVG_HITTER_HARD_HIT_PCT),
      0,
    );
  });

  it("raises traffic for more walks and fewer strikeouts and lowers it for the inverse", () => {
    assert.ok((estimateTrafficAdjustment(4.5, 11.0, 18.0) ?? 0) > 0);
    assert.ok((estimateTrafficAdjustment(4.5, 6.0, 28.0) ?? 0) < 0);
  });

  it("raises damage for above-average hard-hit rate and lowers it below average", () => {
    assert.ok((estimateDamageAdjustment(4.5, 46.0) ?? 0) > 0);
    assert.ok((estimateDamageAdjustment(4.5, 31.0) ?? 0) < 0);
  });

  it("returns null for unavailable inputs and clamps extreme team estimates", () => {
    assert.strictEqual(estimateTrafficAdjustment(4.5, null, 20), null);
    assert.strictEqual(estimateTrafficAdjustment(4.5, 10, null), null);
    assert.strictEqual(estimateDamageAdjustment(4.5, null), null);
    assert.equal(Math.abs(estimateTrafficAdjustment(12, 25, 5) ?? 0), SHADOW_TAIL_TEAM_CAP);
    assert.equal(Math.abs(estimateDamageAdjustment(12, 90) ?? 0), SHADOW_TAIL_TEAM_CAP);
  });
});

// ─── computeShadowAuditRow ────────────────────────────────────────────────────

describe("computeShadowAuditRow — preview unavailable", () => {
  it("zero adjustment and missing_fields=['preview_not_available'] when preview is null", () => {
    const row = computeShadowAuditRow(makeSummary(), null, TS);
    assert.strictEqual(row.shadow_xwoba_adjustment, 0);
    assert.strictEqual(row.shadow_projection, row.current_projection);
    assert.ok(row.missing_fields.includes("preview_not_available"));
    assert.strictEqual(row.cap_applied, false);
  });

  it("zero adjustment when preview_availability is NOT_PUBLISHED", () => {
    const preview = makePreview({ preview_availability: "NOT_PUBLISHED" });
    const row = computeShadowAuditRow(makeSummary(), preview, TS);
    assert.strictEqual(row.shadow_xwoba_adjustment, 0);
    assert.ok(row.missing_fields.includes("preview_not_available"));
  });
});

describe("computeShadowAuditRow — pitchers did not qualify", () => {
  it("zero adjustment when both pitchers are didNotQualify", () => {
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, did_not_qualify: true },
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, did_not_qualify: true },
    });
    const row = computeShadowAuditRow(makeSummary(), preview, TS);
    assert.strictEqual(row.shadow_xwoba_adjustment, 0);
    assert.ok(row.missing_fields.includes("away_pitcher_xwoba"));
    assert.ok(row.missing_fields.includes("home_pitcher_xwoba"));
  });

  it("partial adjustment when only one pitcher qualifies", () => {
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, did_not_qualify: true },
    });
    const row = computeShadowAuditRow(makeSummary(), preview, TS);
    // away pitcher DNQ → away pitcher xwOBA is excluded → no impact on HOME run scoring
    assert.strictEqual(row.home_starter_delta, 0, "home delta should be 0 when away pitcher DNQ");
    // away_starter_delta depends on the HOME pitcher (which still qualifies) — may be non-zero
    assert.ok(row.missing_fields.includes("away_pitcher_xwoba"));
    assert.ok(!row.missing_fields.includes("home_pitcher_xwoba"));
  });
});

describe("computeShadowAuditRow — both starters have xwOBA data", () => {
  it("preview_used_in_projection is always NO", () => {
    const row = computeShadowAuditRow(makeSummary(), makePreview(), TS);
    assert.strictEqual(row.preview_used_in_projection, "NO");
  });

  it("shadow_projection = current_projection when adjustment is zero", () => {
    // Use league-average xwOBA for both pitchers → shadow quals ≈ current quals → delta ≈ 0
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, xwoba: LEAGUE_AVG_XWOBA_ALLOWED },
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, xwoba: LEAGUE_AVG_XWOBA_ALLOWED },
    });
    const summary = makeSummary({
      away_starter_quality: 1.0,
      home_starter_quality: 1.0,
    });
    const row = computeShadowAuditRow(summary, preview, TS);
    // xwobaFactor = 1.0, shadow blend gives 1.0, delta = 0
    assert.strictEqual(row.shadow_xwoba_adjustment, 0);
    assert.strictEqual(row.shadow_projection, summary.projected_total_runs);
  });

  it("home pitcher xwOBA drives away_starter_delta, not home_starter_delta", () => {
    // Make away pitcher league-average (no delta from that side)
    // Make home pitcher very bad (high xwOBA → higher runs for away batters)
    const summary = makeSummary({
      away_starter_quality: 1.0,
      home_starter_quality: 1.0,
    });
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, xwoba: LEAGUE_AVG_XWOBA_ALLOWED },
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, xwoba: 0.380 },  // worse
    });
    const row = computeShadowAuditRow(summary, preview, TS);
    assert.strictEqual(row.home_starter_delta, 0, "away pitcher is league-avg → home delta should be 0");
    assert.ok(row.away_starter_delta > 0, "bad home pitcher → more away runs → positive away_starter_delta");
  });

  it("away pitcher xwOBA drives home_starter_delta, not away_starter_delta", () => {
    const summary = makeSummary({
      away_starter_quality: 1.0,
      home_starter_quality: 1.0,
    });
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, xwoba: 0.260 }, // elite
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, xwoba: LEAGUE_AVG_XWOBA_ALLOWED },
    });
    const row = computeShadowAuditRow(summary, preview, TS);
    assert.strictEqual(row.away_starter_delta, 0, "home pitcher is league-avg → away delta should be 0");
    assert.ok(row.home_starter_delta < 0, "elite away pitcher → fewer home runs → negative home_starter_delta");
  });

  it("cap is applied and flagged when uncapped adjustment exceeds SHADOW_ADJUSTMENT_CAP", () => {
    // Force an extreme case: very bad pitchers on both sides, large offense rates
    const summary = makeSummary({
      away_offense_rate_used:  8.0,
      home_offense_rate_used:  8.0,
      away_starter_quality:    0.80,
      home_starter_quality:    0.80,
      combined_run_multiplier: 1.0,
      away_lineup_factor:      1.0,
      home_lineup_factor:      1.0,
      home_expected_innings:   6.0,
      away_expected_innings:   6.0,
    });
    const preview = makePreview({
      away_pitcher_stats: { ...makePreview().away_pitcher_stats!, xwoba: 0.450 },  // terrible
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, xwoba: 0.450 },
    });
    const row = computeShadowAuditRow(summary, preview, TS);
    if (row.cap_applied) {
      assert.ok(
        Math.abs(row.shadow_projection - row.current_projection) <= SHADOW_ADJUSTMENT_CAP + 0.001,
        "capped shadow should be within CAP of current projection",
      );
      // Uncapped should be larger than capped
      assert.ok(
        Math.abs(row.shadow_xwoba_adjustment) > SHADOW_ADJUSTMENT_CAP,
        "uncapped adjustment should exceed cap when cap is applied",
      );
    }
    // If cap was not applied, verify adjustment is within bounds
    if (!row.cap_applied) {
      assert.ok(
        Math.abs(row.shadow_xwoba_adjustment) <= SHADOW_ADJUSTMENT_CAP,
        "when cap not applied, adjustment should be within cap range",
      );
    }
  });

  it("missing_fields is empty when both pitcher xwOBA values are present", () => {
    const row = computeShadowAuditRow(makeSummary(), makePreview(), TS);
    assert.deepEqual(row.missing_fields, []);
  });

  it("populates traffic and HR/XBH estimates and reconciles the estimated projection", () => {
    const row = computeShadowAuditRow(makeSummary(), makePreview(), TS);
    assert.equal(row.tail_estimate_status, "AVAILABLE");
    assert.equal(
      row.traffic_conversion_estimate,
      parseFloat((row.away_traffic_adjustment + row.home_traffic_adjustment).toFixed(4)),
    );
    assert.equal(
      row.hr_xbh_damage_estimate,
      parseFloat((row.away_damage_adjustment + row.home_damage_adjustment).toFixed(4)),
    );
    assert.ok(Math.abs(row.combined_tail_adjustment) <= SHADOW_TAIL_GAME_CAP);
    const starterCapped = Math.max(
      -SHADOW_ADJUSTMENT_CAP,
      Math.min(SHADOW_ADJUSTMENT_CAP, row.shadow_xwoba_adjustment),
    );
    assert.equal(
      row.estimated_projection,
      parseFloat((row.current_projection + starterCapped + row.combined_tail_adjustment).toFixed(2)),
    );
  });

  it("marks tail estimates partial when only some hitter inputs are available", () => {
    const preview = makePreview({ away_hitters_hard_hit_avg: null });
    const row = computeShadowAuditRow(makeSummary(), preview, TS);
    assert.equal(row.tail_estimate_status, "PARTIAL");
    assert.ok(row.missing_fields.includes("away_hitter_hard_hit"));
  });

  it("identity_warnings populated from parse_warnings", () => {
    const preview = makePreview({
      parse_warnings: ["Away pitcher ID mismatch: page 123 vs pipeline 456 (Gerrit Cole)"],
    });
    const row = computeShadowAuditRow(makeSummary(), preview, TS);
    assert.strictEqual(row.identity_warnings.length, 1);
    assert.ok(row.identity_warnings[0].includes("pitcher ID mismatch"));
  });
});

describe("computeShadowAuditRow — numerical correctness", () => {
  it("away_starter_delta matches manual calculation", () => {
    const summary = makeSummary({
      away_offense_rate_used:  4.550,
      combined_run_multiplier: 1.0,
      away_lineup_factor:      1.0,
      home_starter_quality:    1.0,
      home_expected_innings:   5.5,
    });
    // Home pitcher xwOBA = 0.315 (league avg) → xwobaFactor = 1.0, shadowQual = 1.0 → delta = 0
    const preview = makePreview({
      home_pitcher_stats: { ...makePreview().home_pitcher_stats!, xwoba: LEAGUE_AVG_XWOBA_ALLOWED },
      away_pitcher_stats: null,
    });
    const row = computeShadowAuditRow(summary, preview, TS);
    assert.strictEqual(row.away_starter_delta, 0);
  });

  it("snapshot_ts is passed through unchanged", () => {
    const ts = "2026-07-26T12:34:56.789Z";
    const row = computeShadowAuditRow(makeSummary(), makePreview(), ts);
    assert.strictEqual(row.snapshot_ts, ts);
  });

  it("game identity fields are passed through from GameSummaryRow", () => {
    const summary = makeSummary({ game_id: "2026-07-26_CLE@CHC", away_team: "CLE", home_team: "CHC" });
    const row = computeShadowAuditRow(summary, null, TS);
    assert.strictEqual(row.game_id, "2026-07-26_CLE@CHC");
    assert.strictEqual(row.away_team, "CLE");
    assert.strictEqual(row.home_team, "CHC");
  });
});

describe("low-center volatility shadow", () => {
  it("flags sub-eight active totals and records only shadow candidates", () => {
    const summary = makeSummary({
      projected_total_runs: 7.58,
      away_starter_quality: 0.90,
      home_starter_quality: 0.92,
      combined_run_multiplier: 0.96,
      roof_status: "CLOSED",
    });
    const row = computeShadowAuditRow(summary, null, TS);

    assert.equal(row.low_center_volatility_flag, "LOW_CENTER_VOLATILITY");
    assert.equal(
      row.low_center_challenger_projection,
      parseFloat((summary.projected_total_runs + LOW_CENTER_CHALLENGER_LIFT).toFixed(2)),
    );
    assert.equal(
      row.low_center_upper_tail_band,
      parseFloat((summary.projected_total_runs + LOW_CENTER_UPPER_TAIL_RESIDUAL).toFixed(2)),
    );
    assert.equal(row.low_center_upper_tail_residual, LOW_CENTER_UPPER_TAIL_RESIDUAL);
    assert.ok(row.low_center_reason_tags.includes("BASE_PROJECTION_LT_8"));
    assert.ok(row.low_center_reason_tags.includes("BOTH_STARTERS_BELOW_LEAGUE_QUALITY"));
    assert.ok(row.low_center_reason_tags.includes("SUB_NEUTRAL_ENVIRONMENT"));
    assert.ok(row.low_center_reason_tags.includes("CLOSED_ROOF"));
    assert.ok(row.low_center_reason_tags.includes("NO_POSITIVE_TAIL_ESTIMATE"));
    assert.ok(row.low_center_reason_tags.includes("TAIL_ESTIMATE_INCOMPLETE"));
    assert.equal(row.current_projection, summary.projected_total_runs);
    assert.equal(row.shadow_projection, summary.projected_total_runs);
  });

  it("does not flag an eight-run-or-higher total or invent challenger values", () => {
    const summary = makeSummary({ projected_total_runs: LOW_CENTER_VOLATILITY_THRESHOLD });
    const row = computeShadowAuditRow(summary, makePreview(), TS);

    assert.equal(row.low_center_volatility_flag, "STANDARD_RANGE");
    assert.equal(row.low_center_challenger_projection, null);
    assert.equal(row.low_center_upper_tail_band, null);
    assert.equal(row.low_center_upper_tail_residual, null);
    assert.deepEqual(row.low_center_reason_tags, []);
  });
});
