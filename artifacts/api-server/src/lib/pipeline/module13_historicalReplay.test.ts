import assert from "node:assert/strict";
import test from "node:test";
import { canonicalReplayGameId } from "./module13_historicalReplay.js";

test("historical replay renders consecutive same-matchup games as distinct canonical Game_IDs", () => {
  assert.equal(canonicalReplayGameId("2026-09-25", "TBR", "PHI"), "20260925_TBR_PHI");
  assert.equal(canonicalReplayGameId("2026-09-26", "TBR", "PHI"), "20260926_TBR_PHI");
  assert.notEqual(
    canonicalReplayGameId("2026-09-25", "TBR", "PHI"),
    canonicalReplayGameId("2026-09-26", "TBR", "PHI"),
  );
});
