import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import { useGetPipelineSlate, getGetPipelineSlateQueryKey } from "@workspace/api-client-react";
import { GameCard } from "@/components/game-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2, Info, XCircle, Lock, LockOpen, Timer } from "lucide-react";
import { useBoardStatus, buildBoardStatusMap } from "@/hooks/use-board-status";

export default function SlatePage() {
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));

  const { data: slate, isLoading } = useGetPipelineSlate(
    { date },
    { query: { queryKey: getGetPipelineSlateQueryKey({ date }) } }
  );

  const { data: boardStatus } = useBoardStatus(date);
  const lockMap = buildBoardStatusMap(boardStatus);

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
