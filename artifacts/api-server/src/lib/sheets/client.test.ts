import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_WORKBOOK_ID,
  assertWorkbookWriteAllowed,
  selectSheetsBackend,
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
