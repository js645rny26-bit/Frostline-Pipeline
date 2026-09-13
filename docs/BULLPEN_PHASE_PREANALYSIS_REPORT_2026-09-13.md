# Bullpen Phase Pre-Analysis Control Report — 2026-09-13

## Commissioning status

This is a research-only corpus audit built from immutable frozen packets and
canonical settled outcomes. No production feature was promoted and no frozen
pregame row was rewritten.

Primary verdict:

`BULLPEN_STATE_HYPOTHESIS_SUPPORTED`

Commissioning consequence:

`STATE_BASED_BULLPEN_ENGINE_SUPPORTED_RESEARCH_PRIORITY_NO_PRODUCTION_PROMOTION`

## Phase-instrumentation coverage gate

| Measure                                               | N / value | Status                                         |
| ----------------------------------------------------- | --------: | ---------------------------------------------- |
| Allocation-eligible games                             |       239 | Frozen packet + canonical final                |
| Direct exact starter-window runs                      |         0 | No exact aggregate field exists                |
| Direct exact post-starter runs                        |         0 | No exact aggregate field exists                |
| Deterministically reconstructed from MLB play-by-play |       239 | Scoring total reconciled to official total     |
| Direct actual starter IP, both sides                  |       239 | MLB boxscore outs / 3                          |
| Direct frozen Expected_IP, both sides                 |       239 | Immutable frozen packet                        |
| Direct actual game total                              |       239 | Canonical final                                |
| Direct frozen starter roles, both sides               |       239 | Immutable frozen packet                        |
| Safely usable after starter-identity checks           |       231 | Both starter identities matched                |
| Coverage                                              |    96.65% | PASS                                           |
| Excluded                                              |         8 | Explicit starter identity mismatch/unresolved  |
| Games with inherited-runner crossings                 |       106 | Resolved using current pitcher                 |
| Inherited-runner crossings                            |       224 | Confirms pitcher R is not the phase definition |

The predeclared floor was at least 100 usable games and at least 50% coverage.
Both requirements pass.

The eight exclusions were four `MATCH/UNRESOLVED`, one
`UNRESOLVED/MATCH`, one `MISMATCH/MATCH`, and two `MISMATCH/MISMATCH` games.
Repairing those frozen-versus-actual starter identity gaps could raise usable N
to 239, but they were not reconstructed or silently assumed for this analysis.

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
| Overall             | 231 |       +0.517 |       2.527 |        3.093 |       -1.564 |       2.712 |        3.645 |           +0.185 | [-0.184, +0.575]       |
| LOW_NORMAL          | 186 |       +0.783 |       2.556 |        3.071 |       -1.303 |       2.528 |        3.339 |           -0.028 | [-0.381, +0.316]       |
| HIGH                |  30 |       -0.849 |       2.171 |        2.916 |       -2.319 |       3.527 |        4.796 |           +1.356 | [+0.657, +2.055]       |
| EXTREME             |  15 |       -0.047 |       2.879 |        3.659 |       -3.292 |       3.365 |        4.505 |           +0.486 | unavailable: one slate |
| REACHED_OR_EXCEEDED |  46 |       +1.847 |       2.395 |        2.901 |       -0.776 |       2.440 |        3.022 |           +0.045 | [-0.750, +0.987]       |
| MODERATELY_SHORT    | 114 |       +0.833 |       2.523 |        3.002 |       -1.053 |       2.169 |        2.966 |           -0.354 | [-0.671, -0.094]       |
| MATERIALLY_SHORT    |  71 |       -0.851 |       2.619 |        3.347 |       -2.895 |       3.759 |        4.815 |           +1.141 | [+0.555, +1.741]       |

Confidence intervals use a deterministic 5,000-repetition paired block
bootstrap that resamples complete slate dates rather than individual games.

## Workload-by-environment interaction

`MIN_INTERPRETABLE_CELL_N = 15`. Cells below that floor are descriptive only,
receive no inferential interpretation, and do not support the verdict.

| Environment × workload           |   N | Starter bias | Starter MAE | Starter RMSE | Bullpen bias | Bullpen MAE | Bullpen RMSE | Paired loss diff | 95% block CI     | Status            |
| -------------------------------- | --: | -----------: | ----------: | -----------: | -----------: | ----------: | -----------: | ---------------: | ---------------- | ----------------- |
| LOW_NORMAL × REACHED_OR_EXCEEDED |  41 |       +1.914 |       2.530 |        3.033 |       -0.623 |       2.326 |        2.748 |           -0.204 | [-0.964, +0.649] | INTERPRETABLE     |
| LOW_NORMAL × MODERATELY_SHORT    |  94 |       +1.089 |       2.603 |        3.069 |       -0.989 |       2.139 |        2.943 |           -0.465 | [-0.817, -0.172] | INTERPRETABLE     |
| LOW_NORMAL × MATERIALLY_SHORT    |  51 |       -0.692 |       2.490 |        3.105 |       -2.427 |       3.407 |        4.317 |           +0.917 | [+0.289, +1.696] | INTERPRETABLE     |
| HIGH × REACHED_OR_EXCEEDED       |   5 |       +1.290 |       1.290 |        1.414 |       -2.034 |       3.374 |        4.697 |           +2.084 | —                | INSUFFICIENT_CELL |
| HIGH × MODERATELY_SHORT          |   9 |       -1.246 |       2.152 |        2.837 |       -0.386 |       2.403 |        2.968 |           +0.251 | —                | INSUFFICIENT_CELL |
| HIGH × MATERIALLY_SHORT          |  16 |       -1.294 |       2.456 |        3.285 |       -3.496 |       4.207 |        5.593 |           +1.751 | [+1.132, +2.546] | INTERPRETABLE     |
| EXTREME × REACHED_OR_EXCEEDED    |   0 |            — |           — |            — |            — |           — |            — |                — | —                | INSUFFICIENT_CELL |
| EXTREME × MODERATELY_SHORT       |  11 |       +0.339 |       2.141 |        2.522 |       -2.141 |       2.241 |        3.156 |           +0.100 | —                | INSUFFICIENT_CELL |
| EXTREME × MATERIALLY_SHORT       |   4 |       -1.110 |       4.910 |        5.719 |       -6.458 |       6.458 |        6.980 |           +1.548 | —                | INSUFFICIENT_CELL |

Five of nine interaction cells are underpowered. The limitation concerns those
cells, not the whole analysis. Main-effect evidence is available. The verdict
does not rely on the sparse cells: within `LOW_NORMAL`, the 51-game materially
short cohort shows positive bullpen-phase excess while both adequately sampled
nonmaterial cohorts do not; the 71-game workload main effect is consistent.
The 16-game `HIGH × MATERIALLY_SHORT` cell is directionally coherent but spans
only two slate blocks and should remain secondary.

## Verdict

The apparent bullpen-phase excess does not disappear after controlling for
leave-one-slate-out scoring environment. It worsens coherently when either
starter exits at least 2.0 innings earlier than frozen expectation, including
inside ordinary `LOW_NORMAL` environments.

Therefore the one primary verdict is:

`BULLPEN_STATE_HYPOTHESIS_SUPPORTED`

The State-Based Bullpen Engine becomes a supported engineering research
priority. This report does not authorize implementation or promotion into the
production projection path.
