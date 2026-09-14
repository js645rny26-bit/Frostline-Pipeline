# Allocation Bridge V1 commissioning — 2026-09-14

Status: `CONTINUE_SHADOW`

Scope: research-only fixed-total allocation challenger. No production
projection, decision, market, vehicle, or ticket consumer was added.

## Structural and dependency audit

The active Module 09 path builds each team independently before summing the two
team projections:

1. `4.5 * exact-lineup quality * bounded recent form` creates the active
   offense center.
2. The opposing starter quality, effective starter innings, team-specific
   traffic factor, and team-specific damage factor create the starter window.
3. The opposing bullpen quality and remaining innings create continuation.
4. A common environment multiplier is applied to both team projections.
5. Away and home projections are summed into the published total.

The audit found no circular consumer. Offense, starter, traffic, damage,
workload, and bullpen information are already combined in the active team
projection. Environment is common and therefore does not independently
reallocate the away/home share. Collision, SSAT, SWE, market data, and outcomes
are not bridge inputs.

The frozen packet does not retain a standalone numeric bullpen factor or an
independent team conversion object. V1 therefore reports the exact residual of
the frozen opponent system as the bullpen component and emits conversion as
zero. It does not fabricate either signal. `HR_XBH_Damage_Runs` is zero in all
225 eligible rows, so damage-path attribution remains limited.

## Pre-registered V1 rule

For each team:

```text
Baseball_Team_Runs = Legacy_Team_Projection / Run_Multiplier
Frozen_Opponent_System_Factor = Baseball_Team_Runs / Active_Offense_Center
Raw_Allocation_Support = Active_Offense_Center
                         * sqrt(Frozen_Opponent_System_Factor)
```

Then:

```text
Away_Share = Away_Support / (Away_Support + Home_Support)
Home_Share = 1 - Away_Share
Bridge_Away = Frozen_Total * Away_Share
Bridge_Home = Frozen_Total - Bridge_Away
```

The rule was frozen before outcome evaluation. It contains no trained
coefficient. Offense identity receives full log weight; the complete opposing
run-prevention system receives half log weight. This retains starter and
bullpen evidence without allowing pitcher ranking alone to define the game.

Component columns are an exact log decomposition of the support:

```text
Offense + Starter + Traffic + Damage + Conversion + Bullpen
= ln(Raw_Allocation_Support / 4.5)
```

## Publication and readback

GitHub Actions run:
`https://github.com/js645rny26-bit/Frostline-Pipeline/actions/runs/34854812826`

Implementation commit: `573255530040c75df7b4636f74eda2fa4851169f`

Replay timestamp: `2026-09-14T14:22:31.616Z`

Materialized surfaces:

- `ALLOCATION_BRIDGE_V1`: 254 rows
- `ALLOCATION_BRIDGE_REPLAY_V1`: 225 rows
- `ALLOCATION_BRIDGE_SUMMARY_V1`: 15 rows
- `ALLOCATION_BRIDGE_DIAG_V1`: 225 rows

Coverage:

- settled allocation rows examined: 254
- eligible component-complete frozen packets: 225
- excluded older packets: 29
- exclusion: `FROZEN_BRIDGE_COMPONENTS_MISSING` for all 29
- invariant failures: 0
- eligible lineage status: `FROZEN_PACKET_MATCHED` for all 225
- stored maximum `abs(Away + Home - Frozen_Total)`: `1.78e-15`
- workbook formula errors: 0

## Overall replay

| Measure | Legacy | Bridge | Change |
|---|---:|---:|---:|
| Higher-scoring-side accuracy | 60.00% | 58.67% | -1.33 pp |
| Allocation sign errors | 90 | 93 | +3 |
| Away-team MAE | 2.4443 | 2.4482 | +0.0039 |
| Home-team MAE | 2.6028 | 2.5786 | -0.0242 |
| Combined team-run MAE | 2.5235 | 2.5134 | -0.0101 |
| Run-differential MAE | 3.5386 | 3.5342 | -0.0044 |

Frozen-total MAE is 3.4927 under both allocation methods because the bridge
cannot change the total. Mean absolute movement per team is 0.2057 runs and
the maximum team movement is 0.6505 runs.

The overall result is mixed: the two continuous allocation losses improve by
small amounts, but directional accuracy and sign-error count regress. This is
not commissioning evidence.

## Subgroups

| Cohort | N | Accuracy legacy → bridge | Combined MAE legacy → bridge | Run-diff MAE legacy → bridge |
|---|---:|---:|---:|---:|
| Low allocation strength | 150 | 62.00% → 60.00% | 2.4515 → 2.4634 | 3.4239 → 3.4960 |
| Medium allocation strength | 57 | 50.88% → 50.88% | 2.8192 → 2.7674 | 4.1753 → 4.0833 |
| High allocation strength | 18 | 72.22% → 72.22% | 2.1875 → 2.1253 | 2.4783 → 2.1133 |
| Full lineups | 106 | 55.66% → 58.49% | 2.6658 → 2.6473 | 3.3469 → 3.3122 |
| Partial/lower lineups | 119 | 63.87% → 58.82% | 2.3968 → 2.3941 | 3.7093 → 3.7320 |
| Conventional starters both sides | 174 | 59.20% → 59.20% | 2.4484 → 2.4418 | 3.3943 → 3.3882 |
| Atypical role present | 51 | 62.75% → 56.86% | 2.7798 → 2.7576 | 4.0310 → 4.0324 |
| Total error <= 2 runs | 92 | 59.78% → 54.35% | 1.6004 → 1.5767 | 3.0705 → 3.0606 |
| Total error 2–4 runs | 60 | 61.67% → 61.67% | 2.2023 → 2.2106 | 3.4335 → 3.3366 |
| Total error > 4 runs | 73 | 58.90% → 61.64% | 3.9510 → 3.9428 | 4.2148 → 4.2935 |
| Total good / allocation bad | 10 | 20.00% → 10.00% | 3.7230 → 3.5277 | 7.4460 → 7.0554 |

All 225 eligible rows report available bullpen data, so this corpus cannot
estimate a missing-vs-complete bullpen-data interaction. The 18-game
high-strength cohort is descriptive and too small for a promotion claim.

## Sept. 13 challenge set

Sept. 13 higher-scoring-side accuracy moves from 7/15 to 9/15. The bridge fixes
`LAA_WSN`, `PHI_ATL`, and `TEX_ARI`, but reverses the previously correct
`CIN_MIL` direction. It does not fix `COL_DET`, `HOU_TBR`, `CLE_MIN`,
`PIT_CHC`, or `SEA_OAK`.

Selected cases:

- `COL_DET`: 5.03/4.43 becomes 4.8881/4.5719; actual 1/8. Both are wrong.
- `LAD_MIA`: 4.72/4.97 becomes 4.7774/4.9126; actual 4/6. Both are correct.
- `SDP_SFG`: 4.60/3.82 becomes 4.3841/4.0359; actual 6/4. Both are correct.
- `NYM_NYY`: 3.14/4.16 becomes 3.4304/3.8696; actual 0/2. Both are correct.
- `TEX_ARI`: 3.95/4.07 becomes 4.0193/4.0007; actual 7/6. Bridge corrects the sign.
- `SEA_OAK`: 4.95/4.14 becomes 4.7858/4.3042; actual 7/8. Both are wrong.

These examples were diagnostics only and did not select or tune the formula.

## Failure diagnostics

The 90 legacy sign errors classify as:

- `LINEUP_IDENTITY_GAP`: 43
- `ROLE_OR_WORKLOAD_MISMATCH`: 36
- `STARTER_WEIGHT_OVERREACH`: 6
- `INSUFFICIENT_EVIDENCE_TO_CLASSIFY`: 3
- `BULLPEN_EXPOSURE_MISALLOCATION`: 1
- `OFFENSE_STRENGTH_MISALLOCATION`: 1

The taxonomy is evidence-gated. It does not force a mechanism where the frozen
record cannot support one. In particular, the inert damage field and absent
standalone conversion/bullpen factors prevent a stronger damage-versus-
conversion diagnosis.

## Immutability and production isolation

Pre-run and post-run content hashes match for every protected surface:

| Surface | Pre | Post | Result |
|---|---|---|---|
| `PREGAME_PACKET_HISTORY` A:CV | `26c6e271` | `26c6e271` | unchanged |
| `PREGAME_PACKET_HISTORY` CW:GR | `4bf62e48` | `4bf62e48` | unchanged |
| `PREGAME_PACKET_HISTORY` GS:IS | `5d2e416e` | `5d2e416e` | unchanged |
| `GAME_SUMMARY` | `2a13e8af` | `2a13e8af` | unchanged |
| `SLATE_BOARD` | `4410e591` | `4410e591` | unchanged |
| `VEHICLE_LOG` | `7f81dd90` | `7f81dd90` | unchanged |
| `DECISION_AUDIT_LOG` | `a6e89017` | `a6e89017` | unchanged |

Therefore:

- no frozen pregame projection changed;
- no historical packet changed;
- no active `GAME_SUMMARY` projection changed;
- no active `SLATE_BOARD` decision changed;
- no market, vehicle, or ticket history changed.

## Validation

- focused Allocation Bridge tests: 9/9 pass
- complete API-server suite: 529/529 pass across 64 files
- TypeScript: pass
- API build: pass
- CI settlement/materialization: pass
- workbook publication/readback: pass

## Verdict

`CONTINUE_SHADOW`

The bridge produces modest, explainable fixed-total reallocations and improves
some continuous allocation losses, especially with full lineups and in the
medium/high separation cohorts. It does not improve the primary directional
result across the eligible corpus and performs poorly in partial-lineup and
atypical-role cohorts. No production activation is recommended. Suppression
Fragility, SWE, collision, SSAT, and state-based bullpen logic remain unchanged
and unpromoted.
