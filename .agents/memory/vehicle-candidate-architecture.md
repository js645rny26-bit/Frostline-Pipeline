---
name: Vehicle Candidate Shadow Architecture
description: Doctrine constraints, interface contract, and commissioning gates for the shadow vehicle-selection system built in Task #72.
---

# Vehicle Candidate Shadow Architecture

## Rule
Vehicle type determines which gates apply; it never creates preference, safety, or tiebreak priority. Ranking uses only evaluated candidate attributes.

**Why:** The doctrine explicitly rejects universal vehicle-type hierarchies. Any comparator that uses the vehicle label as a criterion or tiebreaker re-encodes the hierarchy we are trying to eliminate.

**How to apply:** The comparator in `rankViableVehicles` must read only the ten doctrine fields (scriptCapture, failureModeBurden, conversionBurden, timingDependence, workloadDependence, plateAppearanceDependence, bullpenDependence, runAllocationDependence, stability, dataCompleteness). True ties return 0 — stable input order preserved, no vehicle-type fallback.

## Four-state evaluation
`VehicleEvaluationStatus`: VIABLE / NOT_VIABLE / NOT_EVALUABLE / UNAVAILABLE.
Missing data freezes only the affected vehicle; siblings remain independently evaluable.

## Current NOT_EVALUABLE vehicles
TEAM_TOTAL_*, MONEYLINE, RUN_LINE, STARTER_OUTS_UNDER, STARTER_ER_OVER, STARTER_HITS_OVER — all require vehicle-specific projections not yet commissioned. Blocker: `VEHICLE_PROJECTION_UNAVAILABLE`.

## Opener/bulk rule
FULL_GAME_UNDER is NOT_EVALUABLE only when a non-conventional starter's `expectedInnings === null` (unresolved workload). Known chains (innings present) are VIABLE; caller elevates workloadDependence and bullpenDependence scores. Role label alone is never a veto.

## Phase separation (mandatory)
1. `evaluateVehicleCandidate(candidate, context)` — evaluability/structural check
2. `rankViableVehicles(candidates)` → `RankViableResult { ranked, controllingBlockers }` — attribute-only ordering
3. `authorizeSelectedVehicle(selected, context)` → `AuthorizationResult` — CORE/NO_CORE gates

A vehicle may be VIABLE and receive NO_CORE. Selection (Phase 2) and authorization (Phase 3) are separate. Never use `decision === CORE` to filter before ranking.

## Operational preservation
- `module10_slateInput.ts` GAME_TOTAL seed is preserved until the shadow replacement passes replay and comparison validation (Task #73).
- `rankViableVehicles` is not wired to `Candidate_Vehicle` or `SLATE_BOARD` until Task #74 is commissioned.

## Commissioning gates before live selection
1. Vehicle-specific projections for all NOT_EVALUABLE vehicle types
2. Caller-supplied attribute scores populated from real pipeline signals
3. Task #73: shadow comparison run — one publish with shadow output logged against the live board
4. Task #74: GAME_TOTAL seed removal + one-time data migration after #73 is positive
