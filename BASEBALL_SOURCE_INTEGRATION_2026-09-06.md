# Baseball-source integration contract — 2026-09-06

## Purpose and non-negotiable order

Frostline's published projection is a **price-blind game-truth forecast**.
Market objects remain downstream comparators only.  No source in this document
may read a line, price, ticket, settlement result, or post-first-pitch state.

The acquisition docket identifies useful baseball evidence; it is not a license
to turn every source into another additive model vote.  A source moves through
these stages:

1. retain an immutable raw response and validate its schema/coverage;
2. construct a frozen, cutoff-safe candidate feature;
3. test incremental information in expanding, date-ordered replay/shadow work;
4. promote only the proven feature into one named correlated feature family;
5. freeze the selected source, value, sample state, and fallback in the packet.

No source may be silently converted to a neutral number when unavailable.
Absence is `UNAVAILABLE`, `PARTIAL`, `SCHEMA_DRIFT`, or a named downstream
fallback/gap.  A fallback value is never evidence that the missing source was
neutral.

## Current architecture audit

| Family | Existing active path | Current limitation | Integration rule |
|---|---|---|---|
| Exact lineup / offense | Starting Nine exact order/coverage; MLB season OPS/OBP/SLG/BB/K; Savant batter xwOBA and hard hit | Handedness is a bounded broad platoon adjustment, not an exact pitch-arsenal interaction | Keep exact lineup identity as the join root; all player sources join to MLBAM ID and use order/expected-PA weights. |
| Starter center | MLB FIP primary, ERA fallback over effective starter innings | No reliable pitcher-specific workload/role-distribution source is yet commissioned | One true-skill source per pitcher; workload, traffic, and damage remain distinct families. |
| Starter traffic / damage | Exact lineup BB/K/OBP and hard-hit vs pitcher BB/K/WHIP/HR/9 | Expected-contact quality not available when a traditional pitcher field is missing | Do not count xwOBA/xSLG/HH/arsenal measures independently of traffic/damage. |
| Bullpen | Starting Nine availability plus season ERA and recent workload weighting | No proved deployment/hierarchy or true-skill replacement | Availability gates the pool; quality selects one source per arm; role hierarchy cannot override availability. |
| Environment | Starting Nine/static park plus weather/roof resolver | Structural Statcast park truth not yet connected | Park is one structural factor; weather remains a separate daily context and cannot be double counted. |
| Distribution | Module 29 frozen direct-total PMF research (Poisson/NB/hurdle-NB/CMP/empirical) | No candidate source gets authority from one slate or from point-error anecdotes | Center and shape require separately pre-registered tests; nothing here bypasses Module 29. |

## Implemented phase 1 — safe quality-family gap fill

`SOURCE_SAVANT_PITCHER_EXPECTED` is now fetched from the official Baseball
Savant expected-statistics pitcher CSV with `min=1`, retaining unqualified
pitchers for source completeness.  Before use it is stored in
`SOURCE_ACQUISITION_LOG` and `SOURCE_RAW_SNAPSHOT`, with request URL, fetch
time, pregame data-through date, response SHA-256, bytes, parsed row count,
column contract, MLBAM coverage, parser version, source status and fallback.

| Required report item | Implementation |
|---|---|
| Source/raw fields | Savant `player_id`, `pa`, `bip`, `era`, `xera`, `est_woba`, `est_ba`, `est_slg`; the untouched CSV is chunk-retained before use. The season leaderboard is admitted only during a full-slate pregame run; after any game starts it is withheld because the endpoint has no data-through-date parameter. |
| Family | `STARTER_QUALITY` / `BULLPEN_QUALITY`: one correlated true-skill/contact-quality family. |
| Existing input | Supplements only a **missing** MLB FIP/ERA value. It does not replace a present FIP or ERA. |
| Transformation | `clamp(xERA) / league ERA`; the existing bounded factor is preserved. Bullpen xERA is weighted by the existing availability/workload weights only for arms lacking ERA. |
| Sample gate | `pa >= 100` for an active fallback. The download retains all rows so low-sample evidence remains visible rather than disappearing. |
| Missing behavior | Traditional FIP/ERA still wins. Missing traditional quality + absent/under-gate xERA resolves to `LEAGUE_NEUTRAL`; an under-gate Savant row is not converted to zero. Failed raw retention removes the map from that run and logs `SOURCE_SNAPSHOT_RETENTION_GAP`. |
| Double-count protection | xERA cannot coexist with FIP/ERA for a starter or reliever. xwOBA/xSLG are retained but not used in this phase; they cannot separately modify traffic or damage. |
| Outputs | Existing `GAME_SUMMARY` starter/bullpen quality factor only when traditional data is missing. Four frozen packet/source-lineage fields identify `FIP`, `ERA`, `STATCAST_XERA_FALLBACK`, mixed bullpen fallback, or `LEAGUE_NEUTRAL`. No market, vehicle, authorization, or distribution output changes. |
| Tests | Parser/schema-drift/hash/chunk tests; starter precedence and sample gate; bullpen no-double-count and insufficient-sample tests; packet-schema and lineage tests. |
| Replay evidence | `NO_ELIGIBLE_FALLBACK_REPLAY_YET` until settled frozen packets contain the fallback state. This phase is an evidence-completeness repair, not a claim that xERA improves the center. |

## Acquisition docket governance

| Source/candidate | Family | Initial status | Required candidate feature and protection | Promotion evidence / current gap |
|---|---|---|---|---|
| Statcast pitch-level CSV | Batter/pitcher quality, recent stuff, umpire evidence | `READY_FOR_SOURCE_FOUNDATION` | Raw day-chunks; Season/L30/L14/L5 from events through slate date minus one; MLBAM joins; validate core columns before accept. | Needs backfill, unified rolling-window implementation, and date-ordered incremental replay. |
| Savant pitch arsenal, pitcher + hitter | Exact lineup × weighted arsenal collision | `READY_FOR_PROSPECTIVE_SHADOW` | Pitcher usage weights × actual lineup order/PA weights; shrink hitter pitch-type splits to hitter broad quality at low samples. | Must beat the present broad matchup profile without double-counting xwOBA/HH/RV. |
| Savant expected pitcher statistics | Starter/bullpen true skill | `ACTIVE_GAP_FILL_ONLY` | Implemented above. | Accumulate fallback-state replay; no broader contact-quality promotion yet. |
| Pitch movement / velocity | Starter failure / stuff-change research | `READY_FOR_PROSPECTIVE_SHADOW` | Same-pitcher, same-pitch baseline versus L30/L14/L5, minimum pitch counts. | Requires a predeclared material-change rule and starter-window incremental test. |
| Fielding Run Value + OAA | Post-contact defense / conversion | `READY_FOR_PROSPECTIVE_SHADOW` | Expected starting defenders by MLBAM/position; use Fielding Run Value as family head, OAA explanatory only. Bounded post-contact modifier. | Need position/innings coverage and a game-level conversion replay; never sum FRV plus OAA. |
| Baserunning Run Value | Traffic-to-runs conversion | `READY_FOR_PROSPECTIVE_SHADOW` | Exact lineup expected-PA weighted; total baserunning value is family head, SB/XB are components. | Need opportunities/sample shrinkage and conversion incremental replay. |
| Catcher framing/blocking/throwing | Catcher / umpire / ABS context | `RESEARCH_GAP` | Starting catcher only; block/throw are conversion effects; framing belongs to one ABS-era contextual family. | 2026 ABS-era recalibration and opportunities are mandatory; no historic framing coefficient reuse. |
| ABS challenges + pitch-level umpire model | Strike-zone context | `RESEARCH_GAP` | Preserve actor scope, opportunities, flips and current-game participants. | Requires a separately validated ABS-era called-strike model; never a standalone run adjustment. |
| MLB transactions + FanGraphs injury report/news | Roster / workload / role state | `READY_FOR_SOURCE_FOUNDATION` | MLB transactions are roster authority; other feeds enrichment only; explicit narrative tags only. | Needs MLBAM mapping and an auditable rule that a stated restriction affects workload/role, not a guessed talent penalty. |
| FanGraphs bullpen hierarchy | Bullpen likely deployment | `READY_FOR_PROSPECTIVE_SHADOW` | Role × Starting Nine availability × workload × existing true-skill quality. | Must not replace the daily availability gate; needs game deployment replay. |
| Statcast 3-year park factors | Structural park | `READY_FOR_PROSPECTIVE_SHADOW` | Regressed structural run factor family head; HR/contact components explain shape only. | Need venue map and direct comparison with current park factor; weather interaction held separate. |
| Bat tracking | Batter swing-quality change | `SHADOW_ONLY` | Exact lineup, sample-gated change against hitter own baseline. | Must show information beyond xwOBA/hard hit before promotion. |
| FanGraphs true-talent forecasts | Small-sample shrinkage prior | `SHADOW_ONLY` | ID-mapped forecast horizon and snapshot date; use only as a shrinkage challenger. | Cannot replace game truth without prospective incremental evidence. |

## Explicitly unsupported or deferred shape features

- Historical LOB%, ERA-FIP, and strand-rate gaps are not persistent width traits.
- Batting-order rearrangement is not a separate shape signal once lineup talent is
  represented.
- Humidity and pressure do not receive independent dispersion coefficients.
- Bullpen reliance and opener labels are not presumed to widen totals; both need
  role-tagged, prospective settled evidence.
- The current role-derived Expected-IP layer is not a dispersion source until its
  workload trace is independently commissioned.

## Reproducibility and promotion protocol

Every proposed feature must record its source snapshot ID, raw/derived sample,
window cutoff, shrinkage target/weight, status, and correlation family in the
frozen packet or an immutable companion snapshot.  Candidate comparison is
expanding, date-ordered and price-blind.  It must report game-truth effects
(center error, allocation, mechanism classification) and, where applicable,
Module 29 proper scores, discrete PIT, interval behavior, and paired
slate-block uncertainty.  A feature with no stable incremental result remains
shadow-only or is rejected; it is not retained as an ungraded permanent vote.

## Hard Rock whole-number rule

Florida executable Hard Rock full-game totals are accepted only as literal
half-number markets. A supplied whole-number Hard Rock total is rejected as
`INVALID_LITERAL_EXECUTABLE_HARD_ROCK_FULL_GAME_TOTAL`, never normalized into
an executable line and therefore never creates a Hard Rock push. Literal
reference markets are retained separately for historical provenance and are
not Hard Rock opportunities.
