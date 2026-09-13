# Bullpen Phase Pre-Analysis Control Report — 2026-09-13

## Commissioning status

This is the authoritative-workbook readback from settlement workflow run
`34764362094` on commit `8668d80`. It is a research-only corpus audit built
from immutable frozen packets and canonical settled outcomes. No production
feature was promoted and no frozen pregame row was rewritten.

Primary verdict:

`INCONCLUSIVE_SAMPLE_OR_EFFECT`

Commissioning consequence:

`RETAIN_HYPOTHESIS_UNRESOLVED`

## Phase-instrumentation coverage gate

| Measure                                               | N / value | Status                                                |
| ----------------------------------------------------- | --------: | ----------------------------------------------------- |
| Allocation-eligible games                             |       239 | Frozen packet + canonical final                       |
| Direct exact starter-window runs                      |         0 | No exact aggregate field exists                       |
| Direct exact post-starter runs                        |         0 | No exact aggregate field exists                       |
| Deterministically reconstructed from MLB play-by-play |       237 | Scoring total reconciled to official total            |
| Direct actual starter IP, both sides                  |       239 | MLB boxscore outs / 3                                 |
| Direct frozen Expected_IP, both sides                 |       239 | Immutable frozen packet                               |
| Direct actual game total                              |       239 | Canonical final                                       |
| Direct frozen starter roles, both sides               |       239 | Immutable frozen packet                               |
| Safely usable after all controls                      |       231 | Exact phase reconstruction + matched starter identity |
| Coverage                                              |    96.65% | PASS                                                  |
| Excluded                                              |         8 | Explicit PBP or starter-identity failure               |
| Games with inherited-runner crossings                 |       106 | Resolved using current pitcher                        |
| Inherited-runner crossings                            |       224 | Confirms pitcher R is not the phase definition        |

The predeclared floor was at least 100 usable games and at least 50% coverage.
Both requirements pass.

The eight exclusions were four `MATCH/UNRESOLVED`, one
`UNRESOLVED/MATCH`, one `MISMATCH/MATCH`, and two `MISMATCH/MISMATCH` games.
The two doubleheader G1 identity mismatches also failed the play-by-play total
reconciliation, so they remain fail-closed rather than being forced into the
corpus. The current exact-PBP reconstruction makes 237 games recoverable; a
legitimate identity repair could raise usable N from 231 to 237.

### Exact sources and reconstruction

- Allocation eligibility and actual total:
  `ALLOCATION_SETTLEMENT_DIAGNOSTICS` rows with
  `Diagnostic_Status=FROZEN_PACKET_VERIFIED`.
- Frozen expected innings, roles, starter attack runs, and bullpen continuation
  runs: latest legitimate pre-first-pitch `FROZEN_PREGAME` row in
  `PREGAME_PACKET_HISTORY`.
- Actual starter innings:
  `STARTER_OUTCOME_DIAGNOSTICS.Actual_IP`, derived from MLB boxscore outs / 3.
- Frozen-to-actual starter identity:
  `SHADOW_OUTCOMES.Away_Starter_Match_Status` and
  `Home_Starter_Match_Status`.
- Exact phase runs: MLB Stats API play-by-play.

The first current pitcher in the top and bottom halves identifies the two
actual starters. Each scoring runner is assigned to the play's
`matchup.pitcher.id`, the pitcher on the mound when the run scores. A scoring
runner whose `responsiblePitcher.id` differs is retained as an inherited-runner
crossing, but the run remains in the current pitcher's phase. The reconstructed
game total must equal the official actual total or the row fails closed.

The previously stored Module 24 `*_Starter_Window_Runs_Allowed` fields are
pitcher-charged R. They are not exact on-mound phase observations when an
inherited runner scores after removal and were not used in this analysis.

## Leave-one-slate-out environment control

Slate scoring environment is standardized using leave-one-slate-out corpus
parameters so the evaluated slate does not contribute to its own benchmark.

For each of 20 slate dates, the slate's runs per game is compared with the mean
and sample SD of the other 19 slate rates. Fixed buckets are `LOW_NORMAL` below
+1.0, `HIGH` from +1.0 to below +2.0, and `EXTREME` at +2.0 or above.

- `HIGH`: 2026-09-09 (z = 1.5689), 2026-09-12 (z = 1.8026)
- `EXTREME`: 2026-09-01 (z = 2.1807)
- all other corpus dates: `LOW_NORMAL`

## Phase-error findings

Errors are frozen phase projection minus exact actual phase runs. The paired
loss difference is bullpen absolute error minus starter absolute error. Positive
values mean the bullpen phase is worse.

| Cohort              |   N | Starter bias | Starter MAE | Starter RMSE | Bullpen bias | Bullpen MAE | Bullpen RMSE | Paired loss diff | 95% block CI           |
| ------------------- | --: | -----------: | ----------: | -----------: | -----------: | ----------: | -----------: | ---------------: | ---------------------- |
| Overall             | 231 |       +0.517 |       2.527 |        3.093 |       -1.564 |       2.712 |        3.645 |           +0.185 | [-0.203, +0.583]       |
| LOW_NORMAL          | 186 |       +0.783 |       2.556 |        3.071 |       -1.303 |       2.528 |        3.340 |           -0.028 | [-0.388, +0.322]       |
| HIGH                |  30 |       -0.849 |       2.171 |        2.916 |       -2.319 |       3.527 |        4.796 |           +1.356 | [+0.657, +2.055]       |
| EXTREME             |  15 |       -0.047 |       2.879 |        3.659 |       -3.292 |       3.365 |        4.505 |           +0.486 | unavailable: one slate |
| REACHED_OR_EXCEEDED |  20 |       +0.306 |       3.236 |        4.070 |       -0.818 |       2.785 |        3.463 |           -0.451 | [-2.083, +1.459]       |
| MODERATELY_SHORT    |  39 |       -0.776 |       2.691 |        3.253 |       -1.098 |       2.441 |        3.288 |           -0.250 | [-1.101, +0.395]       |
| MATERIALLY_SHORT    | 172 |       +0.835 |       2.407 |        2.920 |       -1.756 |       2.765 |        3.741 |           +0.357 | [+0.030, +0.711]       |

Confidence intervals use a deterministic 5,000-repetition paired block
bootstrap that resamples complete slate dates rather than individual games.

## Workload-by-environment interaction

`MIN_INTERPRETABLE_CELL_N = 15`. Cells below that floor are descriptive only,
receive no inferential interpretation, and do not support the verdict.

| Environment × workload           |   N | Starter bias | Starter MAE | Starter RMSE | Bullpen bias | Bullpen MAE | Bullpen RMSE | Paired loss diff | 95% block CI     | Status            |
| -------------------------------- | --: | -----------: | ----------: | -----------: | -----------: | ----------: | -----------: | ---------------: | ---------------- | ----------------- |
| LOW_NORMAL × REACHED_OR_EXCEEDED |  15 |       -0.022 |       3.885 |        4.628 |       -0.413 |       2.589 |        2.938 |           -1.296 | [-2.800, +0.423] | INTERPRETABLE     |
| LOW_NORMAL × MODERATELY_SHORT    |  28 |       -0.233 |       2.609 |        3.034 |       -0.886 |       2.109 |        2.788 |           -0.500 | [-1.880, +0.382] | INTERPRETABLE     |
| LOW_NORMAL × MATERIALLY_SHORT    | 143 |       +1.066 |       2.406 |        2.867 |       -1.478 |       2.603 |        3.475 |           +0.197 | [-0.118, +0.505] | INTERPRETABLE     |
| HIGH × REACHED_OR_EXCEEDED       |   5 |       +1.290 |       1.290 |        1.414 |       -2.034 |       3.374 |        4.697 |           +2.084 | —                | INSUFFICIENT_CELL |
| HIGH × MODERATELY_SHORT          |   9 |       -1.246 |       2.152 |        2.837 |       -0.386 |       2.403 |        2.968 |           +0.251 | —                | INSUFFICIENT_CELL |
| HIGH × MATERIALLY_SHORT          |  16 |       -1.294 |       2.456 |        3.285 |       -3.496 |       4.207 |        5.593 |           +1.751 | [+1.132, +2.546] | INTERPRETABLE     |
| EXTREME × REACHED_OR_EXCEEDED    |   0 |            — |           — |            — |            — |           — |            — |                — | —                | INSUFFICIENT_CELL |
| EXTREME × MODERATELY_SHORT       |   2 |       -6.270 |       6.270 |        6.420 |       -7.260 |       7.260 |        7.894 |           +0.990 | —                | INSUFFICIENT_CELL |
| EXTREME × MATERIALLY_SHORT       |  13 |       +0.910 |       2.358 |        3.017 |       -2.682 |       2.766 |        3.719 |           +0.409 | —                | INSUFFICIENT_CELL |

Five of nine interaction cells are underpowered. The limitation concerns those
cells, not the whole analysis. Main-effect evidence is available. No conclusion
rests only on a sparse cell.

The materially-short main effect is positive with a block-bootstrap interval
above zero. The `HIGH × MATERIALLY_SHORT` cell is also positive, but represents
only two slate blocks. Inside `LOW_NORMAL`, the materially-short cell is worse
than the reached and moderately-short cells, but its interval still crosses
zero. This is coherent directional evidence, not enough controlled evidence for
verdict A.

## Verdict

The corpus contains a credible materially-short workload signal, but the
overall bullpen-versus-starter error difference is not distinguishable from
zero and the decisive `LOW_NORMAL × MATERIALLY_SHORT` interval includes zero.
Five environment/workload cells are underpowered. The current evidence cannot
reliably distinguish a state-dependent bullpen defect from an environment-
concentrated or weaker effect.

Therefore the one primary verdict is:

`INCONCLUSIVE_SAMPLE_OR_EFFECT`

The bullpen-state hypothesis remains unresolved. It does not change engineering
priority on this evidence, and no production feature was promoted.
