import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVE_DAMAGE_MATCHUP_ENABLED } from "./module09_recalculation.js";

test("Patch B cannot affect the active projection before commissioning", () => {
  assert.equal(ACTIVE_DAMAGE_MATCHUP_ENABLED, false);
});
