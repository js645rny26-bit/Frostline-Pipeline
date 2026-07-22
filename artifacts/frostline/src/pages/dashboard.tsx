import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import {
  useGetPipelineSummary,
  useGetPipelineSlate,
  getGetPipelineSlateQueryKey,
  getGetPipelineSummaryQueryKey,
  usePublishPipeline,
  useCreateWorkbook,
} from "@workspace/api-client-react";
import { GameCard } from "@/components/game-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, AlertTriangle, Users, Cloud, Database, Upload, ExternalLink, Loader2, PlusSquare } from "lucide-react";

export default function Dashboard() {
  const [date, setDate] = useState("2026-07-22");
  const [publishResult, setPublishResult] = useState<{ status: string; workbook_url: string; bundle_name?: string; errors: unknown[] } | null>(null);

  const { data: summary, isLoading: isLoadingSummary } = useGetPipelineSummary(
    { date },
    { query: { queryKey: getGetPipelineSummaryQueryKey({ date }) } }
  );

  const { data: slate, isLoading: isLoadingSlate } = useGetPipelineSlate(
    { date },
    { query: { queryKey: getGetPipelineSlateQueryKey({ date }) } }
  );

  const publish = usePublishPipeline();
  const createWb = useCreateWorkbook();
  const [createResult, setCreateResult] = useState<{ workbook_url: string; workbook_name: string; errors: unknown[] } | null>(null);

  const isLoading = isLoadingSummary || isLoadingSlate;

  function handleCreateWorkbook() {
    setCreateResult(null);
    createWb.mutate(
      { params: { date } },
      {
        onSuccess: (result) => {
          setCreateResult({
            workbook_url: result.workbook_url,
            workbook_name: result.workbook_name,
            errors: result.errors ?? [],
          });
        },
        onError: () => {
          setCreateResult({ workbook_url: "", workbook_name: "", errors: ["Workbook creation failed"] });
        },
      }
    );
  }

  function handlePublish() {
    setPublishResult(null);
    publish.mutate(
      { params: { date } },
      {
        onSuccess: (result) => {
          setPublishResult({
            status: result.pipeline_status,
            workbook_url: result.workbook_url,
            bundle_name: result.module_12?.bundle_name,
            errors: result.errors ?? [],
          });
        },
        onError: () => {
          setPublishResult({ status: "error", workbook_url: "", errors: ["Publish request failed"] });
        },
      }
    );
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Pipeline Dashboard</h1>
            <p className="text-sm text-muted-foreground">High-level overview of MLB slate data</p>
          </div>
          <div className="flex items-center gap-3">
            {isLoading && <span className="text-sm text-muted-foreground animate-pulse">Running pipeline...</span>}
            <DatePicker date={date} onDateChange={setDate} />
            <Button
              data-testid="button-create-workbook"
              onClick={handleCreateWorkbook}
              disabled={createWb.isPending}
              variant="outline"
              className="gap-2 font-semibold"
            >
              {createWb.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
              ) : (
                <><PlusSquare className="w-4 h-4" /> New Workbook</>
              )}
            </Button>
            <Button
              data-testid="button-publish-sheets"
              onClick={handlePublish}
              disabled={publish.isPending || isLoading}
              className="gap-2 font-semibold"
            >
              {publish.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Publishing…</>
              ) : (
                <><Upload className="w-4 h-4" /> Publish to Sheets</>
              )}
            </Button>
          </div>
        </div>

        {/* Create workbook result banner */}
        {createResult && (
          <div
            data-testid="create-workbook-result-banner"
            className={`rounded-md border px-4 py-3 flex items-center justify-between gap-4 text-sm ${
              createResult.errors.length === 0
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning"
            }`}
          >
            <div className="flex items-center gap-3">
              {createResult.errors.length === 0 ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              <span>
                {createResult.errors.length === 0
                  ? `New workbook created — ${createResult.workbook_name}`
                  : `Workbook created with ${createResult.errors.length} warning(s) — ${createResult.workbook_name}`}
              </span>
            </div>
            {createResult.workbook_url && (
              <a
                data-testid="link-open-new-workbook"
                href={createResult.workbook_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 underline underline-offset-2 shrink-0"
              >
                Open Workbook <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {/* Publish result banner */}
        {publishResult && (
          <div
            data-testid="publish-result-banner"
            className={`rounded-md border px-4 py-3 flex items-center justify-between gap-4 text-sm ${
              publishResult.status === "success"
                ? "border-success/40 bg-success/10 text-success"
                : publishResult.status === "partial_success"
                ? "border-warning/40 bg-warning/10 text-warning"
                : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
          >
            <div className="flex items-center gap-3">
              {publishResult.status === "success" ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : publishResult.status === "partial_success" ? (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0" />
              )}
              <span>
                {publishResult.status === "success"
                  ? `Published successfully${publishResult.bundle_name ? ` — bundle ${publishResult.bundle_name}` : ""}`
                  : publishResult.status === "partial_success"
                  ? "Partial publish — some modules had warnings"
                  : "Publish failed"}
              </span>
            </div>
            {publishResult.workbook_url && (
              <a
                data-testid="link-open-workbook"
                href={publishResult.workbook_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 underline underline-offset-2 shrink-0"
              >
                Open Workbook <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

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
