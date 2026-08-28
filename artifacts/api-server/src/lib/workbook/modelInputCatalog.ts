/**
 * Model Input Catalog
 *
 * One operator-facing dictionary for Frostline's important sources, inputs,
 * active components, projections, and deliberately non-operative fields.
 * It documents what a value means before it is mistaken for a second model
 * vote or a live input.
 */

import {
  addSheet,
  clearRange,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
} from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

export const MODEL_INPUT_CATALOG_SHEET = "MODEL_INPUT_CATALOG";

export const MODEL_INPUT_CATALOG_HEADER = [
  "Record_Type",
  "Canonical_ID",
  "Display_Label",
  "Layer",
  "Output_Class",
  "Operational_Status",
  "Definition",
  "Statistical_Window",
  "Game_Window",
  "Primary_Source",
  "Fallback_Source",
  "Refresh_Cadence",
  "Freshness_Evidence",
  "Current_Observed_Date",
  "Current_Observed_TS",
  "Freshness_State",
  "Workbook_Location",
  "Feeds_Active_Projection",
  "Feeds_Decision_Board",
  "Correlation_Family",
  "Missing_Behavior",
  "Notes",
  "Catalog_Updated_TS",
] as const;

export type ModelInputCatalogRecordType = "SOURCE" | "INPUT" | "PROJECTION" | "GAP";

interface ModelInputCatalogEntry {
  recordType: ModelInputCatalogRecordType;
  id: string;
  label: string;
  layer: "BASEBALL_MODEL" | "MARKET_COMPARATOR" | "SETTLEMENT" | "GOVERNANCE";
  outputClass:
    | "SOURCE"
    | "ACTIVE_INPUT"
    | "ACTIVE_COMPONENT"
    | "ACTIVE_FORECAST"
    | "FROZEN_SNAPSHOT"
    | "SHADOW_CHALLENGER"
    | "DIAGNOSTIC"
    | "REPLAY_COUNTERFACTUAL"
    | "DISPLAY_ONLY"
    | "MISSING_INPUT";
  operationalStatus:
    | "ACTIVE"
    | "SHADOW_ONLY"
    | "FROZEN_HISTORY"
    | "DISPLAY_ONLY"
    | "DECOMMISSIONED_PLACEHOLDER"
    | "MISSING"
    | "FALLBACK_ONLY"
    | "LEGACY_ALIAS";
  definition: string;
  statisticalWindow: string;
  gameWindow: string;
  primarySource: string;
  fallbackSource: string;
  refreshCadence: string;
  freshnessEvidence: string;
  workbookLocation: string;
  feedsActiveProjection: "YES" | "NO";
  feedsDecisionBoard: "YES" | "NO";
  correlationFamily: string;
  missingBehavior: string;
  notes: string;
  freshnessKey?: SourceFreshnessKey;
}

type SourceFreshnessKey =
  | "MLB_SCHEDULE"
  | "STARTER_WORKLOAD"
  | "PITCHER_SEASON"
  | "BATTER_SEASON"
  | "SAVANT_BATTER_SEASON"
  | "TEAM_FORM"
  | "STARTING_NINE_LINEUPS"
  | "STARTING_NINE_PARK"
  | "BULLPEN_REPORT"
  | "INSIDE_THE_PEN"
  | "WEATHER"
  | "SAVANT_PREVIEW"
  | "UMPIRE"
  | "MARKET"
  | "SETTLEMENT"
  | "ACTIVE_PROJECTION"
  | "PREGAME_PACKET";

interface SourceObservation {
  date: string;
  timestamp: string;
  state: string;
}

const SOURCE = (
  id: string,
  label: string,
  primarySource: string,
  refreshCadence: string,
  freshnessEvidence: string,
  notes: string,
  freshnessKey: SourceFreshnessKey,
): ModelInputCatalogEntry => ({
  recordType: "SOURCE",
  id,
  label,
  layer: "GOVERNANCE",
  outputClass: "SOURCE",
  operationalStatus: "ACTIVE",
  definition: "External source used by one or more Frostline inputs.",
  statisticalWindow: "See dependent input rows",
  gameWindow: "See dependent input rows",
  primarySource,
  fallbackSource: "See dependent input rows",
  refreshCadence,
  freshnessEvidence,
  workbookLocation: "Source provenance is frozen in dependent packet fields where available.",
  feedsActiveProjection: "NO",
  feedsDecisionBoard: "NO",
  correlationFamily: "SOURCE",
  missingBehavior: "Dependent input declares its own fallback or gap.",
  notes,
  freshnessKey,
});

const ENTRIES: ModelInputCatalogEntry[] = [
  SOURCE(
    "SOURCE_MLB_SCHEDULE",
    "MLB schedule, identity, probable starters",
    "MLB Stats API schedule",
    "EVERY_PREGAME_RUN",
    "DAILY_MATCHUPS.Date + Pipeline_Last_Updated",
    "Requested slate date is the identity authority; this is not a historical replay source.",
    "MLB_SCHEDULE",
  ),
  SOURCE(
    "SOURCE_MLB_STARTER_WORKLOAD",
    "MLB starter game logs and workload",
    "MLB Stats API person game logs",
    "EVERY_PREGAME_RUN",
    "DAILY_MATCHUPS expected innings/pitches + PREGAME_PACKET_HISTORY",
    "Workload source records data-through date internally; packet preserves the resulting expected workload.",
    "STARTER_WORKLOAD",
  ),
  SOURCE(
    "SOURCE_MLB_PITCHER_SEASON",
    "MLB pitcher season statistics",
    "MLB Stats API season pitching",
    "EVERY_PREGAME_RUN",
    "DAILY_MATCHUPS starter ERA/FIP/K% + GAME_SUMMARY",
    "Season fetch freshness is pipeline-observed; per-pitcher source data-through metadata is not yet preserved.",
    "PITCHER_SEASON",
  ),
  SOURCE(
    "SOURCE_MLB_BATTER_SEASON",
    "MLB batter season statistics",
    "MLB Stats API season hitting plus active roster",
    "EVERY_PREGAME_RUN",
    "PLAYER_INTEGRATION.Date + GAME_SUMMARY lineup status",
    "Roster/name matching coverage is a real dependency; a successful fetch can still leave a player unmatched.",
    "BATTER_SEASON",
  ),
  SOURCE(
    "SOURCE_SAVANT_BATTER_SEASON",
    "Baseball Savant batter season leaderboard",
    "Baseball Savant Statcast leaderboard",
    "EVERY_PREGAME_RUN",
    "GAME_SUMMARY matchup profile status + PLAYER_INTEGRATION",
    "Season xwOBA and hard-hit are active; xBA, xSLG, barrels, and EV are currently display-only.",
    "SAVANT_BATTER_SEASON",
  ),
  SOURCE(
    "SOURCE_MLB_RECENT_SCORING",
    "MLB recent team scoring results",
    "MLB Stats API completed schedules",
    "EVERY_PREGAME_RUN",
    "TEAM_FORM_INPUT.Date + DAILY_MATCHUPS.L30_RS_Observed_TS",
    "L30 and L10 are one correlated realized-scoring family, not two independent confirmations.",
    "TEAM_FORM",
  ),
  SOURCE(
    "SOURCE_STARTING_NINE_LINEUPS",
    "MLB Starting Nine lineups and park factors",
    "mlbstartingnine.com dated lineup page",
    "EVERY_PREGAME_RUN",
    "TODAY_LINEUPS.Date/Notes + RUN_ENVIRONMENT",
    "Lineup coverage and official/projected state must be read per team; partial coverage attenuates active lineup effects.",
    "STARTING_NINE_LINEUPS",
  ),
  SOURCE(
    "SOURCE_STARTING_NINE_BULLPEN",
    "MLB Starting Nine bullpen report",
    "mlbstartingnine.com/reports/bullpens",
    "EVERY_PREGAME_RUN",
    "BULLPEN_USAGE_DAILY.Source_Snapshot_TS + Workload_Source",
    "Daily availability is primary. The fetch timestamp is Frostline-observed, not a parsed source-published timestamp.",
    "BULLPEN_REPORT",
  ),
  SOURCE(
    "SOURCE_INSIDE_THE_PEN",
    "Inside The Pen bullpen workload enrichment",
    "insidethepen.com bullpen report",
    "EVERY_PREGAME_RUN",
    "BULLPEN_USAGE_DAILY.Innings_Last_7_Days + Workload_Source",
    "Enriches seven-day innings history only; it never replaces explicit Starting Nine availability.",
    "INSIDE_THE_PEN",
  ),
  SOURCE(
    "SOURCE_WEATHERMLB",
    "WeatherMLB daily game forecast",
    "WeatherMLB games_{slate date}.json",
    "EVERY_PREGAME_RUN",
    "RUN_ENVIRONMENT.Date + DAILY_MATCHUPS.Weather_Source",
    "Fallback conditions are synthetic and must remain visibly fallback/low-certainty evidence.",
    "WEATHER",
  ),
  SOURCE(
    "SOURCE_SAVANT_PREVIEW",
    "Baseball Savant game preview",
    "baseballsavant.mlb.com/preview",
    "EVERY_PREGAME_RUN_WHEN_PUBLISHED",
    "STATCAST_GAME_PREVIEW.Fetch_TS/Availability/Parser_Version",
    "Preview remains shadow-only. NOT_PUBLISHED is an evidence gap, not a zero signal.",
    "SAVANT_PREVIEW",
  ),
  SOURCE(
    "SOURCE_MLB_UMPIRE",
    "MLB plate-umpire assignment",
    "MLB Stats API boxscore",
    "EVERY_PREGAME_RUN",
    "DAILY_MATCHUPS.Plate_Umpire",
    "Display/provenance only today; missing assignment is legitimate before publication.",
    "UMPIRE",
  ),
  SOURCE(
    "SOURCE_MARKET_TOTALS",
    "Market total snapshots",
    "MLB Starting Nine totals; The Odds API fallback",
    "EVERY_PREGAME_RUN",
    "ODDS_HISTORY.Snapshot_TS_UTC + SLATE_INPUT authoritative market fields",
    "Market is downstream execution context only. First Frostline observation is not necessarily the market opener.",
    "MARKET",
  ),
  SOURCE(
    "SOURCE_MLB_FINALS",
    "Official finals and boxscores",
    "MLB Stats API final/boxscore/linescore",
    "DAILY_SETTLEMENT",
    "SHADOW_OUTCOMES settlement timestamps + postgame diagnostic tabs",
    "Settlement may grade only a legitimate frozen pregame packet; it may not reconstruct one.",
    "SETTLEMENT",
  ),

  {
    recordType: "INPUT", id: "GAME_IDENTITY", label: "Game identity, first pitch, starter identity",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Canonical away/home, venue, scheduled first pitch, game status, and probable starter identity.",
    statisticalWindow: "Requested slate date", gameWindow: "FULL_GAME",
    primarySource: "SOURCE_MLB_SCHEDULE", fallbackSource: "NONE",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "DAILY_MATCHUPS.Date/Game_ID/Pipeline_Last_Updated",
    workbookLocation: "DAILY_MATCHUPS A:K", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "IDENTITY", missingBehavior: "No game-level projection publication after first pitch without a legitimate packet.",
    notes: "This is the lineage root for every projection and freeze.", freshnessKey: "MLB_SCHEDULE",
  },
  {
    recordType: "INPUT", id: "STARTER_WORKLOAD", label: "Starter role and expected workload",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Expected pitches/innings and starter role; determines the starter window and inherited bullpen window.",
    statisticalWindow: "L30 primary game-log workload through slate date minus one; L60 return detector; L14/season stored but inactive",
    gameWindow: "STARTER_WINDOW -> BULLPEN_WINDOW", primarySource: "SOURCE_MLB_STARTER_WORKLOAD", fallbackSource: "Role defaults (6.0 conventional / 3.0 bulk / 1.2 opener / 5.5 missing)",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "DAILY_MATCHUPS L:O + PREGAME_PACKET_HISTORY Away/Home_Expected_IP",
    workbookLocation: "DAILY_MATCHUPS L:O; PREGAME_PACKET_HISTORY AD:AE", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "STARTER_WORKLOAD", missingBehavior: "Explicit unresolved/default workload; never a postgame reconstruction.",
    notes: "Workload is not a generic pitcher-success label.", freshnessKey: "STARTER_WORKLOAD",
  },
  {
    recordType: "INPUT", id: "LINEUP_IDENTITY", label: "Exact lineup identity, order, hand, coverage",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Posted/projected hitters, batting order, handedness, and coverage used to build team allocation and exact matchup profiles.",
    statisticalWindow: "Current slate only", gameWindow: "TEAM_ALLOCATION + STARTER_WINDOW",
    primarySource: "SOURCE_STARTING_NINE_LINEUPS", fallbackSource: "Projected lineup with 60% lineup confidence; generic lineup factor when incomplete",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "TODAY_LINEUPS A:N + GAME_SUMMARY lineup/matchup status",
    workbookLocation: "TODAY_LINEUPS; GAME_SUMMARY Away/Home_Lineup_*", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "LINEUP_QUALITY", missingBehavior: "PARTIAL attenuates; NEUTRAL means exact profile unavailable.",
    notes: "Officialness must be evaluated separately for each side.", freshnessKey: "STARTING_NINE_LINEUPS",
  },
  {
    recordType: "INPUT", id: "BATTER_SEASON_QUALITY", label: "Season OPS/OBP/SLG and BB%/K%",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Season hitter quality, batting-order weighted; OPS anchors lineup quality while BB%/K% feed traffic.",
    statisticalWindow: "Season to date; minimum 50 PA for lineup-quality use", gameWindow: "TEAM_ALLOCATION + STARTER_WINDOW",
    primarySource: "SOURCE_MLB_BATTER_SEASON", fallbackSource: "Coverage-weighted generic lineup value",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "PLAYER_INTEGRATION Date/Notes; GAME_SUMMARY lineup factor",
    workbookLocation: "PLAYER_INTEGRATION; GAME_SUMMARY lineup factors", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "LINEUP_QUALITY", missingBehavior: "Insufficient coverage reduces lineup confidence and exact-profile activation.",
    notes: "Do not treat OPS and later traffic terms as independent votes.", freshnessKey: "BATTER_SEASON",
  },
  {
    recordType: "INPUT", id: "SAVANT_SEASON_CONTACT", label: "Season xwOBA and hard-hit rate",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Season Statcast xwOBA contributes to lineup quality; hard-hit rate contributes to damage only.",
    statisticalWindow: "Season to date; minimum 50 PA", gameWindow: "TEAM_ALLOCATION + STARTER_WINDOW",
    primarySource: "SOURCE_SAVANT_BATTER_SEASON", fallbackSource: "OPS-only lineup quality; NEUTRAL damage profile",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "GAME_SUMMARY matchup profile status + PLAYER_INTEGRATION",
    workbookLocation: "GAME_SUMMARY matchup factors; PLAYER_INTEGRATION", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "LINEUP_QUALITY / DAMAGE", missingBehavior: "No exact candidate effect when lineup/profile coverage is insufficient.",
    notes: "xBA, xSLG, barrel rate, and exit velocity are fetched but not active.", freshnessKey: "SAVANT_BATTER_SEASON",
  },
  {
    recordType: "INPUT", id: "RECENT_SCORING_FORM", label: "Recent realized team scoring form",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "L30 and L10 actual runs scored per game blended into a bounded form multiplier; not the offense center.",
    statisticalWindow: "L30: trailing 30 calendar days, max 30 finals, min 15; L10: last 10 finals within 15 days, min 5",
    gameWindow: "FULL_GAME_CENTER + TEAM_ALLOCATION", primarySource: "SOURCE_MLB_RECENT_SCORING", fallbackSource: "L10-only or league-average form modifier",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "TEAM_FORM_INPUT A:D + DAILY_MATCHUPS L30_RS_Observed_TS",
    workbookLocation: "TEAM_FORM_INPUT; GAME_SUMMARY Away/Home_Recent_Form_Multiplier", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "RECENT_REALIZED_SCORING", missingBehavior: "Bounded neutral/fallback form; no synthetic wOBA or SOS substitute.",
    notes: "L30 and L10 are correlated inputs within one form family.", freshnessKey: "TEAM_FORM",
  },
  {
    recordType: "INPUT", id: "STARTER_RUN_PREVENTION", label: "Starter run-prevention quality",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "FIP primary, ERA fallback; applies the central starter-quality multiplier over effective starter innings.",
    statisticalWindow: "Season to date", gameWindow: "STARTER_WINDOW",
    primarySource: "SOURCE_MLB_PITCHER_SEASON", fallbackSource: "Neutral league baseline factor",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "DAILY_MATCHUPS AK:AP + GAME_SUMMARY starter components",
    workbookLocation: "DAILY_MATCHUPS AK:AP; GAME_SUMMARY Starter_Attack_Runs", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "STARTER_QUALITY", missingBehavior: "Neutral baseline rather than fabricated pitcher quality.",
    notes: "FIP contains some BB/K/HR information; companion traffic/damage fields are related, not independent votes.", freshnessKey: "PITCHER_SEASON",
  },
  {
    recordType: "INPUT", id: "STARTER_TRAFFIC", label: "Starter command/traffic pressure",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Lineup BB%/K% versus starter BB%/K%/WHIP; first shortens workload and expands bullpen exposure.",
    statisticalWindow: "Season to date for lineup and pitcher", gameWindow: "STARTER_WINDOW -> BULLPEN_WINDOW",
    primarySource: "SOURCE_MLB_BATTER_SEASON + SOURCE_MLB_PITCHER_SEASON", fallbackSource: "NEUTRAL exact matchup profile",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "GAME_SUMMARY Traffic_Matchup_Factor/Effective_IP/Bullpen_Exposure",
    workbookLocation: "GAME_SUMMARY traffic/effective-IP/bullpen-exposure fields", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "STARTER_TRAFFIC", missingBehavior: "No positive direct traffic runs without exact profile and damage co-sign.",
    notes: "Traffic is not synonymous with runs.", freshnessKey: "BATTER_SEASON",
  },
  {
    recordType: "INPUT", id: "STARTER_DAMAGE", label: "Starter damage pressure",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Lineup hard-hit rate versus starter HR/9; creates bounded signed damage runs and can shorten workload.",
    statisticalWindow: "Season to date", gameWindow: "STARTER_WINDOW -> BULLPEN_WINDOW",
    primarySource: "SOURCE_SAVANT_BATTER_SEASON + SOURCE_MLB_PITCHER_SEASON", fallbackSource: "NEUTRAL exact matchup profile",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "GAME_SUMMARY Damage_Matchup_Factor + HR_XBH_Damage_Runs",
    workbookLocation: "GAME_SUMMARY damage component fields", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "STARTER_DAMAGE", missingBehavior: "NEUTRAL when exact lineup/starter evidence is incomplete.",
    notes: "Damage is a component, not a separate projection.", freshnessKey: "SAVANT_BATTER_SEASON",
  },
  {
    recordType: "INPUT", id: "BULLPEN_AVAILABILITY", label: "Daily bullpen availability and pitch workload",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "AVAILABLE/TIRED/UNAVAILABLE controls who enters the active bullpen-quality pool; L5 and five-day pitches provide preserved workload context.",
    statisticalWindow: "Current daily availability; 5-day appearance/pitch map", gameWindow: "BULLPEN_WINDOW",
    primarySource: "SOURCE_STARTING_NINE_BULLPEN", fallbackSource: "UNKNOWN availability / generic bullpen baseline",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "BULLPEN_USAGE_DAILY M:U including Source_Snapshot_TS",
    workbookLocation: "BULLPEN_USAGE_DAILY; PREGAME_PACKET_HISTORY bullpen state", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "BULLPEN_AVAILABILITY", missingBehavior: "Explicit unknown/degraded state; no invented rested arm.",
    notes: "Individual pitch counts are preserved context; availability status is the current active gate.", freshnessKey: "BULLPEN_REPORT",
  },
  {
    recordType: "INPUT", id: "BULLPEN_QUALITY", label: "Available-bullpen season ERA and workload weighting",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Available relievers' season ERA, weighted by L7 innings history or L5 appearances fallback, applied to inherited bullpen innings.",
    statisticalWindow: "Season ERA; prior 7 days innings/games, L5 appearance fallback", gameWindow: "BULLPEN_WINDOW",
    primarySource: "SOURCE_MLB_PITCHER_SEASON + SOURCE_INSIDE_THE_PEN", fallbackSource: "L5 appearances / neutral bullpen factor",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "BULLPEN_USAGE_DAILY E:F, J:U + GAME_SUMMARY bullpen continuation",
    workbookLocation: "BULLPEN_USAGE_DAILY; GAME_SUMMARY Bullpen_Continuation_Runs", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "BULLPEN_QUALITY", missingBehavior: "Minimum-arm requirement or neutral baseline.",
    notes: "Reliever WHIP and role importance remain display-only today.", freshnessKey: "INSIDE_THE_PEN",
  },
  {
    recordType: "INPUT", id: "PARK_ENVIRONMENT", label: "Park run factor",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Venue run multiplier applied after baseball-only team runs; environment modifies but does not originate game truth.",
    statisticalWindow: "Current seasonal park factor", gameWindow: "ENVIRONMENT / FULL_GAME",
    primarySource: "SOURCE_STARTING_NINE_LINEUPS", fallbackSource: "Static seasonal park map / neutral unresolved venue",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "RUN_ENVIRONMENT Stadium/Run_Multiplier + GAME_SUMMARY Park_Source_Status",
    workbookLocation: "RUN_ENVIRONMENT; GAME_SUMMARY environment lineage", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "ENVIRONMENT", missingBehavior: "Neutral/low-certainty state; no false HIGH certainty.",
    notes: "Combined HR factor is displayed but not a separate active run effect.", freshnessKey: "STARTING_NINE_PARK",
  },
  {
    recordType: "INPUT", id: "WEATHER_ROOF", label: "Weather, roof, wind, humidity, rain",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_INPUT", operationalStatus: "ACTIVE",
    definition: "Daily weather context produces one bounded common environment multiplier after baseball-only team totals.",
    statisticalWindow: "Current forecast for scheduled game", gameWindow: "ENVIRONMENT / FULL_GAME",
    primarySource: "SOURCE_WEATHERMLB", fallbackSource: "Visible synthetic climatology fallback / neutral environment",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "RUN_ENVIRONMENT A:L + DAILY_MATCHUPS Weather_Source",
    workbookLocation: "RUN_ENVIRONMENT; GAME_SUMMARY Environment_Run_Adjustment", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "ENVIRONMENT", missingBehavior: "Fallback must stay low-certainty and visibly synthetic.",
    notes: "Positive environment addition is capped at 1.5 total runs.", freshnessKey: "WEATHER",
  },

  {
    recordType: "PROJECTION", id: "ACTIVE_GAME_FORECAST", label: "Active game projection (away / home / total)",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_FORECAST", operationalStatus: "ACTIVE",
    definition: "The sole active price-blind Frostline forecast: projected away runs, home runs, and their total.",
    statisticalWindow: "Current frozen pregame inputs", gameWindow: "FULL_GAME + TEAM_ALLOCATION",
    primarySource: "Active Module 09 calculation", fallbackSource: "NONE",
    refreshCadence: "EVERY_PREGAME_RUN before first pitch", freshnessEvidence: "GAME_SUMMARY Date/Game_ID/Run_ID",
    workbookLocation: "GAME_SUMMARY.Projected_Away_Runs/Projected_Home_Runs/Projected_Total_Runs", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "ACTIVE_FORECAST", missingBehavior: "No prospective publication after first pitch; audit gap if none existed.",
    notes: "All other totals in this catalog are components, frozen copies, challengers, or diagnostics.", freshnessKey: "ACTIVE_PROJECTION",
  },
  {
    recordType: "PROJECTION", id: "ACTIVE_BASEBALL_SUBTOTAL", label: "Active baseball-only subtotal",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_COMPONENT", operationalStatus: "ACTIVE",
    definition: "Active team-run subtotal before park/weather multiplier, not an independent forecast.",
    statisticalWindow: "Current active inputs", gameWindow: "FULL_GAME before environment",
    primarySource: "Active Module 09 calculation", fallbackSource: "NONE",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "GAME_SUMMARY.Baseball_Only_Projection",
    workbookLocation: "GAME_SUMMARY.Baseball_Only_Projection", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "ACTIVE_FORECAST", missingBehavior: "Not applicable; it reconciles to active total after environment.",
    notes: "Display alias: Active_Baseball_Subtotal. Do not count it as another model.", freshnessKey: "ACTIVE_PROJECTION",
  },
  {
    recordType: "PROJECTION", id: "ACTIVE_COMPONENTS", label: "Active starter, traffic, damage, bullpen, environment components",
    layer: "BASEBALL_MODEL", outputClass: "ACTIVE_COMPONENT", operationalStatus: "ACTIVE",
    definition: "Starter attack + traffic conversion + HR/XBH damage + bullpen continuation = baseball subtotal; environment then modifies both teams.",
    statisticalWindow: "Current active inputs", gameWindow: "STARTER_WINDOW + BULLPEN_WINDOW + ENVIRONMENT",
    primarySource: "Active Module 09 calculation", fallbackSource: "Neutral component states",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "GAME_SUMMARY component and matchup-profile fields",
    workbookLocation: "GAME_SUMMARY Starter_Attack_Runs through Environment_Run_Adjustment", feedsActiveProjection: "YES", feedsDecisionBoard: "YES",
    correlationFamily: "ACTIVE_FORECAST", missingBehavior: "NEUTRAL exact-profile status is an evidence gap, not a conclusion.",
    notes: "Components reconcile the active forecast; they do not vote independently.", freshnessKey: "ACTIVE_PROJECTION",
  },
  {
    recordType: "PROJECTION", id: "FROZEN_ACTIVE_FORECAST", label: "Frozen active forecast at publication",
    layer: "BASEBALL_MODEL", outputClass: "FROZEN_SNAPSHOT", operationalStatus: "FROZEN_HISTORY",
    definition: "Immutable capture of the active forecast and dependent packet that legitimately existed before first pitch.",
    statisticalWindow: "One prospective snapshot", gameWindow: "FULL_GAME + provenance",
    primarySource: "ACTIVE_GAME_FORECAST", fallbackSource: "NONE",
    refreshCadence: "OPEN pregame; immutable at first pitch", freshnessEvidence: "PREGAME_PACKET_HISTORY Packet_Status/Freeze_TS; VEHICLE_LOG; SHADOW_OUTCOMES Frozen_Published_Total",
    workbookLocation: "PREGAME_PACKET_HISTORY; VEHICLE_LOG; DECISION_AUDIT_LOG; SHADOW_OUTCOMES", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "ACTIVE_FORECAST", missingBehavior: "PREGAME_FREEZE_MISSING/AUDIT_GAP; never replay output.",
    notes: "Display alias for Base_Projection: Active_Total_At_Snapshot.", freshnessKey: "PREGAME_PACKET",
  },
  {
    recordType: "PROJECTION", id: "STATCAST_XWOBA_SHADOW", label: "Statcast xwOBA shadow total",
    layer: "BASEBALL_MODEL", outputClass: "SHADOW_CHALLENGER", operationalStatus: "SHADOW_ONLY",
    definition: "Preview-driven xwOBA-only shadow candidate.",
    statisticalWindow: "Current published game preview", gameWindow: "FULL_GAME",
    primarySource: "SOURCE_SAVANT_PREVIEW", fallbackSource: "Explicit source unavailable state",
    refreshCadence: "EVERY_PREGAME_RUN_WHEN_PUBLISHED", freshnessEvidence: "STATCAST_GAME_PREVIEW Fetch_TS; STATCAST_SHADOW_AUDIT",
    workbookLocation: "STATCAST_SHADOW_AUDIT.Shadow_Projection", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "STATCAST_COLLISION", missingBehavior: "SOURCE_UNAVAILABLE / INSUFFICIENT_INPUT; never neutralized.",
    notes: "Display alias: Statcast_xwOBA_Shadow_Total.", freshnessKey: "SAVANT_PREVIEW",
  },
  {
    recordType: "PROJECTION", id: "COLLISION_COMBINED_SHADOW", label: "Combined collision shadow total",
    layer: "BASEBALL_MODEL", outputClass: "SHADOW_CHALLENGER", operationalStatus: "SHADOW_ONLY",
    definition: "xwOBA plus capped traffic/damage tail candidate used only for prospective replay.",
    statisticalWindow: "Current preview plus active matchup evidence", gameWindow: "FULL_GAME distribution",
    primarySource: "SOURCE_SAVANT_PREVIEW", fallbackSource: "Explicit incomplete candidate state",
    refreshCadence: "EVERY_PREGAME_RUN_WHEN_PUBLISHED", freshnessEvidence: "STATCAST_SHADOW_AUDIT Estimated_Projection + Collision_Calibration_History",
    workbookLocation: "STATCAST_SHADOW_AUDIT.Estimated_Projection", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "STATCAST_COLLISION", missingBehavior: "No candidate promotion from unavailable or incomplete rows.",
    notes: "Display alias: Collision_Combined_Shadow_Total.", freshnessKey: "SAVANT_PREVIEW",
  },
  {
    recordType: "PROJECTION", id: "LOW_CENTER_FIXED_SHADOWS", label: "Low-center +1.5 / +2.0 fixed challengers",
    layer: "BASEBALL_MODEL", outputClass: "SHADOW_CHALLENGER", operationalStatus: "SHADOW_ONLY",
    definition: "Fixed mean-lift experiments for sub-8 active projections.",
    statisticalWindow: "Current prospective low-center state", gameWindow: "FULL_GAME distribution",
    primarySource: "Active total + historical low-center diagnostic", fallbackSource: "No challenger when eligibility/input is absent",
    refreshCadence: "EVERY_PREGAME_RUN for eligible games", freshnessEvidence: "STATCAST_SHADOW_AUDIT + LOW_CENTER_CALIBRATION_HISTORY",
    workbookLocation: "Low_Center_Challenger_Projection; Low_Center_Sensitivity_Projection", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "LOW_CENTER", missingBehavior: "Explicit insufficient/source status.",
    notes: "Display aliases: Fixed_+1.5_Shadow_Total and Fixed_+2.0_Sensitivity_Total.",
  },
  {
    recordType: "PROJECTION", id: "LOW_CENTER_TAIL_BAND", label: "Low-center upper-tail band",
    layer: "BASEBALL_MODEL", outputClass: "DIAGNOSTIC", operationalStatus: "SHADOW_ONLY",
    definition: "Distribution warning for low-center games; not a point forecast.",
    statisticalWindow: "Historical low-center residual tail", gameWindow: "FULL_GAME distribution",
    primarySource: "LOW_CENTER calibration", fallbackSource: "No band when history insufficient",
    refreshCadence: "EVERY_PREGAME_RUN for eligible games", freshnessEvidence: "STATCAST_SHADOW_AUDIT Low_Center_Upper_Tail_Band",
    workbookLocation: "STATCAST_SHADOW_AUDIT", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "LOW_CENTER", missingBehavior: "No inference from missing band.",
    notes: "Signals width/asymmetry, not a mandatory mean increase.",
  },
  {
    recordType: "PROJECTION", id: "SSAT_FAMILY", label: "Starter survival challenger family (V1/V2)",
    layer: "BASEBALL_MODEL", outputClass: "SHADOW_CHALLENGER", operationalStatus: "SHADOW_ONLY",
    definition: "Four-state starter workload/failure challenger and empirical variant, retained as one correlated evidence family.",
    statisticalWindow: "V1 projected workload proxy; V2 strictly earlier settled cohort evidence", gameWindow: "STARTER_WINDOW -> BULLPEN_WINDOW -> FULL_GAME",
    primarySource: "STARTER_SURVIVAL_CALIBRATION_HISTORY / V2", fallbackSource: "Explicit insufficient input; V2 never silently uses V1 proxy",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "STARTER_SURVIVAL_* history + differentiation audit",
    workbookLocation: "SSAT V1/V2 history and report tabs", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "SSAT", missingBehavior: "Candidate gap, not a baseball conclusion.",
    notes: "Do not count V1 and V2 as two independent confirmations.",
  },
  {
    recordType: "PROJECTION", id: "MARKET_COMPARATOR", label: "Market line, edge, direction, decision",
    layer: "MARKET_COMPARATOR", outputClass: "DIAGNOSTIC", operationalStatus: "ACTIVE",
    definition: "Compares the finished baseball forecast with an executable/frozen market line; never creates baseball truth.",
    statisticalWindow: "Current/frozen observed market snapshot", gameWindow: "MARKET_ONLY",
    primarySource: "SOURCE_MARKET_TOTALS", fallbackSource: "Operator supplied executable market",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "ODDS_HISTORY + SLATE_INPUT authoritative market fields",
    workbookLocation: "SLATE_INPUT; SLATE_BOARD; ACTIVE_BOARD_SNAPSHOT", feedsActiveProjection: "NO", feedsDecisionBoard: "YES",
    correlationFamily: "MARKET", missingBehavior: "MARKET_SNAPSHOT_MISSING; no current-line substitution at settlement.",
    notes: "Price sizes execution; it does not change game truth.", freshnessKey: "MARKET",
  },
  {
    recordType: "PROJECTION", id: "PROJECTION_REPLAY_LEGACY_ALIASES", label: "Legacy PROJECTION_REPLAY variant columns",
    layer: "SETTLEMENT", outputClass: "REPLAY_COUNTERFACTUAL", operationalStatus: "LEGACY_ALIAS",
    definition: "Historical headers that currently receive the same frozen-published total rather than independent model variants.",
    statisticalWindow: "Preserved prospective frozen total", gameWindow: "SETTLEMENT",
    primarySource: "FROZEN_ACTIVE_FORECAST", fallbackSource: "NONE",
    refreshCadence: "DAILY_SETTLEMENT", freshnessEvidence: "PROJECTION_REPLAY Frozen_Published_Source/Replay_Run_TS",
    workbookLocation: "PROJECTION_REPLAY Legacy/L30/Blend columns", feedsActiveProjection: "NO", feedsDecisionBoard: "NO",
    correlationFamily: "ACTIVE_FORECAST", missingBehavior: "Blank when frozen snapshot unavailable.",
    notes: "Do not interpret duplicated legacy columns as separate forecasts; real counterfactual variants belong in REPLAY_RESULTS.",
  },

  {
    recordType: "GAP", id: "PLACEHOLDER_TEAM_FORM", label: "Deprecated TEAM_FORM placeholders",
    layer: "GOVERNANCE", outputClass: "DISPLAY_ONLY", operationalStatus: "DECOMMISSIONED_PLACEHOLDER",
    definition: "Last_10_wOBA, Recent_Strength_of_Schedule, and Bullpen_Rest_Days were synthetic/display-only values.",
    statisticalWindow: "None", gameWindow: "NONE", primarySource: "NONE", fallbackSource: "NONE",
    refreshCadence: "NOT_APPLICABLE", freshnessEvidence: "TEAM_FORM_INPUT E:G are intentionally blank", workbookLocation: "TEAM_FORM_INPUT E:G",
    feedsActiveProjection: "NO", feedsDecisionBoard: "NO", correlationFamily: "NONE",
    missingBehavior: "Blank until a real source and commissioned use exist.",
    notes: "Removed to prevent pretty-but-false evidence.",
  },
  {
    recordType: "GAP", id: "DISPLAY_ONLY_SAVANT_FIELDS", label: "Retrieved Statcast fields not yet active",
    layer: "GOVERNANCE", outputClass: "DISPLAY_ONLY", operationalStatus: "DISPLAY_ONLY",
    definition: "xBA, xSLG, barrel rate, and exit velocity are retrievable but have no active projection consumer.",
    statisticalWindow: "Season to date", gameWindow: "NONE", primarySource: "SOURCE_SAVANT_BATTER_SEASON", fallbackSource: "NONE",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "Statcast batter fetch + catalog status", workbookLocation: "Internal Statcast batter payload",
    feedsActiveProjection: "NO", feedsDecisionBoard: "NO", correlationFamily: "STATCAST_CONTACT",
    missingBehavior: "Do not infer a model effect from availability.",
    notes: "Commission only after a replay-backed dependency design exists.", freshnessKey: "SAVANT_BATTER_SEASON",
  },
  {
    recordType: "GAP", id: "DISPLAY_ONLY_STARTER_CONTEXT", label: "Starter L14/season workload, prior outing stress, umpire",
    layer: "GOVERNANCE", outputClass: "DISPLAY_ONLY", operationalStatus: "DISPLAY_ONLY",
    definition: "Useful context that is stored or fetchable but does not currently modify active projected runs.",
    statisticalWindow: "L14/season workload; latest prior outing; current assignment", gameWindow: "NONE",
    primarySource: "SOURCE_MLB_STARTER_WORKLOAD + SOURCE_MLB_UMPIRE", fallbackSource: "NONE",
    refreshCadence: "EVERY_PREGAME_RUN", freshnessEvidence: "DAILY_MATCHUPS Z:AJ", workbookLocation: "DAILY_MATCHUPS prior-outing/umpire fields",
    feedsActiveProjection: "NO", feedsDecisionBoard: "NO", correlationFamily: "STARTER_CONTEXT",
    missingBehavior: "Visible context only; no fake coefficient.",
    notes: "These are candidates for future evidence review, not current inputs.", freshnessKey: "UMPIRE",
  },
  {
    recordType: "GAP", id: "MISSING_ALLOCATION_INPUTS", label: "Unmodeled allocation inputs",
    layer: "GOVERNANCE", outputClass: "MISSING_INPUT", operationalStatus: "MISSING",
    definition: "No active batter-vs-hand performance split, home/away offensive split, defense, baserunning, catcher/framing, or umpire effect.",
    statisticalWindow: "Not currently sourced/commissioned", gameWindow: "TEAM_ALLOCATION",
    primarySource: "NONE", fallbackSource: "Existing lineup/quality model", refreshCadence: "NOT_APPLICABLE",
    freshnessEvidence: "MODEL_INPUT_CATALOG gap record", workbookLocation: "No active workbook field",
    feedsActiveProjection: "NO", feedsDecisionBoard: "NO", correlationFamily: "ALLOCATION_GAPS",
    missingBehavior: "Must not be simulated by a proxy without an explicit commission.",
    notes: "This is a known model boundary, not a hidden zero.",
  },
];

interface SheetTable {
  headers: string[];
  rows: unknown[][];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header === name);
}

function canonicalDate(value: unknown): string {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  return "";
}

async function readTable(workbookId: string, range: string): Promise<SheetTable> {
  try {
    const values = (await readRange(workbookId, range)).values ?? [];
    const rows = values as unknown[][];
    return { headers: (rows[0] ?? []).map(text), rows: rows.slice(1) };
  } catch {
    return { headers: [], rows: [] };
  }
}

function rowsForDate(table: SheetTable, date: string): unknown[][] {
  const index = headerIndex(table.headers, "Date");
  return index < 0 ? [] : table.rows.filter((row) => canonicalDate(row[index]) === date);
}

function latestValue(rows: unknown[][], headers: string[], field: string): string {
  const index = headerIndex(headers, field);
  if (index < 0) return "";
  return rows.map((row) => text(row[index])).filter(Boolean).sort().at(-1) ?? "";
}

/**
 * Schema repair also runs from settlement. Preserve the last pregame
 * materialization observation in that case: settlement has no business
 * erasing a truthful pregame freshness record simply because it did not
 * receive a slate date.
 */
function preservedObservations(table: SheetTable): Map<SourceFreshnessKey, SourceObservation> {
  const idIndex = headerIndex(table.headers, "Canonical_ID");
  const dateIndex = headerIndex(table.headers, "Current_Observed_Date");
  const timestampIndex = headerIndex(table.headers, "Current_Observed_TS");
  const stateIndex = headerIndex(table.headers, "Freshness_State");
  const byId = new Map(ENTRIES.map((entry) => [entry.id, entry]));
  const observations = new Map<SourceFreshnessKey, SourceObservation>();

  if (idIndex < 0 || dateIndex < 0 || timestampIndex < 0 || stateIndex < 0) {
    return observations;
  }

  for (const row of table.rows) {
    const entry = byId.get(text(row[idIndex]));
    if (!entry?.freshnessKey) continue;
    const state = text(row[stateIndex]);
    if (!state || state === "NOT_OBSERVED_IN_THIS_WRITE") continue;
    observations.set(entry.freshnessKey, {
      date: text(row[dateIndex]),
      timestamp: text(row[timestampIndex]),
      state,
    });
  }

  return observations;
}

function observation(date: string, rows: unknown[][], headers: string[], timestampField?: string): SourceObservation {
  return {
    date: rows.length > 0 ? date : "",
    timestamp: timestampField ? latestValue(rows, headers, timestampField) : "",
    state: rows.length > 0 ? `CURRENT_MATERIALIZED (${rows.length})` : "NOT_MATERIALIZED_FOR_SLATE",
  };
}

async function collectSourceObservations(
  workbookId: string,
  date: string,
): Promise<Map<SourceFreshnessKey, SourceObservation>> {
  const [daily, lineups, teamForm, bullpen, environment, preview, odds, player, outcomes, gameSummary, packet] = await Promise.all([
    readTable(workbookId, "DAILY_MATCHUPS!A1:AU100"),
    readTable(workbookId, "TODAY_LINEUPS!A1:N1000"),
    readTable(workbookId, "TEAM_FORM_INPUT!A1:H100"),
    readTable(workbookId, "BULLPEN_USAGE_DAILY!A1:U500"),
    readTable(workbookId, "RUN_ENVIRONMENT!A1:L100"),
    readTable(workbookId, "STATCAST_GAME_PREVIEW!A1:BC100"),
    readTable(workbookId, "ODDS_HISTORY!A1:G5000"),
    readTable(workbookId, "PLAYER_INTEGRATION!A1:P1000"),
    readTable(workbookId, "SHADOW_OUTCOMES!A1:AZ5000"),
    readTable(workbookId, "GAME_SUMMARY!A1:BS100"),
    readTable(workbookId, "PREGAME_PACKET_HISTORY!A1:BS5000"),
  ]);
  const dailyRows = rowsForDate(daily, date);
  const lineupsRows = rowsForDate(lineups, date);
  const teamFormRows = rowsForDate(teamForm, date);
  const bullpenRows = rowsForDate(bullpen, date);
  const environmentRows = rowsForDate(environment, date);
  const previewRows = rowsForDate(preview, date);
  const oddsDateIndex = headerIndex(odds.headers, "Date");
  const oddsRows = oddsDateIndex < 0 ? [] : odds.rows.filter((row) => canonicalDate(row[oddsDateIndex]) === date);
  const playerRows = rowsForDate(player, date);
  const outcomeRows = rowsForDate(outcomes, date);
  const gameSummaryRows = rowsForDate(gameSummary, date);
  const packetRows = rowsForDate(packet, date);
  const pipelineTs = latestValue(dailyRows, daily.headers, "Pipeline_Last_Updated");

  const observations = new Map<SourceFreshnessKey, SourceObservation>();
  observations.set("MLB_SCHEDULE", observation(date, dailyRows, daily.headers, "Pipeline_Last_Updated"));
  observations.set("STARTER_WORKLOAD", observation(date, dailyRows, daily.headers, "Pipeline_Last_Updated"));
  observations.set("PITCHER_SEASON", observation(date, dailyRows, daily.headers, "Pipeline_Last_Updated"));
  observations.set("BATTER_SEASON", {
    ...observation(date, playerRows, player.headers), timestamp: pipelineTs,
  });
  observations.set("SAVANT_BATTER_SEASON", {
    ...observation(date, playerRows, player.headers), timestamp: pipelineTs,
  });
  observations.set("TEAM_FORM", observation(date, teamFormRows, teamForm.headers));
  const lineupStatusIndex = headerIndex(lineups.headers, "Notes");
  const lineupMissing = lineupStatusIndex >= 0 && lineupsRows.some((row) => /NO_LINEUP_DATA/i.test(text(row[lineupStatusIndex])));
  observations.set("STARTING_NINE_LINEUPS", {
    ...observation(date, lineupsRows, lineups.headers), timestamp: pipelineTs,
    state: lineupsRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : lineupMissing ? `PARTIAL_MATERIALIZED (${lineupsRows.length})` : `CURRENT_MATERIALIZED (${lineupsRows.length})`,
  });
  observations.set("STARTING_NINE_PARK", {
    ...observation(date, environmentRows, environment.headers), timestamp: pipelineTs,
  });
  const sourceIndex = headerIndex(bullpen.headers, "Workload_Source");
  const primaryBullpen = sourceIndex >= 0 && bullpenRows.some((row) => /MLBSTARTINGNINE_BULLPEN_REPORT/.test(text(row[sourceIndex])));
  observations.set("BULLPEN_REPORT", {
    ...observation(date, bullpenRows, bullpen.headers, "Source_Snapshot_TS"),
    state: bullpenRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : primaryBullpen ? `CURRENT_MATERIALIZED (${bullpenRows.length})` : `FALLBACK_MATERIALIZED (${bullpenRows.length})`,
  });
  observations.set("INSIDE_THE_PEN", {
    ...observation(date, bullpenRows, bullpen.headers, "Source_Snapshot_TS"),
    state: bullpenRows.length > 0 ? `CURRENT_ENRICHMENT_MATERIALIZED (${bullpenRows.length})` : "NOT_MATERIALIZED_FOR_SLATE",
  });
  const weatherSourceIndex = headerIndex(daily.headers, "Weather_Source");
  const weatherFallback = weatherSourceIndex >= 0 && dailyRows.some((row) => /CLIMATOLOGY|FALLBACK/i.test(text(row[weatherSourceIndex])));
  observations.set("WEATHER", {
    ...observation(date, environmentRows, environment.headers), timestamp: pipelineTs,
    state: environmentRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : weatherFallback ? `FALLBACK_MATERIALIZED (${environmentRows.length})` : `CURRENT_MATERIALIZED (${environmentRows.length})`,
  });
  const availabilityIndex = headerIndex(preview.headers, "Preview_Availability");
  const availablePreviews = availabilityIndex < 0 ? 0 : previewRows.filter((row) => text(row[availabilityIndex]) === "AVAILABLE").length;
  observations.set("SAVANT_PREVIEW", {
    ...observation(date, previewRows, preview.headers, "Fetch_TS"),
    state: previewRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : availablePreviews > 0 ? `CURRENT_AVAILABLE (${availablePreviews}/${previewRows.length})` : "NOT_YET_PUBLISHED_OR_UNAVAILABLE",
  });
  const umpireIndex = headerIndex(daily.headers, "Plate_Umpire");
  const umpireCount = umpireIndex < 0 ? 0 : dailyRows.filter((row) => text(row[umpireIndex])).length;
  observations.set("UMPIRE", {
    ...observation(date, dailyRows, daily.headers, "Pipeline_Last_Updated"),
    state: dailyRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : umpireCount === dailyRows.length ? `CURRENT_ASSIGNED (${umpireCount}/${dailyRows.length})` : `NOT_YET_PUBLISHED_OR_PARTIAL (${umpireCount}/${dailyRows.length})`,
  });
  observations.set("MARKET", observation(date, oddsRows, odds.headers, "Snapshot_TS_UTC"));
  observations.set("SETTLEMENT", observation(date, outcomeRows, outcomes.headers, "Settlement_TS"));
  observations.set("ACTIVE_PROJECTION", observation(date, gameSummaryRows, gameSummary.headers, "Run_TS"));
  const packetStatusIndex = headerIndex(packet.headers, "Packet_Status");
  const frozenPackets = packetStatusIndex < 0 ? 0 : packetRows.filter((row) => text(row[packetStatusIndex]) === "FROZEN_PREGAME").length;
  observations.set("PREGAME_PACKET", {
    ...observation(date, packetRows, packet.headers, "Packet_Snapshot_TS"),
    state: packetRows.length === 0
      ? "NOT_MATERIALIZED_FOR_SLATE"
      : frozenPackets > 0 ? `FROZEN_PACKET_MATERIALIZED (${frozenPackets}/${packetRows.length})` : `OPEN_PACKET_MATERIALIZED (${packetRows.length})`,
  });
  return observations;
}

function toRows(
  observations: Map<SourceFreshnessKey, SourceObservation>,
  updatedTs: string,
): unknown[][] {
  return ENTRIES.map((entry) => {
    const source = entry.freshnessKey ? observations.get(entry.freshnessKey) : undefined;
    return [
      entry.recordType,
      entry.id,
      entry.label,
      entry.layer,
      entry.outputClass,
      entry.operationalStatus,
      entry.definition,
      entry.statisticalWindow,
      entry.gameWindow,
      entry.primarySource,
      entry.fallbackSource,
      entry.refreshCadence,
      entry.freshnessEvidence,
      source?.date ?? "",
      source?.timestamp ?? "",
      source?.state ?? "NOT_OBSERVED_IN_THIS_WRITE",
      entry.workbookLocation,
      entry.feedsActiveProjection,
      entry.feedsDecisionBoard,
      entry.correlationFamily,
      entry.missingBehavior,
      entry.notes,
      updatedTs,
    ];
  });
}

export function buildModelInputCatalogRows(
  observations: Map<SourceFreshnessKey, SourceObservation> = new Map(),
  updatedTs = "2026-01-01T00:00:00.000Z",
): unknown[][] {
  return toRows(observations, updatedTs);
}

export function getModelInputCatalogEntries(): readonly ModelInputCatalogEntry[] {
  return ENTRIES;
}

export interface ModelInputCatalogWriteResult {
  rows_written: number;
  freshness_gaps: string[];
}

export interface ModelInputCatalogSheetClient {
  getSpreadsheetSheetProperties: typeof getSpreadsheetSheetProperties;
  addSheet: typeof addSheet;
}

const DEFAULT_SHEET_CLIENT: ModelInputCatalogSheetClient = {
  getSpreadsheetSheetProperties,
  addSheet,
};

/**
 * Ensures the catalog tab exists using workbook metadata, not a cell read.
 *
 * A transient cell-range read failure is not evidence that a tab is absent.
 * Treating it that way caused settlement to attempt a duplicate addSheet after
 * every other settlement module had already completed. Metadata is the
 * authoritative sheet-existence surface; a duplicate-add race is tolerated
 * only after a second metadata read proves that another writer created it.
 */
export async function ensureModelInputCatalogSheet(
  workbookId: string,
  client: ModelInputCatalogSheetClient = DEFAULT_SHEET_CLIENT,
): Promise<void> {
  const hasCatalog = async (): Promise<boolean> => {
    const sheets = await client.getSpreadsheetSheetProperties(workbookId);
    return sheets.some((sheet) => sheet.title === MODEL_INPUT_CATALOG_SHEET);
  };

  if (await hasCatalog()) return;

  try {
    await client.addSheet(workbookId, MODEL_INPUT_CATALOG_SHEET);
  } catch (error: unknown) {
    // A concurrent writer may create the tab after our metadata read. Only
    // suppress the add failure when the second read proves that exact
    // idempotent outcome; every other error remains fail-closed.
    if (await hasCatalog()) return;
    throw error;
  }
}

/**
 * Rewrites the compact static catalog and, when a slate date is supplied,
 * attaches current materialization/freshness observations from actual workbook
 * surfaces. The observations are intentionally not substituted for frozen
 * provenance; PREGAME_PACKET_HISTORY remains that historical source of truth.
 */
export async function writeModelInputCatalog(
  workbookId: string,
  slateDate?: string,
): Promise<ModelInputCatalogWriteResult> {
  await ensureModelInputCatalogSheet(workbookId);

  const existingCatalog = slateDate
    ? { headers: [], rows: [] }
    : await readTable(workbookId, `${MODEL_INPUT_CATALOG_SHEET}!A1:W500`);
  const observations = slateDate
    ? await collectSourceObservations(workbookId, slateDate)
    : preservedObservations(existingCatalog);
  const updatedTs = new Date().toISOString();
  const rows = buildModelInputCatalogRows(observations, updatedTs);
  const gaps = Array.from(observations.entries())
    .filter(([, value]) => !value.state.startsWith("CURRENT"))
    .map(([key, value]) => `${key}:${value.state}`);

  await clearRange(workbookId, `${MODEL_INPUT_CATALOG_SHEET}!A1:W500`);
  await writeRange(workbookId, `${MODEL_INPUT_CATALOG_SHEET}!A1`, [
    [...MODEL_INPUT_CATALOG_HEADER],
    ...rows,
  ]);

  logger.info(
    { slateDate: slateDate ?? null, rows: rows.length, freshnessGaps: gaps.length },
    "MODEL_INPUT_CATALOG: refreshed",
  );

  return { rows_written: rows.length, freshness_gaps: gaps };
}
