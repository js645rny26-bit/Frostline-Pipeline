/**
 * Frozen Day-2 strict structural cohort definition.
 *
 * This is prospective research instrumentation only. It classifies the
 * final legitimate pre-first-pitch packet without reading market separation,
 * price, direction, outcomes, or authorization state.
 */

export const STRICT_STRUCTURAL_COHORT_VERSION =
  "STRICT_STRUCTURAL_ELIGIBLE_V1_2026-09-02";
export const STRICT_STRUCTURAL_COHORT_START_DATE = "2026-09-02";

export const STRICT_STRUCTURAL_CHECK_NAMES = [
  "CORE_PACKET_COMPLETE",
  "STARTERS_RESOLVED",
  "EXPECTED_INNINGS_PRESENT",
  "OPENER_CHAIN_CLEAN",
  "BULLPEN_USABLE",
  "OFFENSE_SOURCE_USABLE",
  "LINEUP_DATA_USABLE",
  "PARK_SOURCE_USABLE",
  "LINEUPS_OFFICIAL",
  "LINEUPS_FULL",
  "OFFENSE_SOURCES_BLENDED",
  "WEATHER_RESOLVED_OR_NEUTRAL",
  "ENVIRONMENT_CERTAINTY_HIGH",
  "WEATHER_VEHICLE_ACTIVE",
] as const;

export type StrictStructuralCheckName =
  (typeof STRICT_STRUCTURAL_CHECK_NAMES)[number];
export type StrictStructuralCheckState = "PASS" | "FAIL" | "MISSING";
export type StrictStructuralVerdict =
  | "STRICT_STRUCTURAL_ELIGIBLE"
  | "STRICT_STRUCTURAL_EXCLUDED";

export interface StrictStructuralEligibilityInput {
  core_packet_status: string;
  truth_checks: string;
  stability_checks: string;
  opener_chain_state: string;
  away_lineup_status: string;
  home_lineup_status: string;
  away_lineup_coverage: number | null | undefined;
  home_lineup_coverage: number | null | undefined;
  environment_certainty: string;
  weather_vehicle_status: string;
  stability_score: number | null | undefined;
}

export interface StrictStructuralEligibilityState {
  cohort_version: string;
  verdict: StrictStructuralVerdict;
  exclusion_reasons: string;
  checks: Record<StrictStructuralCheckName, StrictStructuralCheckState>;
  check_vector: string;
}

export interface StrictStructuralMembershipCandidate<T> {
  packet_snapshot_ts: string;
  scheduled_first_pitch: string;
  value: T;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function isExactOne(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && Number.isFinite(value) && value === 1;
}

function checkStateFromSerialized(
  checks: Map<string, string>,
  name: string,
): { state: StrictStructuralCheckState; raw: string } {
  const raw = checks.get(name);
  if (!raw) return { state: "MISSING", raw: "MISSING" };
  if (raw.startsWith("PASS")) return { state: "PASS", raw };
  if (raw.startsWith("FAIL")) return { state: "FAIL", raw };
  return { state: "MISSING", raw };
}

/** Parses the existing immutable NAME=PASS(detail) | NAME=FAIL(detail) trace. */
export function parseFrozenNamedChecks(serialized: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of text(serialized).split("|")) {
    const entry = part.trim();
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    parsed.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
  }
  return parsed;
}

function rawState(
  passed: boolean,
  raw: string,
  missing: boolean,
): { state: StrictStructuralCheckState; raw: string } {
  if (missing) return { state: "MISSING", raw: raw || "MISSING" };
  return { state: passed ? "PASS" : "FAIL", raw };
}

/**
 * Implements the contract verbatim. Only the fourteen named criteria decide
 * membership. Stability_Score is preserved only as a consistency diagnostic.
 */
export function classifyStrictStructuralEligibility(
  input: StrictStructuralEligibilityInput,
): StrictStructuralEligibilityState {
  const truth = parseFrozenNamedChecks(input.truth_checks);
  const stability = parseFrozenNamedChecks(input.stability_checks);
  const results = new Map<StrictStructuralCheckName, { state: StrictStructuralCheckState; raw: string }>();

  results.set("CORE_PACKET_COMPLETE", rawState(
    text(input.core_packet_status) === "COMPLETE",
    text(input.core_packet_status),
    text(input.core_packet_status) === "",
  ));

  for (const name of [
    "STARTERS_RESOLVED",
    "EXPECTED_INNINGS_PRESENT",
    "BULLPEN_USABLE",
    "OFFENSE_SOURCE_USABLE",
    "LINEUP_DATA_USABLE",
    "PARK_SOURCE_USABLE",
  ] as const) {
    results.set(name, checkStateFromSerialized(truth, name));
  }

  results.set("OPENER_CHAIN_CLEAN", rawState(
    text(input.opener_chain_state) === "NO_OPENER_IDENTIFIED",
    text(input.opener_chain_state),
    text(input.opener_chain_state) === "",
  ));

  results.set("LINEUPS_OFFICIAL", checkStateFromSerialized(stability, "LINEUPS_OFFICIAL"));

  const lineupRaw = [
    `AWAY_${text(input.away_lineup_status) || "MISSING"}_${input.away_lineup_coverage ?? "MISSING"}`,
    `HOME_${text(input.home_lineup_status) || "MISSING"}_${input.home_lineup_coverage ?? "MISSING"}`,
  ].join("/");
  const lineupMissing = !text(input.away_lineup_status)
    || !text(input.home_lineup_status)
    || input.away_lineup_coverage === null
    || input.away_lineup_coverage === undefined
    || input.home_lineup_coverage === null
    || input.home_lineup_coverage === undefined;
  results.set("LINEUPS_FULL", rawState(
    text(input.away_lineup_status) === "FULL"
      && text(input.home_lineup_status) === "FULL"
      && isExactOne(input.away_lineup_coverage)
      && isExactOne(input.home_lineup_coverage),
    lineupRaw,
    lineupMissing,
  ));

  for (const name of [
    "OFFENSE_SOURCES_BLENDED",
    "WEATHER_RESOLVED_OR_NEUTRAL",
  ] as const) {
    results.set(name, checkStateFromSerialized(stability, name));
  }

  results.set("ENVIRONMENT_CERTAINTY_HIGH", rawState(
    text(input.environment_certainty) === "HIGH",
    text(input.environment_certainty),
    text(input.environment_certainty) === "",
  ));
  results.set("WEATHER_VEHICLE_ACTIVE", rawState(
    text(input.weather_vehicle_status) === "ACTIVE",
    text(input.weather_vehicle_status),
    text(input.weather_vehicle_status) === "",
  ));

  const checks = Object.fromEntries(
    STRICT_STRUCTURAL_CHECK_NAMES.map((name) => [name, results.get(name)!.state]),
  ) as Record<StrictStructuralCheckName, StrictStructuralCheckState>;
  const exclusionReasons = STRICT_STRUCTURAL_CHECK_NAMES
    .filter((name) => checks[name] !== "PASS")
    .map((name) => `${name}=${checks[name]}`);

  const stabilityNames = [
    "LINEUPS_OFFICIAL",
    "LINEUPS_FULL",
    "OFFENSE_SOURCES_BLENDED",
    "WEATHER_RESOLVED_OR_NEUTRAL",
    "ENVIRONMENT_CERTAINTY",
    "WEATHER_VEHICLE_ACTIVE",
  ];
  const stabilityComponentsAllPass = stabilityNames.every(
    (name) => checkStateFromSerialized(stability, name).state === "PASS",
  );
  const stabilityInconsistent = stabilityComponentsAllPass && input.stability_score !== 100;
  const checkVector = [
    ...STRICT_STRUCTURAL_CHECK_NAMES.map((name) => {
      const result = results.get(name)!;
      return `${name}=${result.state}(${result.raw})`;
    }),
    ...(stabilityInconsistent
      ? [`STABILITY_VECTOR_INCONSISTENT=TRUE(Stability_Score=${input.stability_score ?? "MISSING"})`]
      : []),
  ].join(" | ");

  return {
    cohort_version: STRICT_STRUCTURAL_COHORT_VERSION,
    verdict: exclusionReasons.length === 0
      ? "STRICT_STRUCTURAL_ELIGIBLE"
      : "STRICT_STRUCTURAL_EXCLUDED",
    exclusion_reasons: exclusionReasons.join("; "),
    checks,
    check_vector: checkVector,
  };
}

/**
 * Selects the one and only membership snapshot. Earlier qualifying packets are
 * never a fallback when a later legitimate packet fails strict eligibility.
 */
export function selectLastLegitimatePregameSnapshot<T>(
  candidates: readonly StrictStructuralMembershipCandidate<T>[],
): StrictStructuralMembershipCandidate<T> | null {
  const valid = candidates.filter((candidate) => {
    const snapshotMs = Date.parse(candidate.packet_snapshot_ts);
    const firstPitchMs = Date.parse(candidate.scheduled_first_pitch);
    return Number.isFinite(snapshotMs) && Number.isFinite(firstPitchMs) && snapshotMs < firstPitchMs;
  });
  if (valid.length === 0) return null;
  return valid.reduce((latest, candidate) =>
    Date.parse(candidate.packet_snapshot_ts) > Date.parse(latest.packet_snapshot_ts)
      ? candidate
      : latest,
  );
}
