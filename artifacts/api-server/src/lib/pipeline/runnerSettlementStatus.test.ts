import assert from "node:assert/strict";
import test from "node:test";
import { aggregateDailySettlementStatus, dailySettlementHttpStatus } from "./runner.js";

test("only a fully successful daily settlement receives HTTP success", () => {
  assert.equal(dailySettlementHttpStatus("success"), 200);
  assert.equal(dailySettlementHttpStatus("partial_failure"), 500);
  assert.equal(dailySettlementHttpStatus("failure"), 500);
});

test("research-only warnings remain visible without invalidating completed settlement", () => {
  assert.equal(aggregateDailySettlementStatus([
    { status: "success" },
    { status: "warning" },
    { status: "success" },
  ]), "success");
});

test("every blocking partial or failure state remains fail-closed", () => {
  assert.equal(aggregateDailySettlementStatus([
    { status: "success" },
    { status: "partial" },
    { status: "warning" },
  ]), "partial_failure");
  assert.equal(aggregateDailySettlementStatus([
    { status: "failure" },
    { status: "failure" },
  ]), "failure");
});
