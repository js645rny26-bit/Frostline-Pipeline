import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import { useGetPipelineSlate, getGetPipelineSlateQueryKey, customFetch } from "@workspace/api-client-react";
import { GameCard } from "@/components/game-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle, CheckCircle2, Info, XCircle, Lock, Timer,
  ShieldOff, ShieldAlert, ShieldCheck, RotateCcw,
} from "lucide-react";
import { useBoardStatus, buildBoardStatusMap } from "@/hooks/use-board-status";
import { useQueryClient } from "@tanstack/react-query";

export default function SlatePage() {
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));

  const { data: slate, isLoading } = useGetPipelineSlate(
    { date },
    { query: { queryKey: getGetPipelineSlateQueryKey({ date }) } }
  );

  const { data: boardStatus } = useBoardStatus(date);
  const lockMap = buildBoardStatusMap(boardStatus);
  const queryClient = useQueryClient();

  // ── Override UI state (Task #22) ──────────────────────────────────────────
  const [overrideReason, setOverrideReason] = useState("");
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overridePending, setOverridePending] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  async function submitOverride(active: boolean) {
    if (active && !overrideReason.trim()) return;
    setOverridePending(true);
    setOverrideError(null);
    try {
      await customFetch("/api/pipeline/monotonicity-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, reason: overrideReason.trim(), active }),
      });
      setShowOverrideForm(false);
      setOverrideReason("");
      await queryClient.invalidateQueries({ queryKey: ["board-status", date] });
    } catch (e: unknown) {
      setOverrideError(e instanceof Error ? e.message : "Override failed");
    } finally {
      setOverridePending(false);
    }
  }

  // Determine which lock banner to show (if any)
  const showLockedBanner =
    boardStatus && (boardStatus.locked_in_count > 0 || boardStatus.locked_out_count > 0);
  const showApproachingBanner =
    boardStatus?.cutoff_approaching && boardStatus.next_upcoming_cutoff_ts;

  function formatCutoffTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function minutesUntilCutoff(iso: string): number {
    return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  }

  // ── CORE auth banner helpers ──────────────────────────────────────────────
  /** True when the auth block is a genuine failure (not just "needs a re-run") */
  function isCoreAuthFailure(status: string) {
    return status === "DISABLED_MONOTONICITY_FAIL" || status === "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE";
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Pipeline Slate</h1>
            <p className="text-sm text-muted-foreground">Full normalized game data and validations</p>
          </div>
          <div className="flex items-center gap-4">
            {isLoading && <span className="text-sm text-muted-foreground animate-pulse">Running pipeline...</span>}
            <DatePicker date={date} onDateChange={setDate} />
          </div>
        </div>

        {/* ── CORE Authorization Status Banner ─────────────────────────────── */}
        {boardStatus && boardStatus.core_auth_status !== "ENABLED" && (() => {
          const status = boardStatus.core_auth_status;
          // FAIL / INSUFFICIENT_SAMPLE → red (genuine failure)
          // STALE / NOT_COMPUTED → amber (routine "re-run needed" state, Task #24)
          const isFailure = isCoreAuthFailure(status);

          const title =
            status === "DISABLED_MONOTONICITY_FAIL"
              ? "CORE Authorization Disabled — Monotonicity FAIL"
              : status === "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"
              ? "CORE Authorization Disabled — Insufficient Sample"
              : status === "DISABLED_MONOTONICITY_STALE"
              ? "CORE Authorization Paused — Regression Report Stale"
              : "CORE Authorization Paused — Regression Not Yet Run Today";

          const body =
            status === "DISABLED_MONOTONICITY_FAIL"
              ? "The edge-tier monotonicity analysis failed: higher edge tiers do not reliably outperform lower ones. All CORE picks are blocked this session. Re-run the regression to recheck, or use the override below."
              : status === "DISABLED_MONOTONICITY_INSUFFICIENT_SAMPLE"
              ? "The monotonicity report does not yet have enough data per tier (< 75 qualifying games in at least one bucket). Accumulate more history and re-run the regression. All CORE picks are blocked until the sample is sufficient."
              : status === "DISABLED_MONOTONICITY_STALE"
              ? "The most recent monotonicity report is older than 24 hours. Re-run the regression to refresh it, or use the override below if today's data is not yet available."
              : "The monotonicity verdict has not been computed yet for today. Re-run the regression to produce it, or use the override below.";

          return (
            <div className={`flex items-start gap-3 px-4 py-3 rounded-md border text-sm ${
              isFailure
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning"
            }`}>
              <ShieldOff className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="font-semibold">{title}</p>
                <p className={isFailure ? "text-destructive/80" : "text-warning/80"}>{body}</p>

                {/* Override form (Task #22) */}
                {!showOverrideForm ? (
                  <button
                    onClick={() => setShowOverrideForm(true)}
                    className="mt-1 text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
                  >
                    Override CORE authorization for today's slate →
                  </button>
                ) : (
                  <div className="flex flex-col gap-2 pt-1">
                    <input
                      type="text"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Reason for override (required)"
                      className="text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-full max-w-sm"
                      disabled={overridePending}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => submitOverride(true)}
                        disabled={overridePending || !overrideReason.trim()}
                        className="text-xs px-3 py-1.5 rounded border border-current font-medium opacity-90 hover:opacity-100 disabled:opacity-40"
                      >
                        {overridePending ? "Saving…" : "Confirm Override"}
                      </button>
                      <button
                        onClick={() => { setShowOverrideForm(false); setOverrideReason(""); setOverrideError(null); }}
                        className="text-xs opacity-60 hover:opacity-80"
                      >
                        Cancel
                      </button>
                    </div>
                    {overrideError && (
                      <p className="text-xs text-destructive">{overrideError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Monotonicity override active banner ── */}
        {boardStatus?.monotonicity_override_active && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-md border border-warning/40 bg-warning/10 text-warning text-sm">
            <div className="flex items-center gap-3">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              <span>
                <strong>Monotonicity gate overridden</strong> — operator exception active for today's slate. CORE authorization enabled despite verdict.
              </span>
            </div>
            {/* Revoke button (Task #22) */}
            <button
              onClick={() => submitOverride(false)}
              disabled={overridePending}
              className="flex items-center gap-1 text-xs font-medium text-warning border border-warning/40 px-2 py-1 rounded hover:bg-warning/20 disabled:opacity-40 flex-shrink-0"
            >
              <RotateCcw className="w-3 h-3" />
              Revoke
            </button>
          </div>
        )}

        {/* ── Monotonicity PASS + override not needed — quiet confirmation ── */}
        {boardStatus?.core_auth_status === "ENABLED" && !boardStatus.monotonicity_override_active && (
          <div className="flex items-center gap-3 px-4 py-2 rounded-md border border-success/30 bg-success/5 text-success text-xs">
            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Monotonicity PASS — CORE authorization enabled.</span>
          </div>
        )}

        {/* ── Lock Suppressed Banner — fires when ≥ 50 % of slate games have no start time ── */}
        {boardStatus && boardStatus.lock_data_unavailable_count > 0 && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-md border border-warning/40 bg-warning/10 text-warning text-sm">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Board Lock Suppressed — Start Times Unavailable</p>
              <p className="text-warning/80 text-xs mt-1">
                More than half of today's games have no confirmed start time. The lock window cannot be
                determined and all new CORE promotions are blocked until start times are published.
                Individual game cards show a{" "}
                <span className="font-medium">No start time — lock window unknown</span>{" "}
                badge for affected games.
              </p>
            </div>
          </div>
        )}

        {/* ── Board Lock Status Banner ── */}
        {showApproachingBanner && boardStatus?.next_upcoming_cutoff_ts && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-md border border-warning/40 bg-warning/10 text-warning text-sm">
            <Timer className="w-4 h-4 flex-shrink-0" />
            <span>
              <strong>Board locking soon</strong> — next cutoff in{" "}
              {minutesUntilCutoff(boardStatus.next_upcoming_cutoff_ts)} min (
              {formatCutoffTime(boardStatus.next_upcoming_cutoff_ts)}). No new
              CORE authorizations after this time without an operator exception.
            </span>
          </div>
        )}

        {!showApproachingBanner && showLockedBanner && boardStatus && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-md border border-border bg-secondary/30 text-sm text-foreground">
            <Lock className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
            <span className="flex items-center gap-3 flex-wrap">
              <span className="text-muted-foreground font-medium">Board lock active</span>
              <span className="text-muted-foreground">·</span>
              <span>
                <span className="text-success font-medium">{boardStatus.locked_in_count}</span>
                <span className="text-muted-foreground"> Locked In at cutoff</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span>
                <span className="text-warning font-medium">{boardStatus.locked_out_count}</span>
                <span className="text-muted-foreground"> Locked Out at cutoff</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span>
                <span className="font-medium">{boardStatus.pre_lock_count}</span>
                <span className="text-muted-foreground"> Pre-Lock</span>
              </span>
            </span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-6">
            <Skeleton className="h-32 w-full" />
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-48 w-full" />)}
            </div>
          </div>
        ) : slate && (
          <>
            {/* Validation Panel */}
            <Card className="border-border shadow-sm">
              <CardHeader className="py-3 px-4 border-b border-border bg-secondary/20 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  Validation Results
                  {slate.validation.status === "PASS" ? (
                    <span className="text-success text-xs border border-success/30 px-1.5 py-0.5 rounded-sm">PASS</span>
                  ) : (
                    <span className="text-destructive text-xs border border-destructive/30 px-1.5 py-0.5 rounded-sm">FAIL</span>
                  )}
                </CardTitle>
                <div className="text-xs font-mono text-muted-foreground">
                  Run: {new Date(slate.run_timestamp).toLocaleTimeString()}
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                {slate.validation.critical_failures.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-destructive uppercase tracking-wider flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> Critical Failures
                    </h4>
                    <ul className="text-sm text-destructive/90 space-y-1">
                      {slate.validation.critical_failures.map((msg, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 flex-shrink-0 w-1 h-1 rounded-full bg-destructive" />
                          <span>{msg}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {slate.validation.warnings.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-warning uppercase tracking-wider flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Warnings
                    </h4>
                    <ul className="text-sm text-warning/90 space-y-1">
                      {slate.validation.warnings.map((msg, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 flex-shrink-0 w-1 h-1 rounded-full bg-warning" />
                          <span>{msg}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {slate.validation.info_notes.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-info uppercase tracking-wider flex items-center gap-1">
                      <Info className="w-3 h-3" /> Info Notes
                    </h4>
                    <ul className="text-sm text-info/90 space-y-1">
                      {slate.validation.info_notes.map((msg, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 flex-shrink-0 w-1 h-1 rounded-full bg-info" />
                          <span>{msg}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {slate.validation.critical_failures.length === 0 && slate.validation.warnings.length === 0 && slate.validation.info_notes.length === 0 && (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-success" />
                    All validations passed with no warnings.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Game Grid */}
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <h2 className="text-lg font-semibold">Normalized Games ({slate.total_games})</h2>
                <div className="text-xs text-muted-foreground flex items-center gap-4">
                  <span>FG Source: {slate.fangraphs_source}</span>
                  <span>Freshness: {slate.fangraphs_freshness}</span>
                </div>
              </div>
              
              {slate.games.length > 0 ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {slate.games.map((game) => (
                    <GameCard
                      key={game.gamePk}
                      game={game}
                      lockEntry={lockMap.get(game.legacy_game_id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-lg">
                  No games scheduled for this date.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
