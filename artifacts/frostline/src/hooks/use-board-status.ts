import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { advanceEtagGate, type EtagGateState } from "./etag-gate.js";

export interface BoardStatusEntry {
  game_id: string;
  /**
   * PRE_LOCK              — before cutoff; normal promotion allowed.
   * LOCKED_IN             — was CORE at cutoff; still downgradable.
   * LOCKED_OUT            — not CORE at cutoff; promotion blocked.
   * LOCK_TIME_UNAVAILABLE — no scheduled_utc_time; CORE promotion disabled.
   * LOCK_DATA_UNAVAILABLE — ≥ 50 % of slate games have no time; all new CORE blocked.
   */
  lock_status: "PRE_LOCK" | "LOCKED_IN" | "LOCKED_OUT" | "LOCK_TIME_UNAVAILABLE" | "LOCK_DATA_UNAVAILABLE";
  lock_cutoff_ts: string;
  pre_lock_decision: string;
  final_decision: string;
  core_blocker: string;
  // ── Pick decision detail fields ──────────────────────────────────────────────
  /** OVER / UNDER / NONE */
  direction: string;
  /** Model projected total runs */
  projected_total: number | null;
  /** Market over/under line */
  market_line: number | null;
  /** Edge strength label (e.g. "STRONG", "MODERATE") */
  edge_strength: string;
  /** PASS / FAIL / N_A — survival gate result for this game */
  survival_check: string;
  /** Human-readable reason the survival gate failed, or "" when it passed */
  survival_failure_reason: string;
}

export interface BoardStatusResult {
  date: string;
  timestamp: string;
  /**
   * 16-hex SHA-256 prefix computed from sorted game_id:lock_status pairs.
   * Changes whenever any game's lock badge changes.  Two consecutive reads
   * returning the same etag means the data is consistent (write has settled).
   */
  etag: string;
  games: BoardStatusEntry[];
  /** Earliest cutoff that has NOT yet passed — for "locking soon" banner */
  next_upcoming_cutoff_ts: string | null;
  /** True when any game's cutoff is within 30 min from now */
  cutoff_approaching: boolean;
  locked_in_count: number;
  locked_out_count: number;
  pre_lock_count: number;
  /** Games whose scheduled start time is absent — CORE promotion disabled for these games. */
  lock_time_unavailable_count: number;
  /** Entire slate has ≥ 50 % games with no time — all new CORE promotions blocked. */
  lock_data_unavailable_count: number;
  /**
   * ENABLED                                   — verdict is PASS and report is fresh; CORE authorized normally.
   * DISABLED_MONOTONICITY_FAIL                — verdict is FAIL; all CORE picks blocked.
   * DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE — sample too small; CORE blocked until more history.
   * DISABLED_MONOTONICITY_NOT_COMPUTED        — no OVERALL VERDICT row in sheet yet.
   * DISABLED_MONOTONICITY_STALE               — Report_TS absent or > 24 h old; re-run regression.
   */
  core_auth_status:
    | "ENABLED"
    | "DISABLED_MONOTONICITY_FAIL"
    | "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"
    | "DISABLED_MONOTONICITY_NOT_COMPUTED"
    | "DISABLED_MONOTONICITY_STALE";
  /** Raw OVERALL verdict from the MONOTONICITY sheet. Null when sheet absent. */
  monotonicity_verdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE" | null;
  /** True when the operator sentinel row in BOARD_LOCK_STATE passes all validity checks. */
  monotonicity_override_active: boolean;
}

async function fetchBoardStatus(date: string): Promise<BoardStatusResult> {
  return customFetch<BoardStatusResult>(`/api/pipeline/board-status?date=${date}`);
}

/**
 * Poll /pipeline/board-status every 60 s.
 *
 * Anti-flicker strategy (Task #18):
 *
 *   ETag confirmation gate — prevents a partially-written BOARD_LOCK_STATE
 *   (mid-publish) from flickering badges.  The hook maintains two separate
 *   pieces of state:
 *
 *     stableData  — the last response whose ETag was confirmed stable.
 *                   This is what callers receive as `data` and what drives
 *                   all badge rendering.  It only advances when the same ETag
 *                   is seen on two consecutive reads (proving the write settled).
 *
 *     pendingEtag — the ETag from the most-recent unconfirmed read.
 *                   When this differs from stableEtag, a confirmation re-fetch
 *                   fires after CONFIRM_DELAY_MS.  If the re-fetch returns the
 *                   same ETag, the data is promoted to stableData.  If the ETag
 *                   is still changing (write in flight), the previous stable
 *                   snapshot remains on screen until it settles.
 *
 *   First load accepts the first response immediately (no prior stable state
 *   to protect) so the initial page render is not delayed.
 */
const CONFIRM_DELAY_MS = 3_000;

export function useBoardStatus(date: string) {
  // ── Stable state: only updates once ETag is confirmed ──────────────────────
  const [stableData, setStableData] = useState<BoardStatusResult | undefined>(undefined);

  // ETag gate — pure state machine; held in a ref to avoid stale-closure issues.
  const gateRef  = useRef<EtagGateState>({ stableEtag: undefined, pendingEtag: undefined });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Raw React Query — only used to drive fetches; data gated below ──────────
  const query = useQuery({
    queryKey: ["board-status", date],
    queryFn:  () => fetchBoardStatus(date),
    // Refetch every 60 s — lock status changes infrequently but we want it current.
    refetchInterval: 60_000,
    // Don't throw on 404 (no BOARD_LOCK_STATE yet) — treat as empty.
    retry: false,
  });

  // ── Gate: process each new fetch result through the state machine ───────────
  useEffect(() => {
    const incoming = query.data;
    if (!incoming?.etag) return;

    const { nextState, action } = advanceEtagGate(gateRef.current, incoming.etag);
    gateRef.current = nextState;

    if (action.type === "NEW_CHANGE") {
      // ETag changed for the first time — may be a partial write.
      // Do NOT update stableData; schedule a confirmation re-fetch.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        query.refetch();
      }, CONFIRM_DELAY_MS);
    } else {
      // FIRST_LOAD | UNCHANGED | CONFIRMED — data is consistent; promote to stable.
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setStableData(incoming);
    }
  }, [query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset when date changes ─────────────────────────────────────────────────
  useEffect(() => {
    gateRef.current = { stableEtag: undefined, pendingEtag: undefined };
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setStableData(undefined);
  }, [date]);

  // ── Return stable data, not raw query.data ──────────────────────────────────
  return {
    ...query,
    /** Last ETag-confirmed stable snapshot — drives all badge rendering. */
    data: stableData,
    /**
     * True while a confirmation re-fetch is pending (first-changed ETag not
     * yet seen a second time).  Callers can show a subtle "updating…" indicator.
     */
    isConfirmingEtag: gateRef.current.pendingEtag !== undefined,
  };
}

/** Build a Map<game_id, BoardStatusEntry> for O(1) lookup in GameCard */
export function buildBoardStatusMap(
  result: BoardStatusResult | undefined,
): Map<string, BoardStatusEntry> {
  const m = new Map<string, BoardStatusEntry>();
  if (!result) return m;
  for (const g of result.games) {
    m.set(g.game_id, g);
  }
  return m;
}
