# Starter Workload Estimator V1 research specification

Version: `SWE 1.0.0`

Status: **SHADOW_ONLY — HOLD**

The active conventional workload path remains unchanged. SWE cannot alter `Expected_IP`, bullpen exposure, a projection, vehicle, or authorization output. Frozen historical and prospective evidence is immutable.

## 1. Research hypotheses

SWE now carries two separately adjudicated hypotheses.

### 1.1 Conventional-starter personalization

The primary question is whether pitcher-specific SWE deviations contain information beyond the ordinary 6.0-IP conventional-starter baseline.

For eligible conventional starters:

```text
Predicted_Deviation = SWE_Expected_IP - 6.0
Actual_Deviation    = Actual_IP - 6.0
```

The primary diagnostics are Pearson correlation, Spearman rank correlation, predicted- and actual-deviation standard deviation, and the calibration intercept and slope from `Actual_Deviation ~ Predicted_Deviation`.

MAE, RMSE, signed bias, two-plus-IP misses, and the paired Wilcoxon comparison with active `Expected_IP` remain required secondary diagnostics. They cannot establish that personalization works by themselves. A constant can achieve good MAE merely by sitting near the cohort mean.

Interpretation:

- persistent bias plus meaningful deviation correlation: personalization may be informative and require later recalibration;
- near-zero bias plus meaningful deviation correlation: strong personalization candidate;
- persistent bias plus near-zero deviation correlation: intercept recalibration cannot repair the core failure;
- near-zero bias plus near-zero deviation correlation: apparent precision without useful individual discrimination.

Persistent near-zero deviation correlation in an adequately sized, variance-qualified sample is an architectural failure, not a calibration problem.

### 1.2 Atypical roles

`OPENER` and `BULK / FOLLOWER / TRANSITION` are separate prospective cohorts. Their question is whether pitcher-specific evidence improves upon rigid role buckets. They are never pooled into the conventional correlation or its primary performance number.

Hagen Smith on September 10 is the first proof case for the question, not proof of general superiority: active 1.20 IP, SWE 2.25 IP, actual 2.00 IP.

## 2. Sample and variance gates

The existing formal checkpoint remains 150 eligible conventional starters.

Module 30 records descriptive correlations at smaller samples but assigns:

- `INSUFFICIENT_N` below 150;
- `INSUFFICIENT_PREDICTED_VARIANCE` when predicted deviations collapse;
- `INSUFFICIENT_ACTUAL_VARIANCE` when outcome depth is not sufficiently variable;
- `VARIANCE_FLOOR_NOT_FROZEN` when N and raw variation exist but the outcome-variance floor has not been approved;
- `INTERPRETABLE` only after every gate passes.

Unavailable correlations and p-values remain blank, never numeric zero. `Correlation_Score_Status` remains `NOT_YET_INTERPRETABLE` until the formal gate passes.

### 2.1 Actual-IP variance floor

No numeric floor is authorized from the September 10 slate. The current value is intentionally unset.

Before future formal interpretation, derive a candidate floor from only cutoff-safe historical actual workload evidence that predates the prospective scoring window:

1. use resolved conventional starts from `SWE_APPEARANCE_HISTORY_V1`;
2. calculate actual deviation from 6.0 IP;
3. order strictly by game date;
4. calculate the sample standard deviation in rolling 150-start windows;
5. report the distribution and calendar stability of those window standard deviations;
6. select, review, document, and version-freeze a conservative lower support boundary without consulting SWE correlations, errors, or later outcomes.

The exact statistic and numeric value require a separate source-only review. Until approved, `Actual_Deviation_SD_Floor` is blank and `Variance_Floor_Status` is `PROPOSED_METHOD_NOT_FROZEN`. This deliberately prevents moving the threshold after seeing SWE performance.

## 3. Estimator specification

### 3.1 Current V1 formula

SWE 1.0.0 retains its already-frozen source-only estimator in this diagnostic patch:

- L3 / L5 / season windows with renormalized weights 0.50 / 0.30 / 0.20;
- conventional shrinkage constant `k=4`;
- source cutoff strictly before the slate and through D-1;
- explicit `INSUFFICIENT_HISTORY` and `OUTS_UNRESOLVED` states;
- no fallback to active `Expected_IP`.

No weight, prior, bound, or active consumer changes in schema v62.

### 3.2 Atypical-role bounds — next estimator version

**Role is a weak prior, not a hard ceiling, for atypical workload roles.**

The current SWE 1.0.0 opener branch still contains its frozen 2.5-IP hard ceiling. That rule is now a documented specification gap; it is not silently changed inside this diagnostic patch.

A separately versioned estimator candidate must:

- use opener/bulk/follower/transition role as a prior or shrinkage input;
- allow cutoff-safe pitcher appearance history to move the estimate beyond the nominal role prior;
- preserve explicit insufficient-history behavior;
- never fall back silently to active `Expected_IP`;
- replace any baseball-role ceiling with, at most, a broad data-integrity guardrail justified from pre-cutoff workload support;
- choose no prior, shrinkage, or guardrail by fitting September 10 outcomes;
- remain shadow-only through its own commissioning review.

## 4. Stored outputs

`SWE_WORKLOAD_DEVIATION_V1` preserves per starter:

- SWE, active baseline, and actual IP;
- frozen role and role cohort;
- conventional 6.0-IP baseline;
- predicted and actual deviations;
- deviation error and within-corpus ranks;
- SWE and baseline absolute errors;
- cutoff and settlement lineage.

Deviation and rank fields are intentionally blank for atypical roles.

`SWE_WORKLOAD_REPLAY_SUMMARY_V1` writes one row for each cohort:

- `CONVENTIONAL_STARTER`;
- `OPENER`;
- `BULK_FOLLOWER_TRANSITION`;
- `UNRESOLVED_OTHER`.

The conventional row contains the primary deviation diagnostics and all secondary scores. Atypical rows contain independent secondary workload grading and explicit not-applicable correlation status.

## 5. September 10 observation

The first prospective conventional sample was N=9. Reported Pearson `r ≈ -0.034`, `p ≈ 0.93`; therefore it supplied no first-sample discrimination. It cannot establish steady-state failure.

The paired comparison across the ten observed starters had Wilcoxon `p=0.322`, with active baseline lower absolute error in 6 of 10. There is no statistically demonstrated winner, and SWE did not “lose” the slate. The conventional actual mean of approximately 6.07 IP also explains why the 6.0 constant performed well as a location estimate.

Current commissioning verdict: **HOLD**.

## 6. Decision rules

Conventional SWE can reach a promotion review only after:

- at least 150 eligible conventional starters;
- sufficient predicted and actual deviation variance under frozen gates;
- stable positive pitcher-specific discrimination;
- useful deviation calibration;
- incremental value beyond the role constant;
- every source, cutoff, dependency, and immutability requirement passes.

`INTERPRETABLE` starts review; it never promotes automatically. No unapproved correlation magnitude or p-value threshold is introduced by this patch.

Reject or redesign conventional SWE if an adequately sized, variance-qualified prospective sample retains near-zero Pearson and rank discrimination. Do not attempt to rescue non-discrimination with intercept correction.

Atypical-role SWE may receive a separate future commissioning decision. Evidence from that cohort cannot promote conventional SWE.

## 7. Prohibitions

- no active `Expected_IP` or projection change;
- no SWE promotion;
- no September 10 weight tuning;
- no bullpen, starter-quality, BVH, center-health, or distribution change;
- no historical packet rewrite or postgame backfill;
- no aggregate all-role primary score;
- no missing statistic encoded as zero;
- no estimator revision hidden inside a diagnostic/schema patch.
