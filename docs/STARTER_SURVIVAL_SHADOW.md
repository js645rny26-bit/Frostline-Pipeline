# Starter survival / failure dependency challenger

Status: shadow default only. This module is a commissioning measurement surface;
it does not change Frostline's active projection, production coefficients,
CORE/NO CORE authorization, vehicle selection, market processing, or either
workbook's canonical behavior.

## Temporary starter-survival probability model

```text
Definition:
  pA, pH = clamp(Projected_Starter_Innings / 9, 0, 1)

Status: Shadow default only
Rationale: Linear scaling from existing Frostline projection

Known limitations:
  - No injury weighting
  - No manager-specific hooks
  - No performance variance beyond projection
  - Assumes Frostline innings projection is calibrated

Replay target: Does this survive-probability assumption
correctly predict which starters actually reach their leash?
```

The challenger treats each game as the four independent states `SS`, `FS`,
`SF`, and `FF`. A failure removes exactly 1.0 projected starter inning, down to
zero, and transfers precisely that workload to the bullpen. Lineup, offense,
park, weather, umpire, team form, opponent, and market values are unchanged
between branches. The weighted Starter Survival Adjusted Total (SSAT) and the
continuous starter/game failure-dependency scores are written only to
`STARTER_SURVIVAL_CALIBRATION_HISTORY` before first pitch.

At settlement, `STARTER_SURVIVAL_CALIBRATION_REPORT` grades preserved
snapshots against actual total and official starter innings. A missing
prospective snapshot remains missing; it is never reconstructed or backdated.

## SSAT v2 empirical challenger

SSAT v1 remains frozen as the control. `STARTER_SURVIVAL_V2_CALIBRATION_HISTORY`
is a new, separate challenger, not a rewrite of v1. It does **not** use
`Projected_Starter_Innings / 9` as a fallback probability. Instead it takes
only strictly earlier settled v1 observations and derives a survival rate plus
conditional workload shortfall from the closest available empirical cohort:
role and exact projected workload when available, then exact workload, then
role, then the complete settled history. No numeric similarity weights,
thresholds, or production coefficients are introduced.

V2 also captures the existing expected-pitch count, workload flags,
starter-quality proxy (FIP/K-BB based), and opponent pressure (opponent
offense rate × lineup factor). Those fields are preserved prospectively for
the next empirical pass; they receive no invented weight during the v2
bootstrap.

The v2 failure workload is `expected survival innings − empirical conditional
failure shortfall`, floored at zero. The removed workload goes to the bullpen
in the same projection machinery used by v1. An observed conditional run-cost
field is recorded for audit; the branch total itself still changes only starter
and bullpen exposure. When earlier settled evidence has no actual failure case,
v2 records `INSUFFICIENT_EMPIRICAL_HISTORY` rather than manufacturing a number.

The v2 settlement report compares base, preserved v1, and v2 separately. No
candidate may promote itself into a projection, vehicle, market, or decision.

## V1/V2 differentiation audit

`STARTER_SURVIVAL_DIFFERENTIATION_AUDIT` is the required check against treating
two related SSAT outputs as independent confirmation. It records total-output
correlation and distance, the shares within 0.10/0.25/0.50 runs, repeated
survival-probability profiles across distinct games, frozen cohort provenance,
and descriptive quality/pressure associations.

Until a future commissioning review demonstrates material differentiation,
v1 and v2 are **one SSAT evidence family**. Manual review should describe the
base total and SSAT family range, never count v1/v2 agreement as two separate
votes. The audit contains no automatic retirement threshold and cannot alter
projections, vehicles, market handling, BET/PASS, or authorization.
