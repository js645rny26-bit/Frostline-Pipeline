/**
 * Pure ETag confirmation state machine.
 *
 * Prevents partially-written BOARD_LOCK_STATE data from flickering onto
 * lock-status badges.  A new ETag is only considered "stable" once it has
 * been seen on two consecutive reads from /pipeline/board-status.
 *
 * Designed to be side-effect-free so it can be tested without React.
 */

export interface EtagGateState {
  /** ETag that has been confirmed stable (seen ≥ 2 times consecutively). */
  stableEtag: string | undefined;
  /**
   * ETag from the most-recent fetch that has NOT yet been confirmed.
   * Undefined when the last read matched the stable ETag.
   */
  pendingEtag: string | undefined;
}

export type EtagGateAction =
  | { type: "FIRST_LOAD"; etag: string }   // no prior stable state
  | { type: "UNCHANGED" }                  // new read matches stableEtag
  | { type: "CONFIRMED"; etag: string }    // new read matches pendingEtag → promote
  | { type: "NEW_CHANGE"; etag: string };  // new etag seen for the first time

/**
 * Compute the next gate state and the action that produced it.
 *
 * Returns `{ nextState, action }` — the caller decides whether to:
 *  - Promote display data (action === "CONFIRMED" | "UNCHANGED" | "FIRST_LOAD")
 *  - Schedule a confirmation re-fetch   (action === "NEW_CHANGE")
 */
export function advanceEtagGate(
  current: EtagGateState,
  incomingEtag: string,
): { nextState: EtagGateState; action: EtagGateAction } {
  // ── First load: no stable ETag yet → accept immediately ──────────────────
  if (current.stableEtag === undefined) {
    return {
      nextState: { stableEtag: incomingEtag, pendingEtag: undefined },
      action:    { type: "FIRST_LOAD", etag: incomingEtag },
    };
  }

  // ── Unchanged: incoming matches the already-stable ETag ──────────────────
  if (incomingEtag === current.stableEtag) {
    return {
      nextState: { stableEtag: current.stableEtag, pendingEtag: undefined },
      action:    { type: "UNCHANGED" },
    };
  }

  // ── Confirmed: incoming matches the pending (unconfirmed) ETag ───────────
  if (incomingEtag === current.pendingEtag) {
    return {
      nextState: { stableEtag: incomingEtag, pendingEtag: undefined },
      action:    { type: "CONFIRMED", etag: incomingEtag },
    };
  }

  // ── New change: first time seeing this ETag → hold, schedule re-fetch ────
  return {
    nextState: { stableEtag: current.stableEtag, pendingEtag: incomingEtag },
    action:    { type: "NEW_CHANGE", etag: incomingEtag },
  };
}
