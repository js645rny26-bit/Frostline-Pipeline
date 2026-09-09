import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_WORKBOOK_ID } from "../lib/sheets/client.js";
import {
  assertBVHBackfillRequest,
  bvhBackfillSourceDisposition,
} from "./backfillBvhTestCopy.js";

test("BVH backfill is date-bounded, pregame-only, and cannot target canonical", () => {
  assert.doesNotThrow(() => assertBVHBackfillRequest("2026-08-01", "2026-08-07", "2026-09-08", "test-workbook"));
  assert.throws(() => assertBVHBackfillRequest("2026-08-01", "2026-08-07", "2026-09-08", CANONICAL_WORKBOOK_ID), /CANONICAL_FORBIDDEN/);
  assert.doesNotThrow(() => assertBVHBackfillRequest(
    "2026-08-01",
    "2026-08-07",
    "2026-09-08",
    CANONICAL_WORKBOOK_ID,
    "CANONICAL_SOURCE_BOOTSTRAP",
  ));
  assert.throws(() => assertBVHBackfillRequest(
    "2026-08-01",
    "2026-08-07",
    "2026-09-08",
    CANONICAL_WORKBOOK_ID,
    "CANONICAL_BOOTSTRAP",
  ), /CANONICAL_FORBIDDEN/);
  assert.throws(() => assertBVHBackfillRequest("2026-08-01", "2026-09-08", "2026-09-08", "test"), /CUTOFF_VIOLATION|RANGE_LIMIT/);
  assert.throws(() => assertBVHBackfillRequest("2026-08-01", "2026-09-01", "2026-09-08", "test"), /RANGE_LIMIT/);
});

test("BVH backfill preserves a header-only day as an explicit gap and retains earlier valid history", () => {
  const retainedSnapshot = {} as never;
  assert.equal(
    bvhBackfillSourceDisposition({ status: "success", source_snapshot: retainedSnapshot }),
    "ACCEPT",
  );
  assert.equal(
    bvhBackfillSourceDisposition({ status: "partial", source_snapshot: retainedSnapshot }),
    "SKIP_EXPLICIT_PARTIAL",
  );
  assert.equal(
    bvhBackfillSourceDisposition({ status: "failure", source_snapshot: null }),
    "FAIL",
  );
});
