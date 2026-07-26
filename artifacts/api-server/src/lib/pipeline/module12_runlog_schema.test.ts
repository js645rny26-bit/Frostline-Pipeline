/**
 * Schema-validation tests: module12 RUN_LOG_HEADERS vs workbookSchema RUN_LOG columns.
 *
 * These tests prove that the 38 header strings module12 writes to the live
 * RUN_LOG sheet exactly match the 38 column definitions registered in
 * workbookSchema.ts — in the same order, with sequential indices.
 *
 * Any rename, reorder, addition, or deletion that keeps one file in sync but
 * not the other will fail here before it can produce a misaligned live sheet.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Both imports are pure-data constants — no I/O, no side effects.
import { RUN_LOG_HEADERS } from "./module12_archival.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

const RUN_LOG_SHEET = WORKBOOK_SCHEMA.find((s) => s.name === "RUN_LOG");

describe("RUN_LOG schema alignment", () => {
  it("RUN_LOG sheet exists in WORKBOOK_SCHEMA", () => {
    assert.ok(RUN_LOG_SHEET, "RUN_LOG sheet must be registered in WORKBOOK_SCHEMA");
  });

  it("WORKBOOK_SCHEMA RUN_LOG has exactly 38 columns", () => {
    assert.strictEqual(
      RUN_LOG_SHEET!.columns.length,
      38,
      `Expected 38 schema columns, got ${RUN_LOG_SHEET!.columns.length}`,
    );
  });

  it("module12 RUN_LOG_HEADERS has exactly 38 entries", () => {
    assert.strictEqual(
      RUN_LOG_HEADERS.length,
      38,
      `Expected 38 RUN_LOG_HEADERS, got ${RUN_LOG_HEADERS.length}`,
    );
  });

  it("every header matches the schema column name at the same position", () => {
    const schema = RUN_LOG_SHEET!;
    const mismatches: string[] = [];

    for (let i = 0; i < Math.max(RUN_LOG_HEADERS.length, schema.columns.length); i++) {
      const hdr = RUN_LOG_HEADERS[i] ?? "(missing)";
      const col = schema.columns[i]?.name ?? "(missing)";
      if (hdr !== col) {
        mismatches.push(`  [${i}]  module12="${hdr}"  schema="${col}"`);
      }
    }

    assert.deepEqual(
      mismatches,
      [],
      `Header/column name mismatches:\n${mismatches.join("\n")}`,
    );
  });

  it("schema column indices are sequential starting at 0", () => {
    const schema = RUN_LOG_SHEET!;
    const badIndices = schema.columns
      .map((c, i) => ({ name: c.name, declared: c.index, expected: i }))
      .filter((x) => x.declared !== x.expected);

    assert.deepEqual(
      badIndices,
      [],
      `Non-sequential column indices:\n${badIndices.map((x) => `  "${x.name}": index=${x.declared}, expected=${x.expected}`).join("\n")}`,
    );
  });

  it("last 8 headers are the Statcast_Preview_* columns from the approved spec", () => {
    const expected = [
      "Statcast_Preview_Status",
      "Statcast_Preview_Games_Expected",
      "Statcast_Preview_Games_Available",
      "Statcast_Preview_Games_Parsed",
      "Statcast_Preview_Games_Missing",
      "Statcast_Preview_Games_Failed",
      "Statcast_Preview_Stale_Count",
      "Statcast_Preview_Identity_Mismatch_Count",
    ] as const;

    const actual = [...RUN_LOG_HEADERS].slice(30);

    assert.deepEqual(
      actual,
      expected,
      `Statcast_Preview_* headers (indices 30–37) do not match the approved spec.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`,
    );
  });
});
