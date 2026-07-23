---
name: Frostline pipeline design notes
description: Known limitations and Sheets-interop decisions for the MLB betting pipeline; read before touching game IDs, ODDS_HISTORY, or sheet schemas.
---

# Frostline pipeline — design notes & known limitations

## Doubleheader collision in the canonical game ID (KNOWN LIMITATION, deferred)
`legacy_game_id` = `YYYYMMDD_AWAY_HOME` with no game-number suffix. On doubleheader days, both games share one ID, so every map keyed on it (odds, line movement, plate ump, lineups/platoon) collapses to one entry.
**Why deferred:** fixing it means changing the canonical ID format across every module AND the operator's downstream sheet formulas — a user-approval decision, not a slip-in refactor. `gameNumber`/`doubleheaderStatus` are already captured in module01, so the data exists when the user wants the fix.
**How to apply:** if a task involves doubleheaders or duplicate game rows, propose the ID-format change as its own scoped task first.

## ODDS_HISTORY reads must stay tail-anchored
The sheet is append-only and grows forever. Opener lookups read a bounded tail window anchored to the append response's `updatedRange` end row — never a fixed `A2:G<N>` range, which silently misses today's rows once history outgrows it (movement then collapses to 0 with no error).

## Sheets USER_ENTERED round-trip is format-sensitive
Values are written USER_ENTERED and read back as FORMATTED_VALUE, and module05d matches them by string equality. ISO timestamps with `Z` suffix stay strings (Sheets doesn't parse them), and bare `YYYY-MM-DD` currently round-trips intact — but adding a date display format to those columns would break the equality checks. Schema deliberately types ODDS_HISTORY ts/date columns as `string`.

## Operator column convention
Sheets seeded from the workbook schema mark `Notes` columns as OPERATOR-filled, but daily-refresh writers overwrite them with "" each run (long-standing behavior; operator persistence lives in SLATE_INPUT, which module10 explicitly preserves). Don't "fix" this without asking.

## Schema drift check
`workbookSchema.ts` is the source of truth for NEW workbooks only — existing workbooks don't get new headers automatically. When adding columns to a writer, update the schema AND one-off write the new header cells to the live workbook.
