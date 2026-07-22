/**
 * Workbook schema definitions for the Frostline Pipeline Google Sheets workbook.
 * Canonical source of truth for sheet names, column layout, types, and formats.
 */

export interface ColumnDef {
  name: string;
  index: number;
  type: "string" | "number" | "date" | "formula" | "currency" | "percent";
  formula?: string;
  width?: number;
  format?: string;
  readOnly?: boolean;
  description?: string;
  filledBy?: "MODULE_08" | "MODULE_10" | "FORMULA" | "OPERATOR" | "MODULE_12" | "SYSTEM";
  exampleValue?: string;
}

export interface SheetDef {
  name: string;
  description: string;
  section: "INPUT" | "COMPUTATION" | "OUTPUT" | "REFERENCE" | "META";
  columns: ColumnDef[];
  frozenRows?: number;
}

// Header background colours per section (RGB 0–1)
export const SECTION_COLORS: Record<SheetDef["section"], { red: number; green: number; blue: number }> = {
  INPUT:       { red: 0.10, green: 0.14, blue: 0.22 }, // deep navy
  COMPUTATION: { red: 0.12, green: 0.10, blue: 0.22 }, // deep indigo
  OUTPUT:      { red: 0.10, green: 0.20, blue: 0.14 }, // deep green
  REFERENCE:   { red: 0.18, green: 0.14, blue: 0.10 }, // deep amber
  META:        { red: 0.12, green: 0.12, blue: 0.12 }, // dark grey
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
      { name: "Park_Factor_HR", index: 20, type: "number", width: 90, format: "0.000", filledBy: "MODULE_08", exampleValue: "1.052" },
      { name: "Run_Environment", index: 21, type: "number", width: 90, format: "0.00", filledBy: "MODULE_08", exampleValue: "4.75" },
      { name: "FanGraphs_Last_Updated", index: 22, type: "date", width: 130, format: "mm/dd/yyyy hh:mm", filledBy: "MODULE_08", exampleValue: "07/22/2026 08:00" },
      { name: "Statcast_Last_Updated", index: 23, type: "date", width: 130, format: "mm/dd/yyyy hh:mm", filledBy: "MODULE_08", exampleValue: "07/22/2026 06:00" },
      { name: "Notes", index: 24, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "Dome game — weather neutral" },
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

  // ─── COMPUTATION SECTION ────────────────────────────────────────────────────
  {
    name: "GAME_INTEGRATION",
    description: "Per-team aggregation: DAILY_MATCHUPS + derived fields",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "FORMULA", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "BOS" },
      { name: "Opponent", index: 3, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "NYY" },
      { name: "Is_Home", index: 4, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", description: "YES / NO", exampleValue: "NO" },
      { name: "Pitcher", index: 5, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Brayan Bello" },
      { name: "Pitcher_Role", index: 6, type: "string", width: 100, readOnly: true, filledBy: "FORMULA", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Pitcher_Confidence", index: 7, type: "percent", width: 100, format: "0%", readOnly: true, filledBy: "FORMULA", exampleValue: "0.75" },
      { name: "Expected_Pitches", index: 8, type: "number", width: 110, format: "0", readOnly: true, filledBy: "FORMULA", exampleValue: "85" },
      { name: "Expected_Innings", index: 9, type: "number", width: 110, format: "0.0", readOnly: true, filledBy: "FORMULA", exampleValue: "5.5" },
      { name: "Opp_Pitcher", index: 10, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Gerrit Cole" },
      { name: "Opp_Pitcher_Role", index: 11, type: "string", width: 100, readOnly: true, filledBy: "FORMULA", exampleValue: "CONVENTIONAL_STARTER" },
      { name: "Lineup_Strength", index: 12, type: "number", width: 110, format: "0.000", readOnly: true, filledBy: "FORMULA", description: "VLOOKUP to TODAY_LINEUPS avg wRC+", exampleValue: "112.500" },
      { name: "Recent_RS_per_9", index: 13, type: "number", width: 120, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "From TEAM_FORM_INPUT", exampleValue: "4.68" },
      { name: "Recent_RA_per_9", index: 14, type: "number", width: 120, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "3.42" },
      { name: "Temperature_F", index: 15, type: "number", width: 100, format: "0", readOnly: true, filledBy: "FORMULA", exampleValue: "78" },
      { name: "Wind_MPH", index: 16, type: "number", width: 90, format: "0.0", readOnly: true, filledBy: "FORMULA", exampleValue: "12.5" },
      { name: "Run_Multiplier", index: 17, type: "number", width: 110, format: "0.000", readOnly: true, filledBy: "FORMULA", exampleValue: "1.035" },
      { name: "Adjusted_Scoring_Rate", index: 18, type: "number", width: 140, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "Recent_RS_per_9 * Run_Multiplier", exampleValue: "4.84" },
      { name: "Notes", index: 19, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "GAME_SUMMARY",
    description: "One row per game. Aggregates GAME_INTEGRATION to game level.",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "FORMULA", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "NYY" },
      { name: "Away_Pitcher", index: 4, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Brayan Bello" },
      { name: "Home_Pitcher", index: 5, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Gerrit Cole" },
      { name: "Away_Lineup_Strength", index: 6, type: "number", width: 130, format: "0.000", readOnly: true, filledBy: "FORMULA", exampleValue: "108.200" },
      { name: "Home_Lineup_Strength", index: 7, type: "number", width: 130, format: "0.000", readOnly: true, filledBy: "FORMULA", exampleValue: "112.500" },
      { name: "Away_Adjusted_Scoring_Rate", index: 8, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "4.56" },
      { name: "Home_Adjusted_Scoring_Rate", index: 9, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "4.84" },
      { name: "Projected_Away_Runs", index: 10, type: "number", width: 130, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "Away_Adjusted_Scoring_Rate * Away_Expected_Innings / 9", exampleValue: "2.79" },
      { name: "Projected_Home_Runs", index: 11, type: "number", width: 130, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "3.23" },
      { name: "Projected_Total_Runs", index: 12, type: "number", width: 130, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "Projected_Away_Runs + Projected_Home_Runs", exampleValue: "6.02" },
      { name: "Temperature_F", index: 13, type: "number", width: 100, format: "0", readOnly: true, filledBy: "FORMULA", exampleValue: "78" },
      { name: "Wind_MPH", index: 14, type: "number", width: 90, format: "0.0", readOnly: true, filledBy: "FORMULA", exampleValue: "12.5" },
      { name: "Run_Multiplier", index: 15, type: "number", width: 110, format: "0.000", readOnly: true, filledBy: "FORMULA", exampleValue: "1.035" },
      { name: "Stadium", index: 16, type: "string", width: 140, readOnly: true, filledBy: "FORMULA", exampleValue: "Yankee Stadium" },
      { name: "Notes", index: 17, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "PLAYER_INTEGRATION",
    description: "One row per batter. Pulls TODAY_LINEUPS + context from GAME_INTEGRATION.",
    section: "COMPUTATION",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "FORMULA", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "NYY" },
      { name: "Player_Name", index: 3, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Aaron Judge" },
      { name: "Player_ID", index: 4, type: "string", width: 100, readOnly: true, filledBy: "FORMULA", exampleValue: "592450" },
      { name: "Position", index: 5, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "RF" },
      { name: "Batting_Order", index: 6, type: "number", width: 100, format: "0", readOnly: true, filledBy: "FORMULA", exampleValue: "3" },
      { name: "Vs_Pitcher", index: 7, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", exampleValue: "Brayan Bello" },
      { name: "Pitcher_Handedness", index: 8, type: "string", width: 120, readOnly: true, filledBy: "FORMULA", description: "L / R", exampleValue: "R" },
      { name: "Player_vs_Handedness_wRC", index: 9, type: "number", width: 140, format: "0", readOnly: true, filledBy: "FORMULA", description: "VLOOKUP to TODAY_LINEUPS", exampleValue: "172" },
      { name: "Player_Last_30_wRC", index: 10, type: "number", width: 120, format: "0", readOnly: true, filledBy: "FORMULA", exampleValue: "185" },
      { name: "Game_Run_Environment", index: 11, type: "number", width: 130, format: "0.000", readOnly: true, filledBy: "FORMULA", description: "From GAME_SUMMARY Run_Multiplier", exampleValue: "1.035" },
      { name: "Adjusted_wRC_plus", index: 12, type: "number", width: 130, format: "0", readOnly: true, filledBy: "FORMULA", description: "(vs_wRC + Last30_wRC) / 2 * Run_Environment / 100", exampleValue: "184" },
      { name: "Salary", index: 13, type: "currency", width: 100, format: "$#,##0", readOnly: true, filledBy: "FORMULA", exampleValue: "5800" },
      { name: "Projected_FPTS", index: 14, type: "number", width: 110, format: "0.00", filledBy: "FORMULA", description: "Formula or operator input", exampleValue: "42.50" },
      { name: "Notes", index: 15, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  // ─── OUTPUT SECTION ─────────────────────────────────────────────────────────
  {
    name: "SLATE_INPUT",
    description: "Operator input: Vehicle, Line, Odds, Notes. Module 10 seeds with new games.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "MODULE_10", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "MODULE_10", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "MODULE_10", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "MODULE_10", exampleValue: "NYY" },
      { name: "Away_Pitcher", index: 4, type: "string", width: 120, readOnly: true, filledBy: "MODULE_10", exampleValue: "Brayan Bello" },
      { name: "Home_Pitcher", index: 5, type: "string", width: 120, readOnly: true, filledBy: "MODULE_10", exampleValue: "Gerrit Cole" },
      { name: "Candidate_Vehicle", index: 6, type: "string", width: 200, filledBy: "OPERATOR", description: "GAME_TOTAL, SPREAD, O3.5, U8.5, etc.", exampleValue: "GAME_TOTAL" },
      { name: "Line", index: 7, type: "number", width: 100, format: "0.0", filledBy: "OPERATOR", description: "8.5, -115, etc.", exampleValue: "8.5" },
      { name: "Implied_Probability", index: 8, type: "percent", width: 130, format: "0.0%", readOnly: true, filledBy: "FORMULA", description: "Formula from Line", exampleValue: "0.521" },
      { name: "Odds_Decimal", index: 9, type: "number", width: 110, format: "0.000", filledBy: "OPERATOR", description: "1.909, 2.105, etc.", exampleValue: "1.909" },
      { name: "Your_Confidence", index: 10, type: "percent", width: 130, format: "0%", filledBy: "OPERATOR", exampleValue: "0.60" },
      { name: "Projected_Value", index: 11, type: "percent", width: 120, format: "0.00%", readOnly: true, filledBy: "FORMULA", description: "Your_Confidence - Implied_Probability", exampleValue: "0.079" },
      { name: "Model_Confidence", index: 12, type: "percent", width: 130, format: "0%", readOnly: true, filledBy: "FORMULA", description: "From SLATE_BOARD", exampleValue: "0.68" },
      { name: "Notes", index: 13, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
    ],
  },

  {
    name: "SLATE_BOARD",
    description: "Decision output: CORE/NOT_CORE + confidence, based on projections vs lines.",
    section: "OUTPUT",
    frozenRows: 1,
    columns: [
      { name: "Date", index: 0, type: "date", width: 100, format: "mm/dd/yyyy", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026" },
      { name: "Game_ID", index: 1, type: "string", width: 80, readOnly: true, filledBy: "FORMULA", exampleValue: "2026/07/22-NYY-BOS" },
      { name: "Away_Team", index: 2, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "BOS" },
      { name: "Home_Team", index: 3, type: "string", width: 70, readOnly: true, filledBy: "FORMULA", exampleValue: "NYY" },
      { name: "Vehicle_Type", index: 4, type: "string", width: 150, readOnly: true, filledBy: "FORMULA", description: "Game Total, Spread, etc.", exampleValue: "GAME_TOTAL" },
      { name: "Projected_Value", index: 5, type: "string", width: 150, readOnly: true, filledBy: "FORMULA", description: "From GAME_SUMMARY", exampleValue: "6.02" },
      { name: "Market_Line", index: 6, type: "number", width: 100, format: "0.0", readOnly: true, filledBy: "FORMULA", description: "From SLATE_INPUT", exampleValue: "8.5" },
      { name: "Variance_from_Projection", index: 7, type: "number", width: 150, format: "0.00", readOnly: true, filledBy: "FORMULA", description: "Projected - Market", exampleValue: "-2.48" },
      { name: "Decision", index: 8, type: "string", width: 100, readOnly: true, filledBy: "FORMULA", description: "CORE or NOT_CORE", exampleValue: "NOT_CORE" },
      { name: "Confidence", index: 9, type: "percent", width: 110, format: "0%", readOnly: true, filledBy: "FORMULA", description: "Based on variance magnitude", exampleValue: "0.35" },
      { name: "Expected_ROI", index: 10, type: "percent", width: 120, format: "0.0%", readOnly: true, filledBy: "FORMULA", description: "If Decision=CORE, expected ROI", exampleValue: "0.082" },
      { name: "Recommendation", index: 11, type: "string", width: 150, readOnly: true, filledBy: "FORMULA", description: "STRONG_BUY, BUY, HOLD, PASS", exampleValue: "PASS" },
      { name: "Notes", index: 12, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
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
      { name: "Vehicle", index: 4, type: "string", width: 200, readOnly: true, filledBy: "FORMULA", exampleValue: "GAME_TOTAL UNDER 8.5" },
      { name: "Model_Projection", index: 5, type: "number", width: 120, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "6.02" },
      { name: "Market_Line", index: 6, type: "number", width: 100, format: "0.0", readOnly: true, filledBy: "FORMULA", exampleValue: "8.5" },
      { name: "Edge", index: 7, type: "number", width: 90, format: "0.00", readOnly: true, filledBy: "FORMULA", exampleValue: "2.48" },
      { name: "Confidence", index: 8, type: "percent", width: 110, format: "0%", readOnly: true, filledBy: "FORMULA", exampleValue: "0.72" },
      { name: "Recommendation", index: 9, type: "string", width: 150, readOnly: true, filledBy: "FORMULA", description: "STRONG_BUY, BUY, HOLD, PASS", exampleValue: "STRONG_BUY" },
      { name: "Time_Added", index: 10, type: "date", width: 130, format: "mm/dd/yyyy hh:mm:ss", readOnly: true, filledBy: "FORMULA", exampleValue: "07/22/2026 09:00:00" },
      { name: "Status", index: 11, type: "string", width: 100, filledBy: "OPERATOR", description: "PENDING, PLACED, FILLED, WON, LOST, CANCELLED", exampleValue: "PENDING" },
      { name: "Placed_At", index: 12, type: "date", width: 130, format: "mm/dd/yyyy hh:mm:ss", filledBy: "OPERATOR", exampleValue: "" },
      { name: "Result", index: 13, type: "currency", width: 100, format: "+$#,##0", filledBy: "OPERATOR", exampleValue: "" },
      { name: "Notes", index: 14, type: "string", width: 200, filledBy: "OPERATOR", exampleValue: "" },
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
