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
- **Direction** column (OVER | UNDER | NONE) is now explicit in both output sheets
- **Expected_ROI = |variance| × 0.05** — always positive; direction tells you which side
- Before this fix, ROI was `variance × 0.05` (sign-preserving), causing negative ROI on UNDER plays despite STRONG_BUY recommendation — a visible contradiction

**Why:** CORE decision is magnitude-only (|variance| ≥ 0.5); Recommendation tiers are also magnitude-only. ROI must follow the same convention or it contradicts the recommendation on UNDER plays.

## Module12 pipeline status was hardcoded (fixed 2026-07-23)
RUN_LOG `Pipeline_Status` was always `partial_success` regardless of actual outcome. Fixed: runner now computes `overallStatus` and passes it through to `archiveRunBundle`. The `partial_success` in earlier RUN_LOG rows reflects the bug, not small-slate validation.

## Odds consensus: mode with median tiebreak (fixed 2026-07-23)
`consensusTotal()` now finds all modes (equally most-common totals), then falls back to the lower-middle element of the full sorted points array when there's a tie. Result is always a line some book actually posted — never an averaged x.25 half-point.

## SLATE_INPUT backfill is per-cell (fixed 2026-07-23)
Module 10 back-fills blank Line/Odds/Vehicle only when `Line` is blank. After the fix: `Candidate_Vehicle` is only overwritten if it is blank or still "TBD"; `Odds` is only overwritten if blank. `Market_Available` is the one pipeline-maintained flag inside the operator range.

## One-off workbook script pattern
Run `.mts` scripts in `artifacts/api-server/` using `../frostline/node_modules/.bin/tsx <file>.mts`. Plain `pnpm exec tsx` fails there. Import from `./src/lib/sheets/client.js` and `./src/lib/workbook/workbookSchema.js` (compiled JS extensions required).
