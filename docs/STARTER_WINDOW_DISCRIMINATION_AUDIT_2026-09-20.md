# Starter Window Discrimination Audit — 2026-09-20

Status: `RESEARCH_ONLY_NOT_COMMISSIONED`  
Active input: `NO`  
Authoritative workflow: `35494729737` (`e268765`)  
Authoritative replay timestamp: `2026-09-20T06:39:26.520Z`

## Coverage and lineage

Module 38 published 602 team-side observations spanning 301 games and 24
slates. The underlying Module 32 phase corpus contained 324 usable games, so
the complete frozen-feature join covers 92.90% of the exact phase corpus.
Every included outcome uses MLB Stats API play-by-play current-pitcher
identity; pitcher R/ER and final-score allocation are prohibited substitutes.

All predictors come from immutable pre-first-pitch packets. Actual innings,
on-mound runs, run-detonation labels, and workload-shortfall labels are
settlement outcomes only.

## Center calibration and allocation distinction

The primary workload-normalized starter scoring-rate error was:

- signed bias: -0.528 runs per starter side;
- MAE: 1.506;
- median absolute error: 1.203;
- RMSE: 1.963;
- 99.1667% slate-block bootstrap interval: [-0.853, -0.161].

This is approximately -1.06 runs per game and reconciles the side-level audit
to Module 37's supported negative starter-phase rate bias.

The separate allocation-inclusive error was +0.282 runs per side with MAE
1.663. These are not contradictory results. Early exits remove frozen starter
innings, so the raw starter-window total can appear slightly high while the
frozen starter scoring rate is too low when evaluated over the innings the
starter actually pitched. Neither quantity authorizes a production change.

## Distribution discrimination

- exact 4+ run starter detonations: 158/602 (26.25%);
- 5+ run windows: 16.28%;
- 6+ run windows: 8.47%;
- mean exact runs conditional on a 4+ detonation: 5.165;
- material workload shortfalls: 259/602 (43.02%);
- allocation-inclusive expected starter windows at 4+ runs: 23/602;
- those 23 identified only 6 of the 158 observed detonations;
- workload-normalized expected windows at 4+ runs: 14/602, identifying 8
  observed detonations.

An expected center is not a failure probability, so these counts are evidence
of center/tail compression, not a manufactured probability-calibration score.
Frostline does not persist a calibrated starter-side failure probability or a
conditional failure-severity forecast.

## Pregame feature findings

`Starter_Quality` is a run multiplier: lower values describe stronger
suppression anchors and higher values describe weaker pitchers.

| Frozen cohort | N | normalized bias | 99.1667% interval | 4+ rate |
|---|---:|---:|---:|---:|
| low quality multiplier / stronger suppression | 202 | -0.699 | [-1.064, -0.289] | 21.78% |
| mid quality multiplier | 201 | -0.576 | [-1.002, -0.097] | 27.36% |
| high quality multiplier / weaker pitcher | 199 | -0.307 | [-0.719, +0.204] | 29.65% |

The factor ranks detonation frequency in the expected direction, but the
largest supported low bias occurs in the supposedly strongest suppression
cohort. This supports a suppression-anchor calibration/tail concern; it does
not identify a safe correction.

Traffic shows modest tail ranking (28.03% detonations in the mid bucket versus
22.82% in the low bucket), but both buckets retain nearly identical negative
bias (-0.522 versus -0.540). Traffic therefore does not explain the recurring
center error by itself.

Opponent-offense tertiles do not discriminate detonations (25.49% to 27.04%).
One-sided and two-sided pressure also remain close (25.30% versus 27.37%).
Neither is a stable separator for the proof cases versus inverse controls.

Expected workload is instrumentation-degenerate in the frozen corpus and
cannot support a workload-bucket claim. Conventional starters are interpretable
(N=533, normalized bias -0.508, interval [-0.882, -0.106]); opener N=40 and
bulk N=29 remain descriptive only.

## Unavailable and null findings

- `Damage_Matchup_Factor=1.0` and `HR_XBH_Damage_Runs=0` remain
  `INSTRUMENTATION_DEAD`. Zero contribution does not clear damage.
- raw K/whiff and BB fields are not uniformly frozen at starter-side level;
  requested low-K/elevated-BB and high-whiff/walk-volatility interactions are
  unavailable.
- Patch B barrel/hard-hit evidence remains unmapped and cannot be substituted.
- handedness is not uniformly replayable from historical packets.
- no starter-side survival probability, failure probability, or conditional
  failure-severity forecast is frozen, so probability-versus-severity
  attribution remains unresolved.

## Proof cases and mechanism governance

The pair audit preserves both allocation-inclusive and workload-normalized
errors. OAK-CLE, MIA-SDP, and SFG-LAD remain
`PREDECLARED_MECHANISM_PARTIAL`; MIN-LAA is a
`PREDECLARED_MECHANISM_MISS`; CHC-CIN and ATL-HOU remain `POSTHOC_ONLY` and
receive no validation credit. No case is a coefficient target.

## Commissioning verdict

`HOLD — DIAGNOSTIC EVIDENCE SUPPORTED, DISCRIMINATING MECHANISM NOT YET ISOLATED`

The audit confirms both a repeated workload-normalized center error and weak
detonation capture. It does not find a pregame-observable feature or
interaction that cleanly separates underestimated detonations from inverse
quiet controls. A later shadow projection challenger is not yet justified.

The next legitimate research step is instrumentation, not tuning: prospectively
freeze a starter-side failure probability and conditional failure-severity
object, plus the source-safe K/BB/whiff and commissioned damage evidence needed
to test the declared interactions. Active projections, confidence, market,
vehicle, and decisions remain unchanged.
