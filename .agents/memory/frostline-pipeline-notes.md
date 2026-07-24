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

## Schema drift rule: new board columns need one-off live header writes
`workbookSetup.ts` only applies to new workbooks. Adding a column to SLATE_BOARD, ACTIVE_BOARD_SNAPSHOT, DAILY_MATCHUPS, etc. requires a one-off `writeRange` to the live workbook's header row (pattern: `.mts` script in artifacts/api-server using `../frostline/node_modules/.bin/tsx`).

## Module09 projection inputs (Repair v2, 2026-07-24)
Offensive rate now uses a blended input, not wRC+ alone:
- `L30_WEIGHT = 0.65` × Fangraphs wRC+-derived rate + `L10_WEIGHT = 0.35` × actual L10 RS/game
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

Lineup_Strength stub removed:
- Column M in GAME_INTEGRATION and cols G/H in GAME_SUMMARY now write null
- Header renamed to Lineup_Strength_Status / Away_Lineup_Strength_Status
- Per-player model approved for development but not commissioned

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
