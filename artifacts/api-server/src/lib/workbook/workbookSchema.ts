/**
 * Workbook schema definitions for the Frostline Pipeline Google Sheets workbook.
 * Canonical source of truth for sheet names, column layout, types, and formats.
 */

/**
 * Schema version — bump whenever column layout changes; stamped into every
 * RUN_LOG row so each run records which schema wrote it.
 *  v1 (2026-07-20): initial workbook — 25-col DAILY_MATCHUPS, core sheets.
 *  v2 (2026-07-23): totals expansion — DAILY_MATCHUPS Z–AU (starter last outing,
 *      plate ump, season stats, line movement, platoon), bullpen ERA/WHIP/tier,
 *      ODDS_HISTORY sheet, RUN_LOG Schema_Version column, README sheet.
 */
/**
 *  v3 (2026-07-24): added six ANALYSIS sheets to WORKBOOK_SCHEMA so
 *      SCHEMA_REFERENCE documents the full commissioning stack:
 *      SHADOW_HISTORY, SHADOW_OUTCOMES, REGRESSION_REPORT, STARTER_AUDIT,
 *      VEHICLE_LOG, VEHICLE_POSTMORTEM.
 *  v4 (2026-07-25): SLATE_BOARD AB column — Survival_Floor (Over stress-test floor).
 *      Park × weather combined multiplier capped at +1.5-run addition in MODULE_09.
 *  v5 (2026-07-25): Board-lock gate — BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH constant;
 *      SLATE_INPUT AH = Board_Lock_Status (PRE_LOCK | LOCKED_IN | LOCKED_OUT);
 *      SLATE_BOARD AH = Lock_Status. After the lock cutoff (default 2 h before first pitch)
 *      games not already CORE cannot be promoted by later numerical refreshes.
 *  v6 (2026-07-25): Per-game board lock — each game locks independently before its own
 *      first pitch.  BOARD_LOCK_STATE sheet added as authoritative governance store
 *      (12 cols A–L) with operator Late_Change_Reason / Late_Promotion_Authorized fields
 *      enabling controlled post-lock CORE exceptions for named baseball reasons only.
 *  v7 (2026-07-25): MONOTONICITY sheet — edge-tier hit-rate analysis from module15.
 *      REPLAY_RESULTS extended with Market_Line + Edge_BLEND_PARK_PITCHER columns (cols AE–AE).
 *  v8 (2026-07-25): SURVIVAL_GATE_REPLAY sheet — retroactive survival gate analysis from module18.
 *  v9 (2026-07-26): SURVIVAL_GATE_REPLAY cols 26–27 added — Away_Offense_Source and
 *      Home_Offense_Source read from SHADOW_HISTORY. Notes shifted to col 28. REPLAY_COLS = 29.
 *      module11 SlateBoardEntry carries away_offense_source / home_offense_source;
 *      warns when a CORE Over uses a non-BLENDED offense projection.
 *  v10 (2026-07-26): Pipeline_Last_Updated renamed from Statcast_Last_Updated
 *      (DAILY_MATCHUPS col X, index 23). module02_statcast.ts renamed to
 *      module02_pitcherWorkload.ts.
 *  v11 (2026-07-26): STATCAST_GAME_PREVIEW sheet added — per-game Baseball Savant
 *      preview ingestion (55-col schema: identity + status + pitcher Statcast +
 *      hitter aggregates). Fail-open; Preview_Used_In_Projection = NO throughout
 *      Phase 1. No projection or authorization change.
 *  v12 (2026-07-26): RUN_LOG extended with 8 Statcast preview observability cols
 *      (indices 30–37): Statcast_Preview_Status/Games_Expected/Available/Parsed/
 *      Missing/Failed/Stale_Count/Identity_Mismatch_Count. Phase 2 completion.
 *  v13 (2026-07-26): STATCAST_SHADOW_AUDIT sheet added (23 cols) — per-game shadow
 *      projection via Baseball Savant pitcher xwOBA-allowed. Phase 3 shadow feature
 *      mapping. Preview_Used_In_Projection = NO throughout; no CORE/auth impact.
 *  v14 (2026-08-02): End-to-end decision lineage. Shared environment identity is
 *      mirrored across DAILY_MATCHUPS, RUN_ENVIRONMENT, and GAME_SUMMARY;
 *      GAME_SUMMARY, PLAYER_INTEGRATION, SLATE_INPUT, and SLATE_BOARD gain explicit
 *      source, component, score, Run_ID, model-version, and read-back audit fields.
 *  v19 (2026-08-09): DECISION_AUDIT_LOG required two-phase ledger. Pregame model,
 *      manual-overlay, and authorization fields freeze at board lock; settlement
 *      appends actuals and independent grading without rewriting pregame reasoning.
 *  v20 (2026-08-12): Prospective lifecycle firewall, immutable publication,
 *      single-source authorization, audit-gap state, truthful lifecycle timestamps,
 *      and separate total/allocation/margin/winner settlement measurements.
 *  v21 (2026-08-16): STATCAST_SHADOW_AUDIT adds estimated traffic-conversion
 *      and HR/XBH damage adjustments plus a combined estimated projection.
 *  v22 (2026-08-18): STATCAST_SHADOW_AUDIT adds a shadow-only low-center
 *      volatility challenger and upper-tail audit band.
 *  v23 (2026-08-19): STATCAST_SHADOW_AUDIT adds a separate +2.00 low-center
 *      sensitivity challenger for prospective calibration comparison.
 *  v24 (2026-08-19): LOW_CENTER_CALIBRATION_HISTORY preserves timestamped
 *      low-center candidates; settlement writes their prospective comparison.
 *  v25 (2026-08-21): STARTER_SURVIVAL_CALIBRATION_HISTORY and REPORT preserve
 *      the four-state starter workload challenger and grade it at settlement.
 */
export const WORKBOOK_SCHEMA_VERSION = 25;

export interface ColumnDef {
  name: string;
  index: number;
  type: "string" | "number" | "date" | "formula" | "currency" | "percent";
  formula?: string;
  width?: number;
  format?: string;
  readOnly?: boolean;
  description?: string;
  filledBy?: "MODULE_05d" | "MODULE_08" | "MODULE_08b" | "MODULE_09" | "MODULE_09s" | "MODULE_09t" | "MODULE_10" | "MODULE_11" | "MODULE_12" | "MODULE_13" | "MODULE_14" | "MODULE_15" | "MODULE_16" | "MODULE_17" | "MODULE_18" | "MODULE_20" | "FORMULA" | "OPERATOR" | "SYSTEM";
  exampleValue?: string;
}

export interface SheetDef {
  name: string;
  description: string;
  section: "INPUT" | "COMPUTATION" | "OUTPUT" | "REFERENCE" | "META" | "ANALYSIS";
  columns: ColumnDef[];
  frozenRows?: number;
}

const HISTORICAL_REPLAY_COLUMNS = [
  "Replay_Date", "Game_ID", "Away_Team", "Home_Team", "Actual_Total",
  "Legacy_Projected", "L30_Park_Projected", "L10_Park_Projected",
  "Blend_Projected", "Blend_Park_Projected", "Legacy_Error", "L30_Park_Error",
  "L10_Park_Error", "Blend_Error", "Blend_Park_Error", "Away_L30_Rate",
  "Home_L30_Rate", "Away_L10_Rate", "Home_L10_Rate", "Away_Offense_Source",
  "Home_Offense_Source", "Park_Runs_Pct", "Park_Multiplier", "Park_Source_Status",
  "Away_Starter_Quality", "Home_Starter_Quality", "Blend_Park_Pitcher_Projected",
  "Blend_Park_Pitcher_Error", "Market_Line", "Edge_BLEND_PARK_PITCHER",
  "Blend_Park_Pitcher_Env_Projected", "Blend_Park_Pitcher_Env_Error",
  "Environment_Projection_Delta", "Historical_Weather_Status", "Weather_Multiplier",
  "Combined_Run_Multiplier", "Home_Run_Factor", "Roof_Status", "Wind_Disposition",
  "Environment_Certainty", "Weather_Vehicle_Status", "Replay_Run_TS",
] as const;

const HISTORICAL_REPLAY_STRING_COLUMNS = new Set([
  0, 1, 2, 3, 19, 20, 23, 33, 37, 38, 39, 40, 41,
]);

// Header background colours per section (RGB 0–1)
export const SECTION_COLORS: Record<SheetDef["section"], { red: number; green: number; blue: number }> = {
  INPUT:       { red: 0.10, green: 0.14, blue: 0.22 }, // deep navy
  COMPUTATION: { red: 0.12, green: 0.10, blue: 0.22 }, // deep indigo
  OUTPUT:      { red: 0.10, green: 0.20, blue: 0.14 }, // deep green
  REFERENCE:   { red: 0.18, green: 0.14, blue: 0.10 }, // deep amber
  META:        { red: 0.12, green: 0.12, blue: 0.12 }, // dark grey
  ANALYSIS:    { red: 0.10, green: 0.18, blue: 0.22 }, // deep teal — shadow/replay sheets
};

export const WORKBOOK_SCHEMA: SheetDef[] = [
  // ─── INPUT SECTION ─────────────────────────────────────────────────────────
  {
    name: "DAILY_MATCHUPS",
    description: "Game identity, pitcher workload, weather, park effects",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_08", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, filledBy: "MODULE_08", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Game_Status", index: 2, type: "string", width: 80, filledBy: "MODULE_08", description: "TBD, Scheduled, In Progress, Final", exampleValue: "Scheduled" },
      { name: "Away_Team", index: 3, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "BOS" },
      { name: "Home_Team", index: 4, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "NYY" },
      { name: "Away_Pitcher", index: 5, type: "string", width: 120, filledBy: "MODULE_08", exampleValue: "Brayan Bello" },
      { name: "Home_Pitcher", index: 6, type: "string", width: 120, filledBy: "MODULE_08", exampleValue: "Gerrit Cole" },
      { name: "Away_Pitcher_Role", index: 7, type: "string", width: 100, filledBy: "MODULE_08", description: "CONVENTIONAL_STARTER, BULLPEN_GAME, OPENER, etc.", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Home_Pitcher_Role", index: 8, type: "string", width: 100, filledBy: "MODULE_08", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Away_Pitcher_Confidence", index: 9, type: "percent", width: 90, format: "0%", filledBy: "MODULE_08", exampleValue: "0.75" },
      { name: "Home_Pitcher_Confidence", index: 10, type: "percent", width: 90, format: "0%", filledBy: "MODULE_08", exampleValue: "0.90" },
      { name: "Away_Expected_Pitches", index: 11, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "85" },
      { name: "Home_Expected_Pitches", index: 12, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "95" },
      { name: "Away_Expected_Innings", index: 13, type: "number", width: 100, format: "0.0", filledBy: "MODULE_08", exampleValue: "5.5" },
      { name: "Home_Expected_Innings", index: 14, type: "number", width: 100, format: "0.0", filledBy: "MODULE_08", exampleValue: "6.0" },
      { name: "Temperature_F", index: 15, type: "number", width: 90, format: "0", filledBy: "MODULE_08", exampleValue: "78" },
      { name: "Wind_MPH", index: 16, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", exampleValue: "12.5" },
      { name: "Precipitation_Pct", index: 17, type: "percent", width: 100, format: "0%", filledBy: "MODULE_08", exampleValue: "0.05" },
      { name: "Weather_Source", index: 18, type: "string", width: 100, filledBy: "MODULE_08", description: "LIVE_WX or CLIMATOLOGY", exampleValue: "LIVE_WX" },
      { name: "Stadium", index: 19, type: "string", width: 140, filledBy: "MODULE_08", exampleValue: "Yankee Stadium" },
      { name: "Home_Run_Factor", index: 20, type: "number", width: 120, format: "0.0000", filledBy: "MODULE_09", description: "Shared environment resolver HR factor: structural park baseline plus conservative daily weather.", exampleValue: "1.0520" },
      { name: "Run_Multiplier", index: 21, type: "number", width: 120, format: "0.0000", filledBy: "MODULE_09", description: "Exact effective combined multiplier used by Module 09 after the environment run-addition cap.", exampleValue: "1.0350" },
      { name: "FanGraphs_Last_Updated", index: 22, type: "date", width: 130, format: "mm/dd/yyyy hh:mm", filledBy: "MODULE_08", exampleValue: "07/22/2026 08:00" },
      { name: "Pipeline_Last_Updated", index: 23, type: "date", width: 130, format: "mm/dd/yyyy hh:mm", filledBy: "MODULE_08", description: "Timestamp of the most recent successful module08 feed-writing run. Not a Statcast fetch timestamp.", exampleValue: "07/22/2026 06:00" },
      { name: "Notes", index: 24, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "Dome game — weather neutral" },
      // ── Starter previous outing (module 04d) ────────────────────────────────
      { name: "Away_Last_Outing_Date", index: 25, type: "string", width: 110, filledBy: "MODULE_08", exampleValue: "2026-07-18" },
      { name: "Away_Last_IP", index: 26, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", description: "Baseball notation: 3.2 = 3⅔ IP", exampleValue: "5.2" },
      { name: "Away_Last_Pitches", index: 27, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "94" },
      { name: "Away_Days_Rest", index: 28, type: "number", width: 90, format: "0", filledBy: "MODULE_08", exampleValue: "5" },
      { name: "Away_Stress_Flag", index: 29, type: "string", width: 110, filledBy: "MODULE_08", description: "NORMAL, SHORT_REST, KNOCKED_OUT, DEEP_OUTING", exampleValue: "NORMAL" },
      { name: "Home_Last_Outing_Date", index: 30, type: "string", width: 110, filledBy: "MODULE_08", exampleValue: "2026-07-17" },
      { name: "Home_Last_IP", index: 31, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", description: "Baseball notation: 3.2 = 3⅔ IP", exampleValue: "7.0" },
      { name: "Home_Last_Pitches", index: 32, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "89" },
      { name: "Home_Days_Rest", index: 33, type: "number", width: 90, format: "0", filledBy: "MODULE_08", exampleValue: "6" },
      { name: "Home_Stress_Flag", index: 34, type: "string", width: 110, filledBy: "MODULE_08", description: "NORMAL, SHORT_REST, KNOCKED_OUT, DEEP_OUTING", exampleValue: "DEEP_OUTING" },
      // ── Plate umpire (module 04e; blank before ~noon ET) ────────────────────
      { name: "Plate_Umpire", index: 35, type: "string", width: 130, filledBy: "MODULE_08", exampleValue: "Pat Hoberg" },
      // ── Starter season stats (module 02b) ───────────────────────────────────
      { name: "Away_ERA", index: 36, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "3.85" },
      { name: "Away_FIP", index: 37, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "3.99" },
      { name: "Away_K_Pct", index: 38, type: "percent", width: 90, format: "0.0%", filledBy: "MODULE_08", exampleValue: "0.272" },
      { name: "Home_ERA", index: 39, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "2.06" },
      { name: "Home_FIP", index: 40, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "2.72" },
      { name: "Home_K_Pct", index: 41, type: "percent", width: 90, format: "0.0%", filledBy: "MODULE_08", exampleValue: "0.289" },
      // ── O/U line movement (module 05d) ──────────────────────────────────────
      { name: "Total_Open", index: 42, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", exampleValue: "8.5" },
      { name: "Total_Current", index: 43, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", exampleValue: "8.0" },
      { name: "Total_Move", index: 44, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", description: "Current − open; negative = money on the under", exampleValue: "-0.5" },
      // ── Lineup platoon advantage vs. opposing starter (module 08) ───────────
      { name: "Away_Platoon_Adv", index: 45, type: "percent", width: 100, format: "0%", filledBy: "MODULE_08", description: "Share of lineup with platoon edge; blank until lineup posts", exampleValue: "0.67" },
      { name: "Home_Platoon_Adv", index: 46, type: "percent", width: 100, format: "0%", filledBy: "MODULE_08", description: "Share of lineup with platoon edge; blank until lineup posts", exampleValue: "0.44" },
    ],
  },

  {
    name: "TODAY_LINEUPS",
    description: "Batting order projections, recent form splits",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_08", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, filledBy: "MODULE_08", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Team", index: 2, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "NYY" },
      { name: "Batting_Order", index: 3, type: "number", width: 80, format: "0", filledBy: "MODULE_08", exampleValue: "3" },
      { name: "Player_Name", index: 4, type: "string", width: 120, filledBy: "MODULE_08", exampleValue: "Aaron Judge" },
      { name: "Player_ID", index: 5, type: "string", width: 100, filledBy: "MODULE_08", exampleValue: "592450" },
      { name: "Position", index: 6, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "RF" },
      { name: "vs_LHP_wRC_plus", index: 7, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "198" },
      { name: "vs_RHP_wRC_plus", index: 8, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "172" },
      { name: "Last_30_Days_wRC_plus", index: 9, type: "number", width: 110, format: "0", filledBy: "MODULE_08", exampleValue: "185" },
      { name: "Injury_Status", index: 10, type: "string", width: 100, filledBy: "MODULE_08", exampleValue: "ACTIVE" },
      { name: "Salary", index: 11, type: "currency", width: 100, format: "$#,##0", filledBy: "MODULE_08", exampleValue: "5800" },
      { name: "FanGraphs_Projection", index: 12, type: "number", width: 110, format: "0.000", filledBy: "MODULE_08", exampleValue: "42.500" },
      { name: "Notes", index: 13, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "TEAM_FORM_INPUT",
    description: "Recent team-level offensive and defensive context",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_08", exampleValue: "07/22/2026" },
      { name: "Team", index: 1, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "NYY" },
      { name: "Last_10_Runs_Scored", index: 2, type: "number", width: 120, format: "0.0", filledBy: "MODULE_08", exampleValue: "5.2" },
      { name: "Last_10_Runs_Allowed", index: 3, type: "number", width: 120, format: "0.0", filledBy: "MODULE_08", exampleValue: "3.8" },
      { name: "Last_10_wOBA", index: 4, type: "number", width: 100, format: "0.000", filledBy: "MODULE_08", exampleValue: "0.342" },
      { name: "Recent_Strength_of_Schedule", index: 5, type: "string", width: 120, filledBy: "MODULE_08", exampleValue: "MEDIUM" },
      { name: "Bullpen_Rest_Days", index: 6, type: "number", width: 110, format: "0", filledBy: "MODULE_08", exampleValue: "2" },
      { name: "Notes", index: 7, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "BULLPEN_USAGE_DAILY",
    description: "Relief pitcher availability and workload tracking",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_08", exampleValue: "07/22/2026" },
      { name: "Team", index: 1, type: "string", width: 70, filledBy: "MODULE_08", exampleValue: "NYY" },
      { name: "Reliever_Name", index: 2, type: "string", width: 120, filledBy: "MODULE_08", exampleValue: "Clay Holmes" },
      { name: "Player_ID", index: 3, type: "string", width: 100, filledBy: "MODULE_08", exampleValue: "656302" },
      { name: "Innings_Last_7_Days", index: 4, type: "number", width: 120, format: "0.0", filledBy: "MODULE_08", exampleValue: "2.1" },
      { name: "Games_Last_7_Days", index: 5, type: "number", width: 120, format: "0", filledBy: "MODULE_08", exampleValue: "3" },
      { name: "Days_Rest", index: 6, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "1" },
      { name: "Role", index: 7, type: "string", width: 100, filledBy: "MODULE_08", description: "CLOSER, SETUP, MIDDLE", exampleValue: "CLOSER" },
      { name: "Notes", index: 8, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
      // ── Reliever season quality (module 02b) ────────────────────────────────
      { name: "ERA", index: 9, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "2.95" },
      { name: "WHIP", index: 10, type: "number", width: 80, format: "0.00", filledBy: "MODULE_08", exampleValue: "1.14" },
      { name: "Quality_Tier", index: 11, type: "string", width: 90, filledBy: "MODULE_08", description: "ERA tier: A <3.20, B <4.00, C <5.00, D otherwise", exampleValue: "A" },
    ],
  },

  {
    name: "RUN_ENVIRONMENT",
    description: "Game context: weather, umpire, park, altitude effects",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_08", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, filledBy: "MODULE_08", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Stadium", index: 2, type: "string", width: 140, filledBy: "MODULE_08", exampleValue: "Yankee Stadium" },
      { name: "Elevation_Feet", index: 3, type: "number", width: 120, format: "0", filledBy: "MODULE_08", exampleValue: "55" },
      { name: "Temperature_F", index: 4, type: "number", width: 100, format: "0", filledBy: "MODULE_08", exampleValue: "78" },
      { name: "Wind_MPH", index: 5, type: "number", width: 90, format: "0.0", filledBy: "MODULE_08", exampleValue: "12.5" },
      { name: "Wind_Direction", index: 6, type: "string", width: 100, filledBy: "MODULE_08", exampleValue: "OUT_TO_CF" },
      { name: "Precipitation_Pct", index: 7, type: "percent", width: 100, format: "0%", filledBy: "MODULE_08", exampleValue: "0.05" },
      { name: "Humidity_Pct", index: 8, type: "percent", width: 100, format: "0%", filledBy: "MODULE_08", exampleValue: "0.62" },
      { name: "Home_Run_Factor", index: 9, type: "number", width: 100, format: "0.000", filledBy: "MODULE_08", exampleValue: "1.052" },
      { name: "Run_Multiplier", index: 10, type: "number", width: 110, format: "0.000", filledBy: "MODULE_08", exampleValue: "1.035" },
      { name: "Notes", index: 11, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "ODDS_HISTORY",
    description: "Append-only O/U snapshot log; earliest row per game per day = opener",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      // Snapshot_TS_UTC / Date stay type "string": module 05d compares raw
      // values on read-back — a date display format would break the match.
      { name: "Snapshot_TS_UTC", index: 0, type: "string", width: 190, filledBy: "MODULE_05d", exampleValue: "2026-07-23T06:05:37.958Z" },
      { name: "Date", index: 1, type: "string", width: 100, filledBy: "MODULE_05d", exampleValue: "2026-07-23" },
      { name: "Game_ID", index: 2, type: "string", width: 150, filledBy: "MODULE_05d", exampleValue: "20260723_SDP_ATL" },
      { name: "Total", index: 3, type: "number", width: 80, format: "0.0", filledBy: "MODULE_05d", exampleValue: "8.5" },
      { name: "Over_Odds", index: 4, type: "number", width: 90, format: "0", filledBy: "MODULE_05d", exampleValue: "-112" },
      { name: "Under_Odds", index: 5, type: "number", width: 90, format: "0", filledBy: "MODULE_05d", exampleValue: "-85" },
      { name: "Bookmaker", index: 6, type: "string", width: 110, filledBy: "MODULE_05d", exampleValue: "FanDuel" },
    ],
  },

  {
    name: "STATCAST_GAME_PREVIEW",
    description: "Per-game Baseball Savant pregame preview: fetch status + pitcher Statcast + hitter aggregates. Phase 1 — ingestion only; Preview_Used_In_Projection = NO throughout.",
    section: "INPUT",
    frozenRows: 1,
    columns: [
      // ── Identity + fetch status (cols A–U, indices 0–20) ─────────────────
      { name: "Date",                         index: 0,  type: "string",  width: 100, filledBy: "MODULE_08b", description: "ISO date string yyyy-mm-dd", exampleValue: "2026-07-26" },
      { name: "Game_ID",                       index: 1,  type: "string",  width: 160, filledBy: "MODULE_08b", exampleValue: "2026/07/26-ARI-WAS" },
      { name: "MLB_GamePk",                    index: 2,  type: "number",  width: 110, filledBy: "MODULE_08b", exampleValue: "822706" },
      { name: "Away_Team",                     index: 3,  type: "string",  width: 80,  filledBy: "MODULE_08b", exampleValue: "ARI" },
      { name: "Home_Team",                     index: 4,  type: "string",  width: 80,  filledBy: "MODULE_08b", exampleValue: "WAS" },
      { name: "Scheduled_First_Pitch",         index: 5,  type: "string",  width: 190, filledBy: "MODULE_08b", description: "UTC ISO timestamp from MLB Stats API", exampleValue: "2026-07-26T17:05:00Z" },
      { name: "Preview_Availability",          index: 6,  type: "string",  width: 180, filledBy: "MODULE_08b", description: "AVAILABLE | NOT_PUBLISHED | NOT_FOUND | SOURCE_UNAVAILABLE | PARSE_FAILED | IDENTITY_MISMATCH | STALE | UNSUPPORTED_FORMAT", exampleValue: "AVAILABLE" },
      { name: "Fetch_Status",                  index: 7,  type: "string",  width: 120, filledBy: "MODULE_08b", description: "success | http_error | timeout | parse_error | skipped", exampleValue: "success" },
      { name: "Fetch_TS",                      index: 8,  type: "string",  width: 190, filledBy: "MODULE_08b", description: "ISO timestamp when the HTTP fetch completed", exampleValue: "2026-07-26T06:00:01.234Z" },
      { name: "Source_Name",                   index: 9,  type: "string",  width: 250, filledBy: "MODULE_08b", exampleValue: "Baseball Savant Game Preview (baseballsavant.mlb.com/preview)" },
      { name: "Source_URL_or_Endpoint",        index: 10, type: "string",  width: 300, filledBy: "MODULE_08b", exampleValue: "https://baseballsavant.mlb.com/preview?game_pk=822706" },
      { name: "Source_Published_TS",           index: 11, type: "string",  width: 190, filledBy: "MODULE_08b", description: "Not available from this source; blank in Phase 1", exampleValue: "" },
      { name: "Payload_Hash",                  index: 12, type: "string",  width: 140, filledBy: "MODULE_08b", description: "First 16 hex chars of SHA-256 over the raw var teams JSON", exampleValue: "a3f9c2e1b5d07820" },
      { name: "Parser_Version",                index: 13, type: "string",  width: 110, filledBy: "MODULE_08b", exampleValue: "1.0.0" },
      { name: "Starting_Pitcher_Match_Status", index: 14, type: "string",  width: 200, filledBy: "MODULE_08b", description: "MATCHED | UNVERIFIED | MISMATCH | NO_PROBABLE", exampleValue: "MATCHED" },
      { name: "Lineup_Match_Status",           index: 15, type: "string",  width: 180, filledBy: "MODULE_08b", description: "LINEUP_POSTED | LINEUP_NOT_POSTED | UNAVAILABLE", exampleValue: "LINEUP_NOT_POSTED" },
      { name: "Stale_Data_Flag",               index: 16, type: "string",  width: 120, filledBy: "MODULE_08b", description: "YES | NO", exampleValue: "NO" },
      { name: "Parse_Warnings",                index: 17, type: "string",  width: 300, filledBy: "MODULE_08b", description: "Semicolon-separated list of non-fatal parse issues", exampleValue: "" },
      { name: "Parse_Error",                   index: 18, type: "string",  width: 250, filledBy: "MODULE_08b", description: "Fatal parse error message; blank on success", exampleValue: "" },
      { name: "Preview_Used_In_Projection",    index: 19, type: "string",  width: 200, filledBy: "MODULE_08b", description: "Always NO in Phase 1", exampleValue: "NO" },
      { name: "Projection_Influence_Notes",    index: 20, type: "string",  width: 300, filledBy: "MODULE_08b", exampleValue: "Phase 1 — ingestion only; no projection influence authorised" },
      // ── Away probable pitcher Statcast (cols V–AE, indices 21–30) ────────
      { name: "Away_Pitcher_ID",               index: 21, type: "number",  width: 110, filledBy: "MODULE_08b", description: "MLB player ID of the away probable pitcher", exampleValue: "684442" },
      { name: "Away_Pitcher_Name",             index: 22, type: "string",  width: 160, filledBy: "MODULE_08b", exampleValue: "Kohl Drake" },
      { name: "Away_Pitcher_Qualifies",        index: 23, type: "string",  width: 130, filledBy: "MODULE_08b", description: "YES when the pitcher has sufficient BF for Statcast metrics; NO = didNotQualify", exampleValue: "NO" },
      { name: "Away_Pitcher_xwOBA",            index: 24, type: "number",  width: 130, format: "0.000", filledBy: "MODULE_08b", description: "Season xwOBA allowed by the away starter", exampleValue: "0.344" },
      { name: "Away_Pitcher_K_Pct",            index: 25, type: "number",  width: 120, format: "0.0", filledBy: "MODULE_08b", description: "Season K% for the away starter", exampleValue: "23.8" },
      { name: "Away_Pitcher_BB_Pct",           index: 26, type: "number",  width: 120, format: "0.0", filledBy: "MODULE_08b", exampleValue: "9.5" },
      { name: "Away_Pitcher_EV_Avg",           index: 27, type: "number",  width: 130, format: "0.0", filledBy: "MODULE_08b", description: "Average exit velocity allowed (mph)", exampleValue: "87.7" },
      { name: "Away_Pitcher_Whiff_Pct",        index: 28, type: "number",  width: 130, format: "0.0", filledBy: "MODULE_08b", exampleValue: "33.3" },
      { name: "Away_Pitcher_Hard_Hit_Pct",     index: 29, type: "number",  width: 150, format: "0.0", filledBy: "MODULE_08b", description: "Hard-hit % allowed (EV ≥ 95 mph)", exampleValue: "46.2" },
      { name: "Away_Pitcher_Barrel_Rate",      index: 30, type: "number",  width: 140, format: "0.0", filledBy: "MODULE_08b", exampleValue: "15.4" },
      // ── Home probable pitcher Statcast (cols AF–AO, indices 31–40) ───────
      { name: "Home_Pitcher_ID",               index: 31, type: "number",  width: 110, filledBy: "MODULE_08b", exampleValue: "571945" },
      { name: "Home_Pitcher_Name",             index: 32, type: "string",  width: 160, filledBy: "MODULE_08b", exampleValue: "Miles Mikolas" },
      { name: "Home_Pitcher_Qualifies",        index: 33, type: "string",  width: 130, filledBy: "MODULE_08b", description: "YES when the pitcher has sufficient BF for Statcast metrics; NO = didNotQualify", exampleValue: "YES" },
      { name: "Home_Pitcher_xwOBA",            index: 34, type: "number",  width: 130, format: "0.000", filledBy: "MODULE_08b", exampleValue: "0.344" },
      { name: "Home_Pitcher_K_Pct",            index: 35, type: "number",  width: 120, format: "0.0", filledBy: "MODULE_08b", exampleValue: "12.2" },
      { name: "Home_Pitcher_BB_Pct",           index: 36, type: "number",  width: 120, format: "0.0", filledBy: "MODULE_08b", exampleValue: "4.8" },
      { name: "Home_Pitcher_EV_Avg",           index: 37, type: "number",  width: 130, format: "0.0", filledBy: "MODULE_08b", exampleValue: "89.9" },
      { name: "Home_Pitcher_Whiff_Pct",        index: 38, type: "number",  width: 130, format: "0.0", filledBy: "MODULE_08b", exampleValue: "14.7" },
      { name: "Home_Pitcher_Hard_Hit_Pct",     index: 39, type: "number",  width: 150, format: "0.0", filledBy: "MODULE_08b", exampleValue: "41.6" },
      { name: "Home_Pitcher_Barrel_Rate",      index: 40, type: "number",  width: 140, format: "0.0", filledBy: "MODULE_08b", exampleValue: "8.8" },
      // ── Away hitter aggregates — qualified hitters only (cols AP–AV, indices 41–47) ──
      { name: "Away_Hitters_Total",            index: 41, type: "number",  width: 130, format: "0", filledBy: "MODULE_08b", description: "Total hitter rows returned by the page for the away team", exampleValue: "26" },
      { name: "Away_Hitters_Qualified",        index: 42, type: "number",  width: 150, format: "0", filledBy: "MODULE_08b", description: "Hitters with didNotQualify = false", exampleValue: "14" },
      { name: "Away_Hitters_xwOBA_Avg",        index: 43, type: "number",  width: 160, format: "0.000", filledBy: "MODULE_08b", description: "Mean xwOBA across qualified away hitters", exampleValue: "0.318" },
      { name: "Away_Hitters_EV_Avg",           index: 44, type: "number",  width: 150, format: "0.0", filledBy: "MODULE_08b", description: "Mean exit velocity across qualified away hitters", exampleValue: "88.4" },
      { name: "Away_Hitters_Hard_Hit_Avg",     index: 45, type: "number",  width: 170, format: "0.0", filledBy: "MODULE_08b", description: "Mean hard-hit % across qualified away hitters", exampleValue: "37.2" },
      { name: "Away_Hitters_K_Pct_Avg",        index: 46, type: "number",  width: 155, format: "0.0", filledBy: "MODULE_08b", description: "Mean K% across qualified away hitters", exampleValue: "21.4" },
      { name: "Away_Hitters_BB_Pct_Avg",       index: 47, type: "number",  width: 155, format: "0.0", filledBy: "MODULE_08b", description: "Mean BB% across qualified away hitters", exampleValue: "8.1" },
      // ── Home hitter aggregates — qualified hitters only (cols AW–BC, indices 48–54) ──
      { name: "Home_Hitters_Total",            index: 48, type: "number",  width: 130, format: "0", filledBy: "MODULE_08b", exampleValue: "26" },
      { name: "Home_Hitters_Qualified",        index: 49, type: "number",  width: 150, format: "0", filledBy: "MODULE_08b", exampleValue: "12" },
      { name: "Home_Hitters_xwOBA_Avg",        index: 50, type: "number",  width: 160, format: "0.000", filledBy: "MODULE_08b", exampleValue: "0.305" },
      { name: "Home_Hitters_EV_Avg",           index: 51, type: "number",  width: 150, format: "0.0", filledBy: "MODULE_08b", exampleValue: "87.9" },
      { name: "Home_Hitters_Hard_Hit_Avg",     index: 52, type: "number",  width: 170, format: "0.0", filledBy: "MODULE_08b", exampleValue: "35.8" },
      { name: "Home_Hitters_K_Pct_Avg",        index: 53, type: "number",  width: 155, format: "0.0", filledBy: "MODULE_08b", exampleValue: "20.1" },
      { name: "Home_Hitters_BB_Pct_Avg",       index: 54, type: "number",  width: 155, format: "0.0", filledBy: "MODULE_08b", exampleValue: "7.6" },
    ],
  },

  // ─── COMPUTATION SECTION ────────────────────────────────────────────────────
  {
    name: "GAME_INTEGRATION",
    description: "Per-team aggregation: DAILY_MATCHUPS + derived fields",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "MODULE_09", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 160, readOnly: true, filledBy: "MODULE_09", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "BOS" },
      { name: "Opponent", index: 3, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "NYY" },
      { name: "Is_Home", index: 4, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", description: "YES / NO", exampleValue: "NO" },
      { name: "Pitcher", index: 5, type: "string", width: 120, readOnly: true, filledBy: "MODULE_09", exampleValue: "Brayan Bello" },
      { name: "Pitcher_Role", index: 6, type: "string", width: 100, readOnly: true, filledBy: "MODULE_09", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Pitcher_Confidence", index: 7, type: "percent", width: 100, format: "0%", readOnly: true, filledBy: "MODULE_09", exampleValue: "0.75" },
      { name: "Expected_Pitches", index: 8, type: "number", width: 110, format: "0", readOnly: true, filledBy: "MODULE_09", exampleValue: "85" },
      { name: "Expected_Innings", index: 9, type: "number", width: 110, format: "0.0", readOnly: true, filledBy: "MODULE_09", exampleValue: "5.5" },
      { name: "Opp_Pitcher", index: 10, type: "string", width: 120, readOnly: true, filledBy: "MODULE_09", exampleValue: "Gerrit Cole" },
      { name: "Opp_Pitcher_Role", index: 11, type: "string", width: 100, readOnly: true, filledBy: "MODULE_09", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Lineup_Factor", index: 12, type: "number", width: 120, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Batting-order-weighted season OPS with conservative platoon and Statcast xwOBA blending; neutral 1.0 when coverage is insufficient.", exampleValue: "1.025" },
      { name: "Offense_Rate_Used", index: 13, type: "number", width: 140, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Blended offensive rate fed into the projection formula. = L30_WEIGHT × L30_RS_Estimate + L10_WEIGHT × L10_RS_Actual when both present; see Offense_Source_Status for fallback hierarchy.", exampleValue: "4.512" },
      { name: "Opp_Offense_Rate_Used", index: 14, type: "number", width: 155, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Opponent team's blended offensive rate.", exampleValue: "4.320" },
      { name: "Temperature_F", index: 15, type: "number", width: 100, format: "0", readOnly: true, filledBy: "MODULE_09", exampleValue: "78" },
      { name: "Wind_MPH", index: 16, type: "number", width: 90, format: "0.0", readOnly: true, filledBy: "MODULE_09", exampleValue: "12.5" },
      { name: "Combined_Run_Multiplier", index: 17, type: "number", width: 175, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Park_Multiplier × Weather_Multiplier, clamped [0.85, 1.30]. Replaces the weather-only Run_Multiplier. See Park_Multiplier and Weather_Multiplier audit columns for decomposition.", exampleValue: "1.0420" },
      { name: "Adjusted_Scoring_Rate", index: 18, type: "number", width: 155, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Offense_Rate_Used × Combined_Run_Multiplier", exampleValue: "4.70" },
      { name: "Notes", index: 19, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
      // ── Offensive rate audit (Repair 1) — cols U–W, indices 20–22 ──
      { name: "L30_RS_Estimate", index: 20, type: "number", width: 130, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Fangraphs L30 wRC+ converted to runs/9: (wRC+/100) × 4.5. Null when Fangraphs data absent for this team.", exampleValue: "4.365" },
      { name: "L10_RS_Actual", index: 21, type: "number", width: 130, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Actual runs scored per game over the last 10 completed games (module05c). Null when fewer than 5 games available.", exampleValue: "4.900" },
      { name: "Offense_Source_Status", index: 22, type: "string", width: 180, readOnly: true, filledBy: "MODULE_09", description: "BLENDED (65% L30 + 35% L10) | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK. LEAGUE_AVG_FALLBACK always generates a pipeline warning.", exampleValue: "BLENDED" },
      // ── Park / weather multiplier audit (Repair 2) — cols X–AA, indices 23–26 ──
      { name: "Park_Runs_Pct", index: 23, type: "number", width: 120, format: "0.0", readOnly: true, filledBy: "MODULE_09", description: "Raw runs_pct from module04c (mlbstartingnine.com park factors). Signed integer % relative to league average. Null when park data absent.", exampleValue: "8" },
      { name: "Park_Multiplier", index: 24, type: "number", width: 130, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "1 + (Park_Runs_Pct / 100), clamped [0.85, 1.15]. Seasonal venue baseline. 1.0 when park data absent.", exampleValue: "1.0800" },
      { name: "Weather_Multiplier", index: 25, type: "number", width: 140, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Temperature/wind/rain deviation factor, clamped [0.90, 1.15]. Represents that day's deviation from the park baseline.", exampleValue: "0.9800" },
      { name: "Park_Source_Status", index: 26, type: "string", width: 190, readOnly: true, filledBy: "MODULE_09", description: "VENUE_FACTOR_USED | SEASONAL_FACTOR_USED | MISSING_PARK_DATA", exampleValue: "VENUE_FACTOR_USED" },
    ],
  },

  {
    name: "GAME_SUMMARY",
    description: "One row per game. Aggregates GAME_INTEGRATION to game level.",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "MODULE_09", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 160, readOnly: true, filledBy: "MODULE_09", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "NYY" },
      { name: "Away_Pitcher", index: 4, type: "string", width: 120, readOnly: true, filledBy: "MODULE_09", exampleValue: "Brayan Bello" },
      { name: "Home_Pitcher", index: 5, type: "string", width: 120, readOnly: true, filledBy: "MODULE_09", exampleValue: "Gerrit Cole" },
      { name: "Away_Lineup_Factor", index: 6, type: "number", width: 150, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Away lineup batting-order-weighted quality multiplier; neutral when source coverage is insufficient.", exampleValue: "1.025" },
      { name: "Home_Lineup_Factor", index: 7, type: "number", width: 150, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Home lineup batting-order-weighted quality multiplier; neutral when source coverage is insufficient.", exampleValue: "0.985" },
      { name: "Away_Adjusted_Scoring_Rate", index: 8, type: "number", width: 175, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Away team's blended offense rate × Combined_Run_Multiplier. Fed into Projected_Away_Runs.", exampleValue: "4.512" },
      { name: "Home_Adjusted_Scoring_Rate", index: 9, type: "number", width: 175, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Home team's blended offense rate × Combined_Run_Multiplier. Fed into Projected_Home_Runs.", exampleValue: "4.730" },
      { name: "Projected_Away_Runs", index: 10, type: "number", width: 130, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Away_Adjusted_Scoring_Rate × (home_starter_IP/9) × starter_qual + bullpen component", exampleValue: "2.79" },
      { name: "Projected_Home_Runs", index: 11, type: "number", width: 130, format: "0.00", readOnly: true, filledBy: "MODULE_09", exampleValue: "3.23" },
      { name: "Projected_Total_Runs", index: 12, type: "number", width: 155, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Projected_Away_Runs + Projected_Home_Runs", exampleValue: "6.02" },
      { name: "Temperature_F", index: 13, type: "number", width: 100, format: "0", readOnly: true, filledBy: "MODULE_09", exampleValue: "78" },
      { name: "Wind_MPH", index: 14, type: "number", width: 90, format: "0.0", readOnly: true, filledBy: "MODULE_09", exampleValue: "12.5" },
      { name: "Combined_Run_Multiplier", index: 15, type: "number", width: 175, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Park_Multiplier × Weather_Multiplier. See audit cols AA–AE for decomposition.", exampleValue: "1.0420" },
      { name: "Stadium", index: 16, type: "string", width: 140, readOnly: true, filledBy: "MODULE_09", exampleValue: "Yankee Stadium" },
      { name: "Notes", index: 17, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
      // ── Offensive rate audit (Repair 1) — cols S–Z, indices 18–25 ──
      { name: "Away_L30_RS_Estimate", index: 18, type: "number", width: 155, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Away team Fangraphs L30 wRC+ → runs/9. Null when data absent.", exampleValue: "4.365" },
      { name: "Home_L30_RS_Estimate", index: 19, type: "number", width: 155, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Home team Fangraphs L30 wRC+ → runs/9. Null when data absent.", exampleValue: "4.725" },
      { name: "Away_L10_RS_Actual", index: 20, type: "number", width: 140, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Away team actual RS/game, last 10 completed games. Null when < 5 games.", exampleValue: "4.900" },
      { name: "Home_L10_RS_Actual", index: 21, type: "number", width: 140, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Home team actual RS/game, last 10 completed games. Null when < 5 games.", exampleValue: "5.100" },
      { name: "Away_Offense_Rate_Used", index: 22, type: "number", width: 160, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Blended rate used in Away projection formula (before × run multiplier).", exampleValue: "4.552" },
      { name: "Home_Offense_Rate_Used", index: 23, type: "number", width: 160, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Blended rate used in Home projection formula (before × run multiplier).", exampleValue: "4.812" },
      { name: "Away_Offense_Source_Status", index: 24, type: "string", width: 195, readOnly: true, filledBy: "MODULE_09", description: "BLENDED | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK. FALLBACK generates a pipeline warning.", exampleValue: "BLENDED" },
      { name: "Home_Offense_Source_Status", index: 25, type: "string", width: 195, readOnly: true, filledBy: "MODULE_09", description: "BLENDED | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK. FALLBACK generates a pipeline warning.", exampleValue: "BLENDED" },
      // ── Park / weather multiplier audit (Repair 2) — cols AA–AE, indices 26–30 ──
      { name: "Park_Runs_Pct", index: 26, type: "number", width: 120, format: "0.0", readOnly: true, filledBy: "MODULE_09", description: "Raw park runs_pct from module04c (signed % vs league avg). Null when absent.", exampleValue: "8" },
      { name: "Park_Multiplier", index: 27, type: "number", width: 130, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "1 + (Park_Runs_Pct/100), clamped [0.85, 1.15]. Venue structural factor.", exampleValue: "1.0800" },
      { name: "Weather_Multiplier", index: 28, type: "number", width: 145, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Temp/wind/rain day-specific deviation, clamped [0.90, 1.15].", exampleValue: "0.9800" },
      { name: "Combined_Run_Multiplier_Audit", index: 29, type: "number", width: 210, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Park_Multiplier × Weather_Multiplier. Same value as column P — audit copy for traceability.", exampleValue: "1.0584" },
      { name: "Park_Source_Status",    index: 30, type: "string", width: 190, readOnly: true, filledBy: "MODULE_09", description: "VENUE_FACTOR_USED | SEASONAL_FACTOR_USED | MISSING_PARK_DATA", exampleValue: "VENUE_FACTOR_USED" },
      // ── Survival gate inputs (cols AF–AH, indices 31–33) — written by MODULE_09 ──
      { name: "Projected_Run_Diff",   index: 31, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Projected_Away_Runs − Projected_Home_Runs. Used as informational spread signal.", exampleValue: "-0.44" },
      { name: "Away_Starter_Quality", index: 32, type: "number", width: 165, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Away starter quality factor (FIP-derived). Used by the survival gate.", exampleValue: "0.920" },
      { name: "Home_Starter_Quality", index: 33, type: "number", width: 165, format: "0.000", readOnly: true, filledBy: "MODULE_09", description: "Home starter quality factor (FIP-derived). Used by the survival gate.", exampleValue: "0.950" },
      { name: "Home_Run_Factor", index: 34, type: "number", width: 135, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Shared resolver HR factor used for this game.", exampleValue: "1.0420" },
      { name: "Weather_Source_Status", index: 35, type: "string", width: 175, readOnly: true, filledBy: "MODULE_09", description: "LIVE | FALLBACK_NEUTRAL.", exampleValue: "LIVE" },
      { name: "Roof_Status", index: 36, type: "string", width: 150, readOnly: true, filledBy: "MODULE_09", description: "CLOSED | PENDING | OPEN_OR_OUTDOOR | UNKNOWN.", exampleValue: "OPEN_OR_OUTDOOR" },
      { name: "Wind_Disposition", index: 37, type: "string", width: 150, readOnly: true, filledBy: "MODULE_09", description: "OUT | IN | CROSS_OR_UNKNOWN | NEUTRALIZED_BY_ROOF.", exampleValue: "OUT" },
      { name: "Environment_Certainty", index: 38, type: "string", width: 165, readOnly: true, filledBy: "MODULE_09", description: "Resolver certainty after weather, roof, wind, and source checks.", exampleValue: "HIGH" },
      { name: "Weather_Vehicle_Status", index: 39, type: "string", width: 175, readOnly: true, filledBy: "MODULE_09", description: "ACTIVE or frozen weather-dependent vehicle state.", exampleValue: "ACTIVE" },
      { name: "Starter_Attack_Runs", index: 40, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "MODULE_09", exampleValue: "4.25" },
      { name: "Bullpen_Continuation_Runs", index: 41, type: "number", width: 185, format: "0.00", readOnly: true, filledBy: "MODULE_09", exampleValue: "3.10" },
      { name: "Baseline_Offense_Runs", index: 42, type: "number", width: 165, format: "0.00", readOnly: true, filledBy: "MODULE_09", exampleValue: "8.40" },
      { name: "Traffic_Conversion_Runs", index: 43, type: "number", width: 175, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Active component remains zero; current estimate is recorded in STATCAST_SHADOW_AUDIT.Traffic_Conversion_Estimate.", exampleValue: "0.00" },
      { name: "HR_XBH_Damage_Runs", index: 44, type: "number", width: 160, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Active component remains zero; current estimate is recorded in STATCAST_SHADOW_AUDIT.HR_XBH_Damage_Estimate.", exampleValue: "0.00" },
      { name: "Baseball_Only_Projection", index: 45, type: "number", width: 180, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Projection excluding park/weather contribution.", exampleValue: "7.35" },
      { name: "Environment_Run_Adjustment", index: 46, type: "number", width: 190, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Projected total minus baseball-only projection.", exampleValue: "0.55" },
      { name: "Away_Lineup_Status", index: 47, type: "string", width: 145, readOnly: true, filledBy: "MODULE_09", exampleValue: "FULL" },
      { name: "Home_Lineup_Status", index: 48, type: "string", width: 145, readOnly: true, filledBy: "MODULE_09", exampleValue: "FULL" },
      { name: "Away_Lineup_Source", index: 49, type: "string", width: 145, readOnly: true, filledBy: "MODULE_09", exampleValue: "official" },
      { name: "Home_Lineup_Source", index: 50, type: "string", width: 145, readOnly: true, filledBy: "MODULE_09", exampleValue: "official" },
      { name: "Away_Lineup_Coverage", index: 51, type: "percent", width: 155, format: "0%", readOnly: true, filledBy: "MODULE_09", exampleValue: "1.00" },
      { name: "Home_Lineup_Coverage", index: 52, type: "percent", width: 155, format: "0%", readOnly: true, filledBy: "MODULE_09", exampleValue: "1.00" },
      { name: "Away_Lineup_xwOBA_Coverage", index: 53, type: "percent", width: 195, format: "0%", readOnly: true, filledBy: "MODULE_09", exampleValue: "0.89" },
      { name: "Home_Lineup_xwOBA_Coverage", index: 54, type: "percent", width: 195, format: "0%", readOnly: true, filledBy: "MODULE_09", exampleValue: "0.78" },
    ],
  },

  {
    name: "PLAYER_INTEGRATION",
    description: "One row per posted batter. Module 09 writes lineup identity, opponent, shared environment, and explicit unavailable-stat notes.",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "MODULE_09", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 160, readOnly: true, filledBy: "MODULE_09", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "NYY" },
      { name: "Player_Name", index: 3, type: "string", width: 140, readOnly: true, filledBy: "MODULE_09", exampleValue: "Aaron Judge" },
      { name: "Player_ID", index: 4, type: "string", width: 100, readOnly: true, filledBy: "MODULE_09", exampleValue: "592450" },
      { name: "Position", index: 5, type: "string", width: 70, readOnly: true, filledBy: "MODULE_09", exampleValue: "RF" },
      { name: "Batting_Order", index: 6, type: "number", width: 100, format: "0", readOnly: true, filledBy: "MODULE_09", exampleValue: "3" },
      { name: "Vs_Pitcher", index: 7, type: "string", width: 140, readOnly: true, filledBy: "MODULE_09", exampleValue: "Brayan Bello" },
      { name: "Pitcher_Handedness", index: 8, type: "string", width: 120, readOnly: true, filledBy: "MODULE_09", description: "L / R; blank when unresolved.", exampleValue: "R" },
      { name: "Player_vs_Handedness_wRC", index: 9, type: "number", width: 180, format: "0", readOnly: true, filledBy: "MODULE_09", description: "Blank until a validated handedness-specific wRC source is commissioned.", exampleValue: "" },
      { name: "Player_Last_30_wRC", index: 10, type: "number", width: 150, format: "0", readOnly: true, filledBy: "MODULE_09", description: "Blank until a validated player L30 wRC source is commissioned.", exampleValue: "" },
      { name: "Game_Run_Environment", index: 11, type: "number", width: 160, format: "0.0000", readOnly: true, filledBy: "MODULE_09", description: "Exact GAME_SUMMARY Combined_Run_Multiplier.", exampleValue: "1.0350" },
      { name: "Adjusted_wRC_plus", index: 12, type: "number", width: 140, format: "0", readOnly: true, filledBy: "MODULE_09", description: "Blank until both wRC inputs are available; never fabricated.", exampleValue: "" },
      { name: "Salary", index: 13, type: "currency", width: 100, format: "$#,##0", readOnly: true, filledBy: "MODULE_09", description: "Blank when no salary source is available.", exampleValue: "" },
      { name: "Projected_FPTS", index: 14, type: "number", width: 120, format: "0.00", readOnly: true, filledBy: "MODULE_09", description: "Blank until a validated fantasy projection is commissioned.", exampleValue: "" },
      { name: "Notes", index: 15, type: "string", width: 320, readOnly: true, filledBy: "MODULE_09", description: "Lineup status plus explicit unavailable-source flags.", exampleValue: "lineup=official; season_ops=1.020; wRC_plus=unavailable" },
    ],
  },

  // ─── OUTPUT SECTION ─────────────────────────────────────────────────────────
  {
    name: "SLATE_INPUT",
    description: "Pipeline seed + operator override surface. Module 10 writes all 34 columns A–AH each publish; operator edits columns O–W only.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      // ── Game identity (A–E, indices 0–4) ──────────────────────────────────────
      { name: "Game_ID",          index: 0,  type: "string", width: 160, readOnly: true,  filledBy: "MODULE_10", description: "Canonical game identifier. Format: YYYY/MM/DD-AWAY-HOME.", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Date",             index: 1,  type: "string", width: 100, readOnly: true,  filledBy: "MODULE_10", description: "Game date in YYYY-MM-DD format.", exampleValue: "2026-07-22" },
      { name: "Matchup",          index: 2,  type: "string", width: 120, readOnly: true,  filledBy: "MODULE_10", description: "AWAY @ HOME abbreviation pair.", exampleValue: "NYY @ BOS" },
      { name: "Target",           index: 3,  type: "string", width: 90,  readOnly: true,  filledBy: "MODULE_10", description: "Betting vehicle target. GAME_TOTAL for totals.", exampleValue: "GAME_TOTAL" },
      { name: "Opposing_Starter", index: 4,  type: "string", width: 140, readOnly: true,  filledBy: "MODULE_10", description: "Confirmed or probable opposing starting pitcher name.", exampleValue: "Gerrit Cole" },
      // ── Model signals (F–N, indices 5–13) — pipeline-maintained, never operator-set ──
      { name: "Truth_Family",      index: 5,  type: "string", width: 130, readOnly: true, filledBy: "MODULE_11", description: "RUNS_OVER | RUNS_UNDER | NO_MARKET | NO_EDGE.", exampleValue: "RUNS_OVER" },
      { name: "Truth_Score",       index: 6,  type: "number", width: 110, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Percentage of named evidence checks that passed.", exampleValue: "83.33" },
      { name: "Vehicle_Score",     index: 7,  type: "number", width: 115, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Absolute edge normalized to the existing 3.0-run STRONG_BUY boundary.", exampleValue: "66.67" },
      { name: "Stability_Score",   index: 8,  type: "number", width: 125, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Percentage of named lineup, source, and environment stability checks that passed.", exampleValue: "83.33" },
      { name: "Composite_Score",   index: 9,  type: "number", width: 125, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Weakest-link minimum of Truth, Vehicle, and Stability; diagnostic only.", exampleValue: "66.67" },
      { name: "Confirmation_Gate", index: 10, type: "string", width: 140, readOnly: true, filledBy: "MODULE_11", description: "TRUE only when the existing final authorization decision is CORE.", exampleValue: "TRUE" },
      { name: "Score_Decision",    index: 11, type: "string", width: 120, readOnly: true, filledBy: "MODULE_11", description: "BET | PASS | PENDING mirror of the fully gated final decision.", exampleValue: "PASS" },
      { name: "Score_Blockers",    index: 12, type: "string", width: 280, readOnly: true, filledBy: "MODULE_11", description: "Named failed evidence/stability checks and authorization blockers.", exampleValue: "LINEUPS_OFFICIAL; ENVIRONMENT_CERTAINTY" },
      { name: "Execution_Status",  index: 13, type: "string", width: 140, readOnly: true, filledBy: "MODULE_11", exampleValue: "blocked" },
      // ── Operator fields (O–W, indices 14–22) — never overwritten by pipeline after seeding ──
      { name: "Candidate_Vehicle",    index: 14, type: "string", width: 180, filledBy: "OPERATOR", description: "GAME_TOTAL, SPREAD, O3.5, U8.5, etc. Seeded by pipeline; operator may override.", exampleValue: "GAME_TOTAL" },
      { name: "Line",                 index: 15, type: "number", width: 80,  format: "0.0", filledBy: "OPERATOR", description: "O/U total from the operator's chosen book.", exampleValue: "8.5" },
      { name: "Odds",                 index: 16, type: "number", width: 80,  filledBy: "OPERATOR", description: "American odds for the Over side.", exampleValue: "-110" },
      { name: "Market_Available",     index: 17, type: "string", width: 130, filledBy: "OPERATOR", description: "TRUE when a tradeable line was found.", exampleValue: "TRUE" },
      { name: "Kill_Flag",            index: 18, type: "string", width: 90,  filledBy: "OPERATOR", description: "TRUE to suppress this game from authorization.", exampleValue: "FALSE" },
      { name: "Notes",                index: 19, type: "string", width: 220, filledBy: "OPERATOR", exampleValue: "" },
      { name: "Owner",                index: 20, type: "string", width: 90,  filledBy: "OPERATOR", description: "Pending until the operator claims the row.", exampleValue: "Pending" },
      { name: "Manual_Kill_Override", index: 21, type: "string", width: 160, filledBy: "OPERATOR", description: "Operator-set TRUE to permanently exclude this game.", exampleValue: "FALSE" },
      { name: "Model_Freeze_Reason",  index: 22, type: "string", width: 190, filledBy: "OPERATOR", description: "Reason string when the model decision is frozen against the pipeline default.", exampleValue: "" },
      // ── Pregame lock fields (X–AB, indices 23–27) — pipeline-maintained ──
      { name: "Market_Phase",                index: 23, type: "string", width: 110, readOnly: true, filledBy: "MODULE_10", description: "PREGAME | LIVE | FINAL — derived from MLB Stats API abstractGameState each publish.", exampleValue: "PREGAME" },
      { name: "Authoritative_Pregame_Total", index: 24, type: "number", width: 190, format: "0.0", readOnly: true, filledBy: "MODULE_10", description: "Line frozen at the moment Market_Phase first becomes LIVE or FINAL. Never overwritten after that. Module 11 prefers this over the live Line.", exampleValue: "8.5" },
      { name: "Authoritative_Over_Odds",     index: 25, type: "number", width: 170, readOnly: true, filledBy: "MODULE_10", description: "Over odds frozen at the same instant as Authoritative_Pregame_Total.", exampleValue: "-110" },
      { name: "Authoritative_Under_Odds",    index: 26, type: "number", width: 175, readOnly: true, filledBy: "MODULE_10", description: "Under odds frozen at pregame lock time. Defaults to -110 when source does not publish separately.", exampleValue: "-110" },
      { name: "Pregame_Line_Locked_TS",      index: 27, type: "string", width: 185, readOnly: true, filledBy: "MODULE_10", description: "ISO 8601 UTC timestamp when the pregame line was frozen. Null until lock occurs.", exampleValue: "2026-07-23T17:05:12.000Z" },
      // ── Market spread / moneyline (AC–AG, indices 28–32) — pipeline-maintained ──
      { name: "Away_Spread",      index: 28, type: "number", width: 110, format: "0.0", readOnly: true, filledBy: "MODULE_10", description: "Run-line point spread for the away team (+1.5 or -1.5).", exampleValue: "1.5" },
      { name: "Away_Spread_Odds", index: 29, type: "number", width: 130, readOnly: true, filledBy: "MODULE_10", description: "American odds for away team to cover the run line.", exampleValue: "-175" },
      { name: "Home_Spread_Odds", index: 30, type: "number", width: 130, readOnly: true, filledBy: "MODULE_10", description: "American odds for home team to cover the run line.", exampleValue: "+150" },
      { name: "Away_ML",          index: 31, type: "number", width: 100, readOnly: true, filledBy: "MODULE_10", description: "American moneyline for away team outright win.", exampleValue: "-130" },
      { name: "Home_ML",          index: 32, type: "number", width: 100, readOnly: true, filledBy: "MODULE_10", description: "American moneyline for home team outright win.", exampleValue: "+110" },
      // ── Board-lock status (AH = 33) — pipeline-maintained, finalized by module11 ──
      {
        name: "Board_Lock_Status",
        index: 33,
        type: "string",
        width: 150,
        readOnly: true,
        filledBy: "MODULE_11",
        description:
          "PRE_LOCK = board has not yet locked for this game (current time < cutoff). "
          + "LOCKED_IN = game was CORE when the board locked; stable but still downgradable. "
          + "LOCKED_OUT = game was NOT CORE when the board locked; blocked from any future promotion. "
          + "Lock cutoff = first pitch − BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH. "
          + "Seeded PRE_LOCK by module10; finalized by module11 on the first publish at or after the cutoff.",
        exampleValue: "LOCKED_OUT",
      },
    ],
  },

  {
    name: "SLATE_BOARD",
    description: "Decision output: CORE/NOT_CORE + confidence, based on projections vs lines.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "MODULE_11", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 160, readOnly: true, filledBy: "MODULE_11", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "MODULE_11", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "MODULE_11", exampleValue: "NYY" },
      { name: "Vehicle_Type", index: 4, type: "string", width: 150, readOnly: true, filledBy: "MODULE_11", description: "Game Total, Spread, etc.", exampleValue: "GAME_TOTAL" },
      { name: "Projected_Value", index: 5, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "From GAME_SUMMARY", exampleValue: "6.02" },
      { name: "Market_Line", index: 6, type: "number", width: 100, format: "0.0", readOnly: true, filledBy: "MODULE_11", description: "From SLATE_INPUT", exampleValue: "8.5" },
      { name: "Variance_from_Projection", index: 7, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Model − Market. Positive = OVER edge; negative = UNDER edge.", exampleValue: "-2.48" },
      { name: "Direction", index: 8, type: "string", width: 100, readOnly: true, filledBy: "MODULE_11", description: "OVER | UNDER | NONE — derived from sign of variance", exampleValue: "UNDER" },
      { name: "Decision", index: 9, type: "string", width: 100, readOnly: true, filledBy: "MODULE_11", description: "CORE or NO_CORE or PENDING. CORE = authorized bet; NO_CORE = blocked by eligibility gate.", exampleValue: "NO_CORE" },
      { name: "Confidence", index: 10, type: "percent", width: 110, format: "0%", readOnly: true, filledBy: "MODULE_11", description: "Based on variance magnitude", exampleValue: "0.35" },
      { name: "Expected_ROI", index: 11, type: "percent", width: 120, format: "0.0%", readOnly: true, filledBy: "MODULE_11", description: "If CORE: |variance| × 0.05. Always positive — direction tells you which side.", exampleValue: "0.124" },
      { name: "Edge_Strength", index: 12, type: "string", width: 130, readOnly: true, filledBy: "MODULE_11", description: "STRONG_BUY | BUY | LEAN — edge-strength metadata based on separation magnitude. Not an authorization label.", exampleValue: "BUY" },
      { name: "CORE_Blocker", index: 13, type: "string", width: 220, readOnly: true, filledBy: "MODULE_11", description: "Named reason game did not authorize. Empty for CORE. E.g. INSUFFICIENT_PROJECTION_SEPARATION, UNRESOLVED_STARTER.", exampleValue: "INSUFFICIENT_PROJECTION_SEPARATION" },
      { name: "Notes", index: 14, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
      // ── Prop market comparison fields (P–V, indices 15–21) — shadow mode ──
      // These are informational signals produced by module05e (Rotowire props scraper).
      // They must not influence CORE authorization until historical validation is complete.
      { name: "Starter_K_Market_Signal", index: 15, type: "string", width: 220, readOnly: true, filledBy: "MODULE_11", description: "Hard Rock K lines for away and home starter. Shape comparison only — not a suppression vote. Format: '{awayK} (U:odds/O:odds) | {homeK} (U:odds/O:odds)'", exampleValue: "7.5 (U:-145/O:+110) | 6.5 (U:-120/O:-110)" },
      { name: "Starter_ER_Market_Signal", index: 16, type: "string", width: 220, readOnly: true, filledBy: "MODULE_11", description: "Hard Rock ER lines for away and home starter. More directly relevant than K for run-scoring expectation, but does not account for bullpen or unearned runs. Format: '{awayER} (U:odds/O:odds) | {homeER} (U:odds/O:odds)'", exampleValue: "2.5 (U:-115/O:-115) | 2.5 (U:-155/O:+120)" },
      { name: "Lineup_TB_Coverage_Pct", index: 17, type: "number", width: 160, format: "0.0", readOnly: true, filledBy: "MODULE_11", description: "Percentage of the 18 lineup slots (9 per team × 2) for this game that have a posted Hard Rock total-bases line. Indicates prop market depth, not run-scoring direction.", exampleValue: "38.9" },
      { name: "Prop_Market_Direction", index: 18, type: "string", width: 160, readOnly: true, filledBy: "MODULE_11", description: "Direction implied by ER odds pricing (OVER | UNDER | MIXED | INSUFFICIENT_COVERAGE). Derived from which side is priced more expensively — not an additive run-total forecast.", exampleValue: "UNDER" },
      { name: "Prop_Market_Agreement", index: 19, type: "string", width: 180, readOnly: true, filledBy: "MODULE_11", description: "AGREES | MIXED | CONTRADICTS | INSUFFICIENT_COVERAGE — whether prop market direction aligns with Frostline's OVER/UNDER. Shadow mode: informational only.", exampleValue: "AGREES" },
      { name: "Prop_Market_Disagreement_Reason", index: 20, type: "string", width: 280, readOnly: true, filledBy: "MODULE_11", description: "Human-readable explanation when Prop_Market_Agreement is CONTRADICTS or MIXED. Empty for AGREES or INSUFFICIENT_COVERAGE.", exampleValue: "ER market implies UNDER (away ER: 2.5, home ER: 2.5); Frostline projects OVER" },
      { name: "Prop_Snapshot_TS", index: 21, type: "string", width: 185, readOnly: true, filledBy: "MODULE_11", description: "ISO 8601 UTC timestamp of when the Rotowire props page was fetched for this publish run.", exampleValue: "2026-07-24T13:42:11.000Z" },
      // ── Side derivative signals (W–Y, indices 22–24) — step-5 commissioning ──
      { name: "Side_Edge", index: 22, type: "number", width: 100, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "proj_run_diff + away_spread. Positive = model says away covers; negative = home covers.", exampleValue: "1.2" },
      { name: "Side_Direction", index: 23, type: "string", width: 100, readOnly: true, filledBy: "MODULE_11", description: "AWAY | HOME | NONE | NO_MARKET — direction the model favours on the run line.", exampleValue: "AWAY" },
      { name: "Side_Decision", index: 24, type: "string", width: 100, readOnly: true, filledBy: "MODULE_11", description: "CORE | NO_CORE | NO_MARKET — side authorization against the 1.5-edge threshold.", exampleValue: "NO_CORE" },
      // ── Starter quality derivatives (Z–AA, indices 25–26) ──
      { name: "Away_Starter_Quality", index: 25, type: "number", width: 155, format: "0.0000", readOnly: true, filledBy: "MODULE_11", description: "FIP + K-BB% composite factor for the away starter. 1.0 = league average; <1 = better than average.", exampleValue: "0.8923" },
      { name: "Home_Starter_Quality", index: 26, type: "number", width: 155, format: "0.0000", readOnly: true, filledBy: "MODULE_11", description: "FIP + K-BB% composite factor for the home starter. 1.0 = league average; <1 = better than average.", exampleValue: "1.1042" },
      // ── Over survival gate audit columns (AB–AG, indices 27–32) ──
      {
        name: "Baseball_Only_Projection",
        index: 27,
        type: "number",
        width: 175,
        format: "0.00",
        readOnly: true,
        filledBy: "MODULE_11",
        description: "starter_attack_runs + bullpen_continuation_runs: total projected runs from baseball factors only "
          + "(lineup-adjusted offense × pitcher quality, no park/weather). Non-null for OVER games with a market line. "
          + "An Over must clear the market line by ≥ 1.25 on this number alone.",
        exampleValue: "7.42",
      },
      {
        name: "Environment_Run_Adjustment",
        index: 28,
        type: "number",
        width: 185,
        format: "0.00",
        readOnly: true,
        filledBy: "MODULE_11",
        description: "Park × weather run contribution: projected_total − Baseball_Only_Projection. "
          + "Positive = environment boosted runs; negative = suppressed. Must not be the sole reason an Over clears the market line.",
        exampleValue: "0.62",
      },
      {
        name: "Survival_Floor",
        index: 29,
        type: "number",
        width: 140,
        format: "0.00",
        readOnly: true,
        filledBy: "MODULE_11",
        description: "Low-conversion stress floor: starter × 0.80 + bullpen × 0.75 + traffic × 0.70 + HR/XBH × 0.90. "
          + "Simulates a game where starters outperform, traffic doesn't convert, and extra-base damage is muted. "
          + "Must exceed the market line by ≥ 0.25 (Survival_Floor_Edge) for CORE authorization.",
        exampleValue: "6.84",
      },
      {
        name: "Survival_Floor_Edge",
        index: 30,
        type: "number",
        width: 155,
        format: "0.00",
        readOnly: true,
        filledBy: "MODULE_11",
        description: "Survival_Floor − Market_Line. Must be ≥ 0.25 for an Over to qualify as CORE. "
          + "Negative means the Over fails even the stress-tested floor.",
        exampleValue: "-0.16",
      },
      {
        name: "Survival_Check",
        index: 31,
        type: "string",
        width: 110,
        readOnly: true,
        filledBy: "MODULE_11",
        description: "PASS | FAIL | N_A. FAIL means the Over cannot reach CORE; Survival_Failure_Reason explains why. "
          + "N_A for UNDER, NONE, or PENDING games.",
        exampleValue: "FAIL",
      },
      {
        name: "Survival_Failure_Reason",
        index: 32,
        type: "string",
        width: 270,
        readOnly: true,
        filledBy: "MODULE_11",
        description: "Specific survival gate failure mode. One of: "
          + "ENVIRONMENT_DEPENDENT_OVER (baseball-only projection below market line), "
          + "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD (edge ≥ 0 but < 1.25), "
          + "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD (floor edge < 0.25), "
          + "COMPONENT_DATA_UNAVAILABLE (projection components missing from module09). "
          + "Empty for PASS or N_A.",
        exampleValue: "ENVIRONMENT_DEPENDENT_OVER",
      },
      // ── Board-lock status (AH = 33) ──
      {
        name: "Lock_Status",
        index: 33,
        type: "string",
        width: 130,
        readOnly: true,
        filledBy: "MODULE_11",
        description:
          "PRE_LOCK = before the lock cutoff (board open). "
          + "LOCKED_IN = game was already CORE when the board locked; operator can see it is stable. "
          + "LOCKED_OUT = game was NOT CORE at lock time; blocked from future CORE promotion. "
          + "Operator-visible signal: use this to distinguish stable picks from newly locked-out candidates.",
        exampleValue: "LOCKED_OUT",
      },
      { name: "Truth_Family", index: 34, type: "string", width: 130, readOnly: true, filledBy: "MODULE_11", exampleValue: "RUNS_OVER" },
      { name: "Truth_Score", index: 35, type: "number", width: 110, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Percent of named truth-evidence checks passed.", exampleValue: "83.33" },
      { name: "Vehicle_Score", index: 36, type: "number", width: 115, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Edge magnitude normalized to the existing STRONG_BUY boundary.", exampleValue: "66.67" },
      { name: "Stability_Score", index: 37, type: "number", width: 125, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Percent of named stability checks passed.", exampleValue: "83.33" },
      { name: "Composite_Score", index: 38, type: "number", width: 125, format: "0.00", readOnly: true, filledBy: "MODULE_11", description: "Weakest-link minimum; no weakness can be averaged away.", exampleValue: "66.67" },
      { name: "Confirmation_Gate", index: 39, type: "string", width: 140, readOnly: true, filledBy: "MODULE_11", exampleValue: "TRUE" },
      { name: "Execution_Status", index: 40, type: "string", width: 140, readOnly: true, filledBy: "MODULE_11", exampleValue: "authorized" },
      { name: "Score_Decision", index: 41, type: "string", width: 120, readOnly: true, filledBy: "MODULE_11", description: "BET | PASS | PENDING.", exampleValue: "PASS" },
      { name: "Score_Blockers", index: 42, type: "string", width: 320, readOnly: true, filledBy: "MODULE_11", exampleValue: "LINEUPS_OFFICIAL; BOARD_LOCKED_POST_CUTOFF" },
      { name: "Truth_Components", index: 43, type: "string", width: 420, readOnly: true, filledBy: "MODULE_11", description: "Named pass/fail trace for every Truth check.", exampleValue: "STARTERS_RESOLVED=PASS(...)" },
      { name: "Vehicle_Components", index: 44, type: "string", width: 420, readOnly: true, filledBy: "MODULE_11", description: "Projection, line, edge, survival, and lock trace.", exampleValue: "MARKET_LINE=8.5 | PROJECTED_TOTAL=10.5" },
      { name: "Stability_Components", index: 45, type: "string", width: 420, readOnly: true, filledBy: "MODULE_11", description: "Named pass/fail trace for every Stability check.", exampleValue: "LINEUPS_OFFICIAL=PASS(...)" },
      { name: "Environment_Certainty", index: 46, type: "string", width: 170, readOnly: true, filledBy: "MODULE_11", exampleValue: "HIGH" },
      { name: "Run_ID", index: 47, type: "string", width: 190, readOnly: true, filledBy: "MODULE_11", description: "Per-publish lineage identifier shared across every current board row.", exampleValue: "RUN_20260802..." },
      { name: "Model_Version", index: 48, type: "string", width: 260, readOnly: true, filledBy: "MODULE_11", description: "Decision trace contract version.", exampleValue: "DECISION_TRACE_V1_EXISTING_GATES" },
    ],
  },

  {
    name: "ACTIVE_BOARD_SNAPSHOT",
    description: "Filtered, live view: only CORE picks + decision history for this slate.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "FORMULA", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "NYY" },
      { name: "Vehicle", index: 4, type: "string", width: 200, readOnly: true, filledBy: "FORMULA", exampleValue: "GAME_TOTAL" },
      { name: "Model_Projection", index: 5, type: "number", width: 120, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "6.02" },
      { name: "Market_Line", index: 6, type: "number", width: 100, format: "0.0", readOnly: true, filledBy: "FORMULA", exampleValue: "8.5" },
      { name: "Edge", index: 7, type: "number", width: 90, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "Absolute value of variance. Always positive.", exampleValue: "2.48" },
      { name: "Direction", index: 8, type: "string", width: 100, readOnly: true, filledBy: "FORMULA", description: "OVER | UNDER | NONE", exampleValue: "UNDER" },
      { name: "Confidence", index: 9, type: "percent", width: 110, format: "0%", readOnly: true, filledBy: "FORMULA", exampleValue: "0.72" },
      { name: "Edge_Strength", index: 10, type: "string", width: 130, readOnly: true, filledBy: "FORMULA", description: "STRONG_BUY | BUY | LEAN — edge-strength metadata. Not an authorization label.", exampleValue: "STRONG_BUY" },
      { name: "Time_Added", index: 11, type: "date", width: 130, format: "mm/dd/yyyy hh:mm:ss", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026 09:00:00" },
      { name: "Status", index: 12, type: "string", width: 100, filledBy: "OPERATOR", description: "PENDING, PLACED, FILLED, WON, LOST, CANCELLED", exampleValue: "PENDING" },
      { name: "Placed_At", index: 13, type: "date", width: 130, format: "mm/dd/yyyy hh:mm:ss", filledBy: "OPERATOR", exampleValue: "" },
      { name: "Result", index: 14, type: "currency", width: 100, format: "+$#,##0", filledBy: "OPERATOR", exampleValue: "" },
      { name: "Notes", index: 15, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  // ─── BOARD_LOCK_STATE — authoritative per-game board-lock governance ────────
  {
    name: "BOARD_LOCK_STATE",
    description:
      "Authoritative per-game board-lock governance. "
      + "One row per game per slate day. "
      + "Module 11 writes pipeline fields (A–G, L); operator edits H–K to grant a named baseball exception.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      {
        name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy",
        readOnly: true, filledBy: "MODULE_11", exampleValue: "07/25/2026",
      },
      {
        name: "Game_ID", index: 1, type: "string", width: 170,
        readOnly: true, filledBy: "MODULE_11", exampleValue: "2026/07/25-NYY-BOS",
      },
      {
        name: "Scheduled_First_Pitch", index: 2, type: "string", width: 185,
        readOnly: true, filledBy: "MODULE_11",
        description: "ISO 8601 UTC scheduled game time from MLB Stats API. Used to compute Lock_Cutoff_TS.",
        exampleValue: "2026-07-25T18:07:00Z",
      },
      {
        name: "Lock_Cutoff_TS", index: 3, type: "string", width: 185,
        readOnly: true, filledBy: "MODULE_11",
        description:
          "ISO 8601 UTC timestamp at which this game's board lock fires. "
          + "= Scheduled_First_Pitch − BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH (default 2.0 h). "
          + "Blank when Scheduled_First_Pitch is unavailable.",
        exampleValue: "2026-07-25T16:07:00Z",
      },
      {
        name: "Lock_Status", index: 4, type: "string", width: 130,
        readOnly: true, filledBy: "MODULE_11",
        description:
          "PRE_LOCK = current time < Lock_Cutoff_TS; game is open for new CORE decisions. "
          + "LOCKED_IN = game was already CORE at lock time; stable but still downgradable. "
          + "LOCKED_OUT = game was NOT CORE at lock; blocked from future promotion "
          + "unless Late_Promotion_Authorized = TRUE and Late_Change_Reason is non-blank.",
        exampleValue: "LOCKED_OUT",
      },
      {
        name: "Pre_Lock_Decision", index: 5, type: "string", width: 150,
        readOnly: true, filledBy: "MODULE_11",
        description:
          "The game's CORE/NO_CORE/PENDING decision at the moment the board lock first fired. "
          + "Set once on the first publish at or after Lock_Cutoff_TS; never overwritten afterwards.",
        exampleValue: "NO_CORE",
      },
      {
        name: "Locked_TS", index: 6, type: "string", width: 185,
        readOnly: true, filledBy: "MODULE_11",
        description: "ISO 8601 UTC timestamp of the first publish at or after Lock_Cutoff_TS. Blank while PRE_LOCK.",
        exampleValue: "2026-07-25T16:09:43.000Z",
      },
      // ── Operator late-change fields (H–K) — must be filled to grant an exception ──
      {
        name: "Late_Change_Reason", index: 7, type: "string", width: 280,
        filledBy: "OPERATOR",
        description:
          "Named baseball reason for a post-lock CORE exception. "
          + "Must describe a substantive new baseball input: starter scratch, confirmed opener/bulk, "
          + "corrected starter identity, materially changed confirmed lineup, roof status change, or "
          + "unavailable high-leverage bullpen arms. "
          + "Odds movement, line movement, rounding, or ordinary recalculation do NOT qualify. "
          + "Must be non-blank for Late_Promotion_Authorized to have effect.",
        exampleValue: "Starter scratch — Cole replaced by Cortes (unofficial)",
      },
      {
        name: "Late_Change_Source", index: 8, type: "string", width: 200,
        filledBy: "OPERATOR",
        description: "Source of the late change (e.g. 'beat reporter @JonHeyman', 'team announcement', 'roster transaction wire').",
        exampleValue: "team announcement",
      },
      {
        name: "Late_Change_TS", index: 9, type: "string", width: 185,
        filledBy: "OPERATOR",
        description: "ISO 8601 UTC timestamp when the late change was recorded by the operator.",
        exampleValue: "2026-07-25T18:42:00Z",
      },
      {
        name: "Late_Promotion_Authorized", index: 10, type: "string", width: 185,
        filledBy: "OPERATOR",
        description:
          "Set to TRUE to authorize a post-lock CORE promotion for this game. "
          + "Effective only when Late_Change_Reason is also non-blank. "
          + "When TRUE + reason present: LOCKED_OUT is overridden and rawDecision is used; "
          + "all other gates (survival, eligibility) still apply.",
        exampleValue: "FALSE",
      },
      {
        name: "Last_Updated_TS", index: 11, type: "string", width: 185,
        readOnly: true, filledBy: "MODULE_11",
        description: "ISO 8601 UTC timestamp of the most recent module11 write to this row.",
        exampleValue: "2026-07-25T18:11:02.000Z",
      },
    ],
  },

  // ─── REFERENCE SECTION ──────────────────────────────────────────────────────
  {
    name: "SCHEMA_REFERENCE",
    description: "Data dictionary. Column definitions, formulas, data types. Auto-generated.",
    section: "REFERENCE",
    frozenRows: 1,
    columns: [
      { name: "Sheet_Name", index: 0, type: "string", width: 160, filledBy: "SYSTEM", exampleValue: "DAILY_MATCHUPS" },
      { name: "Section", index: 1, type: "string", width: 110, filledBy: "SYSTEM", exampleValue: "INPUT" },
      { name: "Column_Name", index: 2, type: "string", width: 180, filledBy: "SYSTEM", exampleValue: "Away_Pitcher_Role" },
      { name: "Column_Index", index: 3, type: "number", width: 90, format: "0", filledBy: "SYSTEM", exampleValue: "7" },
      { name: "Data_Type", index: 4, type: "string", width: 100, filledBy: "SYSTEM", exampleValue: "string" },
      { name: "Purpose", index: 5, type: "string", width: 280, filledBy: "SYSTEM", exampleValue: "CONVENTIONAL_STARTER, BULLPEN_GAME, OPENER, etc." },
      { name: "Number_Format", index: 6, type: "string", width: 120, filledBy: "SYSTEM", exampleValue: "" },
      { name: "Filled_By", index: 7, type: "string", width: 120, filledBy: "SYSTEM", exampleValue: "MODULE_08" },
      { name: "Read_Only", index: 8, type: "string", width: 80, filledBy: "SYSTEM", exampleValue: "NO" },
      { name: "Example_Value", index: 9, type: "string", width: 160, filledBy: "SYSTEM", exampleValue: "CONVENTIONAL_STARTER" },
    ],
  },

  // ─── META SECTION ───────────────────────────────────────────────────────────
  {
    name: "RUN_LOG",
    description: "Append-only pipeline run history. One row per Module 12 archival.",
    section: "META",
    frozenRows: 1,
    columns: [
      { name: "Run_Timestamp", index: 0, type: "date", width: 160, format: "mm/dd/yyyy hh:mm:ss", filledBy: "MODULE_12", exampleValue: "07/22/2026 09:12:18" },
      { name: "Date", index: 1, type: "date", width: 100, format: "mm/dd/yyyy", filledBy: "MODULE_12", exampleValue: "07/22/2026" },
      { name: "Bundle_Name", index: 2, type: "string", width: 140, filledBy: "MODULE_12", exampleValue: "2026-07-22_v01" },
      { name: "Pipeline_Status", index: 3, type: "string", width: 120, filledBy: "MODULE_12", exampleValue: "success" },
      { name: "Total_Games", index: 4, type: "number", width: 90, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "Validation_Status", index: 5, type: "string", width: 120, filledBy: "MODULE_12", exampleValue: "PASS" },
      { name: "Critical_Failures", index: 6, type: "number", width: 110, format: "0", filledBy: "MODULE_12", exampleValue: "0" },
      { name: "Warnings", index: 7, type: "number", width: 80, format: "0", filledBy: "MODULE_12", exampleValue: "0" },
      { name: "Pitchers_Resolved", index: 8, type: "number", width: 120, format: "0", filledBy: "MODULE_12", exampleValue: "34" },
      { name: "Pitchers_Total", index: 9, type: "number", width: 100, format: "0", filledBy: "MODULE_12", exampleValue: "34" },
      { name: "Weather_Live", index: 10, type: "number", width: 90, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "Weather_Fallback", index: 11, type: "number", width: 110, format: "0", filledBy: "MODULE_12", exampleValue: "0" },
      { name: "M08_Status", index: 12, type: "string", width: 100, filledBy: "MODULE_12", exampleValue: "success" },
      { name: "M08_Rows_DailyMatchups", index: 13, type: "number", width: 130, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "M08_Rows_TodayLineups", index: 14, type: "number", width: 130, format: "0", filledBy: "MODULE_12", exampleValue: "270" },
      { name: "M08_Rows_TeamForm", index: 15, type: "number", width: 120, format: "0", filledBy: "MODULE_12", exampleValue: "30" },
      { name: "M08_Rows_Bullpen", index: 16, type: "number", width: 110, format: "0", filledBy: "MODULE_12", exampleValue: "136" },
      { name: "M08_Rows_RunEnv", index: 17, type: "number", width: 110, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "M09_Status", index: 18, type: "string", width: 100, filledBy: "MODULE_12", exampleValue: "verified" },
      { name: "M09_IntegrationRows", index: 19, type: "number", width: 130, format: "0", filledBy: "MODULE_12", exampleValue: "35" },
      { name: "M09_SummaryRows", index: 20, type: "number", width: 120, format: "0", filledBy: "MODULE_12", exampleValue: "1" },
      { name: "M10_Status", index: 21, type: "string", width: 100, filledBy: "MODULE_12", exampleValue: "success" },
      { name: "M10_NewGames", index: 22, type: "number", width: 100, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "M10_UpdatedGames", index: 23, type: "number", width: 120, format: "0", filledBy: "MODULE_12", exampleValue: "0" },
      { name: "M11_Status", index: 24, type: "string", width: 100, filledBy: "MODULE_12", exampleValue: "success" },
      { name: "M11_CoreCount", index: 25, type: "number", width: 100, format: "0", filledBy: "MODULE_12", exampleValue: "3" },
      { name: "M11_NotCoreCount", index: 26, type: "number", width: 120, format: "0", filledBy: "MODULE_12", exampleValue: "14" },
      { name: "M11_SlateBoardRows", index: 27, type: "number", width: 130, format: "0", filledBy: "MODULE_12", exampleValue: "17" },
      { name: "Errors", index: 28, type: "string", width: 300, filledBy: "MODULE_12", exampleValue: "[]" },
      { name: "Schema_Version",                     index: 29, type: "number", width: 110, format: "0",   filledBy: "MODULE_12", description: "WORKBOOK_SCHEMA_VERSION that produced this row", exampleValue: "11" },
      // ── Statcast preview observability (cols AE–AL, indices 30–37) ─────────
      { name: "Statcast_Preview_Status",                    index: 30, type: "string", width: 155,               filledBy: "MODULE_12", description: "success | partial | failure | skipped", exampleValue: "partial" },
      { name: "Statcast_Preview_Games_Expected",            index: 31, type: "number", width: 195, format: "0",   filledBy: "MODULE_12", description: "Total games on the slate that a preview was attempted for", exampleValue: "15" },
      { name: "Statcast_Preview_Games_Available",           index: 32, type: "number", width: 200, format: "0",   filledBy: "MODULE_12", description: "Games where Preview_Availability = AVAILABLE", exampleValue: "13" },
      { name: "Statcast_Preview_Games_Parsed",              index: 33, type: "number", width: 185, format: "0",   filledBy: "MODULE_12", description: "Games successfully parsed (same as Available in Phase 1)", exampleValue: "13" },
      { name: "Statcast_Preview_Games_Missing",             index: 34, type: "number", width: 185, format: "0",   filledBy: "MODULE_12", description: "NOT_PUBLISHED + NOT_FOUND + STALE", exampleValue: "1" },
      { name: "Statcast_Preview_Games_Failed",              index: 35, type: "number", width: 180, format: "0",   filledBy: "MODULE_12", description: "SOURCE_UNAVAILABLE + PARSE_FAILED + UNSUPPORTED_FORMAT", exampleValue: "1" },
      { name: "Statcast_Preview_Stale_Count",               index: 36, type: "number", width: 175, format: "0",   filledBy: "MODULE_12", description: "Games where Preview_Availability = STALE", exampleValue: "0" },
      { name: "Statcast_Preview_Identity_Mismatch_Count",   index: 37, type: "number", width: 235, format: "0",   filledBy: "MODULE_12", description: "Games where Preview_Availability = IDENTITY_MISMATCH", exampleValue: "0" },
    ],
  },

  // ── Shadow validation / historical replay ────────────────────────────────────

  {
    name: "SHADOW_VALIDATION",
    description: "Per-game comparison of repaired projection vs legacy (pre-repair) projection. Written by module12s after every full-pipeline publish. Shadow mode only — does not affect CORE authorization.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",                       index: 0,  type: "string",  width: 90,  filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",                    index: 1,  type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24_NYY@BOS" },
      { name: "Away_Team",                  index: 2,  type: "string",  width: 80,  filledBy: "MODULE_09", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",                  index: 3,  type: "string",  width: 80,  filledBy: "MODULE_09", readOnly: true, exampleValue: "BOS" },
      { name: "Away_Pitcher",               index: 4,  type: "string",  width: 140, filledBy: "MODULE_09", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "Home_Pitcher",               index: 5,  type: "string",  width: 140, filledBy: "MODULE_09", readOnly: true, exampleValue: "Brayan Bello" },
      { name: "Repaired_Projected_Total",   index: 6,  type: "number",  width: 175, format: "0.00", filledBy: "MODULE_09", readOnly: true, description: "mod09 repaired model (65%L30+35%L10 offense, park × weather multiplier)", exampleValue: "8.45" },
      { name: "Legacy_Projected_Total",     index: 7,  type: "number",  width: 170, format: "0.00", filledBy: "MODULE_09", readOnly: true, description: "Reconstructed pre-repair model (L30-only offense, weather-only multiplier). Derived via ratio-scaling from repaired projections using audit columns.", exampleValue: "7.82" },
      { name: "Delta_Repaired_Minus_Legacy",index: 8,  type: "number",  width: 195, format: "0.00", filledBy: "MODULE_09", readOnly: true, description: "Repaired − Legacy. Positive = repaired projects higher.", exampleValue: "0.63" },
      { name: "Away_Offense_Source",        index: 9,  type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "BLENDED" },
      { name: "Home_Offense_Source",        index: 10, type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "L30_ONLY" },
      { name: "Away_L30_Rate",              index: 11, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.680" },
      { name: "Home_L30_Rate",              index: 12, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.320" },
      { name: "Away_L10_Rate",              index: 13, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "5.100" },
      { name: "Home_L10_Rate",              index: 14, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "" },
      { name: "Away_Offense_Rate_Used",     index: 15, type: "number",  width: 165, format: "0.000", filledBy: "MODULE_09", readOnly: true, description: "Blended rate used in repaired model", exampleValue: "4.877" },
      { name: "Home_Offense_Rate_Used",     index: 16, type: "number",  width: 165, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.320" },
      { name: "Legacy_Multiplier",          index: 17, type: "number",  width: 145, format: "0.0000", filledBy: "MODULE_09", readOnly: true, description: "Weather-only multiplier. Park treated as 1.0 in legacy model.", exampleValue: "1.0050" },
      { name: "Park_Multiplier",            index: 18, type: "number",  width: 130, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0800" },
      { name: "Weather_Multiplier",         index: 19, type: "number",  width: 140, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0050" },
      { name: "Repaired_Multiplier",        index: 20, type: "number",  width: 150, format: "0.0000", filledBy: "MODULE_09", readOnly: true, description: "Park × weather (combined) used in repaired model", exampleValue: "1.0854" },
      { name: "Park_Source_Status",         index: 21, type: "string",  width: 175, filledBy: "MODULE_09", readOnly: true, exampleValue: "VENUE_FACTOR_USED" },
      { name: "Snapshot_TS",                index: 22, type: "string",  width: 200, filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24T10:00:00.000Z" },
    ],
  },

  {
    name: "REPLAY_RESULTS",
    description: "Date-anchored historical baseline-versus-candidate replay written by module13, including the shared environment resolver and explicit historical-weather provenance.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: HISTORICAL_REPLAY_COLUMNS.map((name, index) => ({
      name,
      index,
      type: HISTORICAL_REPLAY_STRING_COLUMNS.has(index) ? "string" as const : "number" as const,
      width: index === 1 ? 180 : 145,
      format: HISTORICAL_REPLAY_STRING_COLUMNS.has(index) ? undefined : "0.000",
      filledBy: "MODULE_13" as const,
      readOnly: true,
    })),
  },

  {
    name: "PROJECTION_REPLAY",
    description: "Frozen-published settlement replay. Module14 upserts one row per completed game from VEHICLE_LOG without reconstructing the pregame projection.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Replay_Date",          index: 0,  type: "string",  width: 90,  filledBy: "MODULE_12", readOnly: true, exampleValue: "2026-07-20" },
      { name: "Game_ID",              index: 1,  type: "string",  width: 160, filledBy: "MODULE_12", readOnly: true, exampleValue: "2026-07-20_NYY@BOS" },
      { name: "Away_Team",            index: 2,  type: "string",  width: 80,  filledBy: "MODULE_12", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",            index: 3,  type: "string",  width: 80,  filledBy: "MODULE_12", readOnly: true, exampleValue: "BOS" },
      { name: "Actual_Total",         index: 4,  type: "number",  width: 100, format: "0", filledBy: "MODULE_12", readOnly: true, exampleValue: "7" },
      { name: "Legacy_Projected",     index: 5,  type: "number",  width: 140, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "L30-only offense, park=1.0, weather=1.0", exampleValue: "8.32" },
      { name: "L30_Park_Projected",   index: 6,  type: "number",  width: 150, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "L30-only offense + park factor", exampleValue: "8.98" },
      { name: "L10_Park_Projected",   index: 7,  type: "number",  width: 150, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "L10-actual offense + park factor", exampleValue: "9.14" },
      { name: "Blend_Projected",      index: 8,  type: "number",  width: 140, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "65%L30+35%L10 offense, park=1.0", exampleValue: "8.55" },
      { name: "Blend_Park_Projected", index: 9,  type: "number",  width: 160, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "65%L30+35%L10 offense + park factor — current repaired candidate", exampleValue: "9.23" },
      { name: "Legacy_Error",         index: 10, type: "number",  width: 120, format: "0.00", filledBy: "MODULE_12", readOnly: true, description: "Projected − Actual. Positive = overprojection.", exampleValue: "1.32" },
      { name: "L30_Park_Error",       index: 11, type: "number",  width: 125, format: "0.00", filledBy: "MODULE_12", readOnly: true, exampleValue: "1.98" },
      { name: "L10_Park_Error",       index: 12, type: "number",  width: 125, format: "0.00", filledBy: "MODULE_12", readOnly: true, exampleValue: "2.14" },
      { name: "Blend_Error",          index: 13, type: "number",  width: 120, format: "0.00", filledBy: "MODULE_12", readOnly: true, exampleValue: "1.55" },
      { name: "Blend_Park_Error",     index: 14, type: "number",  width: 140, format: "0.00", filledBy: "MODULE_12", readOnly: true, exampleValue: "2.23" },
      { name: "Away_L30_Rate",        index: 15, type: "number",  width: 115, format: "0.000", filledBy: "MODULE_12", readOnly: true, exampleValue: "4.680" },
      { name: "Home_L30_Rate",        index: 16, type: "number",  width: 115, format: "0.000", filledBy: "MODULE_12", readOnly: true, exampleValue: "4.320" },
      { name: "Away_L10_Rate",        index: 17, type: "number",  width: 115, format: "0.000", filledBy: "MODULE_12", readOnly: true, exampleValue: "5.100" },
      { name: "Home_L10_Rate",        index: 18, type: "number",  width: 115, format: "0.000", filledBy: "MODULE_12", readOnly: true, exampleValue: "" },
      { name: "Away_Offense_Source",  index: 19, type: "string",  width: 155, filledBy: "MODULE_12", readOnly: true, exampleValue: "BLENDED" },
      { name: "Home_Offense_Source",  index: 20, type: "string",  width: 155, filledBy: "MODULE_12", readOnly: true, exampleValue: "L30_ONLY" },
      { name: "Park_Runs_Pct",                  index: 21, type: "number", width: 110, format: "0.0",    filledBy: "MODULE_13", readOnly: true, exampleValue: "8" },
      { name: "Park_Multiplier",                index: 22, type: "number", width: 125, format: "0.0000", filledBy: "MODULE_13", readOnly: true, exampleValue: "1.0800" },
      { name: "Park_Source_Status",             index: 23, type: "string", width: 175,                   filledBy: "MODULE_13", readOnly: true, description: "VENUE_FACTOR_USED | MISSING_PARK_DATA", exampleValue: "VENUE_FACTOR_USED" },
      { name: "Away_Starter_Quality",           index: 24, type: "number", width: 165, format: "0.000",  filledBy: "MODULE_13", readOnly: true, description: "Away starter quality factor (FIP-derived) at replay time.", exampleValue: "0.920" },
      { name: "Home_Starter_Quality",           index: 25, type: "number", width: 165, format: "0.000",  filledBy: "MODULE_13", readOnly: true, description: "Home starter quality factor (FIP-derived) at replay time.", exampleValue: "0.950" },
      { name: "Blend_Park_Pitcher_Projected",   index: 26, type: "number", width: 200, format: "0.00",   filledBy: "MODULE_13", readOnly: true, description: "BLEND_PARK variant with FIP-derived starter quality factor applied. Informational — not used in live projection.", exampleValue: "8.98" },
      { name: "Blend_Park_Pitcher_Error",       index: 27, type: "number", width: 185, format: "0.00",   filledBy: "MODULE_13", readOnly: true, description: "Blend_Park_Pitcher_Projected − Actual_Total.", exampleValue: "1.98" },
      { name: "Market_Line",                    index: 28, type: "number", width: 115, format: "0.0",    filledBy: "MODULE_13", readOnly: true, description: "O/U market line for this game at replay time. Null when unavailable.", exampleValue: "8.5" },
      { name: "Edge_BLEND_PARK_PITCHER",        index: 29, type: "number", width: 185, format: "0.00",   filledBy: "MODULE_13", readOnly: true, description: "Blend_Park_Pitcher_Projected − Market_Line. Positive = projected Over.", exampleValue: "0.48" },
      { name: "Replay_Run_TS",                  index: 30, type: "string", width: 200,                   filledBy: "MODULE_13", readOnly: true, description: "ISO UTC timestamp when this replay row was written.", exampleValue: "2026-07-24T18:00:00.000Z" },
    ],
  },

  {
    name: "REPLAY_METRICS",
    description: "Per-variant aggregate metrics from the most recent historical replay run. One row per variant (5 rows). Cleared and rewritten on each replay.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Variant",           index: 0, type: "string",  width: 140, filledBy: "MODULE_12", readOnly: true, description: "LEGACY | L30_PARK | L10_PARK | BLEND | BLEND_PARK", exampleValue: "BLEND_PARK" },
      { name: "Games_Count",       index: 1, type: "number",  width: 100, format: "0",    filledBy: "MODULE_12", readOnly: true, exampleValue: "280" },
      { name: "MAE",               index: 2, type: "number",  width: 80,  format: "0.000", filledBy: "MODULE_12", readOnly: true, description: "Mean absolute error (projected − actual)", exampleValue: "2.140" },
      { name: "Median_AE",         index: 3, type: "number",  width: 90,  format: "0.000", filledBy: "MODULE_12", readOnly: true, exampleValue: "1.720" },
      { name: "Bias",              index: 4, type: "number",  width: 80,  format: "0.000", filledBy: "MODULE_12", readOnly: true, description: "Mean(projected − actual). Positive = systematic overprojection.", exampleValue: "0.340" },
      { name: "Miss_4Plus_Pct",    index: 5, type: "number",  width: 115, format: "0.0", filledBy: "MODULE_12", readOnly: true, description: "% of games where |error| ≥ 4 runs", exampleValue: "18.2" },
      { name: "Overproject_Pct",   index: 6, type: "number",  width: 120, format: "0.0", filledBy: "MODULE_12", readOnly: true, exampleValue: "55.7" },
      { name: "Underproject_Pct",  index: 7, type: "number",  width: 125, format: "0.0", filledBy: "MODULE_12", readOnly: true, exampleValue: "44.3" },
      { name: "Replay_Run_TS",     index: 8, type: "string",  width: 200, filledBy: "MODULE_12", readOnly: true, exampleValue: "2026-07-24T18:00:00.000Z" },
    ],
  },

  // ── Live accumulation + monitoring sheets (created by one-off scripts) ────────

  {
    name: "SHADOW_HISTORY",
    description: "Append-only accumulation of every shadow-validation row. Same columns as SHADOW_VALIDATION. Written by module12s after every publish; never cleared.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",                        index: 0,  type: "string",  width: 90,  filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",                     index: 1,  type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24_NYY@BOS" },
      { name: "Away_Team",                   index: 2,  type: "string",  width: 80,  filledBy: "MODULE_09", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",                   index: 3,  type: "string",  width: 80,  filledBy: "MODULE_09", readOnly: true, exampleValue: "BOS" },
      { name: "Away_Pitcher",                index: 4,  type: "string",  width: 140, filledBy: "MODULE_09", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "Home_Pitcher",                index: 5,  type: "string",  width: 140, filledBy: "MODULE_09", readOnly: true, exampleValue: "Brayan Bello" },
      { name: "Repaired_Projected_Total",    index: 6,  type: "number",  width: 175, format: "0.00", filledBy: "MODULE_09", readOnly: true, exampleValue: "8.45" },
      { name: "Legacy_Projected_Total",      index: 7,  type: "number",  width: 170, format: "0.00", filledBy: "MODULE_09", readOnly: true, exampleValue: "7.82" },
      { name: "Delta_Repaired_Minus_Legacy", index: 8,  type: "number",  width: 195, format: "0.00", filledBy: "MODULE_09", readOnly: true, exampleValue: "0.63" },
      { name: "Away_Offense_Source",         index: 9,  type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "BLENDED" },
      { name: "Home_Offense_Source",         index: 10, type: "string",  width: 160, filledBy: "MODULE_09", readOnly: true, exampleValue: "L30_ONLY" },
      { name: "Away_L30_Rate",               index: 11, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.680" },
      { name: "Home_L30_Rate",               index: 12, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.320" },
      { name: "Away_L10_Rate",               index: 13, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "5.100" },
      { name: "Home_L10_Rate",               index: 14, type: "number",  width: 120, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "" },
      { name: "Away_Offense_Rate_Used",      index: 15, type: "number",  width: 165, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.877" },
      { name: "Home_Offense_Rate_Used",      index: 16, type: "number",  width: 165, format: "0.000", filledBy: "MODULE_09", readOnly: true, exampleValue: "4.320" },
      { name: "Legacy_Multiplier",           index: 17, type: "number",  width: 145, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0050" },
      { name: "Park_Multiplier",             index: 18, type: "number",  width: 130, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0800" },
      { name: "Weather_Multiplier",          index: 19, type: "number",  width: 140, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0050" },
      { name: "Repaired_Multiplier",         index: 20, type: "number",  width: 150, format: "0.0000", filledBy: "MODULE_09", readOnly: true, exampleValue: "1.0854" },
      { name: "Park_Source_Status",          index: 21, type: "string",  width: 175, filledBy: "MODULE_09", readOnly: true, exampleValue: "VENUE_FACTOR_USED" },
      { name: "Snapshot_TS",                 index: 22, type: "string",  width: 200, filledBy: "MODULE_09", readOnly: true, exampleValue: "2026-07-24T10:00:00.000Z" },
    ],
  },

  {
    name: "SHADOW_OUTCOMES",
    description: "Settlement log with one row per game. Module14 records the frozen projection, final score, and official pitcher chain; reruns backfill incomplete provenance without duplicating game IDs.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",                     index: 0,  type: "string", width: 90,  filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",                  index: 1,  type: "string", width: 160, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-07-24_NYY@BOS" },
      { name: "Away_Team",                index: 2,  type: "string", width: 80,  filledBy: "MODULE_14", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",                index: 3,  type: "string", width: 80,  filledBy: "MODULE_14", readOnly: true, exampleValue: "BOS" },
      { name: "Repaired_Projected_Total", index: 4,  type: "number", width: 175, format: "0.00", filledBy: "MODULE_14", readOnly: true, description: "Projection from SHADOW_HISTORY (repaired model)", exampleValue: "8.45" },
      { name: "Actual_Total",             index: 5,  type: "number", width: 100, format: "0",    filledBy: "MODULE_14", readOnly: true, exampleValue: "7" },
      { name: "Error",                    index: 6,  type: "number", width: 90,  format: "0.00", filledBy: "MODULE_14", readOnly: true, description: "Projected − Actual. Positive = overprojection.", exampleValue: "1.45" },
      { name: "Abs_Error",                index: 7,  type: "number", width: 90,  format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "1.45" },
      { name: "Park_Source_Status",       index: 8,  type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, exampleValue: "VENUE_FACTOR_USED" },
      { name: "Away_Offense_Source",      index: 9,  type: "string", width: 160, filledBy: "MODULE_14", readOnly: true, exampleValue: "BLENDED" },
      { name: "Home_Offense_Source",      index: 10, type: "string", width: 160, filledBy: "MODULE_14", readOnly: true, exampleValue: "L30_ONLY" },
      { name: "Settlement_TS",            index: 11, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-07-25T02:00:00.000Z" },
      { name: "Frozen_Published_Total",   index: 12, type: "number", width: 175, format: "0.00", filledBy: "MODULE_14", readOnly: true, description: "Exact packet projection frozen in VEHICLE_LOG before first pitch", exampleValue: "8.45" },
      { name: "Frozen_Error",             index: 13, type: "number", width: 100, format: "0.00", filledBy: "MODULE_14", readOnly: true, description: "Frozen_Published_Total minus Actual_Total", exampleValue: "1.45" },
      { name: "Frozen_Abs_Error",         index: 14, type: "number", width: 110, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "1.45" },
      { name: "Frozen_Projection_Source", index: 15, type: "string", width: 190, filledBy: "MODULE_14", readOnly: true, exampleValue: "FROZEN_VEHICLE_LOG" },
      { name: "Repaired_Minus_Frozen",    index: 16, type: "number", width: 165, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "0.10" },
      { name: "Frozen_Market_Line",       index: 17, type: "number", width: 130, format: "0.0", filledBy: "MODULE_14", readOnly: true, exampleValue: "8.5" },
      { name: "Settlement_Market_Line",   index: 18, type: "number", width: 150, format: "0.0", filledBy: "MODULE_14", readOnly: true, exampleValue: "8.5" },
      { name: "Frozen_Ticket_Result",     index: 19, type: "string", width: 145, filledBy: "MODULE_14", readOnly: true, exampleValue: "WIN" },
      { name: "Settlement_Ticket_Result", index: 20, type: "string", width: 165, filledBy: "MODULE_14", readOnly: true, exampleValue: "WIN" },
      { name: "Projection_Audit_Status",  index: 21, type: "string", width: 230, filledBy: "MODULE_14", readOnly: true, exampleValue: "MATCHES_PUBLISHED" },
      { name: "Projected_Away_Starter",   index: 22, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Last pregame starter snapshot", exampleValue: "Gerrit Cole" },
      { name: "Projected_Home_Starter",   index: 23, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Last pregame starter snapshot", exampleValue: "Brayan Bello" },
      { name: "Actual_Away_Starter",      index: 24, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Official MLB boxscore starter", exampleValue: "Gerrit Cole" },
      { name: "Actual_Home_Starter",      index: 25, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Official MLB boxscore starter", exampleValue: "Brayan Bello" },
      { name: "Away_Starter_Match_Status", index: 26, type: "string", width: 175, filledBy: "MODULE_14", readOnly: true, description: "MATCH, MISMATCH, or UNRESOLVED", exampleValue: "MATCH" },
      { name: "Home_Starter_Match_Status", index: 27, type: "string", width: 175, filledBy: "MODULE_14", readOnly: true, description: "MATCH, MISMATCH, or UNRESOLVED", exampleValue: "MATCH" },
      { name: "Away_Bulk_Pitcher",        index: 28, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Most-used away non-starter by outs recorded", exampleValue: "Nick Burdi" },
      { name: "Home_Bulk_Pitcher",        index: 29, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, description: "Most-used home non-starter by outs recorded", exampleValue: "Josh Winckowski" },
      { name: "Away_Pitcher_Chain",       index: 30, type: "string", width: 360, filledBy: "MODULE_14", readOnly: true, description: "Official appearance order with innings", exampleValue: "Gerrit Cole (6.0 IP) > Luke Weaver (1.0 IP)" },
      { name: "Home_Pitcher_Chain",       index: 31, type: "string", width: 360, filledBy: "MODULE_14", readOnly: true, description: "Official appearance order with innings", exampleValue: "Brayan Bello (5.0 IP) > Brennan Bernardino (1.0 IP)" },
      { name: "Pitcher_Provenance_Status", index: 32, type: "string", width: 190, filledBy: "MODULE_14", readOnly: true, description: "COMPLETE, PARTIAL, or UNAVAILABLE", exampleValue: "COMPLETE" },
    ],
  },

  {
    name: "REGRESSION_REPORT",
    description: "Per-window performance summary computed from SHADOW_OUTCOMES. Overwritten on each run. Written by module15.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Window",       index: 0,  type: "string", width: 80,  filledBy: "MODULE_15", readOnly: true, description: "7d | 30d | ytd | all", exampleValue: "30d" },
      { name: "N_Games",      index: 1,  type: "number", width: 80,  format: "0",     filledBy: "MODULE_15", readOnly: true, exampleValue: "87" },
      { name: "MAE",          index: 2,  type: "number", width: 80,  format: "0.000", filledBy: "MODULE_15", readOnly: true, exampleValue: "3.662" },
      { name: "Median_AE",    index: 3,  type: "number", width: 90,  format: "0.000", filledBy: "MODULE_15", readOnly: true, exampleValue: "3.210" },
      { name: "Bias",         index: 4,  type: "number", width: 80,  format: "0.000", filledBy: "MODULE_15", readOnly: true, description: "Mean(proj − actual). Positive = systematic overprojection.", exampleValue: "0.022" },
      { name: "Over_Pct",     index: 5,  type: "number", width: 90,  format: "0.0",   filledBy: "MODULE_15", readOnly: true, exampleValue: "51.7" },
      { name: "Under_Pct",    index: 6,  type: "number", width: 90,  format: "0.0",   filledBy: "MODULE_15", readOnly: true, exampleValue: "48.3" },
      { name: "Miss_4Plus_Pct", index: 7, type: "number", width: 110, format: "0.0",  filledBy: "MODULE_15", readOnly: true, description: "% of games where |error| ≥ 4 runs", exampleValue: "38.2" },
      { name: "MAE_Alert",    index: 8,  type: "string", width: 90,  filledBy: "MODULE_15", readOnly: true, description: "YES when MAE > 4.2", exampleValue: "NO" },
      { name: "Bias_Alert",   index: 9,  type: "string", width: 90,  filledBy: "MODULE_15", readOnly: true, description: "YES when |bias| > 0.20", exampleValue: "NO" },
      { name: "Miss_Alert",   index: 10, type: "string", width: 90,  filledBy: "MODULE_15", readOnly: true, description: "YES when miss_4plus > 45%", exampleValue: "NO" },
      { name: "Report_TS",    index: 11, type: "string", width: 200, filledBy: "MODULE_15", readOnly: true, exampleValue: "2026-07-25T08:00:00.000Z" },
    ],
  },

  {
    name: "MONOTONICITY",
    description: "Edge-tier hit-rate analysis written by module15. Joins VEHICLE_LOG (prediction-time market line + direction) with SHADOW_OUTCOMES. Tests whether higher |proj − line| edge correlates with higher directional hit rate. Separate OVER and UNDER sections. Overwritten on each regression run.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Direction",              index: 0,  type: "string", width: 90,  filledBy: "MODULE_15", readOnly: true, description: "OVER | UNDER | OVERALL — the directional bucket this row belongs to.", exampleValue: "OVER" },
      { name: "Analysis_Type",          index: 1,  type: "string", width: 110, filledBy: "MODULE_15", readOnly: true, description: "FIXED_TIER | QUINTILE | SUMMARY | VERDICT", exampleValue: "FIXED_TIER" },
      { name: "Tier",                   index: 2,  type: "string", width: 150, filledBy: "MODULE_15", readOnly: true, description: "Tier label, e.g. '2.00–2.49', 'Q3 (2.10–2.61)', or verdict string for summary rows.", exampleValue: "2.00–2.49" },
      { name: "Edge_Min",               index: 3,  type: "number", width: 90,  format: "0.00",  filledBy: "MODULE_15", readOnly: true, description: "|proj − market_line| lower bound (inclusive). -999 for first quintile.", exampleValue: "2.00" },
      { name: "Edge_Max",               index: 4,  type: "string", width: 90,  filledBy: "MODULE_15", readOnly: true, description: "|proj − market_line| upper bound (exclusive). '∞' for the 3.00+ tier.", exampleValue: "2.50" },
      { name: "N_Games",                index: 5,  type: "number", width: 80,  format: "0",     filledBy: "MODULE_15", readOnly: true, exampleValue: "18" },
      { name: "N_Hits",                 index: 6,  type: "number", width: 70,  format: "0",     filledBy: "MODULE_15", readOnly: true, description: "Games where the direction was correct (push excluded).", exampleValue: "11" },
      { name: "N_Pushes",               index: 7,  type: "number", width: 80,  format: "0",     filledBy: "MODULE_15", readOnly: true, description: "Games where actual_total = market_line (excluded from hit rate).", exampleValue: "1" },
      { name: "Hit_Rate_Pct",           index: 8,  type: "number", width: 110, format: "0.0",   filledBy: "MODULE_15", readOnly: true, description: "Hits / (N_Games − N_Pushes) × 100. OVER: actual > line; UNDER: actual < line.", exampleValue: "61.1" },
      { name: "MAE",                    index: 9,  type: "number", width: 80,  format: "0.000", filledBy: "MODULE_15", readOnly: true, exampleValue: "3.120" },
      { name: "Median_AE",              index: 10, type: "number", width: 90,  format: "0.000", filledBy: "MODULE_15", readOnly: true, exampleValue: "2.900" },
      { name: "Bias",                   index: 11, type: "number", width: 80,  format: "0.000", filledBy: "MODULE_15", readOnly: true, description: "Mean(proj − actual). Positive = systematic overprojection.", exampleValue: "1.820" },
      { name: "Hit_Monotone_vs_Prior",  index: 12, type: "string", width: 185, filledBy: "MODULE_15", readOnly: true, description: "PASS | FAIL | N/A | INSUFFICIENT_SAMPLE. PASS if hit_rate_pct ≥ prior tier's and both n ≥ 75.", exampleValue: "PASS" },
      { name: "MAE_Monotone_vs_Prior",  index: 13, type: "string", width: 185, filledBy: "MODULE_15", readOnly: true, description: "PASS | FAIL | N/A | INSUFFICIENT_SAMPLE. PASS if MAE ≤ prior tier's and both n ≥ 75.", exampleValue: "PASS" },
      { name: "Report_TS",              index: 14, type: "string", width: 200, filledBy: "MODULE_15", readOnly: true, exampleValue: "2026-07-25T08:00:00.000Z" },
    ],
  },

  {
    name: "STARTER_AUDIT",
    description: "Per-pitcher projection accuracy from settled outcomes. Overwritten on each run. Written by module16.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Pitcher",         index: 0, type: "string", width: 160, filledBy: "MODULE_16", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "N_Games",         index: 1, type: "number", width: 80,  format: "0",     filledBy: "MODULE_16", readOnly: true, exampleValue: "12" },
      { name: "MAE",             index: 2, type: "number", width: 80,  format: "0.000", filledBy: "MODULE_16", readOnly: true, exampleValue: "3.420" },
      { name: "Bias",            index: 3, type: "number", width: 80,  format: "0.000", filledBy: "MODULE_16", readOnly: true, description: "Positive = systematically overprojected when this starter pitches.", exampleValue: "-0.120" },
      { name: "Over_Pct",        index: 4, type: "number", width: 90,  format: "0.0",   filledBy: "MODULE_16", readOnly: true, exampleValue: "41.7" },
      { name: "Under_Pct",       index: 5, type: "number", width: 90,  format: "0.0",   filledBy: "MODULE_16", readOnly: true, exampleValue: "58.3" },
      { name: "Miss_4Plus_Pct",  index: 6, type: "number", width: 110, format: "0.0",   filledBy: "MODULE_16", readOnly: true, exampleValue: "33.3" },
      { name: "Bias_Direction",  index: 7, type: "string", width: 120, filledBy: "MODULE_16", readOnly: true, description: "OVER | UNDER | NEUTRAL. Flagged when |bias| > 0.5.", exampleValue: "NEUTRAL" },
      { name: "First_Date",      index: 8, type: "string", width: 100, filledBy: "MODULE_16", readOnly: true, exampleValue: "2026-04-25" },
      { name: "Last_Date",       index: 9, type: "string", width: 100, filledBy: "MODULE_16", readOnly: true, exampleValue: "2026-07-24" },
    ],
  },

  {
    name: "VEHICLE_LOG",
    description: "Append-only per-game vehicle decision log. Written by module17 (phase 1) after every publish. Idempotent by (date, game_id).",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",           index: 0,  type: "string", width: 90,  filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",        index: 1,  type: "string", width: 160, filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-24_NYY@BOS" },
      { name: "Away_Team",      index: 2,  type: "string", width: 80,  filledBy: "MODULE_17", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",      index: 3,  type: "string", width: 80,  filledBy: "MODULE_17", readOnly: true, exampleValue: "BOS" },
      { name: "Vehicle_Type",   index: 4,  type: "string", width: 130, filledBy: "MODULE_17", readOnly: true, exampleValue: "GAME_TOTAL" },
      { name: "Market_Line",    index: 5,  type: "number", width: 90,  format: "0.0",  filledBy: "MODULE_17", readOnly: true, exampleValue: "8.5" },
      { name: "Direction",      index: 6,  type: "string", width: 90,  filledBy: "MODULE_17", readOnly: true, description: "OVER | UNDER | NONE", exampleValue: "UNDER" },
      { name: "Projected_Total",index: 7,  type: "number", width: 130, format: "0.00", filledBy: "MODULE_17", readOnly: true, exampleValue: "6.88" },
      { name: "Variance",       index: 8,  type: "number", width: 90,  format: "0.00", filledBy: "MODULE_17", readOnly: true, description: "Projected − Market. Negative = UNDER edge.", exampleValue: "-1.62" },
      { name: "Final_Decision", index: 9,  type: "string", width: 100, filledBy: "MODULE_17", readOnly: true, description: "CORE | NO_CORE | PENDING", exampleValue: "NO_CORE" },
      { name: "Core_Blocker",   index: 10, type: "string", width: 220, filledBy: "MODULE_17", readOnly: true, exampleValue: "INSUFFICIENT_PROJECTION_SEPARATION" },
      { name: "Edge_Strength",  index: 11, type: "string", width: 120, filledBy: "MODULE_17", readOnly: true, exampleValue: "LEAN" },
      { name: "Confidence",     index: 12, type: "number", width: 90,  format: "0.00", filledBy: "MODULE_17", readOnly: true, exampleValue: "0.35" },
      { name: "Publish_TS",     index: 13, type: "string", width: 200, filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-24T13:42:11.000Z" },
    ],
  },

  {
    name: "VEHICLE_POSTMORTEM",
    description: "Per-game postmortem grading. Written by module17 (phase 2) after settlement. Idempotent by (date, game_id). Grades thesis accuracy and ticket result separately.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",               index: 0,  type: "string", width: 90,  filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",            index: 1,  type: "string", width: 160, filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-24_NYY@BOS" },
      { name: "Away_Team",          index: 2,  type: "string", width: 80,  filledBy: "MODULE_17", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",          index: 3,  type: "string", width: 80,  filledBy: "MODULE_17", readOnly: true, exampleValue: "BOS" },
      { name: "Active_Vehicle_Label", index: 4, type: "string", width: 220, filledBy: "MODULE_17", readOnly: true, exampleValue: "NYY@BOS FG Under 8.5" },
      { name: "Vehicle_Type", index: 5, type: "string", width: 150, filledBy: "MODULE_17", readOnly: true, exampleValue: "FULL_GAME_UNDER" },
      { name: "Market_Line", index: 6, type: "number", width: 90, format: "0.0", filledBy: "MODULE_17", readOnly: true, exampleValue: "8.5" },
      { name: "Decision", index: 7, type: "string", width: 90, filledBy: "MODULE_17", readOnly: true, description: "BET or PASS", exampleValue: "PASS" },
      { name: "Packet_Projected_Total", index: 8, type: "number", width: 175, format: "0.00", filledBy: "MODULE_17", readOnly: true, exampleValue: "6.88" },
      { name: "Actual_Total", index: 9, type: "number", width: 100, format: "0", filledBy: "MODULE_17", readOnly: true, exampleValue: "7" },
      { name: "Signed_Error", index: 10, type: "number", width: 100, format: "0.00", filledBy: "MODULE_17", readOnly: true, description: "Frozen packet projection minus actual", exampleValue: "-0.12" },
      { name: "Abs_Error", index: 11, type: "number", width: 90, format: "0.00", filledBy: "MODULE_17", readOnly: true, exampleValue: "0.12" },
      { name: "Game_Truth_Grade", index: 12, type: "string", width: 175, filledBy: "MODULE_17", readOnly: true, description: "TRUTH_CONFIRMED | TRUTH_FAILED | TRUTH_PUSH | TRUTH_NOT_EVALUABLE", exampleValue: "TRUTH_PUSH" },
      { name: "Vehicle_Capture_Grade", index: 13, type: "string", width: 190, filledBy: "MODULE_17", readOnly: true, exampleValue: "NO_AUTHORIZED_VEHICLE" },
      { name: "Ticket_Result", index: 14, type: "string", width: 145, filledBy: "MODULE_17", readOnly: true, exampleValue: "NO_WAGER_SHADOW" },
      { name: "Blocker_Grade", index: 15, type: "string", width: 160, filledBy: "MODULE_17", readOnly: true, exampleValue: "BLOCKER_RECORDED" },
      { name: "Failure_Modes", index: 16, type: "string", width: 240, filledBy: "MODULE_17", readOnly: true, exampleValue: "DIRECTION_MISS" },
      { name: "Exact_Blocker", index: 17, type: "string", width: 280, filledBy: "MODULE_17", readOnly: true, exampleValue: "INSUFFICIENT_PROJECTION_SEPARATION" },
      { name: "Graded_TS", index: 18, type: "string", width: 200, filledBy: "MODULE_17", readOnly: true, exampleValue: "2026-07-25T08:30:00.000Z" },
    ],
  },

  {
    name: "DECISION_AUDIT_LOG",
    description: "Required two-phase decision-learning ledger. Module20 freezes model, manual-overlay, and authorization evidence at board lock, then appends settlement grading without rewriting pregame reasoning. Idempotent by Date + Game_ID.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "string", width: 95, filledBy: "MODULE_20", readOnly: true, exampleValue: "2026-08-09" },
      { name: "Game_ID", index: 1, type: "string", width: 180, filledBy: "MODULE_20", readOnly: true, exampleValue: "20260809_CIN_WSN" },
      { name: "Away_Team", index: 2, type: "string", width: 85, filledBy: "MODULE_20", readOnly: true, exampleValue: "CIN" },
      { name: "Home_Team", index: 3, type: "string", width: 85, filledBy: "MODULE_20", readOnly: true, exampleValue: "WSN" },
      { name: "Scheduled_First_Pitch", index: 4, type: "string", width: 195, filledBy: "MODULE_20", readOnly: true, exampleValue: "2026-08-09T17:35:00.000Z" },
      { name: "Run_ID", index: 5, type: "string", width: 210, filledBy: "MODULE_20", readOnly: true, exampleValue: "20260809_CIN_WSN_run" },
      { name: "Model_Version", index: 6, type: "string", width: 150, filledBy: "MODULE_20", readOnly: true, exampleValue: "DA-1.1.0" },
      { name: "Audit_Status", index: 7, type: "string", width: 105, filledBy: "MODULE_20", readOnly: true, description: "OPEN before board lock; FROZEN after a legitimate pregame lock; AUDIT_GAP when first pitch passed without a prospective freeze. Settlement fields are identified by Settlement_TS and Graded_TS.", exampleValue: "FROZEN" },
      { name: "Frozen_Projected_Away_Runs", index: 8, type: "number", width: 190, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "4.70" },
      { name: "Frozen_Projected_Home_Runs", index: 9, type: "number", width: 190, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "4.30" },
      { name: "Frozen_Projected_Total", index: 10, type: "number", width: 165, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "9.00" },
      { name: "Frozen_Market_Line", index: 11, type: "number", width: 145, format: "0.0", filledBy: "MODULE_20", readOnly: true, exampleValue: "8.5" },
      { name: "Frozen_Model_Direction", index: 12, type: "string", width: 165, filledBy: "MODULE_20", readOnly: true, exampleValue: "OVER" },
      { name: "Frozen_Model_Vehicle", index: 13, type: "string", width: 165, filledBy: "MODULE_20", readOnly: true, exampleValue: "GAME_TOTAL" },
      { name: "Frozen_Model_Confidence", index: 14, type: "number", width: 175, format: "0", filledBy: "MODULE_20", readOnly: true, description: "Independent integer from 1 to 10.", exampleValue: "7" },
      { name: "Frozen_Model_Blocker", index: 15, type: "string", width: 250, filledBy: "MODULE_20", readOnly: true, exampleValue: "INSUFFICIENT_PROJECTION_SEPARATION" },
      { name: "Frozen_Model_TS", index: 16, type: "string", width: 195, filledBy: "MODULE_20", readOnly: true, exampleValue: "2026-08-09T15:00:00.000Z" },
      { name: "Manual_Game_Truth", index: 17, type: "string", width: 190, filledBy: "OPERATOR", description: "Pregame manual truth statement; include OVER or UNDER when directional grading is intended.", exampleValue: "UNDER suppression" },
      { name: "Manual_Away_Run_View", index: 18, type: "number", width: 165, format: "0.00", filledBy: "OPERATOR", exampleValue: "4.00" },
      { name: "Manual_Home_Run_View", index: 19, type: "number", width: 165, format: "0.00", filledBy: "OPERATOR", exampleValue: "3.50" },
      { name: "Manual_Total_View", index: 20, type: "number", width: 145, format: "0.00", filledBy: "OPERATOR", exampleValue: "7.50" },
      { name: "Manual_Preferred_Vehicle", index: 21, type: "string", width: 195, filledBy: "OPERATOR", exampleValue: "FULL_GAME_UNDER" },
      { name: "Manual_Allocation_Disagreement", index: 22, type: "string", width: 215, filledBy: "OPERATOR", exampleValue: "YES" },
      { name: "Manual_Disagreement_Reason", index: 23, type: "string", width: 300, filledBy: "OPERATOR", exampleValue: "Model allocates too many runs to home offense" },
      { name: "Manual_Confidence", index: 24, type: "number", width: 135, format: "0", filledBy: "OPERATOR", description: "Independent integer from 1 to 10.", exampleValue: "8" },
      { name: "Statcast_Preview_Available", index: 25, type: "string", width: 190, filledBy: "MODULE_20", exampleValue: "AVAILABLE" },
      { name: "Manual_Overlay_TS", index: 26, type: "string", width: 195, filledBy: "OPERATOR", exampleValue: "2026-08-09T15:10:00.000Z" },
      { name: "Final_Reasoning_Source", index: 27, type: "string", width: 220, filledBy: "OPERATOR", description: "MODEL | MANUAL | MODEL_MANUAL_AGREEMENT | MODEL_WITH_MANUAL_DOWNGRADE | MANUAL_OVERRIDE | SPLIT_DECISION | UNRESOLVED", exampleValue: "MODEL_MANUAL_AGREEMENT" },
      { name: "Final_Vehicle", index: 28, type: "string", width: 175, filledBy: "OPERATOR", exampleValue: "GAME_TOTAL" },
      { name: "Final_Decision", index: 29, type: "string", width: 120, filledBy: "OPERATOR", description: "CORE | NO CORE", exampleValue: "NO CORE" },
      { name: "Final_Authorization_Confidence", index: 30, type: "number", width: 215, format: "0", filledBy: "OPERATOR", description: "Independent integer from 1 to 10; never averaged from model and manual confidence.", exampleValue: "5" },
      { name: "Final_Blocker", index: 31, type: "string", width: 260, filledBy: "OPERATOR", exampleValue: "UNRESOLVED_STARTER" },
      { name: "Final_Decision_Notes", index: 32, type: "string", width: 300, filledBy: "OPERATOR", exampleValue: "Manual contradiction lowers authorization confidence" },
      { name: "Final_Decision_TS", index: 33, type: "string", width: 195, filledBy: "OPERATOR", exampleValue: "2026-08-09T15:15:00.000Z" },
      { name: "Actual_Away_Runs", index: 34, type: "number", width: 135, format: "0", filledBy: "MODULE_20", readOnly: true, exampleValue: "6" },
      { name: "Actual_Home_Runs", index: 35, type: "number", width: 135, format: "0", filledBy: "MODULE_20", readOnly: true, exampleValue: "4" },
      { name: "Actual_Total", index: 36, type: "number", width: 105, format: "0", filledBy: "MODULE_20", readOnly: true, exampleValue: "10" },
      { name: "Ticket_Result", index: 37, type: "string", width: 125, filledBy: "MODULE_20", readOnly: true, description: "WIN | LOSS | PUSH | NO_WAGER | PENDING", exampleValue: "NO_WAGER" },
      { name: "Settlement_TS", index: 38, type: "string", width: 195, filledBy: "MODULE_20", readOnly: true, exampleValue: "2026-08-10T03:00:00.000Z" },
      { name: "Model_Truth_Grade", index: 39, type: "string", width: 160, filledBy: "MODULE_20", readOnly: true, exampleValue: "CORRECT" },
      { name: "Manual_Truth_Grade", index: 40, type: "string", width: 165, filledBy: "MODULE_20", readOnly: true, exampleValue: "INCORRECT" },
      { name: "Model_Allocation_Error", index: 41, type: "number", width: 175, format: "0.00", filledBy: "MODULE_20", readOnly: true, description: "Absolute away-run error plus absolute home-run error.", exampleValue: "2.00" },
      { name: "Manual_Allocation_Error", index: 42, type: "number", width: 180, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "3.00" },
      { name: "Allocation_Winner", index: 43, type: "string", width: 155, filledBy: "MODULE_20", readOnly: true, description: "MODEL | MANUAL | TIE | BOTH_WRONG | NOT_COMPARABLE", exampleValue: "MODEL" },
      { name: "Vehicle_Capture_Grade", index: 44, type: "string", width: 190, filledBy: "MODULE_20", readOnly: true, exampleValue: "NO_AUTHORIZED_VEHICLE" },
      { name: "Authorization_Grade", index: 45, type: "string", width: 190, filledBy: "MODULE_20", readOnly: true, description: "Pregame decision-quality grade; a passed winner is not automatically QUESTIONABLE_PASS.", exampleValue: "CORRECT_PASS" },
      { name: "Outcome_Tag", index: 46, type: "string", width: 155, filledBy: "MODULE_20", readOnly: true, exampleValue: "MODEL_CORRECT" },
      { name: "Failure_or_Survival_Mechanism", index: 47, type: "string", width: 270, filledBy: "MODULE_20", readOnly: true, exampleValue: "RECORDED_BLOCKER_PRESERVED_PASS" },
      { name: "One_Sentence_Lesson", index: 48, type: "string", width: 380, filledBy: "MODULE_20", readOnly: true, exampleValue: "The pregame blocker governed the pass; the result alone does not invalidate it." },
      { name: "Graded_TS", index: 49, type: "string", width: 195, filledBy: "MODULE_20", readOnly: true, exampleValue: "2026-08-10T03:05:00.000Z" },
      { name: "Model_Total_Error", index: 50, type: "number", width: 150, format: "0.00", filledBy: "MODULE_20", readOnly: true, description: "Frozen model total minus actual total.", exampleValue: "-1.00" },
      { name: "Manual_Total_Error", index: 51, type: "number", width: 155, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "-0.50" },
      { name: "Model_Away_Run_Error", index: 52, type: "number", width: 175, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "-1.30" },
      { name: "Model_Home_Run_Error", index: 53, type: "number", width: 175, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "0.30" },
      { name: "Manual_Away_Run_Error", index: 54, type: "number", width: 180, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "-1.00" },
      { name: "Manual_Home_Run_Error", index: 55, type: "number", width: 180, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "0.50" },
      { name: "Model_Margin_Error", index: 56, type: "number", width: 165, format: "0.00", filledBy: "MODULE_20", readOnly: true, description: "Frozen projected margin minus actual margin.", exampleValue: "-1.60" },
      { name: "Manual_Margin_Error", index: 57, type: "number", width: 170, format: "0.00", filledBy: "MODULE_20", readOnly: true, exampleValue: "-1.50" },
      { name: "Actual_Winner", index: 58, type: "string", width: 125, filledBy: "MODULE_20", readOnly: true, description: "AWAY | HOME | TIE.", exampleValue: "AWAY" },
      { name: "Model_Winner_Result", index: 59, type: "string", width: 165, filledBy: "MODULE_20", readOnly: true, description: "CORRECT | INCORRECT | PUSH | NOT_GRADABLE.", exampleValue: "CORRECT" },
      { name: "Manual_Winner_Result", index: 60, type: "string", width: 170, filledBy: "MODULE_20", readOnly: true, exampleValue: "INCORRECT" },
      { name: "Freeze_TS", index: 61, type: "string", width: 195, filledBy: "MODULE_20", readOnly: true, description: "Real timestamp when the coherent pregame snapshot became immutable; distinct from projection generation, decision, publication, and settlement.", exampleValue: "2026-08-11T20:51:25.000Z" },
    ],
  },

  {
    name: "SURVIVAL_GATE_REPLAY",
    description: "Retroactive survival gate analysis written by module18. Reconstructs baseball_only_projection = projected_total / combined_multiplier for every OVER pick in the date range and re-grades against gate thresholds. Never cleared; overwritten on each run.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",                  index: 0,  type: "string", width: 90,  filledBy: "MODULE_18", readOnly: true, exampleValue: "2026-07-24" },
      { name: "Game_ID",               index: 1,  type: "string", width: 160, filledBy: "MODULE_18", readOnly: true, exampleValue: "20260724_OAK_MIN" },
      { name: "Away_Team",             index: 2,  type: "string", width: 80,  filledBy: "MODULE_18", readOnly: true, exampleValue: "OAK" },
      { name: "Home_Team",             index: 3,  type: "string", width: 80,  filledBy: "MODULE_18", readOnly: true, exampleValue: "MIN" },
      { name: "Away_Pitcher",          index: 4,  type: "string", width: 140, filledBy: "MODULE_18", readOnly: true, exampleValue: "Jacob Lopez" },
      { name: "Home_Pitcher",          index: 5,  type: "string", width: 140, filledBy: "MODULE_18", readOnly: true, exampleValue: "Zebby Matthews" },
      { name: "Market_Line",           index: 6,  type: "number", width: 90,  format: "0.0", filledBy: "MODULE_18", readOnly: true, exampleValue: "9.5" },
      { name: "Projected_Total",       index: 7,  type: "number", width: 130, format: "0.00", filledBy: "MODULE_18", readOnly: true, exampleValue: "10.47" },
      { name: "Variance",              index: 8,  type: "number", width: 90,  format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "Projected − Market", exampleValue: "0.97" },
      { name: "Direction",             index: 9,  type: "string", width: 80,  filledBy: "MODULE_18", readOnly: true, exampleValue: "OVER" },
      { name: "Actual_Total",          index: 10, type: "number", width: 90,  format: "0",   filledBy: "MODULE_18", readOnly: true, exampleValue: "2" },
      { name: "Thesis_Correct",        index: 11, type: "string", width: 110, filledBy: "MODULE_18", readOnly: true, description: "TRUE | FALSE | PUSH | blank when not evaluable. PUSH is excluded from win/loss and gate-performance denominators.", exampleValue: "PUSH" },
      { name: "Original_Decision",     index: 12, type: "string", width: 110, filledBy: "MODULE_18", readOnly: true, description: "CORE | NO_CORE | PENDING at time of publish", exampleValue: "NO_CORE" },
      { name: "Original_Blocker",      index: 13, type: "string", width: 220, filledBy: "MODULE_18", readOnly: true, exampleValue: "INSUFFICIENT_PROJECTION_SEPARATION" },
      { name: "Replayed_Decision",     index: 14, type: "string", width: 110, filledBy: "MODULE_18", readOnly: true, description: "CORE | BLOCKED | PENDING | NOT_OVER under survival gate", exampleValue: "BLOCKED" },
      { name: "Replay_Blocker",        index: 15, type: "string", width: 250, filledBy: "MODULE_18", readOnly: true, description: "Survival gate failure reason, or PRIOR_GATE", exampleValue: "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD" },
      { name: "Baseball_Only_Proj",    index: 16, type: "number", width: 130, format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "projected_total / combined_multiplier — environment-free projection", exampleValue: "10.69" },
      { name: "Combined_Multiplier",   index: 17, type: "number", width: 130, format: "0.0000", filledBy: "MODULE_18", readOnly: true, description: "park × weather combined run multiplier (capped)", exampleValue: "0.9794" },
      { name: "Environment_Run_Adj",   index: 18, type: "number", width: 140, format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "projected_total − baseball_only_proj. Positive = env boosted.", exampleValue: "-0.22" },
      { name: "Approx_Survival_Floor", index: 19, type: "number", width: 150, format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "baseball_only × 0.781 (approximate; uses default 5.5 IP starter split)", exampleValue: "8.34" },
      { name: "Floor_Edge",            index: 20, type: "number", width: 90,  format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "Approx_Floor − Market_Line. Must be ≥ 0.25 to pass.", exampleValue: "-1.16" },
      { name: "Baseball_Only_Edge",    index: 21, type: "number", width: 130, format: "0.00", filledBy: "MODULE_18", readOnly: true, description: "Baseball_Only_Proj − Market_Line. Must be ≥ 1.25 to pass.", exampleValue: "1.19" },
      { name: "Park_Multiplier",       index: 22, type: "number", width: 120, format: "0.0000", filledBy: "MODULE_18", readOnly: true, exampleValue: "0.95" },
      { name: "Weather_Multiplier",    index: 23, type: "number", width: 130, format: "0.0000", filledBy: "MODULE_18", readOnly: true, exampleValue: "1.031" },
      { name: "Park_Source",           index: 24, type: "string", width: 160, filledBy: "MODULE_18", readOnly: true, exampleValue: "VENUE_FACTOR_USED" },
      { name: "Marginal_Flag",         index: 25, type: "string", width: 160, filledBy: "MODULE_18", readOnly: true, description: "MARGINAL when verdict is within 0.15 of a threshold. NO_MULTIPLIER_DATA when SHADOW_HISTORY absent.", exampleValue: "MARGINAL" },
      { name: "Away_Offense_Source",   index: 26, type: "string", width: 160, filledBy: "MODULE_18", readOnly: true, description: "Source of the away team's offensive rate read from SHADOW_HISTORY col 9. BLENDED | L30_ONLY | L10_ONLY | LEAGUE_AVG_FALLBACK. Blank for pre-v9 rows.", exampleValue: "BLENDED" },
      { name: "Home_Offense_Source",   index: 27, type: "string", width: 160, filledBy: "MODULE_18", readOnly: true, description: "Source of the home team's offensive rate read from SHADOW_HISTORY col 10. Same values as Away_Offense_Source.", exampleValue: "L30_ONLY" },
      { name: "Notes",                 index: 28, type: "string", width: 220, filledBy: "MODULE_18", readOnly: true, description: "Semicolon-separated flags: SHADOW_HISTORY_ABSENT | NO_OUTCOME | FALLBACK_OFFENSE_SOURCE", exampleValue: "FALLBACK_OFFENSE_SOURCE" },
      { name: "Pregame_Away_Starter",  index: 29, type: "string", width: 180, filledBy: "MODULE_18", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "Pregame_Home_Starter",  index: 30, type: "string", width: 180, filledBy: "MODULE_18", readOnly: true, exampleValue: "Brayan Bello" },
      { name: "Pregame_Away_Opener",   index: 31, type: "string", width: 190, filledBy: "MODULE_18", readOnly: true, description: "Explicit NOT_CAPTURED_PREGAME when no date-anchored role record exists", exampleValue: "NOT_CAPTURED_PREGAME" },
      { name: "Pregame_Home_Opener",   index: 32, type: "string", width: 190, filledBy: "MODULE_18", readOnly: true, exampleValue: "NOT_CAPTURED_PREGAME" },
      { name: "Pregame_Away_Bulk",     index: 33, type: "string", width: 190, filledBy: "MODULE_18", readOnly: true, exampleValue: "NOT_CAPTURED_PREGAME" },
      { name: "Pregame_Home_Bulk",     index: 34, type: "string", width: 190, filledBy: "MODULE_18", readOnly: true, exampleValue: "NOT_CAPTURED_PREGAME" },
      { name: "Actual_Away_Primary",   index: 35, type: "string", width: 180, filledBy: "MODULE_18", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "Actual_Home_Primary",   index: 36, type: "string", width: 180, filledBy: "MODULE_18", readOnly: true, exampleValue: "Brayan Bello" },
      { name: "Pitcher_Provenance_Flag", index: 37, type: "string", width: 230, filledBy: "MODULE_18", readOnly: true, exampleValue: "COMPLETE_MATCH" },
    ],
  },

  {
    name: "STATCAST_SHADOW_AUDIT",
    description: "Per-game estimated projection driven by Baseball Savant pitcher xwOBA-allowed plus hitter traffic/damage shape, with a shadow-only low-center volatility challenger and upper-tail band. Full-replace each pipeline run (current-day snapshot only). Does not affect the board or authorization. Written by module09s.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date",                          index: 0,  type: "string", width: 90,  filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-07-26" },
      { name: "Game_ID",                       index: 1,  type: "string", width: 175, filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-07-26_NYY@BOS" },
      { name: "Away_Team",                     index: 2,  type: "string", width: 80,  filledBy: "MODULE_09s", readOnly: true, exampleValue: "NYY" },
      { name: "Home_Team",                     index: 3,  type: "string", width: 80,  filledBy: "MODULE_09s", readOnly: true, exampleValue: "BOS" },
      { name: "Away_Pitcher",                  index: 4,  type: "string", width: 150, filledBy: "MODULE_09s", readOnly: true, exampleValue: "Gerrit Cole" },
      { name: "Home_Pitcher",                  index: 5,  type: "string", width: 150, filledBy: "MODULE_09s", readOnly: true, exampleValue: "Brayan Bello" },
      { name: "Preview_Availability",          index: 6,  type: "string", width: 160, filledBy: "MODULE_09s", readOnly: true, description: "AVAILABLE | NOT_PUBLISHED | FETCH_ERROR | PARSE_ERROR | UNAVAILABLE", exampleValue: "AVAILABLE" },
      { name: "Current_Projection",            index: 7,  type: "number", width: 130, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Projected total runs from module09. This is the live projection used on the board.", exampleValue: "8.74" },
      { name: "Shadow_xwOBA_Adjustment",       index: 8,  type: "number", width: 180, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Uncapped total run delta from both starter xwOBA adjustments. Positive = shadow model expects more runs.", exampleValue: "0.1820" },
      { name: "Shadow_Projection",             index: 9,  type: "number", width: 140, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Current_Projection + capped adjustment. Shadow-only — NOT used in any live calculation.", exampleValue: "8.92" },
      { name: "Cap_Applied",                   index: 10, type: "string", width: 100, filledBy: "MODULE_09s", readOnly: true, description: "YES when |uncapped adjustment| exceeded ±0.30 runs.", exampleValue: "NO" },
      { name: "Away_Pitcher_xwOBA",            index: 11, type: "number", width: 145, format: "0.000", filledBy: "MODULE_09s", readOnly: true, description: "Season xwOBA allowed by the away starter. Blank when unavailable.", exampleValue: "0.290" },
      { name: "Away_Pitcher_Shadow_Quality",   index: 12, type: "number", width: 200, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Shadow quality factor: currentQual × 0.75 + xwobaFactor × 0.25. Blank when xwOBA unavailable.", exampleValue: "0.9036" },
      { name: "Away_Pitcher_Current_Quality",  index: 13, type: "number", width: 205, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "FIP/ERA-based quality factor from module09 (away_starter_quality).", exampleValue: "0.9200" },
      { name: "Home_Pitcher_xwOBA",            index: 14, type: "number", width: 145, format: "0.000", filledBy: "MODULE_09s", readOnly: true, description: "Season xwOBA allowed by the home starter. Blank when unavailable.", exampleValue: "0.330" },
      { name: "Home_Pitcher_Shadow_Quality",   index: 15, type: "number", width: 200, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Shadow quality factor for the home starter. Blank when xwOBA unavailable.", exampleValue: "1.0619" },
      { name: "Home_Pitcher_Current_Quality",  index: 16, type: "number", width: 205, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "FIP/ERA-based quality factor from module09 (home_starter_quality).", exampleValue: "1.0500" },
      { name: "Away_Starter_Delta",            index: 17, type: "number", width: 145, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Run delta from the HOME pitcher quality change affecting AWAY run scoring.", exampleValue: "0.1020" },
      { name: "Home_Starter_Delta",            index: 18, type: "number", width: 145, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Run delta from the AWAY pitcher quality change affecting HOME run scoring.", exampleValue: "0.0800" },
      { name: "Missing_Fields",                index: 19, type: "string", width: 280, filledBy: "MODULE_09s", readOnly: true, description: "Semicolon-separated list of unavailable fields that zeroed the shadow adjustment.", exampleValue: "away_pitcher_xwoba" },
      { name: "Identity_Warnings",             index: 20, type: "string", width: 350, filledBy: "MODULE_09s", readOnly: true, description: "Semicolon-separated parse warnings (pitcher ID mismatch, team mismatch, stale data, etc.).", exampleValue: "" },
      { name: "Preview_Used_In_Projection",    index: 21, type: "string", width: 200, filledBy: "MODULE_09s", readOnly: true, description: "Always NO throughout Phase 3.", exampleValue: "NO" },
      { name: "Snapshot_TS",                   index: 22, type: "string", width: 200, filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-07-26T10:00:00.000Z" },
      { name: "Away_Traffic_Adjustment",       index: 23, type: "number", width: 175, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Signed away-team run estimate from preview walk/strikeout opportunity shape.", exampleValue: "0.0800" },
      { name: "Home_Traffic_Adjustment",       index: 24, type: "number", width: 175, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Signed home-team run estimate from preview walk/strikeout opportunity shape.", exampleValue: "-0.0400" },
      { name: "Traffic_Conversion_Estimate",  index: 25, type: "number", width: 205, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Away plus home traffic adjustments; diagnostic estimate, not the active GAME_SUMMARY component.", exampleValue: "0.0400" },
      { name: "Away_Damage_Adjustment",        index: 26, type: "number", width: 175, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Signed away-team run estimate from preview hard-hit rate relative to league baseline.", exampleValue: "0.1200" },
      { name: "Home_Damage_Adjustment",        index: 27, type: "number", width: 175, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Signed home-team run estimate from preview hard-hit rate relative to league baseline.", exampleValue: "0.0600" },
      { name: "HR_XBH_Damage_Estimate",       index: 28, type: "number", width: 195, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Away plus home hard-hit damage adjustments; diagnostic estimate, not the active GAME_SUMMARY component.", exampleValue: "0.1800" },
      { name: "Combined_Tail_Adjustment",      index: 29, type: "number", width: 190, format: "0.0000", filledBy: "MODULE_09s", readOnly: true, description: "Traffic plus damage estimate, capped to +/-0.60 runs per game.", exampleValue: "0.2200" },
      { name: "Estimated_Projection",          index: 30, type: "number", width: 165, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Current projection plus capped starter xwOBA adjustment and combined tail estimate.", exampleValue: "8.96" },
      { name: "Tail_Cap_Applied",              index: 31, type: "string", width: 135, filledBy: "MODULE_09s", readOnly: true, description: "YES when the combined traffic/damage estimate exceeded +/-0.60 runs.", exampleValue: "NO" },
      { name: "Tail_Estimate_Status",          index: 32, type: "string", width: 165, filledBy: "MODULE_09s", readOnly: true, description: "AVAILABLE | PARTIAL | UNAVAILABLE according to preview hitter inputs.", exampleValue: "AVAILABLE" },
      { name: "Low_Center_Volatility_Flag",    index: 33, type: "string", width: 220, filledBy: "MODULE_09s", readOnly: true, description: "LOW_CENTER_VOLATILITY when Current_Projection is below 8.00; shadow-only diagnostic, never a board or authorization input.", exampleValue: "LOW_CENTER_VOLATILITY" },
      { name: "Low_Center_Challenger_Projection", index: 34, type: "number", width: 235, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Shadow-only Current_Projection + 1.50 center challenger for low-center games; blank otherwise.", exampleValue: "8.35" },
      { name: "Low_Center_Sensitivity_Projection", index: 35, type: "number", width: 240, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Shadow-only Current_Projection + 2.00 sensitivity challenger for low-center games; blank otherwise.", exampleValue: "8.85" },
      { name: "Low_Center_Upper_Tail_Band",   index: 36, type: "number", width: 220, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Shadow-only upper-tail audit ceiling for low-center games; not a projection or wager signal.", exampleValue: "14.94" },
      { name: "Low_Center_Upper_Tail_Residual", index: 37, type: "number", width: 235, format: "0.00", filledBy: "MODULE_09s", readOnly: true, description: "Observed low-center upper-tail residual behind the audit ceiling; blank outside the regime.", exampleValue: "8.09" },
      { name: "Low_Center_Reason_Tags",       index: 38, type: "string", width: 360, filledBy: "MODULE_09s", readOnly: true, description: "Descriptive low-center inputs present in the snapshot; tags never create an automatic thesis.", exampleValue: "BASE_PROJECTION_LT_8; BOTH_STARTERS_BELOW_LEAGUE_QUALITY" },
    ],
  },

  {
    name: "LOW_CENTER_CALIBRATION_HISTORY",
    description: "Append-only, timestamped pregame capture of low-center base and challenger projections. Used only to grade shadow candidates prospectively at settlement.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "string", width: 90, filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-08-19" },
      { name: "Game_ID", index: 1, type: "string", width: 180, filledBy: "MODULE_09s", readOnly: true, exampleValue: "20260819_SEA_HOU" },
      { name: "Away_Team", index: 2, type: "string", width: 90, filledBy: "MODULE_09s", readOnly: true, exampleValue: "SEA" },
      { name: "Home_Team", index: 3, type: "string", width: 90, filledBy: "MODULE_09s", readOnly: true, exampleValue: "HOU" },
      { name: "Scheduled_First_Pitch", index: 4, type: "string", width: 200, filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-08-19T23:10:00.000Z" },
      { name: "Base_Projection", index: 5, type: "number", width: 140, format: "0.00", filledBy: "MODULE_09s", readOnly: true, exampleValue: "7.50" },
      { name: "Primary_Challenger_Projection", index: 6, type: "number", width: 235, format: "0.00", filledBy: "MODULE_09s", readOnly: true, exampleValue: "9.00" },
      { name: "Sensitivity_Challenger_Projection", index: 7, type: "number", width: 250, format: "0.00", filledBy: "MODULE_09s", readOnly: true, exampleValue: "9.50" },
      { name: "Upper_Tail_Band", index: 8, type: "number", width: 160, format: "0.00", filledBy: "MODULE_09s", readOnly: true, exampleValue: "15.59" },
      { name: "Snapshot_TS", index: 9, type: "string", width: 200, filledBy: "MODULE_09s", readOnly: true, exampleValue: "2026-08-19T16:00:00.000Z" },
    ],
  },

  {
    name: "LOW_CENTER_CALIBRATION_REPORT",
    description: "Settlement comparison of the preserved low-center base, +1.50 primary challenger, and +2.00 sensitivity challenger. Shadow-only; never affects projections or authorization.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-19" },
      { name: "Game_ID", index: 1, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, exampleValue: "20260819_SEA_HOU" },
      { name: "Away_Team", index: 2, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "SEA" },
      { name: "Home_Team", index: 3, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "HOU" },
      { name: "Scheduled_First_Pitch", index: 4, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-19T23:10:00.000Z" },
      { name: "Base_Projection", index: 5, type: "number", width: 140, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "7.50" },
      { name: "Primary_Challenger_Projection", index: 6, type: "number", width: 235, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "9.00" },
      { name: "Sensitivity_Challenger_Projection", index: 7, type: "number", width: 250, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "9.50" },
      { name: "Actual_Total", index: 8, type: "number", width: 115, format: "0", filledBy: "MODULE_14", readOnly: true, exampleValue: "11" },
      { name: "Base_Error", index: 9, type: "number", width: 110, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "-3.50" },
      { name: "Primary_Error", index: 10, type: "number", width: 125, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "-2.00" },
      { name: "Sensitivity_Error", index: 11, type: "number", width: 145, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "-1.50" },
      { name: "Base_Abs_Error", index: 12, type: "number", width: 135, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "3.50" },
      { name: "Primary_Abs_Error", index: 13, type: "number", width: 150, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "2.00" },
      { name: "Sensitivity_Abs_Error", index: 14, type: "number", width: 170, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "1.50" },
      { name: "Prospective_Snapshot_TS", index: 15, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-19T16:00:00.000Z" },
      { name: "Settlement_TS", index: 16, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-20T03:00:00.000Z" },
      { name: "Calibration_Status", index: 17, type: "string", width: 220, filledBy: "MODULE_14", readOnly: true, exampleValue: "PROSPECTIVE_SHADOW_CANDIDATE" },
    ],
  },

  {
    name: "STARTER_SURVIVAL_CALIBRATION_HISTORY",
    description: "Immutable pre-first-pitch four-state starter survival/failure challenger snapshots. Shadow-only; never changes the active total, vehicle, market, or authorization.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "string", width: 90, filledBy: "MODULE_09t", readOnly: true, exampleValue: "2026-08-21" },
      { name: "Game_ID", index: 1, type: "string", width: 180, filledBy: "MODULE_09t", readOnly: true, exampleValue: "20260821_AAA_BBB" },
      { name: "Scheduled_First_Pitch", index: 2, type: "string", width: 200, filledBy: "MODULE_09t", readOnly: true, exampleValue: "2026-08-21T23:10:00.000Z" },
      { name: "Base_Projected_Total", index: 3, type: "number", width: 145, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.50" },
      { name: "Starter_Survival_Adjusted_Total", index: 4, type: "number", width: 235, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.63" },
      { name: "Away_Starter_Survival_Workload", index: 5, type: "number", width: 220, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "5.80" },
      { name: "Home_Starter_Survival_Workload", index: 6, type: "number", width: 220, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "5.40" },
      { name: "Away_Starter_Survival_Prob", index: 7, type: "number", width: 205, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, description: "Temporary default: clamp(Projected_Starter_Innings / 9, 0, 1).", exampleValue: "0.6444" },
      { name: "Home_Starter_Survival_Prob", index: 8, type: "number", width: 205, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.6000" },
      { name: "P_SS", index: 9, type: "number", width: 100, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.3867" },
      { name: "P_FS", index: 10, type: "number", width: 100, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.2133" },
      { name: "P_SF", index: 11, type: "number", width: 100, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.2578" },
      { name: "P_FF", index: 12, type: "number", width: 100, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.1422" },
      { name: "T_SS", index: 13, type: "number", width: 100, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.30" },
      { name: "T_FS", index: 14, type: "number", width: 100, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.55" },
      { name: "T_SF", index: 15, type: "number", width: 100, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.70" },
      { name: "T_FF", index: 16, type: "number", width: 100, format: "0.00", filledBy: "MODULE_09t", readOnly: true, exampleValue: "7.95" },
      { name: "Away_Starter_FDS", index: 17, type: "number", width: 155, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.0320" },
      { name: "Home_Starter_FDS", index: 18, type: "number", width: 155, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.0510" },
      { name: "Game_FDS", index: 19, type: "number", width: 120, format: "0.0000", filledBy: "MODULE_09t", readOnly: true, exampleValue: "0.0450" },
      { name: "Snapshot_TS", index: 20, type: "string", width: 200, filledBy: "MODULE_09t", readOnly: true, exampleValue: "2026-08-21T16:00:00.000Z" },
      { name: "Calibration_Status", index: 21, type: "string", width: 220, filledBy: "MODULE_09t", readOnly: true, exampleValue: "PROSPECTIVE_SHADOW_CANDIDATE" },
    ],
  },

  {
    name: "STARTER_SURVIVAL_CALIBRATION_REPORT",
    description: "Settlement-grade comparison of preserved base and starter-survival challenger totals. It appends actuals without rewriting the prospective history.",
    section: "ANALYSIS",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-21" },
      { name: "Game_ID", index: 1, type: "string", width: 180, filledBy: "MODULE_14", readOnly: true, exampleValue: "20260821_AAA_BBB" },
      { name: "Away_Team", index: 2, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "AAA" },
      { name: "Home_Team", index: 3, type: "string", width: 90, filledBy: "MODULE_14", readOnly: true, exampleValue: "BBB" },
      { name: "Scheduled_First_Pitch", index: 4, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-21T23:10:00.000Z" },
      { name: "Base_Projected_Total", index: 5, type: "number", width: 145, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "7.50" },
      { name: "Starter_Survival_Adjusted_Total", index: 6, type: "number", width: 235, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "7.63" },
      { name: "Actual_Total", index: 7, type: "number", width: 115, format: "0", filledBy: "MODULE_14", readOnly: true, exampleValue: "9" },
      { name: "Base_Error", index: 8, type: "number", width: 120, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "-1.50" },
      { name: "Base_Abs_Error", index: 9, type: "number", width: 140, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "1.50" },
      { name: "SSAT_Error", index: 10, type: "number", width: 120, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "-1.37" },
      { name: "SSAT_Abs_Error", index: 11, type: "number", width: 140, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "1.37" },
      { name: "Base_Market_Direction_Result", index: 12, type: "string", width: 205, filledBy: "MODULE_14", readOnly: true, exampleValue: "WIN" },
      { name: "SSAT_Market_Direction_Result", index: 13, type: "string", width: 205, filledBy: "MODULE_14", readOnly: true, exampleValue: "WIN" },
      { name: "Away_Starter_Actual_IP", index: 14, type: "number", width: 170, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "5.67" },
      { name: "Home_Starter_Actual_IP", index: 15, type: "number", width: 170, format: "0.00", filledBy: "MODULE_14", readOnly: true, exampleValue: "4.00" },
      { name: "Away_Starter_Survival_Result", index: 16, type: "string", width: 215, filledBy: "MODULE_14", readOnly: true, exampleValue: "FAILED" },
      { name: "Home_Starter_Survival_Result", index: 17, type: "string", width: 215, filledBy: "MODULE_14", readOnly: true, exampleValue: "SURVIVED" },
      { name: "Away_Starter_FDS", index: 18, type: "number", width: 155, format: "0.0000", filledBy: "MODULE_14", readOnly: true, exampleValue: "0.0320" },
      { name: "Home_Starter_FDS", index: 19, type: "number", width: 155, format: "0.0000", filledBy: "MODULE_14", readOnly: true, exampleValue: "0.0510" },
      { name: "Game_FDS", index: 20, type: "number", width: 120, format: "0.0000", filledBy: "MODULE_14", readOnly: true, exampleValue: "0.0450" },
      { name: "Prospective_Snapshot_TS", index: 21, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-21T16:00:00.000Z" },
      { name: "Settlement_TS", index: 22, type: "string", width: 200, filledBy: "MODULE_14", readOnly: true, exampleValue: "2026-08-22T03:00:00.000Z" },
      { name: "Calibration_Status", index: 23, type: "string", width: 220, filledBy: "MODULE_14", readOnly: true, exampleValue: "SETTLED" },
    ],
  },

  {
    name: "README",
    description: "Operator orientation: schema version, SOP links, ownership rules.",
    section: "META",
    frozenRows: 0,
    columns: [
      { name: "Key", index: 0, type: "string", width: 220, filledBy: "SYSTEM", exampleValue: "Schema version" },
      { name: "Value", index: 1, type: "string", width: 520, filledBy: "SYSTEM", exampleValue: "8" },
    ],
  },
];

export const WORKBOOK_NAME_TEMPLATE = "FROSTLINE_Pipeline_{DATE}";

/** Generate SCHEMA_REFERENCE rows from the schema definitions */
export function generateSchemaReferenceRows(): string[][] {
  const rows: string[][] = [];
  for (const sheet of WORKBOOK_SCHEMA) {
    for (const col of sheet.columns) {
      rows.push([
        sheet.name,
        sheet.section,
        col.name,
        String(col.index),
        col.type,
        col.description ?? "",
        col.format ?? "",
        col.filledBy ?? "",
        col.readOnly ? "YES" : "NO",
        col.exampleValue ?? "",
      ]);
    }
  }
  return rows;
}
