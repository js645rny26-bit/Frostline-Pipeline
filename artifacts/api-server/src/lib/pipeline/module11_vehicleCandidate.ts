/**
 * Module 11 — Vehicle Candidate Shadow Architecture
 *
 * SHADOW MODULE — does NOT modify SLATE_BOARD, CORE counts, lock state,
 * workbook schema, or any live pipeline output. All functions are pure and
 * side-effect-free.
 *
 * Implements the four-phase vehicle-selection doctrine:
 *
 *   Phase 1  evaluateVehicleCandidate  — evaluability / structural check
 *   Phase 2  rankViableVehicles        — attribute-only price-blind ordering
 *   Phase 3  authorizeSelectedVehicle  — CORE/NO_CORE gates on the selected vehicle
 *
 * Doctrine constraints (enforced mechanically):
 *
 *   • Vehicle type determines which gates apply; it never creates preference,
 *     safety, or tiebreak priority.
 *   • Ranking uses only evaluated candidate attributes (scriptCapture,
 *     failureModeBurden, conversionBurden, timingDependence, workloadDependence,
 *     plateAppearanceDependence, bullpenDependence, runAllocationDependence,
 *     stability, dataCompleteness). Odds and juice are excluded.
 *   • A vehicle may be structurally VIABLE and still receive NO_CORE from
 *     authorization (Phase 3). Viability and authorization are separate.
 *   • Missing data freezes only the vehicles that depend on it.
 *   • True ties preserve stable input order (no hidden vehicle-type tiebreaker).
 *
 * Operational preservation:
 *   The existing GAME_TOTAL seed in module10_slateInput.ts is not touched.
 *   rankViableVehicles() is not wired to live Candidate_Vehicle or SLATE_BOARD.
 */

import type { GameEligibilityContext } from "./module11_outputExtraction.js";

// ─── Vehicle type catalogue ────────────────────────────────────────────────

/**
 * All known vehicle types in the pipeline.
 * "GAME_TOTAL" is the legacy operational seed from module10 (treated as a
 * full-game total without an explicit direction; preserved for continuity).
 * "TBD" signals no vehicle has been selected yet.
 */
export type VehicleType =
  | "FULL_GAME_OVER"
  | "FULL_GAME_UNDER"
  | "GAME_TOTAL"            // legacy operational seed — treated as full-game total
  | "TEAM_TOTAL_OVER"
  | "TEAM_TOTAL_UNDER"
  | "MONEYLINE"
  | "RUN_LINE"
  | "STARTER_OUTS_UNDER"
  | "STARTER_ER_OVER"
  | "STARTER_HITS_OVER"
  | "TBD";

/**
 * Four-state evaluation result for a vehicle candidate.
 *
 *   VIABLE       — required data is present; vehicle clears its own gates.
 *   NOT_VIABLE   — required data is present but a vehicle-specific gate fails.
 *   NOT_EVALUABLE — required projection, target, workload, market, or context
 *                   is missing; cannot assess this vehicle now.
 *   UNAVAILABLE  — vehicle was validly preferred but is not currently offered
 *                   (no live market, no line posted).
 *
 * Missing data must freeze only the affected vehicle, not siblings.
 */
export type VehicleEvaluationStatus =
  | "VIABLE"
  | "NOT_VIABLE"
  | "NOT_EVALUABLE"
  | "UNAVAILABLE";

// ─── Classification sets (internal) ────────────────────────────────────────
// Vehicle type determines which gates apply. It never determines preference.

const FULL_GAME_TOTAL_VEHICLES = new Set<VehicleType>([
  "FULL_GAME_OVER",
  "FULL_GAME_UNDER",
  "GAME_TOTAL",
]);

const TEAM_TOTAL_VEHICLES = new Set<VehicleType>([
  "TEAM_TOTAL_OVER",
  "TEAM_TOTAL_UNDER",
]);

const SIDE_VEHICLES = new Set<VehicleType>([
  "MONEYLINE",
  "RUN_LINE",
]);

const STARTER_PROP_VEHICLES = new Set<VehicleType>([
  "STARTER_OUTS_UNDER",
  "STARTER_ER_OVER",
  "STARTER_HITS_OVER",
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

// ─── Candidate contract ────────────────────────────────────────────────────

/**
 * A single vehicle candidate entering the evaluation and ranking pipeline.
 *
 * Identity fields (vehicleType, targetSide, targetTeam, targetPlayerId,
 * targetPlayerName) are caller-supplied.
 *
 * Doctrine ranking attributes (scriptCapture through dataCompleteness) are
 * populated by the caller from available pipeline signals. Undefined fields
 * are treated as 0 (neutral) by the comparator.
 *
 * evaluationStatus and blocker are written by evaluateVehicleCandidate.
 *
 * marketOdds is a transparency field only — it is explicitly excluded from
 * the comparator. Odds and juice must not influence vehicle selection.
 */
export interface VehicleCandidate {
  // ── Identity ──────────────────────────────────────────────────────────────
  vehicleType: VehicleType;
  /** Required for team-specific vehicles (TEAM_TOTAL_*, MONEYLINE, RUN_LINE). */
  targetSide?: "AWAY" | "HOME";
  /** Team abbreviation when the vehicle is team-specific. */
  targetTeam?: string;
  /** MLB player ID for player-prop vehicles. */
  targetPlayerId?: number;
  /** Display name for player-prop vehicles (transparency only). */
  targetPlayerName?: string;

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
   * American-odds representation of the market price (transparency field).
   * EXPLICITLY EXCLUDED from the comparator — odds and juice must not affect
   * vehicle selection or ranking.
   */
  marketOdds?: number;
  /**
   * Whether a live market currently exists for this vehicle.
   * UNAVAILABLE → not evaluable regardless of data completeness.
   */
  availability: "AVAILABLE" | "UNAVAILABLE";

  // ── Doctrine ranking attributes (all optional — 0 when absent) ────────────
  /**
   * How strongly this vehicle captures the game's dominant scoring script.
   * Higher = better expression of game truth.
   */
  scriptCapture?: number;
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
  stability?: number;
  /**
   * Fraction of required input data that is present, 0.0–1.0.
   * 1.0 = all required pipeline signals are present.
   */
  dataCompleteness?: number;

  // ── Evaluation result (written by evaluateVehicleCandidate) ──────────────
  evaluationStatus: VehicleEvaluationStatus;
  /** Machine-readable reason code when evaluationStatus !== VIABLE. */
  blocker?: string;
}

// ─── Rank result ───────────────────────────────────────────────────────────

/**
 * Result of rankViableVehicles.
 *
 * ranked       — VIABLE candidates in doctrine priority order. Empty when
 *                no viable candidate exists.
 * controllingBlockers — When ranked is empty, the blocker strings from every
 *                non-viable candidate, for diagnosis. Empty when ranked is
 *                non-empty.
 */
export interface RankViableResult {
  ranked: VehicleCandidate[];
  controllingBlockers: string[];
}

// ─── Authorization result ──────────────────────────────────────────────────

/**
 * Output of authorizeSelectedVehicle — CORE/NO_CORE gates applied to the
 * already-selected vehicle. This is Phase 3 only.
 */
export interface AuthorizationResult {
  /**
   * CORE          = authorized bet candidate.
   * NO_CORE       = blocked by an authorization gate.
   * NOT_EVALUABLE = viability gate failed; authorization was not reached.
   * PENDING       = no projection or market line to evaluate.
   */
  decision: "CORE" | "NO_CORE" | "NOT_EVALUABLE" | "PENDING";
  direction: "OVER" | "UNDER" | "NONE";
  /** Named reason when decision !== CORE. Empty string for CORE. */
  coreBlocker: string;
  confidence: number;
  roi: number;
}

// ─── Phase 1: Candidate evaluation ────────────────────────────────────────

/**
 * Evaluate whether a candidate is structurally evaluable and viable for
 * this game context.
 *
 * Returns a shallow copy of the candidate with evaluationStatus and blocker
 * set. Does NOT apply CORE authorization gates — that is Phase 3.
 *
 * Decision tree:
 *   1. UNAVAILABLE market → UNAVAILABLE
 *   2. Vehicle requires a projection type not yet commissioned → NOT_EVALUABLE
 *      (TEAM_TOTAL_*, MONEYLINE, RUN_LINE, STARTER_*, TBD)
 *   3. FULL_GAME_UNDER with unresolved opener/bulk workload → NOT_EVALUABLE
 *      Known opener/bulk chain (innings present) → VIABLE (caller elevates burdens)
 *   4. FULL_GAME_OVER / FULL_GAME_UNDER (workload resolved) / GAME_TOTAL → VIABLE
 *   5. Unknown vehicle type → NOT_EVALUABLE
 *
 * Missing workload freezes only workload-dependent vehicles (full-game Under).
 * Missing team-total projection freezes only team-total vehicles.
 * Missing starter-prop projection freezes only starter-prop vehicles.
 * Sibling vehicles are unaffected.
 */
export function evaluateVehicleCandidate(
  candidate: VehicleCandidate,
  context: GameEligibilityContext,
): VehicleCandidate {
  const result: VehicleCandidate = { ...candidate };

  // ── 1. Market availability ──────────────────────────────────────────────
  if (candidate.availability === "UNAVAILABLE") {
    result.evaluationStatus = "UNAVAILABLE";
    result.blocker = "MARKET_UNAVAILABLE";
    return result;
  }

  // ── 2. Projection type support ──────────────────────────────────────────
  // Only the full-game-total projection is currently commissioned.
  // Team totals, sides, and starter props require vehicle-specific projections
  // that do not yet exist. Each is frozen independently; siblings unaffected.
  if (
    TEAM_TOTAL_VEHICLES.has(candidate.vehicleType) ||
    SIDE_VEHICLES.has(candidate.vehicleType) ||
    STARTER_PROP_VEHICLES.has(candidate.vehicleType)
  ) {
    result.evaluationStatus = "NOT_EVALUABLE";
    result.blocker = "VEHICLE_PROJECTION_UNAVAILABLE";
    return result;
  }

  if (candidate.vehicleType === "TBD") {
    result.evaluationStatus = "NOT_EVALUABLE";
    result.blocker = "VEHICLE_NOT_SPECIFIED";
    return result;
  }

  // ── 3. Full-game total structural checks ────────────────────────────────
  if (FULL_GAME_TOTAL_VEHICLES.has(candidate.vehicleType)) {
    if (candidate.vehicleType === "FULL_GAME_UNDER") {
      // An opener/bulk/piggyback designation is NOT an automatic Under veto.
      // If the chain's workload (expected innings) is known: evaluate normally.
      // Caller is responsible for elevating workloadDependence and bullpenDependence
      // scores on the candidate to reflect the broader dependency burden.
      // If the chain is unresolved (innings null): NOT_EVALUABLE for this vehicle.
      const awayNonConventional = NON_CONVENTIONAL_ROLES.has(context.awayPitcherRole);
      const homeNonConventional = NON_CONVENTIONAL_ROLES.has(context.homePitcherRole);
      const awayWorkloadUnknown = awayNonConventional && context.awayExpectedInnings === null;
      const homeWorkloadUnknown = homeNonConventional && context.homeExpectedInnings === null;
      if (awayWorkloadUnknown || homeWorkloadUnknown) {
        result.evaluationStatus = "NOT_EVALUABLE";
        result.blocker = "UNRESOLVED_OPENER_WORKLOAD";
        return result;
      }
    }
    result.evaluationStatus = "VIABLE";
    return result;
  }

  // ── 4. Unknown vehicle type ─────────────────────────────────────────────
  result.evaluationStatus = "NOT_EVALUABLE";
  result.blocker = "UNKNOWN_VEHICLE_TYPE";
  return result;
}

// ─── Phase 2: Attribute-only ranking ──────────────────────────────────────

/**
 * Rank VIABLE candidates by doctrine criteria.
 *
 * Non-VIABLE candidates are excluded from ranked output. Their blockers are
 * collected into controllingBlockers for diagnosis when no viable vehicle
 * survives.
 *
 * Comparator reads evaluated candidate attributes exclusively.
 * Vehicle type is never used as a preference criterion or tiebreaker.
 * Odds and juice (marketOdds) are excluded.
 *
 * Criteria (in priority order):
 *   1. scriptCapture              DESC  (higher = better expression of game truth)
 *   2. failureModeBurden          ASC   (lower = more robust)
 *   3. conversionBurden           ASC
 *   4. timingDependence           ASC
 *   5. workloadDependence         ASC
 *   6. plateAppearanceDependence  ASC
 *   7. bullpenDependence          ASC
 *   8. runAllocationDependence    ASC
 *   9. stability                  DESC  (higher = more consistent)
 *  10. dataCompleteness           DESC  (higher = more data present)
 *
 * True tie on all ten criteria: returns 0. Node's Array.prototype.sort is
 * stable (V8 ≥ 7.0), so input order is preserved for equal candidates.
 * No vehicle-type tiebreaker is applied.
 */
export function rankViableVehicles(candidates: VehicleCandidate[]): RankViableResult {
  const viable     = candidates.filter(c => c.evaluationStatus === "VIABLE");
  const nonViable  = candidates.filter(c => c.evaluationStatus !== "VIABLE");

  const controllingBlockers: string[] = viable.length === 0
    ? nonViable.map(c => c.blocker ?? c.evaluationStatus).filter(Boolean)
    : [];

  const ranked = [...viable].sort(compareCandidateAttributes);

  return { ranked, controllingBlockers };
}

function compareCandidateAttributes(a: VehicleCandidate, b: VehicleCandidate): number {
  // 1. scriptCapture DESC
  const scA = a.scriptCapture ?? 0;
  const scB = b.scriptCapture ?? 0;
  if (scA !== scB) return scB - scA;

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

  // 9. stability DESC
  const ssA = a.stability ?? 0;
  const ssB = b.stability ?? 0;
  if (ssA !== ssB) return ssB - ssA;

  // 10. dataCompleteness DESC
  const dcA = a.dataCompleteness ?? 0;
  const dcB = b.dataCompleteness ?? 0;
  if (dcA !== dcB) return dcB - dcA;

  // True tie — return 0 to preserve stable input order. No vehicle-type comparison.
  return 0;
}

// ─── Phase 3: Authorization ────────────────────────────────────────────────

/** Separation threshold matching module11_outputExtraction CORE_THRESHOLD. */
const AUTH_CORE_THRESHOLD = 1.5;

/**
 * Apply CORE/NO_CORE authorization gates to an already-selected vehicle.
 *
 * Precondition: called AFTER evaluateVehicleCandidate (Phase 1) and
 * rankViableVehicles (Phase 2) have completed. The selected vehicle is
 * the top entry of ranked.
 *
 * The best vehicle remains identifiable even when authorization returns NO_CORE.
 * Do not use authorization status to filter or re-rank candidates.
 *
 * Gate order (matches computeDecision in module11_outputExtraction):
 *   1. Viability guard   — NOT_EVALUABLE for non-VIABLE evaluationStatus.
 *   2. Data guard        — PENDING if projection or marketLine is absent.
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
  if (selected.evaluationStatus !== "VIABLE") {
    return {
      decision:    "NOT_EVALUABLE",
      direction:   "NONE",
      coreBlocker: selected.blocker ?? selected.evaluationStatus,
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
