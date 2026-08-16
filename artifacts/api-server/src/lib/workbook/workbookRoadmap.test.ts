import test from "node:test";
import assert from "node:assert/strict";

import { WORKBOOK_SCHEMA } from "./workbookSchema.js";
import { WORKBOOK_ROADMAP, buildWorkbookRoadmapReadmeRows } from "./workbookRoadmap.js";

test("workbook roadmap documents every schema sheet exactly once", () => {
  const schemaNames = WORKBOOK_SCHEMA.map((sheet) => sheet.name).sort();
  const roadmapNames = WORKBOOK_ROADMAP.map((entry) => entry.sheet).sort();

  assert.deepEqual(roadmapNames, schemaNames);
  assert.equal(new Set(roadmapNames).size, roadmapNames.length);
});

test("every roadmap entry records timing, purpose, board relationship, and reading guidance", () => {
  for (const entry of WORKBOOK_ROADMAP) {
    assert.ok(entry.timing.trim(), `${entry.sheet} is missing timing`);
    assert.ok(entry.purpose.trim(), `${entry.sheet} is missing purpose`);
    assert.ok(entry.boardRelationship.trim(), `${entry.sheet} is missing board relationship`);
    assert.ok(entry.readNote.trim(), `${entry.sheet} is missing reading guidance`);
  }
});

test("README roadmap rows remain keyed and one-to-one with the registry", () => {
  const rows = buildWorkbookRoadmapReadmeRows();
  assert.equal(rows.length, WORKBOOK_ROADMAP.length);
  assert.deepEqual(
    rows.map((row) => row[0]),
    WORKBOOK_ROADMAP.map((entry) => `Tab_${entry.sheet}`),
  );
  assert.ok(rows.every((row) => row.length === 2 && row[1]?.includes("Board:")));
});
