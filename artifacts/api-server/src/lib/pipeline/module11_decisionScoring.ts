/**
 * Auditable three-score bridge for the Frostline decision board.
 *
 * These scores are diagnostic translations of existing, named pipeline gates.
 * They do not introduce new betting coefficients or replace the existing CORE
 * authorization policy. Vehicle strength is normalized to the already-existing
 * 3.0-run STRONG_BUY boundary; Truth and Stability are percentages of explicit
 * evidence checks; Composite is the weakest-link minimum so a strong edge cannot
 * compensate for weak evidence.
 */

export const DECISION_SCORE_MODEL_VERSION = "DECISION_TRACE_V1_EXISTING_GATES";

export type ScoreDecision = "BET" | "PASS" | "PENDING";

export interface DecisionEvidence {
  game_id: string;
  date: string;
  away_pitcher_role: string;
  home_pitcher_role: string;
  away_expected_innings: number | null;
  home_expected_innings: number | null;
  bullpen_available: boolean;
  away_offense_source_status: string;
  home_offense_source_status: string;
  park_source_status: string;
  away_lineup_status: string;
  home_lineup_status: string;
  away_lineup_source: string | null;
  home_lineup_source: string | null;
  weather_source_status: string;
  environment_certainty: string;
  weather_vehicle_status: string;
}

export interface DecisionScoreInput {
  evidence: DecisionEvidence;
  projected_total: number;
  market_line: number | null;
  direction: "OVER" | "UNDER" | "NONE";
  final_decision: "CORE" | "NO_CORE" | "PENDING";
  core_blocker: string;
  survival_check: "PASS" | "FAIL" | "N_A";
  survival_failure_reason: string;
  lock_status: string;
  calculated_ts: string;
  run_id: string;
}

export interface NamedScoreCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DecisionScoreResolution {
  truth_family: "RUNS_OVER" | "RUNS_UNDER" | "NO_MARKET" | "NO_EDGE";
  truth_score: number;
  vehicle_score: number;
  stability_score: number;
  composite_score: number;
  confirmation_gate: boolean;
  score_decision: ScoreDecision;
  execution_status: "authorized" | "blocked" | "pending";
  score_blockers: string[];
  truth_components: string;
  vehicle_components: string;
  stability_components: string;
  run_id: string;
  model_version: string;
  calculated_ts: string;
}

function rounded(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function percentPassed(checks: NamedScoreCheck[]): number {
  if (checks.length === 0) return 0;
  return rounded((checks.filter((check) => check.passed).length / checks.length) * 100);
}

function serializeChecks(checks: NamedScoreCheck[]): string {
  return checks
    .map((check) => `${check.name}=${check.passed ? "PASS" : "FAIL"}${check.detail ? `(${check.detail})` : ""}`)
    .join(" | ");
}

function failedCheckNames(checks: NamedScoreCheck[]): string[] {
  return checks.filter((check) => !check.passed).map((check) => check.name);
}

function hasUsableLineup(status: string): boolean {
  return status === "FULL" || status === "PARTIAL";
}

/**
 * Convert current projection evidence and the final, fully-gated board decision
 * into an audit trace. The final decision remains authoritative; the scores make
 * the reasons measurable and visible without inventing a new authorization rule.
 */
export function resolveDecisionScores(input: DecisionScoreInput): DecisionScoreResolution {
  const { evidence } = input;
  const startersResolved =
    evidence.away_pitcher_role !== "UNRESOLVED" && evidence.home_pitcher_role !== "UNRESOLVED";
  const inningsPresent =
    evidence.away_expected_innings !== null && evidence.away_expected_innings > 0 &&
    evidence.home_expected_innings !== null && evidence.home_expected_innings > 0;
  const offenseUsable =
    evidence.away_offense_source_status !== "LEAGUE_AVG_FALLBACK" &&
    evidence.home_offense_source_status !== "LEAGUE_AVG_FALLBACK";
  const lineupUsable =
    hasUsableLineup(evidence.away_lineup_status) && hasUsableLineup(evidence.home_lineup_status);
  const parkUsable = evidence.park_source_status !== "MISSING_PARK_DATA";

  const truthChecks: NamedScoreCheck[] = [
    { name: "STARTERS_RESOLVED", passed: startersResolved, detail: `${evidence.away_pitcher_role}/${evidence.home_pitcher_role}` },
    { name: "EXPECTED_INNINGS_PRESENT", passed: inningsPresent, detail: `${evidence.away_expected_innings ?? "NA"}/${evidence.home_expected_innings ?? "NA"}` },
    { name: "BULLPEN_USABLE", passed: evidence.bullpen_available, detail: evidence.bullpen_available ? "both" : "missing" },
    { name: "OFFENSE_SOURCE_USABLE", passed: offenseUsable, detail: `${evidence.away_offense_source_status}/${evidence.home_offense_source_status}` },
    { name: "LINEUP_DATA_USABLE", passed: lineupUsable, detail: `${evidence.away_lineup_status}/${evidence.home_lineup_status}` },
    { name: "PARK_SOURCE_USABLE", passed: parkUsable, detail: evidence.park_source_status },
  ];

  const lineupsOfficial =
    evidence.away_lineup_source === "official" && evidence.home_lineup_source === "official";
  const offenseBlended =
    evidence.away_offense_source_status === "BLENDED" && evidence.home_offense_source_status === "BLENDED";
  const lineupsFull = evidence.away_lineup_status === "FULL" && evidence.home_lineup_status === "FULL";
  const liveOrNeutralWeather =
    evidence.weather_source_status === "LIVE" || evidence.weather_source_status === "FALLBACK_NEUTRAL";
  const certaintyUsable = evidence.environment_certainty !== "LOW";
  const weatherVehicleActive = evidence.weather_vehicle_status === "ACTIVE";

  const stabilityChecks: NamedScoreCheck[] = [
    { name: "LINEUPS_OFFICIAL", passed: lineupsOfficial, detail: `${evidence.away_lineup_source ?? "NA"}/${evidence.home_lineup_source ?? "NA"}` },
    { name: "LINEUPS_FULL", passed: lineupsFull, detail: `${evidence.away_lineup_status}/${evidence.home_lineup_status}` },
    { name: "OFFENSE_SOURCES_BLENDED", passed: offenseBlended, detail: `${evidence.away_offense_source_status}/${evidence.home_offense_source_status}` },
    { name: "WEATHER_RESOLVED_OR_NEUTRAL", passed: liveOrNeutralWeather, detail: evidence.weather_source_status },
    { name: "ENVIRONMENT_CERTAINTY", passed: certaintyUsable, detail: evidence.environment_certainty },
    { name: "WEATHER_VEHICLE_ACTIVE", passed: weatherVehicleActive, detail: evidence.weather_vehicle_status },
  ];

  const edge = input.market_line === null ? null : rounded(input.projected_total - input.market_line);
  const absEdge = edge === null ? 0 : Math.abs(edge);
  // Existing Module 11 STRONG_BUY boundary is 3.0 runs. Normalizing to it
  // creates a transparent 0-100 magnitude scale without a new threshold.
  const vehicleScore = input.market_line === null ? 0 : rounded(Math.min(100, (absEdge / 3) * 100));
  const vehicleComponents = [
    `MARKET_LINE=${input.market_line ?? "NA"}`,
    `PROJECTED_TOTAL=${rounded(input.projected_total)}`,
    `EDGE=${edge ?? "NA"}`,
    `ABS_EDGE=${input.market_line === null ? "NA" : rounded(absEdge)}`,
    "CORE_BOUNDARY=1.5",
    "STRONG_BUY_BOUNDARY=3.0",
    `SURVIVAL=${input.survival_check}`,
    `LOCK=${input.lock_status}`,
  ].join(" | ");

  const truthScore = percentPassed(truthChecks);
  const stabilityScore = percentPassed(stabilityChecks);
  // Weakest-link composite: one weak evidence family cannot be averaged away.
  const compositeScore = rounded(Math.min(truthScore, vehicleScore, stabilityScore));
  const scoreDecision: ScoreDecision =
    input.final_decision === "CORE" ? "BET" :
    input.final_decision === "PENDING" ? "PENDING" : "PASS";

  const scoreBlockers = [
    ...failedCheckNames(truthChecks),
    ...failedCheckNames(stabilityChecks),
    input.core_blocker,
    input.survival_failure_reason,
  ].filter((value, index, values) => value !== "" && values.indexOf(value) === index);

  return {
    truth_family:
      input.market_line === null ? "NO_MARKET" :
      input.direction === "OVER" ? "RUNS_OVER" :
      input.direction === "UNDER" ? "RUNS_UNDER" : "NO_EDGE",
    truth_score: truthScore,
    vehicle_score: vehicleScore,
    stability_score: stabilityScore,
    composite_score: compositeScore,
    confirmation_gate: input.final_decision === "CORE",
    score_decision: scoreDecision,
    execution_status:
      input.final_decision === "CORE" ? "authorized" :
      input.final_decision === "PENDING" ? "pending" : "blocked",
    score_blockers: scoreBlockers,
    truth_components: serializeChecks(truthChecks),
    vehicle_components: vehicleComponents,
    stability_components: serializeChecks(stabilityChecks),
    run_id: input.run_id,
    model_version: DECISION_SCORE_MODEL_VERSION,
    calculated_ts: input.calculated_ts,
  };
}
