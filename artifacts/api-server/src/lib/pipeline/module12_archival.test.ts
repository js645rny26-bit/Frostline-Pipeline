import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_LOG_HEADERS,
  assessRunLogIntegrity,
  buildRunLogIssueDetails,
  ensureRunLogHeaders,
  type RunLogHeaderDependencies,
} from "./module12_archival.js";

test("run log preserves every counted validation warning and critical failure", () => {
  const details = buildRunLogIssueDetails(
    ["Missing required starter"],
    ["Weather fallback used"],
    [{ module: "08_feed_writer", error: "write partial", timestamp: "2026-09-03T12:00:01.000Z" }],
    "2026-09-03T12:00:00.000Z",
  );
  assert.equal(details.integrityStatus, "PASS");
  assert.equal(details.critical.length, 1);
  assert.equal(details.warnings.length, 1);
  assert.equal(details.moduleErrors.length, 1);
  assert.deepEqual(details.critical[0], {
    module: "07_validation", code: "VALIDATION_CRITICAL_FAILURE", message: "Missing required starter",
    timestamp: "2026-09-03T12:00:00.000Z", fallback_state: "NO_FALLBACK", usability_state: "BLOCKING",
  });
  assert.equal(details.moduleErrors[0]?.fallback_state, "NOT_DECLARED");
  assert.equal(details.moduleErrors[0]?.usability_state, "DEGRADED");
});

test("a counted critical failure without detail is explicitly a run-log integrity failure", () => {
  assert.equal(assessRunLogIntegrity(1, 0, [], []), "RUN_LOG_INTEGRITY_FAILURE");
  assert.equal(assessRunLogIntegrity(0, 1, [], []), "RUN_LOG_INTEGRITY_FAILURE");
});

function headerDependencies(overrides: Partial<RunLogHeaderDependencies> = {}): RunLogHeaderDependencies {
  return {
    readRange: async () => ({ values: [Array.from(RUN_LOG_HEADERS)] }),
    writeRange: async (_workbookId, range, values) => ({
      updatedRows: values.length,
      updatedRange: range,
    }),
    addSheet: async () => undefined,
    expandSheetColumns: async () => undefined,
    ...overrides,
  };
}

test("verified RUN_LOG headers do not spend a second metadata read", async () => {
  let expandCalls = 0;
  const status = await ensureRunLogHeaders("workbook", headerDependencies({
    expandSheetColumns: async () => { expandCalls += 1; },
  }));

  assert.equal(status, "VERIFIED");
  assert.equal(expandCalls, 0);
});

test("late RUN_LOG header read quota exhaustion defers to the fail-closed append", async () => {
  let writeCalls = 0;
  let expandCalls = 0;
  const status = await ensureRunLogHeaders("workbook", headerDependencies({
    readRange: async () => {
      throw new Error("Google sheets API 429: RESOURCE_EXHAUSTED: Read requests quota exceeded");
    },
    writeRange: async (_workbookId, range, values) => {
      writeCalls += 1;
      return { updatedRows: values.length, updatedRange: range };
    },
    expandSheetColumns: async () => { expandCalls += 1; },
  }));

  assert.equal(status, "SKIPPED_READ_QUOTA");
  assert.equal(writeCalls, 0);
  assert.equal(expandCalls, 0);
});

test("non-quota RUN_LOG header errors remain blocking", async () => {
  await assert.rejects(
    ensureRunLogHeaders("workbook", headerDependencies({
      readRange: async () => { throw new Error("authentication failed"); },
    })),
    /authentication failed/,
  );
});
