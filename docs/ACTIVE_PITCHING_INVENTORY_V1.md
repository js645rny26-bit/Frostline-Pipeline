# Active Pitching Inventory V1 — commissioning record

Status: `TEST ONLY / READY FOR LIVE SHADOW`

Active projection impact: none. `Active_Input=NO` and
`Projection_Mapping_Status=SHADOW_ONLY_NOT_COMMISSIONED` are commissioning
sentinels.

## Prospective snapshot lifecycle

`ACTIVE_PITCHING_INVENTORY_V1` is an immutable snapshot ledger. Each mutable
pregame refresh appends a new `(Date, Game_ID, Team_Side, Snapshot_TS)` row;
it does not overwrite the earlier observation. Protected or started games do
not receive another snapshot. Exact retries with the same snapshot timestamp
are idempotent.

Settlement/replay selects the latest *complete* away/home snapshot captured
before protection. It never combines sides from different refreshes. This is
required so a late opener, bulk, or availability change can enter prospective
evidence without rewriting what the earlier run knew.

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
available pregame evidence into the first of these only when a pregame source
actually designates the follower:

`named starter/opener -> source-supported bulk/swing option -> remaining available relief pool`

Availability, roster membership, and prior multi-inning work establish only
`ROSTER_HISTORY_ONLY`. Together they cannot name the intended follower.

It preserves production `Expected_IP`, SWE `Expected_IP`, and API phase
allocation as three separate objects. It does not create a parallel workload
or bullpen-quality model.

## Source and observability map

| Field family | Source | Pregame availability | Historical replay availability | Status/fallback |
| --- | --- | --- | --- | --- |
| Named starter, identity, role | MLB schedule + Module 03 | Known | Frozen in packets | `KNOWN_PREGAME`; unresolved stays unresolved |
| Production workload | MLB D-1 game logs + Module 03 | Known | Frozen in packets | Existing active value, unchanged |
| SWE workload | Retained D-1 Savant pitch appearances | Known when retained | Frozen only for prospective SWE/API runs | Separate research object |
| Reliever identity/availability | MLB Starting Nine bullpen report | Known on live run | Not historically retained as an immutable raw/pregame chain snapshot | Availability is pool evidence, not follower designation |
| Multi-inning capability | MLB active roster + D-1 SWE appearance history | Deterministic historical description | Available only where daily source retention exists | `[ROSTER_HISTORY_ONLY]`; cannot populate expected bulk |
| Bulk identity | Explicit pregame follower designation | No current source | Unavailable | Remains blank; roster plausibility fails closed |
| Bulk expected IP | Existing SWE estimator after a source-supported identity exists | No current eligible identity | Same limitation as SWE | Workload cannot manufacture identity |
| Bulk run prevention | Existing Module 09 FIP/ERA/xERA-fallback resolver | Known when season source exists | Same as source retention | No second quality model |
| Generic bullpen quality | Existing Module 09 available-pool resolver | Known when bullpen source is live | Not a historical chain identity | Existing neutral fallback remains explicit |
| Actual chain | Official final MLB boxscore | Postgame only | Settlement diagnostic | Never used to create or repair pregame inventory |

`Expected_Leverage_Bridge` remains blank in V1 because the current pregame
source declares arm availability but not the manager's intended leverage
sequence. The available pool, long-relief options, unavailable arms, and tired
arms are still preserved.

## Follower-evidence contract

The daily availability report and D-1 appearance history may identify rested,
multi-inning roster options. They are published only as deterministic
`[ROSTER_HISTORY_ONLY]` inventory. They may not populate
`Expected_Bulk_Pitcher`, enter `Expected_Pitching_Sequence`, reduce true
bullpen exposure, or create a shadow delta.

A bulk identity becomes eligible only when a retained pregame source actually
names or strongly designates that pitcher as the expected follower for the
exact game/team/side and MLBAM identity verifies. No current source satisfies
that contract. Until one does, opener rows remain
`CHAIN_PARTIAL_NOT_PROJECTION_READY` and assign the unidentified remainder to
the generic bullpen.

Any future shadow delta may reallocate only source-supported bulk innings from
the generic bullpen quality factor to that pitcher's existing run-prevention
factor. All other offense, matchup, traffic, damage, conversion, environment,
and market inputs remain untouched.

## Starting Nine team-page chronology

`STARTING_NINE_TEAM_PAGE_V1` remains the current-state display surface. Each
exact mutable-game HTML response is also retained in the existing append-only
`SOURCE_ACQUISITION_LOG` / `SOURCE_RAW_SNAPSHOT` ledgers with URL, observed
timestamp, raw hash, parser version, MLBAM coverage, and source status. The
page does not establish a trustworthy statistics data-through date, so that
field remains blank rather than being inferred. Identical bytes and governing
metadata deduplicate; materially changed bytes or status append a new record.

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
