import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { DatePicker } from "@/components/ui/date-picker";
import { useGetPipelineSchedule, getGetPipelineScheduleQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SchedulePage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const { data: schedule, isLoading } = useGetPipelineSchedule(
    { date },
    { query: { queryKey: getGetPipelineScheduleQueryKey({ date }) } }
  );

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Raw MLB Schedule</h1>
            <p className="text-sm text-muted-foreground">Module 01: Base game data from MLB Stats API</p>
          </div>
          <div className="flex items-center gap-4">
            {isLoading && <span className="text-sm text-muted-foreground animate-pulse">Fetching schedule...</span>}
            <DatePicker date={date} onDateChange={setDate} />
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(i => <Skeleton key={i} className="h-32 w-full" />)}
          </div>
        ) : schedule && (
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h2 className="text-lg font-semibold">Games Scheduled: {schedule.total_games}</h2>
              <div className="text-xs font-mono text-muted-foreground">
                Fetched: {new Date(schedule.retrieval_timestamp_utc).toLocaleTimeString()}
              </div>
            </div>

            {schedule.games.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {schedule.games.map((game) => {
                  const timeStr = game.gameDateTime 
                    ? new Date(game.gameDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : "TBD";

                  return (
                    <Card key={game.gamePk} className="flex flex-col">
                      <CardHeader className="py-2 px-3 border-b border-border bg-secondary/10 flex flex-row items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock className="w-3.5 h-3.5" />
                          <span>{timeStr}</span>
                        </div>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          PK: {game.gamePk}
                        </Badge>
                      </CardHeader>
                      <CardContent className="p-4 flex-1 flex flex-col gap-3">
                        <div className="flex justify-between items-center">
                          <div className="text-center w-[45%]">
                            <div className="text-xl font-bold">{game.awayTeam.abbreviation}</div>
                            <div className="text-xs text-muted-foreground mt-1 truncate" title={game.awayProbablePitcher.fullName || "TBD"}>
                              {game.awayProbablePitcher.fullName || "TBD"}
                              {game.awayProbablePitcher.hand && <span className="ml-1 text-[10px] border border-border px-1 rounded">{game.awayProbablePitcher.hand}</span>}
                            </div>
                          </div>
                          <div className="text-sm font-bold text-muted-foreground">@</div>
                          <div className="text-center w-[45%]">
                            <div className="text-xl font-bold">{game.homeTeam.abbreviation}</div>
                            <div className="text-xs text-muted-foreground mt-1 truncate" title={game.homeProbablePitcher.fullName || "TBD"}>
                              {game.homeProbablePitcher.fullName || "TBD"}
                              {game.homeProbablePitcher.hand && <span className="ml-1 text-[10px] border border-border px-1 rounded">{game.homeProbablePitcher.hand}</span>}
                            </div>
                          </div>
                        </div>

                        <div className="mt-auto pt-3 border-t border-border flex flex-col gap-1 text-[10px] text-muted-foreground">
                          <div className="flex justify-between">
                            <span>Status:</span>
                            <span className="font-medium text-foreground">{game.status.detailedState}</span>
                          </div>
                          <div className="flex justify-between truncate" title={game.venue.name || "Unknown"}>
                            <span>Venue:</span>
                            <span className="font-medium text-foreground truncate ml-2">{game.venue.name}</span>
                          </div>
                          {game.doubleheaderStatus !== "N" && (
                            <div className="flex justify-between">
                              <span>Doubleheader:</span>
                              <span className="font-medium text-warning">{game.doubleheaderStatus} (Game {game.gameNumber})</span>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-lg">
                No games scheduled for this date.
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
