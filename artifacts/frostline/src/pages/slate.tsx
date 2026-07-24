import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import { useGetPipelineSlate, getGetPipelineSlateQueryKey } from "@workspace/api-client-react";
import { GameCard } from "@/components/game-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export default function SlatePage() {
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));

  const { data: slate, isLoading } = useGetPipelineSlate(
    { date },
    { query: { queryKey: getGetPipelineSlateQueryKey({ date }) } }
  );

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
                    <GameCard key={game.gamePk} game={game} />
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
