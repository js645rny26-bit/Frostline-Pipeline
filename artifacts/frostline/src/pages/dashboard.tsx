import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import { useGetPipelineSummary, useGetPipelineSlate, getGetPipelineSlateQueryKey, getGetPipelineSummaryQueryKey } from "@workspace/api-client-react";
import { GameCard } from "@/components/game-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, AlertTriangle, Users, Cloud, Database } from "lucide-react";

export default function Dashboard() {
  const [date, setDate] = useState("2026-07-22");

  const { data: summary, isLoading: isLoadingSummary } = useGetPipelineSummary(
    { date },
    { query: { queryKey: getGetPipelineSummaryQueryKey({ date }) } }
  );

  const { data: slate, isLoading: isLoadingSlate } = useGetPipelineSlate(
    { date },
    { query: { queryKey: getGetPipelineSlateQueryKey({ date }) } }
  );

  const isLoading = isLoadingSummary || isLoadingSlate;

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Pipeline Dashboard</h1>
            <p className="text-sm text-muted-foreground">High-level overview of MLB slate data</p>
          </div>
          <div className="flex items-center gap-4">
            {isLoading && <span className="text-sm text-muted-foreground animate-pulse">Running pipeline...</span>}
            <DatePicker date={date} onDateChange={setDate} />
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-48 w-full" />)}
            </div>
          </div>
        ) : (
          <>
            {/* Top Stats Bar */}
            {summary && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Total Games</p>
                      <h2 className="text-3xl font-bold mt-1">{summary.total_games}</h2>
                      {summary.doubleheaders > 0 && (
                        <p className="text-xs text-warning mt-1">{summary.doubleheaders} Doubleheaders</p>
                      )}
                    </div>
                    <Database className="w-8 h-8 text-primary opacity-50" />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Pitcher Resolution</p>
                      <h2 className="text-3xl font-bold mt-1">{summary.pitcher_resolution_pct}%</h2>
                      <p className="text-xs text-muted-foreground mt-1">{summary.pitchers_resolved} / {summary.pitchers_total} roles</p>
                    </div>
                    <Users className="w-8 h-8 text-primary opacity-50" />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Live Weather</p>
                      <h2 className="text-3xl font-bold mt-1">{summary.weather_live_pct}%</h2>
                      <p className="text-xs text-muted-foreground mt-1">{summary.weather_live_count} live / {summary.weather_fallback_count} fallback</p>
                    </div>
                    <Cloud className="w-8 h-8 text-primary opacity-50" />
                  </CardContent>
                </Card>

                <Card className={summary.validation_status === "PASS" ? "border-success/50 bg-success/5" : "border-destructive/50 bg-destructive/5"}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Validation</p>
                      <h2 className={`text-3xl font-bold mt-1 flex items-center gap-2 ${summary.validation_status === "PASS" ? "text-success" : "text-destructive"}`}>
                        {summary.validation_status}
                        {summary.validation_status === "PASS" ? <CheckCircle2 className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
                      </h2>
                      <p className="text-xs text-muted-foreground mt-1">{summary.critical_failures} critical, {summary.warnings} warnings</p>
                    </div>
                    <AlertTriangle className={`w-8 h-8 opacity-50 ${summary.validation_status === "PASS" ? "text-success" : "text-destructive"}`} />
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Module Statuses */}
            {slate && (
              <Card>
                <CardHeader className="py-3 px-4 border-b border-border bg-secondary/20">
                  <CardTitle className="text-sm font-medium">Pipeline Modules</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 divide-x divide-y divide-border border-b border-border">
                    {slate.module_statuses.map((mod) => (
                      <div key={mod.module} className="p-3 flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-muted-foreground truncate" title={mod.module}>{mod.module}</span>
                          {mod.status === "PASS" ? (
                            <CheckCircle2 className="w-4 h-4 text-success" />
                          ) : (
                            <XCircle className="w-4 h-4 text-destructive" />
                          )}
                        </div>
                        <div className="text-xs text-foreground mt-1 truncate" title={mod.message || ""}>
                          {mod.message || "OK"}
                        </div>
                        {mod.count != null && (
                          <div className="text-[10px] font-mono text-muted-foreground mt-auto pt-1">
                            n={mod.count}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Game Grid */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold border-b border-border pb-2">Today's Games</h2>
              {slate && slate.games.length > 0 ? (
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
