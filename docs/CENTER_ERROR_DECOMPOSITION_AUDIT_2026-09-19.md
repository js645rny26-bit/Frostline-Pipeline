# Center Error Decomposition Audit — 2026-09-19

Status: `TEST_ONLY / RESEARCH_ONLY`

No workbook write and no active projection change were made.

## Authoritative source coverage

Direct readback from the authoritative workbook at the latest published
Module 32 timestamp (`2026-09-19T15:21:26.510Z`) showed:

- allocation-eligible games: 318;
- direct starter-window aggregate rows: 0;
- direct post-starter aggregate rows: 0;
- deterministic MLB play-by-play reconstructions: 316;
- exact phase rows usable: 309 (97.17%);
- inherited-runner ambiguity games: 146;
- inherited-runner crossings resolved by current pitcher: 304;
- excluded rows: 9.

All phase analysis therefore uses play-by-play current-pitcher reconstruction.
Pitcher R/ER and the older sparse aggregate field are rejected.

## Component join

All 309 usable phase rows joined to their exact frozen packet snapshot. Of
those, 286 contained every component needed for the full decomposition. The
23 excluded component rows are historical lineage gaps; they are not filled
from current or postgame information.

The sample-floor derivation cohort ended 2026-09-17 and contained 271 complete
rows. Continuous SD and resulting frozen N floor:

| Family | Derivation N | SD (runs) | Frozen floor |
|---|---:|---:|---:|
| Offense marginal loss | 271 | 0.2015 | 100 |
| Starter-phase rate error | 271 | 2.7665 | 100 |
| Workload-allocation error | 271 | 0.4372 | 100 |
| Bullpen-continuation rate error | 271 | 3.5488 | 100 |
| Environment marginal loss | 271 | 0.4581 | 100 |
| Team-allocation correctness | n/a | Bernoulli rule | 171 |
| Frozen 90% interval escape | n/a | nominal p=0.10 rule | 139 |

## First corpus result

Across 286 fully reconciling rows:

- total signed bias (`projection - actual`): -0.844 runs;
- total MAE: 3.338;
- workload-allocation signed error: +0.121 runs;
- workload-allocation MAE: 0.257;
- starter-phase rate signed error: -1.101 runs;
- starter-phase rate MAE: 2.421;
- bullpen-continuation rate signed error: +0.136 runs;
- bullpen-continuation rate MAE: 2.777;
- offense-baseline marginal absolute-loss change: -0.009 runs;
- environment marginal absolute-loss change: -0.053 runs.

A deterministic 5,000-replicate slate-block bootstrap across 23 slates gave
these 95% intervals for signed means:

- total: [-1.381, -0.345];
- workload allocation: [+0.069, +0.179];
- starter phase: [-1.616, -0.553];
- bullpen continuation: [-0.449, +0.713];
- offense marginal loss: [-0.036, +0.017];
- environment marginal loss: [-0.094, -0.007].

Interpretation: the recent low-center problem is not explained by workload
allocation, generic bullpen continuation bias, offense-center customization,
or environment adjustment in this corpus. The supported repeated directional
error is starter-window scoring: observed starter-window runs are higher than
the workload-normalized frozen starter-phase expectation.

This identifies the next audit target; it does not authorize a coefficient or
an active correction.

The six starter-mechanism follow-ups are governed as one family. Evidence
requires a 99.1667% slate-block interval excluding zero after the mechanism's
own frozen N floor passes. Point-estimate ranking alone is prohibited.

Damage is currently `INSTRUMENTATION_DEAD` wherever the only candidate fields
are constant `Damage_Matchup_Factor=1.0` and `HR_XBH_Damage_Runs=0`. This is an
instrumentation finding, not evidence that damage is not responsible. Patch B
remains unmapped and cannot be silently substituted.

## Allocation and tail controls

- team allocation: 318 eligible, 317 comparable, 193 correct, 124 sign
  reversals, 60.69% accuracy; the 171-game floor is passed;
- NB frozen distribution: 215 eligible, 13 outside the 90% interval (4 low,
  9 high), 6.05% escape rate; the 139-game floor is passed.

The tail result does not permit individual games to be called “defensible
centers.” It only shows that large misses cannot be dumped into a generic tail
bucket without checking the supported starter-phase mechanism first.

## Next research step

Decompose the starter-window residual against frozen starter quality, traffic,
damage, conversion, and survival/failure evidence. Keep each subcohort behind
its own frozen N floor. Do not change the active center until an isolated
mechanism repair improves replay and live shadow without damaging conventional
clean cases.
