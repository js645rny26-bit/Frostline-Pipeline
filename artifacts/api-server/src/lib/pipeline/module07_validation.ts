/**
 * Module 07: Validation
 * Validates the normalized slate against critical/warning/info rules.
 */

import { VALIDATION_RULES } from "./config.js";
import { logger } from "../../lib/logger.js";
import type { NormalizationResult } from "./module06_normalization.js";

export interface ValidationResult {
  validation_timestamp_utc: string;
  status: string;
  critical_failures: string[];
  warnings: string[];
  info_notes: string[];
}

export function validateNormalizedSlate(normalized: NormalizationResult): ValidationResult {
  logger.info("MODULE_07: Validating slate");

  const critical: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const games = normalized.games;

  // WARNING (not critical): atypical slate size.
  // A small slate does not threaten projection integrity — it is a calendar artefact.
  // Only missing games, bad joins, or impossible values are truly critical.
  if (games.length < VALIDATION_RULES.game_count.min_expected) {
    warnings.push(`[ATYPICAL_SLATE_SIZE] Game count ${games.length} is below typical range of ${VALIDATION_RULES.game_count.min_expected}–${VALIDATION_RULES.game_count.max_expected} — projections are unaffected`);
  }

  // CRITICAL: All games must have a gamePk
  for (const game of games) {
    if (!game.gamePk) {
      critical.push(`Missing gamePk in game: ${game.legacy_game_id}`);
    }
  }

  // WARNING: Unresolved pitcher roles
  let unresolvedCount = 0;
  for (const game of games) {
    if (game.away_pitcher.role === "UNRESOLVED") unresolvedCount++;
    if (game.home_pitcher.role === "UNRESOLVED") unresolvedCount++;
  }
  if (unresolvedCount > 0) {
    warnings.push(`${unresolvedCount} pitchers with UNRESOLVED roles`);
  }

  // WARNING: Weather fallback usage
  const fallbackWeatherCount = games.filter((g) => g.environment.data_quality === "fallback").length;
  if (fallbackWeatherCount > 0) {
    warnings.push(`${fallbackWeatherCount} games using fallback weather data`);
  }

  // INFO: Doubleheaders
  const doubleheaders = games.filter((g) => g.doubleheader_status !== "N" && g.doubleheader_status !== "NONE");
  for (const dh of doubleheaders) {
    info.push(`Doubleheader game detected: ${dh.legacy_game_id}`);
  }

  // INFO: Game count if within expected range
  if (games.length >= VALIDATION_RULES.game_count.min_expected && games.length <= VALIDATION_RULES.game_count.max_expected) {
    info.push(`Game count ${games.length} is within expected range (${VALIDATION_RULES.game_count.min_expected}–${VALIDATION_RULES.game_count.max_expected})`);
  }

  const status = critical.length > 0 ? "FAIL" : "PASS";
  logger.info({ status, critical: critical.length, warnings: warnings.length }, "MODULE_07: Validation complete");

  return {
    validation_timestamp_utc: new Date().toISOString(),
    status,
    critical_failures: critical,
    warnings,
    info_notes: info,
  };
}
