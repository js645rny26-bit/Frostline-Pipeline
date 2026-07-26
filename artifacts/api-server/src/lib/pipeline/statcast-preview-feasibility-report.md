# Statcast Game Preview — Phase 0 Feasibility Report

**Date:** 2026-07-26  
**Task:** #63 — Statcast Game Preview Pipeline Integration  
**Scope:** Phase 0 only. No production code written. No workbook changes. No schema version change. No projection or authorization changes.

---

## Finding 1 — Root Cause of the `Statcast_Last_Updated` Confusion

**`Statcast_Last_Updated` is a misleading generic timestamp.**

In `module08_feedWriter.ts` line 115, both `FanGraphs_Last_Updated` (col W) and `Statcast_Last_Updated` (col X) are stamped with the same `now` value at the moment module08 writes DAILY_MATCHUPS:

```
now,   // W: FanGraphs_Last_Updated
now,   // X: Statcast_Last_Updated
```

No actual Statcast fetch occurs. The field name is inaccurate — it records when module08 ran, not when any Statcast data was ingested. This confirms the identical-timestamp observation from the workbook.

Additionally, `module02_statcast.ts` (misnamed) fetches **pitcher workload** from the MLB Stats API game log — not from Baseball Savant Statcast. The file's own header comment says: *"Baseball Savant's statcast_search/csv endpoint now returns only aggregated career stats (one row per pitcher) and no longer serves pitch-level or date-filtered data."*

---

## Finding 2 — Available Sources, in Priority Order

### Source 1 (INVESTIGATED): Official MLB Stats API
- **URL pattern:** `https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`
- **Source owner:** MLB Advanced Media / MLB Stats API (official)
- **Request method:** HTTP GET, no authentication
- **Pregame availability:** YES — confirmed for three Pre-Game games today
- **What it provides:**
  - `probablePitchers` (player IDs and full names)
  - `weather` (condition, temp string, wind string)
  - `status`, `teams`, `venue`, `datetime`
  - `officials` (umpires, via boxscore endpoint)
  - NO Statcast-specific metrics — no xwOBA, EV, spin rate, etc.
- **Doubleheaders distinguishable:** YES — each game has a unique `gamePk`
- **Historical availability:** YES — game feed archives remain accessible by gamePk
- **Rate limits:** No documented limit; tested 5 concurrent requests, all 200 in < 185ms
- **Assessment:** Excellent for identity resolution, weather, and probable pitchers. Zero Statcast content.

### Source 2 (INVESTIGATED): Baseball Savant Game Preview Page
- **URL pattern:** `https://baseballsavant.mlb.com/preview?game_pk={gamePk}`
- **Source owner:** MLB / Baseball Savant (official)
- **Request method:** HTTP GET, no authentication
- **Response format:** HTML page with server-rendered `var teams = {...}` JavaScript variable (NOT a JSON API)
- **Pregame availability:** YES — confirmed for five distinct Pre-Game games (822706, 823354, 824730, 824810, 824246), all returned HTTP 200 with data
- **What it provides (per player in the expected lineup/roster):**
  - `exit_velocity_avg`, `launch_angle_avg`, `hard_hit_percent`
  - `xwoba`, `xslg`, `xba` (expected statistics)
  - `k_percent`, `bb_percent`, `whiff_percent`
  - `sprint_speed`, `barrel_batted_rate`
  - Batted-ball profile: `popups_percent`, `flyballs_percent`, `linedrives_percent`, `groundballs_percent`
  - Direction profile: `pull_percent`, `straightaway_percent`, `opposite_percent`
  - Contact quality: `poorlyweak_percent`, `poorlytopped_percent`, `flareburner_percent`, `solidcontact_percent`
  - Zone/swing metrics: `z_swing_percent`, `oz_swing_percent`, `iz_contact_percent`, `oz_contact_percent`, `swing_percent`
  - `n_outs_above_average` (defensive; not relevant for run projection)
  - `percent_rank_*` percentile rank for each metric
  - `didNotQualify` flag (see limitation below)
  - Traditional season stats via `seasonStats.batting` (avg, OBP, SLG, OPS, strikeOuts, etc.)
- **What it does NOT provide:**
  - Game-specific projections (these are season aggregates)
  - Pitcher spin rate in the roster Statcast fields
  - `hitterPlusRows` / `pitcherPlusRows` — these were `null` for all five tested games (may require a separate data tier or are unpopulated before game time)
  - No explicit game number for doubleheaders within the page data (distinguishable only via the gamePk URL parameter)
- **Doubleheaders distinguishable:** YES — each game has a unique gamePk that is the join key. Confirmed: gamePk 823519 (game 1) and 824732 (game 2) for BAL @ BOS on 2026-07-22 are separate pages returning separate team data.
- **Historical availability:** PARTIAL — the page appears to serve current-season data only. Past game preview pages may redirect to box scores; not tested for archival use.
- **Starting-pitcher changes reflected:** CONDITIONALLY — the page uses the live roster + MLB Stats API probable pitcher data. If a probable pitcher changes before the page is fetched, the updated starter appears. There is no "was this pitcher the original probable?" field — a pitcher change is invisible unless the pipeline polls and compares.
- **Rate limits:** No 429 or blocking observed on 5 rapid concurrent requests. No documented rate limit policy for this endpoint.
- **Expected failure modes:**
  - Page restructure invalidates the `var teams` regex parser (fragile HTML extraction)
  - `hasLineup: false` — lineup not yet posted (metrics still available from roster, but batting order unknown)
  - `hasProbable: false` — no probable pitcher listed; pitcher Statcast data available from full roster only
  - `didNotQualify: "*"` — player has insufficient PA/BF to produce reliable Statcast metrics
  - Network timeouts or temporary 503 during high-traffic periods (MLB infrastructure)

### Source 3 (INVESTIGATED): Baseball Savant `/gf` Endpoint
- **URL:** `https://baseballsavant.mlb.com/gf?game_pk={gamePk}`
- Returns JSON with lineup player IDs, team metadata, and umpires (pregame)
- Adds at-bat level Statcast data (exit velocity per play, WPA, etc.) only for **in-progress and final** games
- NOT useful for pregame Statcast metrics — pregame response contains no Statcast quality fields per player

### Source 4 (INVESTIGATED): MLB CMS Preview Story
- **URL:** `https://dapi.cms.mlbinfra.com/v2/content/EN-us/stories/gamepreview-{gamePk}`
- Returns editorial (human-written preview narrative) with tags, slugs, and publication metadata
- NOT machine-readable Statcast data

---

## Sample Payloads (Three Games, Repeatable Requests)

### Game 1 — ARI @ WAS (gamePk 822706, Pre-Game, 2026-07-26)
**Probable pitchers:** Kohl Drake (ARI, id 684442), Miles Mikolas (WAS, id 571945)

Miles Mikolas Statcast fields:
- `k_percent: 12.2`, `bb_percent: 4.8`, `exit_velocity_avg: 89.9`, `launch_angle_avg: 11.5`
- `hard_hit_percent: 41.6`, `xwoba: .344`, `xba: .283`, `xslg: .489`
- `whiff_percent: 14.7`, `barrel_batted_rate: 8.8`, `batted_ball: 346` (BF)
- `didNotQualify: ""` (qualifies)

Kohl Drake Statcast fields:
- `k_percent: 23.8`, `bb_percent: 9.5`, `exit_velocity_avg: 87.7`, `launch_angle_avg: 19`
- `hard_hit_percent: 46.2`, `xwoba: .359`, `xba: .286`, `xslg: .415`
- `whiff_percent: 33.3`, `barrel_batted_rate: 15.4`, `batted_ball: 13` (BF)
- `didNotQualify: "*"` — DOES NOT QUALIFY (insufficient sample, 13 BF)

Lineup: 26 hitters in roster, 12 (46%) marked `didNotQualify`.

### Game 2 — TOR @ BOS (gamePk 824730, Pre-Game, 2026-07-26)
- `hasLineup: true`, `hasProbable: true` for both sides
- Same Statcast field set confirmed present in roster hitters
- `hitterPlusRows: null`, `pitcherPlusRows: null` (same as Game 1)

### Game 3 — BAL @ BOS Game 2 DH (gamePk 824732, Final, 2026-07-22)
- `hasLineup: true`, `hasProbable: true` for both sides
- 27 hitters with EV data, 15 (56%) marked `didNotQualify`
- Confirmed distinct gamePk from game 1 of the same DH — doubleheader games are natively distinguishable

---

## Critical Limitations

### L1 — HTML scraping, not a JSON API
The Statcast player data is embedded in a server-rendered JavaScript variable (`var teams = {...}`) in an HTML page. There is no documented machine-readable JSON endpoint for this data. A regex or DOM parser is required. Page restructures will silently break the integration.

### L2 — Season aggregates, not game-specific projections
These are each player's full-season Statcast metrics — NOT projections for tonight's game. They do not account for recent form, park, weather, opponent, or lineup context. They are reference data, not a pregame run-estimate signal.

### L3 — `didNotQualify` rate is high
Across three tested games, 46–56% of hitters and some probable pitchers have `didNotQualify: "*"`, meaning their Statcast metrics are below the minimum sample threshold. Any integration must handle null/missing values gracefully for nearly half the lineup in every game.

### L4 — `hitterPlusRows` / `pitcherPlusRows` unavailable
These fields were `null` in all five tested pregame games. They likely represent Statcast+ normalized scores (e.g., xBA+, xwOBA+) — the most useful comparative metrics. Their absence from the live pregame data means they are either not yet generated before game time or require a different access path.

### L5 — Double-counting risk with existing Frostline inputs
`xwOBA` and exit velocity are correlated with the `wRC+` already used in the offensive rate calculation (both measure contact quality). `k_percent` and `bb_percent` partially overlap with `ERA`/`FIP`. `hard_hit_percent` and `barrel_batted_rate` overlap with the starter quality factor. Adding these Statcast fields without a double-counting audit could amplify existing signals rather than add independent information.

### L6 — No documented API endpoint; no stability guarantee
Baseball Savant does not document `https://baseballsavant.mlb.com/preview?game_pk={gamePk}` as a machine-readable data source. The `var teams` structure is an implementation detail that could change without notice.

---

## Feasibility Verdict

**FEASIBLE_WITH_LIMITATIONS**

Season-level Statcast metrics (xwOBA, EV avg, whiff%, barrel rate, K%, BB%) are accessible for each player expected to play today via the Baseball Savant preview page. Requests are fast, no authentication required, and doubleheaders are natively distinguishable by gamePk. The MLB Stats API provides complementary identity and weather data as a stable documented JSON source.

However, the integration path has significant operational constraints:
1. HTML parsing dependency (fragile, not a documented API)
2. Season aggregates only — no game-specific projection signal
3. ~45–55% of hitters in any game do not qualify for Statcast metrics
4. Double-counting risk with existing Frostline inputs requires a careful Phase 3 audit before any projection influence
5. `hitterPlusRows` / `pitcherPlusRows` (the normalized scores most useful for comparisons) are not available pregame

**Outcome A criteria NOT met** — a usable source exists.  
**Outcome B work is NOT yet authorized** — requires explicit Neon approval after reviewing this report.

---

## Summary Table

| Criterion | Result |
|---|---|
| Feasibility verdict | FEASIBLE_WITH_LIMITATIONS |
| Official source identified | YES — Baseball Savant preview page (HTML, not JSON API) |
| Source owner | MLB / Baseball Savant |
| Request method | HTTP GET, no auth |
| Pregame availability | YES — confirmed across 5 games |
| Fields available | xwOBA, xBA, xSLG, EV avg, launch angle, hard hit%, whiff%, K%, BB%, barrel rate, batted ball profile, sprint speed, traditional season stats |
| Fields unavailable | hitterPlusRows/pitcherPlusRows (null), spin rate, game-specific projections |
| Doubleheaders distinguishable | YES — native gamePk separation |
| Starting-pitcher changes reflected | CONDITIONALLY — live at fetch time, no change-detection |
| Historical availability | PARTIAL — current season only tested |
| Rate limit / blocking | None observed (5 concurrent requests, 200 each) |
| Expected failure modes | HTML parser breakage, didNotQualify for ~50% of players, hasProbable/hasLineup false |
| Projection logic changed | NO |
| Authorization logic changed | NO |
| Canonical workbook published | NO |
| Schema version changed | NO |
| Files changed | This report only |
| Recommended next state | Await Neon approval before Phase 1. If approved: build `var teams` JSON extractor with gamePk identity verification, per-player `didNotQualify` handling, and Phase 3 double-counting audit before any projection influence. |

---

## Files Changed

- `artifacts/api-server/src/lib/pipeline/statcast-preview-feasibility-report.md` — this report (no pipeline code)

## Authorization State

```
Projection logic changed:   NO
Authorization logic changed: NO
Canonical workbook published: NO
Schema version changed:      NO
Engine status:               NO CORE — RESEARCH-ONLY
```
