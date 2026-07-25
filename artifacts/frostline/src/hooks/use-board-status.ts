import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

export interface BoardStatusEntry {
  game_id: string;
  lock_status: "PRE_LOCK" | "LOCKED_IN" | "LOCKED_OUT";
  lock_cutoff_ts: string;
  pre_lock_decision: string;
  final_decision: string;
  core_blocker: string;
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
}

async function fetchBoardStatus(date: string): Promise<BoardStatusResult> {
  return customFetch<BoardStatusResult>(`/api/pipeline/board-status?date=${date}`);
}

export function useBoardStatus(date: string) {
  return useQuery({
    queryKey: ["board-status", date],
    queryFn: () => fetchBoardStatus(date),
    // Refetch every 60 s — lock status changes infrequently but we want it current
    refetchInterval: 60_000,
    // Don't throw on 404 (no BOARD_LOCK_STATE yet) — treat as empty
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
