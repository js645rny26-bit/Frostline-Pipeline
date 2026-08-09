export type DirectionalOutcome = "WIN" | "LOSS" | "PUSH" | "NOT_EVALUABLE";

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
