/**
 * module11 board-lock cutoff — unit tests
 *
 * Tests buildGameLockCutoffs() against a range of slate configurations.
 *
 * Contract points under test:
 *
 *  1. All games have times    → OK status; cutoff map contains every game.
 *  2. No games have times     → UNAVAILABLE; cutoffs empty, all IDs in missingGameIds.
 *  3. < 50 % missing          → PARTIAL; only timed games in cutoffs; untimed in missingGameIds.
 *  4. Exactly 50 % missing    → UNAVAILABLE; cutoffs empty (2 of 4 missing).
 *  5. > 50 % missing          → UNAVAILABLE; cutoffs empty (3 of 4 missing).
 *  6. Cutoff timestamp is exactly BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH before first pitch.
 *  7. Empty / undefined input → OK; empty map, no crash.
 *  8. Untimed games in a PARTIAL slate appear in missingGameIds (fail-closed, not PRE_LOCK).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGameLockCutoffs } from "./module11_outputExtraction.js";
import { BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH } from "./config.js";
import type { NormalizedGame } from "./module06_normalization.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGame(id: string, scheduledUtc: string | null): NormalizedGame {
  return {
    gamePk:             Number(id.replace(/\D/g, "")) || 1,
    legacy_game_id:     id,
    date:               "2026-07-25",
    scheduled_utc_time: scheduledUtc,
    venue:              { id: null, name: "Test Park", timeZone: null },
    away_team:          { team_id: 1, team_abbr: "AAA", team_name: "Away" },
    home_team:          { team_id: 2, team_abbr: "HHH", team_name: "Home" },
    away_pitcher: {
      player_id: null, name: null, hand: null, role: "CONVENTIONAL_STARTER",
      role_confidence: "high", workload_flags: [], expected_pitches: null,
      expected_innings: 6, reasoning: "",
    },
    home_pitcher: {
      player_id: null, name: null, hand: null, role: "CONVENTIONAL_STARTER",
      role_confidence: "high", workload_flags: [], expected_pitches: null,
      expected_innings: 6, reasoning: "",
    },
    environment: {
      temperature_f: 72, humidity_pct: 65, wind_speed_mph: 10,
      wind_direction_degrees: 180, precipitation_probability_pct: 10,
      wind_context: null, roof: false, data_quality: "api",
    },
    game_status:         { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
    doubleheader_status: "N",
  };
}

/** ms difference between the given cutoff Date and the scheduled first-pitch ISO string. */
function msBeforePitch(cutoff: Date, scheduledIso: string): number {
  return new Date(scheduledIso).getTime() - cutoff.getTime();
}

const LOCK_MS = BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH * 60 * 60 * 1000;

// ── §1: all games have scheduled times ───────────────────────────────────────

describe("buildGameLockCutoffs — all games have scheduled times", () => {
  it("returns OK status and a cutoff entry for every game", () => {
    const games = [
      makeGame("G1", "2026-07-25T17:05:00Z"),
      makeGame("G2", "2026-07-25T20:10:00Z"),
      makeGame("G3", "2026-07-26T01:40:00Z"),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "OK");
    assert.equal(cutoffs.size, 3, "all 3 games must have a cutoff entry");
    assert.equal(missingGameIds.size, 0, "no games should be marked missing");
    assert.ok(cutoffs.has("G1"));
    assert.ok(cutoffs.has("G2"));
    assert.ok(cutoffs.has("G3"));
  });

  it("cutoff is exactly BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH before first pitch", () => {
    const scheduled = "2026-07-25T17:05:00Z";
    const { cutoffs } = buildGameLockCutoffs([makeGame("G1", scheduled)]);
    const cutoff = cutoffs.get("G1");
    assert.ok(cutoff instanceof Date, "cutoff must be a Date");
    const diff = msBeforePitch(cutoff!, scheduled);
    assert.equal(diff, LOCK_MS, `cutoff must be ${BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH}h before first pitch`);
  });
});

// ── §2: no games have scheduled times ────────────────────────────────────────

describe("buildGameLockCutoffs — no games have scheduled times", () => {
  it("returns UNAVAILABLE status; cutoffs empty; all IDs in missingGameIds", () => {
    const games = [
      makeGame("G1", null),
      makeGame("G2", null),
      makeGame("G3", null),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "UNAVAILABLE", "all-missing slate must be UNAVAILABLE");
    assert.equal(cutoffs.size, 0, "cutoffs must be empty when all times are missing");
    assert.equal(missingGameIds.size, 3, "all 3 game IDs must appear in missingGameIds");
    assert.ok(missingGameIds.has("G1"));
    assert.ok(missingGameIds.has("G2"));
    assert.ok(missingGameIds.has("G3"));
  });
});

// ── §3: mixed slate — fewer than 50 % missing ────────────────────────────────

describe("buildGameLockCutoffs — mixed slate (< 50 % missing)", () => {
  it("returns PARTIAL status; timed games in cutoffs; untimed games in missingGameIds", () => {
    // 1 of 3 missing = 33 % → PARTIAL
    const scheduled1 = "2026-07-25T17:05:00Z";
    const scheduled2 = "2026-07-25T20:10:00Z";
    const games = [
      makeGame("G1", scheduled1),
      makeGame("G2", scheduled2),
      makeGame("G3", null),          // missing
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "PARTIAL");
    assert.equal(cutoffs.size, 2, "only timed games should be in cutoffs");
    assert.ok(cutoffs.has("G1"));
    assert.ok(cutoffs.has("G2"));
    assert.ok(!cutoffs.has("G3"), "untimed game must NOT have a cutoff entry");

    // G3 must be in missingGameIds — callers must treat it as LOCK_TIME_UNAVAILABLE, not PRE_LOCK.
    assert.equal(missingGameIds.size, 1);
    assert.ok(missingGameIds.has("G3"), "untimed game must appear in missingGameIds");

    // Cutoff timestamps must be correct for timed games.
    assert.equal(msBeforePitch(cutoffs.get("G1")!, scheduled1), LOCK_MS);
    assert.equal(msBeforePitch(cutoffs.get("G2")!, scheduled2), LOCK_MS);
  });

  it("2 of 5 missing (40 %) — PARTIAL; 3 cutoffs produced; 2 in missingGameIds", () => {
    const games = [
      makeGame("G1", "2026-07-25T17:05:00Z"),
      makeGame("G2", "2026-07-25T18:10:00Z"),
      makeGame("G3", "2026-07-25T20:15:00Z"),
      makeGame("G4", null),
      makeGame("G5", null),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "PARTIAL");
    assert.equal(cutoffs.size, 3);
    assert.equal(missingGameIds.size, 2);
    assert.ok(missingGameIds.has("G4"));
    assert.ok(missingGameIds.has("G5"));
    assert.ok(!cutoffs.has("G4"));
    assert.ok(!cutoffs.has("G5"));
  });

  it("untimed games in a PARTIAL slate are in missingGameIds (fail-closed: not treated as PRE_LOCK)", () => {
    // This is the key anti-regression: an absent entry in cutoffs MUST NOT be
    // interpreted as PRE_LOCK.  The presence of the game ID in missingGameIds
    // is the signal that the downstream lock logic must use LOCK_TIME_UNAVAILABLE.
    // Use 3 games (2 timed, 1 untimed) = 33 % missing → PARTIAL.
    const games = [
      makeGame("TIMED_A", "2026-07-25T17:05:00Z"),
      makeGame("TIMED_B", "2026-07-25T20:00:00Z"),
      makeGame("UNTIMED", null),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "PARTIAL");
    assert.ok(!cutoffs.has("UNTIMED"), "UNTIMED must not appear in cutoffs");
    assert.ok(missingGameIds.has("UNTIMED"), "UNTIMED must appear in missingGameIds so caller blocks CORE");
    assert.ok(!missingGameIds.has("TIMED_A"), "timed game must NOT appear in missingGameIds");
    assert.ok(!missingGameIds.has("TIMED_B"), "timed game must NOT appear in missingGameIds");
  });
});

// ── §4 & §5: exactly 50 % or more than 50 % missing → UNAVAILABLE ────────────

describe("buildGameLockCutoffs — ≥ 50 % missing → UNAVAILABLE", () => {
  it("exactly 50 % missing (2 of 4) → UNAVAILABLE; cutoffs empty", () => {
    const games = [
      makeGame("G1", "2026-07-25T17:05:00Z"),
      makeGame("G2", "2026-07-25T20:10:00Z"),
      makeGame("G3", null),
      makeGame("G4", null),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "UNAVAILABLE",
      "exactly 50 % missing must produce UNAVAILABLE, not PARTIAL");
    assert.equal(cutoffs.size, 0, "cutoffs must be empty when UNAVAILABLE");
    assert.equal(missingGameIds.size, 2);
  });

  it("more than 50 % missing (3 of 4) → UNAVAILABLE; cutoffs empty", () => {
    const games = [
      makeGame("G1", "2026-07-25T17:05:00Z"),
      makeGame("G2", null),
      makeGame("G3", null),
      makeGame("G4", null),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "UNAVAILABLE");
    assert.equal(cutoffs.size, 0);
    assert.equal(missingGameIds.size, 3);
    // The one timed game must still appear in missingGameIds? No — only untimed ones do.
    assert.ok(!missingGameIds.has("G1"), "timed game must not be in missingGameIds");
  });

  it("all 10 games missing → UNAVAILABLE", () => {
    const games = Array.from({ length: 10 }, (_, i) => makeGame(`G${i + 1}`, null));
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);
    assert.equal(lockDataStatus, "UNAVAILABLE");
    assert.equal(cutoffs.size, 0);
    assert.equal(missingGameIds.size, 10);
  });
});

// ── §6: invalid timestamp strings ────────────────────────────────────────────

describe("buildGameLockCutoffs — invalid timestamp strings", () => {
  it("an unparseable string is treated as missing and added to missingGameIds", () => {
    // "not-a-date" is non-null but isNaN → treated as missing.
    // 1 of 2 invalid → 50 % → UNAVAILABLE.
    const games = [
      makeGame("G1", "not-a-date"),
      makeGame("G2", "2026-07-25T20:10:00Z"),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    // G1 is invalid → missingGameIds; 1/2 = 50 % → UNAVAILABLE.
    assert.equal(lockDataStatus, "UNAVAILABLE",
      "unparseable string counts as missing; 1/2 = 50 % → UNAVAILABLE");
    assert.ok(missingGameIds.has("G1"), "unparseable game must appear in missingGameIds");
    assert.equal(cutoffs.size, 0);
  });

  it("1 of 3 unparseable (33 %) → PARTIAL; valid games get cutoffs", () => {
    const games = [
      makeGame("G1", "not-a-date"),
      makeGame("G2", "2026-07-25T17:05:00Z"),
      makeGame("G3", "2026-07-25T20:10:00Z"),
    ];
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(games);

    assert.equal(lockDataStatus, "PARTIAL");
    assert.ok(missingGameIds.has("G1"));
    assert.ok(cutoffs.has("G2"));
    assert.ok(cutoffs.has("G3"));
  });
});

// ── §7: empty / undefined input ───────────────────────────────────────────────

describe("buildGameLockCutoffs — edge cases", () => {
  it("returns OK with empty map for undefined input (no crash)", () => {
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs(undefined);
    assert.equal(lockDataStatus, "OK");
    assert.equal(cutoffs.size, 0);
    assert.equal(missingGameIds.size, 0);
  });

  it("returns OK with empty map for empty array", () => {
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs([]);
    assert.equal(lockDataStatus, "OK");
    assert.equal(cutoffs.size, 0);
    assert.equal(missingGameIds.size, 0);
  });

  it("single game with a time → OK; one cutoff at correct offset", () => {
    const scheduled = "2026-07-25T23:10:00Z";
    const { cutoffs, lockDataStatus } = buildGameLockCutoffs([makeGame("G1", scheduled)]);
    assert.equal(lockDataStatus, "OK");
    assert.equal(cutoffs.size, 1);
    assert.equal(msBeforePitch(cutoffs.get("G1")!, scheduled), LOCK_MS);
  });

  it("single game with no time → UNAVAILABLE; empty cutoffs; ID in missingGameIds", () => {
    const { cutoffs, missingGameIds, lockDataStatus } = buildGameLockCutoffs([makeGame("G1", null)]);
    assert.equal(lockDataStatus, "UNAVAILABLE");
    assert.equal(cutoffs.size, 0);
    assert.ok(missingGameIds.has("G1"));
  });
});
