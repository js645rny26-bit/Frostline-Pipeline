# Module 29 Calibration Checkpoint — 2026-09-26

Status: `RESEARCH_ONLY / HOLD_NO_PROMOTION`

Source: authoritative `GAME_TRUTH_DIST_*_V2` workbook surfaces read at replay
timestamp `2026-09-26T14:14:53.266Z`.

## Sample governance

- 245 walk-forward observations per comparator.
- 19 slate-date blocks in paired bootstrap comparisons.
- Contract state: `N_200_TO_499_EARLY_MODEL_RANKING_NO_FINE_CALIBRATION_CERTIFICATION`.
- No comparator, width adjustment, or feature is commissioned by this checkpoint.

## Current distribution evidence

| Comparator | CRPS | twCRPS 6.5-11.5 | 50% coverage | 80% coverage | 90% coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| CMP | 2.3298 | 0.2211 | 60.4% | 82.0% | 91.8% |
| Empirical residual | 2.3346 | 0.2191 | 62.9% | 83.7% | 91.8% |
| Hurdle NB | 2.3555 | 0.2243 | 60.8% | 86.1% | 93.1% |
| NB | 2.3546 | 0.2240 | 62.0% | 86.5% | 93.5% |
| Poisson | 2.3630 | 0.2234 | 50.2% | 70.6% | 78.4% |

Poisson is materially too narrow at the 80% and 90% levels. NB-family
comparators over-cover the central 50% interval and modestly over-cover the
wider intervals. CMP and empirical residual are closer at 80%/90%, but still
over-cover the central interval.

The count-PIT shapes are not uniform. Poisson has excess mass in both extreme
bins, consistent with underdispersion. CMP/NB-family PIT means above 0.5 and
heavier upper bins remain consistent with center-low outcomes appearing too
often; this is a diagnostic direction, not a coefficient instruction.

## Comparator uncertainty

CMP has lower mean CRPS than NB and hurdle NB with slate-block bootstrap
intervals excluding zero. Its CRPS difference versus empirical residual and
Poisson remains uncertain because the block intervals cross zero. Log-score
evidence is also mixed across comparisons. The predeclared decision therefore
remains no promotion.

## Added commissioning readback

The existing summary surface now reports modeled probability mass beside
empirical frequency for three mutually exclusive outcome regions:

- `LE_6`
- `7_TO_10`
- `GE_11`

This closes the requested quiet/central/loud readback without adding a module,
sheet, active consumer, distribution adjustment, or production coefficient.

## Current bucket-readback coverage limitation

The authoritative distribution ledger contains 245 eligible observations per
model, but the published line-probability ledger currently contains only the
first 9,999 data rows.  Consequently, the exact 10.5-line join needed to derive
`GE_11` is available for only 182 observations (181 for empirical residual).
The summary rows expose that smaller sample size rather than silently treating
it as the full corpus.

On that explicitly partial cohort, observed frequencies were approximately
24.7% `LE_6`, 36.8% `7_TO_10`, and 38.5% `GE_11`.  CMP assigned 34.1%, 36.8%,
and 29.1%, respectively; empirical residual assigned 25.9%, 34.4%, and 39.7%.
These values are descriptive only.  The 245-game calibration claim remains
blocked until a complete-cohort replay is materialized.  The code repair raises
the owned line-ledger read boundary from 10,000 to 20,000 rows (and narrows the
read to the actual A:Q schema), but this checkpoint does not claim workbook
materialization that has not yet occurred.
