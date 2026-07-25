/**
 * Tests for the ETag confirmation state machine.
 * Run with: node --test --experimental-strip-types src/hooks/etag-gate.test.ts
 *
 * Covers the four critical properties:
 *  1. First load: data accepted immediately (no prior stable state).
 *  2. Unchanged ETag: data updated in-place (timestamps etc. may drift).
 *  3. First-time ETag change: action is NEW_CHANGE, stableEtag unchanged.
 *  4. Confirmed ETag (same changed ETag twice): promoted to stable.
 *  5. ETag keeps changing: stableEtag stays at the last confirmed value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advanceEtagGate, type EtagGateState } from "./etag-gate.ts";

const empty: EtagGateState = { stableEtag: undefined, pendingEtag: undefined };

describe("advanceEtagGate", () => {
  it("1. first load — accepts immediately, no confirmation needed", () => {
    const { nextState, action } = advanceEtagGate(empty, "abc");
    assert.equal(action.type, "FIRST_LOAD");
    assert.equal(nextState.stableEtag, "abc");
    assert.equal(nextState.pendingEtag, undefined);
  });

  it("2. unchanged ETag — updates in place, pendingEtag cleared", () => {
    const stable: EtagGateState = { stableEtag: "abc", pendingEtag: undefined };
    const { nextState, action } = advanceEtagGate(stable, "abc");
    assert.equal(action.type, "UNCHANGED");
    assert.equal(nextState.stableEtag, "abc");
    assert.equal(nextState.pendingEtag, undefined);
  });

  it("3. first-time ETag change — NEW_CHANGE, stable data must NOT update", () => {
    const stable: EtagGateState = { stableEtag: "abc", pendingEtag: undefined };
    const { nextState, action } = advanceEtagGate(stable, "xyz");
    assert.equal(action.type, "NEW_CHANGE");
    // stableEtag must remain "abc" — no badge update yet.
    assert.equal(nextState.stableEtag, "abc");
    assert.equal(nextState.pendingEtag, "xyz");
  });

  it("4. confirmed ETag (same changed ETag twice) — promoted to stable", () => {
    // First read returns "xyz" → NEW_CHANGE
    const after1st = advanceEtagGate({ stableEtag: "abc", pendingEtag: undefined }, "xyz");
    assert.equal(after1st.action.type, "NEW_CHANGE");

    // Second read also returns "xyz" → CONFIRMED
    const after2nd = advanceEtagGate(after1st.nextState, "xyz");
    assert.equal(after2nd.action.type, "CONFIRMED");
    assert.equal(after2nd.nextState.stableEtag, "xyz");
    assert.equal(after2nd.nextState.pendingEtag, undefined);
  });

  it("5. ETag keeps changing — stableEtag stays at last confirmed value", () => {
    const base: EtagGateState = { stableEtag: "abc", pendingEtag: undefined };

    // Read 1: new ETag "mid1" → pending
    const r1 = advanceEtagGate(base, "mid1");
    assert.equal(r1.action.type, "NEW_CHANGE");
    assert.equal(r1.nextState.stableEtag, "abc");

    // Read 2: write still in flight, ETag changed again to "mid2"
    const r2 = advanceEtagGate(r1.nextState, "mid2");
    assert.equal(r2.action.type, "NEW_CHANGE");
    // stableEtag must remain "abc" — mid1 was never confirmed
    assert.equal(r2.nextState.stableEtag, "abc");
    assert.equal(r2.nextState.pendingEtag, "mid2");

    // Read 3: ETag settled at "mid2"
    const r3 = advanceEtagGate(r2.nextState, "mid2");
    assert.equal(r3.action.type, "CONFIRMED");
    assert.equal(r3.nextState.stableEtag, "mid2");
  });
});
