# Starter Window Discrimination V1

Status: `RESEARCH_ONLY_NOT_COMMISSIONED`  
Active input: `NO`

Module 38 diagnoses why Frostline's frozen starter-window center differs from
the exact scoring observed while each designated starter was actually on the
mound. It cannot change a projection, coefficient, confidence, market,
vehicle, or decision.

## Lineage contract

- Predictors come only from a legitimate `FROZEN_PREGAME`
  `PREGAME_PACKET_HISTORY` row whose snapshot precedes scheduled first pitch.
- Outcomes come only from Module 32's MLB play-by-play current-pitcher
  reconstruction, now retained separately for the away and home batting side.
- Pitcher R/ER and final-score allocation are prohibited substitutes.
- Postgame data defines actual innings, exact on-mound runs, survival/failure
  labels, and tail thresholds only. It never fills a pregame feature.

The frozen side expectation reproduces the active team formula without tuning:

```text
base = Active_Offense_Center × Effective_Starter_IP / 9 × Opposing_Starter_Quality
traffic = base × (Traffic_Factor - 1)
damage = (base + traffic) × (Damage_Factor - 1)
expected starter-window runs = (base + traffic + damage) × Run_Multiplier
```

## Outcome labels

These labels were declared before interpreting Module 38 results:

- `FAILURE`: at least four exact on-mound starter-window runs, or at least a
  two-inning shortfall versus frozen Expected_IP.
- `SURVIVAL`: no more than two exact on-mound runs and actual innings reached
  frozen Expected_IP within 0.5 inning.
- `MIXED`: every other observation.

Tail rates at 4+, 5+, and 6+ runs remain separate from the label.

## Feature governance

Starter quality, expected/effective workload, the active traffic factor, and
active offense center are frozen, varying inputs. Tertile cutpoints are derived
from predictor values only through 2026-09-17; outcomes do not choose them.

The active damage factor and `HR_XBH_Damage_Runs` remain uniformly neutral
behind the Patch B gate. They are `INSTRUMENTATION_DEAD`, not evidence that
damage is unimportant. Patch B remains `Active_Input=NO` and
`NOT_MAPPED_PENDING_COMMISSIONING`.

Frostline does not persist a calibrated starter-side survival/failure
probability, raw K/whiff field, raw BB field, or uniformly replayable
handedness field in the eligible historical packet. Probability calibration
and those requested interactions are therefore unavailable rather than
manufactured.

## Inference rules

Module 38 reports signed bias and absolute/tail discrimination separately.
Cells below N=30 are descriptive only. Bias intervals resample complete slate
dates. Case studies never tune a coefficient. `POSTHOC_ONLY` mechanisms do not
count as validation.

No shadow projection experiment is justified until a pregame-observable,
adequately sampled mechanism separates detonations from inverse quiet controls
without degrading the opposite error dimension.

