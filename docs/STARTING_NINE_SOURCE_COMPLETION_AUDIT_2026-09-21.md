# Starting Nine source-completion audit — 2026-09-21

Status: research/source governance only. No active projection or decision
consumer exists.

## Authority and overlap matrix

| Field | Starting Nine evidence | Existing Frostline authority | Classification | Chain use | Preserve | Activate | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Starter identity / MLBAM ID | Named starter on exact team page | MLB Stats probable starter | A when MLB is unresolved; otherwise B | Identity fallback only | Yes | Only unresolved exact slot | MLB remains primary; require exact date/game/team/side and verified MLBAM identity. |
| Starter hand | Team page plus MLBAM verification | MLB Stats person record | B | None beyond verified fallback | Yes | Only with accepted fallback | Never overwrite MLB. |
| Lineup state | Projected/official state on page | Starting Nine slate lineup state / TODAY_LINEUPS | B | No | Yes | No new use | Preserve exact observed state and timestamp. |
| Opposing pitcher IP / ERA / WHIP / SO | Season summary, window not fully documented | MLB season pitching and active quality resolver | B / D | No | Yes | No | Display-only; do not replace the higher-authority MLB source. |
| Opposing pitcher platoon AVG / OPS / HR / K | Page split table, denominator/window not explicit | Savant/MLB and existing matchup/lineup inputs | B / C / D | No | Yes | No | Useful human context only; not independent corroboration and not chain identity. |
| Park runs index | Page park table | Existing Starting Nine slate park factor plus static park fallback | B / C | No | Yes | No | Display-only; do not create a second environment factor. |
| Park HR LHB / RHB index | Page park table | Existing Starting Nine slate park factor/collision context | B / C | No | Yes | No | Display-only; no second damage or park adjustment. |
| Umpire identity | Page may show assignment or TBD | MLB live-game/boxscore umpire source | B / D | No | Yes | No | MLB remains authority. |
| Umpire K / BB / runs per game | Page aggregate, window not explicit | No commissioned active umpire-rate input | D / E | No | Yes | No | Preserve for human review only; source window must be documented before research use. |
| Source URL | Exact team page | No substitute | A | Provenance only | Yes | N/A | Retain in current-state row and append-only source ledger. |
| Observed timestamp | Fetch timestamp | No substitute | A | Freshness/chronology only | Yes | N/A | Timestamp proves Frostline observation time, not the age of every displayed statistic. |
| Raw HTML/hash | Exact fetched response | Existing `SOURCE_ACQUISITION_LOG` / `SOURCE_RAW_SNAPSHOT` contract | A | Chronology and replay audit | Yes | No | Retain exact mutable-game bytes; do not create another sheet. |
| Explicit follower/bulk designation | Not present on the audited team pages | None currently | F | Required for expected bulk | If later present | Not yet | No expected bulk identity may be inferred from the current page. |

Classification key: A unique/useful new evidence; B duplicates an existing
source; C duplicates a Frostline-derived input; D lower-authority display
context; E not reliable enough for model use; F missing/inconsistent.

## Starter fallback contract

- MLB probable starter is primary.
- A team-page identity may fill only an unresolved MLB slot.
- Date, game, team, and side must match exactly.
- MLBAM ID, normalized name, pitcher position, and hand must verify through MLB.
- A partial/conflicting MLB identity fails closed.
- Ambiguous doubleheaders fail closed.
- An existing MLB identity is never overwritten.
- Source URL and observed timestamp remain attached to an accepted fallback.

## Pitching-chain observability contract

`ROSTER_PLAUSIBLE` / `[ROSTER_HISTORY_ONLY]` means an arm is on the active
roster, rested under the predeclared gate, and has prior multi-inning history.
The daily bullpen report may additionally say that arm is available. None of
those facts designates the manager's intended follower.

Only an exact, retained pregame source that names or strongly designates the
follower may populate `Expected_Bulk_Pitcher`. Until such a source exists:

- expected bulk identity/IP/pitches remain blank;
- roster-history options may remain visible;
- the expected sequence goes directly from opener/short starter to the
  unidentified relief pool;
- the shadow delta is unavailable;
- the chain stays `CHAIN_PARTIAL_NOT_PROJECTION_READY`.

## Refresh chronology

`STARTING_NINE_TEAM_PAGE_V1` is a current-state publication surface. The
exact HTML for each mutable-game fetch is retained prospectively in the
existing append-only `SOURCE_ACQUISITION_LOG` and `SOURCE_RAW_SNAPSHOT` sheets.
Each record carries URL, observed timestamp, raw hash, parser version, source
status, and MLBAM coverage. Identical bytes plus governing metadata deduplicate;
changed bytes or evidence state append. Protected games are not reacquired as
fresh pregame evidence. The source does not prove the data-through date of its
season/platoon aggregates, so that field remains blank.

## 2026-09-21 negative control

Authoritative v74 readback at the audited morning snapshot showed six
`MLB_ID_VERIFIED` team-page starters, all with `Starter_Fallback_Applied=NO`:
Trey Yesavage, Shane Baz, DJ Herz, River Ryan, Zebby Matthews, and Blade
Tidwell. All six API sides remained `CONVENTIONAL_STARTER`, had blank expected
bulk identity and IP, `NO_BULK_PHASE_EXPECTED`, no estimable shadow delta,
`Active_Input=NO`, and `SHADOW_ONLY_NOT_COMMISSIONED`. The three game summaries
each reported a zero API shadow total delta.

## Dodgers regression boundary

For `20260920_SFG_LAD`, Jack Dreyer may be represented as the named opener.
Emmet Sheehan may appear only as `[ROSTER_HISTORY_ONLY]` absent retained
pregame follower designation. He may not populate expected bulk, enter the
expected sequence, reduce generic bullpen exposure, or create a shadow delta.
Postgame order is outcome evidence and is inadmissible as a pregame backfill.

