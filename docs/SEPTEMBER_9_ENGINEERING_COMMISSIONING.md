# September 9 Frostline postmortem — ordered engineering report

Status: superseded for workload promotion by `STARTER_WORKLOAD_FINAL_COMMISSIONING_PASS.md`. The authoritative workbook and every frozen September 9 packet remain untouched. The pitcher-specific estimator remains shadow-only pending one legitimate live settlement. No global run correction, environment change, authorization change, or active workload deployment was made.

Evidence scope:

- authoritative `PREGAME_PACKET_HISTORY`, `STARTER_OUTCOME_DIAGNOSTICS`, `GAME_TRUTH_REPLAY_V1`, `STARTER_SURVIVAL_V2_CALIBRATION_HISTORY`, and source-provenance sheets;
- source and consumer tracing in Modules 02, 02g, 02h, 03, 04b, 09, 09t, 09u, 24, 26, 28, and 29;
- the already-frozen prospective workload shadow for September 7–9;
- local candidate tests and build.

## A. STARTER_WORKLOAD repair candidate

### Root cause and repair boundary

The established BUG is exact: Module 03 uses L30 pitch magnitude to assign `OPENER`, `BULK`, or `CONVENTIONAL_STARTER`, then replaces the numeric workload with 25/1.2, 55/3.0, or 92/6.0. The local candidate changes only that final numeric boundary.

The candidate deliberately reuses the already-frozen Workload State V1 formula and source inputs rather than promoting SWE:

1. Admit only official MLB game-log appearances dated before the game and no later than D-1.
2. For a conventional starter, prefer prior starts; for opener/bulk usage, retain prior appearances because relief usage is relevant to the declared role.
3. Use at most five appearances with normalized recency weights 0.50/0.30/0.20/0.10/0.05.
4. Shrink samples smaller than five toward the existing role/return prior with `history_weight = n / 5`.
5. Preserve the existing short-rest reduction of 0.50 IP and extended-rest/return reduction of 0.75 IP.
6. Preserve the existing role bounds as guards: opener 0.70–2.25 IP, bulk 1.50–5.00 IP, conventional starter 3.00–7.50 IP.
7. Derive expected pitches from the same weighted recent evidence and shrinkage. Workload dispersion is retained as a diagnostic; it does not alter the point estimate.
8. If the game-log fetch fails or no role-relevant admissible appearance exists, retain the declared prior and an explicit fallback state. A `no_games_in_window` pitcher remains on the existing 85-pitch/5.5-IP missing-evidence prior.

Role is therefore still a label, prior, bound, and missing-data fallback. It is no longer the normal numeric estimator.

Code changed:

- `module03_numericWorkload.ts`: isolated deterministic estimator and audit values.
- `module03_pitcherClassification.ts`: was restored to the commissioned legacy active workload so the candidate can be evaluated independently in shadow.
- `module02g_workloadState.ts`: consumes the candidate and freezes it beside the unchanged active workload.
- `module03_numericWorkload.test.ts`: cutoff, shrinkage, rest, non-degeneracy, and named September 9 cases.
- `module03_pitcherClassification.test.ts`: proves Module 03 remains unchanged while the candidate is shadow-only.

No Module 09 formula, environment input, BVH input, bullpen-quality formula, distribution, gate, vehicle, or authorization code changed.

### Preserved prospective comparison

There are 65 settled starter observations from September 7–9 for which both the legacy workload and the frozen Workload State candidate exist. This is the legitimate comparison population; older packets are not reconstructed.

| Population | N | Legacy MAE | Candidate MAE | Legacy median AE | Candidate median AE | Legacy bias | Candidate bias | Legacy >=2 IP | Candidate >=2 IP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All eligible | 65 | 1.185 | 1.135 | 1.000 | 0.960 | +0.736 | +0.297 | 20 | 10 |
| Conventional starter | 57 | 1.186 | 1.161 | 1.000 | 0.960 | +0.999 | +0.416 | 16 | 10 |
| Bulk | 5 | 1.200 | 1.028 | 2.000 | 1.140 | -1.200 | -0.552 | 3 | 0 |
| Opener | 3 | 1.157 | 0.817 | 0.470 | 0.400 | -1.023 | -0.550 | 1 | 0 |

Rest-state behavior is mixed and must remain visible:

| Rest state | N | Legacy MAE | Candidate MAE | Legacy median AE | Candidate median AE | Legacy bias | Candidate bias | Legacy >=2 IP | Candidate >=2 IP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Standard rest | 46 | 1.047 | 1.163 | 1.000 | 1.010 | +0.751 | +0.365 | 11 | 7 |
| Extra rest | 15 | 1.698 | 1.036 | 2.000 | 0.810 | +0.658 | +0.247 | 8 | 2 |
| Return from extended rest | 4 | 0.858 | 1.190 | 0.615 | 1.040 | +0.858 | -0.300 | 1 | 1 |

The candidate improves overall MAE, median error, bias, and especially the large-error count. It does not win every subgroup: standard-rest and extended-rest MAE are worse in this small sample. That is evidence to preserve, not a reason to tune after seeing it.

Across the full current packet ledger, 432 of 448 resolved pitcher slots (96.4%) still equal the exact role default. In the eligible 65-observation comparison, the legacy default-saturation rate is 62/65 (95.4%); the candidate rate is 0/65. All 54 ordinary, non-returning conventional starters in the eligible comparison receive a pitcher-specific value.

### Named September 9 regression cases

| Pitcher | Legacy IP | Candidate IP | Actual IP | Interpretation |
|---|---:|---:|---:|---|
| Griffin Jax | 3.00 | 4.19 | 5.00 | bulk default materially understated the recent starter pattern |
| Daniel Lynch IV | 3.00 | 4.25 | 5.00 | bulk default materially understated workload |
| Davis Martin | 3.00 | 3.86 | 5.00 | moves in the correct direction without pretending the last start is the estimate |
| Janson Junk | 3.00 | 4.19 | 3.00 | legitimate adverse case: the legacy default happened to match the outcome |
| Andre Pallante | 6.00 | 5.52 | 5.00 | pitcher-specific evidence reduces the overstatement |
| Walker Buehler | 6.00 | 5.30 | 2.33 | improves but does not capture the full shortfall |
| Cody Bradford | 6.00 | 4.80 | 4.00 | pitcher-specific evidence improves allocation |
| Kade Anderson | 6.00 | 5.36 | 6.00 | legitimate adverse case: the default happened to match |
| Zac Gallen | 5.50 | 5.11 | 3.33 | return guard remains but is not a fixed answer |
| Reynaldo López | 5.70 | 4.37 | 4.67 | return guard plus pitcher history improves the estimate |

### Downstream effect

Across the 65 eligible starters, expected starter exposure falls by 0.439 IP on average and expected bullpen exposure rises by the same 0.439 IP. This is a transfer between baseball phases, not a global run correction.

The September 9 test-copy mechanical replay is the only current slate with all required frozen per-team factors available without reconstructing older packets. Across 15 games:

- mean absolute total-projection change: 0.118 runs;
- maximum absolute game change: 0.26 runs;
- games changing by at least 0.50 runs: 0;
- slate-total change: -0.97 runs.

The candidate repairs inning ownership while leaving the run environment essentially intact.

### Promotion recommendation

**HOLD pending live shadow settlement.** The bug is proven, the candidate is source-safe and non-degenerate, and the preserved replay improves the full comparison while halving >=2-IP misses. The mixed rest subgroups remain visible. Promotion is not decided until the next legitimate pregame packet freezes the candidate independently and settlement grades both estimates.

## B. Recent starter condition audit

### What Frostline has now

| Evidence | Cutoff/coverage | Retained fields | Active consumption |
|---|---|---|---|
| MLB Stats API pitcher game log | fetched per expected pitcher; filtered through D-1 | date, gamePk, starter flag, IP/outs, pitches, batters faced, rest derivable | workload/role only |
| `STARTER_PREVIOUS_OUTING` | D-1 | latest start date, IP, pitches, rest/stress | display/diagnostic only |
| MLB season pitcher stats | season-to-date | ERA, FIP, K%, BB%, WHIP, HR/9, innings | active season baseline for quality, traffic, and damage |
| Savant pitch-level raw store | current retained daily coverage 2026-09-01 through 2026-09-08; 33,078 pitch rows | all returned headers, including identity, pitch/result, swing/whiff, batted-ball, velocity, movement, location, and TTO fields where populated | source store; SWE/BVH derivation, no recent-starter active effect |
| Savant pitcher expected leaderboard | season-to-date snapshot | xERA/xwOBA/xBA/xSLG and samples | cutoff-gated fallback only when traditional fields are missing; no active September 9 lineage |
| Postgame starter diagnostics | settled games only | actual workload, command/traffic, damage, run prevention; boxscore contact unavailable | settlement diagnosis only |

The game-log response is not stored raw by Module 02, and its current parser discards appearance-level H, BB, HBP, K, HR, R, and ER fields even if present in the upstream payload. The Savant raw lake is immutable and rich, but only eight retained days currently exist. That is sufficient for plumbing and selected recent appearances, not a legitimate season/L5 comparison for the full pitcher population.

### Active path finding

No detailed recent-start condition object feeds the active projection. Starter run prevention is FIP -> ERA -> cutoff-eligible xERA fallback -> league neutral. Traffic uses season BB/K/WHIP plus current lineup interaction. Damage uses season HR/9 plus current lineup hard-hit interaction. The current recent-start evidence affects workload only.

### Smallest shadow-only representation

Build one D-1 `STARTER_APPEARANCE_SPINE` keyed by `(gamePk, pitcher_mlbam_id)`:

- extend the official game-log parser and raw snapshot to retain H, BB, HBP, K, HR, R, and ER with workload fields;
- join Savant pitches by the same gamePk/pitcher identity for whiff, swing, velocity, movement, hard-hit, barrel, EV, xBA, and xwOBA evidence;
- preserve L3, L5, and season baselines only when coverage genuinely exists;
- express separate deltas for traffic, command, damage, whiff, workload, and run prevention relative to the pitcher's own season baseline;
- emit confidence, sample, freshness, and explicit missing-component states; do not emit one generic recent-form run adjustment.

Validation target: next-start traffic, starter runs, damage events, workload shortfall, and catastrophic failure conditional on the existing season baseline. September 9 HOU–PHI remains one challenge case, not a fitted target.

Recommendation: **READY FOR PROSPECTIVE SHADOW after the appearance-spine persistence gap is repaired; no active coefficient.** A legitimate historical replay cannot yet be claimed because complete cutoff-safe appearance features were not frozen before September 1.

## C. Failure / ceiling audit

### Existing objects and consumers

| Object | What it represents | Consumer status |
|---|---|---|
| `FAILURE_CLASSIFICATION_SHADOW_V1` | opener uncertainty, starter-vs-bullpen path, traffic/damage co-sign, structural risk tags | labels/replay only |
| SSAT V1 | four independent starter survival/failure states; survival probability is Expected IP / 9; failure transfers one inning to the same bullpen mean | shadow total only |
| SSAT V2 | empirical starter survival probability and failure shortfall; computes empirical failure run cost | shadow total; failure run cost is stored but dormant/unconsumed |
| Module 29 direct-total distribution | Poisson/NB/hurdle-NB/CMP/empirical residual PMFs centered on the frozen published total with expanding-window global shape fits | research-only; no game-specific compound state mixture |
| Module 24 diagnostics | actual starter/bullpen phases and error taxonomy | settlement only |

SSAT can represent starter `SS/FS/SF/FF`, but assumes starter survival independence. It cannot cross those states with bullpen normal/failure. Its branch total only shortens a starter and hands the inning to the same fixed bullpen-quality mean.

The disconnection is measurable. In 238 valid SSAT V2 rows:

- mean stored away failure run cost: 2.038 runs;
- mean stored home failure run cost: 2.047 runs;
- mean `T_FS - T_SS`: -0.039 runs;
- mean `T_SF - T_SS`: -0.081 runs;
- mean `T_FF - T_SS`: -0.120 runs;
- the maximum observed absolute `T_FF - T_SS` is only 1.73 runs;
- `T_FF` is lower than `T_SS` in 145/238 rows.

So the empirical severity exists, but it does not reach the scenarios. This remains the previously classified dormant-consumption gap; connecting it directly would be a model change and is not authorized here.

Across 203 verified game-truth replay rows, 44 games are high-side misses of at least four runs versus 26 low-side misses of at least four. On September 9, six games are high-side 4+ misses and two are low-side 4+ misses. Of the six high-side misses, five have a material starter-window underprojection, five have a material bullpen-window underprojection, and four have both under the current two-run diagnostic threshold.

The current direct-total PMF can widen around a total, but it cannot preserve which offense owns the tail. It therefore cannot natively distinguish the one-sided CIN–LAD script from the two-sided NYM–MIA script. SSAT permits one or both starters to fail, but not a state-contingent bullpen cascade; HOU–PHI magnitude is compressed for the same reason.

### Smallest shadow experiment

Create no coefficient and no replacement center. Add a strictly observational `COMPOUND_FAILURE_STATE_REPLAY_V1` with:

1. frozen SSAT V2 starter probabilities and frozen phase expectations;
2. four starter states: SS, FS, SF, FF;
3. four settled bullpen states using the existing two-run material phase-error threshold: neither bullpen overruns, away only, home only, both;
4. the resulting 16 state cells, preserving team side, actual residual, one-sided/two-sided allocation, and state frequency;
5. expanding-window estimates only after future pregame bullpen-state features are frozen.

This is the smallest design that can separately observe CIN–LAD, NYM–MIA, and HOU–PHI mechanisms. Its first question is whether compound states have systematically larger residuals than the current scenario totals imply. It has no projection, authorization, or betting consumer.

Recommendation: **READY FOR PROSPECTIVE SHADOW; active center change HOLD.**

## D. Bullpen state audit

### Current representation

Frostline has meaningful availability evidence but only a mean-like deployment model:

- Starting Nine supplies explicit available/tired/unavailable state and five daily pitch-count markers;
- Inside The Pen can supplement seven-day innings when identity matches;
- Module 09 selects all currently available relievers with season ERA and weights them by recent innings/games;
- eligible Savant xERA is only a fallback for an arm missing season ERA;
- at least two usable relievers are required;
- expected bullpen innings are exactly the remainder after effective starter innings.

The active computation does not select a likely leverage/bridge/long-relief chain. It does not condition quality or dispersion on score at transition, starter exit state, inherited runners, number of arms required, blowout usage, or actual role hierarchy. Current `role` is a workload-derived label and is not consumed as leverage hierarchy. The realized chain and first reliever are recorded only after settlement.

This explains why September 9 can contain both a 7.43-run projected bullpen window that produces two runs (TOR–OAK) and a 4.98-run projected window that produces 18 runs (NYM–MIA) without a corresponding state-distribution layer. It does not prove that the bullpen mean should be globally higher or wider.

Recommendation: **NO active model change.** First freeze a price-blind `BULLPEN_HANDOFF_STATE_SHADOW` containing expected starter-exit window, available arm count, recent workload burden, likely long-relief requirement, explicit hierarchy status/unavailable, and separate close/trailing/blowout deployment branches. Test conditional bullpen residuals and tail frequency prospectively. Do not add a generic bullpen-variance multiplier.

## E. September 9 game-truth diagnostic

The table below is a commissioning review of immutable September 9 evidence. It is not written back to the workbook. `Center error` is frozen projection minus actual. `Tail` describes whether the frozen structure captured the realized magnitude, not whether a ticket won.

| Game | Identity | Asymmetry | Phase allocation | Center error | Tail | Primary failure mechanism | Workload-compromised |
|---|---|---|---|---:|---|---|---|
| MIN–DET | HIT | HIT | PARTIAL | -0.11 | HIT | workload innings wrong, run center intact | YES |
| TOR–OAK | HIT | HIT | HIT | +6.41 | MISS_LOW | bullpen/transition suppression far beyond the projected floor | YES |
| STL–SFG | HIT | MISS | MISS | -4.04 | MISS_HIGH | bullpen transition underrepresented | YES |
| WSN–SDP | HIT | HIT | PARTIAL | -2.77 | PARTIAL_HIGH | workload allocation plus conversion | YES |
| TEX–SEA | MISS | MISS | HIT | +6.06 | MISS_LOW | starter/continuation and conversion suppression | NO |
| CLE–BAL | MISS | HIT | PARTIAL | -5.88 | MISS_HIGH | catastrophic starter failure state | YES |
| HOU–PHI | MISS | HIT | PARTIAL | -10.62 | MISS_HIGH | both suppression starters failed; bullpen continuation compounded | NO |
| NYM–MIA | HIT | HIT (two-sided) | HIT | -19.08 | MISS_HIGH | compound starter/bullpen failure on both sides | NO |
| LAA–BOS | HIT | MISS | HIT | -1.00 | HIT | comparative allocation reversal | NO |
| COL–NYY | PARTIAL | HIT | HIT | +2.85 | PARTIAL_LOW | one-sided conversion suppression | NO |
| TBR–ATL | MISS | HIT | PARTIAL | -1.78 | HIT | starter matchup plus workload allocation | YES |
| ARI–KCR | HIT | HIT | PARTIAL | +0.71 | HIT | workload allocation; center remained sound | YES |
| PIT–CHW | HIT | MISS | HIT | +1.88 | HIT | comparative allocation; transition identity was sound | YES |
| CHC–MIL | MISS | HIT | PARTIAL | -6.55 | MISS_HIGH | starter and bullpen failure, with workload error | YES |
| CIN–LAD | HIT | HIT | HIT | -6.17 | MISS_HIGH | correct one-sided identity, compressed LAD starter/bullpen ceiling | YES |

### Instrumentation status

`GAME_TRUTH_REPLAY_V1` already preserves center error, allocation error/reversal, starter and bullpen window errors, phase shares, conversion outcomes, primary mechanism, and a postmortem diagnosis. Ticket outcome is already separate.

It does **not** freeze a machine-readable pregame `Truth_Identity`, `Truth_Asymmetry`, `Truth_Phase`, or `Truth_Tail_Expectation`. Therefore an automated settlement writer cannot safely backfill the requested `GAME_TRUTH_GRADE` for September 9 without deriving the supposed pregame thesis from the final score.

The safe prospective instrumentation is:

- freeze `Truth_Identity`, `Truth_Asymmetry`, `Truth_Phase`, and `Truth_Tail_Expectation` before first pitch from the existing game-truth reasoning layer;
- at settlement, emit `Game_Truth_Grade`, component grades, `Projection_Center_Error`, `Projection_Tail_Error`, and `Primary_Failure_Layer` against those frozen labels;
- keep ticket result in its existing separate settlement field;
- leave all legacy rows explicitly `NOT_GRADABLE_PREGAME_SEMANTICS_NOT_FROZEN` rather than reconstructing them.

Recommendation: **READY FOR PROSPECTIVE OBSERVABILITY DESIGN; no September 9 historical rewrite.**

## Verification

- Focused Module 03 candidate and active-boundary tests: 7/7 passed.
- Complete API suite: 62 files loaded, 485/485 tests passed.
- TypeScript: passed.
- API build: passed.
- Frozen/authoritative workbook mutations: none.
- Deployment/push: none.
