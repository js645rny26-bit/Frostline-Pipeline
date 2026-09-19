# Active Pitching Inventory V1 — commissioning record

Status: `TEST ONLY / READY FOR LIVE SHADOW`

Active projection impact: none. `Active_Input=NO` and
`Projection_Mapping_Status=SHADOW_ONLY_NOT_COMMISSIONED` are commissioning
sentinels.

## Current architecture

The active path is two-phase:

1. Module 03 resolves only the named probable pitcher and a numeric
   `Expected_IP`/`Expected_Pitches` pair.
2. Module 09 applies the opposing starter profile over effective starter
   innings.
3. Module 09 assigns `9 - Effective_Starter_Innings` to one generic available
   bullpen-quality pool.

The current path has no pregame identity/sequence object between the named
starter and that generic pool. SWE is a separate workload shadow. Module 32
and Module 14 pitching chains are post-settlement actuals and are prohibited
as pregame evidence.

## Weakness addressed

`opener + credible multi-inning follower` is structurally different from
`opener + eight innings of unidentified bullpen`. Module 36 resolves the
available pregame evidence into:

`named starter/opener -> inferred bulk/swing option -> remaining available relief pool`

It preserves production `Expected_IP`, SWE `Expected_IP`, and API phase
allocation as three separate objects. It does not create a parallel workload
or bullpen-quality model.

## Source and observability map

| Field family | Source | Pregame availability | Historical replay availability | Status/fallback |
| --- | --- | --- | --- | --- |
| Named starter, identity, role | MLB schedule + Module 03 | Known | Frozen in packets | `KNOWN_PREGAME`; unresolved stays unresolved |
| Production workload | MLB D-1 game logs + Module 03 | Known | Frozen in packets | Existing active value, unchanged |
| SWE workload | Retained D-1 Savant pitch appearances | Known when retained | Frozen only for prospective SWE/API runs | Separate research object |
| Reliever identity/availability | MLB Starting Nine bullpen report | Known on live run | Not historically retained as an immutable raw/pregame chain snapshot | Source failure/absence fails closed |
| Multi-inning capability | D-1 SWE appearance history | Deterministic historical description | Available only where daily source retention exists | Candidate is `PROBABLE_INFERRED`, never announced/known |
| Bulk expected IP | Existing SWE estimator applied to identified candidate | Available only with pitcher-specific eligible start history | Same limitation as SWE | Role fallback cannot create a credible bulk phase |
| Bulk run prevention | Existing Module 09 FIP/ERA/xERA-fallback resolver | Known when season source exists | Same as source retention | No second quality model |
| Generic bullpen quality | Existing Module 09 available-pool resolver | Known when bullpen source is live | Not a historical chain identity | Existing neutral fallback remains explicit |
| Actual chain | Official final MLB boxscore | Postgame only | Settlement diagnostic | Never used to create or repair pregame inventory |

`Expected_Leverage_Bridge` remains blank in V1 because the current pregame
source declares arm availability but not the manager's intended leverage
sequence. The available pool, long-relief options, unavailable arms, and tired
arms are still preserved.

## Inference contract

A reliever can become a source-supported bulk candidate only when:

- the same-day pregame source marks the arm `AVAILABLE`;
- MLBAM identity is present;
- the arm is not the named starter; and
- retained D-1 appearances show at least one 3+ IP appearance, at least two
  2+ IP appearances, or the existing bullpen feed describes the arm as
  `LONG_RELIEF`.

Candidate ranking is deterministic: multi-inning appearance count, maximum
prior IP, latest prior appearance, then MLBAM ID. The identity is labeled
`PROBABLE_INFERRED`. A projection delta is available only when existing SWE
returns a pitcher-specific `ESTIMATED` bulk workload and both existing bulk
and generic-bullpen quality resolvers succeed.

The shadow delta reallocates only the identified bulk innings from the generic
bullpen quality factor to that pitcher's existing run-prevention factor. All
other offense, matchup, traffic, damage, conversion, environment, and market
inputs remain untouched.

## Historical replay and proof cases

The pre-Module-36 corpus does not retain an immutable same-day pregame
reliever-availability/chain snapshot. Therefore a legitimate full historical
API replay is not currently possible. The initial historical eligible N is
zero and the replay status is `INSUFFICIENT_PROSPECTIVE_API_HISTORY`.

| Proof case | Result | Reason |
| --- | --- | --- |
| `20260917_KCR_HOU` | `NOT_OBSERVABLE_PREGAME` | Ethan Pecko cannot be promoted from final pitcher order into a pregame follower identity without a retained pregame inventory. |
| `20260917_BOS_TEX` | `NOT_OBSERVABLE_PREGAME` | Cody Bradford's postgame use is outcome evidence; the required pregame chain snapshot was not retained. |
| `20260918_OAK_CLE` | `NOT_OBSERVABLE_PREGAME` | Joey Cantillo's six postgame innings cannot be backfilled as a pregame expectation. |

These are structural proof cases, not coefficient targets.

## Commissioning sequence

- Structural/dependency audit: pass.
- Identity/source observability audit: pass with historical retention gap.
- Pure resolver smoke tests: pass.
- Full automated suite: pass.
- TypeScript/build: pass.
- Historical replay: not legitimately available; eligible N=0.
- Live shadow: pending first legitimate pregame materialization/readback.
- Active deployment: prohibited.

Future evaluation must compare current production `Expected_IP`, SWE workload,
and API phase allocation separately. Promotion requires prospective opener/bulk
improvement without unacceptable conventional-start degradation.
