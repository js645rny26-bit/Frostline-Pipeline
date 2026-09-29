import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePregameLineLock } from "./module10_slateInput.js";

test("mutable pregame rows clear stale historical line-lock timestamps", () => {
  assert.deepEqual(
    reconcilePregameLineLock("PREGAME", "2026-08-04T04:58:30.861Z"),
    { locked: false, value: "", stale_pregame_lock_cleared: true },
  );
});

test("live and final line-lock timestamps remain immutable evidence", () => {
  const timestamp = "2026-09-29T23:10:00.000Z";
  assert.deepEqual(
    reconcilePregameLineLock("LIVE", timestamp),
    { locked: true, value: timestamp, stale_pregame_lock_cleared: false },
  );
  assert.deepEqual(
    reconcilePregameLineLock("FINAL", timestamp),
    { locked: true, value: timestamp, stale_pregame_lock_cleared: false },
  );
});

test("blank pregame lock state remains blank until the game actually freezes", () => {
  assert.deepEqual(
    reconcilePregameLineLock("PREGAME", null),
    { locked: false, value: null, stale_pregame_lock_cleared: false },
  );
});
