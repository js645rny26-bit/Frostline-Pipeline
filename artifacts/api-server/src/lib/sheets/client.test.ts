import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_WORKBOOK_ID,
  assertWorkbookWriteAllowed,
  resetSheetsTransportForTest,
  selectSheetsBackend,
  writeRange,
} from "./client.js";

const isolatedWorkbook = "1KPYzbSawLIrOcckn5EXxO4vH5eABOhMIibhCgpF-oNs";

test("auto selects Replit when its identity is available", () => {
  assert.equal(selectSheetsBackend("auto", { REPL_IDENTITY: "token", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" }), "replit");
});

test("auto selects Google ADC when Replit identity is absent", () => {
  assert.equal(selectSheetsBackend("auto", { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" }), "google");
});

test("no credentials fails closed", () => {
  assert.throws(() => selectSheetsBackend("auto", {}), /No Sheets identity/);
});

test("explicit backend selection cannot silently fall through", () => {
  assert.throws(() => selectSheetsBackend("replit", { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" }), /Replit Sheets backend requested/);
  assert.throws(() => selectSheetsBackend("google", { REPL_IDENTITY: "token" }), /Google Sheets backend requested/);
});

test("canonical workbook writes are rejected by default", () => {
  assert.throws(() => assertWorkbookWriteAllowed(CANONICAL_WORKBOOK_ID, {}), /Refusing write to canonical workbook/);
  assert.doesNotThrow(() => assertWorkbookWriteAllowed(CANONICAL_WORKBOOK_ID, { ALLOW_CANONICAL_PUBLISH: "true" }));
});

test("isolated workbook writes are allowed", () => {
  assert.doesNotThrow(() => assertWorkbookWriteAllowed(isolatedWorkbook, {}));
});

test("Google Sheets transport retries a quota-exhausted write", async () => {
  const originalFetch = globalThis.fetch;
  const originalBackend = process.env.FROSTLINE_SHEETS_BACKEND;
  const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const originalToken = process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN;
  const originalInterval = process.env.FROSTLINE_GOOGLE_SHEETS_WRITE_INTERVAL_MS;
  const originalRetry = process.env.FROSTLINE_GOOGLE_SHEETS_429_RETRY_MS;
  let calls = 0;

  try {
    process.env.FROSTLINE_SHEETS_BACKEND = "google";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/frostline-test-adc.json";
    process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN = "short-lived-test-token";
    process.env.FROSTLINE_GOOGLE_SHEETS_WRITE_INTERVAL_MS = "0";
    process.env.FROSTLINE_GOOGLE_SHEETS_429_RETRY_MS = "0";
    resetSheetsTransportForTest();

    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ updatedRows: 1, updatedRange: "TEST!A1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await writeRange(isolatedWorkbook, "TEST!A1", [["ok"]]);
    assert.equal(calls, 2);
    assert.deepEqual(result, { updatedRows: 1, updatedRange: "TEST!A1" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBackend === undefined) delete process.env.FROSTLINE_SHEETS_BACKEND;
    else process.env.FROSTLINE_SHEETS_BACKEND = originalBackend;
    if (originalCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials;
    if (originalToken === undefined) delete process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN;
    else process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN = originalToken;
    if (originalInterval === undefined) delete process.env.FROSTLINE_GOOGLE_SHEETS_WRITE_INTERVAL_MS;
    else process.env.FROSTLINE_GOOGLE_SHEETS_WRITE_INTERVAL_MS = originalInterval;
    if (originalRetry === undefined) delete process.env.FROSTLINE_GOOGLE_SHEETS_429_RETRY_MS;
    else process.env.FROSTLINE_GOOGLE_SHEETS_429_RETRY_MS = originalRetry;
    resetSheetsTransportForTest();
  }
});
