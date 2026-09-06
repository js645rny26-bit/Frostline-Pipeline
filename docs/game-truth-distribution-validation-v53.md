# Module 29 validation and feature-governance protocol (v53)

Status: research only. This protocol cannot change a Frostline point projection,
run band, market comparison, vehicle, authorization, BET/PASS state, or score.

## Architecture retained from v52

Module 29 models the combined game total directly. Each comparator uses the same
immutable, price-blind frozen Frostline total as its location and fits its shape
only on strictly earlier settled frozen packets. Same-slate records never train
one another.

The retained comparators are Poisson, negative binomial, zero-hurdle negative
binomial, mean-parameterized COM-Poisson, and empirical residuals. One PMF per
game produces every total-line probability. Market evidence is not read when a
distribution is constructed; a settled line is only a post-settlement Brier
query.

`GAME_TRUTH_DISTRIBUTION_V2` is the game/model score ledger,
`GAME_TRUTH_DIST_LINES_V2` is the coherent line ledger,
`GAME_TRUTH_DIST_SUMMARY_V2` is the whole-distribution diagnostic summary,
`GAME_TRUTH_DIST_PAIRS_V2` is the paired comparator evidence, and
`GAME_TRUTH_SLATE_DIAG_V2` tests aggregate run volume versus game placement.

## Validation added in v53

| Need | Reproducible artifact | Rule |
| --- | --- | --- |
| Discrete PIT | `Nonrandomized_Count_PIT` plus its CDF-jump interval | The Czado-Gneiting-Held midpoint is primary. Deterministic randomized PIT remains secondary only. |
| PIT shape | 10 non-randomized count-PIT bins and an Anderson-Darling uniform diagnostic | A U shape means underdispersion; a dome means overdispersion; a slope suggests center bias. No non-rejection is a calibration certificate. |
| Decision-region score | `Threshold_Weighted_CRPS_6_5_TO_11_5` | Mean Brier score across coherent half-run cutoffs 6.5 through 11.5. Ordinary CRPS remains whole-distribution scoring. |
| Reliability | `GAME_TRUTH_DIST_CORP_V2` | Isotonic/PAV groups, no arbitrary fixed bins; Brier MCB and slate-block bootstrap frequency intervals. It does not recalibrate any probability. |
| Comparator uncertainty | `GAME_TRUTH_DIST_PAIRS_V2` | Paired CRPS/log/twCRPS deltas with full-slate-date block bootstrap CIs. HLN-DM is a secondary one-step cross-check and is unavailable for nested pairs. |
| Coherence | PMF and line reconciliation statuses | Valid nonnegative PMF, nondecreasing CDF, and exact half-line `P(Over k)=1-F(floor(k))` reconciliation are required per PMF. |

## Small-sample contract

| Walk-forward observations per model | Permitted conclusion |
| --- | --- |
| Under 50 | Plumbing and gross-bug detection only. |
| 50-149 | Gross miscalibration or large score gaps only. |
| 150-199 | PIT shape and early calibration/discrimination are directional only. |
| 200-499 | Early model ranking can be studied; fine calibration cannot be certified. |
| 500-999 | Calibration evidence improves, but slope remains imprecise. |
| 1,000+ | Calibration-slope claims begin to become realistically testable. |

No model promotion is authorized by the current sample. A marginal p-value, an
overlapping bootstrap interval, or a non-significant PIT test preserves the
research comparison rather than selecting a comparator.

## Price-blind feature governance

The canonical current ledger is `GAME_TRUTH_DIST_FEATURE_GOV_V2`. The working
rules are:

| Candidate | Center governance | Width/tail governance | Current state |
| --- | --- | --- | --- |
| Starter game-to-game blow-up propensity | Separate from average quality | Evidence-backed candidate | Keep researching after a prior-only frozen feature exists. |
| Unplanned early-exit/role fragility | Planned role only for center context | Evidence-backed mechanism, current data gap | Do not use placeholder Expected_IP. |
| Regressed multi-year park volatility | Both | Both | Need a weather-neutral frozen volatility input. |
| Park-conditional wind | Mean candidate | Park-specific shadow candidate | Freeze wind direction/speed with a park-sensitivity class first. |
| Bullpen fatigue | Mean candidate | Prospective tail hypothesis | Standardize a frozen workload/availability state. |
| Bullpen reliance and opener chain | Not established | Not established | Matched prospective cohorts only; no opener tax. |
| High traffic/access | Mean candidate | Prospective candidate | Preserve access separately from damage and conversion. |
| Traffic-without-damage historical gap | At most a validated mean-regression question | Rejected | LOB%, ERA-FIP, and sequencing are not persistent shape traits. |
| Lineup talent completeness | Mean candidate | Rejected as shape | Talent matters; batting-order position does not. |
| Humidity/barometric pressure | Fold into broad environment physics | Rejected standalone | Do not create separate dispersion coefficients. |

## Prospective replay design

1. Freeze every candidate feature before first pitch with source, timestamp,
   version, availability state, and missing-data reason.
2. Fit only strictly prior games in expanding date order.
3. Test location and dispersion separately. A feature cannot enter both merely
   because it changes expected runs.
4. Grade CRPS, log score, posted-region twCRPS, count PIT, directional interval
   escapes, CORP reliability, and high/low total cohorts.
5. Compare feature variants with slate-date block bootstrap; report attempted
   variant count and nestedness. Keep ambiguous results in shadow.

## Explicit exclusions

Do not create independent dispersion terms for historical LOB%, ERA-FIP gap,
strand-rate overperformance, batting-order construction, humidity, or barometric
pressure. Do not treat bullpen innings, an opener label, strikeout skill, or
weather in a generic way as sufficient proof of wider totals.

## Current data gaps

* A pitcher-specific, prospectively frozen workload and early-exit-fragility
  source is not yet available; role lookup/placeholder Expected_IP is excluded.
* Pre-cap collision components were not preserved across all historic packets.
* Regressed multi-year park volatility and a park-wind sensitivity map are not
  yet frozen inputs.
* A consistent per-reliever fatigue/deployment burden metric has not been
  backfilled and must begin prospectively.
* Opener/role cohort evidence begins only after prospective role capture; no
  legacy inference is permitted.

## Recommendation

Keep direct-total, price-blind PMFs as the baseline. First accumulate enough
walk-forward observations to determine whether NB, CMP, or the empirical
residual comparator is more calibrated in Frostline's own data. Only then test
one frozen structural candidate at a time in a prospective shadow model. No
feature is authorized to change a production mean or distribution yet.
