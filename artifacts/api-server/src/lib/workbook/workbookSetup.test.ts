import assert from "node:assert/strict";
import test from "node:test";
import { WORKBOOK_SCHEMA } from "./workbookSchema.js";
import {
  buildNumberFormatRequests,
  buildPregameSchemaMaterializationHeaders,
  PREGAME_SCHEMA_MATERIALIZATION_SHEETS,
} from "./workbookSetup.js";

test("decision-score columns use numeric rather than percentage formats", () => {
  const slateInput = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "SLATE_INPUT");
  assert.ok(slateInput);

  const requests = buildNumberFormatRequests(123, slateInput) as Array<{
    repeatCell: {
      range: { startColumnIndex: number; endColumnIndex: number };
      cell: { userEnteredFormat: { numberFormat: { type: string; pattern: string } } };
    };
  }>;
  const scoreFormats = requests.filter((request) =>
    [6, 7, 8, 9].includes(request.repeatCell.range.startColumnIndex),
  );

  assert.equal(scoreFormats.length, 4);
  for (const request of scoreFormats) {
    assert.equal(request.repeatCell.cell.userEnteredFormat.numberFormat.type, "NUMBER");
    assert.equal(request.repeatCell.cell.userEnteredFormat.numberFormat.pattern, "0.00");
  }
});

test("normal publish materializes the v79 settlement-research headers", () => {
  assert.deepEqual(PREGAME_SCHEMA_MATERIALIZATION_SHEETS, [
    "VEHICLE_POSTMORTEM",
    "GAME_TRUTH_REPLAY_V1",
  ]);

  const materialized = buildPregameSchemaMaterializationHeaders();
  assert.deepEqual(
    materialized.find(({ sheet }) => sheet === "VEHICLE_POSTMORTEM")?.headers,
    WORKBOOK_SCHEMA.find(({ name }) => name === "VEHICLE_POSTMORTEM")?.columns.map(
      ({ name }) => name,
    ),
  );
  assert.equal(
    materialized.find(({ sheet }) => sheet === "VEHICLE_POSTMORTEM")?.headers.length,
    35,
  );
  assert.equal(
    materialized.find(({ sheet }) => sheet === "GAME_TRUTH_REPLAY_V1")?.headers.at(-1),
    "Season_Phase_Tag",
  );
});
