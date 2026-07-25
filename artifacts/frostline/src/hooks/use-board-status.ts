import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

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

export function useBoardStatus(date: string) {
  return useQuery({
    queryKey: ["board-status", date],
    queryFn: () => fetchBoardStatus(date),
    // Refetch every 60 s — lock status changes infrequently but we want it current.
    refetchInterval: 60_000,
    // Keep previous data visible while the next fetch is in flight so lock badges
    // don't flicker to blank/undefined between refreshes (Task #18 fix).
    placeholderData: keepPreviousData,
    // Don't throw on 404 (no BOARD_LOCK_STATE yet) — treat as empty.
    retry: false,
  });
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
