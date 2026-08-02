import assert from "node:assert/strict";
import test from "node:test";
import { validateEnvironmentLineage, validateProjectionLineage } from "./module09_lineageValidation.js";

test("projection lineage requires exactly two team rows and one summary row per current game", () => {
  const result = validateProjectionLineage(
    "2026-08-02",
    ["G1"],
    [["2026-08-02", "G1"], ["2026-08-02", "G1"]],
    [["2026-08-02", "G1"]],
  );
  assert.equal(result.status, "PASS");
});

test("projection lineage rejects stale, missing, and unexpected rows", () => {
  const result = validateProjectionLineage(
    "2026-08-02",
    ["G1", "G2"],
    [["2026-08-01", "G1"], ["2026-08-02", "G3"]],
    [["2026-08-02", "G1"]],
  );
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.some((error) => error.includes("G2 expected 2 rows")));
  assert.ok(result.errors.some((error) => error.includes("unexpected Game_ID G3")));
  assert.ok(result.errors.some((error) => error.includes("has date 2026-08-01")));
});

test("RUN_ENVIRONMENT must match Module 09 HR and effective run factors", () => {
  const row = Array<unknown>(12).fill("");
  row[0] = "2026-08-02";
  row[1] = "G1";
  row[9] = 1.12;
  row[10] = 1.08;
  const result = validateEnvironmentLineage(
    "2026-08-02",
    [{ game_id: "G1", home_run_factor: 1.12, run_multiplier: 1.08 }],
    [row],
  );
  assert.equal(result.status, "PASS");
});

test("environment multiplier mismatches fail closed", () => {
  const row = Array<unknown>(12).fill("");
  row[0] = "2026-08-02";
  row[1] = "G1";
  row[9] = 1.12;
  row[10] = 1.01;
  const result = validateEnvironmentLineage(
    "2026-08-02",
    [{ game_id: "G1", home_run_factor: 1.12, run_multiplier: 1.08 }],
    [row],
  );
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.some((error) => error.includes("run multiplier mismatch")));
});
