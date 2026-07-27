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

## Statcast shadow module (module09s) — Phase 3
- `module09s_statcastShadow.ts`: pure xwOBA shadow computation + STATCAST_SHADOW_AUDIT sheet write. Fail-open; no CORE impact.
- Shadow formula: `xwobaFactor = clamp(xwoba/0.315, 0.40, 1.80)`, `shadowQual = currentQual×0.75 + xwobaFactor×0.25`, total adj capped ±0.30 runs.
- Attribution: `away_starter_delta` driven by HOME pitcher; `home_starter_delta` driven by AWAY pitcher.
- Pitcher stats are ONLY used when `previewAvailability === "AVAILABLE"` — NOT_PUBLISHED and error previews zero out stats.
- Schema v13. After any schema bump, run `GET /api/pipeline/repair-headers` to sync the live workbook.
- Excluded signals: pitcher K%/BB% (reserved for FanGraphs stub-replacement), hitter xwOBA (overlaps module02d lineup factor). See `docs/statcast-shadow-mapping.md`.

## Statcast preview page — two distinct page formats (critical)
- **Pregame format** (before first pitch): `var teams` has `hitterRows` as an array, `pitcher`/`startingPitcher` keys, embedded Statcast stats. `preview_availability: "AVAILABLE"`.
- **Live/completed-game format** (after first pitch): `hitterPlusRows` and `pitcherPlusRows` become **numbers** (counts), `hitterRows`/`pitcher` keys absent, no Statcast stats. Parser now detects this via `typeof awayRaw["hitterPlusRows"] === "number"` and returns `preview_availability: "NOT_PUBLISHED"` / `fetch_status: "success"`.
- First-pitch time for earliest games is ~12:35 ET. Any publish after that for that game will hit the live format.
- Raw payloads saved per run: `artifacts/api-server/artifacts/statcast-preview/YYYY-MM-DD/{gamePk}/{ts}.json`.
- `aggregateHitters()` has an `Array.isArray` guard as defense-in-depth — non-array values fall through `Object.values()` rather than crashing `.map()`.

## MONOTONICITY sheet — pre-existing absence
- Sheet defined in workbookSchema.ts but never created in the canonical workbook.
- Every `GET /api/pipeline/regression?write_sheets=true` returns `status: "partial"` with error `"Monotonicity sheet write failed: Sheet \"MONOTONICITY\" not found in workbook"`.
- REGRESSION_REPORT is still written correctly; only the edge-tier monotonicity analysis is skipped.
- Fix: add `ensureSheet` call in module15 before the MONOTONICITY write (same pattern as module08b / module09s). Task #71 tracks this.

## Phase 4 commissioning — completed July 26 2026
- Canonical workbook now has 28 tabs (STATCAST_GAME_PREVIEW + STATCAST_SHADOW_AUDIT added).
- Schema v13. `Preview_Used_In_Projection = "NO"` enforced in all output rows.
- Phase 5 gated on morning-run evidence of `available ≥ 1` in module02e. Task #70 tracks this.

## July 26 2026 postmortem baseline
- 15 games final. All NO_CORE (all locked by first-pitch cutoff at time of run). 0 authorized exposure.
- Truth-direction: 8 HIT / 6 MISS / 1 PUSH. MAE 3.49, RMSE 4.52, signed error +1.81 (underprojection).
- REPLAY_METRICS (module13): BLEND_PARK_PITCHER best variant, MAE 3.426, bias −1.770 — all variants show negative bias (actual > projection).
- Settlement idempotent: games already in SHADOW_OUTCOMES before explicit settle call.
- Diagnostic modes recorded in uploaded baseline doc (attached_assets/Pasted-SOURCES-USED-*).

## Commissioning verification
- `POST /api/pipeline/publish` → expect `pipeline_status: success`, 0 errors.
- `GET /api/pipeline/repair-headers` → expect `sheets_repaired: 28`; only MONOTONICITY in errors is acceptable.
- `GET /api/pipeline/settle?date=YYYY-MM-DD` → chains module14 (SHADOW_OUTCOMES) + module18 (SURVIVAL_GATE_REPLAY). Idempotent.
- `GET /api/pipeline/regression?write_sheets=true` → `partial` until MONOTONICITY sheet is created (task #71).
- Quota trap: running repair-headers immediately before publish exhausts the Sheets write-per-minute quota. Space them ≥60s apart.
