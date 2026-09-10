# Batter-vs-Hand Performance Split (BVH) V1

## Status

- Version: `1.0.0`
- Build state: `SHADOW_ONLY_PROSPECTIVE_V1`
- Active projection input: `NO` (`BVH_ACTIVE_INPUT = false`)
- Source: `SOURCE_SAVANT_PITCH_LEVEL`
- Market input: none

BVH V1 refines the existing exact-lineup offense-versus-opposing-starter-hand object. It is not an independent run adjustment and does not enter bullpen innings.

## Source-to-feature contract

| Source/raw fields | Frostline family | Existing input refined | Transformation | Sample and missing behavior | Consumer |
|---|---|---|---|---|---|
| `game_date`, `game_pk`, `at_bat_number`, `batter`, `p_throws`, `events` | Confirmed-lineup offense vs starter | Fixed `+0.012 OPS` nominal platoon proxy | One terminal event per `(game_pk, at_bat_number)`; official AB/OBP/TB rules; group by MLBAM batter and pitcher hand | Same-season raw PA; historical same-hand player prior only at 200+ PA, otherwise cutoff-specific same-hand league prior; fixed `k=150`; zero sample returns the prior with `NO_SPLIT_SAMPLE` | Starter-window matchup factor only |

The active projection retains the commissioned coarse platoon path. The BVH counterfactual removes the fixed nominal platoon increment from its candidate baseline and maps the shrinkage-aware split-to-stable-OPS ratio through the already commissioned lineup blend (`0.40`; projected lineups receive the existing `0.60` confidence discount). The candidate factor is applied only to `starter_attack_runs`. Bullpen continuation, traffic, damage, park/weather, vehicle, and authorization logic are not changed.

## Correlation and double-count protection

- The BVH candidate replaces/refines the existing handedness contribution inside its counterfactual; it is not added beside the active coarse path.
- Each hitter is consumed once through the lineup-weighted opposing-hand profile.
- The exact same exported batting-order weight vector used by the commissioned lineup calculation is reused; BVH does not maintain a second weighting policy.
- Stable OPS/xwOBA remains the talent center; raw split OPS is shrunk rather than treated as a second talent estimate.
- The BVH factor affects only expected starter exposure. It cannot describe bullpen innings.
- A planned opener can affect only its planned short window. An unresolved pitcher/chain produces a neutral matchup factor with explicit uncertainty.
- Evidence availability is evaluated separately for each batting side; an unresolved hand or lineup on one side cannot erase a usable candidate for the other.
- Traffic, damage, and Statcast contact families remain separate and unchanged.

## Evidence and missing-data behavior

Every current batter-hand estimate preserves raw PA/OBP/SLG/OPS, prior and prior source, shrinkage weight, final OPS, status, cutoff, freshness, parser integrity, and deterministic hash. `TODAY_LINEUPS` preserves both hand splits plus status, raw PA, prior source, and MLBAM ID. The immutable projection audit also freezes slot-level MLBAM/sample/value driver traces.

Missing identity or source evidence is explicit. It never becomes a numeric zero. Unknown Savant event values remain commissioning failures until classified; `truncated_pa` is explicitly counted and excluded as a non-PA terminal record.

## Commissioning evidence

The network-only 2026 audit for the Sept. 8 slate read 164 scheduled regular-season dates and produced:

- 639,042 pitch rows inspected
- 164,185 terminal event records
- 96 no-terminal/malformed groups exposed
- 292 `truncated_pa` records explicitly excluded from rate denominators
- zero unclassified events
- exact D-1 freshness through 2026-09-07
- identical deterministic hashes after input-order reversal
- 270/270 current lineup identities matched
- 270 distinct unrounded RHP estimates and 269 LHP estimates

This commissions the parser behavior in local/network validation. It does not by itself authorize the candidate or prove workbook materialization.

## Replay boundary

Historical packets before BVH did not freeze exact hitter MLBAM identities and split evidence. They cannot be reconstructed after results without violating the temporal firewall. Therefore the legitimate replay begins only with prospectively frozen `BVH_PROJECTION_HISTORY_V1` rows. The Aug. 24 target is usable only where an exact, cutoff-safe lineup snapshot already exists; otherwise the row is explicitly unavailable rather than backfilled from postgame data.

## Promotion gate

BVH data derivation is commissioned, but projection consumption remains shadow-only. Promotion review cannot begin before 200 eligible prospectively settled games. At that checkpoint, run the declared paired error comparison and acceptance checks, inspect total and team-allocation error, coverage/hand cohorts, materially changed games, cutoff integrity, and double-count protection. N=200 does not auto-promote the feature; it authorizes a documented `PROMOTE`, `HOLD`, or `REJECT` review.

The first 15 prospectively settled games remain immutable evidence of the period in which BVH was active. They are not rewritten or discarded. New unfrozen packets use the coarse platoon projection as active truth while continuing to freeze BVH as the paired candidate.
