/**
 * module11 vehicle candidate shadow architecture — regression suite
 *
 * Tests the four-phase doctrine pipeline in module11_vehicleCandidate.ts.
 * SHADOW-ONLY: no live pipeline outputs are touched by these tests.
 *
 * Functions under test:
 *   evaluateVehicleCandidate  — Phase 1: evaluability / structural check
 *   rankViableVehicles        — Phase 2: attribute-only price-blind ordering
 *   authorizeSelectedVehicle  — Phase 3: CORE/NO_CORE authorization gates
 *
 * 14 required regression tests
 * ─────────────────────────────
 *  1  Either-side eruption       FG-Over ranks first via explicit script-capture and
 *                                 allocation-dependence attributes.
 *  2  One-sided ownership        TT-Over ranks first via one-sided offensive ownership
 *                                 and lower run-allocation dependence.
 *  3  Traffic without conversion  Outs-Under ranks first via pitch stress / hook pathway
 *                                 attributes, not its vehicle label.
 *  4  Contact-dominant fade      Hits-Allowed-Over ranks first via contact-access
 *                                 attributes, not its vehicle label.
 *  5  Full-game Under burden     Unresolved suppression chain → NOT_EVALUABLE;
 *                                 opener label alone is insufficient.
 *  6  Price blindness            Changing odds / juice does not alter viability,
 *                                 ranking, or the selected vehicle.
 *  7  Unavailable preferred      Highest-ranked viable candidate is UNAVAILABLE;
 *                                 reroute occurs to next independently viable candidate.
 *  8  No viable vehicle          Returns empty ranked + controllingBlockers; does not
 *                                 force selection.
 *  9  Identical attributes       Vehicle type alone cannot affect ranking.
 * 10  Viable but NO CORE         Best vehicle is selected first; authorization returns
 *                                 NO_CORE with the applicable blocker.
 * 11  Unknown workload isolation  Starter prop → NOT_EVALUABLE; full-game total remains
 *                                 independently evaluable.
 * 12  Unsupported projection     Moneyline / team total / starter prop cannot reuse
 *                                 a full-game-total projection.
 * 13  Known opener/bulk chain    Full-Game Under is NOT auto-rejected by role label.
 * 14  No operational drift       computeDecision and overSurvivalCheck outputs are
 *                                 byte-for-byte identical to their pre-shadow baselines.
 *
 * Design note on tests 2–4
 * ─────────────────────────
 * TEAM_TOTAL_OVER, STARTER_OUTS_UNDER, and STARTER_HITS_OVER are currently
 * NOT_EVALUABLE (no vehicle-specific projection exists yet). Tests 2–4 target
 * the Phase 2 comparator directly: candidates are pre-built with
 * evaluationStatus = "VIABLE" to represent the future state when those
 * projections are commissioned. This isolates the ranking logic from the
 * current evaluability constraint and proves that attribute values — not
 * vehicle labels — determine rank.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateVehicleCandidate,
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

const CONVENTIONAL_CTX: GameEligibilityContext = {
  awayPitcherRole:     "CONVENTIONAL_STARTER",
  homePitcherRole:     "CONVENTIONAL_STARTER",
  awayExpectedInnings: 6.0,
  homeExpectedInnings: 6.0,
  bullpenAvailable:    true,
};

/** Minimal VIABLE FULL_GAME_OVER candidate with projection above threshold. */
function fgOver(overrides: Partial<VehicleCandidate> = {}): VehicleCandidate {
  return {
    vehicleType:      "FULL_GAME_OVER",
    availability:     "AVAILABLE",
    evaluationStatus: "VIABLE",
    projection:       10.5,
    marketLine:       8.5,
    ...overrides,
  };
}

/** Minimal VIABLE FULL_GAME_UNDER candidate with projection below threshold. */
function fgUnder(overrides: Partial<VehicleCandidate> = {}): VehicleCandidate {
  return {
    vehicleType:      "FULL_GAME_UNDER",
    availability:     "AVAILABLE",
    evaluationStatus: "VIABLE",
    projection:       6.5,
    marketLine:       8.5,
    ...overrides,
  };
}

// ─── Test 1: Either-side eruption ─────────────────────────────────────────

describe("T1: Either-side eruption — FG-Over ranks first via attributes", () => {
  it("Higher scriptCapture + lower runAllocationDependence wins regardless of vehicle label", () => {
    // Both candidates are FULL_GAME_OVER to confirm type is not the deciding factor.
    const strongAggregateScript = fgOver({
      scriptCapture:          0.90,  // strong: both sides driving runs
      runAllocationDependence: 0.15, // low: whole-game total, no team split needed
      failureModeBurden:       0.20,
    });

    const weakerScript = fgOver({
      scriptCapture:          0.60,  // weaker aggregate capture
      runAllocationDependence: 0.55, // higher: result depends on split clarity
      failureModeBurden:       0.35,
    });

    const { ranked } = rankViableVehicles([weakerScript, strongAggregateScript]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].scriptCapture, 0.90,
      "Higher scriptCapture must rank first");
    assert.strictEqual(ranked[1].scriptCapture, 0.60,
      "Lower scriptCapture must rank second");
    assert.strictEqual(ranked[0].vehicleType, ranked[1].vehicleType,
      "Same vehicle type in both positions — rank came purely from attributes");
  });
});

// ─── Test 2: One-sided ownership ──────────────────────────────────────────

describe("T2: One-sided ownership — TT-Over ranks first via ownership attributes", () => {
  it("Team-total candidate with stronger one-sided ownership ranks above full-game candidate", () => {
    // Projections are hypothetical (pre-commissioning) — evaluationStatus pre-set to
    // VIABLE to isolate the comparator from current evaluability constraints.
    const teamTotalOwnership: VehicleCandidate = {
      vehicleType:            "TEAM_TOTAL_OVER",
      targetSide:             "AWAY",
      targetTeam:             "SEA",
      availability:           "AVAILABLE",
      evaluationStatus:       "VIABLE",
      scriptCapture:          0.85,  // strong: away team owns the offensive script
      runAllocationDependence: 0.25, // low: only one team's allocation matters
      failureModeBurden:      0.22,
    };

    const fullGameDiffuse = fgOver({
      scriptCapture:          0.65,  // weaker: script is split, both teams uncertain
      runAllocationDependence: 0.60, // high: depends on how both teams allocate
      failureModeBurden:      0.30,
    });

    const { ranked } = rankViableVehicles([fullGameDiffuse, teamTotalOwnership]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].scriptCapture, 0.85,
      "One-sided ownership (higher scriptCapture) must rank first");
    assert.strictEqual(ranked[0].vehicleType, "TEAM_TOTAL_OVER",
      "Team-total wins because of attributes, not because of its label");
  });
});

// ─── Test 3: Traffic without conversion ──────────────────────────────────

describe("T3: Traffic without conversion — Outs-Under ranks first via pitch-stress attributes", () => {
  it("Outs-Under candidate with strong pitch-stress attributes ranks above FG-Over with weak conversion path", () => {
    // Pre-set VIABLE to test the comparator (no starter projection exists yet).
    const outsUnderPitchStress: VehicleCandidate = {
      vehicleType:        "STARTER_OUTS_UNDER",
      targetSide:         "AWAY",
      availability:       "AVAILABLE",
      evaluationStatus:   "VIABLE",
      scriptCapture:      0.80,  // high: pitch-stress hook is the dominant path
      conversionBurden:   0.20,  // low: outs don't require run conversion
      failureModeBurden:  0.18,
    };

    const fgOverWeakConversion = fgOver({
      scriptCapture:    0.55,  // lower: script predicts traffic but conversion is uncertain
      conversionBurden: 0.70,  // high: traffic must convert to runs to win
      failureModeBurden: 0.45,
    });

    const { ranked } = rankViableVehicles([fgOverWeakConversion, outsUnderPitchStress]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].vehicleType, "STARTER_OUTS_UNDER",
      "Outs-Under ranks first because its pitch-stress attributes are superior");
    assert.strictEqual(ranked[0].scriptCapture, 0.80);
    assert.strictEqual(ranked[0].conversionBurden, 0.20);
  });
});

// ─── Test 4: Contact-dominant fade ───────────────────────────────────────

describe("T4: Contact-dominant fade — Hits-Allowed-Over ranks first via contact-access attributes", () => {
  it("Hits-Allowed-Over with strong contact-access attributes ranks above FG-Under with weak suppression", () => {
    // Pre-set VIABLE (no starter projection yet).
    const hitsAllowedContactStrong: VehicleCandidate = {
      vehicleType:            "STARTER_HITS_OVER",
      targetSide:             "HOME",
      availability:           "AVAILABLE",
      evaluationStatus:       "VIABLE",
      scriptCapture:          0.82,  // high: contact-access path is dominant
      conversionBurden:       0.15,  // very low: hits are the direct output
      runAllocationDependence: 0.10, // not dependent on cross-team allocation
      failureModeBurden:       0.20,
    };

    const fgUnderWeakSuppression = fgUnder({
      scriptCapture:          0.50,  // lower: suppression script is not dominant
      conversionBurden:       0.55,  // high: requires both starters to be effective
      runAllocationDependence: 0.45,
      failureModeBurden:       0.40,
    });

    const { ranked } = rankViableVehicles([fgUnderWeakSuppression, hitsAllowedContactStrong]);

    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].vehicleType, "STARTER_HITS_OVER",
      "Hits-Allowed-Over ranks first because contact-access attributes are superior");
    assert.strictEqual(ranked[0].scriptCapture, 0.82);
  });
});

// ─── Test 5: Full-game Under burden ──────────────────────────────────────

describe("T5: Full-game Under burden — unresolved suppression chain → NOT_EVALUABLE", () => {
  it("OPENER with null expectedInnings → NOT_EVALUABLE UNRESOLVED_OPENER_WORKLOAD", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,   // chain identity unresolved
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const result = evaluateVehicleCandidate(fgUnder(), ctx);
    assert.strictEqual(result.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(result.blocker, "UNRESOLVED_OPENER_WORKLOAD");
  });

  it("OPENER label alone with known innings does NOT freeze FG-Under", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: 1.2,   // workload is known
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const result = evaluateVehicleCandidate(fgUnder(), ctx);
    assert.strictEqual(result.evaluationStatus, "VIABLE",
      "Role label alone is not a veto — known innings make the chain evaluable");
  });

  it("FG-Over in the same game is VIABLE regardless of the away opener", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const result = evaluateVehicleCandidate(fgOver(), ctx);
    assert.strictEqual(result.evaluationStatus, "VIABLE",
      "Opener workload check is Under-specific; FG-Over is unaffected");
  });
});

// ─── Test 6: Price blindness ──────────────────────────────────────────────

describe("T6: Price blindness — odds and juice do not affect ranking or selection", () => {
  it("Changing marketOdds on the leading candidate does not alter rank", () => {
    const candidateA = fgOver({
      scriptCapture:  0.80,
      failureModeBurden: 0.20,
      marketOdds:     -110,
    });

    const candidateB = fgOver({
      scriptCapture:  0.60,
      failureModeBurden: 0.30,
      marketOdds:     +130,  // better payout but irrelevant to rank
    });

    const { ranked: ranked1 } = rankViableVehicles([candidateA, candidateB]);
    assert.strictEqual(ranked1[0].scriptCapture, 0.80,
      "Candidate A ranks first regardless of odds");

    // Now give candidate A extreme juice and re-rank
    const candidateABadOdds = { ...candidateA, marketOdds: +500 };
    const { ranked: ranked2 } = rankViableVehicles([candidateABadOdds, candidateB]);
    assert.strictEqual(ranked2[0].scriptCapture, 0.80,
      "Rank is unchanged even when odds swing to +500");
  });

  it("Evaluability is unchanged by marketOdds value", () => {
    const steep = { ...fgOver(), marketOdds: -350 };
    const flat  = { ...fgOver(), marketOdds: -102 };
    assert.strictEqual(evaluateVehicleCandidate(steep, CONVENTIONAL_CTX).evaluationStatus, "VIABLE");
    assert.strictEqual(evaluateVehicleCandidate(flat,  CONVENTIONAL_CTX).evaluationStatus, "VIABLE");
  });

  it("Authorization is unchanged by marketOdds value", () => {
    const candidate = fgOver({ marketOdds: -150 });
    const authA = authorizeSelectedVehicle(candidate, CONVENTIONAL_CTX);
    const authB = authorizeSelectedVehicle({ ...candidate, marketOdds: +120 }, CONVENTIONAL_CTX);
    assert.strictEqual(authA.decision, authB.decision);
    assert.strictEqual(authA.coreBlocker, authB.coreBlocker);
  });
});

// ─── Test 7: Unavailable preferred vehicle ────────────────────────────────

describe("T7: Unavailable preferred vehicle — reroute to next independently viable candidate", () => {
  it("UNAVAILABLE best-ranked candidate is excluded; next viable is selected", () => {
    const bestByAttributes: VehicleCandidate = {
      vehicleType:      "FULL_GAME_OVER",
      availability:     "UNAVAILABLE",    // market not offered
      evaluationStatus: "UNAVAILABLE",
      blocker:          "MARKET_UNAVAILABLE",
      scriptCapture:    0.95,             // would have ranked first
      failureModeBurden: 0.10,
    };

    const nextBest = fgOver({
      scriptCapture:    0.70,
      failureModeBurden: 0.25,
    });

    const { ranked, controllingBlockers } = rankViableVehicles([bestByAttributes, nextBest]);

    assert.strictEqual(ranked.length, 1,
      "UNAVAILABLE candidate must be filtered from ranked output");
    assert.strictEqual(ranked[0].scriptCapture, 0.70,
      "Next independently viable candidate is selected");
    assert.strictEqual(controllingBlockers.length, 0,
      "controllingBlockers is empty when at least one viable candidate exists");
  });

  it("Reroute does not occur by CORE status — UNAVAILABLE is the only reroute trigger", () => {
    // A candidate that is VIABLE but will receive NO_CORE from authorization
    // must still appear in ranked (reroute happens only for UNAVAILABLE, not NO_CORE).
    const viableNoCoreCandidate = fgOver({
      projection: 9.0,  // variance = 0.5 — will be NO_CORE on authorization
      marketLine: 8.5,
      scriptCapture: 0.80,
    });

    const { ranked } = rankViableVehicles([viableNoCoreCandidate]);

    assert.strictEqual(ranked.length, 1,
      "VIABLE candidate must appear in ranked even if it will receive NO_CORE");
    const auth = authorizeSelectedVehicle(ranked[0], CONVENTIONAL_CTX);
    assert.strictEqual(auth.decision, "NO_CORE",
      "Authorization returns NO_CORE after ranking, not during");
  });
});

// ─── Test 8: No viable vehicle ───────────────────────────────────────────

describe("T8: No viable vehicle — returns empty ranked + controllingBlockers", () => {
  it("All non-viable candidates: empty ranked, blockers collected, no forced selection", () => {
    const moneyline: VehicleCandidate = {
      vehicleType:      "MONEYLINE",
      availability:     "AVAILABLE",
      evaluationStatus: "NOT_EVALUABLE",
      blocker:          "VEHICLE_PROJECTION_UNAVAILABLE",
    };

    const unavailable: VehicleCandidate = {
      vehicleType:      "FULL_GAME_OVER",
      availability:     "UNAVAILABLE",
      evaluationStatus: "UNAVAILABLE",
      blocker:          "MARKET_UNAVAILABLE",
    };

    const { ranked, controllingBlockers } = rankViableVehicles([moneyline, unavailable]);

    assert.strictEqual(ranked.length, 0,
      "No viable candidates — ranked must be empty");
    assert.ok(controllingBlockers.includes("VEHICLE_PROJECTION_UNAVAILABLE"),
      "MONEYLINE blocker must appear in controllingBlockers");
    assert.ok(controllingBlockers.includes("MARKET_UNAVAILABLE"),
      "UNAVAILABLE market blocker must appear in controllingBlockers");
  });
});

// ─── Test 9: Identical attributes, different vehicle labels ───────────────

describe("T9: Identical attributes, different labels — vehicle type cannot affect ranking", () => {
  it("True tie on all criteria: input order preserved, type is irrelevant", () => {
    const attrs: Partial<VehicleCandidate> = {
      availability:             "AVAILABLE",
      evaluationStatus:         "VIABLE",
      scriptCapture:            0.70,
      failureModeBurden:        0.25,
      conversionBurden:         0.30,
      timingDependence:         0.20,
      workloadDependence:       0.20,
      plateAppearanceDependence: 0.15,
      bullpenDependence:        0.20,
      runAllocationDependence:  0.30,
      stability:                0.80,
      dataCompleteness:         1.0,
    };

    const first:  VehicleCandidate = { ...attrs, vehicleType: "FULL_GAME_OVER",  availability: "AVAILABLE", evaluationStatus: "VIABLE" };
    const second: VehicleCandidate = { ...attrs, vehicleType: "FULL_GAME_UNDER", availability: "AVAILABLE", evaluationStatus: "VIABLE" };

    const { ranked: fwd } = rankViableVehicles([first, second]);
    assert.strictEqual(fwd[0].vehicleType, "FULL_GAME_OVER",
      "First input comes first on a true tie");

    const { ranked: rev } = rankViableVehicles([second, first]);
    assert.strictEqual(rev[0].vehicleType, "FULL_GAME_UNDER",
      "Reversing input reverses output — no hidden type preference");
  });
});

// ─── Test 10: Viable but NO CORE ─────────────────────────────────────────

describe("T10: Viable but NO CORE — best vehicle selected first, authorization returns NO_CORE", () => {
  it("Candidate below separation threshold: VIABLE → ranked → NO_CORE INSUFFICIENT_PROJECTION_SEPARATION", () => {
    const candidate = fgOver({
      projection: 9.0,
      marketLine: 8.5,   // variance = 0.5, below 1.5 threshold
      scriptCapture: 0.70,
    });

    const evaluated = evaluateVehicleCandidate(candidate, CONVENTIONAL_CTX);
    assert.strictEqual(evaluated.evaluationStatus, "VIABLE",
      "Insufficient edge does not affect structural evaluability");

    const { ranked } = rankViableVehicles([evaluated]);
    assert.strictEqual(ranked.length, 1, "Vehicle appears in ranked output");

    const auth = authorizeSelectedVehicle(ranked[0], CONVENTIONAL_CTX);
    assert.strictEqual(auth.decision, "NO_CORE");
    assert.strictEqual(auth.coreBlocker, "INSUFFICIENT_PROJECTION_SEPARATION");
  });

  it("Unresolved pitcher: VIABLE → ranked → NO_CORE UNRESOLVED_STARTER", () => {
    const candidate = fgOver({ projection: 12.0, marketLine: 8.5 });
    const unresolvedCtx: GameEligibilityContext = {
      ...CONVENTIONAL_CTX,
      awayPitcherRole: "UNRESOLVED",
    };

    const evaluated = evaluateVehicleCandidate(candidate, unresolvedCtx);
    assert.strictEqual(evaluated.evaluationStatus, "VIABLE");

    const { ranked } = rankViableVehicles([evaluated]);
    const auth = authorizeSelectedVehicle(ranked[0], unresolvedCtx);
    assert.strictEqual(auth.decision, "NO_CORE");
    assert.strictEqual(auth.coreBlocker, "UNRESOLVED_STARTER");
  });
});

// ─── Test 11: Unknown workload isolation ─────────────────────────────────

describe("T11: Unknown workload isolation — starter prop frozen; full-game total unaffected", () => {
  it("STARTER_OUTS_UNDER NOT_EVALUABLE and FG-Over VIABLE in the same context", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: null,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };

    const starterProp: VehicleCandidate = {
      vehicleType:      "STARTER_OUTS_UNDER",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      evaluationStatus: "VIABLE",   // overwritten by evaluateVehicleCandidate
    };

    const fg = fgOver();

    const evalProp = evaluateVehicleCandidate(starterProp, ctx);
    const evalFg   = evaluateVehicleCandidate(fg, ctx);

    assert.strictEqual(evalProp.evaluationStatus, "NOT_EVALUABLE",
      "STARTER_OUTS_UNDER: no projection available → NOT_EVALUABLE (independent of workload check)");
    assert.strictEqual(evalProp.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");

    assert.strictEqual(evalFg.evaluationStatus, "VIABLE",
      "FG-Over is independently evaluable; opener workload check does not apply to Over");

    const { ranked, controllingBlockers } = rankViableVehicles([evalProp, evalFg]);
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].vehicleType, "FULL_GAME_OVER");
    assert.strictEqual(controllingBlockers.length, 0,
      "controllingBlockers is empty while at least one viable candidate exists");
  });
});

// ─── Test 12: Unsupported projection protection ───────────────────────────

describe("T12: Unsupported projection — non-FG vehicles cannot reuse full-game-total logic", () => {
  it("MONEYLINE → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const c: VehicleCandidate = {
      vehicleType:      "MONEYLINE",
      targetSide:       "AWAY",
      availability:     "AVAILABLE",
      evaluationStatus: "VIABLE",
      projection:       10.5,   // full-game projection present but semantically wrong
      marketLine:       -150,   // American odds — incompatible with total projection
    };
    const result = evaluateVehicleCandidate(c, CONVENTIONAL_CTX);
    assert.strictEqual(result.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(result.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("RUN_LINE → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const c: VehicleCandidate = {
      vehicleType: "RUN_LINE", targetSide: "HOME",
      availability: "AVAILABLE", evaluationStatus: "VIABLE",
    };
    const r = evaluateVehicleCandidate(c, CONVENTIONAL_CTX);
    assert.strictEqual(r.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(r.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("TEAM_TOTAL_OVER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const c: VehicleCandidate = {
      vehicleType: "TEAM_TOTAL_OVER", targetSide: "AWAY",
      availability: "AVAILABLE", evaluationStatus: "VIABLE",
    };
    const r = evaluateVehicleCandidate(c, CONVENTIONAL_CTX);
    assert.strictEqual(r.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(r.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("TEAM_TOTAL_UNDER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const c: VehicleCandidate = {
      vehicleType: "TEAM_TOTAL_UNDER", targetSide: "HOME",
      availability: "AVAILABLE", evaluationStatus: "VIABLE",
    };
    const r = evaluateVehicleCandidate(c, CONVENTIONAL_CTX);
    assert.strictEqual(r.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(r.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });

  it("STARTER_ER_OVER → NOT_EVALUABLE VEHICLE_PROJECTION_UNAVAILABLE", () => {
    const c: VehicleCandidate = {
      vehicleType: "STARTER_ER_OVER", targetSide: "HOME",
      availability: "AVAILABLE", evaluationStatus: "VIABLE",
    };
    const r = evaluateVehicleCandidate(c, CONVENTIONAL_CTX);
    assert.strictEqual(r.evaluationStatus, "NOT_EVALUABLE");
    assert.strictEqual(r.blocker, "VEHICLE_PROJECTION_UNAVAILABLE");
  });
});

// ─── Test 13: Known opener/bulk chain ────────────────────────────────────

describe("T13: Known opener/bulk chain — FG-Under not auto-rejected by role designation", () => {
  it("OPENER + known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "CONVENTIONAL_STARTER",
      awayExpectedInnings: 1.2,
      homeExpectedInnings: 6.0,
      bullpenAvailable:    true,
    };
    assert.strictEqual(evaluateVehicleCandidate(fgUnder(), ctx).evaluationStatus, "VIABLE");
  });

  it("BULK + known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "CONVENTIONAL_STARTER",
      homePitcherRole:     "BULK",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: 3.0,
      bullpenAvailable:    true,
    };
    assert.strictEqual(evaluateVehicleCandidate(fgUnder(), ctx).evaluationStatus, "VIABLE");
  });

  it("Both OPENER + BULK with known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "OPENER",
      homePitcherRole:     "BULK",
      awayExpectedInnings: 1.2,
      homeExpectedInnings: 3.0,
      bullpenAvailable:    true,
    };
    assert.strictEqual(evaluateVehicleCandidate(fgUnder(), ctx).evaluationStatus, "VIABLE");
  });

  it("PIGGYBACK_SECONDARY + known innings: FG-Under is VIABLE", () => {
    const ctx: GameEligibilityContext = {
      awayPitcherRole:     "CONVENTIONAL_STARTER",
      homePitcherRole:     "PIGGYBACK_SECONDARY",
      awayExpectedInnings: 6.0,
      homeExpectedInnings: 3.0,
      bullpenAvailable:    true,
    };
    assert.strictEqual(evaluateVehicleCandidate(fgUnder(), ctx).evaluationStatus, "VIABLE");
  });
});

// ─── Test 14: No operational drift ───────────────────────────────────────

describe("T14: No operational drift — live pipeline outputs are unchanged by shadow architecture", () => {
  it("computeDecision CORE: projection well above line", () => {
    const r = computeDecision(10.5, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(r.decision, "CORE");
    assert.strictEqual(r.direction, "OVER");
    assert.strictEqual(r.coreBlocker, "");
    assert.strictEqual(r.confidence, 0.71);
    assert.strictEqual(r.roi, 0.1);
  });

  it("computeDecision NO_CORE: insufficient separation", () => {
    const r = computeDecision(9.0, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(r.decision, "NO_CORE");
    assert.strictEqual(r.coreBlocker, "INSUFFICIENT_PROJECTION_SEPARATION");
  });

  it("computeDecision NO_CORE: unresolved starter", () => {
    const ctx: GameEligibilityContext = { ...CONVENTIONAL_CTX, awayPitcherRole: "UNRESOLVED" };
    const r = computeDecision(12.0, 8.5, "GAME_TOTAL", ctx);
    assert.strictEqual(r.decision, "NO_CORE");
    assert.strictEqual(r.coreBlocker, "UNRESOLVED_STARTER");
  });

  it("computeDecision PENDING: null market line", () => {
    const r = computeDecision(10.5, null, "GAME_TOTAL", CONVENTIONAL_CTX);
    assert.strictEqual(r.decision, "PENDING");
    assert.strictEqual(r.coreBlocker, "NO_MARKET_LINE");
  });

  it("overSurvivalCheck FAIL ENVIRONMENT_DEPENDENT_OVER: env lifts otherwise-suppressed game", () => {
    // baseball_only (6.0) < market (8.5) → env manufactured the Over
    const r = overSurvivalCheck(3.5, 2.5, 0, 0, 6.0, 3.0, 8.5);
    assert.strictEqual(r.survival_check, "FAIL");
    assert.strictEqual(r.survival_failure_reason, "ENVIRONMENT_DEPENDENT_OVER");
  });

  it("authorizeSelectedVehicle CORE matches computeDecision CORE exactly", () => {
    const candidate = fgOver({ projection: 10.5, marketLine: 8.5 });
    const evaluated  = evaluateVehicleCandidate(candidate, CONVENTIONAL_CTX);
    const auth       = authorizeSelectedVehicle(evaluated, CONVENTIONAL_CTX);
    const legacy     = computeDecision(10.5, 8.5, "GAME_TOTAL", CONVENTIONAL_CTX);

    assert.strictEqual(auth.decision,    legacy.decision);
    assert.strictEqual(auth.direction,   legacy.direction);
    assert.strictEqual(auth.coreBlocker, legacy.coreBlocker);
    assert.strictEqual(auth.confidence,  legacy.confidence);
    assert.strictEqual(auth.roi,         legacy.roi);
  });
});
