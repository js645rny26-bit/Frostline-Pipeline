# Frostline Daily SOP

The workbook reading map is [WORKBOOK_ROADMAP.md](./WORKBOOK_ROADMAP.md). The independent reasoning procedure is governed by [COMMISSIONING_MANUAL_DOCTRINE.md](./COMMISSIONING_MANUAL_DOCTRINE.md). It is a manual operating layer and must not be translated into projection formulas.

## Lifecycle safety

- A prospective publish is allowed only before scheduled first pitch. At or after first pitch, use an explicitly labeled replay or settlement surface.
- A missing pregame freeze is an `AUDIT_GAP`; it is never reconstructed from current or final information.
- Published pregame vehicle and decision rows are immutable. Settlement reads them and appends outcomes and grades without running mutable pregame stages.
- Projection generation, final decision, freeze, publication, and settlement timestamps describe distinct real events.

**Schema v39 - updated 2026-08-28 - board authorization finalizes 30 minutes before first pitch; the independent pregame packet stays refreshable through legitimate pre-first-pitch runs and freezes only at first pitch. Active offensive center uses lineup quality plus bounded recent form; daily bullpen availability and five-day pitch workload use MLB Starting Nine. Exact fields live in SCHEMA_REFERENCE.**

## Daily sequence (all times ET)

1. **Morning (~8–9 AM) — baseline publish.** Records the day's **opening** totals into ODDS_HISTORY (the movement baseline), plus season stats, bullpen tiers through last night, L10 run rates, weather, and starter last outings. Umpires and some lineups will be blank — normal.
2. **Midday (~11 AM–1 PM) — context publish.** Lineups post through late morning (platoon columns fill); umpire assignments post around noon (Plate_Umpire fills). Rerun once around 1 PM if either is still blank.
3. **Pre-first-pitch (60–90 min out) — final publish.** Locks current totals, movement vs. the opener, and confirmed lineups.
4. **Your entries.** After the final publish, fill SLATE_INPUT columns O–W (vehicle, line, odds, notes). Blank cells are back-filled from consensus odds; anything you type is **never overwritten** (the pipeline maintains only the Market_Available flag).
5. **Board is FINAL when:** final publish done → lineups show `official` in TODAY_LINEUPS → Plate_Umpire filled → your SLATE_INPUT entries are in. Then read SLATE_BOARD / ACTIVE_BOARD_SNAPSHOT. The RUN_LOG row is the audit record for the day.

### Durable operator facts and ladder review

- If you supply a corrected lineup, starter role, venue/park, weather, umpire,
  bullpen state, or executable Hard Rock market before first pitch, add **one
  field per row** to `OPERATOR_EVIDENCE_OVERLAY` with `Source` set to
  `MANUAL_OPERATOR` and an ISO `Supplied_TS` before the game starts.
- Automated/reference full-game totals use half-number representation; an
  integer reference value is normalized down one half-run (`10 -> 9.5`,
  `7 -> 6.5`). A literal Hard Rock quote entered through the operator overlay
  is different: preserve its exact line and price, plus its explicit source
  and quote timestamp when provided. Never normalize, infer, or synthesize an
  executable Hard Rock quote from a reference-market value.
- That input is authoritative only for the named field. The packet records it
  and marks the game for fresh review; it does not silently change projection
  coefficients, BET/PASS, vehicle choice, or unrelated fields.
- Record the independent full-game total review in `FULL_LADDER_AUDIT` before
  first pitch: directional truth, run band, available half-number totals,
  preferred vehicle, BET/PASS, and blocker. Price is execution metadata, not
  game truth. Leave ticket status as `NO_WAGER_REPORTED` unless a wager is
  explicitly reported.

## What auto-runs vs. what you do

- **Auto, every publish** (dashboard **Run Pipeline** button, or `POST /api/pipeline/publish`): schedule, pitcher workloads and roles, weather, bullpen usage + quality tiers, posted lineups, starter previous outings, umpires, team run rates, odds snapshot → ODDS_HISTORY, pitcher season stats, all sheet writes, boards, RUN_LOG.
- **You:** trigger the three publishes above; own SLATE_INPUT O–W.
- **Active math:** `GAME_SUMMARY` now uses the exact confirmed/prospective lineup against the opposing starter to separate traffic, damage/conversion, expected starter workload, and inherited bullpen exposure. Read `*_Matchup_Profile_Status` first: `NEUTRAL` means the formula intentionally preserved the prior rate/quality path because exact evidence was unavailable.
- **Input check:** before interpreting a component or adding a source, read `MODEL_INPUT_CATALOG`. It distinguishes active inputs from shadows, frozen copies, legacy aliases, display-only fields, decommissioned placeholders, and known gaps. `Current_Observed_*` and `Freshness_State` show whether its source materialized for the requested slate.
- **Settlement:** run the daily settlement workflow for the completed slate
  date. It reads frozen packets only and adds allocation, starter-dimension,
  traffic/damage/conversion, bullpen-timing, game-truth replay, and ladder
  diagnostics; it must never rerun mutable pregame calculation for that date.
- **Warning:** the Notes columns in DAILY_MATCHUPS (col Y) and BULLPEN_USAGE_DAILY (col I) are **cleared on every publish**. Durable notes belong in SLATE_INPUT.

## Source authority (when feeds disagree or fail)

- **Odds:** consensus total = most common point across all books (median as tiebreak); the source book is recorded per game. Movement = current − first snapshot of the day. Each publish spends 1 Odds API request — remaining quota is printed in the run logs.
- **Weather:** weathermlb.com daily file. If it isn't published yet, the run uses neutral defaults and flags Weather_Source — treat run environment as low-confidence.
- **Lineups:** `official` beats `projected` — the status is per game in TODAY_LINEUPS. Platoon numbers are computed from whatever lineup is posted.
- **Bullpen workload:** MLB Starting Nine's daily `AVAILABLE` / `TIRED` / `UNAVAILABLE` report and five-day pitch map are authoritative for usable-arm state. Inside The Pen may enrich matched seven-day innings history but cannot override that daily status.
- **Umpires:** MLB boxscore assignments only. Blank before ~noon ET is normal, not an error.
- **Pitcher/team stats:** MLB Stats API, regular-season splits only.

## Warning triage

- **Benign, ignore:** validation FAIL "Game count below minimum" on small slates (fewer than 13 games); umpires blank before noon; platoon blank before lineups post.
- **Investigate:** RUN_LOG Pipeline_Status of `failure` or `partial_success` (a sheet write went wrong — check the run logs); any module logging status `failure`; weather fallback on an outdoor slate; umpires still blank after ~2 PM ET; platoon still blank near first pitch; ODDS_HISTORY not growing (odds quota exhausted).
- **Rule:** blanks always mean "feed unavailable" — the pipeline never fabricates a value.

The former synthetic TEAM_FORM wOBA, strength-of-schedule, and bullpen-rest
cells are intentionally blank and labeled `DECOMMISSIONED`. They were never
active evidence and will not masquerade as it.

## Known limitations

- **Doubleheaders share one game ID**, so odds, umpire, and platoon joins collapse to a single entry for both games. Handle DH days manually until the ID format is extended.
- Column dictionary lives in the SCHEMA_REFERENCE tab (generated from the code schema). Version history: **v1** initial workbook · **v2** (2026-07-23) totals expansion — starter outings, umpires, season stats, line movement, platoon, bullpen tiers, ODDS_HISTORY.

## SSAT family reading

Treat SSAT v1 and v2 as one starter-survival evidence family until the
`STARTER_SURVIVAL_DIFFERENTIATION_AUDIT` demonstrates material differentiation
through commissioning review. Read the base projection beside the SSAT family
range; do not count v1/v2 agreement as separate confirmation.
