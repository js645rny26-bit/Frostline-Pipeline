/**
 * module11 lock-gate integration tests
 *
 * Proves that the structured GameLockCutoffResult returned by
 * buildGameLockCutoffs() is correctly consumed by the production
 * decision-loop logic: games that would otherwise become CORE are
 * blocked when schedule data is missing, and the correct
 * decision/coreBlocker/lockStatus triple is produced in each case.
 *
 * The helper simulateLockGate() replicates the exact branches in
 * extractOutputBoards() that read lockDataStatus and missingGameIds —
 * keeping the test as close to the production code path as possible
 * without invoking Sheets I/O.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGameLockCutoffs,
  computeDecision,
  type GameEligibilityContext,
} from "./module11_outputExtraction.js";
import type { NormalizedGame } from "./module06_normalization.js";

// ─── fixtures ─────────────────────────────────────────────────────────────────

const ELIGIBLE_CTX: GameEligibilityContext = {
  awayPitcherRole:     "CONVENTIONAL_STARTER",
  homePitcherRole:     "CONVENTIONAL_STARTER",
  awayExpectedInnings: 6.0,
  homeExpectedInnings: 6.0,
  bullpenAvailable:    true,
};

/** A projection that produces a CORE outcome when no lock blocks it. */
const CORE_PARAMS = {
  projectedTotal: 11.5,   // strong Over
  marketLine:     8.0,    // variance 3.5 ≥ 1.5 threshold → CORE
  vehicle:        "FULL_GAME_OU",
};

function makeGame(id: string, scheduledUtc: string | null): NormalizedGame {
  return {
    gamePk:             1,
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

// ─── simulator ────────────────────────────────────────────────────────────────

/**
 * Simulates the lock-gate portion of the extractOutputBoards per-game loop
 * for one game, given the full list of normalized games for the slate.
 *
 * This mirrors the exact branches in module11:
 *   1. lockDataStatus === "UNAVAILABLE" → LOCK_DATA_UNAVAILABLE
 *   2. missingGameIds.has(game_id)       → LOCK_TIME_UNAVAILABLE
 *   3. otherwise                         → PRE_LOCK (before cutoff, no I/O here)
 *
 * The survival gate and other downstream gates are out of scope for these tests.
 */
function simulateLockGate(params: {
  gameId: string;
  projectedTotal: number;
  marketLine: number | null;
  vehicle: string;
  ctx: GameEligibilityContext;
  normalizedGames: NormalizedGame[];
  /** Optional: simulate the game's lock cutoff already being in the past. */
  nowMs?: number;
}): {
  decision: "CORE" | "NO_CORE" | "PENDING";
  coreBlocker: string;
  lockStatus: string;
} {
  const { lockDataStatus, cutoffs, missingGameIds } = buildGameLockCutoffs(params.normalizedGames);

  const { decision: rawDecision, coreBlocker: rawBlocker } = computeDecision(
    params.projectedTotal,
    params.marketLine,
    params.vehicle,
    params.ctx,
  );

  let decision = rawDecision;
  let coreBlocker = rawBlocker;
  let lockStatus: string;

  const nowMs = params.nowMs ?? Date.now();
  const gameLockCutoff = cutoffs.get(params.gameId) ?? null;
  const gameLocked     = gameLockCutoff !== null && nowMs >= gameLockCutoff.getTime();

  if (lockDataStatus === "UNAVAILABLE") {
    lockStatus = "LOCK_DATA_UNAVAILABLE";
    if (decision === "CORE") {
      decision    = "NO_CORE";
      coreBlocker = "LOCK_DATA_UNAVAILABLE";
    }
  } else if (missingGameIds.has(params.gameId)) {
    lockStatus = "LOCK_TIME_UNAVAILABLE";
    if (decision === "CORE") {
      decision    = "NO_CORE";
      coreBlocker = "LOCK_TIME_UNAVAILABLE";
    }
  } else if (!gameLocked) {
    lockStatus = "PRE_LOCK";
  } else {
    // Cutoff passed — for these tests we treat as a standard lock-out
    // (the full BOARD_LOCK_STATE persistence logic is not replicated here).
    lockStatus  = "LOCKED_OUT";
    decision    = "NO_CORE";
    coreBlocker = "BOARD_LOCKED_POST_CUTOFF";
  }

  return { decision, coreBlocker, lockStatus };
}

// ─── §1: LOCK_TIME_UNAVAILABLE — missing individual game time ─────────────────

describe("Lock gate — LOCK_TIME_UNAVAILABLE (missing individual game time)", () => {
  // Slate: 3 games, only 1 is untimed (33 % < 50 % → PARTIAL, not UNAVAILABLE).
  // The untimed game would be CORE on the model numbers alone.
  const timedA   = makeGame("TIMED_A", "2026-07-26T17:05:00Z");
  const timedB   = makeGame("TIMED_B", "2026-07-26T20:10:00Z");
  const untimed  = makeGame("UNTIMED", null);
  const slate    = [timedA, timedB, untimed];

  it("a game that would be CORE gets NO_CORE when its scheduled time is missing", () => {
    const { decision, coreBlocker, lockStatus } = simulateLockGate({
      gameId:          "UNTIMED",
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,    "NO_CORE",               "decision must be NO_CORE");
    assert.equal(coreBlocker, "LOCK_TIME_UNAVAILABLE",  "CORE_Blocker must be LOCK_TIME_UNAVAILABLE");
    assert.equal(lockStatus,  "LOCK_TIME_UNAVAILABLE",  "Lock_Status must be LOCK_TIME_UNAVAILABLE");
  });

  it("a timed game in the same slate is unaffected and stays PRE_LOCK before its cutoff", () => {
    // Use a far-future time so the cutoff has not passed.
    const { decision, coreBlocker, lockStatus } = simulateLockGate({
      gameId:          "TIMED_A",
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,    "CORE",     "timed game must stay CORE");
    assert.equal(coreBlocker, "",         "no blocker for a CORE game");
    assert.equal(lockStatus,  "PRE_LOCK", "timed game before its cutoff must be PRE_LOCK");
  });

  it("a game that is already NO_CORE stays NO_CORE with LOCK_TIME_UNAVAILABLE lockStatus", () => {
    // Below threshold: projectedTotal 9.0, line 8.5 → variance 0.5 < 1.5 → NO_CORE.
    const { decision, coreBlocker, lockStatus } = simulateLockGate({
      gameId:          "UNTIMED",
      projectedTotal:  9.0,
      marketLine:      8.5,
      vehicle:         "FULL_GAME_OU",
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,    "NO_CORE",               "already-NO_CORE game must stay NO_CORE");
    assert.equal(lockStatus,  "LOCK_TIME_UNAVAILABLE",  "lockStatus must still be LOCK_TIME_UNAVAILABLE");
    // coreBlocker was already set by computeDecision, not overwritten by the lock gate.
    assert.ok(coreBlocker !== "LOCK_TIME_UNAVAILABLE",  "lock gate must not overwrite an existing blocker");
  });
});

// ─── §2: LOCK_DATA_UNAVAILABLE — ≥ 50 % of slate games have no time ──────────

describe("Lock gate — LOCK_DATA_UNAVAILABLE (≥ 50 % slate times missing)", () => {
  // Slate: 4 games, 2 untimed (50 % → UNAVAILABLE).
  const timed1   = makeGame("G1", "2026-07-26T17:05:00Z");
  const timed2   = makeGame("G2", "2026-07-26T20:10:00Z");
  const untimed1 = makeGame("G3", null);
  const untimed2 = makeGame("G4", null);
  const slate    = [timed1, timed2, untimed1, untimed2];

  it("a timed game that would be CORE gets NO_CORE when slate lock is suppressed", () => {
    const { decision, coreBlocker, lockStatus } = simulateLockGate({
      gameId:          "G1",      // timed, but slate-wide unavailable
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,    "NO_CORE",               "decision must be NO_CORE");
    assert.equal(coreBlocker, "LOCK_DATA_UNAVAILABLE",  "CORE_Blocker must be LOCK_DATA_UNAVAILABLE");
    assert.equal(lockStatus,  "LOCK_DATA_UNAVAILABLE",  "Lock_Status must be LOCK_DATA_UNAVAILABLE");
  });

  it("an untimed game that would be CORE also gets NO_CORE with LOCK_DATA_UNAVAILABLE", () => {
    const { decision, coreBlocker, lockStatus } = simulateLockGate({
      gameId:          "G3",      // untimed, and slate-wide unavailable
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,    "NO_CORE",               "decision must be NO_CORE");
    assert.equal(coreBlocker, "LOCK_DATA_UNAVAILABLE",  "CORE_Blocker must be LOCK_DATA_UNAVAILABLE (slate wins over per-game)");
    assert.equal(lockStatus,  "LOCK_DATA_UNAVAILABLE",  "Lock_Status must be LOCK_DATA_UNAVAILABLE");
  });

  it("an already-NO_CORE game is unaffected by LOCK_DATA_UNAVAILABLE (lockStatus still set)", () => {
    const { decision, lockStatus } = simulateLockGate({
      gameId:          "G2",
      projectedTotal:  9.0,
      marketLine:      8.5,
      vehicle:         "FULL_GAME_OU",
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(decision,   "NO_CORE",               "already-NO_CORE stays NO_CORE");
    assert.equal(lockStatus, "LOCK_DATA_UNAVAILABLE",  "lockStatus must reflect slate state");
  });
});

// ─── §3: timed game with a passed cutoff — standard lock-out ─────────────────

describe("Lock gate — timed game with passed cutoff (regression guard)", () => {
  it("a game whose cutoff has passed and has no persisted BLS gets LOCKED_OUT", () => {
    // First pitch in the past → cutoff is also in the past.
    const pastGame = makeGame("G1", "2026-07-25T01:00:00Z");  // 1 AM UTC — long past
    const slate    = [pastGame, makeGame("G2", "2026-07-26T20:10:00Z")];

    const { decision, lockStatus } = simulateLockGate({
      gameId:          "G1",
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
      nowMs:           Date.now(),  // well after the cutoff
    });

    // The lock gate fired (past cutoff) — without persisted BLS, defaults to LOCKED_OUT.
    assert.equal(lockStatus, "LOCKED_OUT", "past-cutoff game must be LOCKED_OUT");
    assert.equal(decision,   "NO_CORE",    "decision must be NO_CORE when LOCKED_OUT");
  });

  it("a timed game before its cutoff is PRE_LOCK and stays CORE", () => {
    // First pitch 10 hours from now → cutoff 8 hours from now → PRE_LOCK.
    const futureIso = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    const slate = [makeGame("G1", futureIso)];

    const { decision, lockStatus } = simulateLockGate({
      gameId:          "G1",
      ...CORE_PARAMS,
      ctx:             ELIGIBLE_CTX,
      normalizedGames: slate,
    });

    assert.equal(lockStatus, "PRE_LOCK", "game before cutoff must be PRE_LOCK");
    assert.equal(decision,   "CORE",     "CORE must be preserved before lock");
  });
});
