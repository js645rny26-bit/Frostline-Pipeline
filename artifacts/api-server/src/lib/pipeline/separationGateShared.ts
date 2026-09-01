/**
 * Frozen, shadow-only pre-registration for the projection-separation audit.
 *
 * These helpers intentionally do not know a direction, market price, vehicle,
 * decision, or outcome. They only classify a frozen price-blind structural
 * cohort and the distance from the already-queried full-game total.
 */

export const SEPARATION_GATE_PRE_REGISTRATION_VERSION =
  "SEPARATION_GATE_AUDIT_V1_2026-09-01";

/**
 * Fixed primary cohort definition. Derived from price-blind Truth checks,
 * explicitly excluding Vehicle checks, edge magnitude, direction, and 1.5.
 */
export const PRICE_BLIND_STRUCTURAL_REQUIRED_TRUTH_CHECKS = [
  "STARTERS_RESOLVED",
  "EXPECTED_INNINGS_PRESENT",
  "BULLPEN_USABLE",
  "OFFENSE_SOURCE_USABLE",
  "LINEUP_DATA_USABLE",
  "PARK_SOURCE_USABLE",
] as const;

export type PriceBlindStructuralEligibilityStatus =
  | "PRICE_BLIND_STRUCTURAL_ELIGIBLE"
  | "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_FAILED"
  | "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_MISSING";

export interface PriceBlindStructuralEligibility {
  status: PriceBlindStructuralEligibilityStatus;
  failed_or_missing_checks: string;
}

export type SeparationCohort =
  | "NO_QUERY_LINE"
  | "LOW_UNDER_0.75"
  | "MODERATE_0.75_1.24"
  | "NEAR_BOUNDARY_1.25_1.49"
  | "CURRENT_QUALIFIED_1.50_1.99"
  | "LARGE_2.00_PLUS";

export type AdjacentThresholdCohort =
  | "NO_QUERY_LINE"
  | "NEAR_BOUNDARY_1.25_1.49"
  | "ADJACENT_ABOVE_1.50_1.74"
  | "OUTSIDE_ADJACENT_COMPARISON";

export type SeparationMarketProvenance =
  | "NO_QUERY_LINE"
  | "REFERENCE_ONLY_RESEARCH"
  | "LITERAL_EXECUTABLE_HARD_ROCK";

export type HardRockCalibrationEvidenceStatus =
  | "NO_QUERY_LINE"
  | "REFERENCE_ONLY_NOT_HARD_ROCK_CALIBRATION"
  | "LITERAL_HARD_ROCK_HALF_TOTAL"
  | "LITERAL_HARD_ROCK_NON_HALF_TOTAL_RESEARCH_ONLY";

export interface FrozenSeparationState {
  pre_registration_version: string;
  price_blind_structural_eligibility_status: PriceBlindStructuralEligibilityStatus;
  price_blind_structural_failed_checks: string;
  separation_query_line: number | null;
  separation_market_provenance: SeparationMarketProvenance;
  separation_hard_rock_calibration_status: HardRockCalibrationEvidenceStatus;
  separation_continuous: number | null;
  separation_cohort: SeparationCohort;
  separation_adjacent_threshold_cohort: AdjacentThresholdCohort;
  separation_research_tag: string;
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

/** Parse the frozen Module 11 serialization without depending on any score. */
function truthCheckState(serializedChecks: string, checkName: string): "PASS" | "FAIL" | null {
  const pattern = new RegExp(`(?:^|\\s*\\|\\s*)${checkName}=(PASS|FAIL)(?:\\([^)]*\\))?(?=\\s*\\||$)`);
  const match = serializedChecks.match(pattern);
  return match?.[1] === "PASS" ? "PASS" : match?.[1] === "FAIL" ? "FAIL" : null;
}

export function classifyPriceBlindStructuralEligibility(
  truthChecks: unknown,
): PriceBlindStructuralEligibility {
  const serialized = String(truthChecks ?? "").trim();
  const missing: string[] = [];
  const failed: string[] = [];
  for (const check of PRICE_BLIND_STRUCTURAL_REQUIRED_TRUTH_CHECKS) {
    const state = truthCheckState(serialized, check);
    if (state === null) missing.push(check);
    else if (state === "FAIL") failed.push(check);
  }
  if (missing.length > 0) {
    return {
      status: "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_MISSING",
      failed_or_missing_checks: missing.map((check) => `MISSING_${check}`).join("; "),
    };
  }
  if (failed.length > 0) {
    return {
      status: "PRICE_BLIND_STRUCTURAL_INELIGIBLE_TRUTH_CHECKS_FAILED",
      failed_or_missing_checks: failed.join("; "),
    };
  }
  return {
    status: "PRICE_BLIND_STRUCTURAL_ELIGIBLE",
    failed_or_missing_checks: "",
  };
}

export function classifySeparationCohort(separation: number | null): SeparationCohort {
  if (separation === null || !Number.isFinite(separation)) return "NO_QUERY_LINE";
  if (separation < 0.75) return "LOW_UNDER_0.75";
  if (separation < 1.25) return "MODERATE_0.75_1.24";
  if (separation < 1.5) return "NEAR_BOUNDARY_1.25_1.49";
  if (separation < 2) return "CURRENT_QUALIFIED_1.50_1.99";
  return "LARGE_2.00_PLUS";
}

export function classifyAdjacentThresholdCohort(separation: number | null): AdjacentThresholdCohort {
  if (separation === null || !Number.isFinite(separation)) return "NO_QUERY_LINE";
  if (separation >= 1.25 && separation < 1.5) return "NEAR_BOUNDARY_1.25_1.49";
  if (separation >= 1.5 && separation < 1.75) return "ADJACENT_ABOVE_1.50_1.74";
  return "OUTSIDE_ADJACENT_COMPARISON";
}

function isHalfNumber(value: number): boolean {
  const doubled = value * 2;
  return Math.abs(doubled - Math.round(doubled)) < 1e-9
    && Math.abs(value - Math.round(value)) > 1e-9;
}

/**
 * Freeze research state at pregame time. A reference line is research evidence
 * only; it is never represented as literal Hard Rock calibration evidence.
 */
export function buildFrozenSeparationState(input: {
  truth_checks: unknown;
  projected_total: number | null | undefined;
  query_line: number | null | undefined;
  has_literal_executable_hard_rock_line: boolean;
}): FrozenSeparationState {
  const eligibility = classifyPriceBlindStructuralEligibility(input.truth_checks);
  const line = input.query_line === null || input.query_line === undefined
    || !Number.isFinite(input.query_line) ? null : input.query_line;
  const separation = line === null || input.projected_total === null || input.projected_total === undefined
    || !Number.isFinite(input.projected_total) ? null : rounded(Math.abs(input.projected_total - line));
  const cohort = classifySeparationCohort(separation);
  const provenance: SeparationMarketProvenance = line === null
    ? "NO_QUERY_LINE"
    : input.has_literal_executable_hard_rock_line
      ? "LITERAL_EXECUTABLE_HARD_ROCK"
      : "REFERENCE_ONLY_RESEARCH";
  const hardRockStatus: HardRockCalibrationEvidenceStatus = line === null
    ? "NO_QUERY_LINE"
    : !input.has_literal_executable_hard_rock_line
      ? "REFERENCE_ONLY_NOT_HARD_ROCK_CALIBRATION"
      : isHalfNumber(line)
        ? "LITERAL_HARD_ROCK_HALF_TOTAL"
        : "LITERAL_HARD_ROCK_NON_HALF_TOTAL_RESEARCH_ONLY";
  const tag = provenance === "REFERENCE_ONLY_RESEARCH"
    ? cohort === "NEAR_BOUNDARY_1.25_1.49"
      ? "NEAR_BOUNDARY_REFERENCE"
      : `REFERENCE_ONLY_${cohort}`
    : provenance === "LITERAL_EXECUTABLE_HARD_ROCK"
      ? `HARD_ROCK_${cohort}`
      : "NO_QUERY_LINE";
  return {
    pre_registration_version: SEPARATION_GATE_PRE_REGISTRATION_VERSION,
    price_blind_structural_eligibility_status: eligibility.status,
    price_blind_structural_failed_checks: eligibility.failed_or_missing_checks,
    separation_query_line: line,
    separation_market_provenance: provenance,
    separation_hard_rock_calibration_status: hardRockStatus,
    separation_continuous: separation,
    separation_cohort: cohort,
    separation_adjacent_threshold_cohort: classifyAdjacentThresholdCohort(separation),
    separation_research_tag: tag,
  };
}
