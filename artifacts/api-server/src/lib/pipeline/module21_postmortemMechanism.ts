/**
 * Module 21: evidence-backed postmortem mechanism classification.
 *
 * This classifier explains a settled result. It never changes the ticket result
 * and never infers a mechanism from the final score alone.
 */

export type PostmortemMechanism =
  | "THESIS_WRONG_FROM_OUTSET"
  | "STARTER_SURVIVAL_MISREAD"
  | "STARTER_FAILURE_MISREAD"
  | "BULLPEN_BRIDGE_FAILURE"
  | "CONVERSION_FAILURE"
  | "LATE_VARIANCE"
  | "EXTRA_INNING_STATE_CHANGE"
  | "NOT_CLASSIFIED_INSUFFICIENT_EVENT_EVIDENCE";

export interface PostmortemEventEvidence {
  thesis_wrong_from_outset?: boolean;
  starter_survival_misread?: boolean;
  starter_failure_misread?: boolean;
  bullpen_bridge_failure?: boolean;
  conversion_failure?: boolean;
  late_variance?: boolean;
  extra_inning_state_change?: boolean;
}

export interface PostmortemMechanismClassification {
  primary: PostmortemMechanism;
  contributing: PostmortemMechanism[];
}

const ORDER: Array<[keyof PostmortemEventEvidence, PostmortemMechanism]> = [
  ["extra_inning_state_change", "EXTRA_INNING_STATE_CHANGE"],
  ["thesis_wrong_from_outset", "THESIS_WRONG_FROM_OUTSET"],
  ["starter_survival_misread", "STARTER_SURVIVAL_MISREAD"],
  ["starter_failure_misread", "STARTER_FAILURE_MISREAD"],
  ["bullpen_bridge_failure", "BULLPEN_BRIDGE_FAILURE"],
  ["conversion_failure", "CONVERSION_FAILURE"],
  ["late_variance", "LATE_VARIANCE"],
];

export function classifyPostmortemMechanism(
  evidence?: PostmortemEventEvidence,
): PostmortemMechanismClassification {
  const matches = evidence
    ? ORDER.filter(([key]) => evidence[key]).map(([, mechanism]) => mechanism)
    : [];
  if (matches.length === 0) {
    return {
      primary: "NOT_CLASSIFIED_INSUFFICIENT_EVENT_EVIDENCE",
      contributing: [],
    };
  }
  return { primary: matches[0]!, contributing: matches.slice(1) };
}

export function formatPostmortemMechanism(
  classification: PostmortemMechanismClassification,
): string {
  return [classification.primary, ...classification.contributing].join(" | ");
}
