import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_INPUT_CATALOG_HEADER,
  buildModelInputCatalogRows,
  ensureModelInputCatalogSheet,
  getModelInputCatalogEntries,
} from "./modelInputCatalog.js";

test("model input catalog has one complete, uniquely identified row per registry entry", () => {
  const entries = getModelInputCatalogEntries();
  const rows = buildModelInputCatalogRows();

  assert.equal(rows.length, entries.length);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(
    rows.every((row) => row.length === MODEL_INPUT_CATALOG_HEADER.length),
  );
});

test("each active model input declares window, source, cadence, freshness surface, and missing behavior", () => {
  const entries = getModelInputCatalogEntries().filter(
    (entry) => entry.outputClass === "ACTIVE_INPUT",
  );
  assert.ok(entries.length > 0);

  for (const entry of entries) {
    assert.notEqual(entry.statisticalWindow, "");
    assert.notEqual(entry.gameWindow, "");
    assert.notEqual(entry.primarySource, "");
    assert.notEqual(entry.refreshCadence, "");
    assert.notEqual(entry.freshnessEvidence, "");
    assert.notEqual(entry.missingBehavior, "");
  }
});

test("catalog labels the active forecast once and does not treat components, shadows, or aliases as active forecasts", () => {
  const entries = getModelInputCatalogEntries();
  const activeForecasts = entries.filter(
    (entry) => entry.outputClass === "ACTIVE_FORECAST",
  );
  assert.deepEqual(
    activeForecasts.map((entry) => entry.id),
    ["ACTIVE_GAME_FORECAST"],
  );

  for (const id of [
    "ACTIVE_BASEBALL_SUBTOTAL",
    "ACTIVE_COMPONENTS",
    "STATCAST_XWOBA_SHADOW",
    "COLLISION_COMBINED_SHADOW",
    "LOW_CENTER_FIXED_SHADOWS",
    "SSAT_FAMILY",
    "PROJECTION_REPLAY_LEGACY_ALIASES",
  ]) {
    const entry = entries.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} must be cataloged`);
    assert.notEqual(entry.outputClass, "ACTIVE_FORECAST");
  }
});

test("synthetic TEAM_FORM placeholders are explicitly decommissioned", () => {
  const entry = getModelInputCatalogEntries().find(
    (candidate) => candidate.id === "PLACEHOLDER_TEAM_FORM",
  );
  assert.equal(entry?.operationalStatus, "DECOMMISSIONED_PLACEHOLDER");
  assert.equal(entry?.feedsActiveProjection, "NO");
});

test("catalog renders source materialization separately from the static registry", () => {
  const observations = new Map() as NonNullable<
    Parameters<typeof buildModelInputCatalogRows>[0]
  >;
  observations.set("TEAM_FORM", {
    date: "2026-08-27",
    timestamp: "2026-08-27T16:00:00.000Z",
    state: "CURRENT_MATERIALIZED (30)",
  });
  const entries = getModelInputCatalogEntries();
  const rows = buildModelInputCatalogRows(observations);
  const sourceIndex = entries.findIndex(
    (entry) => entry.id === "SOURCE_MLB_RECENT_SCORING",
  );

  assert.equal(rows[sourceIndex]?.[13], "2026-08-27");
  assert.equal(rows[sourceIndex]?.[14], "2026-08-27T16:00:00.000Z");
  assert.equal(rows[sourceIndex]?.[15], "CURRENT_MATERIALIZED (30)");
});

test("catalog sheet existence is determined from workbook metadata, not a cell-range probe", async () => {
  let addCalls = 0;
  await ensureModelInputCatalogSheet("workbook", {
    getSpreadsheetSheetProperties: async () => [
      { sheetId: 1, title: "MODEL_INPUT_CATALOG" },
    ],
    addSheet: async () => {
      addCalls++;
    },
  });
  assert.equal(addCalls, 0);
});

test("catalog sheet creation tolerates only a proven duplicate-add race", async () => {
  let metadataReads = 0;
  let addCalls = 0;
  await ensureModelInputCatalogSheet("workbook", {
    getSpreadsheetSheetProperties: async () => {
      metadataReads++;
      return metadataReads === 1
        ? []
        : [{ sheetId: 1, title: "MODEL_INPUT_CATALOG" }];
    },
    addSheet: async () => {
      addCalls++;
      throw new Error(
        'A sheet with the name "MODEL_INPUT_CATALOG" already exists',
      );
    },
  });
  assert.equal(addCalls, 1);
  assert.equal(metadataReads, 2);
});

test("catalog sheet metadata failures do not attempt a blind addSheet", async () => {
  let addCalls = 0;
  await assert.rejects(
    ensureModelInputCatalogSheet("workbook", {
      getSpreadsheetSheetProperties: async () => {
        throw new Error("metadata unavailable");
      },
      addSheet: async () => {
        addCalls++;
      },
    }),
    /metadata unavailable/,
  );
  assert.equal(addCalls, 0);
});
