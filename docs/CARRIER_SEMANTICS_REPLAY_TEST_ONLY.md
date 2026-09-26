# Carrier Semantics Replay — Test Only

Status: `RESEARCH_ONLY / NOT_COMMISSIONED`

This task is intentionally separate from the Sept. 25 human-truth ledger repair. It may not rewrite historical carrier labels, mechanism text, projections, decisions, or authorizations.

Replay the prospective carrier label under four candidate rules:

- `ABS_ONLY`
- `REL_ONLY`
- `OR_RULE`
- `AND_RULE`

Candidate absolute allocation-margin thresholds:

- 0.5 runs
- 0.75 runs

Candidate relative allocation-margin thresholds:

- 8%
- 10%

Mandatory boundary cases:

- `20260925_PIT_DET`
- `20260925_ARI_SDP`
- `20260925_HOU_OAK`

Also evaluate `Mechanism_Specificity_Flag` as an observability signal. Report sample sizes, boundary behavior, and stability before recommending any production threshold. No production threshold or carrier rewrite is authorized.

The replay must not reduce carrier confidence to allocation-gap size alone.
Predeclare a second, text-structure view using only the frozen mechanism text:

- `ASYMMETRIC_CARRIER_LANGUAGE`: one team is named as the scoring engine and the
  other as a capped or secondary contributor.
- `TWO_SIDED_OR_HEDGED_LANGUAGE`: the text says the game is two-sided, both
  teams have material access, or otherwise weakens the asserted carrier.
- `LOW_SPECIFICITY_REFERENT`: the frozen contract already carries a specificity
  warning or does not identify the pitcher/phase responsible for the carrier.

This is an observability hypothesis, not a sentiment model and not permission to
rewrite frozen prose.  `ARI_SDP` (0.4-run gap, called side held) and `HOU_OAK`
(0.9-run gap, called side flipped) are mandatory adverse boundary examples;
`PIT_DET` remains the near-balanced canonical boundary.  With only these cases,
any language result is descriptive and the expected governance result is
`INSUFFICIENT_SAMPLE`.
