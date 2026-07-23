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

## SLATE_BOARD / ACTIVE_BOARD_SNAPSHOT sign convention (as of schema v2, fixed 2026-07-23)
- **Variance_from_Projection = Model − Market** (positive = OVER edge, negative = UNDER edge)
- **Direction** column (OVER | UNDER | NONE) is explicit in both output sheets
- **Expected_ROI = |variance| × 0.05** — always positive; direction tells you which side
- Before this fix, ROI was `variance × 0.05` (sign-preserving), causing negative ROI on UNDER plays despite STRONG_BUY recommendation — a visible contradiction

**Why:** CORE decision is magnitude-only (|variance| ≥ 0.5); Recommendation tiers are also magnitude-only. ROI must follow the same convention or it contradicts the recommendation on UNDER plays.

## Module09 projection formula — two-component model (fixed 2026-07-23)
The original formula was `projAway = awayAdj × starterIP/9`, which modelled only the starter's innings and zeroed out bullpen innings. This caused structural all-UNDER bias (model always below market) especially severe for opener games (2 IP opener → 78% of team offense vanished).

**Correct formula:**
```
projAway = awayAdj × (starterIP/9) × starterQuality   ← starter innings, ERA-adjusted
         + awayAdj × ((9−starterIP)/9)                 ← bullpen innings, league average
```
- `starterQuality = clamp(ERA, 2.0, 7.0) / LEAGUE_AVG_ERA (4.20)`
- Elite starter (ERA 2.06) → quality 0.49 → team scores 49% of usual rate during starter innings
- Bad starter (ERA 5.70) → quality 1.36 → team scores 136% during starter innings
- Bullpen always at 1.0 (league-average assumption)
- `pitcherStatsMap` (Map<number, PitcherSeasonStats>) now passed from runner.ts to `verifyRecalculation`; falls back to ERA = LEAGUE_AVG_ERA (neutral) if no stats

**Why:** `awayAdj` is in runs/9 innings. Multiplying by `starterIP/9` produced nonsense units and discarded bullpen innings entirely. ERA ratio correctly separates pitcher quality from game-length coverage.

## Module12 pipeline status was hardcoded (fixed 2026-07-23)
RUN_LOG `Pipeline_Status` was always `partial_success` regardless of actual outcome. Fixed: runner now computes `overallStatus` and passes it through to `archiveRunBundle`.

## Odds consensus: mode with median tiebreak (fixed 2026-07-23)
`consensusTotal()` finds all modes then falls back to lower-middle element of sorted points when tied. Result is always a line some book actually posted.

## SLATE_INPUT backfill is per-cell (fixed 2026-07-23)
Module 10 back-fills `Candidate_Vehicle` only if blank or "TBD"; `Odds` only if blank. `Market_Available` is the one pipeline-maintained flag in the operator range.

## One-off workbook script pattern
Run `.mts` scripts in `artifacts/api-server/` using `../frostline/node_modules/.bin/tsx <file>.mts`. Plain `pnpm exec tsx` fails there. Import from `./src/lib/sheets/client.js` and `./src/lib/workbook/workbookSchema.js` (compiled JS extensions required).
