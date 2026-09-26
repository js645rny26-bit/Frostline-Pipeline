# P2H Diagnostic Semantics Audit

Status: `DOCUMENTED / TESTED / NON-OPERATIONAL`

This audit closes two workbook-label interpretation gaps without changing any
calculation, threshold, projection, decision, historical row, or consumer.

## `REGRESSION_REPORT.Bias_Alert`

For each independently computed `7d`, `30d`, `ytd`, or `all` window:

```text
Signed_Error_i = Frozen_Projected_Total_i - Actual_Total_i
Bias = arithmetic_mean(Signed_Error_i)
Bias_Alert = ALERT when abs(Bias) > 0.20 runs
```

The boundary is strict: `+0.200` and `-0.200` do not alert; `+0.201` and
`-0.201` do. The input bias is rounded to three decimals before the alert is
evaluated and published.

`Bias_Alert` has no minimum sample size, bootstrap interval, significance test,
multiple-comparison adjustment, persistence requirement, or active consumer.
It is therefore an uninterpreted descriptive threshold flag—not evidence of a
stable model condition and not authority to tune a coefficient.

## `DECISION_AUDIT_LOG.Allocation_Winner`

The legacy field name compares the two layers' allocation accuracy:

```text
Model_Allocation_Error =
  abs(Frozen_Model_Away - Actual_Away) +
  abs(Frozen_Model_Home - Actual_Home)

Manual_Allocation_Error =
  abs(Manual_Away - Actual_Away) +
  abs(Manual_Home - Actual_Home)
```

- `MODEL`: model allocation error is lower.
- `MANUAL`: manual allocation error is lower.
- `TIE`: errors are equal.
- `BOTH_WRONG`: both market-direction truth grades are `INCORRECT`; this legacy
  branch takes precedence over comparing the numerical allocation errors.
- `NOT_COMPARABLE`: either allocation error is unavailable.

It does **not** mean which layer correctly selected the higher-scoring team.
That question is recorded separately in `Model_Winner_Result` and
`Manual_Winner_Result`.

The historical column is retained to avoid rewriting workbook history. Its
schema description and tests now make the narrower meaning explicit.
