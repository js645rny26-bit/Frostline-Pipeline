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
