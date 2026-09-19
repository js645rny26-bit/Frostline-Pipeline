import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_PITCHING_INVENTORY_ACTIVE_INPUT,
  ACTIVE_PITCHING_INVENTORY_HEADERS,
  ACTIVE_PITCHING_INVENTORY_MAPPING_STATUS,
  ACTIVE_PITCHING_INVENTORY_PROOF_CASES,
  ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS,
  ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_HEADERS,
  ACTIVE_PITCHING_INVENTORY_SUMMARY_HEADERS,
  auditHistoricalAPIReplayAvailability,
  buildActivePitchingInventory,
} from "./module36_activePitchingInventory.js";
import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION } from "../workbook/workbookSchema.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type { BullpenResult, RelieverStat } from "./module04b_bullpenUsage.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type { SWEAppearance, SWEGameState } from "./module02i_starterWorkloadEstimator.js";

const pitcher = (id: number, name: string, role: string, ip: number) => ({
  player_id: id, name, hand: "R", role, role_confidence: "high" as const,
  workload_flags: [], expected_pitches: Math.round(ip * 15), expected_innings: ip,
  reasoning: "fixture",
});

const game: NormalizedGame = {
  gamePk: 1, legacy_game_id: "20260919_AWY_HME", date: "2026-09-19",
  scheduled_utc_time: "2026-09-19T23:00:00Z",
  venue: { id: 1, name: "Test", timeZone: "America/New_York" },
  away_team: { team_id: 1, team_abbr: "AWY", team_name: "Away" },
  home_team: { team_id: 2, team_abbr: "HME", team_name: "Home" },
  away_pitcher: pitcher(10, "Conventional", "CONVENTIONAL_STARTER", 6),
  home_pitcher: pitcher(20, "Opener", "OPENER", 1.2),
  environment: {
    temperature_f: 72, humidity_pct: 50, wind_speed_mph: 5,
    wind_direction_degrees: 180, precipitation_probability_pct: 0,
    wind_context: null, roof: false, roof_pending: false, roof_status: "OPEN_OR_OUTDOOR",
    data_quality: "live",
  },
  game_status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
  doubleheader_status: "N",
};

const reliever = (id: number, name: string, team: string): RelieverStat => ({
  player_id: id, full_name: name, team_abbr: team, innings_last_7: 4,
  games_last_7: 2, days_rest: 3, last_outing_date: "2026-09-16", role: "LONG_RELIEF",
  notes: "", availability_status: "AVAILABLE", appearances_last_5: 2,
  pitches_yesterday: 0, pitches_2_days_ago: 0, pitches_3_days_ago: 60,
  pitches_4_days_ago: 0, pitches_5_days_ago: 0,
  workload_source: "MLBSTARTINGNINE_BULLPEN_REPORT", source_snapshot_utc: "2026-09-19T12:00:00Z",
});

const bullpen: BullpenResult = {
  status: "success", date: "2026-09-19", relievers: [
    reliever(21, "Credible Bulk", "HME"), reliever(22, "Secondary", "HME"),
    reliever(11, "Away Long", "AWY"),
  ], teams_fetched: 2, teams_failed: 0, errors: [],
  primary_source: "MLBSTARTINGNINE_BULLPEN_REPORT", source_snapshot_utc: "2026-09-19T12:00:00Z",
};

function appearances(id: number): SWEAppearance[] {
  return [1, 2, 3].map((number) => ({
    game_date: `2026-09-${10 + number}`, game_pk: number, pitcher_id: id,
    pitches_thrown: 60 + number, batters_faced: 16, outs_recorded: 12,
    innings_pitched: 4, max_thruorder: 2, started_game: true,
    pitcher_days_since_prev_game: 5, outs_status: "AVAILABLE",
  }));
}

const sweState = (ip: number): SWEGameState => ({
  away: { expected_ip: ip, status: "SHRUNK", n_starts: 5, l3_ip: ip, l5_ip: ip, season_ip: ip, shrinkage_weight: .5, role_prior_used: 6, data_through_date: "2026-09-18", role: "CONVENTIONAL_STARTER", notes: "" },
  home: { expected_ip: 1.2, status: "ROLE_BOUNDED", n_starts: 5, l3_ip: 1.2, l5_ip: 1.2, season_ip: 1.2, shrinkage_weight: null, role_prior_used: 6, data_through_date: "2026-09-18", role: "OPENER", notes: "" },
});

const summary = {
  game_id: game.legacy_game_id, date: game.date, away_team: "AWY", home_team: "HME",
  projected_away_runs: 4.5, projected_home_runs: 4.2,
  away_active_offense_center: 4.4, home_active_offense_center: 4.1,
} as GameSummaryRow;

test("API separates a credible inferred bulk phase from true bullpen exposure", () => {
  const rows = buildActivePitchingInventory(
    [game], [summary], bullpen, [...appearances(21), ...appearances(22), ...appearances(11)],
    new Map([[game.legacy_game_id, sweState(6)]]),
    new Map([
      [21, { pitcher_id: 21, name: "Credible Bulk", hand: "R", era: 2.5, fip: 3, k_pct: .2, bb_pct: .08, whip: 1.1, hr_per_9: .8, innings_pitched: "80.0" }],
      [22, { pitcher_id: 22, name: "Secondary", hand: "R", era: 4.5, fip: 4.5, k_pct: .2, bb_pct: .08, whip: 1.3, hr_per_9: 1.2, innings_pitched: "50.0" }],
      [11, { pitcher_id: 11, name: "Away Long", hand: "R", era: 4, fip: 4, k_pct: .2, bb_pct: .08, whip: 1.3, hr_per_9: 1.1, innings_pitched: "50.0" }],
    ]),
    new Map(), "2026-09-18", "2026-09-19T15:00:00Z",
  );
  assert.equal(rows.length, 2);
  const home = rows.find((row) => row.team_side === "HOME")!;
  assert.equal(home.pitching_plan_type, "OPENER_PLUS_CREDIBLE_BULK");
  assert.equal(home.expected_bulk_pitcher, "Credible Bulk");
  assert.equal(home.bulk_observability, "PROBABLE_INFERRED");
  assert.equal(home.expected_starter_phase_ip, 1.2);
  assert.equal(home.expected_bulk_phase_ip, 4);
  assert.equal(home.true_bullpen_exposure_ip, 3.8);
  assert.equal(home.projection_effect_status, "SHADOW_DELTA_AVAILABLE");
  assert.notEqual(home.api_shadow_run_delta, null);
  const away = rows.find((row) => row.team_side === "AWAY")!;
  assert.equal(away.pitching_plan_type, "CONVENTIONAL_STARTER");
  assert.equal(away.expected_bulk_ip, null);
});

test("missing pregame bullpen source fails closed instead of inventing a follower", () => {
  const rows = buildActivePitchingInventory(
    [game], [summary], null, [], new Map([[game.legacy_game_id, sweState(6)]]),
    new Map(), new Map(), "2026-09-18", "2026-09-19T15:00:00Z",
  );
  const home = rows.find((row) => row.team_side === "HOME")!;
  assert.equal(home.bulk_observability, "MISSING_DUE_TO_SOURCE_FAILURE");
  assert.equal(home.expected_bulk_pitcher, "");
  assert.equal(home.api_shadow_opposing_offense_runs, null);
  assert.match(home.missing_data_flags, /BULLPEN_SOURCE_UNAVAILABLE/);
});

test("Module 36 governance sentinels cannot authorize an active projection", () => {
  assert.equal(ACTIVE_PITCHING_INVENTORY_ACTIVE_INPUT, "NO");
  assert.equal(ACTIVE_PITCHING_INVENTORY_MAPPING_STATUS, "SHADOW_ONLY_NOT_COMMISSIONED");
});

test("Module 36 exposes only its four research surfaces through schema v69", () => {
  assert.equal(WORKBOOK_SCHEMA_VERSION, 69);
  for (const [sheet, headers] of [
    ["ACTIVE_PITCHING_INVENTORY_V1", ACTIVE_PITCHING_INVENTORY_HEADERS],
    ["ACTIVE_PITCHING_INVENTORY_SUMMARY_V1", ACTIVE_PITCHING_INVENTORY_SUMMARY_HEADERS],
    ["ACTIVE_PITCHING_INVENTORY_REPLAY_V1", ACTIVE_PITCHING_INVENTORY_REPLAY_HEADERS],
    ["ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_V1", ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_HEADERS],
  ] as const) {
    assert.deepEqual(
      WORKBOOK_SCHEMA.find((definition) => definition.name === sheet)?.columns.map((column) => column.name),
      Array.from(headers),
    );
  }
});

test("canonical proof cases remain not observable rather than postgame-backfilled", () => {
  assert.equal(ACTIVE_PITCHING_INVENTORY_PROOF_CASES.length, 3);
  assert.ok(ACTIVE_PITCHING_INVENTORY_PROOF_CASES.every((row) => row[2] === "NOT_OBSERVABLE_PREGAME"));
  assert.equal(auditHistoricalAPIReplayAvailability([]).status, "INSUFFICIENT_PROSPECTIVE_API_HISTORY");
});
