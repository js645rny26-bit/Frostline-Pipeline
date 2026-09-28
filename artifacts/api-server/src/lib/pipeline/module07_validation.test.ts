import assert from "node:assert/strict";
import test from "node:test";

import { validateNormalizedSlate } from "./module07_validation.js";
import type { NormalizationResult } from "./module06_normalization.js";

test("one-to-four-game postseason slates pass validation without forcing action", () => {
  for (const count of [1, 2, 3, 4]) {
    const games = Array.from({ length: count }, (_, index) => ({
      gamePk: 9000 + index,
      legacy_game_id: `20261002_A${index}_H${index}`,
      away_pitcher: { role: "STARTER" },
      home_pitcher: { role: "STARTER" },
      environment: { data_quality: "live" },
      doubleheader_status: "N",
    }));
    const result = validateNormalizedSlate({ games } as unknown as NormalizationResult);
    assert.equal(result.status, "PASS");
    assert.equal(result.critical_failures.length, 0);
    assert.match(result.warnings.join(" "), /ATYPICAL_SLATE_SIZE/);
    assert.doesNotMatch(result.warnings.join(" "), /CORE/);
  }
});
