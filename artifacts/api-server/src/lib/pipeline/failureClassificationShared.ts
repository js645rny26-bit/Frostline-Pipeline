/**
 * Shared, price-blind structural classifications for frozen pregame metadata.
 *
 * These labels describe the evidence shape present before first pitch. They
 * are deliberately not projection, market, or authorization inputs.
 */

export interface FailureClassificationEvidence {
  starter_phase_runs: number | null;
  bullpen_continuation_runs: number | null;
  away_starter_role: string;
  home_starter_role: string;
  away_expected_ip: number | null;
  home_expected_ip: number | null;
  collision_status: string;
  collision_traffic_estimate: number | null;
  collision_damage_estimate: number | null;
}

export function classifyOpenerChain(
  evidence: Pick<
    FailureClassificationEvidence,
    "away_starter_role" | "home_starter_role" | "away_expected_ip" | "home_expected_ip"
  >,
): string {
  const roles = [evidence.away_starter_role, evidence.home_starter_role]
    .map((role) => role.toUpperCase())
    .filter(Boolean);
  if (roles.length === 0) return "INSUFFICIENT_STARTER_ROLE_INPUT";
  if (!roles.includes("OPENER")) return "NO_OPENER_IDENTIFIED";
  const expectedIps = [evidence.away_expected_ip, evidence.home_expected_ip];
  return expectedIps.some((innings) => innings === null)
    ? "OPENER_WORKLOAD_UNRESOLVED"
    : "OPENER_CHAIN_UNCERTAINTY";
}

export function classifyScoringPath(
  evidence: Pick<FailureClassificationEvidence, "starter_phase_runs" | "bullpen_continuation_runs">,
): string {
  if (
    evidence.starter_phase_runs === null
    || evidence.bullpen_continuation_runs === null
  ) return "INSUFFICIENT_PHASE_INPUT";
  if (evidence.bullpen_continuation_runs > evidence.starter_phase_runs) {
    return "BULLPEN_PHASE_RELIANT";
  }
  if (evidence.starter_phase_runs > evidence.bullpen_continuation_runs) {
    return "STARTER_PHASE_SUPPORTED";
  }
  return "BALANCED_STARTER_AND_BULLPEN_PATHS";
}

export function classifyTrafficDamageCoSign(
  evidence: Pick<
    FailureClassificationEvidence,
    "collision_status" | "collision_traffic_estimate" | "collision_damage_estimate"
  >,
): string {
  if (evidence.collision_status !== "PROSPECTIVE_SHADOW_CANDIDATE") {
    return "NO_PROSPECTIVE_COLLISION_EVIDENCE";
  }
  const trafficPositive = (evidence.collision_traffic_estimate ?? 0) > 0;
  const damagePositive = (evidence.collision_damage_estimate ?? 0) > 0;
  if (trafficPositive && damagePositive) return "TRAFFIC_AND_DAMAGE_COSIGNED";
  if (trafficPositive) return "TRAFFIC_WITHOUT_DAMAGE_COSIGN";
  if (damagePositive) return "DAMAGE_WITHOUT_TRAFFIC_COSIGN";
  return "NO_POSITIVE_COLLISION_SIGNAL";
}

export function classifyTrafficConversion(coSignStatus: string): string {
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

export function classifyCoSignFragility(coSignStatus: string): string {
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

export function classifyDistributionStructure(
  openerStatus: string,
  scoringPathStatus: string,
  coSignFragilityStatus: string,
): { distributionStructureStatus: string; distributionRiskTags: string } {
  const tags = [
    openerStatus === "OPENER_CHAIN_UNCERTAINTY" || openerStatus === "OPENER_WORKLOAD_UNRESOLVED"
      ? openerStatus
      : "",
    scoringPathStatus === "BULLPEN_PHASE_RELIANT" ? "BULLPEN_CONTINUATION_DEPENDENT" : "",
    coSignFragilityStatus !== "NO_COSIGN_FRAGILITY_CLASSIFICATION" ? coSignFragilityStatus : "",
  ].filter(Boolean);
  const distributionStructureStatus = tags.includes("OPENER_CHAIN_UNCERTAINTY")
    || tags.includes("OPENER_WORKLOAD_UNRESOLVED")
    ? "OPENER_CHAIN_UNCERTAINTY"
    : tags.includes("BULLPEN_CONTINUATION_DEPENDENT")
      ? "BULLPEN_CONTINUATION_TAIL_CANDIDATE"
      : tags.includes("TRAFFIC_DAMAGE_TAIL_CANDIDATE")
        ? "TRAFFIC_DAMAGE_TAIL_CANDIDATE"
        : coSignFragilityStatus === "TRAFFIC_WITHOUT_DAMAGE_FRAGILITY"
          || coSignFragilityStatus === "DAMAGE_WITHOUT_TRAFFIC_FRAGILITY"
          ? "ASYMMETRIC_SCORING_SUPPORT"
          : "NO_CLASSIFIED_WIDENING_PATH";
  return {
    distributionStructureStatus,
    distributionRiskTags: tags.join("; ") || "NO_CLASSIFIED_RISK_TAG",
  };
}
