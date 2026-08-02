import assert from "node:assert/strict";
import test from "node:test";
import { WORKBOOK_SCHEMA } from "./workbookSchema.js";
import { buildNumberFormatRequests } from "./workbookSetup.js";

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
