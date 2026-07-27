/**
 * module11 vehicle candidate shadow architecture — unit tests
 *
 * Tests the three-phase doctrine pipeline implemented in module11_vehicleCandidate.ts.
 * This module is SHADOW-ONLY; none of these tests touch live pipeline outputs.
 *
 * Functions under test (no Google Sheets I/O):
 *   evaluateVehicleViability  — Phase 1: structural / evaluability check
 *   rankViableVehicles        — Phase 2: attribute-only ordering
 *   authorizeSelectedVehicle  — Phase 3: CORE/NO_CORE authorization gates
 *
 * Test catalogue
 * ──────────────
 * Doctrine scenarios (8)
 *   S1  Either-side eruption: FG-Over wins over TT-Over when script capture is stronger
 *   S2  Run-allocation confidence: TT-Over wins over FG-Over when allocation is cleaner
 *   S3  Known opener/bulk chain: FG-Under is VIABLE when workload is known
 *   S4  Unknown opener/bulk workload: FG-Under becomes NOT_EVALUABLE
 *   S5  Starter prop with no projection: STARTER_OUTS_UNDER → NOT_EVALUABLE
 *   S6  Multi-candidate ranking by attributes
 *   S7  No viable candidates: rankViableVehicles returns empty array
 *   S8  Single viable candidate: selected unconditionally
 *
 * Mandatory additional tests (6)
 *   A1  Identical attributes, different vehicle labels → same rank, input order preserved
 *   A2  Viable but NO CORE → vehicle selected, authorization returns NO_CORE with blocker
 *   A3  Unknown workload isolation: STARTER_OUTS_UNDER NOT_EVALUABLE, FG-Over VIABLE
 *   A4  Known opener/bulk chain: FG-Under not auto-rejected by role label alone
 *   A5  Unsupported projection type: MONEYLINE → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE
 *   A6  No live-output drift: computeDecision results are byte-for-byte unchanged
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateVehicleViability,
  rankViableVehicles,
  authorizeSelectedVehicle,
  type VehicleCandidate,
} from "./module11_vehicleCandidate.js";

import {
  computeDecision,
  overSurvivalCheck,
  type GameEligibilityContext,
} from "./module11_outputExtraction.js";

// ─── Shared fixtures ───────────────────────────────────────────────────────

/** Fully-eligible game context: conventional starters, innings known, bullpen present. */
const CONVENTIONAL_CTX: GameEligibilityContext = {
  awayPitcherRole:      "CONVENTIONAL_STARTER",
  homePitcherRole:      "CONVENTIONAL_STARTER",
  awayExpectedInnings:  6.0,
  homeExpectedInnings:  6.0,
  bullpenAvailable:     true,
};

/** Helper to build a minimal VIABLE FULL_GAME_OVER candidate. */
function fgOverCandidate(overrides: Partial<VehicleCandidate> = {}): VehicleCandidate {
  return {
    vehicleType:   "FULL_GAME_OVER",
    availability:  "AVAILABLE",
    dataCompleteness: 1.0,
    projection:    10.5,
    marketLine:    8.5,
    viability:     "VIABLE",
    ...overrides,
  };
}

/** Helper to build a minimal VIABLE FULL_GAME_UNDER candidate. */
function fgUnderCandidate(overrides: Partial<VehicleCandidate> = {}): VehicleCandidate {
  return {
    vehicleType:   "FULL_GAME_UNDER",
    availability:  "AVAILABLE",
    dataCompleteness: 1.0,
    projection:    6.5,
    marketLine:    8.5,
    viability:     "VIABLE",
    ...overrides,
  };
}

// ─── Doctrine scenario S1 ──────────────────────────────────────────────────
// Either-side eruption: FG-Over wins over TT-Over when its script capture is
// stronger and its run-allocation dependence is lower.
//
// Supplying explicit attribute values so the test proves the comparator reads
// those values, not the vehicle type.

describe("S1: Either-side eruption — FG-Over ranks above TT-Over via attributes", () => {
  it("FG-Over (high script capture, low allocation dependence) ranks first", () => {
    const fgOver: VehicleCandidate = {
      vehicleType:          "FULL_GAME_OVER",
      availability:         "AVAILABLE",
      dataCompleteness:     1.0,
      viability:            "VIABLE",
      scriptCaptureScore:   0.90,   // strong aggregate run script
      runAllocationDependence: 0.15, // low — whole-game total, no split needed
      failureModeBurden:    0.20,
    };

    // TEAM_TOTAL_OVER is NOT_EVALUABLE under current projection availability,
    // so we use FULL_GAME_OVER as a stand-in with weaker attributes to test
    // the comparator directly.
    const narrowerOver: VehicleCandidate = {
      vehicleType:          "FULL_GAME_OVER",
      availability:         "AVAILABLE",
      dataCompleteness:     0.8,
      viability:            "VIABLE",
      scriptCaptureScore:   0.60,   // weaker script capture
      runAllocationDependence: 0.55, // higher — depends on team split
      failureModeBurden:    0.35,
    };

    const ranked = rankViableVehicles([narrowerOver, fgOver]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].scriptCaptureScore, 0.90,
      "Higher scriptCaptureScore candidate must rank first");
    assert.strictEqual(ranked[1].scriptCaptureScore, 0.60,
      "Lower scriptCaptureScore candidate must rank second");
    // Confirm: rank did not use vehicle type as a criterion
    assert.strictEqual(ranked[0].vehicleType, ranked[1].vehicleType,
      "Both candidates share the same vehicleType — rank came from attributes only");
  });
});

// ─── Doctrine scenario S2 ──────────────────────────────────────────────────
// Run-allocation confidence: a candidate with cleaner run-allocation can rank
// above one with a higher scriptCaptureScore when their scripts tie and the
// allocation-dependent one is demonstrably weaker.
//
// Here both candidates tie on scriptCaptureScore; the one with lower
// runAllocationDependence wins on criterion 8.

describe("S2: Run-allocation confidence — allocation-clean candidate wins tie", () => {
  it("Lower runAllocationDependence wins when all higher criteria are tied", () => {
    const allocationClean: VehicleCandidate = {
      vehicleType:              "FULL_GAME_OVER",
      availability:             "AVAILABLE",
      dataCompleteness:         1.0,
      viability:                "VIABLE",
      scriptCaptureScore:       0.75,
      failureModeBurden:        0.25,
      conversionBurden:         0.30,
      timingDependence:         0.20,
      workloadDependence:       0.20,
      plateAppearanceDependence: 0.15,
      bullpenDependence:        0.25,
      runAllocationDependence:  0.20,  // clean
    };

    const allocationDependent: VehicleCandidate = {
      vehicleType:              "FULL_GAME_OVER",
      availability:             "AVAILABLE",
      dataCompleteness:         1.0,
      viability:                "VIABLE",
      scriptCaptureScore:       0.75,  // tied
      failureModeBurden:        0.25,  // tied
      conversionBurden:         0.30,  // tied
      timingDependence:         0.20,  // tied
      workloadDependence:       0.20,  // tied
      plateAppearanceDependence: 0.15, // tied
      bullpenDependence:        0.25,  // tied
      runAllocationDependence:  0.65,  // higher — depends on team split clarity
    };

    const ranked = rankViableVehicles([allocationDependent, allocationClean]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].runAllocationDependence, 0.20,
      "Lower runAllocationDependence must rank first when higher criteria are tied");
    assert.strictEqual(ranked[1].runAllocationDependence, 0.65);
  });
});

// ─── Doctrine scenario S3 ──────────────────────────────────────────────────
// Known opener/bulk chain: Full-Game Under is VIABLE when the opener's workload
// (expected innings) is known, even though the role is non-conventional.

describe("S3: Known opener/bulk chain — FG-Under is VIABLE when innings are known", () => {
  it("FULL_GAME_UNDER with OPENER role + known innings → VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: 1.2,   // known — opener workload is resolved
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "VIABLE",
      "Known opener workload must not veto FG-Under — role label alone is insufficient");
    assert.strictEqual(result.viabilityBlocker, undefined,
      "No viabilityBlocker for VIABLE candidates");
  });

  it("FULL_GAME_UNDER with BULK role + known innings → VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "CONVENTIONAL_STARTER",
      homePitcherRole:     "BULK",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: 3.0,   // known — bulk pitcher innings resolved
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "VIABLE");
  });
});

// ─── Doctrine scenario S4 ──────────────────────────────────────────────────
// Unknown opener/bulk workload: FG-Under becomes NOT_EVALUABLE when the
// opener or bulk pitcher's workload cannot be assessed (expectedInnings null).

describe("S4: Unknown opener/bulk workload — FG-Under → NOT_EVALUABLE", () => {
  it("FULL_GAME_UNDER with OPENER + null innings → NOT_EVALUABLE UNRESOLVED_OPENER_WORKLOAD", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,   // workload unknown — cannot evaluate
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "UNRESOLVED_OPENER_WORKLOAD");
  });

  it("FULL_GAME_UNDER with PIGGYBACK_PRIMARY + null innings → NOT_EVALUABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "CONVENTIONAL_STARTER",
      homePitcherRole:     "PIGGYBACK_PRIMARY",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: null,
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "UNRESOLVED_OPENER_WORKLOAD");
  });

  it("FULL_GAME_OVER with OPENER + null innings → still VIABLE (not Under-specific)", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    // Opener check only applies to Under (workload matters most for run suppression).
    const candidate = fgOverCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "VIABLE",
      "Opener workload check does not apply to FULL_GAME_OVER");
  });
});

// ─── Doctrine scenario S5 ──────────────────────────────────────────────────
// Starter prop with no supporting projection: STARTER_OUTS_UNDER requires a
// starter-specific outs projection that does not yet exist.

describe("S5: Starter prop — NOT_EVALUABLE when projection unavailable", () => {
  it("STARTER_OUTS_UNDER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const candidate: VehicleCandidate = {
      vehicleType:      "STARTER_OUTS_UNDER",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      dataCompleteness: 0.0,
      viability:        "VIABLE",   // caller-supplied; evaluator will overwrite
    };

    const result = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("STARTER_ER_OVER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const candidate: VehicleCandidate = {
      vehicleType:      "STARTER_ER_OVER",
      targetSide:       "HOME",
      availability:     "AVAILABLE",
      dataCompleteness: 0.0,
      viability:        "VIABLE",
    };

    const result = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });
});

// ─── Doctrine scenario S6 ──────────────────────────────────────────────────
// Multi-candidate ranking: three viable candidates with different attribute
// profiles are sorted in the correct doctrine order.

describe("S6: Multi-candidate ranking by evaluated attributes", () => {
  it("Three VIABLE candidates ranked in correct attribute order", () => {
    const lowCapture: VehicleCandidate = {
      vehicleType:        "FULL_GAME_OVER",
      availability:       "AVAILABLE",
      dataCompleteness:   0.9,
      viability:          "VIABLE",
      scriptCaptureScore: 0.40,
      failureModeBurden:  0.20,
    };

    const highCapture: VehicleCandidate = {
      vehicleType:        "FULL_GAME_OVER",
      availability:       "AVAILABLE",
      dataCompleteness:   1.0,
      viability:          "VIABLE",
      scriptCaptureScore: 0.85,
      failureModeBurden:  0.25,
    };

    const midCapture: VehicleCandidate = {
      vehicleType:        "FULL_GAME_UNDER",
      availability:       "AVAILABLE",
      dataCompleteness:   0.95,
      viability:          "VIABLE",
      scriptCaptureScore: 0.65,
      failureModeBurden:  0.15,
    };

    const ranked = rankViableVehicles([lowCapture, highCapture, midCapture]);

    assert.strictEqual(ranked.length, 3);
    assert.strictEqual(ranked[0].scriptCaptureScore, 0.85, "Highest script capture first");
    assert.strictEqual(ranked[1].scriptCaptureScore, 0.65, "Mid script capture second");
    assert.strictEqual(ranked[2].scriptCaptureScore, 0.40, "Lowest script capture third");
  });
});

// ─── Doctrine scenario S7 ──────────────────────────────────────────────────
// No viable candidates: rankViableVehicles returns an empty array.

describe("S7: No viable candidates — empty ranked array", () => {
  it("All NOT_EVALUABLE/UNAVAILABLE → empty result from rankViableVehicles", () => {
    const moneyline: VehicleCandidate = {
      vehicleType:      "MONEYLINE",
      availability:     "AVAILABLE",
      dataCompleteness: 0.0,
      viability:        "NOT_EVALUABLE",
      viabilityBlocker: "VEHICLE_PROJECTION_UNAVAILABLE",
    };

    const unavailable: VehicleCandidate = {
      vehicleType:      "FULL_GAME_OVER",
      availability:     "UNAVAILABLE",
      dataCompleteness: 0.0,
      viability:        "UNAVAILABLE",
      viabilityBlocker: "MARKET_UNAVAILABLE",
    };

    const ranked = rankViableVehicles([moneyline, unavailable]);

    assert.strictEqual(ranked.length, 0,
      "No viable candidates — ranked list must be empty");
  });
});

// ─── Doctrine scenario S8 ──────────────────────────────────────────────────
// Single viable candidate among others that are not: selected unconditionally.

describe("S8: Single viable candidate among non-viable siblings", () => {
  it("One VIABLE among NOT_EVALUABLE siblings → that candidate is selected", () => {
    const viable: VehicleCandidate = fgOverCandidate({
      scriptCaptureScore:   0.70,
      runAllocationDependence: 0.25,
    });

    const notEvaluable: VehicleCandidate = {
      vehicleType:      "STARTER_OUTS_UNDER",
      availability:     "AVAILABLE",
      dataCompleteness: 0.0,
      viability:        "NOT_EVALUABLE",
      viabilityBlocker: "VEHICLE_PROJECTION_UNAVAILABLE",
    };

    const ranked = rankViableVehicles([notEvaluable, viable]);

    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].vehicleType, "FULL_GAME_OVER",
      "The single viable candidate is returned");
  });
});

// ─── Mandatory A1 ─────────────────────────────────────────────────────────
// Identical attributes, different vehicle labels: rank must not change.
// Input order must be preserved (stable sort guarantee).

describe("A1: Identical attributes, different vehicle labels → stable input order", () => {
  it("Two candidates with identical attributes preserve input order regardless of type", () => {
    const first: VehicleCandidate = {
      vehicleType:              "FULL_GAME_OVER",
      availability:             "AVAILABLE",
      dataCompleteness:         1.0,
      viability:                "VIABLE",
      scriptCaptureScore:       0.70,
      failureModeBurden:        0.25,
      conversionBurden:         0.30,
      timingDependence:         0.20,
      workloadDependence:       0.20,
      plateAppearanceDependence: 0.15,
      bullpenDependence:        0.20,
      runAllocationDependence:  0.30,
      stabilityScore:           0.80,
    };

    const second: VehicleCandidate = {
      ...first,
      vehicleType: "FULL_GAME_UNDER",   // only difference — different label, same attributes
    };

    const ranked = rankViableVehicles([first, second]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].vehicleType, "FULL_GAME_OVER",
      "First input must remain first when all attributes are identical");
    assert.strictEqual(ranked[1].vehicleType, "FULL_GAME_UNDER",
      "Second input must remain second when all attributes are identical");
  });

  it("Reversing input order changes result order (no hidden type preference)", () => {
    const candidateA: VehicleCandidate = {
      vehicleType:   "FULL_GAME_UNDER",
      availability:  "AVAILABLE",
      dataCompleteness: 1.0,
      viability:     "VIABLE",
      scriptCaptureScore: 0.55,
    };

    const candidateB: VehicleCandidate = {
      ...candidateA,
      vehicleType: "FULL_GAME_OVER",
    };

    const ranked1 = rankViableVehicles([candidateA, candidateB]);
    const ranked2 = rankViableVehicles([candidateB, candidateA]);

    assert.strictEqual(ranked1[0].vehicleType, "FULL_GAME_UNDER",
      "First input wins tie when A comes first");
    assert.strictEqual(ranked2[0].vehicleType, "FULL_GAME_OVER",
      "First input wins tie when B comes first — no type hierarchy");
  });
});

// ─── Mandatory A2 ─────────────────────────────────────────────────────────
// Viable but NO CORE: the vehicle is selected (Phase 2 complete), but
// authorizeSelectedVehicle returns NO_CORE with a specific blocker.
// Viability must remain VIABLE — authorization result is separate.

describe("A2: Viable but NO CORE — vehicle selected, authorization returns NO_CORE", () => {
  it("Candidate below separation threshold: VIABLE but NO_CORE INSUFFICIENT_PROJECTION_SEPARATION", () => {
    const candidate = fgOverCandidate({
      projection: 9.0,
      marketLine: 8.5,   // variance = 0.5, below 1.5 threshold
      scriptCaptureScore: 0.70,
    });

    // Phase 1 — viability
    const evaluated = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);
    assert.strictEqual(evaluated.viability, "VIABLE",
      "Insufficient edge does not affect structural viability");

    // Phase 2 — ranking (single candidate, rank is trivial)
    const ranked = rankViableVehicles([evaluated]);
    assert.strictEqual(ranked.length, 1, "Vehicle is ranked (not filtered out)");

    // Phase 3 — authorization
    const auth = authorizeSelectedVehicle(ranked[0], CONVENTIONAL_CTX);
    assert.strictEqual(auth.decision, "NO_CORE");
    assert.strictEqual(auth.coreBlocker, "INSUFFICIENT_PROJECTION_SEPARATION",
      "Phase 3 gate must report the separation failure");
  });

  it("Candidate with UNRESOLVED pitcher: VIABLE but NO_CORE UNRESOLVED_STARTER", () => {
    const candidate = fgOverCandidate({
      projection: 11.5,
      marketLine: 8.5,   // variance = 3.0, well above threshold
    });

    const unresolvedCtx: GameEligibilityContext = {
      awayPitcherRole:     "UNRESOLVED",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const evaluated = evaluateVehicleViability(candidate, unresolvedCtx);
    // FULL_GAME_OVER with conventional context: VIABLE regardless of authorization gates
    assert.strictEqual(evaluated.viability, "VIABLE");

    const auth = authorizeSelectedVehicle(evaluated, unresolvedCtx);
    assert.strictEqual(auth.decision, "NO_CORE");
    assert.strictEqual(auth.coreBlocker, "UNRESOLVED_STARTER");
  });
});

// ─── Mandatory A3 ─────────────────────────────────────────────────────────
// Unknown workload isolation: STARTER_OUTS_UNDER becomes NOT_EVALUABLE while
// the full-game-total vehicle in the same game remains independently VIABLE.

describe("A3: Unknown workload isolation — STARTER_OUTS_UNDER NOT_EVALUABLE; FG-Over VIABLE", () => {
  it("Both candidates evaluated in the same game context; only starter prop fails", () => {
    const starterProp: VehicleCandidate = {
      vehicleType:      "STARTER_OUTS_UNDER",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      dataCompleteness: 0.0,
      viability:        "VIABLE",   // will be overwritten
    };

    const fgOver: VehicleCandidate = fgOverCandidate({
      scriptCaptureScore: 0.70,
    });

    // Context: away starter has unknown workload (opener, innings null)
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const evalProp  = evaluateVehicleViability(starterProp, ctx);
    const evalFgOver = evaluateVehicleViability(fgOver, ctx);

    assert.strictEqual(evalProp.viability, "NOT_EVALUABLE",
      "STARTER_OUTS_UNDER: no projection available → NOT_EVALUABLE");
    assert.strictEqual(evalProp.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE",
      "Starter prop fails on projection type, not workload");

    assert.strictEqual(evalFgOver.viability, "VIABLE",
      "FG-Over is independently evaluable; opener check does not apply");

    // Only FG-Over survives into Phase 2
    const ranked = rankViableVehicles([evalProp, evalFgOver]);
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].vehicleType, "FULL_GAME_OVER");
  });
});

// ─── Mandatory A4 ─────────────────────────────────────────────────────────
// Known opener/bulk chain: Full-Game Under is not auto-rejected solely
// because of pitcher role label. Only unresolved workload blocks it.

describe("A4: Known opener/bulk chain — FG-Under not auto-rejected by role label", () => {
  it("Both OPENER + BULK with known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "BULK",
      awayExpectedInnings: 1.2,   // opener innings known
      homeExpectedInnings: 3.0,   // bulk innings known
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "VIABLE",
      "Both non-conventional roles with known innings must be VIABLE, not auto-blocked");
  });

  it("PIGGYBACK_SECONDARY with known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "CONVENTIONAL_STARTER",
      homePitcherRole:     "PIGGYBACK_SECONDARY",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: 3.0,
      bullpenAvailable:    true,
    };

    const candidate = fgUnderCandidate();
    const result = evaluateVehicleViability(candidate, ctx);

    assert.strictEqual(result.viability, "VIABLE",
      "PIGGYBACK_SECONDARY with known innings must not be auto-blocked");
  });
});

// ─── Mandatory A5 ─────────────────────────────────────────────────────────
// Unsupported projection type: MONEYLINE cannot use the full-game-total
// projection and must return NOT_EVALUABLE regardless of projection presence.

describe("A5: Unsupported projection type — MONEYLINE → NOT_EVALUABLE", () => {
  it("MONEYLINE with AVAILABLE market → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const candidate: VehicleCandidate = {
      vehicleType:      "MONEYLINE",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      dataCompleteness: 0.5,
      projection:       10.5,    // full-game projection present but semantically wrong
      marketLine:       -150,    // American odds — incompatible with total projection
      viability:        "VIABLE",
    };

    const result = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);

    assert.strictEqual(result.viability, "NOT_EVALUABLE",
      "MONEYLINE cannot be evaluated through a full-game-total projection");
    assert.strictEqual(result.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("RUN_LINE → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const candidate: VehicleCandidate = {
      vehicleType:      "RUN_LINE",
      targetSide:       "HOME",
      availability:     "AVAILABLE",
      dataCompleteness: 0.5,
      viability:        "VIABLE",
    };

    const result = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("TEAM_TOTAL_OVER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const candidate: VehicleCandidate = {
      vehicleType:      "TEAM_TOTAL_OVER",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      dataCompleteness: 0.5,
      viability:        "VIABLE",
    };

    const result = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);

    assert.strictEqual(result.viability, "NOT_EVALUABLE");
    assert.strictEqual(result.viabilityBlocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });
});

// ─── Mandatory A6 ─────────────────────────────────────────────────────────
// No live-output drift: the shadow module does not change the behaviour of
// computeDecision or overSurvivalCheck from module11_outputExtraction.
// These are the functions that drive live SLATE_BOARD and ACTIVE_BOARD.
// Results here are the reference baseline; any future regression proves drift.

describe("A6: No live-output drift — module11 computeDecision baseline unchanged", () => {
  it("computeDecision: CORE for projection well above line", () => {
    const result = computeDecision(10.5, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(result.decision, "CORE");
    assert.strictEqual(result.direction, "OVER");
    assert.strictEqual(result.coreBlocker, "");
  });

  it("computeDecision: NO_CORE INSUFFICIENT_PROJECTION_SEPARATION for small variance", () => {
    const result = computeDecision(9.0, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(result.decision, "NO_CORE");
    assert.strictEqual(result.coreBlocker, "INSUFFICIENT_PROJECTION_SEPARATION");
  });

  it("computeDecision: NO_CORE UNRESOLVED_STARTER for unresolved pitcher", () => {
    const ctx: GameEligibilityContext = {
      ...CONVENTIONAL_CTX,
      awayPitcherRole: "UNRESOLVED",
    };
    const result = computeDecision(12.0, 8.5, "GAME_TOTAL", ctx);
    assert.strictEqual(result.decision, "NO_CORE");
    assert.strictEqual(result.coreBlocker, "UNRESOLVED_STARTER");
  });

  it("computeDecision: PENDING for null market line", () => {
    const result = computeDecision(10.5, null, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(result.decision, "PENDING");
    assert.strictEqual(result.coreBlocker, "NO_MARKET_LINE");
  });

  it("overSurvivalCheck: FAIL ENVIRONMENT_DEPENDENT_OVER when env lifts Under-eligible game", () => {
    // baseball_only = 6.0, environment = 3.0, market = 8.5
    // baseball_only (6.0) < market (8.5) → environment manufactured the Over
    const result = overSurvivalCheck(
      3.5, // starterAttack
      2.5, // bullpen
      0,   // traffic
      0,   // HR/XBH
      6.0, // baseball_only
      3.0, // environment
      8.5, // market line
    );
    assert.strictEqual(result.survival_check, "FAIL");
    assert.strictEqual(result.survival_failure_reason, "ENVIRONMENT_DEPENDENT_OVER");
  });

  it("authorizeSelectedVehicle CORE result matches computeDecision CORE result", () => {
    const candidate = fgOverCandidate({
      projection: 10.5,
      marketLine: 8.5,
    });

    const evaluated = evaluateVehicleViability(candidate, CONVENTIONAL_CTX);
    const auth      = authorizeSelectedVehicle(evaluated, CONVENTIONAL_CTX);
    const legacy    = computeDecision(10.5, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);

    assert.strictEqual(auth.decision, legacy.decision,
      "Shadow authorization must produce the same decision as the live function");
    assert.strictEqual(auth.direction, legacy.direction);
    assert.strictEqual(auth.coreBlocker, legacy.coreBlocker);
    assert.strictEqual(auth.confidence, legacy.confidence);
    assert.strictEqual(auth.roi, legacy.roi);
  });
});
