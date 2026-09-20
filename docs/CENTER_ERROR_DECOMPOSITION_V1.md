# Center Error Decomposition V1

Status: `TEST_ONLY / RESEARCH_ONLY`

Active projection input: `NO`

This object diagnoses repeated center errors. It does not alter a projection,
decision, market comparison, authorization, frozen packet, or settlement.

## Required evidence

Phase observations must come from `BULLPEN_PHASE_COVERAGE_V1` rows with
`Phase_Row_Usable=TRUE` and
`Actual_Phase_Source=MLB_STATSAPI_PLAY_BY_PLAY_RECONSTRUCTION`. At the
2026-09-19 authoritative readback, Module 32 had reconstructed 316 games and
309 were safely usable. The older sparse
`Actual_Starter_Window_Runs`/pitcher-charged R or ER surfaces are prohibited:
they do not describe runs scored while the designated pitcher was actually on
the mound and can misassign inherited runners.

## Reconciled phase decomposition

The frozen starter phase is:

`(Starter_Attack_Runs + Traffic_Conversion_Runs + HR_XBH_Damage_Runs) × Run_Multiplier`

The frozen bullpen phase is:

`Bullpen_Continuation_Runs × Run_Multiplier`

Both must reconcile to the frozen price-blind total. Actual starter-window and
post-starter runs must reconcile to the actual total.

The diagnostic then holds frozen phase run rates fixed and substitutes the
observed starter/bullpen inning split. This yields three additive errors:

1. workload-allocation error;
2. starter-phase rate error after workload normalization;
3. bullpen-continuation rate error after workload normalization.

Their sum must equal `Frozen_Total - Actual_Total` within tolerance. This is a
settlement decomposition, not a claim that actual workload was knowable
pregame.

## Seven diagnostic families

| Family | Construction | Additive? | Minimum governance |
|---|---|---:|---|
| Offense baseline | Active offense center versus league-neutral one-at-a-time counterfactual | No | max(100, 95% CI half-width rule) |
| Starter phase | Workload-normalized starter-phase residual | Yes | max(100, 95% CI half-width rule) |
| Workload allocation | Frozen innings allocation versus actual-innings counterfactual using frozen phase rates | Yes | max(100, 95% CI half-width rule) |
| Bullpen continuation | Workload-normalized bullpen-phase residual | Yes | max(100, 95% CI half-width rule) |
| Environment | Frozen total versus no-environment one-at-a-time counterfactual | No | max(100, 95% CI half-width rule) |
| Team allocation | Frozen team split versus actual team split, total held fixed | No | 171 for worst-case ±7.5 percentage-point 95% precision |
| Distribution tail | Actual total versus the frozen 90% predictive interval | No | 139 for nominal 10% escape-rate ±5 percentage-point 95% precision |

Continuous sample floors are derived from the sample SD in a fixed derivation
corpus ending `2026-09-17`, using a 0.75-run 95% CI half-width, and then frozen.
Rows after that date cannot change the floor. Every family reports its own
eligible N and `FLOOR_NOT_FROZEN`, `INSUFFICIENT_N`, or `INTERPRETABLE`.

The authoritative derivation corpus contained 271 complete component rows.
The frozen continuous floors are 100 for offense baseline, starter phase,
workload allocation, bullpen continuation, and environment. The frozen
allocation and tail floors are 171 and 139 respectively.

## Tail governance

A game may be labeled only as within the frozen 90% interval, a low escape, a
high escape, or distribution evidence unavailable. A single game is never
labeled “the center remained defensible.”

“Defensible center” is a cohort-level conclusion only, and requires an
interpretable sample, signed-bias uncertainty that includes zero, acceptable
frozen interval coverage/PIT behavior, and no adequately sampled mechanism
cohort carrying the miss. Otherwise the row remains an unresolved tail
candidate or is attributed to the supported mechanism. Tail cannot be the
dumping ground for unexplained large misses.

## Starter-mechanism multiplicity and instrumentation

The starter-window follow-up evaluates six predeclared mechanism families:
starter quality, traffic, damage, conversion, survival/failure, and role or
lineup observability. Each family must independently pass its frozen N floor.

Directional support requires a slate-block interval excluding zero after
familywise control. V1 uses Bonferroni control across six simultaneous claims:
familywise alpha 0.05, per-mechanism alpha 0.008333, and a 99.1667% interval.
The largest point estimate is not evidence when its simultaneous interval
includes zero. Environment or role subcells below their own floor remain
descriptive even when the parent mechanism is interpretable.

Instrumentation is audited before error attribution. A fully populated field
that never leaves its neutral value is `INSTRUMENTATION_DEAD`; a partially
populated field is `INSTRUMENTATION_PARTIAL`. Neither can receive a
`NOT_RESPONSIBLE` interpretation.

In particular, a corpus where `Away/Home_Damage_Matchup_Factor` remains 1.0
and `HR_XBH_Damage_Runs` remains 0 does not clear damage. It means the active
damage mechanism is unmeasurable from those fields and must be reported as
`INSTRUMENTATION_DEAD`. Patch B remains a separate factual evidence source and
is not mapped into this audit or the active projection by implication.

## Commissioning order

1. freeze sample-floor derivation rows through 2026-09-17;
2. join only exact Module 32 phase rows to matching frozen packets;
3. reject non-reconciling component or phase rows;
4. publish research-only rows and bucket summaries;
5. inspect repeated mechanisms only after each bucket reaches its frozen floor;
6. propose a model repair only for a supported mechanism;
7. replay and live-shadow that isolated repair before active deployment.

No Sept. 18 or later outcome may be used to tune a coefficient or change a
sample floor.
