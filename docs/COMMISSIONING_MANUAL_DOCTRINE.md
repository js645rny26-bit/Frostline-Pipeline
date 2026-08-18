# Frostline Manual Commissioning Doctrine

Effective: 2026-08-12

This document governs the independent user + Ace manual review. It is an operating procedure, not projection code. The pipeline may record the review, but it must not imitate it, convert it into coefficients, or grant it automatic projection influence.

## Evidence order

Treat every model total, team allocation, direction, confidence, and vehicle as a hypothesis. Complete the independent baseball review before comparing it with Frostline:

1. Establish the independent expected run center.
2. Establish the plausible distribution width.
3. Audit away runs, home runs, and total runs separately.
4. Map each starter's survival path, failure path, workload/leash range, third-time-through uncertainty, bullpen transition, and the opponent conversion required.
5. Audit bullpen continuation by workload state and role importance.
6. Identify the dominant common scripts.
7. Compare price-blind vehicles.
8. Only then compare the independent read with the Frostline hypothesis.

Do not begin by trying to preserve a Frostline Over, Under, side, confidence, or preferred vehicle. Disagreement does not require extraordinary evidence, and skepticism must not be represented as an automatic numerical discount.

## Vehicle and polarity audit

A veto of the original vehicle starts a price-blind reroute audit. Review the opposite game total, moneyline, run line, each team total, opponent team total, and appropriate derivatives. This search is mandatory; selecting an alternative is not. Return NO CORE when no alternative captures the dominant scripts better.

### Structural event capture

When the full-game total requires multiple independent conditions to hold, but a narrower bettable event is supported across more of the likely game scripts, that event must enter the price-blind vehicle tournament and may supersede the total.

Checklist question: **Is there a narrower bettable event that occurs across more likely game scripts than the full-game total?**

Structural event capture is manual vehicle-selection doctrine only. It does not change a projection, coefficient, threshold, gate, or game truth, and it does not force an alternative wager.

### Tentative total range

When `STATCAST_SHADOW_AUDIT.Tail_Estimate_Status` is `AVAILABLE` or `PARTIAL`, treat the active `GAME_SUMMARY.Projected_Total_Runs` and `STATCAST_SHADOW_AUDIT.Estimated_Projection` as the endpoints of a tentative decision range. If the executable market line falls inside that range, the point-estimate direction is unstable and cannot authorize a wager by itself. If both endpoints remain on the same side, that is tentative agreement—not automatic authorization. Missing inputs and cap flags must be stated in the review.

If `Low_Center_Volatility_Flag` is `LOW_CENTER_VOLATILITY`, the active total is below 8.00. Record the `Low_Center_Challenger_Projection`, `Low_Center_Upper_Tail_Band`, and `Low_Center_Reason_Tags` in the manual distribution audit. This is a caution against falsely confident suppression, not an automatic Over, an expanded ordinary tentative range, or an authorization rule. Resolve the relevant starter survival, bullpen continuation, conversion, and detonation paths before selecting a vehicle or returning NO CORE.

When evidence weakens one side of a total, classify that evidence before deciding:

- Opposite-direction evidence moves the expected run center toward the other side.
- Allocation evidence changes which team owns the runs without necessarily changing the total environment.
- Distribution-widening evidence expands uncertainty or tails without establishing the opposite direction.

A weak Over is not automatically an Under, and a weak Under is not automatically an Over. A half-run line has no settlement push, but the reasoning remains capable of returning NO CORE.

Where total-environment confidence exceeds team-allocation confidence, audit the full-game total before a side. The total must still survive its own vehicle audit. A moneyline or run-line authorization carries a higher burden: durable team asymmetry must survive multiple common scripts; a projected scoring advantage alone is insufficient.

## Starter and bullpen law

"Attackable" is a probability, not an outcome. A starter informs script probability but never independently defines game identity, total direction, team allocation, or vehicle.

Classify reliever workload as FRESH, USED, TAXED, or HEAVILY TAXED using daily pitch counts, consecutive-day use, recent cumulative pitches, and likely leverage role. Weight closer, setup, bridge, middle, and long-relief availability separately. Equal pitch counts do not imply equal game impact.

## Evidence timing and market boundary

Use a Statcast game preview only after lineup confirmation is sufficiently complete. Preserve its retrieval timestamp and game identity. Preview data is comparative manual evidence; it has no automatic projection influence. A preview first obtained after first pitch is postgame evidence and cannot be relabeled as pregame evidence.

Build game truth and rank vehicles without price. Then evaluate the current executable market. Operator-supplied Hard Rock or Fliff information supersedes a stale automated snapshot. A materially changed line creates a new vehicle-state question; it does not change the baseball truth.

## Manual audit record

The system may store manual game truth, away/home/total views, preferred vehicle, CORE or NO CORE, blocker, reasoning source, timestamp, and a concise note. Those fields must remain a human-authored overlay. Settlement grades the model and manual layers independently and may report MODEL, MANUAL, TIE, BOTH_WRONG, or NOT_COMPARABLE. Disagreement alone never earns the manual layer a favorable grade.

## Named regression cases

- COL-ARI and HOU-SF (2026-08-11): model anchoring, starter survival, and allocation.
- TB-OAK (2026-08-11): successful vehicle reroute.
- TEX-LAA (2026-08-11): total polarity and allocation.
- SEA-NYY (2026-08-11): model suppression outperforming the manual challenge.
- CHW-CIN (2026-08-11): ticket result versus regulation thesis, bullpen bridge, and extra-inning state change.
- PHI-STL (2026-08-11): clean dual-suppression survival.

## Calibration boundary

No projection coefficient, threshold, or automatic manual-reasoning rule may be changed from these cases. First repair provenance, pass the August 10 and August 11 lifecycle regressions, gather clean prospective samples, and demonstrate repeated layer-specific error. Trust is earned separately for total environment, team allocation, starter survival, bullpen continuation, side selection, vehicle selection, and authorization.
