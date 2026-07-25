---
name: Frostline pipeline notes
description: Non-obvious decisions, traps, and structural facts about the Frostline pipeline codebase.
---

## Module stubs
- module05 Fangraphs is a STUB returning constant splits — not real per-team data.
- mlbstartingnine (module04c) is today-only — no historical park factors.

## API server routing trap
- The api-server Express router is mounted at `/api`, so route files use `/pipeline/...` not `/api/pipeline/...`.

## Game ID collision
- Doubleheader games share a legacy_game_id until the second game is confirmed — the BLS index-registration guard in module11 prevents duplicate appends.

## USER_ENTERED fragility
- Writing with `valueInputOption: USER_ENTERED` causes Sheets to interpret strings as dates/formulas. Use `RAW` for all data writes.

## Schema reality vs declaration (fixed in Pass A2)
- GAME_INTEGRATION col 12: schema declared `Lineup_Strength_Status` (string) but module09 writes `Lineup_Factor` (number). Fixed.
- GAME_SUMMARY cols 6-7: schema declared `Away/Home_Lineup_Strength_Status` (string); module09 writes `Away/Home_Lineup_Factor` (number). Also 3 extra cols at indices 31-33 (`Projected_Run_Diff`, `Away_Starter_Quality`, `Home_Starter_Quality`). Fixed.
- REPLAY_RESULTS: schema had 24 cols; module13 writes 31. Schema updated to match.
- `/api/pipeline/repair-headers` rewrites all row-1 headers from WORKBOOK_SCHEMA and refreshes SCHEMA_REFERENCE — run this after any schema version change.

## Google Sheets date format trap in repair endpoints
- Sheets returns Date cells as "MM/DD/YYYY" (FORMATTED_VALUE) even when written as "2026-07-25".
- Any code that reads a date cell and compares it to a "YYYY-MM-DD" string must normalize both sides first.
- `normDate()` pattern: detect "YYYY-MM-DD" prefix OR "MM/DD/YYYY" → always return "YYYY-MM-DD".
- Failure mode: format mismatch causes ALL rows to appear cross-date and be deleted. Always verify
  removal counts look proportionate before trusting a data-repair result.

## repair-data endpoint — idempotent safety
- `GET /api/pipeline/repair-data` handles BOARD_LOCK_STATE invalidation, VEHICLE_LOG cross-date removal,
  and REPLAY_RESULTS deduplication. Safe to re-run.
- VEHICLE_LOG rows deleted by repair are recreated by the next `/api/pipeline/publish` run (module17 UPSERT).
- BLS invalidation only fires when lock_status=LOCKED_IN AND locked_ts > lock_cutoff_ts + 30 min
  AND pre_lock_decision is not already "UNKNOWN_*". Already-fixed rows are skipped.

## Lock state machine (module11) — reschedule / postpone handling
- When `storedScheduledFP ≠ currentScheduledFP` (reschedule detected): effectiveBLS is produced with lock_status/pre_lock_decision/locked_ts cleared; state machine replays the lock under the new cutoff. Operator late_change fields preserved.
- When a game had a first pitch time but now has none (postponed): lock status becomes LOCK_TIME_UNAVAILABLE and pre_lock_decision is cleared (lineup/pitching will change).
- `UNKNOWN_RESCHEDULED` distinguishes a rescheduled-to-earlier case from `UNKNOWN_LATE_FIRST_RUN` (plain late first publish).
- The `normalizedGame` lookup is hoisted BEFORE the lock state machine so it is available for both reschedule detection and BLS staging.

## BOARD_LOCK_STATE
- Stored in col C as `Scheduled_First_Pitch` (ISO UTC). This is the reference value for reschedule detection.
- `lockedTs` (col G) is stamped once on first lock; cleared to "" when effectiveBLS resets for a reschedule, then re-stamped by the fresh lock.

## Commissioning verification
- `POST /api/pipeline/publish` → expect `pipeline_status: success`, 0 errors.
- `GET /api/pipeline/repair-headers` → expect status success/partial (MONOTONICITY missing is acceptable — it's created lazily on first regression run), schema_version 8.
- Lock distribution check: count LOCKED_IN vs LOCKED_OUT in slate_board.
