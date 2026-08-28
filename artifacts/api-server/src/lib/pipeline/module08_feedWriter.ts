/**
 * Module 08: Google Sheets Feed Writer
 * Writes normalized data to 5 input sheets in the explicitly selected workbook.
 */

import {
  clearRange,
  expandSheetColumns,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult, NormalizedGame } from "./module06_normalization.js";
import type { FangraphsResult } from "./module05_fangraphs.js";
import { STADIUM_COORDS, resolveVenueName } from "./config.js";
import type { BullpenResult } from "./module04b_bullpenUsage.js";
import { type StartingNineResult, type StartingNineGame, buildStartingNineMap } from "./module04c_startingNine.js";
import { resolveEnvironmentFactors } from "./module09_environment.js";
import { getSeasonalParkFactor } from "./module04d_parkFactors.js";
import { type StarterOutingResult, type StarterOuting } from "./module04d_starterPrevOuting.js";
import type { UmpireResult } from "./module04e_umpires.js";
import type { PitcherSeasonStatsResult, PitcherSeasonStats } from "./module02b_pitcherSeasonStats.js";
import type { TeamRunRatesResult } from "./module05c_teamRunRates.js";
import type { LineMovementResult } from "./module05d_oddsHistory.js";
import type { LineupPlayer } from "./module04c_startingNine.js";
import { mergeProtectedRows, type PublicationProtection } from "./module00_scopedPublication.js";

export interface SheetWriteStatus {
  status: "success" | "failure" | "skipped";
  rows_written: number;
  range: string;
  error?: string;
}

export interface Module08Result {
  status: "success" | "failure" | "partial_failure";
  write_timestamp_utc: string;
  workbook_id: string;
  sheets_written: {
    daily_matchups: SheetWriteStatus;
    today_lineups: SheetWriteStatus;
    team_form_input: SheetWriteStatus;
    bullpen_usage_daily: SheetWriteStatus;
    run_environment: SheetWriteStatus;
  };
  errors: Array<{ module: string; error: string; timestamp: string }>;
}

// ─── Row builders ─────────────────────────────────────────────────────────────

// Schema: DAILY_MATCHUPS — 25 cols A–Y, data starts row 2 (frozenRows: 1)
function confidenceNum(c: string | null | undefined): number {
  if (c === "high") return 0.9;
  if (c === "medium") return 0.75;
  return 0.5;
}

/** Share of a lineup holding the platoon advantage vs. the opposing starter.
 *  Switch hitters always count; otherwise opposite hand counts. 0–1, blank if unknown. */
function platoonAdvantage(lineup: LineupPlayer[], starterHand: string | null | undefined): number | "" {
  if (!starterHand || lineup.length === 0) return "";
  const withHand = lineup.filter((p) => p.handedness === "L" || p.handedness === "R" || p.handedness === "S");
  if (withHand.length === 0) return "";
  const advantaged = withHand.filter(
    (p) => p.handedness === "S" || p.handedness !== starterHand,
  ).length;
  return parseFloat((advantaged / withHand.length).toFixed(2));
}

// Schema: DAILY_MATCHUPS — 47 cols A–AU, data starts row 2 (frozenRows: 1)
// Cols A–Y:  matchup / pitcher classification / weather
// Cols Z–AI: starter previous outing (Baseball Savant)
// Col  AJ:   plate umpire (blank before ~noon ET assignment)
// Cols AK–AP: starter season stats (ERA / FIP / K%)
// Cols AQ–AS: O/U line movement (open / current / move)
// Cols AT–AU: lineup platoon advantage vs. opposing starter
function buildDailyMatchupsRows(
  games:        NormalizedGame[],
  outings:      Map<number, StarterOuting>,
  plateUmps:    Map<string, string>,
  pitcherStats: Map<number, PitcherSeasonStats>,
  movement:     Map<string, { open: number; current: number; move: number }>,
  sn:           Map<string, StartingNineGame>,
): unknown[][] {
  const now = new Date().toISOString();
  return games.map((g) => {
    const awayOuting = g.away_pitcher.player_id ? outings.get(g.away_pitcher.player_id) : undefined;
    const homeOuting = g.home_pitcher.player_id ? outings.get(g.home_pitcher.player_id) : undefined;
    const awayStats  = g.away_pitcher.player_id ? pitcherStats.get(g.away_pitcher.player_id) : undefined;
    const homeStats  = g.home_pitcher.player_id ? pitcherStats.get(g.home_pitcher.player_id) : undefined;
    const moveData   = movement.get(g.legacy_game_id);
    const snGame     = sn.get(g.legacy_game_id);
    const parkFactors = snGame?.park_factors ?? getSeasonalParkFactor(g.home_team.team_abbr ?? "") ?? null;
    const environment = resolveEnvironmentFactors(
      g.environment,
      parkFactors,
      snGame?.park_factors
        ? "VENUE_FACTOR_USED"
        : parkFactors
          ? "SEASONAL_FACTOR_USED"
          : "MISSING_PARK_DATA",
    );
    return [
      g.date,                                                          // A: Date
      g.legacy_game_id,                                                // B: Game_ID
      g.game_status.detailedState ?? "Scheduled",                      // C: Game_Status
      g.away_team.team_abbr ?? "",                                     // D: Away_Team
      g.home_team.team_abbr ?? "",                                     // E: Home_Team
      g.away_pitcher.name ?? "",                                       // F: Away_Pitcher
      g.home_pitcher.name ?? "",                                       // G: Home_Pitcher
      g.away_pitcher.role ?? "UNRESOLVED",                             // H: Away_Pitcher_Role
      g.home_pitcher.role ?? "UNRESOLVED",                             // I: Home_Pitcher_Role
      confidenceNum(g.away_pitcher.role_confidence),                   // J: Away_Pitcher_Confidence
      confidenceNum(g.home_pitcher.role_confidence),                   // K: Home_Pitcher_Confidence
      g.away_pitcher.expected_pitches ?? "",                           // L: Away_Expected_Pitches
      g.home_pitcher.expected_pitches ?? "",                           // M: Home_Expected_Pitches
      g.away_pitcher.expected_innings ?? "",                           // N: Away_Expected_Innings
      g.home_pitcher.expected_innings ?? "",                           // O: Home_Expected_Innings
      g.environment.temperature_f ?? "",                               // P: Temperature_F
      g.environment.wind_speed_mph ?? "",                              // Q: Wind_MPH
      g.environment.precipitation_probability_pct !== null
        ? g.environment.precipitation_probability_pct / 100 : "",     // R: Precipitation_Pct (0–1)
      g.environment.data_quality === "fallback" ? "CLIMATOLOGY" : "LIVE_WX", // S: Weather_Source
      g.venue.name ?? "",                                              // T: Stadium
      environment.combined_hr_factor,                                  // U: Park_Factor_HR (park + conservative weather)
      environment.combined_multiplier,                                 // V: Run_Multiplier (Module 09 later mirrors its effective capped value)
      now,                                                             // W: L30_RS_Observed_TS (pipeline-observed, not provider-published)
      now,                                                             // X: Pipeline_Last_Updated
      "",                                                              // Y: Notes
      // ── Away starter last outing (Baseball Savant) ─────────────────
      awayOuting?.outing_date  ?? "",                                  // Z:  Away_Last_Outing_Date
      awayOuting?.ip_display   ?? "",                                  // AA: Away_Last_IP
      awayOuting?.pitch_count  ?? "",                                  // AB: Away_Last_Pitches
      awayOuting?.days_rest    ?? "",                                  // AC: Away_Days_Rest
      awayOuting?.stress_flag  ?? "",                                  // AD: Away_Stress_Flag
      // ── Home starter last outing (Baseball Savant) ─────────────────
      homeOuting?.outing_date  ?? "",                                  // AE: Home_Last_Outing_Date
      homeOuting?.ip_display   ?? "",                                  // AF: Home_Last_IP
      homeOuting?.pitch_count  ?? "",                                  // AG: Home_Last_Pitches
      homeOuting?.days_rest    ?? "",                                  // AH: Home_Days_Rest
      homeOuting?.stress_flag  ?? "",                                  // AI: Home_Stress_Flag
      // ── Plate umpire ───────────────────────────────────────────────
      plateUmps.get(g.legacy_game_id) ?? "",                           // AJ: Plate_Umpire
      // ── Starter season stats ───────────────────────────────────────
      awayStats?.era   ?? "",                                          // AK: Away_ERA
      awayStats?.fip   ?? "",                                          // AL: Away_FIP
      awayStats?.k_pct ?? "",                                          // AM: Away_K_Pct (0–1)
      homeStats?.era   ?? "",                                          // AN: Home_ERA
      homeStats?.fip   ?? "",                                          // AO: Home_FIP
      homeStats?.k_pct ?? "",                                          // AP: Home_K_Pct (0–1)
      // ── O/U line movement ──────────────────────────────────────────
      moveData?.open    ?? "",                                         // AQ: Total_Open
      moveData?.current ?? "",                                         // AR: Total_Current
      moveData?.move    ?? "",                                         // AS: Total_Move (neg = dropping)
      // ── Platoon advantage (lineup vs. opposing starter hand) ───────
      platoonAdvantage(snGame?.away_lineup ?? [], homeStats?.hand),    // AT: Away_Platoon_Adv (0–1)
      platoonAdvantage(snGame?.home_lineup ?? [], awayStats?.hand),    // AU: Home_Platoon_Adv (0–1)
    ];
  });
}

function buildWeatherTag(g: NormalizedGame): string {
  const temp = g.environment.temperature_f;
  const wind = g.environment.wind_speed_mph;
  const rain = g.environment.precipitation_probability_pct;
  if (rain !== null && rain > 50) return "RAIN_RISK";
  if (temp !== null && temp > 90) return "HOT";
  if (temp !== null && temp < 50) return "COLD";
  if (wind !== null && wind > 20) return "WINDY";
  return "NEUTRAL";
}

// Schema: TODAY_LINEUPS — 14 cols A–N, data starts row 2 (frozenRows: 1)
function buildTodayLineupsRows(
  games: NormalizedGame[],
  sn: Map<string, StartingNineGame>,
): unknown[][] {
  const rows: unknown[][] = [];

  for (const g of games) {
    const snGame = sn.get(g.legacy_game_id);

    for (const side of ["A", "H"] as const) {
      const team    = side === "A" ? g.away_team : g.home_team;
      const lineup  = snGame ? (side === "A" ? snGame.away_lineup : snGame.home_lineup) : [];
      const status  = snGame?.lineup_status ?? "projected";

      for (let order = 1; order <= 9; order++) {
        const player = lineup.find((p) => p.batting_order === order);
        rows.push([
          g.date,                                    // A: Date
          g.legacy_game_id,                          // B: Game_ID
          team.team_abbr ?? "",                      // C: Team
          order,                                     // D: Batting_Order
          player?.name ?? "",                        // E: Player_Name
          "",                                        // F: Player_ID (not available from this source)
          player?.position ?? "",                    // G: Position
          "",                                        // H: vs_LHP_wRC_plus (not available)
          "",                                        // I: vs_RHP_wRC_plus (not available)
          "",                                        // J: Last_30_Days_wRC_plus (not available)
          player?.handedness ? `${player.handedness} | ACTIVE` : "ACTIVE", // K: Injury_Status / Bats
          "",                                        // L: Salary (not available)
          "",                                        // M: FanGraphs_Projection (not available)
          player ? status.toUpperCase() : "NO_LINEUP_DATA", // N: Notes
        ]);
      }
    }
  }
  return rows;
}

// Schema: TEAM_FORM_INPUT — 8 cols A–H, 1 row per team (30 rows), data starts row 2
// Runs scored/allowed come from actual last-10-game results (module 05c) when
// available; the fallback is the canonical L30 actual-RS/G compatibility value.
function buildTeamFormRows(
  runDate: string,
  splits: FangraphsResult["teams"],
  runRates: TeamRunRatesResult | null,
): unknown[][] {
  // Collapse the legacy L30 compatibility payload into its canonical actual
  // runs-per-game meaning. Do not synthesize faux wOBA, strength-of-schedule,
  // or bullpen-rest values merely to make unused cells look populated.
  const byTeam = new Map<string, { rsTotal: number; n: number }>();
  for (const s of splits) {
    const entry = byTeam.get(s.team) ?? { rsTotal: 0, n: 0 };
    entry.rsTotal += (s.l30_wrc_plus / 100) * 4.5;
    entry.n++;
    byTeam.set(s.team, entry);
  }

  return Array.from(byTeam.entries()).map(([team, d]) => {
    const actual = runRates?.rates.get(team);
    const rs = actual ? actual.runs_per_game         : parseFloat((d.rsTotal / d.n).toFixed(2));
    const ra = actual ? actual.runs_allowed_per_game : 4.5;
    const note = actual
      ? `L10 actual (${actual.games}g)`
      : "L30 actual RS/G fallback; L10 fetch unavailable";
    return [
      runDate,                                               // A: Date
      team,                                                  // B: Team
      rs,                                                    // C: Last_10_Runs_Scored
      ra,                                                    // D: Last_10_Runs_Allowed
      "",                                                    // E: decommissioned synthetic Last_10_wOBA
      "",                                                    // F: decommissioned synthetic strength-of-schedule
      "",                                                    // G: decommissioned synthetic bullpen-rest stub
      note,                                                  // H: Notes
    ];
  });
}

// BULLPEN_USAGE_DAILY columns (A–L):
//   A: Date | B: Team | C: Reliever_Name | D: Player_ID
//   E: Innings_Last_7_Days | F: Games_Last_7_Days | G: Days_Rest | H: Role | I: Notes
//   J: ERA | K: WHIP | L: Quality_Tier (A <3.20 | B <4.00 | C <5.00 | D)
function qualityTier(era: number | null | undefined): string {
  if (era == null) return "";
  if (era < 3.2) return "A";
  if (era < 4.0) return "B";
  if (era < 5.0) return "C";
  return "D";
}

function buildBullpenRows(
  date: string,
  bullpen: BullpenResult | null,
  pitcherStats: Map<number, PitcherSeasonStats>,
): unknown[][] {
  if (!bullpen || bullpen.relievers.length === 0) return [];
  return bullpen.relievers.map((r) => {
    const stats = r.player_id ? pitcherStats.get(r.player_id) : undefined;
    return [
      date,
      r.team_abbr,
      r.full_name,
      r.player_id,
      Math.round(r.innings_last_7 * 100) / 100,   // 2dp
      r.games_last_7,
      r.days_rest,
      r.role,
      r.notes,
      stats?.era  ?? "",                          // J: ERA
      stats?.whip ?? "",                          // K: WHIP
      qualityTier(stats?.era),                    // L: Quality_Tier
      r.availability_status,                       // M: Availability_Status
      r.appearances_last_5 ?? "",                 // N: Appearances_Last_5
      r.pitches_yesterday ?? "",                  // O: Pitches_Yesterday
      r.pitches_2_days_ago ?? "",                 // P: Pitches_2_Days_Ago
      r.pitches_3_days_ago ?? "",                 // Q: Pitches_3_Days_Ago
      r.pitches_4_days_ago ?? "",                 // R: Pitches_4_Days_Ago
      r.pitches_5_days_ago ?? "",                 // S: Pitches_5_Days_Ago
      r.workload_source,                           // T: Workload_Source
      r.source_snapshot_utc ?? "",                // U: Source_Snapshot_TS
    ];
  });
}

// Schema: RUN_ENVIRONMENT — 12 cols A–L, data starts row 2 (frozenRows: 1)
function buildRunEnvironmentRows(
  games: NormalizedGame[],
  sn: Map<string, StartingNineGame>,
): unknown[][] {
  return games.map((g) => {
    const e = g.environment;
    const venueKey = resolveVenueName(g.venue.name);
    const elevationFt = venueKey ? (STADIUM_COORDS[venueKey]?.elevation_ft ?? 0) : 0;
    const snGame = sn.get(g.legacy_game_id);
    const pf = snGame?.park_factors ?? getSeasonalParkFactor(g.home_team.team_abbr ?? "") ?? null;
    const environment = resolveEnvironmentFactors(
      e,
      pf,
      snGame?.park_factors
        ? "VENUE_FACTOR_USED"
        : pf
          ? "SEASONAL_FACTOR_USED"
          : "MISSING_PARK_DATA",
    );

    const noteParts: string[] = [
      `Roof: ${environment.roof_status}`,
      `Wind: ${e.wind_context ?? environment.wind_disposition}`,
      `Weather_Source: ${environment.weather_source_status}`,
      `Weather_Run: ${environment.weather_multiplier}`,
      `Weather_HR: ${environment.weather_hr_multiplier}`,
      `Environment_Certainty: ${environment.environment_certainty}`,
      `Weather_Vehicle_Status: ${environment.weather_vehicle_status}`,
      `Park_Source: ${environment.park_source_status}`,
    ];
    if (!venueKey) noteParts.push(`Unresolved venue: "${g.venue.name}" — elevation defaulted to 0`);
    if (!pf)       noteParts.push("Park factors: not available");

    return [
      g.date,                                                              // A: Date
      g.legacy_game_id,                                                    // B: Game_ID
      g.venue.name ?? "",                                                  // C: Stadium
      elevationFt,                                                         // D: Elevation_Feet
      e.temperature_f ?? "",                                               // E: Temperature_F
      e.wind_speed_mph ?? "",                                              // F: Wind_MPH
      compassDirection(e.wind_direction_degrees),                          // G: Wind_Direction
      e.precipitation_probability_pct !== null
        ? e.precipitation_probability_pct / 100 : "",                     // H: Precipitation_Pct (0–1)
      e.humidity_pct !== null ? e.humidity_pct / 100 : "",                // I: Humidity_Pct (0–1)
      environment.combined_hr_factor,                                      // J: Home_Run_Factor
      environment.combined_multiplier,                                     // K: Run_Multiplier
      noteParts.join(" | "),                                               // L: Notes
    ];
  });
}

function compassDirection(degrees: number | null): string {
  if (degrees === null) return "VAR";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(degrees / 45) % 8];
}

// ─── Sheet write helper with retry ───────────────────────────────────────────

async function safeWrite(
  label: string,
  clearRng: string,
  writeRng: string,
  rows: unknown[][],
  workbookId: string,
  protection?: {
    keyColumn: number;
    protectedKeys: ReadonlySet<string>;
    orderedKeys?: readonly string[];
  },
): Promise<SheetWriteStatus> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const rowsToWrite = protection && protection.protectedKeys.size > 0
        ? mergeProtectedRows(
            (await readRange(workbookId, clearRng)).values ?? [],
            rows,
            protection.keyColumn,
            protection.protectedKeys,
            protection.orderedKeys,
          )
        : rows;
      await clearRange(workbookId, clearRng);
      if (rowsToWrite.length === 0) {
        return { status: "success", rows_written: 0, range: writeRng };
      }
      const scopedWriteRange = writeRng.replace(/\d+$/, String(1 + rowsToWrite.length));
      const result = await writeRange(workbookId, scopedWriteRange, rowsToWrite);
      logger.info({ sheet: label, rows: result.updatedRows }, "MODULE_08: Sheet written");
      return { status: "success", rows_written: result.updatedRows, range: result.updatedRange };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) {
        logger.error({ sheet: label, err: message }, "MODULE_08: Sheet write failed");
        return { status: "failure", rows_written: 0, range: writeRng, error: message };
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { status: "failure", rows_written: 0, range: writeRng, error: "exhausted retries" };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function writeGoogleSheetsFeed(
  normalized: NormalizationResult,
  splits: FangraphsResult,
  runDate: string,
  workbookId = WORKBOOK_ID,
  bullpenData: BullpenResult | null = null,
  startingNineData: StartingNineResult | null = null,
  starterOutings: StarterOutingResult | null = null,
  umpires: UmpireResult | null = null,
  pitcherSeasonStats: PitcherSeasonStatsResult | null = null,
  teamRunRates: TeamRunRatesResult | null = null,
  lineMovement: LineMovementResult | null = null,
  protection?: PublicationProtection,
): Promise<Module08Result> {
  logger.info({ games: normalized.games.length }, "MODULE_08: Writing feeds to Google Sheets");

  const errors: Module08Result["errors"] = [];
  const failed: string[] = [];

  const snMap = buildStartingNineMap(
    startingNineData ?? { status: "failure", date: runDate, games: [], games_parsed: 0, games_matched: 0, errors: [] },
    normalized.games.map((game) => game.legacy_game_id),
  );
  const statsMap = pitcherSeasonStats?.stats ?? new Map<number, PitcherSeasonStats>();

  await writeRange(workbookId, "DAILY_MATCHUPS!U1:V1", [["Home_Run_Factor", "Run_Multiplier"]]).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_08: Could not write DAILY_MATCHUPS environment headers");
  });

  // 1. DAILY_MATCHUPS — 47 cols A–AU, starts row 2
  // Write v2 extension headers (Z–AU, indices 25–46) on every publish so
  // they remain correct regardless of when the workbook was first created.
  await writeRange(workbookId, "DAILY_MATCHUPS!Z1:AU1", [[
    "Away_Last_Outing_Date", "Away_Last_IP", "Away_Last_Pitches",
    "Away_Days_Rest", "Away_Stress_Flag",
    "Home_Last_Outing_Date", "Home_Last_IP", "Home_Last_Pitches",
    "Home_Days_Rest", "Home_Stress_Flag",
    "Plate_Umpire",
    "Away_ERA", "Away_FIP", "Away_K_Pct",
    "Home_ERA", "Home_FIP", "Home_K_Pct",
    "Total_Open", "Total_Current", "Total_Move",
    "Away_Platoon_Adv", "Home_Platoon_Adv",
  ]]).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MODULE_08: Could not write DAILY_MATCHUPS Z–AU headers — continuing");
  });

  const outingsMap = starterOutings?.outings ?? new Map();
  const dmRows = buildDailyMatchupsRows(
    normalized.games,
    outingsMap,
    umpires?.plate_umps ?? new Map(),
    statsMap,
    lineMovement?.movement ?? new Map(),
    snMap,
  );
  const dmResult = await safeWrite(
    "DAILY_MATCHUPS",
    "DAILY_MATCHUPS!A2:AU32",
    `DAILY_MATCHUPS!A2:AU${1 + Math.max(dmRows.length, 1)}`,
    dmRows,
    workbookId,
    protection ? { keyColumn: 1, protectedKeys: protection.protected_game_ids, orderedKeys: protection.expected_game_ids } : undefined,
  );
  if (dmResult.status === "failure") {
    failed.push("daily_matchups");
    errors.push({ module: "08_daily_matchups", error: dmResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 2. TODAY_LINEUPS — 14 cols A–N, starts row 2
  const tlRows = buildTodayLineupsRows(normalized.games, snMap);
  const tlResult = await safeWrite(
    "TODAY_LINEUPS",
    "TODAY_LINEUPS!A2:N602",
    `TODAY_LINEUPS!A2:N${1 + Math.max(tlRows.length, 1)}`,
    tlRows,
    workbookId,
    protection ? { keyColumn: 1, protectedKeys: protection.protected_game_ids, orderedKeys: protection.expected_game_ids } : undefined,
  );
  if (tlResult.status === "failure") {
    failed.push("today_lineups");
    errors.push({ module: "08_today_lineups", error: tlResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // 3. TEAM_FORM_INPUT — 8 cols A–H, 30 rows (1 per team), starts row 2
  const tfRows = buildTeamFormRows(runDate, splits.teams, teamRunRates);
  const tfResult = await safeWrite(
    "TEAM_FORM_INPUT",
    "TEAM_FORM_INPUT!A2:H62",
    `TEAM_FORM_INPUT!A2:H${1 + Math.max(tfRows.length, 1)}`,
    tfRows,
    workbookId,
    protection ? { keyColumn: 1, protectedKeys: protection.protected_team_abbrs } : undefined,
  );
  if (tfResult.status === "failure") {
    failed.push("team_form_input");
    errors.push({ module: "08_team_form_input", error: tfResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  // Keep visible labels honest without altering any active calculation.
  await Promise.all([
    writeRange(workbookId, "DAILY_MATCHUPS!W1:X1", [[
      "L30_RS_Observed_TS", "Pipeline_Last_Updated",
    ]]),
    writeRange(workbookId, "TODAY_LINEUPS!M1", [[
      "Uncommissioned_Player_Projection",
    ]]),
    writeRange(workbookId, "TEAM_FORM_INPUT!E1:G1", [[
      "DECOMMISSIONED_Last_10_wOBA",
      "DECOMMISSIONED_Recent_Strength_of_Schedule",
      "DECOMMISSIONED_Bullpen_Rest_Days",
    ]]),
  ]).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "MODULE_08: Input-label refresh failed; feed values remain valid",
    );
  });

  // 4. BULLPEN_USAGE_DAILY — reliever workload (04b) + season quality (02b)
  let buResult: SheetWriteStatus = { status: "skipped", rows_written: 0, range: "BULLPEN_USAGE_DAILY!A2:U300" };
  try {
    await expandSheetColumns(workbookId, "BULLPEN_USAGE_DAILY", 21);
    await writeRange(workbookId, "BULLPEN_USAGE_DAILY!M1:U1", [[
      "Availability_Status", "Appearances_Last_5", "Pitches_Yesterday",
      "Pitches_2_Days_Ago", "Pitches_3_Days_Ago", "Pitches_4_Days_Ago",
      "Pitches_5_Days_Ago", "Workload_Source", "Source_Snapshot_TS",
    ]]);
    const buRows = buildBullpenRows(runDate, bullpenData, statsMap);
    buResult = await safeWrite(
      "BULLPEN_USAGE_DAILY",
      "BULLPEN_USAGE_DAILY!A2:U300",
      `BULLPEN_USAGE_DAILY!A2:U${1 + Math.max(buRows.length, 1)}`,
      buRows,
      workbookId,
      protection ? { keyColumn: 1, protectedKeys: protection.protected_team_abbrs } : undefined,
    );
    if (buResult.status === "failure") throw new Error(buResult.error ?? "write failed");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failed.push("bullpen_usage_daily");
    errors.push({ module: "08_bullpen_usage_daily", error: message, timestamp: new Date().toISOString() });
    buResult = { status: "failure", rows_written: 0, range: "BULLPEN_USAGE_DAILY!A2:U300", error: message };
  }

  // 5. RUN_ENVIRONMENT — 12 cols A–L, starts row 2
  const reRows = buildRunEnvironmentRows(normalized.games, snMap);
  const reResult = await safeWrite(
    "RUN_ENVIRONMENT",
    "RUN_ENVIRONMENT!A2:L32",
    `RUN_ENVIRONMENT!A2:L${1 + Math.max(reRows.length, 1)}`,
    reRows,
    workbookId,
    protection ? { keyColumn: 1, protectedKeys: protection.protected_game_ids, orderedKeys: protection.expected_game_ids } : undefined,
  );
  if (reResult.status === "failure") {
    failed.push("run_environment");
    errors.push({ module: "08_run_environment", error: reResult.error ?? "write failed", timestamp: new Date().toISOString() });
  }

  const totalSheets = 5;
  const overallStatus =
    failed.length === 0
      ? "success"
      : failed.length === totalSheets
        ? "failure"
        : "partial_failure";

  logger.info({ overallStatus, failed }, "MODULE_08: Feed write complete");

  return {
    status: overallStatus,
    write_timestamp_utc: new Date().toISOString(),
    workbook_id: workbookId,
    sheets_written: {
      daily_matchups: dmResult,
      today_lineups: tlResult,
      team_form_input: tfResult,
      bullpen_usage_daily: buResult,
      run_environment: reResult,
    },
    errors,
  };
}
