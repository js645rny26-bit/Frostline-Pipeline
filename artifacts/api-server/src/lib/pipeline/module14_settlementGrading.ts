import { isHalfNumberFullGameTotal } from "./marketLineNormalization.js";

export type DirectionalOutcome = "WIN" | "LOSS" | "PUSH" | "NOT_EVALUABLE";

export type HardRockFullGameTotalIntegrityStatus =
  | "VALID_LITERAL_HALF_NUMBER"
  | "MISSING_LITERAL_EXECUTABLE_LINE"
  | "MARKET_LINE_INTEGRITY_FAILURE";

export interface HardRockFullGameTotalGrade {
  outcome: Exclude<DirectionalOutcome, "PUSH">;
  integrity_status: HardRockFullGameTotalIntegrityStatus;
}

/**
 * Grade a frozen total direction against its market line.
 * PUSH is a first-class outcome and is never collapsed into a loss.
 */
export function gradeDirectionalOutcome(
  direction: string,
  marketLine: number | null,
  actualTotal: number | null,
): DirectionalOutcome {
  if (
    marketLine === null ||
    actualTotal === null ||
    (direction !== "OVER" && direction !== "UNDER")
  ) {
    return "NOT_EVALUABLE";
  }

  const difference = actualTotal - marketLine;
  if (difference === 0) return "PUSH";
  if (direction === "OVER") return difference > 0 ? "WIN" : "LOSS";
  return difference < 0 ? "WIN" : "LOSS";
}

/**
 * Grade the active Florida Hard Rock MLB full-game-total vehicle.
 *
 * That executable market is a literal half-number market. A missing or
 * non-half-number line is a market-lineage failure, never a reference fallback
 * and never a PUSH. The generic grader above deliberately retains PUSH for
 * legitimate historical/other-book whole-number markets.
 */
export function gradeHardRockMlbFullGameTotal(
  direction: string,
  marketLine: number | null,
  actualTotal: number | null,
): HardRockFullGameTotalGrade {
  if (marketLine === null) {
    return {
      outcome: "NOT_EVALUABLE",
      integrity_status: "MISSING_LITERAL_EXECUTABLE_LINE",
    };
  }
  if (!isHalfNumberFullGameTotal(marketLine)) {
    return {
      outcome: "NOT_EVALUABLE",
      integrity_status: "MARKET_LINE_INTEGRITY_FAILURE",
    };
  }

  const outcome = gradeDirectionalOutcome(direction, marketLine, actualTotal);
  // Integer MLB game totals cannot equal a half-number line. Retain a hard
  // assertion in case malformed actual data ever makes that impossible state
  // appear rather than allowing PUSH to leak into the Hard Rock path.
  if (outcome === "PUSH") {
    return {
      outcome: "NOT_EVALUABLE",
      integrity_status: "MARKET_LINE_INTEGRITY_FAILURE",
    };
  }
  return {
    outcome,
    integrity_status: "VALID_LITERAL_HALF_NUMBER",
  };
}
