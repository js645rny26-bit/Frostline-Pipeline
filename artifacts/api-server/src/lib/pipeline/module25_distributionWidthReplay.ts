/**
 * Module 25: Distribution Width Replay V1
 *
 * Research-only replay of whether frozen pregame uncertainty evidence explains
 * realized error width. It never creates a replacement projection, a run-band
 * coefficient, a vehicle, or an authorization outcome.
 *
 * The module joins only FROZEN_PREGAME packets to GAME_TRUTH_REPLAY_V1 rows,
 * which already join those packets to official settlement evidence. Missing or
 * post-first-pitch packets are excluded rather than reconstructed.
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

const REPLAY_SHEET = "DISTRIBUTION_WIDTH_REPLAY_V1";
const SUMMARY_SHEET = "DISTRIBUTION_WIDTH_REPLAY_SUMMARY";

export const DISTRIBUTION_WIDTH_REPLAY_HEADERS = [
  "Date",
  "Game_ID",
  "Frozen_Packet_Snapshot_TS",
  "Frozen_Projected_Total",
  "Actual_Total",
  "Total_Error",
  "Total_Abs_Error",
  "Total_Squared_Error",
  "Frozen_Starter_Attack_Runs",
  "Actual_Starter_Window_Runs",
  "Starter_Window_Error",
  "Starter_Window_Abs_Error",
  "Frozen_Bullpen_Continuation_Runs",
  "Actual_Bullpen_Window_Runs",
  "Bullpen_Window_Error",
  "Bullpen_Window_Abs_Error",
  "Frozen_Away_Bullpen_Exposure_IP",
  "Frozen_Home_Bullpen_Exposure_IP",
  "Frozen_Combined_Bullpen_Exposure_IP",
  "Frozen_Away_Starter_Pressure_Shortfall_IP",
  "Frozen_Home_Starter_Pressure_Shortfall_IP",
  "Frozen_Combined_Starter_Pressure_Shortfall_IP",
  "Frozen_SSAT_Family_Base_Spread",
  "Frozen_Collision_Status",
  "Frozen_Collision_Traffic_Estimate",
  "Frozen_Collision_Damage_Estimate",
  "Frozen_Collision_Tail_Adjustment",
  "Frozen_Low_Center_Status",
  "Frozen_Low_Center_Upper_Band_Delta",
  "Frozen_Allocation_Separation",
  "Actual_Bullpen_Run_Share",
  "Actual_Starter_Run_Share",
  "Allocation_MAE",
  "Allocation_Sign_Reversal",
  "Primary_Scoring_Mechanism",
  "Away_Conversion_Outcome",
  "Home_Conversion_Outcome",
  "Replay_Status",
  "Settlement_TS",
] as const;

export const DISTRIBUTION_WIDTH_SUMMARY_HEADERS = [
  "Feature",
  "Outcome_Metric",
  "Eligible_N",
  "Pearson_Correlation",
  "Feature_Min",
  "Feature_Max",
  "Outcome_Mean",
  "Research_Status",
  "Replay_TS",
] as const;

interface FrozenDistributionPacket {
  date: string;
  game_id: string;
  snapshot_ts: string;
  projected_total: number;
  projected_away_runs: number;
  projected_home_runs: number;
  starter_attack_runs: number | null;
  bullpen_continuation_runs: number | null;
  away_bullpen_exposure_ip: number | null;
  home_bullpen_exposure_ip: number | null;
  away_starter_pressure_shortfall_ip: number | null;
  home_starter_pressure_shortfall_ip: number | null;
  ssat_family_base_spread: number | null;
  collision_status: string;
  collision_traffic_estimate: number | null;
  collision_damage_estimate: number | null;
  collision_tail_adjustment: number | null;
  low_center_status: string;
  low_center_upper_band_delta: number | null;
}

interface SettledGameTruth {
  date: string;
  game_id: string;
  snapshot_ts: string;
  actual_total: number;
  total_error: number;
  total_abs_error: number;
  allocation_mae: number | null;
  allocation_sign_reversal: string;
  actual_starter_window_runs: number | null;
  actual_bullpen_window_runs: number | null;
  primary_scoring_mechanism: string;
  away_conversion_outcome: string;
  home_conversion_outcome: string;
  settlement_ts: string;
}

export interface DistributionWidthReplayResult {
  status: "success" | "failure";
  replay_timestamp_utc: string;
  frozen_packets_seen: number;
  eligible_games: number;
  replay_rows_written: number;
  summary_rows_written: number;
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

function isValidBeforeFirstPitch(snapshotTs: string, firstPitch: string): boolean {
  const snapshotMs = Date.parse(snapshotTs);
  const firstPitchMs = Date.parse(firstPitch);
  return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
}

function headerIndex(header: unknown[]): Map<string, number> {
  return new Map(header.map((name, index) => [text(name), index]));
}

function value(row: unknown[], index: ReadonlyMap<string, number>, name: string): unknown {
  const column = index.get(name);
  return column === undefined ? undefined : row[column];
}

function positiveDifference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : round2(Math.max(0, left - right));
}

function ssatFamilySpread(
  base: number,
  v1: number | null,
  v2: number | null,
): number | null {
  const distances = [v1, v2]
    .filter((candidate): candidate is number => candidate !== null)
    .map((candidate) => Math.abs(base - candidate));
  return distances.length === 0 ? null : round2(Math.max(...distances));
}

/** Parse strictly frozen packet evidence; no current or OPEN packet may enter replay. */
export function parseFrozenDistributionPackets(rows: unknown[][]): Map<string, FrozenDistributionPacket> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const packetByGame = new Map<string, FrozenDistributionPacket>();
  const latestSnapshotMs = new Map<string, number>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Packet_Snapshot_TS"));
    const firstPitch = text(value(row, index, "Scheduled_First_Pitch"));
    const base = numeric(value(row, index, "Base_Projection"));
    const away = numeric(value(row, index, "Base_Away_Projection"));
    const home = numeric(value(row, index, "Base_Home_Projection"));
    const snapshotMs = Date.parse(snapshotTs);
    if (
      !date
      || !gameId
      || text(value(row, index, "Packet_Status")) !== "FROZEN_PREGAME"
      || !isValidBeforeFirstPitch(snapshotTs, firstPitch)
      || base === null
      || away === null
      || home === null
      || !Number.isFinite(snapshotMs)
      || snapshotMs < (latestSnapshotMs.get(key(date, gameId)) ?? Number.NEGATIVE_INFINITY)
    ) continue;

    const awayExpected = numeric(value(row, index, "Away_Expected_IP"));
    const homeExpected = numeric(value(row, index, "Home_Expected_IP"));
    const awayEffective = numeric(value(row, index, "Away_Pitcher_Effective_IP"));
    const homeEffective = numeric(value(row, index, "Home_Pitcher_Effective_IP"));
    const lowCenterUpperBand = numeric(value(row, index, "Low_Center_Upper_Band"));
    const observation: FrozenDistributionPacket = {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      projected_total: base,
      projected_away_runs: away,
      projected_home_runs: home,
      starter_attack_runs: numeric(value(row, index, "Starter_Attack_Runs")),
      bullpen_continuation_runs: numeric(value(row, index, "Bullpen_Continuation_Runs")),
      away_bullpen_exposure_ip: numeric(value(row, index, "Away_Bullpen_Exposure_IP")),
      home_bullpen_exposure_ip: numeric(value(row, index, "Home_Bullpen_Exposure_IP")),
      away_starter_pressure_shortfall_ip: positiveDifference(awayExpected, awayEffective),
      home_starter_pressure_shortfall_ip: positiveDifference(homeExpected, homeEffective),
      ssat_family_base_spread: ssatFamilySpread(
        base,
        numeric(value(row, index, "SSAT_V1_Total")),
        numeric(value(row, index, "SSAT_V2_Total")),
      ),
      collision_status: text(value(row, index, "Collision_Status")),
      collision_traffic_estimate: numeric(value(row, index, "Collision_Traffic_Estimate")),
      collision_damage_estimate: numeric(value(row, index, "Collision_Damage_Estimate")),
      collision_tail_adjustment: numeric(value(row, index, "Collision_Tail_Adjustment")),
      low_center_status: text(value(row, index, "Low_Center_Status")),
      low_center_upper_band_delta:
        lowCenterUpperBand === null ? null : round2(lowCenterUpperBand - base),
    };
    const observationKey = key(date, gameId);
    packetByGame.set(observationKey, observation);
    latestSnapshotMs.set(observationKey, snapshotMs);
  }
  return packetByGame;
}

/** Parse only the already settled frozen-packet game-truth surface. */
export function parseSettledGameTruth(rows: unknown[][]): Map<string, SettledGameTruth> {
  const [header = [], ...data] = rows;
  const index = headerIndex(header);
  const games = new Map<string, SettledGameTruth>();
  for (const row of data) {
    const date = text(value(row, index, "Date"));
    const gameId = text(value(row, index, "Game_ID"));
    const snapshotTs = text(value(row, index, "Frozen_Packet_Snapshot_TS"));
    const actual = numeric(value(row, index, "Actual_Total"));
    const totalError = numeric(value(row, index, "Total_Error"));
    const totalAbsError = numeric(value(row, index, "Total_Abs_Error"));
    if (
      !date
      || !gameId
      || !snapshotTs
      || actual === null
      || totalError === null
      || totalAbsError === null
      // GAME_TRUTH_REPLAY_V1's canonical settled status explicitly confirms
      // both the frozen packet and final official outcome.  Module 25 is a
      // downstream replay of that canonical surface, not of the earlier
      // per-diagnostic FROZEN_PACKET_VERIFIED rows.
      || text(value(row, index, "Replay_Status")) !== "FROZEN_PACKET_AND_FINAL_VERIFIED"
    ) continue;
    games.set(key(date, gameId), {
      date,
      game_id: gameId,
      snapshot_ts: snapshotTs,
      actual_total: actual,
      total_error: totalError,
      total_abs_error: totalAbsError,
      allocation_mae: numeric(value(row, index, "Allocation_MAE")),
      allocation_sign_reversal: text(value(row, index, "Allocation_Sign_Reversal")),
      actual_starter_window_runs: numeric(value(row, index, "Starter_Window_Runs_Total")),
      actual_bullpen_window_runs: numeric(value(row, index, "Bullpen_Window_Runs_Total")),
      primary_scoring_mechanism: text(value(row, index, "Primary_Scoring_Mechanism")),
      away_conversion_outcome: text(value(row, index, "Away_Conversion_Outcome")),
      home_conversion_outcome: text(value(row, index, "Home_Conversion_Outcome")),
      settlement_ts: text(value(row, index, "Settlement_TS")),
    });
  }
  return games;
}

export function buildDistributionWidthReplayRows(
  packets: ReadonlyMap<string, FrozenDistributionPacket>,
  settledGames: ReadonlyMap<string, SettledGameTruth>,
): { rows: unknown[][]; snapshot_mismatches: number } {
  const rows: unknown[][] = [];
  let snapshotMismatches = 0;
  for (const [observationKey, packet] of packets) {
    const settled = settledGames.get(observationKey);
    if (!settled) continue;
    if (settled.snapshot_ts !== packet.snapshot_ts) {
      snapshotMismatches++;
      continue;
    }
    const starterError =
      packet.starter_attack_runs === null || settled.actual_starter_window_runs === null
        ? null
        : round2(packet.starter_attack_runs - settled.actual_starter_window_runs);
    const bullpenError =
      packet.bullpen_continuation_runs === null || settled.actual_bullpen_window_runs === null
        ? null
        : round2(packet.bullpen_continuation_runs - settled.actual_bullpen_window_runs);
    const combinedBullpenExposure =
      packet.away_bullpen_exposure_ip === null || packet.home_bullpen_exposure_ip === null
        ? null
        : round2(packet.away_bullpen_exposure_ip + packet.home_bullpen_exposure_ip);
    const combinedPressureShortfall =
      packet.away_starter_pressure_shortfall_ip === null || packet.home_starter_pressure_shortfall_ip === null
        ? null
        : round2(
          packet.away_starter_pressure_shortfall_ip +
            packet.home_starter_pressure_shortfall_ip,
        );
    const totalSquaredError = round2(settled.total_error ** 2);
    const actualBullpenShare =
      settled.actual_bullpen_window_runs === null || settled.actual_total <= 0
        ? null
        : round2(settled.actual_bullpen_window_runs / settled.actual_total);
    const actualStarterShare =
      settled.actual_starter_window_runs === null || settled.actual_total <= 0
        ? null
        : round2(settled.actual_starter_window_runs / settled.actual_total);
    rows.push([
      packet.date,
      packet.game_id,
      packet.snapshot_ts,
      packet.projected_total,
      settled.actual_total,
      settled.total_error,
      settled.total_abs_error,
      totalSquaredError,
      packet.starter_attack_runs ?? "",
      settled.actual_starter_window_runs ?? "",
      starterError ?? "",
      starterError === null ? "" : Math.abs(starterError),
      packet.bullpen_continuation_runs ?? "",
      settled.actual_bullpen_window_runs ?? "",
      bullpenError ?? "",
      bullpenError === null ? "" : Math.abs(bullpenError),
      packet.away_bullpen_exposure_ip ?? "",
      packet.home_bullpen_exposure_ip ?? "",
      combinedBullpenExposure ?? "",
      packet.away_starter_pressure_shortfall_ip ?? "",
      packet.home_starter_pressure_shortfall_ip ?? "",
      combinedPressureShortfall ?? "",
      packet.ssat_family_base_spread ?? "",
      packet.collision_status || "UNAVAILABLE",
      packet.collision_traffic_estimate ?? "",
      packet.collision_damage_estimate ?? "",
      packet.collision_tail_adjustment ?? "",
      packet.low_center_status || "UNAVAILABLE",
      packet.low_center_upper_band_delta ?? "",
      round2(Math.abs(packet.projected_away_runs - packet.projected_home_runs)),
      actualBullpenShare ?? "",
      actualStarterShare ?? "",
      settled.allocation_mae ?? "",
      settled.allocation_sign_reversal,
      settled.primary_scoring_mechanism,
      settled.away_conversion_outcome,
      settled.home_conversion_outcome,
      "FROZEN_PACKET_RESEARCH_ONLY",
      settled.settlement_ts,
    ]);
  }
  return { rows, snapshot_mismatches: snapshotMismatches };
}

interface ReplayNumericRow {
  [name: string]: number | null;
}

function numericReplayRows(rows: unknown[][]): ReplayNumericRow[] {
  const index = headerIndex(DISTRIBUTION_WIDTH_REPLAY_HEADERS as unknown as unknown[]);
  return rows.map((row) => {
    const output: ReplayNumericRow = {};
    for (const [name, column] of index) output[name] = numeric(row[column]);
    return output;
  });
}

function pearson(points: Array<{ feature: number; outcome: number }>): number | null {
  if (points.length < 2) return null;
  const featureMean = points.reduce((sum, point) => sum + point.feature, 0) / points.length;
  const outcomeMean = points.reduce((sum, point) => sum + point.outcome, 0) / points.length;
  let numerator = 0;
  let featureSquareSum = 0;
  let outcomeSquareSum = 0;
  for (const point of points) {
    const featureDelta = point.feature - featureMean;
    const outcomeDelta = point.outcome - outcomeMean;
    numerator += featureDelta * outcomeDelta;
    featureSquareSum += featureDelta ** 2;
    outcomeSquareSum += outcomeDelta ** 2;
  }
  const denominator = Math.sqrt(featureSquareSum * outcomeSquareSum);
  return denominator === 0 ? null : round2(numerator / denominator);
}

const FEATURE_COLUMNS = [
  "Frozen_Combined_Bullpen_Exposure_IP",
  "Frozen_Combined_Starter_Pressure_Shortfall_IP",
  "Frozen_SSAT_Family_Base_Spread",
  "Frozen_Collision_Traffic_Estimate",
  "Frozen_Collision_Damage_Estimate",
  "Frozen_Collision_Tail_Adjustment",
  "Frozen_Low_Center_Upper_Band_Delta",
  "Frozen_Allocation_Separation",
] as const;

const OUTCOME_COLUMNS = [
  "Total_Abs_Error",
  "Total_Squared_Error",
  "Starter_Window_Abs_Error",
  "Bullpen_Window_Abs_Error",
  "Allocation_MAE",
] as const;

/**
 * Correlation is descriptive only. It deliberately reports its own N and
 * never maps a correlation to a band, coefficient, or operational state.
 */
export function buildDistributionWidthSummary(
  rows: unknown[][],
  replayTs: string,
): unknown[][] {
  const numericRows = numericReplayRows(rows);
  const summaries: unknown[][] = [];
  for (const feature of FEATURE_COLUMNS) {
    for (const outcome of OUTCOME_COLUMNS) {
      const points = numericRows.flatMap((row) => {
        const featureValue = row[feature];
        const outcomeValue = row[outcome];
        return featureValue === null || outcomeValue === null
          ? []
          : [{ feature: featureValue, outcome: outcomeValue }];
      });
      const featureValues = points.map((point) => point.feature);
      const outcomeValues = points.map((point) => point.outcome);
      summaries.push([
        feature,
        outcome,
        points.length,
        pearson(points) ?? "",
        featureValues.length === 0 ? "" : Math.min(...featureValues),
        featureValues.length === 0 ? "" : Math.max(...featureValues),
        outcomeValues.length === 0
          ? ""
          : round2(outcomeValues.reduce((sum, value) => sum + value, 0) / outcomeValues.length),
        "RESEARCH_ONLY_NO_PROMOTION",
        replayTs,
      ]);
    }
  }
  return summaries;
}

async function ensureSheets(
  workbookId: string,
  sheetsToEnsure: Array<{ sheet: string; column_count: number }>,
): Promise<void> {
  const existing = new Set(
    (await getSpreadsheetSheetProperties(workbookId)).map(
      (sheet) => sheet.title,
    ),
  );
  for (const { sheet } of sheetsToEnsure) {
    if (!existing.has(sheet)) {
      await addSheet(workbookId, sheet);
      existing.add(sheet);
    }
  }
  await Promise.all(
    sheetsToEnsure.map(({ sheet, column_count }) =>
      expandSheetColumns(workbookId, sheet, column_count),
    ),
  );
}

function isMissingSheetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to parse range|sheet\s+"?[^\"]+"?\s+not found/i.test(message);
}

async function readOptionalSheet(
  workbookId: string,
  range: string,
  warnings: string[],
): Promise<unknown[][]> {
  try {
    return ((await readRange(workbookId, range)).values ?? []) as unknown[][];
  } catch (error: unknown) {
    if (!isMissingSheetError(error)) throw error;
    warnings.push(`MISSING_REPLAY_SOURCE: ${range}`);
    return [];
  }
}

export async function runDistributionWidthReplay(
  options: { workbookId?: string } = {},
): Promise<DistributionWidthReplayResult> {
  const workbookId = options.workbookId ?? WORKBOOK_ID;
  const replayTimestamp = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const [packetRows, gameTruthRows] = await Promise.all([
      readOptionalSheet(
        workbookId,
        `${PREGAME_PACKET_HISTORY_SHEET}!A1:CZ10000`,
        warnings,
      ),
      readOptionalSheet(
        workbookId,
        "GAME_TRUTH_REPLAY_V1!A1:AZ10000",
        warnings,
      ),
    ]);
    const packets = parseFrozenDistributionPackets(packetRows);
    const settledGames = parseSettledGameTruth(gameTruthRows);
    const replay = buildDistributionWidthReplayRows(packets, settledGames);
    if (replay.snapshot_mismatches > 0) {
      warnings.push(
        `FROZEN_PACKET_SNAPSHOT_MISMATCH: ${replay.snapshot_mismatches} packet/game-truth joins were excluded`,
      );
    }
    const summaryRows = buildDistributionWidthSummary(
      replay.rows,
      replayTimestamp,
    );
    await ensureSheets(workbookId, [
      {
        sheet: REPLAY_SHEET,
        column_count: DISTRIBUTION_WIDTH_REPLAY_HEADERS.length,
      },
      {
        sheet: SUMMARY_SHEET,
        column_count: DISTRIBUTION_WIDTH_SUMMARY_HEADERS.length,
      },
    ]);
    await Promise.all([
      writeRange(workbookId, `${REPLAY_SHEET}!A1`, [
        Array.from(DISTRIBUTION_WIDTH_REPLAY_HEADERS),
        ...replay.rows,
      ]),
      writeRange(workbookId, `${SUMMARY_SHEET}!A1`, [
        Array.from(DISTRIBUTION_WIDTH_SUMMARY_HEADERS),
        ...summaryRows,
      ]),
    ]);
    logger.info(
      {
        frozen_packets_seen: packets.size,
        eligible_games: replay.rows.length,
        summary_rows: summaryRows.length,
      },
      "MODULE_25: distribution-width replay written (research-only)",
    );
    return {
      status: "success",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: packets.size,
      eligible_games: replay.rows.length,
      replay_rows_written: replay.rows.length,
      summary_rows_written: summaryRows.length,
      warnings,
      errors,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ err: message }, "MODULE_25: distribution-width replay failed");
    return {
      status: "failure",
      replay_timestamp_utc: replayTimestamp,
      frozen_packets_seen: 0,
      eligible_games: 0,
      replay_rows_written: 0,
      summary_rows_written: 0,
      warnings,
      errors,
    };
  }
}
