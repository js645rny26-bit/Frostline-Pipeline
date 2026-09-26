# Frostline Workbook Roadmap

This is the operator map for reading Frostline efficiently. `SCHEMA_REFERENCE` remains the column dictionary; this document explains why each tab exists, when it is written, and how it relates to the decision board.

## The shortest useful reading path

1. **RUN_LOG** — confirm the latest run date, status, module results, row counts, errors, warnings, and schema version.
2. **DAILY_MATCHUPS**, **TODAY_LINEUPS**, **BULLPEN_USAGE_DAILY**, and **RUN_ENVIRONMENT** — confirm the slate, starters, lineup status, bullpen state, weather source, roof, and environment certainty.
3. **GAME_SUMMARY** — read the active away, home, and total projection. Use **GAME_INTEGRATION** when team allocation needs investigation.
4. **STATCAST_SHADOW_AUDIT** — compare the active total with the estimated total and note missing inputs or clamps.
5. **SLATE_INPUT** — verify the vehicle, executable line, authoritative frozen line, and operator notes.
6. **SLATE_BOARD** — read the full decision, scores, blockers, survival result, lock state, and lineage.
7. **ACTIVE_BOARD_SNAPSHOT** — use only as the condensed execution view after the full board is understood.
8. **DECISION_AUDIT_LOG** and **VEHICLE_LOG** — verify what reasoning and vehicle were actually frozen.
9. After games: **SHADOW_OUTCOMES**, **VEHICLE_POSTMORTEM**, and **PROJECTION_REPLAY** first; aggregate learning tabs second.

## Input and projection catalog

Read `MODEL_INPUT_CATALOG` before treating a value as evidence. It is the
canonical answer to five questions:

- Is this `ACTIVE`, `SHADOW_ONLY`, `DISPLAY_ONLY`, a frozen copy, a legacy
  alias, or a known missing input?
- What is its statistical lookback and which game window does it affect:
  allocation, starter, bullpen, environment, full game, or market only?
- Which source supplies it, how often must it refresh, and which workbook
  surface proves it was materialized for the requested slate?
- What happens if it is unavailable or falls back?
- Which other evidence is correlated with it and therefore must not be counted
  as a second independent confirmation?

The catalog is refreshed with documentation on every run. During a pregame
publish it also records current slate materialization status. It is a source
and lineage map, not an input to any projection or board decision.

Two practical cleanup rules follow from this map:

- `L30_RS_Observed_TS` denotes Frostline's slate-scoped observation of MLB
  L30 actual runs scored per game. The old FanGraphs/wRC+ label was inaccurate.
- `TEAM_FORM_INPUT` synthetic Last_10_wOBA, strength-of-schedule, and bullpen
  rest fields are intentionally blank and labeled decommissioned until real
  sources and a commissioned consumer exist.

## Tentative total range

For manual decision-making, calculate:

```text
Tentative_Low  = min(GAME_SUMMARY.Projected_Total_Runs,
                     STATCAST_SHADOW_AUDIT.Estimated_Projection)

Tentative_High = max(GAME_SUMMARY.Projected_Total_Runs,
                     STATCAST_SHADOW_AUDIT.Estimated_Projection)
```

This range must be considered whenever the Statcast estimate is available:

- If the market line is inside the range, the point-estimate direction is unstable. It cannot authorize a wager by itself.
- If both endpoints remain on the same side of the market, they provide tentative directional agreement—not automatic authorization.
- `PARTIAL`, `UNAVAILABLE`, or capped estimates reduce confidence in the range.
- The range should trigger the vehicle tournament: a narrower structural event may capture more common scripts than the full-game total.

`GAME_SUMMARY.Traffic_Conversion_Runs` is an active signed component of the
team-run calculation. `HR_XBH_Damage_Runs` is currently fail-closed at zero
behind the Patch B commissioning gate: the Savant expected-statistics payload
still supplies xwOBA but does not expose the hard-hit field the active damage
interaction requires. Non-zero damage estimates in `STATCAST_SHADOW_AUDIT` and
the collision history remain research-only and must not be described as an
active run bonus. Read the active traffic component beside
`Away/Home_Traffic_Matchup_Factor`, `Away/Home_Pitcher_Effective_IP`, and
`Away/Home_Bullpen_Exposure_IP`.

`NEUTRAL` matchup-profile status means the required exact pregame lineup **and matching starter** data was unavailable, so the existing rate/quality model was preserved for that team. `PARTIAL` means a projected or incomplete lineup attenuated the effect. Neither state should be interpreted as a baseball conclusion.

### Active team-run calculation (v36)

For each batting team, the live center is now:

```text
league scoring environment * exact lineup OPS/xwOBA quality
  * capped recent L30/L10 realized-scoring form
  -> active offense center
  -> starter run-prevention window (FIP/ERA)
  + bullpen continuation after traffic-adjusted workload
  + bounded direct damage / conversion effects
  -> baseball-only team runs
  * already-resolved park/weather multiplier
  -> projected team runs
```

Recent runs scored are not the team talent center. They remain visible as a
bounded form modifier (maximum 8% in either direction). BB/K/WHIP inform the
traffic and workload path; hard-hit and HR/9 inform the damage path; starter
FIP/ERA owns run prevention. Positive traffic alone can shorten expected
starter workload, but it does not earn a meaningful direct-run addition unless
damage/conversion evidence co-signs it.

The retired v35 formulation was:

```text
recent offense × existing lineup quality
  → starter central-quality window
  + bounded exact-lineup × starter traffic/conversion effect
  + bounded exact-lineup × starter damage/conversion effect
  + bullpen window after the pressure-adjusted starter workload
  → baseball-only team runs
  × already-resolved park/weather multiplier
  → projected team runs
```

The pressure adjustment can shorten a starter's expected workload by at most
0.75 innings and transfers exactly that workload to the opposing bullpen. It
does not label a pitcher as having failed, and it does not overwrite the
separate SSAT family. The frozen `PREGAME_PACKET_HISTORY` record preserves
the active-math components, team matchup factors, effective pitcher workloads,
bullpen exposure, and profile statuses so settlement can test this calculation
prospectively.

### Low-center volatility warning

When `STATCAST_SHADOW_AUDIT.Low_Center_Volatility_Flag` is `LOW_CENTER_VOLATILITY`, Frostline's active total is below 8.00 and the shadow audit records three **non-operative** candidates: a primary `Low_Center_Challenger_Projection` (+1.50 runs), a `Low_Center_Sensitivity_Projection` (+2.00 runs), and an `Low_Center_Upper_Tail_Band` based on the observed low-center upward tail. They are not forecasts, do not widen the ordinary tentative range automatically, and cannot create an Over, CORE, BET, or other authorization. Score the primary and sensitivity challengers against preserved prospective outcomes before promoting either. They require an explicit manual distribution audit: identify whether suppression survives common starter/bullpen paths or whether the game has a real detonation path. Read `Low_Center_Reason_Tags` as descriptive provenance, not as a scoring rule.

## Starter-survival shadow challenger

`STARTER_SURVIVAL_CALIBRATION_HISTORY` is a separate, shadow-only four-state
starter workload calculation. It neither replaces `GAME_SUMMARY.Projected_Total_Runs`
nor changes a vehicle, market line, authorization, or tentative range. The temporary
probability definition is deliberately simple and reproducible:

```
p = clamp(Projected_Starter_Innings / 9, 0, 1)
```

It assumes the existing innings projection already captures role and workload. It does
not weight injury, manager behavior, bullpen quality, or within-start performance
variance. Each starter gets survival and one-inning-shorter failure branches; the
removed starter inning transfers exactly to bullpen exposure. `P_SS`, `P_FS`, `P_SF`,
`P_FF`, branch totals, and continuous FDS fields are diagnostic evidence for manual
review only. `STARTER_SURVIVAL_CALIBRATION_REPORT` later grades only preserved
pre-first-pitch snapshots, including whether each actual starter reached that workload.

`STARTER_SURVIVAL_V2_CALIBRATION_HISTORY` preserves a separate empirical v2
challenger beside v1. It learns only from strictly earlier settled observations:
survival rate, conditional workload shortfall, and observed conditional run
cost. It does not silently reapply the v1 `IP / 9` proxy when history is thin;
instead it records an explicit insufficiency. Its outputs are never board,
vehicle, market, projection, or authorization inputs.

Schema v49 freezes the genuine pregame away/home starter role in future V1
history records, allowing V2's strictly-earlier training parser to form role
and role-plus-workload cohorts without reconstructing older evidence. Legacy
roleless records remain usable only for workload/global cohorts. V2's recorded
`Failure_Run_Cost` is explicitly `DORMANT_UNCONSUMED`: connecting it to a
scenario total would be a future model change, not an instrumentation repair.

## Shadow distribution benchmark

Schema v50 adds `DISTRIBUTION_BENCHMARK_V1`,
`DISTRIBUTION_BENCHMARK_SUMMARY`, and `DISTRIBUTION_BENCHMARK_PAIRS`. They are
the first persisted benchmark for total-run distribution quality; earlier
conversational NB figures are not workbook evidence.

For each settled game, the benchmark uses only the immutable price-blind
`Base_Projection` as its location. It compares a Negative Binomial with
maximum-likelihood dispersion, a Poisson floor, and a discrete empirical
residual distribution. Every slate is fitted using only strictly earlier
settled frozen games, never games from that slate, and remains explicitly
`INSUFFICIENT_PRIOR_SETTLED_GAMES` until 100 earlier observations exist.

The benchmark records CRPS, log loss, deterministic discrete mid-PIT, 50/80/90
equal-tailed interval bounds and coverage, plus Brier score at each frozen
queried market threshold. A queried line is an evaluation threshold only: it
does not enter the fit, mean, alpha, intervals, or any price-blind baseball
calculation. Pairwise score comparisons use a descriptive two-sided sign test.
None of these tabs produces a live forecast, a custom run band, an adjustment,
a market view, a vehicle, or authorization.

### Direct-total distribution research V2

Schema v52 adds `GAME_TRUTH_DISTRIBUTION_V2`,
`GAME_TRUTH_DIST_LINES_V2`, `GAME_TRUTH_DIST_SUMMARY_V2`, and
`GAME_TRUTH_DIST_PAIRS_V2`, and `GAME_TRUTH_SLATE_DIAG_V2`. They retain the same frozen price-blind total as
the location for every comparator and use only strictly earlier settled frozen
games for distribution shape. They compare Poisson, NB, zero-hurdle NB,
mean-parameterized COM-Poisson, and the empirical residual benchmark.

The line surface is long-form by game, comparator, and standard total line.
Each probability therefore comes from one coherent PMF, so over probabilities
are monotone in the queried line rather than independent threshold classifiers.
The summary separately records randomized-PIT bins and high-side versus
low-side interval escapes. The zero-hurdle comparator exposes its historical
zero-total support; it cannot silently turn a no-zero corpus into a low-run
claim.

`GAME_TRUTH_DIST_PAIRS_V2` preserves within-game CRPS and log-score deltas
with a two-sided sign test. That is descriptive paired evidence, not a model
selection rule.

This is settlement research only. It has no active consumer and cannot change
the published center, create a live run band, alter a market view, select a
vehicle, or affect BET/PASS or authorization.

## Starter-window discrimination research

Schema v74 extends the six supporting Module 37 starter-window research
surfaces with two-sided material-error states, survival/detonation intervals,
conditional-severity intervals, and predeclared high-versus-low detonation
contrasts. It also adds exact phase and objective full-rep research grades to
the existing `GAME_TRUTH_REPLAY_V1`; it creates no new sheet or active
consumer. Schema v71 refined these surfaces with workload-normalized
starter scoring-rate error, separate allocation-inclusive error, and distinct
run-detonation versus workload-failure labels. Schema v70 originally added
`STARTER_WINDOW_ERROR_V1`,
`STARTER_WINDOW_ERROR_SUMMARY_V1`, `STARTER_WINDOW_FAILURE_BUCKETS_V1`,
`STARTER_WINDOW_PAIR_AUDIT_V1`, `STARTER_WINDOW_FEATURE_GOV_V1`, and
`STARTER_WINDOW_REPLAY_V1`. They join immutable pregame packet inputs to the
exact runs scored by each batting side while the opposing designated starter
was actually on the mound. MLB play-by-play current-pitcher attribution is
required; pitcher R/ER and final-score allocation are inadmissible substitutes.

Read feature governance before interpreting a cohort. Missing frozen
starter-side failure probabilities stay unavailable. A uniformly neutral
damage channel is labeled `INSTRUMENTATION_DEAD`, not “not responsible.” The
audit separates signed center bias from absolute and tail discrimination. It
cannot change a projection, confidence, market, vehicle, or authorization;
`Active_Input=NO` is a commissioning sentinel.

## Active starter role and workload

Schema v75 repairs the existing Module 03 input path without adding a module
or workbook surface. A pitcher named in the probable-starter slot remains a
starter assignment; low recent pitch volume no longer manufactures an
`OPENER` or `BULK` role. Numeric workload is estimated independently from up
to five cutoff-safe D-1 MLB starts using the already-frozen workload-v1
formula. Missing history falls back explicitly. Module 09 still consumes the
same `Expected_IP` contract and transfers exactly the remaining innings to the
bullpen; only the source truth behind that field changed. Historical frozen
packets retain their original role and workload values.

### SSAT family interpretation

`STARTER_SURVIVAL_DIFFERENTIATION_AUDIT` tests whether v2 has earned separate
interpretive weight from v1. It records v1/v2 total correlation and distance,
the share of games within 0.10, 0.25, and 0.50 runs, repeated survival-
probability profiles across distinct games, frozen cohort sizes/failures, and
descriptive associations with the captured starter-quality and opponent-
pressure fields.

Until that audit is reviewed and a future commissioning decision explicitly
says otherwise, **read v1 and v2 as one SSAT family—not two independent votes.**
State the base total and the SSAT family range; do not treat apparent v1/v2
agreement as extra corroboration. The audit is observational only and cannot
retire, promote, or alter either challenger automatically.

## Collision calibration ledger

`COLLISION_CALIBRATION_HISTORY` freezes the actual pre-first-pitch Statcast
collision observation for each legitimately mutable game: base allocation,
xwOBA companion, traffic, damage, tail adjustment, availability, and a
candidate-status field. A `SOURCE_UNAVAILABLE` or `INSUFFICIENT_INPUT` row is
an explicit evidence gap—its numerical zeroes must never be read as a neutral
collision signal. `COLLISION_CALIBRATION_REPORT` is written only at settlement
and compares the preserved base and available collision candidate against
actual total, actual team allocation, and the frozen market line. Neither tab
can modify the active projection, vehicle, or authorization.

## Pregame packet history

`PREGAME_PACKET_HISTORY` is the single replay-safe packet written immediately
before `VEHICLE_LOG`. It preserves the active allocation and total, captured
market state, decision, starters and expected innings, bullpen status, lineup
state, environment identity, and every shadow companion then available
(collision, low-center, SSAT v1, SSAT v2).

- `OPEN_PROSPECTIVE` may update only before that game starts.
- `FROZEN_PREGAME` is immutable; later refreshes cannot change a value in it.
- `MARKET_SNAPSHOT_MISSING` is a real research gap, not permission to fill in a
  later line during settlement.
- No row may be created or updated at or after first pitch.

This packet is provenance infrastructure only. It cannot change the active
projection, authorization, vehicle selection, or market interpretation.

### Reference and executable full-game totals

The literal reference-market snapshot is the standing research and postmortem
benchmark. Whole-number reference totals retain push semantics. Frostline also
preserves its historical lower-half representation (`10 -> 9.5`, `7 -> 6.5`)
as an explicitly synthetic/mechanical field; it is not substituted for the
literal research grade. A literal pregame Hard Rock quote supplied through
`OPERATOR_EVIDENCE_OVERLAY`, however, is stored exactly as supplied, along with
its explicit price, source, and quote timestamp when provided. It is never
normalized, converted, inferred, or synthesized from a reference-market row.
It is used only for the specific execution/vehicle decision in which it was
supplied and is not required for nightly settlement, replay, or regression.
Reference directional accuracy must never be described as proof that Frostline
beat the executable market. This distinction is market provenance only—never
an input to the baseball projection. Frozen packets and historical grades are
never rewritten.

Sept. 23 governance checkpoint: the standing reference-market directional
record was 8-8 (50.0%) across 16 settled games, or 8-7 (53.3%) when the
starter-unresolved `TOR_BAL_G2` observation is excluded. A separate manual,
opportunistic 13-game Hard Rock spot-check was 5-8 (Overs 3-6, Unders 2-2),
with `CIN_ATL` and `CHW_KCR` grading differently from the reference market.
This is evidence that the two market objects are not interchangeable; it is
not a permanent Hard Rock calibration corpus or proof of executable-market
performance.

### Pre-registered separation gate audit

`SEPARATION_GATE_AUDIT_V1` is a **shadow-only** settlement study. Its primary
cohort is frozen from the six price-blind `Truth_Checks` only: resolved
starters, expected innings, usable bullpen, usable offense source, usable
lineup data, and usable park source. It does not use the market margin,
Vehicle Score, direction, price, or the operational 1.5-run threshold to
define that cohort.

For every future frozen packet, Frostline stores continuous absolute
separation between the center and the queried total plus these fixed bins:

- `<0.75`
- `0.75–1.24`
- `1.25–1.49`
- `1.50–1.99`
- `≥2.00`

It also freezes the explicit adjacent comparison of `1.25–1.49` against
`1.50–1.74`. `SEPARATION_GATE_AUDIT_SUMMARY_V1` reports separate
walk-forward Wilson intervals for literal Hard Rock half-total evidence and
reference-only research. A reference line may be tagged
`NEAR_BOUNDARY_REFERENCE`, but it is never silently counted as Hard Rock
calibration evidence. A literal operator quote that is not a half total is
preserved exactly but is marked research-only rather than normalized or used
for Hard Rock calibration.

The existing 1.5-run authorization boundary remains operationally unchanged.
No future relaxation is implied by a single rate: it requires adequate samples
in both adjacent cohorts, persistent prospective results, and a later
probability-layer review of Brier/log-loss and structural moderators.

## Operator evidence and the full-game ladder

`OPERATOR_EVIDENCE_OVERLAY` is the durable intake surface for a fact supplied
by the operator before first pitch. One row represents **one field**, not an
entire game override. Use `MANUAL_OPERATOR` as the source and an ISO
`Supplied_TS` strictly before scheduled first pitch. Blank or late values do
nothing. The captured packet records the field, source, timestamp, and a
`REAUTHORIZATION_REQUIRED` marker so a later postmortem can distinguish a
model miss from stale upstream evidence.

Operator evidence is intentionally not an automatic projection coefficient.
It changes only the explicitly supplied packet representation and requires a
fresh human review of the affected game; it cannot silently rewrite unrelated
lineup, starter, park, weather, bullpen, market, vehicle, or authorization
fields.

`FULL_LADDER_AUDIT` freezes the independent full-game total review beside that
packet. Record the price-blind directional truth, low/center/high run band,
available Hard Rock half-number totals, preferred total vehicle, BET/PASS
decision, blocker, and reasoning source before first pitch. Current price is
execution metadata only. The ledger records `NO_WAGER_REPORTED` unless a wager
is explicitly reported; it must never infer a ticket.

At settlement, `FULL_LADDER_SETTLEMENT` grades every recorded half-number
threshold. That separates a direction failure from selecting a line that was
too aggressive, and also flags a winning vehicle whose allocation/mechanism
was wrong.

## How data actually moves

The operational tabs are pipeline-written value snapshots, not a network of spreadsheet formulas. “Feeds” below means that the pipeline consumes the same source or a prior module’s in-memory result and then writes the downstream snapshot.

```text
External pregame sources
  → DAILY_MATCHUPS / TODAY_LINEUPS / TEAM_FORM_INPUT
  → BULLPEN_USAGE_DAILY / RUN_ENVIRONMENT / ODDS_HISTORY
  → STATCAST_GAME_PREVIEW

Normalized evidence
  → GAME_INTEGRATION (team level)
  → GAME_SUMMARY (game level)
  → STATCAST_SHADOW_AUDIT (estimated range companion)

Projection + market/operator state
  → SLATE_INPUT
  → SLATE_BOARD
  → ACTIVE_BOARD_SNAPSHOT
  → BOARD_LOCK_STATE / VEHICLE_LOG / DECISION_AUDIT_LOG

Final results + frozen prospective state
  → SHADOW_OUTCOMES / PROJECTION_REPLAY
  → VEHICLE_POSTMORTEM / SURVIVAL_GATE_REPLAY / STARTER_AUDIT
  → REGRESSION_REPORT / MONOTONICITY
```

## Pregame input tabs

| Tab                     | Written                                       | Function                                                                                     | Relationship to SLATE_BOARD                                | Read efficiently                                                                       |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DAILY_MATCHUPS`        | Every publish, Module 08                      | Slate identity, pitchers, workload, weather, park, prior outing, umpire, and market context. | Mirrors evidence used by normalization and projection.     | Confirm date, games, starters, and source gaps first.                                  |
| `TODAY_LINEUPS`         | Every publish, Module 08                      | Posted/projected batting orders plus commissioned BVH split values, raw PA, prior, and status. | Same lineup payload becomes Module 09 lineup factors.      | Check official/projected status, MLBAM identity, split status, and coverage.            |
| `STARTING_NINE_TEAM_PAGE_V1` | Every legitimate pre-first-pitch publish, Module 08c | Current-state Starting Nine team-page starter identity and descriptive opposing-pitcher split, park, and umpire context; exact mutable-game HTML chronology is retained in the existing source ledgers. | Only an MLBAM-verified named starter may fill an otherwise unresolved MLB probable-pitcher slot; every other statistic is display-only. | Verify `Starter_Fallback_Applied`, identity/source status, `Active_Input=NO`, and `Mapping_Status=DISPLAY_ONLY_NOT_PROJECTION_INPUT`; use `SOURCE_ACQUISITION_LOG` for refresh chronology. |
| `TEAM_FORM_INPUT`       | Every publish, Module 08                      | Recent team run-rate and form baselines.                                                     | Feeds Module 09 offense rates.                             | Audit when recent form appears to dominate allocation.                                 |
| `BULLPEN_USAGE_DAILY`   | Every publish, Module 08                      | Starting Nine daily status + five-day pitch map, matched innings history, and quality context. | Feeds bullpen innings and continuation components.         | Start with AVAILABLE/TIRED/UNAVAILABLE; pitch map is primary, ITP is history fallback. |
| `RUN_ENVIRONMENT`       | Every publish, shared resolver                | Park, weather, roof, wind, certainty, run multiplier, and HR factor.                         | Module 09 consumes the same resolver result.               | Check fallback and roof/weather vehicle status; environment cannot originate a thesis. |
| `ODDS_HISTORY`          | Append every publish, Module 05d              | Opening and subsequent total snapshots.                                                      | Supplies movement and line provenance, not baseball truth. | Earliest daily row is opener; compare timestamps before calling a line stale.          |
| `STATCAST_GAME_PREVIEW` | Every publish when available, Modules 02e/08b | Timestamped Savant identity, pitcher metrics, hitter aggregates, and parser status.          | Feeds estimate/audit surfaces, not direct authorization.   | Verify identity, lineup status, and pre-first-pitch timestamp.                         |
| `SOURCE_ACQUISITION_LOG` | Append before a newly connected source can fill a gap | Request/cutoff/hash/schema/coverage/parser/fallback/raw-storage provenance. | No board input; validates the evidence behind a source-derived fallback. | Require `STORED`, a valid schema status, and a pregame data-through date. |
| `SOURCE_RAW_SNAPSHOT` | With each retained source response | Chunked untouched external payload, keyed by `Snapshot_ID`. | Never a direct model or board input. | Use only to reproduce parser/feature behavior for a specific source snapshot. |
| `BVH_DAILY_HISTORY_V1` | After each retained Savant daily response | PA-reduced batter-versus-pitcher-hand outcome counts with immutable snapshot lineage. | No direct board input; evidence ledger for BVH. | Confirm PA counts, cutoff, and canonical source snapshot. |
| `BVH_BATTER_SPLITS_V1` | Rebuilt every pregame run | Raw split rates, prior, k=150 shrinkage, freshness, parser counters, and deterministic hash. | Populates TODAY_LINEUPS split evidence; no independent run bonus. | Read raw PA, prior source, weight, status, and cutoff together. |

## Projection and decision tabs

| Tab                                       | Written                                                              | Function                                                                                                            | Relationship to SLATE_BOARD                                                                                                     | Read efficiently                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GAME_INTEGRATION`                        | Every publish, Module 09                                             | Two rows per game, combining evidence at team level.                                                                | Creates the away/home allocations summarized downstream.                                                                        | Use when the total and team ownership disagree.                                                                                                  |
| `GAME_SUMMARY`                            | Every publish, Module 09                                             | One-row active projection and component lineage.                                                                    | Primary projection input to Module 11.                                                                                          | Reconcile away + home = total and baseball-only + environment = total.                                                                           |
| `PLAYER_INTEGRATION`                      | Every publish, Module 09                                             | Per-batter identity, opponent, environment, statistics, and explicit gaps.                                          | Supports lineup-factor audit, not authorization.                                                                                | Use for player matching and missing-stat diagnosis.                                                                                              |
| `BVH_PROJECTION_HISTORY_V1`               | Every legitimate pre-first-pitch Module 09 run                       | Active coarse-platoon versus shadow-only BVH candidate team runs and exact starter-window split factors.             | No projection or decision consumer before the N=200 paired promotion review.                                                   | Inspect high deltas, identity/50-PA coverage, freshness, and opener-chain uncertainty.                                                            |
| `STATCAST_SHADOW_AUDIT`                   | Every publish after Module 09, Module 09s                            | Starter xwOBA, estimated traffic/damage tail adjustments, and a shadow-only low-center volatility audit.            | Provides the tentative range companion and a manual distribution-risk warning; never changes the active total or authorization. | Compare `Current_Projection` and `Estimated_Projection`; when flagged, inspect both challengers, upper-tail band, reason tags, status, and caps. |
| `LOW_CENTER_CALIBRATION_HISTORY`          | Append every pregame Module 09s run for a low-center game            | Timestamped base, +1.50 primary, and +2.00 sensitivity candidates.                                                  | No board input; preserves evidence for settlement.                                                                              | Only a row strictly before its scheduled first pitch is valid prospective evidence.                                                              |
| `LOW_CENTER_CALIBRATION_REPORT`           | Settlement, Module 14                                                | Actual-result comparison of preserved base and challenger projections.                                              | No board input; calibration evidence only.                                                                                      | Compare each candidate's absolute error over a sufficient prospective sample; never promote on an isolated slate.                                |
| `COLLISION_CALIBRATION_HISTORY`           | Every legitimate pre-first-pitch Module 09s run                      | Frozen real Statcast traffic/damage/xwOBA collision evidence plus availability status.                              | No board input; preserves actual candidate inputs for settlement.                                                               | Only `PROSPECTIVE_SHADOW_CANDIDATE` is comparable; unavailable source rows are not zero evidence.                                                |
| `COLLISION_CALIBRATION_REPORT`            | Settlement, Module 14                                                | Base-versus-collision total, allocation, and market-direction result.                                               | No board input; promotion-or-retirement evidence only.                                                                          | Read candidate error only where a valid prospective candidate exists.                                                                            |
| `STARTER_SURVIVAL_CALIBRATION_HISTORY`    | Every pre-first-pitch Module 09t run                                 | Four-state workload branch totals, probabilities, and continuous failure-dependency scores.                         | No board input; manual-review evidence only.                                                                                    | `p = clamp(Projected_Starter_Innings / 9, 0, 1)` is temporary and must be tested prospectively.                                                  |
| `STARTER_SURVIVAL_CALIBRATION_REPORT`     | Settlement, Module 14                                                | Actual-total comparison and starter survival grading from history.                                                  | No board input; challenger evidence only.                                                                                       | Cannot reconstruct or backdate a missing pregame candidate.                                                                                      |
| `STARTER_SURVIVAL_V2_CALIBRATION_HISTORY` | Every pre-first-pitch Module 09u run                                 | Empirical survival probability and conditional workload-failure severity.                                           | No board input; v2 shadow evidence only.                                                                                        | Uses strictly earlier settled records only; no v1 proxy fallback.                                                                                |
| `STARTER_SURVIVAL_V2_CALIBRATION_REPORT`  | Settlement, Module 14                                                | Base vs SSAT v1 vs SSAT v2 outcome comparison.                                                                      | No board input; calibration evidence only.                                                                                      | Inspect cohort provenance and actual starter workload before interpreting results.                                                               |
| `STARTER_SURVIVAL_DIFFERENTIATION_AUDIT`  | Every pregame Module 09v run                                         | Correlation/difference, repeated-probability, cohort-provenance, and descriptive-input audit for SSAT v1/v2.        | No board input; it cannot alter a challenger or decision.                                                                       | Treat V1/V2 as one SSAT evidence family until an explicit commissioning review demonstrates material differentiation.                            |
| `SLATE_INPUT`                             | Every publish, Module 10                                             | Model scores plus operator vehicle, line, odds, notes, and frozen market state.                                     | Direct input to Module 11.                                                                                                      | Operator owns O–W; authoritative pregame line outranks stale display Line after freeze.                                                          |
| `SLATE_BOARD`                             | Every publish for mutable games, Module 11                           | Complete decision output, blockers, gate, lock, and lineage.                                                        | It is the full decision board.                                                                                                  | Never read Decision without projection, line, tentative range, blocker, and lock state.                                                          |
| `ACTIVE_BOARD_SNAPSHOT`                   | Every publish, Module 11                                             | Condensed currently authorized entries.                                                                             | Filtered view; does not create authorization.                                                                                   | Execution shortcut only after reviewing `SLATE_BOARD`.                                                                                           |
| `BOARD_LOCK_STATE`                        | At each game’s lock, Module 11                                       | Immutable record of final authorization and lock provenance.                                                        | Records the single authorization source.                                                                                        | Use to resolve contradictory displays; lock never invents CORE/BET.                                                                              |
| `VEHICLE_LOG`                             | Frozen after board publication, Module 17                            | Prospective vehicle, projection, line, direction, and decision.                                                     | Preserves what the board actually published.                                                                                    | Historical grading must use this, not a later recalculation.                                                                                     |
| `PREGAME_PACKET_HISTORY`                  | Every legitimate pre-first-pitch publish, Module 20a                 | Complete active projection, market, allocation, starter/bullpen, lineup, environment, and shadow-dependency packet. | Provenance only; it is written before vehicle publication and cannot alter authorization.                                       | `OPEN_PROSPECTIVE` may refresh before first pitch; `FROZEN_PREGAME` is immutable; missing market is explicit.                                    |
| `OPERATOR_EVIDENCE_OVERLAY`               | Operator input before first pitch; Module 20b captures it on publish | Durable field-level authoritative operator evidence.                                                                | No direct board input; it marks the packet for reauthorization/review without changing active math.                             | One row per supplied fact; use `MANUAL_OPERATOR` and an ISO pre-first-pitch timestamp.                                                           |
| `FULL_LADDER_AUDIT`                       | Pregame publish / freeze, Module 20b                                 | Immutable manual full-game half-number total ladder and BET/PASS rationale.                                         | Shadow decision evidence only; cannot create a ticket or live authorization.                                                    | Record run band and available lines before first pitch; price is metadata, not truth.                                                            |
| `DECISION_AUDIT_LOG`                      | Pregame publish and settlement, Module 20                            | Model, manual overlay, canonical/noncanonical human-truth provenance, authorization, result, and independent grades. | Consumes the authoritative decision and records why; human truth remains non-consuming.                                          | OPEN may update; frozen pregame evidence may not. Only canonical research freezes pass the P50/allocation/freeze/hash grading gate; chat evidence remains research-only. |

## Run-health and documentation tabs

| Tab                 | Written                          | Function                                                               | Board relationship                 | Read efficiently                          |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| `RUN_LOG`           | End of every publish, Module 12  | Run identity, schema, statuses, counts, errors, and warnings.          | Certifies the board-producing run. | Read before trusting any refreshed slate. |
| `SHADOW_VALIDATION` | Every publish, Module 12s        | Current repaired-versus-legacy comparison.                             | Audit only.                        | Look for unexpected candidate drift.      |
| `SHADOW_HISTORY`    | Append every publish, Module 12s | Historical validation snapshots.                                       | Audit only.                        | Use for drift over time, not execution.   |
| `MODEL_INPUT_CATALOG` | Schema repair; source materialization checked on pregame publish | Canonical source, window, projection-class, freshness, correlation, and missing-input registry. | Documentation and source health only. | Start here before adding/trusting a stat; confirm it is active and not a correlated alias. |
| `SCHEMA_REFERENCE`  | Schema documentation repair      | Column dictionary, ownership, formats, and descriptions.               | Documentation only.                | Use for exact column meaning.             |
| `README`            | Schema documentation repair      | Orientation, quick order, cautions, and one-row summary for every tab. | Documentation only.                | Start here after time away.               |

## Settlement and learning tabs

| Tab                                 | Written                      | Function                                                                                                                        | Board relationship                                                 | Read efficiently                                                                                                                             |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHADOW_OUTCOMES`                   | Daily settlement, Module 14  | Frozen projection, final score, errors, direction, and pitcher provenance.                                                      | Grades prospective state without rerunning it.                     | Primary settled truth table.                                                                                                                 |
| `PROJECTION_REPLAY`                 | Daily settlement, Module 14  | Frozen-published per-game replay.                                                                                               | Measures the board that actually existed.                          | Compare frozen and repaired projections explicitly.                                                                                          |
| `VEHICLE_POSTMORTEM`                | After settlement, Module 17  | Ticket, truth, capture, blocker, and mechanism grades.                                                                          | Grades vehicle and authorization separately.                       | `VEHICLE_LOG` is primary. If no post-lock publish occurred, a matching timestamp-valid `DECISION_AUDIT_LOG` + canonical pregame packet may supply the postmortem row only; neither frozen source is rewritten. Pushes are neutral and passed winners are not automatically bad passes. |
| `SURVIVAL_GATE_REPLAY`              | Settlement/replay, Module 18 | Over survival-floor regrading with provenance.                                                                                  | Audits one gate without rewriting history.                         | Distinguish baseball-supported and environment-dependent Overs.                                                                              |
| `ALLOCATION_SETTLEMENT_DIAGNOSTICS` | Daily settlement, Module 24  | Frozen away/home/total/margin versus actuals and raw allocation reversals.                                                      | Diagnostic only.                                                   | Read alongside total error; canceled allocation errors can hide a wrong game read.                                                           |
| `STARTER_OUTCOME_DIAGNOSTICS`       | Daily settlement, Module 24  | Separate workload, traffic, contact availability, damage, run prevention, K/whiff, and exit evidence.                           | Diagnostic only.                                                   | Never treat a workload shortfall as a generic pitcher failure.                                                                               |
| `BULLPEN_TIMING_DIAGNOSTICS`        | Daily settlement, Module 24  | Starter exit, pitcher-charged starter R, residual team runs, inning bands, extra innings, and actual bullpen-chain shape.         | Diagnostic only.                                                   | Legacy run fields are not exact on-mound phases when inherited runners score; use Module 32 for phase inference.                              |
| `BULLPEN_PHASE_COVERAGE_V1`         | Daily settlement, Module 32  | Mandatory pre-analysis audit of exact on-mound phase observability, starter identity, actual/frozen innings, and exclusions.    | Research governance only.                                          | Pitcher R/ER is not the exact starter-window definition; require validated PBP reconstruction and matched starter identities.                |
| `BULLPEN_PHASE_COVERAGE_SUMMARY_V1` | Daily settlement, Module 32  | Compact direct/reconstructed/usable coverage counts and inherited-runner diagnostics.                                           | Research governance only.                                          | Inferential replay stops unless usable N >= 100 and coverage >= 50%.                                                                           |
| `BULLPEN_PHASE_REPLAY_V1`           | Daily settlement, Module 32  | Exact starter/post-starter phase error, frozen-versus-actual workload state, and leave-one-slate-out environment per game.       | Research only; no active consumer.                                 | The evaluated slate never contributes to its own environment benchmark.                                                                        |
| `BULLPEN_PHASE_ANALYSIS_V1`         | Daily settlement, Module 32  | Overall/main-effect/interaction phase comparison with slate-block CIs and one governed A/B/C/D/E verdict.                        | Research priority only; no feature promotion.                      | N<15 interaction cells are descriptive only; read main-effect and interaction power statuses separately.                                      |
| `ALLOCATION_BRIDGE_V1`              | Daily settlement, Module 33  | Fixed-total challenger built from frozen offense identity and half-strength opponent-system evidence with component lineage.    | Research only; no active consumer.                                 | Require fixed-total invariant PASS; missing older component packets remain excluded.                                                          |
| `ALLOCATION_BRIDGE_REPLAY_V1`       | Daily settlement, Module 33  | Legacy-versus-bridge team allocation scoring against canonical finals while the frozen total stays unchanged.                   | Research only; no active consumer.                                 | Compare side accuracy, team MAE, and run-differential MAE; total error is identical by construction.                                           |
| `ALLOCATION_BRIDGE_SUMMARY_V1`      | Daily settlement, Module 33  | Overall and declared strength, lineup, role, bullpen-data, and total-error cohort comparison with one research verdict.         | Research verdict only; never automatic promotion.                 | Read overall and TOTAL_GOOD_ALLOCATION_BAD rows before subgroup detail.                                                                        |
| `ALLOCATION_BRIDGE_DIAG_V1`         | Daily settlement, Module 33  | Per-game allocation miss taxonomy, evidence status, dominant driver, and named Sept. 13 case flags.                             | Postgame diagnosis only.                                           | Do not force a mechanism when evidence is insufficient; known damage inactivity stays explicit.                                               |
| `CONVERSION_SETTLEMENT_DIAGNOSTICS` | Daily settlement, Module 24  | Per-team hits, walks/HBP, baserunners, HR/XBH, actual runs, and frozen collision signal.                                        | Diagnostic only.                                                   | Separate access from conversion. `UNAVAILABLE_FROM_MLB_BOXSCORE` contact values are gaps, not neutral evidence.                              |
| `GAME_TRUTH_REPLAY_V1`              | Daily settlement, Module 24 plus Module 37 starter-window support | Frozen-packet replay joining total/allocation error, starter paths, conversion outcomes, exact Module 32 phase outcomes, and objective full-rep postmortem grades. | Shadow-only diagnosis; no confidence or decision consumer. | Legacy phase fields remain descriptive. Exact phase fields use Module 32 PBP. Vehicle grades require a frozen literal executable line; chat-only causal detail is never backfilled. |
| `BVH_PROJECTION_REPLAY_V1`          | Daily settlement, Module 31  | Grades only prospectively frozen existing-versus-BVH team and total projections.                                                | Research only; missing pregame BVH is never reconstructed.         | Review total and allocation changes together; material rows retain exact batter-driver traces.                                                |
| `BVH_PROJECTION_SUMMARY_V1`         | Daily settlement, Module 31  | Descriptive BVH comparison by opposing hand, coverage, and chain-uncertainty cohort.                                             | No promotion or authorization consumer.                            | N<200 is descriptive; N=200 starts the declared paired promotion review and does not auto-promote.                                           |
| `FULL_LADDER_SETTLEMENT`            | Daily settlement, Module 24  | Every frozen half-number total counterfactual plus selected/adjacent vehicle grade.                                             | Diagnostic only; `NO_WAGER_REPORTED` remains distinct from result. | Use it to separate direction, threshold, and mechanism outcomes.                                                                             |
| `SHADOW_TRUTH_DIRECTION_V1`         | Pregame capture and daily settlement, Module 35 | Prospectively preserves the existing projection-versus-literal-line direction independently of BET/PASS/NO_CALL and grades only that stored record. | Research only; no projection, authorization, vehicle, stake, or operational-decision consumer. | Read line status and packet lineage first. Reference/proxy lines never replace missing literal executable evidence; exact ties, missing executable lines, and missing prospective records remain `UNGRADABLE`. |
| `SHADOW_TRUTH_SUMMARY_V1`           | Daily settlement, Module 35  | Per-slate directional record overall and by BET, PASS, NO_CALL, and existing frozen structural cohorts.                         | Research calibration only; never promotes a wager.                 | `PUSH` and `UNGRADABLE` are excluded from directional accuracy; zero NO_CALL rows means no operator NO_CALL state was frozen.                |
| `ACTIVE_PITCHING_INVENTORY_V1`      | Legitimate pre-first-pitch publish, Module 36 | Named starter plus source-supported bulk/swing identity when explicitly designated, active-roster multi-inning options, availability, workload provenance, and starter/bulk/true-bullpen phase allocation. | Research only; `Active_Input=NO` and no Module 09 or decision consumer exists. | Availability and history alone remain `[ROSTER_HISTORY_ONLY]`; they cannot name an expected bulk pitcher or create a shadow delta. Never reconstruct a missing pregame chain from postgame pitcher order. |
| `ACTIVE_PITCHING_INVENTORY_SUMMARY_V1` | Legitimate pre-first-pitch publish, Module 36 | Untouched production team/total projection beside the API chain shadow and isolated phase-reallocation delta. | Research comparison only; never overwrites `GAME_SUMMARY` or frozen packets. | Interpret only `PROSPECTIVE_SHADOW_ELIGIBLE` rows; older proof cases without retained pregame inventory are non-replayable. |
| `ACTIVE_PITCHING_INVENTORY_REPLAY_V1` | Daily settlement, Module 36 | Grades prospectively frozen API rows against team scores and actual starter/bulk/true-bullpen phases; preserves canonical proof cases as non-observable audits. | Research only; never reconstructs or promotes a chain. | Only `PROSPECTIVE_SHADOW_SETTLED` rows enter metrics. |
| `ACTIVE_PITCHING_INVENTORY_REPLAY_SUMMARY_V1` | Daily settlement, Module 36 | Production-versus-API accuracy overall and by pitching-plan type, with separate phase diagnostics. | Research verdict only; no automatic promotion. | `INSUFFICIENT_PROSPECTIVE_API_HISTORY` is expected until live shadows settle. |
| `STARTER_AUDIT`                     | After settlement, Module 16  | Starter-level error and provenance.                                                                                             | Learning only.                                                     | Study repeated survival/failure patterns, not one result.                                                                                    |
| `REGRESSION_REPORT`                 | After settlement, Module 15  | MAE, median error, bias, miss rate, and projection direction summaries.                                                         | Reliability evidence only.                                         | Separate total accuracy from allocation and winner accuracy.                                                                                 |
| `MONOTONICITY`                      | With regression, Module 15   | Directional hit rate by frozen edge tier.                                                                                       | Its adequately sampled verdict governs authorization availability. | Verify sample size before trusting the verdict.                                                                                              |

## Explicit replay tabs

| Tab              | Written                   | Function                                                                      | Board relationship          | Read efficiently                                           |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `REPLAY_RESULTS` | Explicit Module 13 replay | Date-anchored baseline-versus-candidate game results with weather provenance. | Offline commissioning only. | Replay may never impersonate missing prospective evidence. |
| `REPLAY_METRICS` | Each Module 13 replay     | Aggregate variant accuracy, bias, direction, and calibration.                 | Offline commissioning only. | Compare multiple metrics and total bands, not MAE alone.   |

## Non-negotiable reading rules

- Confirm the date and Game_ID on every downstream row; row count alone is not validation.
- A green workflow is not enough—read `RUN_LOG` and current-slate timestamps.
- Preserve the distinction between active projection, tentative estimate, frozen publication, and postgame replay.
- Never let park/weather, a starter label, or a single candidate estimate manufacture game truth.
- Grade total accuracy, team allocation, vehicle capture, authorization, and ticket outcome separately.
