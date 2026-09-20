/**
 * Module 37: Center Error Decomposition V1.
 *
 * Research-only mathematics for decomposing a frozen price-blind total after
 * settlement. This module deliberately has no workbook writer and no active
 * projection consumer. Phase observations must come from Module 32's exact
 * play-by-play reconstruction; pitcher-charged R/ER are not admissible.
 */

export const CENTER_ERROR_DECOMPOSITION_VERSION =
  "CENTER_ERROR_DECOMPOSITION_V1_2026-09-19";
export const CENTER_ERROR_DECOMPOSITION_ACTIVE_INPUT = "NO" as const;
export const CENTER_ERROR_SAMPLE_FLOOR_DERIVATION_THROUGH_DATE = "2026-09-17";
export const CENTER_ERROR_DOMAIN_MIN_N = 100;
export const STARTER_MECHANISM_FAMILY_SIZE = 6;
export const STARTER_MECHANISM_FAMILYWISE_ALPHA = 0.05;
export const STARTER_MECHANISM_BONFERRONI_ALPHA =
  STARTER_MECHANISM_FAMILYWISE_ALPHA / STARTER_MECHANISM_FAMILY_SIZE;
export const STARTER_MECHANISM_SIMULTANEOUS_CONFIDENCE =
  1 - STARTER_MECHANISM_BONFERRONI_ALPHA;

/**
 * Frozen after authoritative readback on 2026-09-19. Continuous floors were
 * derived from rows through 2026-09-17 using deriveContinuousBucketFloor;
 * later outcomes cannot change them.
 */
export const CENTER_ERROR_BUCKET_FLOORS: Readonly<Record<CenterErrorBucket, number>> = {
  OFFENSE_BASELINE: 100,
  STARTER_PHASE: 100,
  WORKLOAD_ALLOCATION: 100,
  BULLPEN_CONTINUATION: 100,
  ENVIRONMENT: 100,
  TEAM_ALLOCATION: 171,
  DISTRIBUTION_TAIL: 139,
};

export type CenterErrorBucket =
  | "OFFENSE_BASELINE"
  | "STARTER_PHASE"
  | "WORKLOAD_ALLOCATION"
  | "BULLPEN_CONTINUATION"
  | "ENVIRONMENT"
  | "TEAM_ALLOCATION"
  | "DISTRIBUTION_TAIL";

export type MechanismEvidenceStatus =
  | "INSTRUMENTATION_DEAD"
  | "INSTRUMENTATION_PARTIAL"
  | "FLOOR_NOT_FROZEN"
  | "INSUFFICIENT_N"
  | "PROVISIONAL_INTERVAL_INCLUDES_ZERO"
  | "SUPPORTED_DIRECTIONAL_ERROR";

export interface InstrumentationAudit {
  status: "LIVE_VARYING" | "INSTRUMENTATION_DEAD" | "INSTRUMENTATION_PARTIAL";
  eligible_n: number;
  observed_n: number;
  distinct_unrounded_values: number;
  neutral_value: number;
}

export interface CenterPhaseInput {
  frozen_total: number;
  frozen_starter_attack_runs: number;
  frozen_traffic_conversion_runs: number;
  frozen_hr_xbh_damage_runs: number;
  frozen_bullpen_continuation_runs: number;
  frozen_run_multiplier: number;
  frozen_away_expected_ip: number;
  frozen_home_expected_ip: number;
  actual_total: number;
  actual_starter_window_runs: number;
  actual_post_starter_runs: number;
  actual_away_starter_ip: number;
  actual_home_starter_ip: number;
}

export interface CenterPhaseDecomposition {
  status: "USABLE" | "NON_RECONCILING_INPUT" | "INVALID_INNINGS";
  projected_starter_phase_runs: number | null;
  projected_bullpen_phase_runs: number | null;
  expected_starter_ip: number | null;
  expected_true_bullpen_ip: number | null;
  actual_starter_ip: number | null;
  actual_true_bullpen_ip: number | null;
  frozen_starter_runs_per_ip: number | null;
  frozen_bullpen_runs_per_ip: number | null;
  actual_workload_counterfactual_total: number | null;
  workload_allocation_error: number | null;
  starter_phase_rate_error: number | null;
  bullpen_continuation_rate_error: number | null;
  total_error: number;
  decomposition_sum: number | null;
  reconciliation_delta: number | null;
}

export interface MarginalCenterInput {
  frozen_total: number;
  actual_total: number;
  frozen_away_projection: number;
  frozen_home_projection: number;
  frozen_away_active_offense_center: number;
  frozen_home_active_offense_center: number;
  frozen_environment_run_adjustment: number;
  league_team_run_baseline?: number;
}

export interface MarginalCenterDiagnostics {
  neutral_offense_counterfactual_total: number | null;
  offense_baseline_marginal_abs_loss: number | null;
  no_environment_counterfactual_total: number;
  environment_marginal_abs_loss: number;
  interpretation: "NON_ADDITIVE_DIAGNOSTICS_ONLY";
}

export type TailObservationStatus =
  | "WITHIN_FROZEN_90_INTERVAL"
  | "LOW_90_INTERVAL_ESCAPE"
  | "HIGH_90_INTERVAL_ESCAPE"
  | "DISTRIBUTION_EVIDENCE_UNAVAILABLE";

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

/**
 * Reconciles the frozen total into three additive settlement errors:
 *
 *   workload allocation effect
 * + starter-phase rate residual
 * + bullpen-continuation rate residual
 * = frozen total - actual total.
 *
 * The actual workload counterfactual holds the two frozen phase rates fixed
 * and changes only innings allocation. It is diagnostic, not a replacement
 * projection and not a claim that actual workload was knowable pregame.
 */
export function decomposeCenterPhaseError(
  input: CenterPhaseInput,
  tolerance = 0.03,
): CenterPhaseDecomposition {
  const totalError = input.frozen_total - input.actual_total;
  const projectedStarter =
    (input.frozen_starter_attack_runs
      + input.frozen_traffic_conversion_runs
      + input.frozen_hr_xbh_damage_runs)
    * input.frozen_run_multiplier;
  const projectedBullpen =
    input.frozen_bullpen_continuation_runs * input.frozen_run_multiplier;
  const expectedStarterIp =
    input.frozen_away_expected_ip + input.frozen_home_expected_ip;
  const actualStarterIp =
    input.actual_away_starter_ip + input.actual_home_starter_ip;
  const expectedBullpenIp = 18 - expectedStarterIp;
  const actualBullpenIp = 18 - actualStarterIp;
  const componentDelta = projectedStarter + projectedBullpen - input.frozen_total;
  const actualPhaseDelta =
    input.actual_starter_window_runs
    + input.actual_post_starter_runs
    - input.actual_total;

  const base = {
    projected_starter_phase_runs: null,
    projected_bullpen_phase_runs: null,
    expected_starter_ip: null,
    expected_true_bullpen_ip: null,
    actual_starter_ip: null,
    actual_true_bullpen_ip: null,
    frozen_starter_runs_per_ip: null,
    frozen_bullpen_runs_per_ip: null,
    actual_workload_counterfactual_total: null,
    workload_allocation_error: null,
    starter_phase_rate_error: null,
    bullpen_continuation_rate_error: null,
    total_error: round(totalError),
    decomposition_sum: null,
    reconciliation_delta: null,
  };

  if (!finite([
    input.frozen_total,
    input.actual_total,
    projectedStarter,
    projectedBullpen,
    expectedStarterIp,
    actualStarterIp,
    input.actual_starter_window_runs,
    input.actual_post_starter_runs,
  ]) || Math.abs(componentDelta) > tolerance || Math.abs(actualPhaseDelta) > tolerance) {
    return { status: "NON_RECONCILING_INPUT", ...base };
  }
  if (
    expectedStarterIp <= 0
    || expectedBullpenIp <= 0
    || actualStarterIp < 0
    || actualStarterIp > 18
    || actualBullpenIp < 0
  ) {
    return { status: "INVALID_INNINGS", ...base };
  }

  const starterRate = projectedStarter / expectedStarterIp;
  const bullpenRate = projectedBullpen / expectedBullpenIp;
  const counterfactualStarter = starterRate * actualStarterIp;
  const counterfactualBullpen = bullpenRate * actualBullpenIp;
  const counterfactualTotal = counterfactualStarter + counterfactualBullpen;
  const workloadError = input.frozen_total - counterfactualTotal;
  const starterError = counterfactualStarter - input.actual_starter_window_runs;
  const bullpenError = counterfactualBullpen - input.actual_post_starter_runs;
  const decompositionSum = workloadError + starterError + bullpenError;

  return {
    status: "USABLE",
    projected_starter_phase_runs: round(projectedStarter),
    projected_bullpen_phase_runs: round(projectedBullpen),
    expected_starter_ip: round(expectedStarterIp),
    expected_true_bullpen_ip: round(expectedBullpenIp),
    actual_starter_ip: round(actualStarterIp),
    actual_true_bullpen_ip: round(actualBullpenIp),
    frozen_starter_runs_per_ip: round(starterRate),
    frozen_bullpen_runs_per_ip: round(bullpenRate),
    actual_workload_counterfactual_total: round(counterfactualTotal),
    workload_allocation_error: round(workloadError),
    starter_phase_rate_error: round(starterError),
    bullpen_continuation_rate_error: round(bullpenError),
    total_error: round(totalError),
    decomposition_sum: round(decompositionSum),
    reconciliation_delta: round(decompositionSum - totalError),
  };
}

/**
 * Offense and environment are overlapping inputs to both pitching phases, so
 * they are reported as one-at-a-time marginal loss diagnostics. They must not
 * be added to the three reconciled phase errors above.
 */
export function buildMarginalCenterDiagnostics(
  input: MarginalCenterInput,
): MarginalCenterDiagnostics {
  const league = input.league_team_run_baseline ?? 4.5;
  const neutralOffense =
    input.frozen_away_active_offense_center > 0
    && input.frozen_home_active_offense_center > 0
      ? input.frozen_away_projection
          * (league / input.frozen_away_active_offense_center)
        + input.frozen_home_projection
          * (league / input.frozen_home_active_offense_center)
      : null;
  const activeLoss = Math.abs(input.frozen_total - input.actual_total);
  const noEnvironment =
    input.frozen_total - input.frozen_environment_run_adjustment;
  return {
    neutral_offense_counterfactual_total:
      neutralOffense === null ? null : round(neutralOffense),
    offense_baseline_marginal_abs_loss:
      neutralOffense === null
        ? null
        : round(activeLoss - Math.abs(neutralOffense - input.actual_total)),
    no_environment_counterfactual_total: round(noEnvironment),
    environment_marginal_abs_loss: round(
      activeLoss - Math.abs(noEnvironment - input.actual_total),
    ),
    interpretation: "NON_ADDITIVE_DIAGNOSTICS_ONLY",
  };
}

export function classifyTailObservation(input: {
  actual_total: number;
  frozen_interval_90_low: number | null;
  frozen_interval_90_high: number | null;
  distribution_status: string;
}): TailObservationStatus {
  if (
    !/ELIGIBLE|COMPLETE|PASS/.test(input.distribution_status)
    || input.frozen_interval_90_low === null
    || input.frozen_interval_90_high === null
    || !finite([
      input.actual_total,
      input.frozen_interval_90_low,
      input.frozen_interval_90_high,
    ])
  ) return "DISTRIBUTION_EVIDENCE_UNAVAILABLE";
  if (input.actual_total < input.frozen_interval_90_low) {
    return "LOW_90_INTERVAL_ESCAPE";
  }
  if (input.actual_total > input.frozen_interval_90_high) {
    return "HIGH_90_INTERVAL_ESCAPE";
  }
  return "WITHIN_FROZEN_90_INTERVAL";
}

function sampleSd(values: readonly number[]): number | null {
  if (values.length < 2 || !finite(values)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Continuous bucket floors target a 95% CI half-width of 0.75 runs and
 * inherit the established 100-game research minimum. The SD must come only
 * from the frozen derivation corpus through 2026-09-17; the returned floor is
 * then frozen before later evaluation rows are interpreted.
 */
export function deriveContinuousBucketFloor(
  derivationValues: readonly number[],
  halfWidth = 0.75,
): number | null {
  const sd = sampleSd(derivationValues);
  if (sd === null || halfWidth <= 0) return null;
  return Math.max(
    CENTER_ERROR_DOMAIN_MIN_N,
    Math.ceil(((1.96 * sd) / halfWidth) ** 2),
  );
}

/** Worst-case Bernoulli precision floor for team-allocation correctness. */
export function allocationBucketFloor(halfWidth = 0.075): number {
  return Math.max(
    CENTER_ERROR_DOMAIN_MIN_N,
    Math.ceil((1.96 ** 2 * 0.25) / (halfWidth ** 2)),
  );
}

/** 90% interval escape calibration floor using nominal p=0.10. */
export function distributionTailBucketFloor(halfWidth = 0.05): number {
  return Math.max(
    CENTER_ERROR_DOMAIN_MIN_N,
    Math.ceil((1.96 ** 2 * 0.1 * 0.9) / (halfWidth ** 2)),
  );
}

export function bucketInterpretationStatus(
  eligibleN: number,
  frozenFloor: number | null,
): "INTERPRETABLE" | "INSUFFICIENT_N" | "FLOOR_NOT_FROZEN" {
  if (frozenFloor === null) return "FLOOR_NOT_FROZEN";
  return eligibleN >= frozenFloor ? "INTERPRETABLE" : "INSUFFICIENT_N";
}

/**
 * A mechanism whose published input never leaves its neutral value cannot be
 * evaluated from that corpus. Missing observations remain partial rather than
 * being silently converted to the neutral value.
 */
export function auditMechanismInstrumentation(
  values: readonly (number | null)[],
  neutralValue: number,
  tolerance = 1e-12,
): InstrumentationAudit {
  const observed = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const distinct = new Set(observed.map((value) => value.toString())).size;
  const allNeutral = observed.length > 0
    && observed.every((value) => Math.abs(value - neutralValue) <= tolerance);
  return {
    status: observed.length < values.length
      ? "INSTRUMENTATION_PARTIAL"
      : allNeutral
        ? "INSTRUMENTATION_DEAD"
        : "LIVE_VARYING",
    eligible_n: values.length,
    observed_n: observed.length,
    distinct_unrounded_values: distinct,
    neutral_value: neutralValue,
  };
}

/**
 * A mechanism is supported only after its own frozen N floor passes and its
 * familywise interval excludes zero. The caller must supply the simultaneous
 * interval produced by slate-block resampling at
 * STARTER_MECHANISM_SIMULTANEOUS_CONFIDENCE (99.1667% for six mechanisms).
 */
export function assessMechanismEvidence(input: {
  instrumentation_status: InstrumentationAudit["status"];
  eligible_n: number;
  frozen_floor: number | null;
  simultaneous_ci_lower: number | null;
  simultaneous_ci_upper: number | null;
}): MechanismEvidenceStatus {
  if (input.instrumentation_status === "INSTRUMENTATION_DEAD") {
    return "INSTRUMENTATION_DEAD";
  }
  if (input.instrumentation_status === "INSTRUMENTATION_PARTIAL") {
    return "INSTRUMENTATION_PARTIAL";
  }
  if (input.frozen_floor === null) return "FLOOR_NOT_FROZEN";
  if (input.eligible_n < input.frozen_floor) return "INSUFFICIENT_N";
  if (
    input.simultaneous_ci_lower === null
    || input.simultaneous_ci_upper === null
    || input.simultaneous_ci_lower <= 0 && input.simultaneous_ci_upper >= 0
  ) return "PROVISIONAL_INTERVAL_INCLUDES_ZERO";
  return "SUPPORTED_DIRECTIONAL_ERROR";
}
