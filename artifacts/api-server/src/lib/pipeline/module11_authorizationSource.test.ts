import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeBoardLockAuthorization } from "./module11_outputExtraction.js";

test("BOARD_LOCK_STATE records the authoritative final CORE decision", () => {
  assert.equal(synchronizeBoardLockAuthorization("LOCKED_OUT", "CORE"), "LOCKED_IN");
});

test("BOARD_LOCK_STATE cannot remain LOCKED_IN when final authorization is NO_CORE", () => {
  assert.equal(synchronizeBoardLockAuthorization("LOCKED_IN", "NO_CORE"), "LOCKED_OUT");
  assert.equal(synchronizeBoardLockAuthorization("LOCKED_IN", "PENDING"), "LOCKED_OUT");
});

test("pre-lock and unavailable provenance states do not manufacture authorization", () => {
  assert.equal(synchronizeBoardLockAuthorization("PRE_LOCK", "CORE"), "PRE_LOCK");
  assert.equal(synchronizeBoardLockAuthorization("LOCK_TIME_UNAVAILABLE", "NO_CORE"), "LOCK_TIME_UNAVAILABLE");
  assert.equal(synchronizeBoardLockAuthorization("LOCK_DATA_UNAVAILABLE", "NO_CORE"), "LOCK_DATA_UNAVAILABLE");
});

test("August 11 replay: every finalized lock surface matches the one final authorization", () => {
  // Exact 15-game Commissioning Shadow slate observed on 2026-08-11.
  const games = [
    "20260811_CLE_DET", "20260811_PIT_MIA", "20260811_CHC_WSN",
    "20260811_SEA_NYY", "20260811_BOS_TOR", "20260811_NYM_ATL",
    "20260811_BAL_MIN", "20260811_CIN_CHW", "20260811_PHI_STL",
    "20260811_TEX_LAA", "20260811_COL_ARI", "20260811_TBR_OAK",
    "20260811_MIL_SDP", "20260811_HOU_SFG", "20260811_KCR_LAD",
  ];
  // The final 2026-08-11 SLATE_BOARD decision was NO_CORE for all 15 games;
  // the defect was that several lock rows still said LOCKED_IN/CORE.
  const finalByGame = new Map(games.map((game) => [game, "NO_CORE" as const]));
  const previouslyObservedLock = new Map(games.map((game, index) => [
    game,
    index < 3 ? "LOCKED_IN" as const : "LOCKED_OUT" as const,
  ]));
  const lockByGame = new Map(games.map((game) => [game, synchronizeBoardLockAuthorization(
    previouslyObservedLock.get(game)!,
    finalByGame.get(game)!,
  )]));
  for (const game of games) {
    assert.equal(finalByGame.get(game), "NO_CORE");
    assert.equal(lockByGame.get(game), "LOCKED_OUT");
  }
});
