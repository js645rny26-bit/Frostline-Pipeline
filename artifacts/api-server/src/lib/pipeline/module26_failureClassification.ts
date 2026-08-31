/**
 * Module 26: Failure Classification Shadow V1
 *
 * A price-blind, shadow-only classification layer.  It derives labels from
 * the self-contained pregame packet, preserves them through first-pitch
 * freeze, and joins only frozen labels to settled GAME_TRUTH_REPLAY_V1 rows.
 *
 * It creates no forecast, coefficient, run-band, vehicle, authorization, or
 * market-derived signal.  The purpose is to classify structural fragility so
 * replay can test it before any future modelling change is considered.
 */

import {
  addSheet,
  expandSheetColumns,
  getSpreadsheetSheetProperties,
  readRange,
  writeRange,
  WORKBOOK_ID,
} from "../sheets/client.js";
import { PREGAME_PACKET_HISTORY_SHEET } from "./module20a_pregamePacket.js";
import { logger } from "../../lib/logger.js";

export const FAILURE_CLASSIFICATION_SHADOW_SHEET =
  "FAILURE_CLASSIFICATION_SHADOW_V1";
export const FAILURE_CLASSIFICATION_REPLAY_SHEET =
  "FAILURE_CLASSIFICATION_REPLAY_V1";
export const FAILURE_CLASSIFICATION_DISCRIMINATION_SHEET =
  "FAILURE_CLASSIFICATION_DISCRIMINATION_V1";

export const FAILURE_CLASSIFICATION_SHADOW_HEADERS = [
  "Date",
  "Game_ID",
  "Away_Team",
  "Home_Team",
  "Packet_Snapshot_TS",
  "Packet_Status",
  "Classification_Status",
  "Starter_Phase_Runs",
  "Bullpen_Continuation_Runs",
  "Combined_Bullpen_Exposure_IP",
  "Away_Starter_Role",
  "Home_Starter_Role",
  "Away_Expected_IP",
  "Home_Expected_IP",
  "Opener_Chain_Status",
  "Scoring_Path_Status",
  "Traffic_Conversion_Status",
  "Traffic_Damage_CoSign_Status",
  "CoSign_Fragility_Status",
  "Distribution_Structure_Status",
  "Distribution_Risk_Tags",
  "Projection_Impact_Status",
  "Authorization_Impact_Status",
  "Source_Provenance",
  "Classification_TS",
] as const;

export const FAILURE_CLASSIFICATION_REPLAY_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Frozen_Classification_Status",
  "Frozen_Opener_Chain_Status",
  "Frozen_Scoring_Path_Status",
  "Frozen_Traffic_Conversion_Status",
  "Frozen_Traffic_Damage_CoSign_Status",
  "Frozen_CoSign_Fragility_Status",
  "Frozen_Distribution_Structure_Status",
  "Frozen_Distribution_Risk_Tags",
  "Frozen_Reference_Market_Line",
  "Reference_Market_Direction",
  "Reference_Directional_Result",
  "Actual_Total",
  "Total_Error",
  "Total_Abs_Error",
  "Actual_Starter_Window_Runs",
  "Actual_Bullpen_Window_Runs",
  "Primary_Scoring_Mechanism",
  "Allocation_MAE",
  "Allocation_Sign_Reversal",
  "Away_Conversion_Outcome",
  "Home_Conversion_Outcome",
  "CoSign_Comparison_Bucket",
  "Major_Center_Miss_Status",
  "Distribution_Warning_Status",
  "Warning_Outcome_Quadrant",
  "False_Negative_Distribution_Case",
  "Replay_Status",
  "Settlement_TS",
] as const;

export const FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS = [
  "Classification_Family",
  "Classification_Value",
  "Eligible_N",
  "Mean_Abs_Center_Error",
  "Median_Abs_Center_Error",
  "Signed_Center_Bias",
  "Major_Miss_Count",
  "Major_Miss_Rate",
  "Directional_Wins",
  "Directional_Losses",
  "Directional_Pushes",
  "Directional_Eligible_N",
  "Mean_Actual_Starter_Window_Runs",
  "Mean_Actual_Bullpen_Window_Runs",
  "Starter_Primary_Count",
  "Bullpen_Primary_Count",
  "Balanced_Primary_Count",
  "Other_Primary_Count",
  "Research_Status",
  "Replay_TS",
] as const;

interface FailureClassificationPacket {
  date: string;
  game_id: string;
  away_team: string;
  home_team: string;
  snapshot_ts: string;
  packet_status: "OPEN_PROSPECTIVE" | "FROZEN_PREGAME";
  starter_phase_runs: number | null;
  bullpen_continuation_runs: number | null;
  away_bullpen_exposure_ip: number | null;
  home_bullpen_exposure_ip: number | null;
  away_starter_role: string;
  home_starter_role: string;
  away_expected_ip: number | null;
  home_expected_ip: number | null;
  collision_status: string;
  collision_traffic_estimate: number | null;
  collision_damage_estimate: number | null;
}

interface FrozenFailureClassification {
  date: string;
  game_id: string;
  snapshot_ts: string;
  classification_status: string;
  opener_chain_status: string;
  scoring_path_status: string;
  traffic_conversion_status: string;
  traffic_damage_cosign_status: string;
  cosign_fragility_status: string;
  distribution_structure_status: string;
  distribution_risk_tags: string;
}

interface SettledGameTruth {
  date: string;
  game_id: string;
  snapshot_ts: string;
  actual_total: number;
  total_error: number;
  total_abs_error: number;
  actual_starter_window_runs: number | null;
  actual_bullpen_window_runs: number | null;
  primary_scoring_mechanism: string;
  allocation_mae: number | null;
  allocation_sign_reversal: string;
  away_conversion_outcome: string;
  home_conversion_outcome: string;
  settlement_ts: string;
}

interface FrozenReferenceMarket {
  snapshot_ts: string;
  projected_total: number;
  reference_market_line: number | null;
}

export interface FailureClassificationShadowResult {
  status: "success" | "failure";
  date: string;
  rows_written: number;
  rows_updated: number;
  rows_frozen_preserved: number;
  packets_ineligible: number;
  warnings: string[];
  errors: string[];
}

export interface FailureClassificationReplayResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  frozen_classifications_seen: number;
  eligible_games: number;
  replay_rows_written: number;
  discrimination_rows_written: number;
  snapshot_mismatches: number;
  warnings: string[];
  errors: string[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function key(date: string, gameId: string): string {
  return `${date}|${gameId}`;
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((name, index) => [text(name), index]));
}

function value(row: unknown[], index: ReadonlyMap<string, number>, name: string): unknown {
  const column = index.get(name);
  return column === undefined ? undefined : row[column];
}

function isValidBeforeFirstPitch(snapshotTs: string, firstPitch: string): boolean {
  const snapshotMs = Date.parse(snapshotTs);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
}

function openerChainStatus(packet: FailureClassificationPacket): string {
  const roles = [packet.away_starter_role, packet.home_starter_role]
    .map((role) => role.toUpperCase())
    .filter(Boolean);
  if (roles.length === 0) return "INSUFFICIENT_STARTER_ROLE_INPUT";
  if (!roles.includes("OPENER")) return "NO_OPENER_IDENTIFIED";
  const expectedIps = [packet.away_expected_ip, packet.home_expected_ip];
  return expectedIps.some((innings) => innings === null)
    ? "OPENER_WORKLOAD_UNRESOLVED"
    : "OPENER_CHAIN_UNCERTAINTY";
}

function scoringPathStatus(packet: FailureClassificationPacket): string {
  if (
    packet.starter_phase_runs === null
    || packet.bullpen_continuation_runs === null
  ) return "INSUFFICIENT_PHASE_INPUT";
  if (packet.bullpen_continuation_runs > packet.starter_phase_runs) {
    return "BULLPEN_PHASE_RELIANT";
  }
  if (packet.starter_phase_runs > packet.bullpen_continuation_runs) {
    return "STARTER_PHASE_SUPPORTED";
  }
  return "BALANCED_STARTER_AND_BULLPEN_PATHS";
}

function trafficDamageCoSignStatus(packet: FailureClassificationPacket): string {
  if (packet.collision_status !== "PROSPECTIVE_SHADOW_CANDIDATE") {
    return "NO_PROSPECTIVE_COLLISION_EVIDENCE";
  }
  const trafficPositive = (packet.collision_traffic_estimate ?? 0) > 0;
  const damagePositive = (packet.collision_damage_estimate ?? 0) > 0;
  if (trafficPositive && damagePositive) return "TRAFFIC_AND_DAMAGE_COSIGNED";
  if (trafficPositive) return "TRAFFIC_WITHOUT_DAMAGE_COSIGN";
  if (damagePositive) return "DAMAGE_WITHOUT_TRAFFIC_COSIGN";
  return "NO_POSITIVE_COLLISION_SIGNAL";
}

function trafficConversionStatus(coSignStatus: string): string {
  if (coSignStatus === "TRAFFIC_AND_DAMAGE_COSIGNED") {
    return "TRAFFIC_DAMAGE_COSIGNED_NO_CONVERSION_INFERENCE";
  }
  if (coSignStatus === "TRAFFIC_WITHOUT_DAMAGE_COSIGN") {
    return "TRAFFIC_ONLY_NO_CONVERSION_INFERENCE";
  }
  if (coSignStatus === "DAMAGE_WITHOUT_TRAFFIC_COSIGN") {
    return "DAMAGE_ONLY_NO_CONVERSION_INFERENCE";
  }
  return "NO_PREGAME_CONVERSION_INFERENCE";
}

/**
 * Co-sign asymmetry is a structural fragility label, not a directional run
 * adjustment. A one-sided signal lacks the redundant traffic+damage path
 * available to a fully co-signed candidate, but it does not tell us whether
 * the eventual miss will be high-side or low-side.
 */
function coSignFragilityStatus(coSignStatus: string): string {
  if (coSignStatus === "TRAFFIC_WITHOUT_DAMAGE_COSIGN") {
    return "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY";
  }
  if (coSignStatus === "DAMAGE_WITHOUT_TRAFFIC_COSIGN") {
    return "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY";
  }
  if (coSignStatus === "TRAFFIC_AND_DAMAGE_COSIGNED") {
    return "TRAFFIC_DAMAGE_TAIL_CANDIDATE";
  }
  return "NO_COSIGN_FRAGILITY_CLASSIFICATION";
}

export function buildFailureClassificationShadowRow(
  packet: FailureClassificationPacket,
  classificationTs: string,
): unknown[] {
  const opener = openerChainStatus(packet);
  const scoring = scoringPathStatus(packet);
  const coSign = trafficDamageCoSignStatus(packet);
  const traffic = trafficConversionStatus(coSign);
  const coSignFragility = coSignFragilityStatus(coSign);
  const tags = [
    opener === "OPENER_CHAIN_UNCERTAINTY" || opener === "OPENER_WORKLOAD_UNRESOLVED"
      ? opener
      : "",
    scoring === "BULLPEN_PHASE_RELIANT" ? "BULLPEN_CONTINUATION_DEPENDENT" : "",
    coSignFragility !== "NO_COSIGN_FRAGILITY_CLASSIFICATION" ? coSignFragility : "",
  ].filter(Boolean);
  const distribution = tags.includes("OPENER_CHAIN_UNCERTAINTY")
    || tags.includes("OPENER_WORKLOAD_UNRESOLVED")
    ? "OPENER_CHAIN_UNCERTAINTY"
    : tags.includes("BULLPEN_CONTINUATION_DEPENDENT")
      ? "BULLPEN_CONTINUATION_TAIL_CANDIDATE"
      : tags.includes("TRAFFIC_DAMAGE_TAIL_CANDIDATE")
        ? "TRAFFIC_DAMAGE_TAIL_CANDIDATE"
        : coSignFragility === "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY"
          || coSignFragility === "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY"
          ? "ASYMMETRIC_SCORING_SUPPORT"
          : "NO_CLASSIFIED_WIDENING_PATH";
  const combinedExposure = packet.away_bullpen_exposure_ip === null
    || packet.home_bullpen_exposure_ip === null
    ? ""
    : round2(packet.away_bullpen_exposure_ip + packet.home_bullpen_exposure_ip);
  return [
    packet.date,
    packet.game_id,
    packet.away_team,
    packet.home_team,
    packet.snapshot_ts,
    packet.packet_status,
    packet.packet_status === "FROZEN_PREGAME"
      ? "FROZEN_PREGAME_SHADOW"
      : "OPEN_PROSPECTIVE_SHADOW",
    packet.starter_phase_runs ?? "",
    packet.bullpen_continuation_runs ?? "",
    combinedExposure,
    packet.away_starter_role,
    packet.home_starter_role,
    packet.away_expected_ip ?? "",
    packet.home_expected_ip ?? "",
    opener,
    scoring,
    traffic,
    coSign,
    coSignFragility,
    distribution,
    tags.join("; ") || "NO_CLASSIFIED_RISK_TAG",
    "SHADOW_ONLY_NO_PROJECTION_IMPACT",
    "SHADOW_ONLY_NO_AUTHORIZATION_IMPACT",
    "FROZEN_PREGAME_PACKET_FIELDS_ONLY",
    classificationTs,
  ];
}

/** Strictly parse legitimate packet data; market/vehicle fields are intentionally ignored. */
export function parseFailureClassificationPackets(
  rows: unknown[][],
  date?: string,
): { packets: FailureClassificationPacket[]; packets_ineligible: number } {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const packets: FailureClassificationPacket[] = [];
  let packetsIneligible = 0;
  for (const row of data) {
    const packetDate = text(value(row, index, "Date"));
    if (date !== undefined && packetDate !== date) continue;
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const packetStatus = text(value(row, index, "Packet_Status"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const projectedTotal = numeric(value(row, index, "Base_Projection"));
    if (
      !packetDate
      || !gameId
      || !snapshotTs
      || !isValidBeforeFirstPitch(snapshotTs, firstPitch)
      || projectedTotal === null
      || (packetStatus !== "OPEN_PROSPECTIVE" && packetStatus !== "FROZEN_PREGAME")
    ) {
      packetsIneligible++;
      continue;
    }
    packets.push({
      date: packetDate,
      game_id: gameId,
      away_team: text(value(row, index, "Away_Team")),
      home_team: text(value(row, index, "Home_Team")),
      snapshot_ts: snapshotTs,
      packet_status: packetStatus,
      starter_phase_runs: numeric(value(row, index, "Starter_Attack_Runs")),
      bullpen_continuation_runs: numeric(value(row, index, "Bullpen_Continuation_Runs")),
      away_bullpen_exposure_ip: numeric(value(row, index, "Away_Bullpen_Exposure_IP")),
      home_bullpen_exposure_ip: numeric(value(row, index, "Home_Bullpen_Exposure_IP")),
      away_starter_role: text(value(row, index, "Away_Starter_Role")),
      home_starter_role: text(value(row, index, "Home_Starter_Role")),
      away_expected_ip: numeric(value(row, index, "Away_Expected_IP")),
      home_expected_ip: numeric(value(row, index, "Home_Expected_IP")),
      collision_status: text(value(row, index, "Collision_Status")),
      collision_traffic_estimate: numeric(value(row, index, "Collision_Traffic_Estimate")),
      collision_damage_estimate: numeric(value(row, index, "Collision_Damage_Estimate")),
    });
  }
  return { packets, packets_ineligible: packetsIneligible };
}

function normalizeRows(
  rows: unknown[][],
  header: readonly string[],
): unknown[][] {
  const [existingHeader = [], ...data] = rows;
  const index = headerIndex(existingHeader);
  return data.map((row) => header.map((name) => value(row, index, name) ?? ""));
}

function isFrozenClassification(row: unknown[], index: ReadonlyMap<string, number>): boolean {
  return text(value(row, index, "Classification_Status")) === "FROZEN_PREGAME_SHADOW";
}

export function upsertFailureClassificationRows(
  existingRows: unknown[][],
  packets: readonly FailureClassificationPacket[],
  classificationTs: string,
): {
  rows: unknown[][];
  rows_written: number;
  rows_updated: number;
  rows_frozen_preserved: number;
} {
  const rows = existingRows.map((row) => [...row]);
  const index = headerIndex(FAILURE_CLASSIFICATION_SHADOW_HEADERS as unknown as unknown[]);
  const existingByKey = new Map(rows.map((row, rowIndex) => [
    key(text(value(row, index, "Date")), text(value(row, index, "Game_ID"))),
    rowIndex,
  ]));
  let rowsWritten = 0;
  let rowsUpdated = 0;
  let rowsFrozenPreserved = 0;
  for (const packet of packets) {
    const rowKey = key(packet.date, packet.game_id);
    const existingIndex = existingByKey.get(rowKey);
    if (existingIndex !== undefined && isFrozenClassification(rows[existingIndex]!, index)) {
      rowsFrozenPreserved++;
      continue;
    }
    const next = buildFailureClassificationShadowRow(packet, classificationTs);
    if (existingIndex === undefined) {
      rows.push(next);
      existingByKey.set(rowKey, rows.length - 1);
      rowsWritten++;
    } else {
      rows[existingIndex] = next;
      rowsUpdated++;
    }
  }
  return {
    rows,
    rows_written: rowsWritten,
    rows_updated: rowsUpdated,
    rows_frozen_preserved: rowsFrozenPreserved,
  };
}

async function ensureSheet(workbookId: string, sheet: string, columnCount: number): Promise<void> {
  const sheets = await getSpreadsheetSheetProperties(workbookId);
  if (!sheets.some((entry) => entry.title === sheet)) {
    await addSheet(workbookId, sheet);
  }
  await expandSheetColumns(workbookId, sheet, columnCount);
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message);
}

async function readOptionalSheet(workbookId: string, range: string, warnings: string[]): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    warnings.push(`MISSING_CLASSIFICATION_SOURCE: ${range}`);
    return [];
  }
}

/**
 * Called during pregame publication and after packet finalization.  OPEN rows
 * may follow the latest valid packet; frozen labels are never overwritten.
 */
export async function syncFailureClassificationShadow(
  date: string,
  options: { workbookId?: string } = {},
): Promise<FailureClassificationShadowResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const classificationTs = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetRows, existingRaw] = await Promise.all([
      readOptionalSheet(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1:CZ10000`, warnings),
      readOptionalSheet(workbookId, `${FAILURE_CLASSIFICATION_SHADOW_SHEET}!A1:AZ10000`, warnings),
    ]);
    const parsed = parseFailureClassificationPackets(packetRows, date);
    const existing = normalizeRows(existingRaw, FAILURE_CLASSIFICATION_SHADOW_HEADERS);
    const mutation = upsertFailureClassificationRows(
      existing,
      parsed.packets,
      classificationTs,
    );
    await ensureSheet(
      workbookId,
      FAILURE_CLASSIFICATION_SHADOW_SHEET,
      FAILURE_CLASSIFICATION_SHADOW_HEADERS.length,
    );
    await writeRange(workbookId, `${FAILURE_CLASSIFICATION_SHADOW_SHEET}!A1`, [
      Array.from(FAILURE_CLASSIFICATION_SHADOW_HEADERS),
      ...mutation.rows,
    ]);
    logger.info(
      {
        date,
        rows_written: mutation.rows_written,
        rows_updated: mutation.rows_updated,
        rows_frozen_preserved: mutation.rows_frozen_preserved,
      },
      "MODULE_26: failure classification shadow synchronized",
    );
    return {
      status: "success",
      date,
      rows_written: mutation.rows_written,
      rows_updated: mutation.rows_updated,
      rows_frozen_preserved: mutation.rows_frozen_preserved,
      packets_ineligible: parsed.packets_ineligible,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ date, err: message }, "MODULE_26: failure classification shadow failed");
    return {
      status: "failure",
      date,
      rows_written: 0,
      rows_updated: 0,
      rows_frozen_preserved: 0,
      packets_ineligible: 0,
      warnings,
      errors,
    };
  }
}

export function parseFrozenFailureClassifications(rows: unknown[][]): Map<string, FrozenFailureClassification> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const classifications = new Map<string, FrozenFailureClassification>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    if (
      !date
      || !gameId
      || !snapshotTs
      || text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME"
      || text(value(row, index, "Classification_Status")) !== "FROZEN_PREGAME_SHADOW"
    ) continue;
    const coSignStatus = text(value(row, index, "Traffic_Damage_CoSign_Status"));
    const storedFragility = text(value(row, index, "CoSign_Fragility_Status"));
    classifications.set(key(date, gameId), {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      classification_status: text(value(row, index, "Classification_Status")),
      opener_chain_status: text(value(row, index, "Opener_Chain_Status")),
      scoring_path_status: text(value(row, index, "Scoring_Path_Status")),
      traffic_conversion_status: text(value(row, index, "Traffic_Conversion_Status")),
      traffic_damage_cosign_status: coSignStatus,
      // v42 frozen rows predate the dedicated field. This is a deterministic
      // v43 read of their already-frozen co-sign status, never a lookup of
      // outcome, market, or current-game evidence.
      cosign_fragility_status: storedFragility || coSignFragilityStatus(coSignStatus),
      distribution_structure_status: text(value(row, index, "Distribution_Structure_Status")),
      distribution_risk_tags: text(value(row, index, "Distribution_Risk_Tags")),
    });
  }
  return classifications;
}

export function parseSettledFailureClassificationGameTruth(rows: unknown[][]): Map<string, SettledGameTruth> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const games = new Map<string, SettledGameTruth>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Frozen_Packet_Snapshot_TS"));
    const actualTotal = numeric(value(row, index, "Actual_Total"));
    const totalError = numeric(value(row, index, "Total_Error"));
    const totalAbsError = numeric(value(row, index, "Total_Abs_Error"));
    if (
      !date
      || !gameId
      || !snapshotTs
      || actualTotal === null
      || totalError === null
      || totalAbsError === null
      || text(value(row, index, "Replay_Status")) !== "FROZEN_PACKET_AND_FINAL_VERIFIED"
    ) continue;
    games.set(key(date, gameId), {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      actual_total: actualTotal,
      total_error: totalError,
      total_abs_error: totalAbsError,
      actual_starter_window_runs: numeric(value(row, index, "Starter_Window_Runs_Total")),
      actual_bullpen_window_runs: numeric(value(row, index, "Bullpen_Window_Runs_Total")),
      primary_scoring_mechanism: text(value(row, index, "Primary_Scoring_Mechanism")),
      allocation_mae: numeric(value(row, index, "Allocation_MAE")),
      allocation_sign_reversal: text(value(row, index, "Allocation_Sign_Reversal")),
      away_conversion_outcome: text(value(row, index, "Away_Conversion_Outcome")),
      home_conversion_outcome: text(value(row, index, "Home_Conversion_Outcome")),
      settlement_ts: text(value(row, index, "Settlement_TS")),
    });
  }
  return games;
}

/**
 * Market evidence is parsed only for the settlement report. It is not passed
 * to the pregame classifier and cannot affect any frozen classification.
 */
export function parseFrozenReferenceMarkets(rows: unknown[][]): Map<string, FrozenReferenceMarket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const markets = new Map<string, FrozenReferenceMarket>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const projectedTotal = numeric(value(row, index, "Base_Projection"));
    if (
      !date
      || !gameId
      || !snapshotTs
      || !isValidBeforeFirstPitch(snapshotTs, firstPitch)
      || text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME"
      || projectedTotal === null
    ) continue;
    markets.set(key(date, gameId), {
      snapshot_ts: snapshotTs,
      projected_total: projectedTotal,
      reference_market_line: numeric(value(row, index, "Reference_Market_Line")),
    });
  }
  return markets;
}

function referenceMarketDirection(market: FrozenReferenceMarket | undefined): string {
  if (!market || market.reference_market_line === null) return "NOT_GRADABLE";
  if (market.projected_total > market.reference_market_line) return "OVER";
  if (market.projected_total < market.reference_market_line) return "UNDER";
  return "NONE";
}

function referenceDirectionalResult(
  market: FrozenReferenceMarket | undefined,
  actualTotal: number,
): string {
  const direction = referenceMarketDirection(market);
  if (!market || market.reference_market_line === null || direction === "NONE") {
    return "NOT_GRADABLE";
  }
  if (actualTotal === market.reference_market_line) return "PUSH";
  return direction === "OVER"
    ? actualTotal > market.reference_market_line ? "WIN" : "LOSS"
    : actualTotal < market.reference_market_line ? "WIN" : "LOSS";
}

function coSignComparisonBucket(coSignStatus: string): string {
  return coSignStatus === "TRAFFIC_AND_DAMAGE_COSIGNED"
    || coSignStatus === "TRAFFIC_WITHOUT_DAMAGE_COSIGN"
    || coSignStatus === "DAMAGE_WITHOUT_TRAFFIC_COSIGN"
    ? coSignStatus
    : "NEITHER_OR_UNAVAILABLE";
}

const MAJOR_CENTER_MISS_RESEARCH_THRESHOLD = 4;

function warningOutcomeQuadrant(warned: boolean, majorMiss: boolean): string {
  if (warned && majorMiss) return "WARNED_MAJOR_MISS";
  if (warned) return "WARNED_NO_MAJOR_MISS";
  return majorMiss ? "NO_WARNING_MAJOR_MISS" : "NO_WARNING_NO_MAJOR_MISS";
}

export function buildFailureClassificationReplayRows(
  classifications: ReadonlyMap<string, FrozenFailureClassification>,
  settledGames: ReadonlyMap<string, SettledGameTruth>,
  referenceMarkets: ReadonlyMap<string, FrozenReferenceMarket> = new Map(),
): { rows: unknown[][]; snapshot_mismatches: number } {
  const rows: unknown[][] = [];
  let snapshotMismatches = 0;
  for (const [observationKey, classification] of classifications) {
    const game = settledGames.get(observationKey);
    if (!game) continue;
    if (game.snapshot_ts !== classification.snapshot_ts) {
      snapshotMismatches++;
      continue;
    }
    const market = referenceMarkets.get(observationKey);
    // A reference-market row is usable only when it preserves the exact same
    // packet snapshot. A market mismatch is simply not gradeable, never a
    // reason to alter an otherwise valid price-blind classification.
    const matchedMarket = market?.snapshot_ts === classification.snapshot_ts
      ? market
      : undefined;
    const majorMiss = game.total_abs_error >= MAJOR_CENTER_MISS_RESEARCH_THRESHOLD;
    const warned = classification.distribution_structure_status !== "NO_CLASSIFIED_WIDENING_PATH";
    rows.push([
      classification.date,
      classification.game_id,
      classification.snapshot_ts,
      classification.classification_status,
      classification.opener_chain_status,
      classification.scoring_path_status,
      classification.traffic_conversion_status,
      classification.traffic_damage_cosign_status,
      classification.cosign_fragility_status,
      classification.distribution_structure_status,
      classification.distribution_risk_tags,
      matchedMarket?.reference_market_line ?? "",
      referenceMarketDirection(matchedMarket),
      referenceDirectionalResult(matchedMarket, game.actual_total),
      game.actual_total,
      game.total_error,
      game.total_abs_error,
      game.actual_starter_window_runs ?? "",
      game.actual_bullpen_window_runs ?? "",
      game.primary_scoring_mechanism,
      game.allocation_mae ?? "",
      game.allocation_sign_reversal,
      game.away_conversion_outcome,
      game.home_conversion_outcome,
      coSignComparisonBucket(classification.traffic_damage_cosign_status),
      majorMiss ? "ABS_ERROR_4_PLUS" : "ABS_ERROR_UNDER_4",
      warned ? "WARNED" : "NO_WARNING",
      warningOutcomeQuadrant(warned, majorMiss),
      !warned && majorMiss ? "TRUE" : "FALSE",
      "FROZEN_CLASSIFICATION_RESEARCH_ONLY",
      game.settlement_ts,
    ]);
  }
  return { rows, snapshot_mismatches: snapshotMismatches };
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : round2(values.reduce((sum, current) => sum + current, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[midpoint]!
    : round2((ordered[midpoint - 1]! + ordered[midpoint]!) / 2);
}

interface ClassificationFamilyValue {
  family: string;
  value: string;
}

function classificationFamilyValues(
  row: unknown[],
  index: ReadonlyMap<string, number>,
): ClassificationFamilyValue[] {
  const single = (family: string, header: string): ClassificationFamilyValue[] => {
    const classification = text(value(row, index, header));
    return classification ? [{ family, value: classification }] : [];
  };
  const tags = text(value(row, index, "Frozen_Distribution_Risk_Tags"));
  const tagValues = tags && tags !== "NO_CLASSIFIED_RISK_TAG"
    ? tags.split(";").map((tag) => tag.trim()).filter(Boolean)
    : ["NO_CLASSIFIED_RISK_TAG"];
  return [
    ...single("OPENER_CHAIN", "Frozen_Opener_Chain_Status"),
    ...single("SCORING_PATH", "Frozen_Scoring_Path_Status"),
    ...single("TRAFFIC_DAMAGE_COSIGN", "Frozen_Traffic_Damage_CoSign_Status"),
    ...single("CO_SIGN_COMPARISON", "CoSign_Comparison_Bucket"),
    ...single("CO_SIGN_FRAGILITY", "Frozen_CoSign_Fragility_Status"),
    ...single("DISTRIBUTION_STRUCTURE", "Frozen_Distribution_Structure_Status"),
    ...single("WARNING_OUTCOME_QUADRANT", "Warning_Outcome_Quadrant"),
    ...single("FALSE_NEGATIVE_DISTRIBUTION", "False_Negative_Distribution_Case"),
    ...tagValues.map((tag) => ({ family: "DISTRIBUTION_RISK_TAG", value: tag })),
  ];
}

/**
 * Descriptive discrimination report only. The 4-run field is the explicitly
 * requested postgame research cut; no row maps this statistic to an active
 * threshold, penalty, confidence change, or authorization behavior.
 */
export function buildFailureClassificationDiscriminationRows(
  replayRows: unknown[][],
  replayTs: string,
): unknown[][] {
  const index = headerIndex(FAILURE_CLASSIFICATION_REPLAY_HEADERS as unknown as unknown[]);
  const groups = new Map<string, { family: string; value: string; rows: unknown[][] }>();
  for (const row of replayRows) {
    for (const classification of classificationFamilyValues(row, index)) {
      const groupKey = `${classification.family}|${classification.value}`;
      const group = groups.get(groupKey) ?? {
        family: classification.family,
        value: classification.value,
        rows: [],
      };
      group.rows.push(row);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.family.localeCompare(right.family) || left.value.localeCompare(right.value))
    .map((group) => {
      const absErrors = group.rows
        .map((row) => numeric(value(row, index, "Total_Abs_Error")))
        .filter((entry): entry is number => entry !== null);
      const signedErrors = group.rows
        .map((row) => numeric(value(row, index, "Total_Error")))
        .filter((entry): entry is number => entry !== null);
      const starterRuns = group.rows
        .map((row) => numeric(value(row, index, "Actual_Starter_Window_Runs")))
        .filter((entry): entry is number => entry !== null);
      const bullpenRuns = group.rows
        .map((row) => numeric(value(row, index, "Actual_Bullpen_Window_Runs")))
        .filter((entry): entry is number => entry !== null);
      const directional = group.rows.map((row) => text(value(row, index, "Reference_Directional_Result")));
      const mechanisms = group.rows.map((row) => text(value(row, index, "Primary_Scoring_Mechanism")));
      const majorMissCount = group.rows.filter(
        (row) => text(value(row, index, "Major_Center_Miss_Status")) === "ABS_ERROR_4_PLUS",
      ).length;
      const directionalEligible = directional.filter((result) => result !== "NOT_GRADABLE");
      return [
        group.family,
        group.value,
        group.rows.length,
        mean(absErrors) ?? "",
        median(absErrors) ?? "",
        mean(signedErrors) ?? "",
        majorMissCount,
        group.rows.length === 0 ? "" : round2(majorMissCount / group.rows.length),
        directional.filter((result) => result === "WIN").length,
        directional.filter((result) => result === "LOSS").length,
        directional.filter((result) => result === "PUSH").length,
        directionalEligible.length,
        mean(starterRuns) ?? "",
        mean(bullpenRuns) ?? "",
        mechanisms.filter((mechanism) => mechanism === "STARTER_WINDOW_PRIMARY").length,
        mechanisms.filter((mechanism) => mechanism === "BULLPEN_TRANSITION_PRIMARY").length,
        mechanisms.filter((mechanism) => mechanism === "BALANCED_STARTER_AND_BULLPEN").length,
        mechanisms.filter((mechanism) => ![
          "STARTER_WINDOW_PRIMARY",
          "BULLPEN_TRANSITION_PRIMARY",
          "BALANCED_STARTER_AND_BULLPEN",
        ].includes(mechanism)).length,
        "RESEARCH_ONLY_NO_PROMOTION",
        replayTs,
      ];
    });
}

export async function runFailureClassificationReplay(
  options: { workbookId?: string } = {},
): Promise<FailureClassificationReplayResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTimestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [classificationRows, gameTruthRows, packetRows] = await Promise.all([
      readOptionalSheet(workbookId, `${FAILURE_CLASSIFICATION_SHADOW_SHEET}!A1:AZ10000`, warnings),
      readOptionalSheet(workbookId, "GAME_TRUTH_REPLAY_V1!A1:AZ10000", warnings),
      readOptionalSheet(workbookId, `${PREGAME_PACKET_HISTORY_SHEET}!A1:CZ10000`, warnings),
    ]);
    const classifications = parseFrozenFailureClassifications(classificationRows);
    const settledGames = parseSettledFailureClassificationGameTruth(gameTruthRows);
    const referenceMarkets = parseFrozenReferenceMarkets(packetRows);
    const replay = buildFailureClassificationReplayRows(
      classifications,
      settledGames,
      referenceMarkets,
    );
    const discrimination = buildFailureClassificationDiscriminationRows(
      replay.rows,
      replayTimestamp,
    );
    if (replay.snapshot_mismatches > 0) {
      warnings.push(
        `FROZEN_CLASSIFICATION_SNAPSHOT_MISMATCH: ${replay.snapshot_mismatches} join(s) excluded`,
      );
    }
    await ensureSheet(
      workbookId,
      FAILURE_CLASSIFICATION_REPLAY_SHEET,
      FAILURE_CLASSIFICATION_REPLAY_HEADERS.length,
    );
    await ensureSheet(
      workbookId,
      FAILURE_CLASSIFICATION_DISCRIMINATION_SHEET,
      FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS.length,
    );
    await Promise.all([
      writeRange(workbookId, `${FAILURE_CLASSIFICATION_REPLAY_SHEET}!A1`, [
        Array.from(FAILURE_CLASSIFICATION_REPLAY_HEADERS),
        ...replay.rows,
      ]),
      writeRange(workbookId, `${FAILURE_CLASSIFICATION_DISCRIMINATION_SHEET}!A1`, [
        Array.from(FAILURE_CLASSIFICATION_DISCRIMINATION_HEADERS),
        ...discrimination,
      ]),
    ]);
    logger.info(
      {
        frozen_classifications_seen: classifications.size,
        eligible_games: replay.rows.length,
        discrimination_rows: discrimination.length,
      },
      "MODULE_26: failure classification replay written (research-only)",
    );
    return {
      status: "success",
      replay_timestamp_utc: replayTimestamp,
      frozen_classifications_seen: classifications.size,
      eligible_games: replay.rows.length,
      replay_rows_written: replay.rows.length,
      discrimination_rows_written: discrimination.length,
      snapshot_mismatches: replay.snapshot_mismatches,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_26: failure classification replay failed");
    return {
      status: "failure",
      replay_timestamp_utc: replayTimestamp,
      frozen_classifications_seen: 0,
      eligible_games: 0,
      replay_rows_written: 0,
      discrimination_rows_written: 0,
      snapshot_mismatches: 0,
      warnings,
      errors,
    };
  }
}
