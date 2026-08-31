/**
 * Module 20a: Pregame Packet History
 *
 * A self-contained, date-anchored record of the information Frostline had
 * before first pitch.  It deliberately duplicates the dependent fields that
 * otherwise live across replace-on-refresh surfaces.  The packet is the
 * settlement/replay provenance boundary; it is not a projection input.
 *
 * OPEN packets may refresh only before their own first pitch.  The first
 * FROZEN packet is immutable.  Missing data stays blank with an explicit
 * status; this module never fills a post-first-pitch packet from current data.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { isAtOrAfterFirstPitch } from "./module00_temporalFirewall.js";
import { normalizeFullGameTotalLine } from "./marketLineNormalization.js";
import type { NormalizedGame } from "./module06_normalization.js";
import type { GameSummaryRow } from "./module09_recalculation.js";
import type { ShadowAuditRow } from "./module09s_statcastShadow.js";
import type { StarterSurvivalRow } from "./module09t_starterSurvivalShadow.js";
import type { StarterSurvivalV2Row } from "./module09u_starterSurvivalV2Shadow.js";
import type { SlateBoardEntry } from "./module11_outputExtraction.js";
import type {
  OperatorEvidenceSnapshot,
  OperatorOverlayField,
} from "./module20b_operatorEvidence.js";

export const PREGAME_PACKET_HISTORY_SHEET = "PREGAME_PACKET_HISTORY";

export const PREGAME_PACKET_HISTORY_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Scheduled_First_Pitch",
  "Packet_Status",
  "Run_ID",
  "Model_Version",
  "Projection_Generated_TS",
  "Final_Decision_TS",
  "Freeze_TS",
  "Packet_Snapshot_TS",
  "Core_Packet_Status",
  "Base_Away_Projection",
  "Base_Home_Projection",
  "Base_Projection",
  // `Market_Line` remains the backwards-compatible primary grading line. The
  // following fields preserve the distinct reference and executable evidence
  // that produced it; none are inputs to the price-blind projection.
  "Market_Line",
  "Market_Snapshot_Status",
  "Reference_Market_Line",
  "Reference_Market_Source",
  "Reference_Market_TS",
  "Executable_Market_Line",
  "Executable_Market_Source",
  "Executable_Market_TS",
  "Primary_Grade_Market_Line",
  "Primary_Grade_Market_Source",
  "Primary_Grade_Market_Status",
  "Direction",
  "Vehicle",
  "Final_Decision",
  "Final_Blocker",
  "Confidence",
  "Variance",
  "Lock_Status",
  "Away_Starter",
  "Home_Starter",
  "Away_Starter_Role",
  "Home_Starter_Role",
  "Away_Expected_IP",
  "Home_Expected_IP",
  "Away_Starter_Quality",
  "Home_Starter_Quality",
  "Bullpen_Data_Status",
  "Starter_Attack_Runs",
  "Bullpen_Continuation_Runs",
  "Baseball_Only_Projection",
  "Environment_Run_Adjustment",
  "Away_Lineup_Status",
  "Home_Lineup_Status",
  "Away_Lineup_Source",
  "Home_Lineup_Source",
  "Away_Lineup_Coverage",
  "Home_Lineup_Coverage",
  "Stadium",
  "Park_Multiplier",
  "Weather_Multiplier",
  "Run_Multiplier",
  "Roof_Status",
  "Wind_Disposition",
  "Environment_Certainty",
  "Weather_Vehicle_Status",
  "Statcast_Preview_Availability",
  "Collision_Status",
  "Collision_xwOBA_Projection",
  "Collision_Traffic_Estimate",
  "Collision_Damage_Estimate",
  "Collision_Tail_Adjustment",
  "Collision_Estimated_Projection",
  "Collision_Away_Evidence_Projection",
  "Collision_Home_Evidence_Projection",
  "Low_Center_Status",
  "Low_Center_Primary",
  "Low_Center_Sensitivity",
  "Low_Center_Upper_Band",
  "SSAT_V1_Status",
  "SSAT_V1_Total",
  "SSAT_V2_Status",
  "SSAT_V2_Total",
  "Operator_Evidence_Status",
  "Operator_Evidence_Fields",
  "Operator_Evidence_Source",
  "Operator_Evidence_TS",
  "Operator_Reauthorization_Status",
  "Away_Pitcher_Effective_IP",
  "Home_Pitcher_Effective_IP",
  "Away_Bullpen_Exposure_IP",
  "Home_Bullpen_Exposure_IP",
  "Away_Traffic_Matchup_Factor",
  "Home_Traffic_Matchup_Factor",
  "Away_Damage_Matchup_Factor",
  "Home_Damage_Matchup_Factor",
  "Away_Matchup_Profile_Status",
  "Home_Matchup_Profile_Status",
  "Traffic_Conversion_Runs",
  "HR_XBH_Damage_Runs",
  "Away_Latent_Lineup_Rate",
  "Home_Latent_Lineup_Rate",
  "Away_Recent_Form_Multiplier",
  "Home_Recent_Form_Multiplier",
  "Away_Active_Offense_Center",
  "Home_Active_Offense_Center",
] as const;

export const PREGAME_PACKET_HISTORY_COLS =
  PREGAME_PACKET_HISTORY_HEADERS.length;

const I = Object.fromEntries(
  PREGAME_PACKET_HISTORY_HEADERS.map((name, index) => [name, index]),
) as Record<(typeof PREGAME_PACKET_HISTORY_HEADERS)[number], number>;

export type PregamePacketStatus = "OPEN_PROSPECTIVE" | "FROZEN_PREGAME";

export interface PregamePacketInput {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  scheduled_first_pitch: string;
  packet_status: PregamePacketStatus;
  values: unknown[];
}

export interface PregamePacketResult {
  status: "success" | "failure";
  date: string;
  rows_written: number;
  rows_updated: number;
  rows_frozen: number;
  rows_skipped_after_first_pitch: number;
  warnings: string[];
  errors: string[];
}

export interface PregamePacketFinalizationResult {
  status: "success" | "failure";
  date: string;
  rows_frozen: number;
  rows_rejected: number;
  warnings: string[];
  errors: string[];
}

function key(date: unknown, gameId: unknown): string {
  return `${String(date ?? "").trim()}|${String(gameId ?? "").trim()}`;
}

function pad(raw: unknown[]): unknown[] {
  const row = raw.slice(0, PREGAME_PACKET_HISTORY_COLS);
  while (row.length < PREGAME_PACKET_HISTORY_COLS) row.push("");
  return row;
}

/**
 * v41 inserted explicit reference/executable market lineage next to the old
 * primary market fields. Re-index existing rows by their stored header before
 * writing the canonical header, so prior frozen values cannot shift into a
 * different column merely because the schema evolved.
 */
export function normalizePregamePacketHistoryRows(raw: unknown[][]): {
  rows: unknown[][];
  headerMigrated: boolean;
} {
  if (raw.length === 0) return { rows: [], headerMigrated: false };
  const [header = [], ...data] = raw;
  const existingHeader = header.map((value) => String(value ?? "").trim());
  const headerIndex = new Map(existingHeader.map((name, index) => [name, index]));
  const headerMigrated = PREGAME_PACKET_HISTORY_HEADERS.some(
    (name, index) => existingHeader[index] !== name,
  );
  if (!headerMigrated) return { rows: data.map(pad), headerMigrated: false };
  return {
    rows: data.map((row) => PREGAME_PACKET_HISTORY_HEADERS.map(
      (name) => row[headerIndex.get(name) ?? -1] ?? "",
    )),
    headerMigrated: true,
  };
}

function blank(value: number | null | undefined): number | "" {
  return value === null || value === undefined || !Number.isFinite(value)
    ? ""
    : value;
}

function packetCoreStatus(marketLine: number | null): string {
  return marketLine === null ? "MARKET_SNAPSHOT_MISSING" : "COMPLETE";
}

function collisionStatus(row: ShadowAuditRow | undefined): string {
  if (!row) return "SOURCE_UNAVAILABLE";
  if (row.preview_availability !== "AVAILABLE") return "SOURCE_UNAVAILABLE";
  return row.tail_estimate_status === "AVAILABLE"
    ? "PROSPECTIVE_SHADOW_CANDIDATE"
    : "INSUFFICIENT_INPUT";
}

function operatorValue(
  snapshot: OperatorEvidenceSnapshot | undefined,
  field: OperatorOverlayField,
): string | undefined {
  return snapshot?.fields.get(field);
}

function operatorNumber(
  snapshot: OperatorEvidenceSnapshot | undefined,
  field: OperatorOverlayField,
): number | undefined {
  const value = operatorValue(snapshot, field);
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return field === "CURRENT_HARD_ROCK_LINE"
    ? normalizeFullGameTotalLine(parsed) ?? undefined
    : parsed;
}

function operatorFieldTimestamp(
  snapshot: OperatorEvidenceSnapshot | undefined,
  field: OperatorOverlayField,
): string {
  return snapshot?.field_supplied_ts.get(field) ?? "";
}

function operatorPacketProvenance(
  snapshot: OperatorEvidenceSnapshot | undefined,
): unknown[] {
  if (!snapshot || snapshot.fields.size === 0) {
    return ["NO_OPERATOR_OVERLAY", "", "", "", "NOT_REQUIRED"];
  }
  return [
    "MANUAL_OPERATOR_CAPTURED",
    [...snapshot.fields.entries()]
      .map(([field, value]) => `${field}=${value}`)
      .join("; "),
    snapshot.source,
    snapshot.supplied_ts,
    snapshot.reauthorization_status,
  ];
}

export function buildPregamePacketInputs(
  summaries: GameSummaryRow[],
  board: SlateBoardEntry[],
  games: NormalizedGame[],
  collisionRows: ShadowAuditRow[],
  ssatV1Rows: StarterSurvivalRow[],
  ssatV2Rows: StarterSurvivalV2Row[],
  operatorEvidenceByGame: ReadonlyMap<
    string,
    OperatorEvidenceSnapshot
  > = new Map(),
): PregamePacketInput[] {
  const boardByGame = new Map(board.map((row) => [row.legacy_game_id, row]));
  const gameById = new Map(games.map((row) => [row.legacy_game_id, row]));
  const collisionByGame = new Map(
    collisionRows.map((row) => [row.game_id, row]),
  );
  const v1ByGame = new Map(ssatV1Rows.map((row) => [row.game_id, row]));
  const v2ByGame = new Map(ssatV2Rows.map((row) => [row.game_id, row]));

  return summaries.flatMap((summary) => {
    const boardRow = boardByGame.get(summary.game_id);
    const game = gameById.get(summary.game_id);
    if (!boardRow || !game?.scheduled_utc_time) return [];
    const collision = collisionByGame.get(summary.game_id);
    const v1 = v1ByGame.get(summary.game_id);
    const v2 = v2ByGame.get(summary.game_id);
    const operator = operatorEvidenceByGame.get(summary.game_id);
    const operatorMarketLine = operatorNumber(
      operator,
      "CURRENT_HARD_ROCK_LINE",
    );
    // The board should already receive a normalized source line, but retain a
    // defensive boundary here because this packet is settlement provenance.
    const referenceMarketLine = normalizeFullGameTotalLine(boardRow.market_line);
    const packetMarketLine = operatorMarketLine ?? referenceMarketLine;
    const referenceMarketTs = referenceMarketLine === null
      ? ""
      : boardRow.final_decision_ts ?? boardRow.projection_generated_ts ?? "";
    const executableMarketTs = operatorFieldTimestamp(
      operator,
      "CURRENT_HARD_ROCK_LINE",
    );
    const primaryMarketSource = operatorMarketLine === undefined
      ? referenceMarketLine === null
        ? ""
        : "AUTOMATED_REFERENCE_BOARD"
      : "MANUAL_OPERATOR_HARD_ROCK";
    const primaryMarketStatus = operatorMarketLine === undefined
      ? referenceMarketLine === null
        ? "MISSING_MARKET"
        : "REFERENCE_ONLY_FALLBACK"
      : "EXECUTABLE_OPERATOR_CAPTURED";
    const awayLineupOverride = operatorValue(operator, "AWAY_LINEUP");
    const homeLineupOverride = operatorValue(operator, "HOME_LINEUP");
    // Board authorization finalizes before first pitch; forecast provenance
    // does not. Keep the packet refreshable for every legitimate pregame run,
    // then promote the last stored pregame snapshot after first pitch without
    // ever reading post-start state.
    const status: PregamePacketStatus = "OPEN_PROSPECTIVE";
    const values: unknown[] = [
      summary.date,
      summary.game_id,
      summary.away_team,
      summary.home_team,
      game.scheduled_utc_time,
      status,
      boardRow.run_id,
      boardRow.model_version,
      boardRow.projection_generated_ts ?? "",
      boardRow.final_decision_ts ?? "",
      "",
      "",
      packetCoreStatus(packetMarketLine),
      summary.projected_away_runs,
      summary.projected_home_runs,
      summary.projected_total_runs,
      blank(packetMarketLine),
      primaryMarketStatus,
      blank(referenceMarketLine),
      referenceMarketLine === null ? "" : "AUTOMATED_REFERENCE_BOARD",
      referenceMarketTs,
      blank(operatorMarketLine),
      operatorMarketLine === undefined ? "" : "MANUAL_OPERATOR_HARD_ROCK",
      executableMarketTs,
      blank(packetMarketLine),
      primaryMarketSource,
      primaryMarketStatus,
      boardRow.direction,
      boardRow.vehicle_type,
      boardRow.final_decision,
      boardRow.core_blocker,
      boardRow.confidence,
      blank(boardRow.variance),
      boardRow.lock_status,
      operatorValue(operator, "AWAY_STARTER") ?? summary.away_pitcher,
      operatorValue(operator, "HOME_STARTER") ?? summary.home_pitcher,
      operatorValue(operator, "AWAY_STARTER_ROLE") ?? summary.away_pitcher_role,
      operatorValue(operator, "HOME_STARTER_ROLE") ?? summary.home_pitcher_role,
      blank(summary.away_expected_innings),
      blank(summary.home_expected_innings),
      summary.away_starter_quality,
      summary.home_starter_quality,
      summary.bullpen_available ? "AVAILABLE" : "UNAVAILABLE",
      summary.starter_attack_runs,
      summary.bullpen_continuation_runs,
      summary.baseball_only_projection,
      summary.environment_run_adjustment,
      awayLineupOverride
        ? "MANUAL_OPERATOR_CONFIRMED"
        : summary.away_lineup_status,
      homeLineupOverride
        ? "MANUAL_OPERATOR_CONFIRMED"
        : summary.home_lineup_status,
      awayLineupOverride
        ? "MANUAL_OPERATOR"
        : (summary.away_lineup_source ?? ""),
      homeLineupOverride
        ? "MANUAL_OPERATOR"
        : (summary.home_lineup_source ?? ""),
      awayLineupOverride ? 100 : summary.away_lineup_coverage,
      homeLineupOverride ? 100 : summary.home_lineup_coverage,
      operatorValue(operator, "STADIUM") ?? summary.stadium,
      operatorNumber(operator, "PARK_MULTIPLIER") ?? summary.park_multiplier,
      summary.weather_multiplier,
      summary.combined_run_multiplier,
      operatorValue(operator, "ROOF_STATUS") ?? summary.roof_status,
      operatorValue(operator, "WIND_DISPOSITION") ?? summary.wind_disposition,
      operatorValue(operator, "ENVIRONMENT_CERTAINTY") ??
        summary.environment_certainty,
      summary.weather_vehicle_status,
      collision?.preview_availability ?? "UNAVAILABLE",
      collisionStatus(collision),
      blank(collision?.shadow_projection),
      blank(collision?.traffic_conversion_estimate),
      blank(collision?.hr_xbh_damage_estimate),
      blank(collision?.combined_tail_adjustment),
      blank(collision?.estimated_projection),
      blank(collision?.collision_away_evidence_projection),
      blank(collision?.collision_home_evidence_projection),
      collision?.low_center_volatility_flag ?? "UNAVAILABLE",
      blank(collision?.low_center_challenger_projection),
      blank(collision?.low_center_sensitivity_projection),
      blank(collision?.low_center_upper_tail_band),
      v1?.calibration_status ?? "INSUFFICIENT_INPUT",
      blank(v1?.starter_survival_adjusted_total),
      v2?.calibration_status ?? "INSUFFICIENT_INPUT",
      blank(v2?.ssat_v2_total),
      ...operatorPacketProvenance(operator),
      summary.away_pitcher_effective_innings,
      summary.home_pitcher_effective_innings,
      summary.away_bullpen_exposure_innings,
      summary.home_bullpen_exposure_innings,
      summary.away_traffic_matchup_factor,
      summary.home_traffic_matchup_factor,
      summary.away_damage_matchup_factor,
      summary.home_damage_matchup_factor,
      summary.away_matchup_profile_status,
      summary.home_matchup_profile_status,
      summary.traffic_conversion_runs,
      summary.hr_xbh_damage_runs,
      summary.away_latent_lineup_rate,
      summary.home_latent_lineup_rate,
      summary.away_recent_form_multiplier,
      summary.home_recent_form_multiplier,
      summary.away_active_offense_center,
      summary.home_active_offense_center,
    ];
    return [
      {
        date: summary.date,
        game_id: summary.game_id,
        away_team: summary.away_team,
        home_team: summary.home_team,
        scheduled_first_pitch: game.scheduled_utc_time,
        packet_status: status,
        values,
      },
    ];
  });
}

export function upsertPregamePacketRows(
  existingRows: unknown[][],
  incoming: PregamePacketInput[],
  snapshotTs: string,
): {
  rows: unknown[][];
  rowsWritten: number;
  rowsUpdated: number;
  rowsFrozen: number;
  rowsSkippedAfterFirstPitch: number;
} {
  const finalized = finalizeOpenPregamePacketRows(
    existingRows,
    undefined,
    snapshotTs,
  );
  const rows = finalized.rows;
  const byKey = new Map(
    rows.map((row, index) => [key(row[I.Date], row[I.Game_ID]), index]),
  );
  let rowsWritten = 0;
  let rowsUpdated = 0;
  let rowsFrozen = finalized.rowsFrozen;
  let rowsSkippedAfterFirstPitch = 0;

  rowsUpdated += finalized.rowsUpdated;

  for (const input of incoming) {
    if (isAtOrAfterFirstPitch(input.scheduled_first_pitch, snapshotTs)) {
      rowsSkippedAfterFirstPitch++;
      continue;
    }
    const rowKey = key(input.date, input.game_id);
    const existingIndex = byKey.get(rowKey);
    const existing =
      existingIndex === undefined ? undefined : rows[existingIndex];
    if (existing?.[I.Packet_Status] === "FROZEN_PREGAME") continue;
    const next = pad(input.values);
    next[I.Packet_Snapshot_TS] = snapshotTs;
    if (input.packet_status === "FROZEN_PREGAME")
      next[I.Freeze_TS] = snapshotTs;
    if (existingIndex === undefined) {
      rows.push(next);
      byKey.set(rowKey, rows.length - 1);
      rowsWritten++;
    } else {
      rows[existingIndex] = next;
      rowsUpdated++;
    }
    if (input.packet_status === "FROZEN_PREGAME") rowsFrozen++;
  }
  return {
    rows,
    rowsWritten,
    rowsUpdated,
    rowsFrozen,
    rowsSkippedAfterFirstPitch,
  };
}

/**
 * Promote stored, legitimate OPEN snapshots without ever looking at a current
 * game surface. `date` scopes settlement finalization to the requested slate;
 * omit it only for the ordinary pregame writer's historical cleanup pass.
 */
export function finalizeOpenPregamePacketRows(
  existingRows: unknown[][],
  date: string | undefined,
  snapshotTs: string,
): {
  rows: unknown[][];
  rowsUpdated: number;
  rowsFrozen: number;
  rowsRejected: number;
} {
  const rows = existingRows.map(pad);
  let rowsUpdated = 0;
  let rowsFrozen = 0;
  let rowsRejected = 0;
  for (const [rowIndex, existing] of rows.entries()) {
    if (date !== undefined && String(existing[I.Date] ?? "") !== date) continue;
    if (existing[I.Packet_Status] !== "OPEN_PROSPECTIVE") continue;
    const scheduledFirstPitch = String(existing[I.Scheduled_First_Pitch] ?? "");
    const packetSnapshot = String(existing[I.Packet_Snapshot_TS] ?? "");
    if (!isAtOrAfterFirstPitch(scheduledFirstPitch, snapshotTs)) continue;
    const firstPitchMs = Date.parse(scheduledFirstPitch);
    const packetSnapshotMs = Date.parse(packetSnapshot);
    if (
      !Number.isFinite(firstPitchMs) ||
      !Number.isFinite(packetSnapshotMs) ||
      packetSnapshotMs >= firstPitchMs
    ) {
      rowsRejected++;
      continue;
    }
    const frozen = pad(existing);
    frozen[I.Packet_Status] = "FROZEN_PREGAME";
    frozen[I.Freeze_TS] = snapshotTs;
    rows[rowIndex] = frozen;
    rowsUpdated++;
    rowsFrozen++;
  }
  return { rows, rowsUpdated, rowsFrozen, rowsRejected };
}

async function ensurePacketSheet(workbookId: string): Promise<void> {
  const properties = await getSpreadsheetSheetProperties(workbookId);
  if (
    !properties.some((sheet) => sheet.title === PREGAME_PACKET_HISTORY_SHEET)
  ) {
    await addSheet(workbookId, PREGAME_PACKET_HISTORY_SHEET);
  }
  await expandSheetColumns(
    workbookId,
    PREGAME_PACKET_HISTORY_SHEET,
    PREGAME_PACKET_HISTORY_COLS,
  );
}

export async function writePregamePacketHistory(
  date: string,
  summaries: GameSummaryRow[],
  board: SlateBoardEntry[],
  games: NormalizedGame[],
  collisionRows: ShadowAuditRow[],
  ssatV1Rows: StarterSurvivalRow[],
  ssatV2Rows: StarterSurvivalV2Row[],
  options: {
    workbookId?: string;
    snapshotTs?: string;
    operatorEvidenceByGame?: ReadonlyMap<string, OperatorEvidenceSnapshot>;
  } = {},
): Promise<PregamePacketResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const snapshotTs = options.snapshotTs ?? new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    await ensurePacketSheet(workbookId);
    const response = await readRange(
      workbookId,
      `${PREGAME_PACKET_HISTORY_SHEET}!A1:CZ5000`,
    );
    const raw = (response.values ?? []) as unknown[][];
    const existingPacketRows = normalizePregamePacketHistoryRows(raw);
    const existing = existingPacketRows.rows;
    if (existingPacketRows.headerMigrated) {
      warnings.push("PREGAME_PACKET_HEADER_REINDEXED: existing rows aligned by stored column names before v41 rewrite");
    }
    const mutation = upsertPregamePacketRows(
      existing,
      buildPregamePacketInputs(
        summaries,
        board,
        games,
        collisionRows,
        ssatV1Rows,
        ssatV2Rows,
        options.operatorEvidenceByGame,
      ),
      snapshotTs,
    );
    if (mutation.rowsSkippedAfterFirstPitch > 0) {
      warnings.push(
        `POST_FIRST_PITCH_REJECTED: ${mutation.rowsSkippedAfterFirstPitch} pregame packet(s) were not created or updated`,
      );
    }
    await writeRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1`, [
      PREGAME_PACKET_HISTORY_HEADERS as unknown as string[],
      ...mutation.rows,
    ]);
    return {
      status: "success",
      date,
      rows_written: mutation.rowsWritten,
      rows_updated: mutation.rowsUpdated,
      rows_frozen: mutation.rowsFrozen,
      rows_skipped_after_first_pitch: mutation.rowsSkippedAfterFirstPitch,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      status: "failure",
      date,
      rows_written: 0,
      rows_updated: 0,
      rows_frozen: 0,
      rows_skipped_after_first_pitch: 0,
      warnings,
      errors,
    };
  }
}

/**
 * Settlement-only lifecycle completion. It can only freeze an already stored
 * pre-first-pitch packet for this date; it never receives live inputs and
 * therefore cannot create or reconstruct a prospective observation.
 */
export async function finalizePregamePacketHistory(
  date: string,
  options: { workbookId?: string; snapshotTs?: string } = {},
): Promise<PregamePacketFinalizationResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const snapshotTs = options.snapshotTs ?? new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    await ensurePacketSheet(workbookId);
    const response = await readRange(
      workbookId,
      `${PREGAME_PACKET_HISTORY_SHEET}!A1:CZ5000`,
    );
    const raw = (response.values ?? []) as unknown[][];
    const existingPacketRows = normalizePregamePacketHistoryRows(raw);
    const existing = existingPacketRows.rows;
    const finalized = finalizeOpenPregamePacketRows(existing, date, snapshotTs);
    if (finalized.rowsRejected > 0) {
      warnings.push(
        `PREGAME_PACKET_FINALIZE_REJECTED_NOT_PROSPECTIVE: ${finalized.rowsRejected}`,
      );
    }
    if (finalized.rowsFrozen > 0 || existingPacketRows.headerMigrated) {
      await writeRange(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1`, [
        PREGAME_PACKET_HISTORY_HEADERS as unknown as string[],
        ...finalized.rows,
      ]);
    }
    return {
      status: "success",
      date,
      rows_frozen: finalized.rowsFrozen,
      rows_rejected: finalized.rowsRejected,
      warnings: existingPacketRows.headerMigrated
        ? [...warnings, "PREGAME_PACKET_HEADER_REINDEXED: existing rows aligned by stored column names before v41 rewrite"]
        : warnings,
      errors,
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      status: "failure",
      date,
      rows_frozen: 0,
      rows_rejected: 0,
      warnings,
      errors,
    };
  }
}
