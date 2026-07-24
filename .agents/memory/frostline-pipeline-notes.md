---
name: Frostline pipeline notes
description: Non-obvious decisions, constraints, and quirks in the Frostline MLB betting pipeline
---

## Doubleheader game_id collision
Deferred by design — two games same day same teams share an ID. No fix yet; noted in RUN_LOG.

## ODDS_HISTORY reads are tail-anchored
`readRange` drops trailing empty cells; ODDS_HISTORY rows are always appended, reads are range-bound so old snapshots stay intact.

## USER_ENTERED round-trip fragility
`writeRange` uses USER_ENTERED value input option. Sheets may reformat dates/numbers on read-back. Don't assume exact string equality on values read from cells that were written as USER_ENTERED.

## Operator Notes columns cleared each run by design
DAILY_MATCHUPS col Y (Notes) and BULLPEN_USAGE_DAILY col I (Notes) are pipeline-owned and cleared on every publish. Operator durable notes belong in SLATE_INPUT cols O–W.

## Schema drift rule: new sheets AND columns need one-off live workbook scripts
`workbookSetup.ts` only applies to new workbooks. Adding a column requires a one-off `writeRange` to the live header row; adding a whole SHEET requires a one-off `addSheet` batchUpdate + header/format writes (working template: `artifacts/api-server/create_analysis_sheets.mts` — idempotent, reads defs from workbookSchema). Symptom of forgetting: module writes fail with `Sheet "X" not found in workbook`.

## Commissioning gates (shadow + replay, 2026-07-24)
**Shadow validation (module12s_shadowValidation.ts):**
- Runs after every full-pipeline publish (mod09 → mod12s → mod10 → mod11)
- Writes to SHADOW_VALIDATION sheet (23 cols A–W); never touches CORE authorization
- Reconstructs legacy projection from GameSummaryRow audit columns — no re-fetching
- Method: ratio-scaling (legacy_runs ≈ repaired_runs × legacy_adj / repaired_adj). Valid because pitching/IP/bullpen components are identical between legacy and repaired.
- Result exposed in PublishResult as `module_09_shadow`

**Historical replay (module13_historicalReplay.ts):**
- Endpoint: GET /pipeline/replay?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&write_sheets=true
- 5 variants: LEGACY, L30_PARK, L10_PARK, BLEND, BLEND_PARK (all neutral weather — historical weather not stored)
- Projection formula: simplified (offense_rate × multiplier, each side summed) — no pitcher ERA adjustment; isolates offense rate + park effect per variant cleanly
- L30 source: MLB Stats API actual RS/G, 30-day window ending date−1, min 15 games (date-anchored, no lookahead — replaced the Fangraphs proxy after the stub discovery; replay L30 is REAL while production module09 L30 is not)
- L10 source: MLB Stats API game logs as-of each replay date (accurate). `fetchTeamRunRates(date, {lookbackDays, lastN})` opts added for the L30 window; defaults unchanged for production callers
- Park factors: today's mlbstartingnine page only — see "mlbstartingnine is today-only" below; replay flags coverage < 20 venues in errors and status goes partial
- 8 metrics per variant: MAE, median AE, bias, miss4+pct, overproject%, underproject%, calibration by band
- Writes: REPLAY_RESULTS (24 cols A–X) and REPLAY_METRICS (9 cols A–I)
- Max date range: 30 days per call

**Schema additions:** SECTION_COLORS now includes "ANALYSIS" (deep teal). New sheets: SHADOW_VALIDATION, REPLAY_RESULTS, REPLAY_METRICS.

## Module05 repair (2026-07-24): real MLB Stats API L30
`module05_fangraphs.ts` was a stub (identical hardcoded splits for all 30 teams). Now repaired:
- Calls `fetchTeamRunRates(today, {lookbackDays:30, lastN:30})` — same MLB Stats API source as module13 replay
- Back-calculates `l30_wrc_plus = (rs_per_game / 4.5) × 100` so module09's formula is unchanged (round-trip: `(wrc/100)×4.5 = rs_per_game`)
- Teams with < 15 L30 finals excluded from `teams[]`; module09's `teamSplits.length > 0` gate handles fallback naturally
- Shadow publish confirmed: 27/30 unique L30 rates, range 3.25–6.25; all 30 games BLENDED
- `TeamSplitData` gained `games_sampled`, `l30_source_status`; `FangraphsResult` gained `l30_teams_sampled`
- Replay metrics after repair are identical to pre-repair (module13 already used real MLB-API L30 per date — repair only affects live production module09)

## mlbstartingnine is today-only; pf blocks are index-aligned
- The `?date` query param is IGNORED — every fetch returns the current day's page. Historical park/lineup coverage from this source is impossible; early-morning pages are sparse (1–5 games) and fill in during the day.
- Park factor blocks are matched to games by page ORDER with a dedup on identical values — two venues with identical factor rows would shift indexes and mis-assign. Latent parser risk, not yet fixed.

## api-server routing trap (dev)
Proxy path `/api` → localhost:8080 with the FULL path forwarded (no strip); health is `/api/healthz`. Probing `localhost:80/api-server/...` silently hits the frostline Vite SPA fallback and returns fake 200 HTML — always curl `localhost:8080/api/...` directly or `localhost:80/api/...`.

## Module09 projection inputs — 65/35 BLEND_PARK CANONIZED (2026-07-24)
- `L30_WEIGHT = 0.65` × MLB Stats API actual L30 RS/G (module05 repaired) + `L10_WEIGHT = 0.35` × actual L10 RS/game
- Park modifier: 1 + (park_runs_pct/100), clamped [0.85, 1.15]; × weather, combined [0.85, 1.30]
- Park source: live scrape (VENUE_FACTOR_USED) with seasonal static fallback (SEASONAL_FACTOR_USED) for all 30 venues
- Calibration: 87-date (1,115-game) replay Apr 25–Jul 20; BLEND_PARK MAE 3.662 / MedAE 3.21
- L30_PARK narrowly beats BLEND_PARK (MAE 3.661 vs 3.662; MedAE 3.190 vs 3.210) — difference of 0.001 MAE
- Correct characterisation: BLEND_PARK is **effectively tied with the best variant** and clears all acceptance thresholds; NOT "best on every metric"
- All acceptance criteria met: bias |+0.022|, miss4+ within bounds — canonisation stands
- `module13_historicalReplay` accepts `maxDates` option (default 30, ceiling 120); router exposes `max_dates` query param
- `ParkSourceStatus`: "VENUE_FACTOR_USED" | "SEASONAL_FACTOR_USED" | "MISSING_PARK_DATA"

## Park factors — module04d static table (2026 seasonal)
- `module04d_parkFactors.ts`: exports `SEASONAL_PARK_FACTORS_2026` (Record<abbr, ParkFactors>) and `getSeasonalParkFactor(abbr)`
- All 30 home venues covered; based on 2023-2025 multi-year consensus (Baseball Reference / Statcast)
- Used by module09 (seasonal fallback when live scrape misses a game) and module13 replay (replaces today-only scrape)
- Key quirks: OAK = Sutter Health Park Sacramento (since 2025); HOU Daikin Park = Minute Maid rename

## Shadow accumulation infrastructure (2026-07-24)
- SHADOW_HISTORY sheet: appended by module12s on every publish (deduped by game_id); never cleared
- SHADOW_OUTCOMES sheet: appended by module14 settlement (deduped by game_id); paired projected vs actual totals
- Settlement endpoint: `GET /api/pipeline/settle?date=YYYY-MM-DD` (defaults to yesterday)
- Call settle daily after games complete to accumulate actual-vs-projected data in SHADOW_OUTCOMES
- Columns: Date, Game_ID, Away, Home, Repaired_Proj, Actual_Total, Error, Abs_Error, Park_Src, Away_Src, Home_Src, Settlement_TS
- Fallback hierarchy: BLENDED → L30_ONLY → L10_ONLY → LEAGUE_AVG_FALLBACK
- LEAGUE_AVG_FALLBACK always emits logger.warn — must never be silent
- L10 data requires ≥ 5 games to be valid (MIN_L10_GAMES = 5)
- Both L30_WEIGHT and L10_WEIGHT are provisional test parameters — calibrate via replay before canonising
- `teamRunRates` and `startingNineResult` are now passed to `verifyRecalculation` (were display-only before)

Run multiplier is now park × weather (not weather-only):
- Park baseline: `1 + (runs_pct / 100)`, clamped [0.85, 1.15]
- Weather modifier: temp/wind/rain deviation, clamped [0.90, 1.15]
- Combined: park × weather, clamped [0.85, 1.30]
- Park factor from module04c is seasonal venue factor — not weather-adjusted, so multiplying is not double-counting
- Missing park data → park_multiplier = 1.0 (neutral fallback, no warning needed since expected sometimes)

Lineup factor live (commissioning step 2, 2026-07-24):
- **module02c_batterSeasonStats.ts**: fetchTeamRosters (name→id map, 774 players, 30 teams) + fetchBatterSeasonStats (batched /people hitting stats — OBP, SLG, OPS, K%, BB%, PA). Same chunked pattern as module02b.
- Name matching uses Unicode NFD normalisation (`normalizeForMatch`) — handles "Jesús" ↔ "Jesus".
- **computeLineupStrength** in module09: batting-order-weighted OPS (weights [1.15,1.10,1.20,1.20,1.05,1.00,0.90,0.80,0.60], sum=9.0) vs LEAGUE_AVG_OPS=0.730; LINEUP_BLEND_WEIGHT=0.40; projected lineups get 0.60× blend weight; clamped [0.82, 1.18]; needs ≥ 60% slot coverage (MIN_LINEUP_COVERAGE) or falls back to 1.0.
- Applied multiplicatively to awayAdj/homeAdj BEFORE the pitcher model.
- GAME_SUMMARY G/H renamed Away_Lineup_Factor / Home_Lineup_Factor; GAME_INTEGRATION M renamed Lineup_Factor.
- runner.ts: fetchTeamRosters added to main Promise.all; batter stats fetched in parallel with pitcher stats; 256 batter IDs resolved across 15 games in first live run.
- Blend weight 0.40 is conservative pending replay validation — do not raise above 0.60 without replay.
- **Platoon matchup (commissioning step 3, 2026-07-24)**: `getPlatoonOpsAdj(batterHand, pitcherHand)` in module09 adds per-slot OPS delta before weighted avg. PLATOON_OPS_ADJ=0.012 (40% of historical ~30pt split). S bats get ×0.30 bonus. Both hands must be known or adj=0. `pitcherHand` sourced from `pitcherStatsMap.get(pitcher.player_id)?.hand`. Floor at .400 OPS to prevent edge cases. Adds `platoon_advantaged` / `platoon_resolved` to LineupStrengthResolution. Step 3 produces ±0.01 total run adjustments at current constants — correct at this commissioning stage.
- **Statcast xwOBA (commissioning step 4, 2026-07-24)**: module02d fetches Baseball Savant expected-stats leaderboard CSV (`/leaderboard/expected_statistics?type=batter&year=YYYY&min=50&csv=true`). Single call gets 471 batters. STATCAST_BLEND_WEIGHT=0.25 blends xwOBA quality ratio with OPS ratio; effective_ops = LEAGUE_AVG_OPS × blended_ratio. Falls back to OPS-only when xwOBA unavailable. LEAGUE_AVG_XWOBA=0.315. COL away factor correctly moves down (Coors inflates OPS vs xwOBA).
- **Step 5 derivatives (commissioning step 5, 2026-07-24)**: GAME_SUMMARY extended to 34 cols (AF=Proj_Run_Diff, AG=Away_Starter_Quality, AH=Home_Starter_Quality). SLATE_INPUT extended to 33 cols (AC-AG = Away_Spread, Away_Spread_Odds, Home_Spread_Odds, Away_ML, Home_ML). SLATE_BOARD extended to 27 cols (W=Side_Edge, X=Side_Direction, Y=Side_Decision, Z=Away_SQ, AA=Home_SQ). Side_Edge = proj_run_diff + away_spread (positive = away covers). SIDE_CORE_THRESHOLD=1.5. Spread data flows: module05b → oddsMap → module10 SLATE_INPUT → module11 SLATE_BOARD. When Odds API quota exhausted, mlbstartingnine fallback provides null spreads → NO_MARKET (correct). module05c_startingNineScraper.ts must also provide null spread fields in MarketLine push.

Audit columns added to sheets:
- GAME_INTEGRATION: 20→27 cols (A–AA), new cols U–AA: L30_RS_Estimate, L10_RS_Actual, Offense_Source_Status, Park_Runs_Pct, Park_Multiplier, Weather_Multiplier, Park_Source_Status
- GAME_SUMMARY: 18→31 cols (A–AE), new cols S–AE: 8 offense audit + 5 park/weather audit

## SLATE_BOARD / ACTIVE_BOARD_SNAPSHOT sign convention (schema v2+)
- **Variance_from_Projection = Model − Market** (positive = OVER edge, negative = UNDER edge)
- **Direction** column (OVER | UNDER | NONE) is explicit in both output sheets
- **Expected_ROI = |variance| × 0.05** — always positive
- **SLATE_BOARD is now A:V (22 cols)**: A–O original, P–V prop comparison signals (shadow mode, no CORE impact)
- **ACTIVE_BOARD_SNAPSHOT is A:P (16 cols)**: K header renamed to Edge_Strength

## Module05e — Rotowire props scraper (shadow mode, 2026-07-24)
- Fetches `rotowire.com/betting/mlb/player-props.php?book=hardrock` via plain HTTP (no browser, no auth)
- Data is embedded as flat JSON arrays directly in server-rendered HTML — locate by searching for `"hardrock_{prop}"`, walk back/forward for enclosing `[...]`
- Props available: `strikeouts` (key: strikeouts), `earned_runs` (key: er), `total_bases` (key: bases)
- Team abbr normalization map: `WAS→WSH`, `OAK/SAC→ATH`, `KCR→KC`, `TBR→TB`, `SDP→SD`, `SFG→SF`
- Starter matching uses last name only (safe for single-day slate; collisions negligible)
- TB coverage uses team abbr matching against game away/home teams
- **Why `isPaywalled: true` doesn't block**: controls export buttons only, not the embedded JSON
- Prop market direction derived from ER odds pricing (under more expensive → UNDER), not K lines
- K lines are shape comparison only — do NOT use as suppression vote (a high K line ≠ low scoring)
- SLATE_BOARD columns P–V written by module11: K signal, ER signal, TB coverage %, direction, agreement, reason, snapshot TS
- **Commissioning sequence**: ingestion → smoke test edge cases → shadow run → historical replay → only then consider CORE integration

## CORE authorization model (commissioning v1, 2026-07-23)
- **Truth labels**: CORE or NO_CORE only (PENDING if no market line). BUY/STRONG_BUY removed as auth labels.
- **CORE threshold**: 1.5 runs provisional. Replay historical slates to calibrate (1.25 / 1.5 / 1.75 / 2.0).
- **Edge_Strength metadata** (not auth): STRONG_BUY ≥ 3.0, BUY ≥ 2.0, LEAN ≥ 1.5, blank for NO_CORE.
- **Eligibility gates** (checked before separation): UNRESOLVED_STARTER, MISSING_EXPECTED_INNINGS, BULLPEN_DATA_UNAVAILABLE; then INSUFFICIENT_PROJECTION_SEPARATION if absVar < 1.5.
- **CORE_Blocker column** in SLATE_BOARD (col N) — named reason for every NO_CORE.
- **Why**: 0.5-run threshold produced 5/5 CORE on every 5-game slate — no filtering value. Eligibility gates prevent large variance from incomplete inputs slipping into CORE.

## Module09 projection formula — two-component model (2026-07-23)
Original formula `projAway = awayAdj × starterIP/9` zeroed bullpen innings. Caused structural all-UNDER bias.

**Current formula (starter + bullpen):**
```
projAway = awayAdj × (starterIP/9) × starterQual   ← ERA-adjusted starter innings
         + awayAdj × ((9−starterIP)/9) × bullpenQual ← individualized bullpen ERA
```
- `starterQual = clamp(ERA, 2.0, 7.0) / LEAGUE_AVG_ERA (4.20)`
- `bullpenQual = Available_Bullpen_ERA / LEAGUE_AVG_ERA` — weighted avg ERA of available relievers (days_rest ≥ 1, not HIGH_WORKLOAD), weighted by innings_last_7; falls back to 1.0 (league avg) if < 2 relievers have ERA data
- Direction note: home bullpen faces away batters; away bullpen faces home batters
- `pitcherStatsMap` and `bullpenResult` both passed from runner.ts to `verifyRecalculation`
- **Why**: `awayAdj` is runs/9 innings. Multiplying by `starterIP/9` discarded bullpen innings. Opener games (2 IP) were catastrophically undermodelled.

## GameSummaryRow carries eligibility context
Fields added: `away_pitcher_role`, `home_pitcher_role`, `away_expected_innings`, `home_expected_innings`, `environment_quality`, `bullpen_available`. Populated in module09, consumed by module11 eligibility gates.

## Validation: slate-size warning not critical (2026-07-23)
Game count < 13 moved from `critical_failures` to `warnings` in module07_validation.ts. Warning message prefixed `[ATYPICAL_SLATE_SIZE]`. Small slates now produce `validation_status: PASS` and `pipeline_status: success`. Only missing games, bad joins, impossible values, or failed projection outputs are truly critical.

## Module12 pipeline status was hardcoded (fixed 2026-07-23)
RUN_LOG `Pipeline_Status` was always `partial_success`. Fixed: runner passes true `overallStatus` to `archiveRunBundle`.

## Odds consensus: mode with median tiebreak (fixed 2026-07-23)
`consensusTotal()` finds all modes, falls back to lower-middle sorted element on ties. Always returns a line some book actually posted.

## SLATE_INPUT backfill is per-cell (fixed 2026-07-23)
Module 10 back-fills `Candidate_Vehicle` only if blank or "TBD"; `Odds` only if blank. `Market_Available` is the one pipeline-maintained flag in the operator range.

## One-off workbook script pattern
Run `.mts` scripts in `artifacts/api-server/` using `../frostline/node_modules/.bin/tsx <file>.mts`. Plain `pnpm exec tsx` fails there. Import from `./src/lib/sheets/client.js` and `./src/lib/workbook/workbookSchema.js` (compiled JS extensions required).
