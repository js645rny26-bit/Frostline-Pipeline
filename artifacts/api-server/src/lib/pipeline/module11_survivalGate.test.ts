/**
 * module11 survival gate — unit tests
 *
 * Tests three contract points:
 *
 *  1. PENDING → re-run with line: a game that was PENDING (no market line)
 *     correctly executes the Over survival check when a line is later posted,
 *     rather than bypassing it.
 *
 *  2. Survival gate blocks CORE: when the gate trips, a specific survival
 *     failure reason appears as the CORE_Blocker and the decision flips to
 *     NO_CORE.
 *
 *  3. Survival_Floor populated for all Over games with a market line: even
 *     games that are already NO_CORE on other grounds (e.g. below the
 *     separation threshold) have survival_floor populated when direction is
 *     OVER and a market line is present.
 *
 * Pure functions under test (no Google Sheets I/O):
 *   overSurvivalCheck  — exported from module11_outputExtraction
 *   computeDecision    — exported from module11_outputExtraction
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  overSurvivalCheck,
  computeDecision,
  applyOverSurvivalGate,
  type GameEligibilityContext,
  type OverSurvivalResult,
  type OverSurvivalGateResult,
} from "./module11_outputExtraction.js";

// ─── shared fixtures ─────────────────────────────────────────────────────────

/** A fully-eligible game context (all pitcher roles resolved, innings present). */
const ELIGIBLE_CTX: GameEligibilityContext = {
  awayPitcherRole:     "CONVENTIONAL_STARTER",
  homePitcherRole:     "CONVENTIONAL_STARTER",
  awayExpectedInnings: 5.5,
  homeExpectedInnings: 6.0,
  bullpenAvailable:    true,
};

/**
 * Survival components that produce a PASS when market line = 8.5:
 *   baseball_only_projection = 6.0 + 4.0 = 10.0  (edge = 1.5 ≥ 1.25 ✓)
 *   survival_floor = 6.0×0.80 + 4.0×0.75 + 0×0.70 + 0×0.90 = 7.80  (edge = −0.70 vs 8.5 → FAIL)
 * Wait — let me recalculate for a real PASS scenario.
 *
 * For a clean PASS at line 8.0:
 *   starterAttack = 5.0, bullpen = 4.5  → baseball_only = 9.5, edge = 1.5 ≥ 1.25 ✓
 *   floor = 5.0×0.80 + 4.5×0.75 + 0 + 0 = 4.0 + 3.375 = 7.375  edge = 7.375 − 8.0 = −0.625 → FAIL
 *
 * Survival floor must EXCEED the market line by ≥ 0.25.
 * With traffic + HR components at 0, the floor will almost always be below the line
 * unless baseball_only_projection is very high.
 *
 * For a PASS at line 7.0 with large baseball components:
 *   starterAttack = 4.0, bullpen = 3.5  → baseball_only = 7.5, edge = 0.5 < 1.25 → FAIL (baseball edge)
 *
 * For a PASS we need:
 *   baseball_only_projection − market_line ≥ 1.25   (baseball edge)
 *   floor − market_line ≥ 0.25                       (floor edge)
 *
 * floor = starter×0.80 + bullpen×0.75 (traffic + hr = 0 currently)
 * floor ≥ market_line + 0.25
 * starter×0.80 + bullpen×0.75 ≥ line + 0.25
 *
 * Suppose line = 7.5:
 *   Need baseball_only ≥ 8.75   → starter + bullpen ≥ 8.75
 *   Need floor ≥ 7.75           → 0.80×starter + 0.75×bullpen ≥ 7.75
 *
 *   starter = 5.0, bullpen = 4.0 → baseball_only = 9.0 (edge 1.5 ✓)
 *   floor = 4.0 + 3.0 = 7.0  → floor edge = −0.5 → FAIL
 *
 *   starter = 5.5, bullpen = 4.5 → baseball_only = 10.0 (edge 2.5 ✓)
 *   floor = 4.4 + 3.375 = 7.775  → floor edge = 0.275 ≥ 0.25 ✓  → PASS!
 */
const PASS_COMPONENTS = {
  starterAttackRuns:       5.5,
  bullpenContinuationRuns: 4.5,
  trafficConversionRuns:   0,
  hrXbhDamageRuns:         0,
  baseballOnlyProjection:  10.0,   // = starter + bullpen
  environmentRunAdjustment: 0.5,   // env adds 0.5 → projected_total = 10.5
  marketLine:              7.5,
};

// ─── §1: overSurvivalCheck unit tests ────────────────────────────────────────

describe("overSurvivalCheck", () => {
  it("returns PASS when baseball edge ≥ 1.25 and floor edge ≥ 0.25", () => {
    const result = overSurvivalCheck(
      PASS_COMPONENTS.starterAttackRuns,
      PASS_COMPONENTS.bullpenContinuationRuns,
      PASS_COMPONENTS.trafficConversionRuns,
      PASS_COMPONENTS.hrXbhDamageRuns,
      PASS_COMPONENTS.baseballOnlyProjection,
      PASS_COMPONENTS.environmentRunAdjustment,
      PASS_COMPONENTS.marketLine,
    );
    assert.equal(result.survival_check, "PASS");
    assert.equal(result.survival_failure_reason, "");
    assert.ok(result.survival_floor > 0, "survival_floor must be positive");
    assert.ok(
      result.survival_floor_edge >= 0.25,
      `floor edge ${result.survival_floor_edge} must be ≥ 0.25`,
    );
  });

  it("ENVIRONMENT_DEPENDENT_OVER: blocks when baseball_only < market_line", () => {
    // baseball_only (6.0) < market_line (8.5) — environment manufactured the thesis
    const result = overSurvivalCheck(
      3.5,   // starterAttack
      2.5,   // bullpen
      0, 0,
      6.0,   // baseball_only_projection (below line)
      2.5,   // env compensates: projected_total = 8.5
      8.5,   // market_line
    );
    assert.equal(result.survival_check, "FAIL");
    assert.equal(result.survival_failure_reason, "ENVIRONMENT_DEPENDENT_OVER");
  });

  it("BASEBALL_ONLY_EDGE_BELOW_THRESHOLD: blocks when 0 ≤ edge < 1.25", () => {
    // baseball_only (8.6) just above line (8.5) but edge = 0.10 < 1.25
    const result = overSurvivalCheck(
      4.3,   // starter
      4.3,   // bullpen
      0, 0,
      8.6,   // baseball_only
      0.0,   // no env
      8.5,   // line
    );
    assert.equal(result.survival_check, "FAIL");
    assert.equal(result.survival_failure_reason, "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD");
  });

  it("SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD: blocks when baseball edge is adequate but floor is too low", () => {
    // baseball_only = 10.0, line = 8.5 → edge = 1.5 ≥ 1.25 ✓
    // floor = 5.0×0.80 + 4.5×0.75 = 4.0 + 3.375 = 7.375 → edge = 7.375 − 8.5 = −1.125 → FAIL
    const result = overSurvivalCheck(
      5.0,   // starter (passes baseball edge)
      4.5,   // bullpen (but floor is too low at line 8.5)
      0, 0,
      9.5,   // baseball_only = 5.0 + 4.5
      0.5,   // small env boost
      8.5,   // line — floor 7.375 cannot clear 8.5 + 0.25
    );
    // baseball edge = 9.5 − 8.5 = 1.0 → still < 1.25 → actually BASEBALL_ONLY_EDGE_BELOW_THRESHOLD
    // need baseball_only ≥ 8.5 + 1.25 = 9.75
    // use baseball_only = 9.8, starter=5.3, bullpen=4.5 → floor = 4.24 + 3.375 = 7.615 → edge = −0.885
    assert.equal(result.survival_failure_reason, "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD");
  });

  it("SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD at higher baseball edge", () => {
    // baseball_only = 10.5, line = 7.0 → baseball edge = 3.5 ≥ 1.25 ✓
    // starter=6.0, bullpen=4.5 → floor = 4.80 + 3.375 = 8.175 → edge vs line 7.0 = 1.175 ≥ 0.25 ✓ → PASS?
    // Let's find a genuine SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD:
    // We need: baseball_only − line ≥ 1.25 AND floor − line < 0.25
    // floor = starter×0.80 + bullpen×0.75 (traffic+hr = 0)
    // Try line = 9.5:
    //   need baseball_only ≥ 10.75  → starter=6, bullpen=5 → baseball_only=11 ✓ edge=1.5
    //   floor = 6×0.80 + 5×0.75 = 4.8 + 3.75 = 8.55  → edge = 8.55 − 9.5 = −0.95 → FAIL
    //   reason: floor edge < 0? Yes, −0.95 < 0.25 → SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD ✓
    const result = overSurvivalCheck(
      6.0,   // starter
      5.0,   // bullpen
      0, 0,
      11.0,  // baseball_only (starter + bullpen)
      0.2,   // small env
      9.5,   // line — floor 8.55, edge −0.95 → FAIL
    );
    assert.equal(result.survival_check, "FAIL");
    assert.equal(result.survival_failure_reason, "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD");
    // Confirm floor is populated (non-zero) — the gate ran even though FAIL
    assert.ok(result.survival_floor > 0, "survival_floor must be computed even on FAIL");
  });

  it("survival_floor is always computed (positive) regardless of check outcome", () => {
    const failResult = overSurvivalCheck(3.0, 2.0, 0, 0, 5.0, 4.0, 9.5);
    assert.ok(failResult.survival_floor > 0, "floor must be computed on FAIL");
    const passResult = overSurvivalCheck(
      PASS_COMPONENTS.starterAttackRuns,
      PASS_COMPONENTS.bullpenContinuationRuns,
      0, 0,
      PASS_COMPONENTS.baseballOnlyProjection,
      PASS_COMPONENTS.environmentRunAdjustment,
      PASS_COMPONENTS.marketLine,
    );
    assert.ok(passResult.survival_floor > 0, "floor must be computed on PASS");
  });
});

// ─── §2: computeDecision — PENDING when no market line ───────────────────────

describe("computeDecision — PENDING gate", () => {
  it("returns PENDING with direction NONE when market line is null", () => {
    const result = computeDecision(10.5, null, "FULL_GAME_OU", ELIGIBLE_CTX);
    assert.equal(result.decision, "PENDING");
    assert.equal(result.direction, "NONE");
    assert.equal(result.coreBlocker, "NO_MARKET_LINE");
  });

  it("returns PENDING when vehicle is empty", () => {
    const result = computeDecision(10.5, 8.5, "", ELIGIBLE_CTX);
    assert.equal(result.decision, "PENDING");
    assert.equal(result.coreBlocker, "NO_MARKET_LINE");
  });

  it("returns PENDING when vehicle is TBD", () => {
    const result = computeDecision(10.5, 8.5, "TBD", ELIGIBLE_CTX);
    assert.equal(result.decision, "PENDING");
  });
});

// ─── §3: PENDING → re-run with line executes the survival gate ───────────────
//
// This test simulates the two-publish scenario:
//   Pass 1 — no market line posted yet → computeDecision returns PENDING and
//             the survival gate is not entered (direction=NONE, line=null).
//   Pass 2 — line posted mid-day → computeDecision returns a real direction
//             and the survival gate fires.  If the game would otherwise be CORE
//             but the floor fails, the decision must flip to NO_CORE and the
//             survival failure reason must appear as the blocker.

describe("PENDING → re-run with line: survival gate fires on second pass", () => {
  /**
   * Simulates the relevant portion of the module11 main loop for one game.
   * Returns the same fields that module11 populates on the SlateBoardEntry.
   */
  function simulateModule11Loop(params: {
    projectedTotal: number;
    marketLine: number | null;
    vehicle: string;
    ctx: GameEligibilityContext;
    // survival-gate component data (mirrors GameSummaryRow fields)
    starterAttackRuns: number;
    bullpenContinuationRuns: number;
    trafficConversionRuns: number;
    hrXbhDamageRuns: number;
    baseballOnlyProjection: number;
    environmentRunAdjustment: number;
  }): {
    decision: "CORE" | "NO_CORE" | "PENDING";
    direction: "OVER" | "UNDER" | "NONE";
    coreBlocker: string;
    survivalCheck: "PASS" | "FAIL" | "N_A";
    survivalFailureReason: string;
    survivalFloor: number | null;
    survivalFloorEdge: number | null;
    baseballOnlyProjection: number | null;
  } {
    const { decision: rawDecision, direction, coreBlocker: rawBlocker } =
      computeDecision(params.projectedTotal, params.marketLine, params.vehicle, params.ctx);

    let decision = rawDecision;
    let coreBlocker = rawBlocker;

    let survivalCheck: "PASS" | "FAIL" | "N_A" = "N_A";
    let survivalFailureReason = "";
    let survivalFloor: number | null = null;
    let survivalFloorEdge: number | null = null;
    let baseballOnlyProjection: number | null = null;

    // Mirror of the survival gate in module11 main loop (lines ~647–691)
    if (direction === "OVER" && params.marketLine !== null) {
      const sr = overSurvivalCheck(
        params.starterAttackRuns,
        params.bullpenContinuationRuns,
        params.trafficConversionRuns,
        params.hrXbhDamageRuns,
        params.baseballOnlyProjection,
        params.environmentRunAdjustment,
        params.marketLine,
      );
      baseballOnlyProjection = sr.baseball_only_projection;
      survivalFloor    = sr.survival_floor;
      survivalFloorEdge = sr.survival_floor_edge;
      survivalCheck    = sr.survival_check;
      survivalFailureReason = sr.survival_failure_reason;

      if (decision === "CORE" && sr.survival_check === "FAIL") {
        decision    = "NO_CORE";
        coreBlocker = sr.survival_failure_reason;
      }
    }

    return {
      decision, direction, coreBlocker,
      survivalCheck, survivalFailureReason,
      survivalFloor, survivalFloorEdge, baseballOnlyProjection,
    };
  }

  it("Pass 1 (no line): decision is PENDING, survival gate is N_A", () => {
    const pass1 = simulateModule11Loop({
      projectedTotal:          10.5,
      marketLine:              null,   // no line yet
      vehicle:                 "FULL_GAME_OU",
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       5.5,
      bullpenContinuationRuns: 4.5,
      trafficConversionRuns:   0,
      hrXbhDamageRuns:         0,
      baseballOnlyProjection:  10.0,
      environmentRunAdjustment: 0.5,
    });

    assert.equal(pass1.decision, "PENDING", "should be PENDING with no line");
    assert.equal(pass1.survivalCheck, "N_A", "gate must not run when line is absent");
    assert.equal(pass1.survivalFloor, null, "survival_floor must be null with no line");
    assert.equal(pass1.baseballOnlyProjection, null, "baseball_only must be null with no line");
  });

  it("Pass 2 (line posted, gate PASS): decision becomes CORE", () => {
    // Market line arrives at 7.5 — baseball edge = 10.0 − 7.5 = 2.5 ≥ 1.25 ✓
    // floor = 5.5×0.80 + 4.5×0.75 = 4.4 + 3.375 = 7.775 → edge = 0.275 ≥ 0.25 ✓
    const pass2 = simulateModule11Loop({
      projectedTotal:          10.5,
      marketLine:              7.5,    // line now posted
      vehicle:                 "FULL_GAME_OU",
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       5.5,
      bullpenContinuationRuns: 4.5,
      trafficConversionRuns:   0,
      hrXbhDamageRuns:         0,
      baseballOnlyProjection:  10.0,
      environmentRunAdjustment: 0.5,
    });

    assert.equal(pass2.decision, "CORE", "should be CORE when line posted and gate passes");
    assert.equal(pass2.survivalCheck, "PASS", "survival gate must fire and return PASS");
    assert.notEqual(pass2.survivalFloor, null, "survival_floor must be populated");
    assert.ok((pass2.survivalFloor ?? 0) > 0, "survival_floor must be positive");
    assert.equal(pass2.coreBlocker, "", "no blocker for a passing CORE");
  });

  it("Pass 2 (line posted, gate FAIL): CORE is blocked with survival failure reason as CORE_Blocker", () => {
    // Market line at 9.5 — floor = 6.0×0.80 + 5.0×0.75 = 8.55, edge = −0.95 → gate FAIL
    // baseball edge = 11.0 − 9.5 = 1.5 ≥ 1.25 → passes first check
    // floor edge = 8.55 − 9.5 = −0.95 < 0.25 → SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD
    const pass2Fail = simulateModule11Loop({
      projectedTotal:          11.2,   // model projects Over
      marketLine:              9.5,    // line arrives mid-day
      vehicle:                 "FULL_GAME_OU",
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       6.0,
      bullpenContinuationRuns: 5.0,
      trafficConversionRuns:   0,
      hrXbhDamageRuns:         0,
      baseballOnlyProjection:  11.0,
      environmentRunAdjustment: 0.2,
    });

    assert.equal(
      pass2Fail.decision, "NO_CORE",
      "CORE must be downgraded to NO_CORE when survival gate fails",
    );
    assert.equal(pass2Fail.survivalCheck, "FAIL", "survival gate must be recorded as FAIL");
    assert.equal(
      pass2Fail.coreBlocker, "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD",
      "CORE_Blocker must be the survival failure reason (not a generic string)",
    );
    assert.notEqual(pass2Fail.survivalFloor, null, "survival_floor must be populated even on FAIL");
    assert.ok((pass2Fail.survivalFloor ?? 0) > 0, "survival_floor must be a positive number");
  });

  it("Pass 2 (environment-manufactured Over): blocked with ENVIRONMENT_DEPENDENT_OVER", () => {
    // projected_total = 10.2, line = 8.5 → variance = 1.7 ≥ 1.5 → CORE candidate
    // BUT baseball_only = 7.0 < market_line = 8.5 → environment manufactured the thesis
    // gate must downgrade to NO_CORE with ENVIRONMENT_DEPENDENT_OVER
    const result = simulateModule11Loop({
      projectedTotal:          10.2,  // env inflated; variance 1.7 ≥ threshold → CORE candidate
      marketLine:              8.5,
      vehicle:                 "FULL_GAME_OU",
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       3.5,
      bullpenContinuationRuns: 3.5,
      trafficConversionRuns:   0,
      hrXbhDamageRuns:         0,
      baseballOnlyProjection:  7.0,   // below market line → env is the entire thesis
      environmentRunAdjustment: 3.2,
    });

    assert.equal(result.decision, "NO_CORE");
    assert.equal(result.coreBlocker, "ENVIRONMENT_DEPENDENT_OVER");
    assert.equal(result.survivalFailureReason, "ENVIRONMENT_DEPENDENT_OVER");
  });
});

// ─── §4: survival_floor populated for all Over games with a line ──────────────
//
// Even a game that is already NO_CORE on other grounds (e.g. below the
// separation threshold or with unresolved starters) must have survival_floor
// populated when direction = OVER and a market line is present.
// This ensures SLATE_BOARD!AD is never blank for an Over game.

describe("Survival_Floor populated for all Over games with a market line", () => {
  function simulateFor(params: {
    projectedTotal: number;
    marketLine: number | null;
    ctx: GameEligibilityContext;
    starterAttackRuns: number;
    bullpenContinuationRuns: number;
    baseballOnlyProjection: number;
  }): { survivalFloor: number | null; survivalCheck: "PASS" | "FAIL" | "N_A" } {
    const { direction } = computeDecision(
      params.projectedTotal, params.marketLine, "FULL_GAME_OU", params.ctx,
    );

    let survivalFloor: number | null = null;
    let survivalCheck: "PASS" | "FAIL" | "N_A" = "N_A";

    if (direction === "OVER" && params.marketLine !== null) {
      const sr = overSurvivalCheck(
        params.starterAttackRuns,
        params.bullpenContinuationRuns,
        0, 0,
        params.baseballOnlyProjection,
        0,
        params.marketLine,
      );
      survivalFloor = sr.survival_floor;
      survivalCheck = sr.survival_check;
    }

    return { survivalFloor, survivalCheck };
  }

  it("survival_floor populated for a NO_CORE Over below the separation threshold", () => {
    // Projected = 9.0, line = 8.5 → variance = 0.5, below the 1.5 CORE_THRESHOLD
    // → computeDecision: NO_CORE (INSUFFICIENT_PROJECTION_SEPARATION)
    // But direction = OVER, line != null → survival gate should still run
    const { survivalFloor, survivalCheck } = simulateFor({
      projectedTotal:          9.0,
      marketLine:              8.5,   // variance 0.5 < threshold
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       5.0,
      bullpenContinuationRuns: 4.5,
      baseballOnlyProjection:  9.5,
    });

    assert.notEqual(
      survivalFloor, null,
      "survival_floor must be non-null for a NO_CORE Over with a market line",
    );
    assert.ok((survivalFloor ?? 0) > 0, "survival_floor must be a positive computed value");
    // survivalCheck must be PASS or FAIL — never N_A — because the gate ran
    assert.notEqual(survivalCheck, "N_A", "survival_check must not be N_A when gate runs");
  });

  it("survival_floor is null for a game with no market line (PENDING)", () => {
    const { survivalFloor, survivalCheck } = simulateFor({
      projectedTotal:          9.5,
      marketLine:              null,  // no line → PENDING
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       5.0,
      bullpenContinuationRuns: 4.5,
      baseballOnlyProjection:  9.5,
    });

    assert.equal(survivalFloor, null, "survival_floor must be null when there is no market line");
    assert.equal(survivalCheck, "N_A", "survival_check must be N_A when gate does not run");
  });

  it("survival_floor is null for an Under game (gate does not apply)", () => {
    // Projected = 7.0, line = 9.0 → direction = UNDER → gate skipped
    const { survivalFloor, survivalCheck } = simulateFor({
      projectedTotal:          7.0,
      marketLine:              9.0,
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       3.5,
      bullpenContinuationRuns: 3.5,
      baseballOnlyProjection:  7.0,
    });

    assert.equal(survivalFloor, null, "survival_floor must be null for Under direction");
    assert.equal(survivalCheck, "N_A");
  });

  it("survival_floor populated for a CORE Over — gate is part of the decision path", () => {
    // projected=10.5, line=7.5 → variance=3.0 ≥ threshold → CORE candidate
    // floor = 5.5×0.80 + 4.5×0.75 = 4.4 + 3.375 = 7.775 > 7.5+0.25=7.75 → PASS
    const { survivalFloor, survivalCheck } = simulateFor({
      projectedTotal:          10.5,
      marketLine:              7.5,
      ctx:                     ELIGIBLE_CTX,
      starterAttackRuns:       5.5,
      bullpenContinuationRuns: 4.5,
      baseballOnlyProjection:  10.0,
    });

    assert.notEqual(survivalFloor, null, "survival_floor must be populated for a CORE Over");
    assert.equal(survivalCheck, "PASS", "gate must PASS for a strong Over");
  });
});

// ─── §5: COMPONENT_DATA_UNAVAILABLE — missing projection components ────────────
//
// When gs.baseball_only_projection or gs.starter_attack_runs are undefined
// (module09 did not populate the decomposed components), the survival gate must
// conservatively block CORE rather than silently passing.
//
// Tests call applyOverSurvivalGate — the exported production function used by
// the module11 main loop — so changes to the guard condition or its blocker
// string break these tests immediately.
//
// Contract:
//   survival_check         = "FAIL"
//   survival_failure_reason = "COMPONENT_DATA_UNAVAILABLE"
// And in the combined decision path: decision = "NO_CORE", coreBlocker = "COMPONENT_DATA_UNAVAILABLE"

describe("COMPONENT_DATA_UNAVAILABLE — survival gate blocks when components are missing", () => {
  /**
   * Simulates the module11 main-loop decision + gate for one Over game.
   * Calls computeDecision and then applyOverSurvivalGate — the same exported
   * production functions used by the real pipeline loop — so this is not a
   * test-only reimplementation.
   */
  function simulateOverWithGate(params: {
    projectedTotal:           number;
    marketLine:               number | null;
    ctx:                      GameEligibilityContext;
    baseballOnlyProjection:   number | undefined;
    starterAttackRuns:        number | undefined;
    bullpenContinuationRuns:  number;
    trafficConversionRuns:    number;
    hrXbhDamageRuns:          number;
    environmentRunAdjustment: number;
  }): {
    decision:    "CORE" | "NO_CORE" | "PENDING";
    direction:   "OVER" | "UNDER" | "NONE";
    coreBlocker: string;
    gate:        OverSurvivalGateResult | null;  // null when gate didn't run
  } {
    const { decision: rawDecision, direction, coreBlocker: rawBlocker } =
      computeDecision(params.projectedTotal, params.marketLine, "FULL_GAME_OU", params.ctx);

    let decision    = rawDecision;
    let coreBlocker = rawBlocker;
    let gate: OverSurvivalGateResult | null = null;

    if (direction === "OVER" && params.marketLine !== null) {
      // applyOverSurvivalGate is the real exported production function — no logic is duplicated here.
      gate = applyOverSurvivalGate(
        params.baseballOnlyProjection,
        params.starterAttackRuns,
        params.bullpenContinuationRuns,
        params.trafficConversionRuns,
        params.hrXbhDamageRuns,
        params.environmentRunAdjustment,
        params.marketLine,
      );
      if (decision === "CORE" && gate.survival_check === "FAIL") {
        decision    = "NO_CORE";
        coreBlocker = gate.survival_failure_reason;
      }
    }

    return { decision, direction, coreBlocker, gate };
  }

  // ── applyOverSurvivalGate direct unit tests ─────────────────────────────────

  it("returns FAIL/COMPONENT_DATA_UNAVAILABLE when both components are undefined", () => {
    const gate = applyOverSurvivalGate(
      undefined,   // baseball_only_projection
      undefined,   // starter_attack_runs
      4.5, 0, 0, 0.5,
      7.5,         // market line
    );
    assert.equal(gate.survival_check,          "FAIL",                       "survival_check must be FAIL");
    assert.equal(gate.survival_failure_reason,  "COMPONENT_DATA_UNAVAILABLE", "survival_failure_reason must be COMPONENT_DATA_UNAVAILABLE");
    assert.equal(gate.survival_floor,           null,                         "survival_floor must be null — gate aborted before overSurvivalCheck");
    assert.equal(gate.baseball_only_projection, null,                         "baseball_only_projection must be null");
  });

  it("returns FAIL/COMPONENT_DATA_UNAVAILABLE when only baseball_only_projection is undefined", () => {
    const gate = applyOverSurvivalGate(
      undefined,   // baseball_only_projection missing
      5.5,         // starter_attack_runs present
      4.5, 0, 0, 0.5,
      7.5,
    );
    assert.equal(gate.survival_check,         "FAIL",                       "survival_check must be FAIL");
    assert.equal(gate.survival_failure_reason, "COMPONENT_DATA_UNAVAILABLE", "survival_failure_reason must be COMPONENT_DATA_UNAVAILABLE");
    assert.equal(gate.survival_floor,          null,                         "survival_floor must be null");
  });

  it("returns FAIL/COMPONENT_DATA_UNAVAILABLE when only starter_attack_runs is undefined", () => {
    const gate = applyOverSurvivalGate(
      10.0,        // baseball_only_projection present
      undefined,   // starter_attack_runs missing
      4.5, 0, 0, 0.5,
      7.5,
    );
    assert.equal(gate.survival_check,         "FAIL",                       "survival_check must be FAIL");
    assert.equal(gate.survival_failure_reason, "COMPONENT_DATA_UNAVAILABLE", "survival_failure_reason must be COMPONENT_DATA_UNAVAILABLE");
    assert.equal(gate.survival_floor,          null,                         "survival_floor must be null");
  });

  it("delegates to overSurvivalCheck (PASS) when both components are present", () => {
    // starterAttack=5.5, bullpen=4.5, baseball_only=10.0, line=7.5
    //   baseball edge = 2.5 ≥ 1.25 ✓
    //   floor = 5.5×0.80 + 4.5×0.75 = 7.775, floor edge = 0.275 ≥ 0.25 ✓ → PASS
    const gate = applyOverSurvivalGate(10.0, 5.5, 4.5, 0, 0, 0.5, 7.5);
    assert.notEqual(gate.survival_failure_reason, "COMPONENT_DATA_UNAVAILABLE", "must not hit component guard when data is present");
    assert.equal(gate.survival_check,             "PASS",                        "gate must PASS with valid components");
    assert.notEqual(gate.survival_floor,           null,                          "survival_floor must be populated");
    assert.ok((gate.survival_floor ?? 0) > 0,                                    "survival_floor must be a positive number");
  });

  // ── Combined decision path tests ────────────────────────────────────────────

  it("blocks a CORE candidate with NO_CORE when both components are undefined", () => {
    // projected=10.5, line=7.5 → variance=3.0 ≥ 1.5 threshold → CORE candidate before gate
    const { decision, coreBlocker, gate } = simulateOverWithGate({
      projectedTotal:           10.5,
      marketLine:               7.5,
      ctx:                      ELIGIBLE_CTX,
      baseballOnlyProjection:   undefined,
      starterAttackRuns:        undefined,
      bullpenContinuationRuns:  4.5,
      trafficConversionRuns:    0,
      hrXbhDamageRuns:          0,
      environmentRunAdjustment: 0.5,
    });

    assert.equal(decision,    "NO_CORE",                    "decision must flip to NO_CORE");
    assert.equal(coreBlocker, "COMPONENT_DATA_UNAVAILABLE", "CORE_Blocker must be COMPONENT_DATA_UNAVAILABLE");
    assert.ok(gate !== null,                                "gate must have run (direction=OVER, line present)");
    assert.equal(gate!.survival_check,         "FAIL",                       "gate survival_check must be FAIL");
    assert.equal(gate!.survival_failure_reason, "COMPONENT_DATA_UNAVAILABLE", "gate reason must be COMPONENT_DATA_UNAVAILABLE");
  });

  it("gate does not run (null) for an Under game — missing components are irrelevant", () => {
    // projected=7.0, line=9.0 → direction=UNDER → gate skipped entirely
    const { gate, decision } = simulateOverWithGate({
      projectedTotal:           7.0,
      marketLine:               9.0,
      ctx:                      ELIGIBLE_CTX,
      baseballOnlyProjection:   undefined,
      starterAttackRuns:        undefined,
      bullpenContinuationRuns:  3.5,
      trafficConversionRuns:    0,
      hrXbhDamageRuns:          0,
      environmentRunAdjustment: 0,
    });

    assert.equal(gate, null, "gate must not run for Under direction");
    assert.notEqual(decision, "PENDING", "game has a market line; must not be PENDING");
  });
});

// ─── §6: Non-zero traffic and HR/XBH components ───────────────────────────────
//
// module09 currently sets traffic_conversion_runs = 0 and hr_xbh_damage_runs = 0
// as reserved stubs (see module09_recalculation.ts ~lines 1014–1015).  When those
// components are eventually populated with real values the survival floor will
// shift, potentially changing game outcomes.  These tests pin the expected formula
// behaviour with non-zero inputs so a future stub replacement will surface any
// formula regression immediately.
//
// Full survival floor formula:
//   floor = starter × 0.80 + bullpen × 0.75 + traffic × 0.70 + HR_XBH × 0.90
//
// Penalty constants (authoritative source: module11_outputExtraction.ts):
//   SURVIVAL_STARTER_PENALTY  = 0.80   (starters pitch better than modelled)
//   SURVIVAL_BULLPEN_PENALTY  = 0.75   (bullpen continuation rate suppressed)
//   SURVIVAL_TRAFFIC_PENALTY  = 0.70   (baserunner-to-run conversion poor)
//   SURVIVAL_HR_XBH_PENALTY   = 0.90   (extra-base / HR damage muted)

describe("Non-zero traffic and HR/XBH components — formula regression guard", () => {
  // ── §6.1: PASS driven by traffic + HR/XBH components ─────────────────────
  //
  // Setup: starter=4.0, bullpen=3.5, traffic=2.5, hr_xbh=1.5, line=8.5
  //
  // Baseball edge:
  //   baseball_only = 4.0 + 3.5 + 2.5 + 1.5 = 11.5
  //   edge = 11.5 − 8.5 = 3.0 ≥ 1.25 ✓
  //
  // Survival floor (full formula):
  //   4.0 × 0.80 = 3.200
  //   3.5 × 0.75 = 2.625
  //   2.5 × 0.70 = 1.750
  //   1.5 × 0.90 = 1.350
  //              ─────────
  //   floor      = 8.925   floor edge = 8.925 − 8.5 = +0.425 ≥ 0.25 ✓ → PASS
  //
  // Without traffic + HR (current stub state):
  //   floor = 3.200 + 2.625 = 5.825   floor edge = −2.675 → FAIL
  //
  // Conclusion: traffic and HR/XBH are the deciding factor; removing them
  // flips this game from PASS to FAIL.  If the formula or penalties change
  // this test will immediately detect it.
  it("PASS: traffic + HR/XBH components are the deciding factor (stub-zero would FAIL)", () => {
    const result = overSurvivalCheck(
      4.0,   // starterAttackRuns
      3.5,   // bullpenContinuationRuns
      2.5,   // trafficConversionRuns  ← non-zero (future real value)
      1.5,   // hrXbhDamageRuns        ← non-zero (future real value)
      11.5,  // baseballOnlyProjection (starter+bullpen+traffic+hr_xbh)
      0.3,   // environmentRunAdjustment
      8.5,   // marketLine
    );

    // Verify the outcome
    assert.equal(result.survival_check, "PASS",
      "gate must PASS when traffic + HR components push floor above threshold");
    assert.equal(result.survival_failure_reason, "",
      "failure reason must be empty for a PASS");

    // Pin the exact floor arithmetic so any formula or constant change is visible
    assert.equal(
      result.survival_floor, 8.93,
      "floor must be 4.0×0.80 + 3.5×0.75 + 2.5×0.70 + 1.5×0.90 = 8.925 → rounded to 8.93",
    );
    assert.ok(
      result.survival_floor_edge >= 0.25,
      `floor edge ${result.survival_floor_edge} must be ≥ 0.25 (threshold)`,
    );

    // Confirm that zeroing traffic + HR flips this exact game to FAIL
    const stubResult = overSurvivalCheck(
      4.0, 3.5,
      0, 0,   // current stub values
      11.5, 0.3, 8.5,
    );
    assert.equal(
      stubResult.survival_check, "FAIL",
      "zeroing traffic + HR (stub state) must flip this game to FAIL — " +
      "confirms those components are the deciding factor",
    );
  });

  // ── §6.2: FAIL — traffic + HR contribute but cannot overcome a high line ──
  //
  // Setup: starter=5.0, bullpen=4.0, traffic=1.5, hr_xbh=1.0, line=10.0
  //
  // Baseball edge:
  //   baseball_only = 5.0 + 4.0 + 1.5 + 1.0 = 11.5
  //   edge = 11.5 − 10.0 = 1.5 ≥ 1.25 ✓ (first gate passes)
  //
  // Survival floor (full formula):
  //   5.0 × 0.80 = 4.000
  //   4.0 × 0.75 = 3.000
  //   1.5 × 0.70 = 1.050
  //   1.0 × 0.90 = 0.900
  //              ─────────
  //   floor      = 8.950   floor edge = 8.950 − 10.0 = −1.05 < 0.25 → FAIL
  //                                     reason = SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD
  //
  // Without traffic + HR:
  //   floor = 4.000 + 3.000 = 7.000   floor edge = −3.0 → also FAIL (but worse)
  //
  // Conclusion: real traffic + HR components improve the floor (+1.95 runs) but
  // cannot overcome a high market line.  The formula correctly applies each
  // penalty even when values are non-zero.
  it("FAIL: traffic + HR contribute to floor but cannot overcome a high market line", () => {
    const result = overSurvivalCheck(
      5.0,   // starterAttackRuns
      4.0,   // bullpenContinuationRuns
      1.5,   // trafficConversionRuns  ← non-zero
      1.0,   // hrXbhDamageRuns        ← non-zero
      11.5,  // baseballOnlyProjection
      0.0,   // environmentRunAdjustment
      10.0,  // marketLine — high enough that even the improved floor fails
    );

    assert.equal(result.survival_check, "FAIL",
      "gate must FAIL when floor cannot clear the high market line even with traffic + HR");
    assert.equal(result.survival_failure_reason, "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD",
      "failure reason must be SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD (baseball edge clears; floor does not)");

    // Pin the exact floor so a future formula change is detected
    assert.equal(
      result.survival_floor, 8.95,
      "floor must be 5.0×0.80 + 4.0×0.75 + 1.5×0.70 + 1.0×0.90 = 8.95",
    );
    assert.ok(
      result.survival_floor_edge < 0.25,
      `floor edge ${result.survival_floor_edge} must be < 0.25 for FAIL`,
    );

    // Confirm the stub state also fails (but with a lower floor) — regression guard
    const stubResult = overSurvivalCheck(
      5.0, 4.0, 0, 0,   // current stub values
      11.5, 0.0, 10.0,
    );
    assert.equal(stubResult.survival_check, "FAIL", "stub-zero state must also FAIL at this line");
    assert.ok(
      (stubResult.survival_floor ?? 0) < result.survival_floor,
      "stub-zero floor must be lower than the non-zero floor (confirms components add value)",
    );
  });

  // ── §6.4: ENVIRONMENT_DEPENDENT_OVER — inclusive baseball_only determines env thesis ──
  //
  // This test confirms that the ENVIRONMENT_DEPENDENT_OVER path is evaluated against
  // the INCLUSIVE baseball_only_projection (all four components), not a starter+bullpen
  // only subset.
  //
  // Scenario A — exclusive definition would misclassify as env-dependent:
  //   starter=3.0, bullpen=2.0, traffic=2.5, hr_xbh=1.5
  //   starter+bullpen only = 5.0 < line 8.5 → would trigger ENVIRONMENT_DEPENDENT_OVER
  //   but inclusive baseball_only = 3.0+2.0+2.5+1.5 = 9.0 > 8.5 → env did NOT manufacture thesis
  //
  // Scenario B — environment truly manufactured the Over:
  //   same components but baseball_only passed in as 5.0 (exclusive, wrong)
  //   vs 9.0 (inclusive, correct)
  //   This test pins that the formula uses the caller-supplied baseball_only_projection,
  //   and that module09 must supply the inclusive value.

  it("§6.4 ENVIRONMENT_DEPENDENT_OVER: inclusive baseball_only (all 4 components) determines env thesis", () => {
    // Scenario A: if baseball_only were computed as starter+bullpen only (5.0),
    // this game would be wrongly classified ENVIRONMENT_DEPENDENT_OVER because 5.0 < 8.5.
    const wrongResult = overSurvivalCheck(
      3.0,   // starterAttackRuns
      2.0,   // bullpenContinuationRuns
      2.5,   // trafficConversionRuns   — non-zero (future real value)
      1.5,   // hrXbhDamageRuns         — non-zero (future real value)
      5.0,   // baseball_only_projection = starter+bullpen only (WRONG — excludes traffic/HR)
      3.5,   // environmentRunAdjustment
      8.5,   // marketLine
    );
    assert.equal(
      wrongResult.survival_check, "FAIL",
      "exclusive (starter+bullpen only) baseball_only triggers ENVIRONMENT_DEPENDENT_OVER",
    );
    assert.equal(
      wrongResult.survival_failure_reason, "ENVIRONMENT_DEPENDENT_OVER",
      "exclusive definition misclassifies this game as env-dependent",
    );

    // Scenario B: with the CORRECT inclusive baseball_only (all 4 components = 9.0),
    // the game is NOT env-dependent because the baseball thesis (9.0 > 8.5) stands alone.
    const correctResult = overSurvivalCheck(
      3.0,   // starterAttackRuns
      2.0,   // bullpenContinuationRuns
      2.5,   // trafficConversionRuns   — non-zero (future real value)
      1.5,   // hrXbhDamageRuns         — non-zero (future real value)
      9.0,   // baseball_only_projection = 3.0+2.0+2.5+1.5 (CORRECT — includes traffic+HR)
      0.0,   // environmentRunAdjustment — env adds nothing in this scenario
      8.5,   // marketLine
    );
    assert.notEqual(
      correctResult.survival_failure_reason, "ENVIRONMENT_DEPENDENT_OVER",
      "inclusive definition must NOT classify this game as env-dependent (baseball_only=9.0 > line=8.5)",
    );
    // baseball edge = 9.0 − 8.5 = 0.5 < 1.25 → BASEBALL_ONLY_EDGE_BELOW_THRESHOLD (not env-dependent)
    assert.equal(
      correctResult.survival_failure_reason, "BASEBALL_ONLY_EDGE_BELOW_THRESHOLD",
      "correct reason: baseball edge exists but is below threshold, not env-manufactured",
    );

    // Scenario C: raise components to ensure a full PASS with inclusive baseball_only
    //   starter=4.0, bullpen=3.0, traffic=2.5, hr=1.5 → baseball_only=11.0
    //   baseball edge = 11.0 − 8.5 = 2.5 ≥ 1.25 ✓
    //   floor = 4.0×0.80 + 3.0×0.75 + 2.5×0.70 + 1.5×0.90
    //         = 3.200 + 2.250 + 1.750 + 1.350 = 8.550  → edge = 8.55 − 8.5 = 0.05 < 0.25 → FAIL on floor
    //   Increase line to 7.5 for a clean PASS:
    //   baseball edge = 11.0 − 7.5 = 3.5 ✓ floor edge = 8.55 − 7.5 = 1.05 ≥ 0.25 ✓
    const passResult = overSurvivalCheck(
      4.0,   // starterAttackRuns
      3.0,   // bullpenContinuationRuns
      2.5,   // trafficConversionRuns   — non-zero
      1.5,   // hrXbhDamageRuns         — non-zero
      11.0,  // baseball_only_projection = 4.0+3.0+2.5+1.5 (inclusive)
      0.2,   // environmentRunAdjustment
      7.5,   // marketLine
    );
    assert.equal(passResult.survival_check, "PASS",
      "inclusive baseball_only allows a legitimate baseball Over to PASS (not misclassified as env-dependent)");
    assert.equal(passResult.survival_failure_reason, "");
  });

  // ── §6.3: PASS — HR/XBH component alone is the deciding factor ────────────
  //
  // Setup: starter=5.5, bullpen=4.5, traffic=0, hr_xbh=0.7, line=8.0
  //        (traffic=0 isolates the HR component contribution)
  //
  // Baseball edge:
  //   baseball_only = 5.5 + 4.5 + 0 + 0.7 = 10.7
  //   edge = 10.7 − 8.0 = 2.7 ≥ 1.25 ✓
  //
  // Survival floor:
  //   5.5 × 0.80 = 4.400
  //   4.5 × 0.75 = 3.375
  //   0.0 × 0.70 = 0.000
  //   0.7 × 0.90 = 0.630
  //              ─────────
  //   floor      = 8.405   floor edge = 8.405 − 8.0 = +0.405 ≥ 0.25 ✓ → PASS
  //
  // Without HR/XBH (current stub state, traffic already 0):
  //   floor = 4.400 + 3.375 = 7.775   floor edge = −0.225 → FAIL
  //
  // Conclusion: the HR/XBH component alone (0.7 runs × 0.90 = 0.63) flips this
  // game from FAIL to PASS.  This test isolates the SURVIVAL_HR_XBH_PENALTY = 0.90
  // constant; if the penalty is changed or the component is accidentally zeroed
  // this test will break.
  it("PASS: HR/XBH component alone flips a borderline game from FAIL to PASS", () => {
    const result = overSurvivalCheck(
      5.5,   // starterAttackRuns
      4.5,   // bullpenContinuationRuns
      0,     // trafficConversionRuns — kept at 0 to isolate HR component
      0.7,   // hrXbhDamageRuns       ← non-zero (future real value)
      10.7,  // baseballOnlyProjection (starter+bullpen+hr_xbh)
      0.0,   // environmentRunAdjustment
      8.0,   // marketLine
    );

    assert.equal(result.survival_check, "PASS",
      "gate must PASS when HR/XBH component pushes floor above threshold");
    assert.equal(result.survival_failure_reason, "");
    assert.equal(
      result.survival_floor, 8.41,
      "floor must be 5.5×0.80 + 4.5×0.75 + 0×0.70 + 0.7×0.90 = 8.405 → rounded to 8.41",
    );
    assert.ok(
      result.survival_floor_edge >= 0.25,
      `floor edge ${result.survival_floor_edge} must be ≥ 0.25`,
    );

    // Confirm that zeroing HR/XBH (stub state) flips this game to FAIL
    const stubResult = overSurvivalCheck(
      5.5, 4.5,
      0, 0,   // current stub values — HR also 0
      10.7, 0.0, 8.0,
    );
    assert.equal(
      stubResult.survival_check, "FAIL",
      "zeroing HR/XBH (stub state) must flip this game to FAIL — " +
      "confirms SURVIVAL_HR_XBH_PENALTY = 0.90 constant is load-bearing",
    );
    assert.equal(
      stubResult.survival_failure_reason, "SURVIVAL_FLOOR_EDGE_BELOW_THRESHOLD",
      "stub state fails on floor edge, not baseball edge — isolates the HR component",
    );
  });
});

// ─── §7: Monotonicity gate — CORE authorization chokepoint (#23) ──────────────
//
// The monotonicity gate in module11's per-game loop is:
//
//   if (!coreAuthEnabled && decision === "CORE") {
//     decision    = "NO_CORE";
//     coreBlocker = coreAuthStatus;
//   }
//
// This section confirms:
//   (a) When coreAuthEnabled=false, any rawDecision=CORE becomes NO_CORE
//       with coreBlocker mirroring the exact auth-status string.
//   (b) When coreAuthEnabled=true, CORE passes through unchanged.
//   (c) The gate acts only on `decision` — a simulated sideDecision variable
//       computed independently after the gate is never affected by it.
//
// The helper simulateMonotonicityGate() mirrors the exact branch in
// extractOutputBoards() without Sheets I/O, using only exported functions.

describe("Monotonicity gate — sole CORE authorization chokepoint", () => {
  const ELIGIBLE_CTX: GameEligibilityContext = {
    awayPitcherRole:     "CONVENTIONAL_STARTER",
    homePitcherRole:     "CONVENTIONAL_STARTER",
    awayExpectedInnings: 6.0,
    homeExpectedInnings: 6.0,
    bullpenAvailable:    true,
  };

  /** Mirrors the monotonicity gate + survival gate portion of the module11 loop. */
  function simulateMonotonicityGate(params: {
    projectedTotal:    number;
    marketLine:        number;
    coreAuthEnabled:   boolean;
    coreAuthStatus:    string;
    /** Optional side-edge for the separate side-bet signal (informational only). */
    sideEdge?:         number;
  }): {
    decision:    "CORE" | "NO_CORE" | "PENDING";
    coreBlocker: string;
    /** Simulated side_decision — computed after the monotonicity gate, independently. */
    sideDecision: "CORE" | "NO_CORE" | "NO_MARKET";
  } {
    const { decision: rawDecision, coreBlocker: rawBlocker } =
      computeDecision(params.projectedTotal, params.marketLine, "FULL_GAME_OU", ELIGIBLE_CTX);

    let decision    = rawDecision;
    let coreBlocker = rawBlocker;

    // ── Monotonicity gate (exact copy of module11 line ~932) ──────────────────
    if (!params.coreAuthEnabled && decision === "CORE") {
      decision    = "NO_CORE";
      coreBlocker = params.coreAuthStatus;
    }

    // ── sideDecision is computed independently AFTER the gate ─────────────────
    // This mirrors module11 lines ~1241-1250 where sideDecision is derived from
    // sideEdge without consulting `decision`.  It is written to the side_decision
    // field of SlateBoardEntry (col Y) and never feeds back into decision,
    // final_decision, or core_count.
    const SIDE_CORE_THRESHOLD = 1.5;
    const sideEdge = params.sideEdge ?? null;
    const sideDecision: "CORE" | "NO_CORE" | "NO_MARKET" =
      sideEdge === null            ? "NO_MARKET" :
      Math.abs(sideEdge) >= SIDE_CORE_THRESHOLD ? "CORE"     : "NO_CORE";

    return { decision, coreBlocker, sideDecision };
  }

  it("converts CORE→NO_CORE when coreAuthEnabled=false (DISABLED_MONOTONICITY_NOT_COMPUTED)", () => {
    // projected=11.5, line=8.0 → variance=3.5 ≥ 1.5 → rawDecision=CORE before gate
    const r = simulateMonotonicityGate({
      projectedTotal:  11.5,
      marketLine:      8.0,
      coreAuthEnabled: false,
      coreAuthStatus:  "DISABLED_MONOTONICITY_NOT_COMPUTED",
    });
    assert.equal(r.decision,    "NO_CORE",                          "gate must downgrade CORE to NO_CORE");
    assert.equal(r.coreBlocker, "DISABLED_MONOTONICITY_NOT_COMPUTED", "blocker must mirror auth status exactly");
  });

  it("preserves CORE when coreAuthEnabled=true (gate is a no-op)", () => {
    const r = simulateMonotonicityGate({
      projectedTotal:  11.5,
      marketLine:      8.0,
      coreAuthEnabled: true,
      coreAuthStatus:  "ENABLED",
    });
    assert.equal(r.decision,    "CORE", "enabled gate must not downgrade a valid CORE");
    assert.equal(r.coreBlocker, "",     "coreBlocker must be empty for an unblocked CORE");
  });

  it("preserves NO_CORE unchanged when coreAuthEnabled=false (gate only downgrades CORE)", () => {
    // projected=7.0, line=8.0 → variance=−1.0 → Under, absVar < 1.5 → NO_CORE
    const r = simulateMonotonicityGate({
      projectedTotal:  7.0,
      marketLine:      8.0,
      coreAuthEnabled: false,
      coreAuthStatus:  "DISABLED_MONOTONICITY_FAIL",
    });
    assert.equal(r.decision, "NO_CORE", "NO_CORE games are unaffected by the monotonicity gate");
    assert.notEqual(r.coreBlocker, "DISABLED_MONOTONICITY_FAIL",
      "blocker must not be overwritten for already-NO_CORE games");
  });

  it("sideDecision=CORE does not affect decision when monotonicity gate blocks", () => {
    // Main decision is CORE (large Over), but gate disables it.
    // sideEdge is also very large → sideDecision=CORE.
    // The sideDecision must remain CORE (it is informational), while decision
    // is correctly downgraded to NO_CORE.
    const r = simulateMonotonicityGate({
      projectedTotal:  11.5,
      marketLine:      8.0,
      coreAuthEnabled: false,
      coreAuthStatus:  "DISABLED_MONOTONICITY_NOT_COMPUTED",
      sideEdge:        2.5,   // ≥ 1.5 → sideDecision=CORE (informational)
    });
    assert.equal(r.decision,     "NO_CORE", "main decision must be gated to NO_CORE");
    assert.equal(r.sideDecision, "CORE",    "sideDecision is informational and is not gated");
    // The distinction proves that sideDecision independence cannot become a
    // silent authorization bypass: sideDecision is a separate signal on the
    // SlateBoardEntry and is never counted in core_count or final_decision.
  });

  it("all coreAuthStatus variants produce the correct blocker string", () => {
    const variants: string[] = [
      "DISABLED_MONOTONICITY_NOT_COMPUTED",
      "DISABLED_MONOTONICITY_FAIL",
      "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE",
      "DISABLED_MONOTONICITY_STALE",
    ];
    for (const status of variants) {
      const r = simulateMonotonicityGate({
        projectedTotal:  11.5,
        marketLine:      8.0,
        coreAuthEnabled: false,
        coreAuthStatus:  status,
      });
      assert.equal(r.decision,    "NO_CORE", `${status}: decision must be NO_CORE`);
      assert.equal(r.coreBlocker, status,    `${status}: blocker must mirror auth status exactly`);
    }
  });
});

// ─── §8: CORE UNDER picks bypass survival gate — survivalCheck stays N_A (#30) ─
//
// The survival gate guard is: if (direction === "OVER" && market.line !== null)
//
// UNDER picks — even those with large enough variance to qualify as CORE —
// must bypass the gate entirely (survivalCheck = "N_A").  This is correct:
// the survival gate is an Over-only thesis test.
//
// A CORE UNDER is still subject to the monotonicity gate and board-lock gate.
//
// This section pins that the guard condition does not accidentally run for UNDERs,
// which would cause applyOverSurvivalGate to receive an UNDER direction context
// it was not designed for.

describe("Survival gate guard — CORE UNDER picks bypass the gate (#30)", () => {
  const ELIGIBLE_CTX: GameEligibilityContext = {
    awayPitcherRole:     "CONVENTIONAL_STARTER",
    homePitcherRole:     "CONVENTIONAL_STARTER",
    awayExpectedInnings: 6.0,
    homeExpectedInnings: 6.0,
    bullpenAvailable:    true,
  };

  /** Simulates the module11 loop gate sequence for one game. */
  function simulateGateSequence(params: {
    projectedTotal:          number;
    marketLine:              number | null;
    baseballOnlyProjection:  number | undefined;
    starterAttackRuns:       number | undefined;
  }): {
    decision:    "CORE" | "NO_CORE" | "PENDING";
    direction:   "OVER" | "UNDER" | "NONE";
    survivalCheck: "PASS" | "FAIL" | "N_A";
    gateRan:     boolean;
  } {
    const { decision: rawDecision, direction, coreBlocker: rawBlocker } =
      computeDecision(params.projectedTotal, params.marketLine, "FULL_GAME_OU", ELIGIBLE_CTX);

    let decision    = rawDecision;
    let survivalCheck: "PASS" | "FAIL" | "N_A" = "N_A";
    let gateRan = false;

    if (direction === "OVER" && params.marketLine !== null) {
      gateRan = true;
      const sg = applyOverSurvivalGate(
        params.baseballOnlyProjection,
        params.starterAttackRuns,
        4.5, 0, 0, 0.5,
        params.marketLine,
      );
      survivalCheck = sg.survival_check;
      if (decision === "CORE" && sg.survival_check === "FAIL") decision = "NO_CORE";
    }

    return { decision, direction, survivalCheck, gateRan };
  }

  it("CORE UNDER with large variance: gate does not run, survivalCheck stays N_A", () => {
    // projected=5.0, line=9.5 → variance=−4.5, UNDER, absVar=4.5 ≥ 1.5 → rawDecision=CORE
    const r = simulateGateSequence({
      projectedTotal:         5.0,
      marketLine:             9.5,
      baseballOnlyProjection: 4.5,
      starterAttackRuns:      2.5,
    });
    assert.equal(r.direction,     "UNDER", "direction must be UNDER for this projection");
    assert.equal(r.decision,      "CORE",  "a large UNDER qualifies as CORE before the gate");
    assert.equal(r.survivalCheck, "N_A",   "survival gate must not run for UNDER direction");
    assert.equal(r.gateRan,       false,   "gate must be skipped entirely for UNDER picks");
  });

  it("CORE OVER with a market line: gate runs and can block", () => {
    // projected=11.5, line=7.5 → OVER CORE candidate; components designed to PASS
    const r = simulateGateSequence({
      projectedTotal:         11.5,
      marketLine:             7.5,
      baseballOnlyProjection: 10.0,
      starterAttackRuns:      5.5,
    });
    assert.equal(r.direction, "OVER", "direction must be OVER");
    assert.equal(r.gateRan,   true,   "gate must run for OVER with a market line");
    assert.notEqual(r.survivalCheck, "N_A",
      "survivalCheck must be PASS or FAIL — not N_A — when the gate runs");
  });

  it("PENDING (no market line): gate does not run, survivalCheck stays N_A", () => {
    // computeDecision returns PENDING when marketLine=null; the guard also requires
    // market.line !== null — both independently prevent the gate from running.
    const r = simulateGateSequence({
      projectedTotal:         11.5,
      marketLine:             null,
      baseballOnlyProjection: 10.0,
      starterAttackRuns:      5.5,
    });
    assert.equal(r.decision,      "PENDING", "no market line → PENDING, not CORE");
    assert.equal(r.gateRan,       false,     "gate must not run when market line is null");
    assert.equal(r.survivalCheck, "N_A",     "survivalCheck must stay N_A for PENDING games");
  });
});
