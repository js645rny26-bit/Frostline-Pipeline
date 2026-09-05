import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHistoricalOddsHistoryRows,
  classifyOddsPriceProvenance,
  ODDS_HISTORY_HEADERS,
} from "./module05d_oddsHistory.js";
import { WORKBOOK_SCHEMA } from "../workbook/workbookSchema.js";

test("ODDS_HISTORY schema preserves raw automated-reference capture fields", () => {
  const schema = WORKBOOK_SCHEMA.find((sheet) => sheet.name === "ODDS_HISTORY");
  assert.deepEqual(schema?.columns.map((column) => column.name), ODDS_HISTORY_HEADERS);
  for (const field of [
    "Observed_Source_Total",
    "Total_Source_Provider",
    "Total_Observed_TS",
    "Total_Selection_Method",
    "Total_Quote_Count",
    "Total_Normalization_Status",
  ]) {
    assert.ok(ODDS_HISTORY_HEADERS.includes(field as never));
  }
});

test("Starting Nine -110 prices are labelled synthetic reference data, never executable", () => {
  assert.deepEqual(
    classifyOddsPriceProvenance("mlbstartingnine", -110, -110, false),
    {
      status: "REFERENCE_TOTAL_SYNTHETIC_PRICE",
      usage_status: "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV",
      notes: "Automated Starting Nine reference total; -110 side prices are synthetic placeholders, not observed executable quotes.",
    },
  );
});

test("legacy non-Starting-Nine prices become UNKNOWN_PROVENANCE without changing their values", () => {
  const legacy = [["2026-08-01T12:00:00.000Z", "2026-08-01", "20260801_AAA_BBB", 8.5, -105, 105, "FanDuel"]];
  const labelled = classifyHistoricalOddsHistoryRows(legacy);
  assert.equal(labelled[0]?.[3], 8.5);
  assert.equal(labelled[0]?.[4], -105);
  assert.equal(labelled[0]?.[5], 105);
  assert.equal(labelled[0]?.[7], "UNKNOWN_PROVENANCE");
  assert.equal(labelled[0]?.[8], "NOT_ELIGIBLE_FOR_EV_VIG_OR_CLV");
});

test("invalid observed American odds stay reference-only and visibly invalid", () => {
  assert.equal(
    classifyOddsPriceProvenance("FanDuel", -90, 90, false).status,
    "OBSERVED_REFERENCE_PRICE_INVALID_FORMAT",
  );
});
