# Bullpen Phase Analysis V1

Module 32 is a settlement-only research instrument. It cannot change the
price-blind projection, expected innings, bullpen exposure, market, vehicle,
authorization, or any frozen pregame packet.

## Mandatory coverage gate

The allocation-eligible corpus is the set of canonical settled games joined to
a legitimate `FROZEN_PREGAME` packet. Before any phase replay or inferential
summary is written, the module records every eligible game in
`BULLPEN_PHASE_COVERAGE_V1` and reports the compact gate in
`BULLPEN_PHASE_COVERAGE_SUMMARY_V1`.

The phase corpus may continue only when both conditions hold:

- usable exact/reconstructed phase games >= 100;
- usable coverage >= 50% of allocation-eligible games.

Otherwise the only primary verdict is
`INSUFFICIENT_PHASE_INSTRUMENTATION`, and replay/analysis rows are not built.

## Exact phase definition

`Actual_Starter_Window_Runs` counts runs scored while either designated,
identity-matched starter/opener/bulk pitcher is actually on the mound.
`Actual_Post_Starter_Runs` is official game total minus that exact starter
window.

Pitcher-charged R and ER are not substitutes. Inherited runners charged to a
starter but scoring against a reliever belong to the post-starter phase. The
reconstruction therefore uses MLB Stats API play-by-play: first top/bottom
pitcher identities establish the starters, and each scoring runner is assigned
by the play's current `matchup.pitcher.id`. The reconstructed scoring total must
equal the official game total or the row fails closed.

Actual starter innings come from the MLB boxscore-derived
`STARTER_OUTCOME_DIAGNOSTICS.Actual_IP`; expected innings, starter roles, and
phase projections come from the immutable frozen packet. Both starter identity
statuses must be `MATCH` before a row is usable.

## Workload and environment controls

Workload state is based on the maximum individual starter shortfall:

- `REACHED_OR_EXCEEDED`: neither starter fell short;
- `MODERATELY_SHORT`: positive shortfall below 2.0 IP;
- `MATERIALLY_SHORT`: either starter fell short by at least 2.0 IP.

Slate scoring environment is standardized using leave-one-slate-out corpus
parameters so the evaluated slate does not contribute to its own benchmark.
The comparison uses slate runs per game, the sample SD of all other slate
rates, and these fixed buckets: `LOW_NORMAL` below +1.0, `HIGH` from +1.0 to
below +2.0, and `EXTREME` at +2.0 or above.

## Interaction governance

`MIN_INTERPRETABLE_CELL_N = 15`. Smaller workload-by-environment cells are
written as `INSUFFICIENT_CELL`, may be read descriptively, receive no confidence
interval, and cannot support or reject the hypothesis. Eligible cells receive a
deterministic 5,000-repetition paired slate-date block-bootstrap interval for
bullpen absolute error minus starter absolute error.

The analysis distinguishes main-effect evidence from an underpowered
interaction. A partially sparse interaction does not invalidate adequately
supported overall or main-effect results, and no conclusion may rest only on an
underpowered cell.

## Primary verdicts

Exactly one of these is emitted:

- `BULLPEN_STATE_HYPOTHESIS_SUPPORTED`
- `GENERIC_BULLPEN_CONTINUATION_DEFECT`
- `EXTREME_SLATE_EFFECT_DOMINANT`
- `INCONCLUSIVE_SAMPLE_OR_EFFECT`
- `INSUFFICIENT_PHASE_INSTRUMENTATION`

Even the supported verdict changes research priority only. No Module 32 output
is an active production feature.
