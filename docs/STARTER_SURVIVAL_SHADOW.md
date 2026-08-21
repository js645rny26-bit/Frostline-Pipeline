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
