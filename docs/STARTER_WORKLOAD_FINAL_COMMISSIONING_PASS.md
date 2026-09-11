# Starter Workload repair — final commissioning pass

Candidate base: `0bde8e3`

Commissioning state: **HOLD — FIRST LIVE SHADOW SETTLED; CONVENTIONAL DISCRIMINATION NOT YET INTERPRETABLE**

Active projection state: **UNCHANGED LEGACY MODULE 03 WORKLOAD**

This pass does not deploy a workload model. It isolates the pitcher-specific estimator behind Module 02g, preserves the current Module 03 output, and expands the frozen packet evidence needed for an honest prospective comparison.

## 1. Exact estimator and dependency audit

The candidate is `PITCHER_SPECIFIC_WORKLOAD_CANDIDATE_V1` in `module03_numericWorkload.ts`.

1. Admit only official MLB Stats API game-log appearances satisfying both `appearance.date < gameDate` and `appearance.date <= dataThroughDate`. The acquisition path supplies D-1; the estimator enforces it again.
2. Sort newest first and use no more than five appearances.
3. For `CONVENTIONAL_STARTER`, use previous starts when any exist. For `OPENER`, `BULK`, and `PIGGYBACK_SECONDARY`, use prior appearances because non-start usage is relevant to those roles.
4. Compute separate weighted recent IP and pitch-count means with weights `0.50 / 0.30 / 0.20 / 0.10 / 0.05`, normalized over the appearances actually present.
5. Use `history_weight = min(n / 5, 1)`. One appearance is therefore 20% history and 80% prior; five appearances earn full history weight. One appearance is the minimum usable sample, but it can never become an unshrunk single-start estimate.
6. Estimate innings as `role_or_return_prior_IP * (1-history_weight) + weighted_recent_IP * history_weight + rest_adjustment`.
7. Estimate pitches independently from the weighted recent pitch counts with the same shrinkage. The existing 15 pitches/IP constant translates only the rest adjustment into pitches; it does not derive the workload center.
8. Rest states: `SHORT_REST <=3 days` applies -0.50 IP; `STANDARD_REST 4-6` applies 0; `EXTRA_REST 7-10` applies 0; `RETURN_FROM_EXTENDED_REST >=11` applies -0.75 IP.
9. Bounds are role constraints, not estimators: opener 0.70-2.25 IP; bulk/piggyback 1.50-5.00; conventional 3.00-7.50.
10. Role/missing priors remain the commissioned active values: opener 25/1.2, bulk 55/3.0, conventional 92/6.0, missing-evidence probable starter 85/5.5, and the existing wide-window return prior. Fetch failure or no admissible role-relevant IP retains that prior with `ROLE_FALLBACK_NO_USABLE_HISTORY`.

Role therefore supplies the prior, bounds, and fallback. Ordinary pitchers with usable history receive individual values. It does not normally supply the candidate's numeric answer.

The downstream contract remains `expected_pitches` and `expected_innings`; however, Module 03 currently continues to emit the legacy active values. Module 02g calls the candidate separately and writes only shadow fields. No Module 09, gate, vehicle, or authorization function imports or consumes `WorkloadGameState`.

Module 09 has no fixed-bucket dependency. It clamps any finite `Expected_IP` to 0-9, subtracts a continuous matchup-pressure shortfall, and sets bullpen exposure to exactly `9 - effective_starter_innings`. Starter and bullpen run components scale continuously with those innings. Module 11 only requires Expected_IP to exist and be positive.

Temporal and immutability findings:

- same-day and future appearances are rejected twice, by acquisition and candidate;
- no postgame/result field is an estimator input;
- the packet writer updates only `OPEN_PROSPECTIVE` rows before first pitch;
- `FROZEN_PREGAME` rows are retained byte-for-byte;
- settlement reads the frozen shadow but cannot backfill it.

## 2. Mixed-result replay audit

The legitimate preserved population is 65 settled starter observations from September 7-9 with both estimates frozen before first pitch. No earlier pitcher history was reconstructed.

| Role | N | Legacy MAE | Candidate MAE | Legacy bias | Candidate bias | Legacy >=2 IP | Candidate >=2 IP |
|---|---:|---:|---:|---:|---:|---:|---:|
| Conventional | 57 | 1.186 | 1.161 | +0.999 | +0.416 | 16 | 10 |
| Bulk | 5 | 1.200 | 1.028 | -1.200 | -0.552 | 3 | 0 |
| Opener | 3 | 1.157 | 0.817 | -1.023 | -0.550 | 1 | 0 |

| Rest state | N | Legacy MAE | Candidate MAE | Legacy bias | Candidate bias | Legacy >=2 IP | Candidate >=2 IP |
|---|---:|---:|---:|---:|---:|---:|---:|
| Standard rest | 46 | 1.047 | 1.163 | +0.751 | +0.365 | 11 | 7 |
| Extra rest | 15 | 1.698 | 1.036 | +0.658 | +0.247 | 8 | 2 |
| Extended-rest return | 4 | 0.858 | 1.190 | +0.858 | -0.300 | 1 | 1 |

| Usable prior appearances | N | Legacy MAE | Candidate MAE | Legacy bias | Candidate bias | Legacy >=2 IP | Candidate >=2 IP |
|---|---:|---:|---:|---:|---:|---:|---:|
| 3 | 1 | 0.000 | 0.640 | 0.000 | -0.640 | 0 | 0 |
| 4 | 1 | 2.670 | 1.360 | +2.670 | +1.360 | 1 | 0 |
| 5 | 63 | 1.181 | 1.140 | +0.717 | +0.295 | 19 | 10 |

Historical stability/variance cohorts are **not replayable**. The old frozen packets preserved a weighted recent value and count in notes, but not the five-appearance sequence or continuous IP/pitch standard deviation. Assigning LOW/MEDIUM/HIGH variance after settlement would be reconstruction. Schema v60 now freezes both continuous standard deviations prospectively; categorical boundaries, if useful, must be predeclared before outcomes.

The material subgroup regressions are standard-rest MAE (+0.116 IP) and extended-rest-return MAE (+0.333 IP, N=4). Standard-rest bias and large-error frequency still improve. No special-case tuning is justified from these mixed, small subgroups.

## 3. Bullpen-exposure regression

Across the 65-starter replay, candidate Expected_IP is 0.439 IP lower per starter on average, with bullpen exposure increasing by the identical amount.

For the 15-game September 9 packet, the continuous Module 09 mechanical replay gives:

| Per-game quantity | Legacy | Candidate |
|---|---:|---:|
| Combined effective starter IP | 10.037 | 9.751 |
| Combined bullpen exposure IP | 7.963 | 8.249 |
| Starter attack runs | 5.033 | 4.795 |
| Bullpen continuation runs | 3.403 | 3.544 |
| Baseball-only total | 8.405 | 8.339 |
| Final projection | 8.594 | 8.530 |

Every side continues to satisfy `effective starter IP + bullpen exposure IP = 9.000`. Candidate bullpen exposure stays within 0-9; the maximum observed side is 7.587 IP. Opener games remain bounded and structurally valid. The mean absolute September 9 total change is 0.118 runs, the maximum is 0.26, no game moves 0.50, and the slate total changes by -0.97 runs.

Only innings allocation is substituted in this replay. Pitcher quality, traffic, damage, bullpen quality, lineup/BVH, park, weather, and environment values remain the frozen packet values.

## 4. September 9 named cases

Errors are estimate minus actual.

| Pitcher | Legacy IP | Candidate IP | Actual IP | Legacy error | Candidate error |
|---|---:|---:|---:|---:|---:|
| Griffin Jax | 3.00 | 4.19 | 5.00 | -2.00 | -0.81 |
| Daniel Lynch IV | 3.00 | 4.25 | 5.00 | -2.00 | -0.75 |
| Davis Martin | 3.00 | 3.86 | 5.00 | -2.00 | -1.14 |
| Janson Junk | 3.00 | 4.19 | 3.00 | 0.00 | +1.19 |
| Walker Buehler | 6.00 | 5.30 | 2.33 | +3.67 | +2.97 |
| Cody Bradford | 6.00 | 4.80 | 4.00 | +2.00 | +0.80 |
| Andre Pallante | 6.00 | 5.52 | 5.00 | +1.00 | +0.52 |
| Kade Anderson | 6.00 | 5.36 | 6.00 | 0.00 | -0.64 |
| Zac Gallen | 5.50 | 5.11 | 3.33 | +2.17 | +1.78 |
| Reynaldo López | 5.70 | 4.37 | 4.67 | +1.03 | -0.30 |
| Cristopher Sánchez | 6.00 | 6.38 | 6.00 | 0.00 | +0.38 |
| Rhett Lowder | 6.00 | 4.90 | 3.33 | +2.67 | +1.57 |
| Yoshinobu Yamamoto | 6.00 | 6.57 | 7.00 | -1.00 | -0.43 |

These are regression cases, not parameter targets.

## 5. Live-shadow contract

Schema v60 adds the following to each new pregame packet while leaving active Expected_IP unchanged:

- candidate version/status and Projected_IP_Shadow;
- Projected_Pitches_Shadow and Projected_BF_Shadow;
- source data-through date;
- relevant appearance count;
- weighted recent IP and pitches;
- continuous IP and pitch standard deviation;
- history weight;
- role, rest, confidence, evidence status, and notes.

Tests prove that the same workload history yields an individual shadow value while Module 03 still emits 92/6.0 for the active conventional starter. The commissioning branch may now run one legitimate pregame shadow. Settlement will compare the frozen legacy and candidate IP to actual IP.

### September 10 materialization

GitHub Actions commissioning run [#162](https://github.com/js645rny26-bit/Frostline-Pipeline/actions/runs/34485656912) completed successfully on commit `3036882`.

- authoritative workbook schema: v60;
- publication scope: `FULL_PREGAME_SCOPE`, five games;
- validation: PASS; critical failures: 0; RUN_LOG integrity: PASS;
- expected pitchers resolved: 10/10;
- packet timestamp: `2026-09-10T13:57:43.880Z`, before first pitch;
- active Expected_IP distinct values: 6.0 and 1.2, proving the commissioned legacy path remained active;
- candidate Projected_IP_Shadow: 10 distinct values across 10 pitchers;
- candidate status: `PITCHER_SPECIFIC` for 10/10;
- source data-through: 2026-09-09 (D-1) for 10/10;
- candidate pitches, five-appearance sample, recent IP/pitches, IP SD, pitch SD, history weight, role, rest, and confidence: populated for 10/10.

All five packet rows are currently `OPEN_PROSPECTIVE`, as expected before their games start. The normal lifecycle must freeze these exact pre-first-pitch snapshots before settlement; no post-start rebuild is permitted.

## 6. September 10 settlement and current verdict

**HOLD.** The first prospective conventional-starter sample was N=9. Reported Pearson correlation between SWE and actual deviation from the ordinary 6.0-IP baseline was approximately `r=-0.034`, `p=0.93`: the first sample supplied no discrimination, but it is far too small for a steady-state conclusion.

The ten-starter paired Wilcoxon result was `p=0.322`, and active workload had lower absolute error in 6 of 10. That is no statistically demonstrated winner, not a one-slate SWE defeat. Conventional actual innings averaged approximately 6.07, so the active 6.0 constant benefited from being near the cohort mean; aggregate MAE cannot determine whether personalization works.

Hagen Smith remains a distinct atypical-role proof case: active 1.20 IP, SWE 2.25, actual 2.00. It demonstrates that the rigid opener bucket can be wrong, not that conventional SWE is superior.

Schema v62 therefore binds Module 30 explicitly to the frozen
`PITCHER_SPECIFIC_WORKLOAD_CANDIDATE_V1` / `Projected_IP_Shadow` fields and
reframes the evaluation around separate hypotheses. The older Module 02i
`SWE_Expected_IP` field is not an eligible substitute:

- conventional SWE must show that its predicted deviations correspond to actual deviations;
- opener and bulk/follower/transition estimates are graded separately against their rigid role buckets.

The existing N=150 checkpoint remains. Formal correlation interpretation additionally requires adequate predicted and actual deviation variance under a pre-cutoff, version-frozen variance rule. That numeric floor is intentionally not inferred from September 10 and remains pending source-only derivation. See `docs/SWE_V1_SPEC.md`.

No workload estimator formula, active workload, bullpen allocation, or projection has changed. The evaluated candidate's current 2.25-IP opener ceiling is recorded as a next-version specification gap: role should become a weak prior rather than a hard ceiling in any separately commissioned atypical-role candidate.

## Verification before branch push

- Complete API suite: 62 files, 492/492 tests pass.
- TypeScript: pass.
- API build: pass.
- Authoritative workbook and frozen packets: untouched by local validation.
- Active Module 03 projection workload: unchanged.
- Live commissioning run #162: PASS; v60 shadow evidence materialized for 10/10 pitchers.
- September 10 settlement verdict: HOLD; conventional N=9 is descriptive only, and atypical roles are now separate.
