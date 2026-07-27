/**
 * Module 11 — Vehicle Candidate Shadow Architecture
 *
 * SHADOW MODULE — does NOT modify SLATE_BOARD, CORE counts, lock state,
 * workbook schema, or any live pipeline output. All functions are pure and
 * side-effect-free.
 *
 * Implements the three-phase vehicle-selection doctrine:
 *
 *   Phase 1  evaluateVehicleViability  — structural / evaluability check
 *   Phase 2  rankViableVehicles        — attribute-only ordering, no type hierarchy
 *   Phase 3  authorizeSelectedVehicle  — CORE/NO_CORE gates on the already-selected vehicle
 *
 * Vehicle type must not appear in the Phase 2 comparator. The comparator
 * reads evaluated candidate attributes exclusively. When two candidates are
 * identical on all nine criteria the comparator returns 0, preserving the
 * stable input order that Node's Array.prototype.sort guarantees.
 *
 * Doctrine references
 * ───────────────────
 * "Vehicle labels do not determine safety or preference. Evaluated
 *  game-specific attributes do."
 *
 * "A vehicle can be structurally viable, the best price-blind expression of
 *  game truth, and still NO CORE because separation, monotonicity, lineup
 *  confirmation, or another authorization requirement fails."
 *
 * "Until a vehicle-specific projection exists: NOT_EVALUABLE —
 *  VEHICLE_PROJECTION_UNAVAILABLE."
 */

import type { GameEligibilityContext } from "./module11_outputExtraction.js";

// ─── Vehicle type catalogue ────────────────────────────────────────────────

/**
 * All known vehicle types in the pipeline.
 * "GAME_TOTAL" is the legacy/default seed from module10 (treated as a full-game
 * total but without an explicit direction; preserved for operational continuity).
 * "TBD" signals no vehicle has been selected yet.
 */
export type VehicleType =
  | "FULL_GAME_OVER"
  | "FULL_GAME_UNDER"
  | "GAME_TOTAL"          // legacy operational seed — treated as full-game total
  | "TEAM_TOTAL_OVER"
  | "TEAM_TOTAL_UNDER"
  | "MONEYLINE"
  | "RUN_LINE"
  | "STARTER_OUTS_UNDER"
  | "STARTER_ER_OVER"
  | "STARTER_HITS_OVER"
  | "TBD";

/** Structural evaluability of a vehicle candidate. */
export type VehicleViability =
  | "VIABLE"           // passes all structural checks; eligible for ranking and authorization
  | "NOT_VIABLE"       // structural gate failure (e.g. explicit operator kill flag)
  | "NOT_EVALUABLE"    // cannot be evaluated with currently available data / projections
  | "UNAVAILABLE";     // market not present (no line, no odds)

// ─── Classification sets (internal — vehicle type determines which gates apply,
//     never which vehicle is preferred) ──────────────────────────────────────

/** Full-game total vehicles: use the full-game projected total vs. market total. */
const FULL_GAME_TOTAL_VEHICLES = new Set<VehicleType>([
  "FULL_GAME_OVER",
  "FULL_GAME_UNDER",
  "GAME_TOTAL",
]);

/** Non-conventional starter roles for which workload identity matters. */
const NON_CONVENTIONAL_ROLES = new Set<string>([
  "OPENER",
  "BULK",
  "PIGGYBACK_PRIMARY",
  "PIGGYBACK_SECONDARY",
  "BULLPEN_GAME",
  "RELIEF_ARM_LISTED_AS_STARTER",
]);

/** Vehicle types that require a team-run projection (not yet available). */
const TEAM_TOTAL_VEHICLES = new Set<VehicleType>([
  "TEAM_TOTAL_OVER",
  "TEAM_TOTAL_UNDER",
]);

/** Vehicle types that require a side/spread projection (not yet available). */
const SIDE_VEHICLES = new Set<VehicleType>([
  "MONEYLINE",
  "RUN_LINE",
]);

/** Vehicle types that require a starter-specific projection (not yet available). */
const STARTER_PROP_VEHICLES = new Set<VehicleType>([
  "STARTER_OUTS_UNDER",
  "STARTER_ER_OVER",
  "STARTER_HITS_OVER",
]);

// ─── Candidate contract ────────────────────────────────────────────────────

/**
 * A single vehicle candidate entering the three-phase selection pipeline.
 *
 * Identity fields (vehicleType, targetSide, targetTeam, targetPlayerId) are
 * caller-supplied and must be set before evaluation.
 *
 * Data completeness and doctrine-criterion scores are populated by the caller
 * from available pipeline signals. Fields may be undefined when data is not
 * yet available; the comparator treats undefined as 0 (neutral).
 *
 * viability and viabilityBlocker are written by evaluateVehicleViability.
 */
export interface VehicleCandidate {
  // ── Identity ──────────────────────────────────────────────────────────────
  vehicleType: VehicleType;
  /** Required for team-specific vehicles (TEAM_TOTAL_*, MONEYLINE, RUN_LINE). */
  targetSide?: "AWAY" | "HOME";
  /** Team abbreviation when the vehicle is team-specific. */
  targetTeam?: string;
  /** MLB player ID when the vehicle is a player prop. */
  targetPlayerId?: number;

  // ── Market and projection ─────────────────────────────────────────────────
  /**
   * Model projection for this vehicle's specific line type.
   * Full-game: projected total runs. Team: projected team runs.
   * Starter prop: projected stat value. Side: projected win probability.
   */
  projection?: number;
  /** Market line for this vehicle's specific line type. */
  marketLine?: number;
  /**
   * Whether a live market exists for this vehicle.
   * UNAVAILABLE → not evaluable regardless of data completeness.
   */
  availability: "AVAILABLE" | "UNAVAILABLE";
  /**
   * Fraction of required input data that is present, 0.0–1.0.
   * 1.0 = all required pipeline signals present.
   * Used for tiebreaking between otherwise equal candidates.
   */
  dataCompleteness: number;

  // ── Doctrine ranking attributes (all optional — 0 when absent) ────────────
  /**
   * How strongly this vehicle captures the game's dominant scoring script.
   * Higher = better expression of game truth.
   */
  scriptCaptureScore?: number;
  /**
   * Aggregate burden of this vehicle's failure modes (model error, line-move
   * sensitivity, unexpected events). Lower = more robust.
   */
  failureModeBurden?: number;
  /**
   * How many events must convert for the vehicle to win. Lower = more direct.
   */
  conversionBurden?: number;
  /**
   * Sensitivity to game-time unknowns (lineup changes, weather delays).
   * Lower = more time-stable.
   */
  timingDependence?: number;
  /**
   * Sensitivity to starter and reliever workload changes.
   * Lower = less vulnerable to mid-game pitching decisions.
   */
  workloadDependence?: number;
  /**
   * Sensitivity to plate-appearance volume (lineup depth, extras risk).
   * Lower = less vulnerable to plate-appearance variance.
   */
  plateAppearanceDependence?: number;
  /**
   * Sensitivity to bullpen identity and availability.
   * Lower = less dependent on uncertain bullpen outcomes.
   */
  bullpenDependence?: number;
  /**
   * Sensitivity to run-allocation between the teams.
   * Full-game totals have low allocation dependence; team totals have high.
   */
  runAllocationDependence?: number;
  /**
   * Historical and structural stability of this vehicle's signals.
   * Higher = more consistent across similar contexts.
   */
  stabilityScore?: number;

  // ── Viability result (written by evaluateVehicleViability) ───────────────
  viability: VehicleViability;
  /** Machine-readable reason code when viability !== VIABLE. */
  viabilityBlocker?: string;
}

// ─── Authorization result ──────────────────────────────────────────────────

/**
 * Output of authorizeSelectedVehicle — CORE/NO_CORE gates applied to the
 * already-selected vehicle.
 *
 * This is Phase 3 only. Viability (Phase 1) and ranking (Phase 2) are complete
 * before this is called.
 */
export interface AuthorizationResult {
  /** CORE = authorized bet candidate. NO_CORE = blocked. NOT_EVALUABLE = viability gate failed before authorization. PENDING = no projection or market line. */
  decision: "CORE" | "NO_CORE" | "NOT_EVALUABLE" | "PENDING";
  direction: "OVER" | "UNDER" | "NONE";
  /** Named reason when decision !== CORE. Empty string for CORE. */
  coreBlocker: string;
  confidence: number;
  roi: number;
}

// ─── Phase 1: Viability evaluation ────────────────────────────────────────

/**
 * Evaluate whether a candidate is structurally viable for this game context.
 *
 * Returns a copy of the candidate with viability and viabilityBlocker set.
 * Does NOT apply CORE authorization gates — that is Phase 3.
 *
 * Decision tree:
 *   1. UNAVAILABLE market → UNAVAILABLE
 *   2. Vehicle requires a projection type not yet implemented → NOT_EVALUABLE
 *   3. TBD (no vehicle specified) → NOT_EVALUABLE
 *   4. Full-game Under with unresolved opener/bulk workload → NOT_EVALUABLE
 *      (Known opener/bulk chain with workload present → VIABLE; burdens elevated by caller)
 *   5. Full-game Over or GAME_TOTAL → VIABLE
 *   6. Unknown vehicle type → NOT_EVALUABLE
 */
export function evaluateVehicleViability(
  candidate: VehicleCandidate,
  context: GameEligibilityContext,
): VehicleCandidate {
  const result: VehicleCandidate = { ...candidate };

  // ── 1. Market availability ──────────────────────────────────────────────
  if (candidate.availability === "UNAVAILABLE") {
    result.viability = "UNAVAILABLE";
    result.viabilityBlocker = "MARKET_UNAVAILABLE";
    return result;
  }

  // ── 2. Projection type support ──────────────────────────────────────────
  // Currently only a full-game-total projection exists.
  // Team totals, sides, and starter props require vehicle-specific projections
  // that have not yet been commissioned. Evaluated honestly as NOT_EVALUABLE.
  if (
    TEAM_TOTAL_VEHICLES.has(candidate.vehicleType) ||
    SIDE_VEHICLES.has(candidate.vehicleType) ||
    STARTER_PROP_VEHICLES.has(candidate.vehicleType)
  ) {
    result.viability = "NOT_EVALUABLE";
    result.viabilityBlocker = "VEHICLE_PROJECTION_UNAVAILABLE";
    return result;
  }

  // ── 3. TBD / unspecified vehicle ────────────────────────────────────────
  if (candidate.vehicleType === "TBD") {
    result.viability = "NOT_EVALUABLE";
    result.viabilityBlocker = "VEHICLE_NOT_SPECIFIED";
    return result;
  }

  // ── 4. Full-game total structural checks ────────────────────────────────
  if (FULL_GAME_TOTAL_VEHICLES.has(candidate.vehicleType)) {
    if (candidate.vehicleType === "FULL_GAME_UNDER") {
      // Known opener/bulk chain: VIABLE (caller elevates burden scores).
      // Unresolved opener/bulk identity or workload: NOT_EVALUABLE.
      // Role label alone does NOT veto — workload unknowability does.
      const awayNonConventional = NON_CONVENTIONAL_ROLES.has(context.awayPitcherRole);
      const homeNonConventional = NON_CONVENTIONAL_ROLES.has(context.homePitcherRole);
      const awayWorkloadUnknown = awayNonConventional && context.awayExpectedInnings === null;
      const homeWorkloadUnknown = homeNonConventional && context.homeExpectedInnings === null;
      if (awayWorkloadUnknown || homeWorkloadUnknown) {
        result.viability = "NOT_EVALUABLE";
        result.viabilityBlocker = "UNRESOLVED_OPENER_WORKLOAD";
        return result;
      }
    }
    result.viability = "VIABLE";
    return result;
  }

  // ── 5. Unknown vehicle type ─────────────────────────────────────────────
  result.viability = "NOT_EVALUABLE";
  result.viabilityBlocker = "UNKNOWN_VEHICLE_TYPE";
  return result;
}

// ─── Phase 2: Attribute-only ranking ──────────────────────────────────────

/**
 * Rank VIABLE candidates by doctrine criteria. Non-VIABLE candidates are
 * filtered out and do not appear in the result.
 *
 * Comparator reads evaluated candidate attributes exclusively. Vehicle type
 * is never used as a preference criterion or tiebreaker.
 *
 * Criteria (in priority order):
 *   1. scriptCaptureScore      DESC  (higher = better expression of game truth)
 *   2. failureModeBurden       ASC   (lower = more robust)
 *   3. conversionBurden        ASC
 *   4. timingDependence        ASC
 *   5. workloadDependence      ASC
 *   6. plateAppearanceDependence ASC
 *   7. bullpenDependence       ASC
 *   8. runAllocationDependence ASC
 *   9. stabilityScore          DESC  (higher = more consistent)
 *
 * True tie on all nine criteria: returns 0. Node's sort is stable (V8 ≥ 7.0),
 * so input order is preserved for equal candidates.
 */
export function rankViableVehicles(candidates: VehicleCandidate[]): VehicleCandidate[] {
  return candidates
    .filter(c => c.viability === "VIABLE")
    .sort(compareCandidateAttributes);
}

function compareCandidateAttributes(a: VehicleCandidate, b: VehicleCandidate): number {
  // 1. scriptCaptureScore DESC
  const scsA = a.scriptCaptureScore ?? 0;
  const scsB = b.scriptCaptureScore ?? 0;
  if (scsA !== scsB) return scsB - scsA;

  // 2. failureModeBurden ASC
  const fmbA = a.failureModeBurden ?? 0;
  const fmbB = b.failureModeBurden ?? 0;
  if (fmbA !== fmbB) return fmbA - fmbB;

  // 3. conversionBurden ASC
  const cbA = a.conversionBurden ?? 0;
  const cbB = b.conversionBurden ?? 0;
  if (cbA !== cbB) return cbA - cbB;

  // 4. timingDependence ASC
  const tdA = a.timingDependence ?? 0;
  const tdB = b.timingDependence ?? 0;
  if (tdA !== tdB) return tdA - tdB;

  // 5. workloadDependence ASC
  const wdA = a.workloadDependence ?? 0;
  const wdB = b.workloadDependence ?? 0;
  if (wdA !== wdB) return wdA - wdB;

  // 6. plateAppearanceDependence ASC
  const padA = a.plateAppearanceDependence ?? 0;
  const padB = b.plateAppearanceDependence ?? 0;
  if (padA !== padB) return padA - padB;

  // 7. bullpenDependence ASC
  const bdA = a.bullpenDependence ?? 0;
  const bdB = b.bullpenDependence ?? 0;
  if (bdA !== bdB) return bdA - bdB;

  // 8. runAllocationDependence ASC
  const radA = a.runAllocationDependence ?? 0;
  const radB = b.runAllocationDependence ?? 0;
  if (radA !== radB) return radA - radB;

  // 9. stabilityScore DESC
  const ssA = a.stabilityScore ?? 0;
  const ssB = b.stabilityScore ?? 0;
  if (ssA !== ssB) return ssB - ssA;

  // True tie — return 0 to preserve stable input order. No vehicle-type tiebreaker.
  return 0;
}

// ─── Phase 3: Authorization ────────────────────────────────────────────────

/** Separation threshold matching module11 computeDecision (1.5 runs). */
const AUTH_CORE_THRESHOLD = 1.5;

/**
 * Apply CORE/NO_CORE authorization gates to an already-selected vehicle.
 *
 * Precondition: this is called AFTER evaluateVehicleViability (Phase 1) and
 * rankViableVehicles (Phase 2) have run. Viability is already established.
 * This function applies authorization gates only — it does not re-evaluate
 * structural viability.
 *
 * Gate order (matches computeDecision in module11_outputExtraction):
 *   1. Viability guard — returns NOT_EVALUABLE for non-VIABLE candidates.
 *   2. Data guard — returns PENDING if projection or market line is absent.
 *   3. UNRESOLVED_STARTER
 *   4. MISSING_EXPECTED_INNINGS
 *   5. BULLPEN_DATA_UNAVAILABLE
 *   6. INSUFFICIENT_PROJECTION_SEPARATION (< 1.5 runs)
 *   7. CORE
 */
export function authorizeSelectedVehicle(
  selected: VehicleCandidate,
  context: GameEligibilityContext,
): AuthorizationResult {
  // ── 1. Viability guard ──────────────────────────────────────────────────
  if (selected.viability !== "VIABLE") {
    return {
      decision:    "NOT_EVALUABLE",
      direction:   "NONE",
      coreBlocker: selected.viabilityBlocker ?? "NOT_VIABLE",
      confidence:  0,
      roi:         0,
    };
  }

  // ── 2. Data guard ───────────────────────────────────────────────────────
  if (selected.projection === undefined || selected.marketLine === undefined) {
    return { decision: "PENDING", direction: "NONE", coreBlocker: "NO_MARKET_LINE", confidence: 0, roi: 0 };
  }

  const variance  = selected.projection - selected.marketLine;
  const absVar    = Math.abs(variance);
  const direction: "OVER" | "UNDER" | "NONE" =
    variance > 0 ? "OVER" : variance < 0 ? "UNDER" : "NONE";

  const confidence = absVar >= AUTH_CORE_THRESHOLD
    ? parseFloat(Math.min(0.95, 0.55 + absVar * 0.08).toFixed(2))
    : parseFloat(Math.max(0.05, 0.45 - absVar * 0.05).toFixed(2));

  const roi = absVar >= AUTH_CORE_THRESHOLD
    ? parseFloat((absVar * 0.05).toFixed(3))
    : 0;

  // ── 3. UNRESOLVED_STARTER ───────────────────────────────────────────────
  if (
    context.awayPitcherRole === "UNRESOLVED" ||
    context.homePitcherRole === "UNRESOLVED"
  ) {
    return { decision: "NO_CORE", direction, coreBlocker: "UNRESOLVED_STARTER", confidence, roi: 0 };
  }

  // ── 4. MISSING_EXPECTED_INNINGS ─────────────────────────────────────────
  if (!context.awayExpectedInnings || !context.homeExpectedInnings) {
    return { decision: "NO_CORE", direction, coreBlocker: "MISSING_EXPECTED_INNINGS", confidence, roi: 0 };
  }

  // ── 5. BULLPEN_DATA_UNAVAILABLE ─────────────────────────────────────────
  if (!context.bullpenAvailable) {
    return { decision: "NO_CORE", direction, coreBlocker: "BULLPEN_DATA_UNAVAILABLE", confidence, roi: 0 };
  }

  // ── 6. Separation gate ──────────────────────────────────────────────────
  if (absVar < AUTH_CORE_THRESHOLD) {
    return { decision: "NO_CORE", direction, coreBlocker: "INSUFFICIENT_PROJECTION_SEPARATION", confidence, roi: 0 };
  }

  return { decision: "CORE", direction, coreBlocker: "", confidence, roi };
}
