import assert from "node:assert/strict";
import test from "node:test";
import { dailySettlementHttpStatus } from "./runner.js";

test("only a fully successful daily settlement receives HTTP success", () => {
  assert.equal(dailySettlementHttpStatus("success"), 200);
  assert.equal(dailySettlementHttpStatus("partial_failure"), 500);
  assert.equal(dailySettlementHttpStatus("failure"), 500);
});
