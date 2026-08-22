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

`GAME_SUMMARY.Traffic_Conversion_Runs` and `HR_XBH_Damage_Runs` remain inactive zeros. Their current candidate estimates live in `STATCAST_SHADOW_AUDIT`. Every slate review and postmortem should state that explicitly.

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

| Tab | Written | Function | Relationship to SLATE_BOARD | Read efficiently |
|---|---|---|---|---|
| `DAILY_MATCHUPS` | Every publish, Module 08 | Slate identity, pitchers, workload, weather, park, prior outing, umpire, and market context. | Mirrors evidence used by normalization and projection. | Confirm date, games, starters, and source gaps first. |
| `TODAY_LINEUPS` | Every publish, Module 08 | Posted/projected batting orders, form, and platoon context. | Same lineup payload becomes Module 09 lineup factors. | Check official/projected status and coverage. |
| `TEAM_FORM_INPUT` | Every publish, Module 08 | Recent team run-rate and form baselines. | Feeds Module 09 offense rates. | Audit when recent form appears to dominate allocation. |
| `BULLPEN_USAGE_DAILY` | Every publish, Module 08 | Reliever availability, workload, and quality context. | Feeds bullpen innings and continuation components. | Interpret workload by leverage role; Notes are cleared on publish. |
| `RUN_ENVIRONMENT` | Every publish, shared resolver | Park, weather, roof, wind, certainty, run multiplier, and HR factor. | Module 09 consumes the same resolver result. | Check fallback and roof/weather vehicle status; environment cannot originate a thesis. |
| `ODDS_HISTORY` | Append every publish, Module 05d | Opening and subsequent total snapshots. | Supplies movement and line provenance, not baseball truth. | Earliest daily row is opener; compare timestamps before calling a line stale. |
| `STATCAST_GAME_PREVIEW` | Every publish when available, Modules 02e/08b | Timestamped Savant identity, pitcher metrics, hitter aggregates, and parser status. | Feeds estimate/audit surfaces, not direct authorization. | Verify identity, lineup status, and pre-first-pitch timestamp. |

## Projection and decision tabs

| Tab | Written | Function | Relationship to SLATE_BOARD | Read efficiently |
|---|---|---|---|---|
| `GAME_INTEGRATION` | Every publish, Module 09 | Two rows per game, combining evidence at team level. | Creates the away/home allocations summarized downstream. | Use when the total and team ownership disagree. |
| `GAME_SUMMARY` | Every publish, Module 09 | One-row active projection and component lineage. | Primary projection input to Module 11. | Reconcile away + home = total and baseball-only + environment = total. |
| `PLAYER_INTEGRATION` | Every publish, Module 09 | Per-batter identity, opponent, environment, statistics, and explicit gaps. | Supports lineup-factor audit, not authorization. | Use for player matching and missing-stat diagnosis. |
| `STATCAST_SHADOW_AUDIT` | Every publish after Module 09, Module 09s | Starter xwOBA, estimated traffic/damage tail adjustments, and a shadow-only low-center volatility audit. | Provides the tentative range companion and a manual distribution-risk warning; never changes the active total or authorization. | Compare `Current_Projection` and `Estimated_Projection`; when flagged, inspect both challengers, upper-tail band, reason tags, status, and caps. |
| `LOW_CENTER_CALIBRATION_HISTORY` | Append every pregame Module 09s run for a low-center game | Timestamped base, +1.50 primary, and +2.00 sensitivity candidates. | No board input; preserves evidence for settlement. | Only a row strictly before its scheduled first pitch is valid prospective evidence. |
| `LOW_CENTER_CALIBRATION_REPORT` | Settlement, Module 14 | Actual-result comparison of preserved base and challenger projections. | No board input; calibration evidence only. | Compare each candidate's absolute error over a sufficient prospective sample; never promote on an isolated slate. |
| `STARTER_SURVIVAL_CALIBRATION_HISTORY` | Every pre-first-pitch Module 09t run | Four-state workload branch totals, probabilities, and continuous failure-dependency scores. | No board input; manual-review evidence only. | `p = clamp(Projected_Starter_Innings / 9, 0, 1)` is temporary and must be tested prospectively. |
| `STARTER_SURVIVAL_CALIBRATION_REPORT` | Settlement, Module 14 | Actual-total comparison and starter survival grading from history. | No board input; challenger evidence only. | Cannot reconstruct or backdate a missing pregame candidate. |
| `STARTER_SURVIVAL_V2_CALIBRATION_HISTORY` | Every pre-first-pitch Module 09u run | Empirical survival probability and conditional workload-failure severity. | No board input; v2 shadow evidence only. | Uses strictly earlier settled records only; no v1 proxy fallback. |
| `STARTER_SURVIVAL_V2_CALIBRATION_REPORT` | Settlement, Module 14 | Base vs SSAT v1 vs SSAT v2 outcome comparison. | No board input; calibration evidence only. | Inspect cohort provenance and actual starter workload before interpreting results. |
| `SLATE_INPUT` | Every publish, Module 10 | Model scores plus operator vehicle, line, odds, notes, and frozen market state. | Direct input to Module 11. | Operator owns O–W; authoritative pregame line outranks stale display Line after freeze. |
| `SLATE_BOARD` | Every publish for mutable games, Module 11 | Complete decision output, blockers, gate, lock, and lineage. | It is the full decision board. | Never read Decision without projection, line, tentative range, blocker, and lock state. |
| `ACTIVE_BOARD_SNAPSHOT` | Every publish, Module 11 | Condensed currently authorized entries. | Filtered view; does not create authorization. | Execution shortcut only after reviewing `SLATE_BOARD`. |
| `BOARD_LOCK_STATE` | At each game’s lock, Module 11 | Immutable record of final authorization and lock provenance. | Records the single authorization source. | Use to resolve contradictory displays; lock never invents CORE/BET. |
| `VEHICLE_LOG` | Frozen after board publication, Module 17 | Prospective vehicle, projection, line, direction, and decision. | Preserves what the board actually published. | Historical grading must use this, not a later recalculation. |
| `DECISION_AUDIT_LOG` | Pregame publish and settlement, Module 20 | Model, manual overlay, authorization, result, and independent grades. | Consumes the authoritative decision and records why. | OPEN may update; frozen pregame evidence may not. |

## Run-health and documentation tabs

| Tab | Written | Function | Board relationship | Read efficiently |
|---|---|---|---|---|
| `RUN_LOG` | End of every publish, Module 12 | Run identity, schema, statuses, counts, errors, and warnings. | Certifies the board-producing run. | Read before trusting any refreshed slate. |
| `SHADOW_VALIDATION` | Every publish, Module 12s | Current repaired-versus-legacy comparison. | Audit only. | Look for unexpected candidate drift. |
| `SHADOW_HISTORY` | Append every publish, Module 12s | Historical validation snapshots. | Audit only. | Use for drift over time, not execution. |
| `SCHEMA_REFERENCE` | Schema documentation repair | Column dictionary, ownership, formats, and descriptions. | Documentation only. | Use for exact column meaning. |
| `README` | Schema documentation repair | Orientation, quick order, cautions, and one-row summary for every tab. | Documentation only. | Start here after time away. |

## Settlement and learning tabs

| Tab | Written | Function | Board relationship | Read efficiently |
|---|---|---|---|---|
| `SHADOW_OUTCOMES` | Daily settlement, Module 14 | Frozen projection, final score, errors, direction, and pitcher provenance. | Grades prospective state without rerunning it. | Primary settled truth table. |
| `PROJECTION_REPLAY` | Daily settlement, Module 14 | Frozen-published per-game replay. | Measures the board that actually existed. | Compare frozen and repaired projections explicitly. |
| `VEHICLE_POSTMORTEM` | After settlement, Module 17 | Ticket, truth, capture, blocker, and mechanism grades. | Grades vehicle and authorization separately. | Pushes are neutral; passed winners are not automatically bad passes. |
| `SURVIVAL_GATE_REPLAY` | Settlement/replay, Module 18 | Over survival-floor regrading with provenance. | Audits one gate without rewriting history. | Distinguish baseball-supported and environment-dependent Overs. |
| `STARTER_AUDIT` | After settlement, Module 16 | Starter-level error and provenance. | Learning only. | Study repeated survival/failure patterns, not one result. |
| `REGRESSION_REPORT` | After settlement, Module 15 | MAE, median error, bias, miss rate, and projection direction summaries. | Reliability evidence only. | Separate total accuracy from allocation and winner accuracy. |
| `MONOTONICITY` | With regression, Module 15 | Directional hit rate by frozen edge tier. | Its adequately sampled verdict governs authorization availability. | Verify sample size before trusting the verdict. |

## Explicit replay tabs

| Tab | Written | Function | Board relationship | Read efficiently |
|---|---|---|---|---|
| `REPLAY_RESULTS` | Explicit Module 13 replay | Date-anchored baseline-versus-candidate game results with weather provenance. | Offline commissioning only. | Replay may never impersonate missing prospective evidence. |
| `REPLAY_METRICS` | Each Module 13 replay | Aggregate variant accuracy, bias, direction, and calibration. | Offline commissioning only. | Compare multiple metrics and total bands, not MAE alone. |

## Non-negotiable reading rules

- Confirm the date and Game_ID on every downstream row; row count alone is not validation.
- A green workflow is not enough—read `RUN_LOG` and current-slate timestamps.
- Preserve the distinction between active projection, tentative estimate, frozen publication, and postgame replay.
- Never let park/weather, a starter label, or a single candidate estimate manufacture game truth.
- Grade total accuracy, team allocation, vehicle capture, authorization, and ticket outcome separately.
