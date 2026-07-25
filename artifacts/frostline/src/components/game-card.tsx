import React from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CloudRain, Wind, Thermometer, AlertCircle, CheckCircle2, Clock, Lock, LockOpen } from "lucide-react";
import type { NormalizedGame, PitcherClassification } from "@workspace/api-client-react";
import type { BoardStatusEntry } from "@/hooks/use-board-status";

interface GameCardProps {
  game: NormalizedGame;
  lockEntry?: BoardStatusEntry;
}

function RoleBadge({ role }: { role: string }) {
  switch (role) {
    case "CONVENTIONAL_STARTER":
      return <Badge variant="success">STARTER</Badge>;
    case "OPENER":
      return <Badge variant="info">OPENER</Badge>;
    case "BULK":
      return <Badge variant="warning">BULK</Badge>;
    case "UNRESOLVED":
    default:
      return <Badge variant="destructive">UNRESOLVED</Badge>;
  }
}

function PitcherInfo({ pitcher, teamAbbr, isHome }: { pitcher: PitcherClassification; teamAbbr: string; isHome: boolean }) {
  return (
    <div className={`flex flex-col gap-2 ${isHome ? "text-right items-end" : "text-left items-start"}`}>
      <div className="flex items-center gap-2">
        {!isHome && <span className="text-xl font-bold text-muted-foreground">{teamAbbr}</span>}
        <span className="font-semibold text-foreground text-lg">{pitcher.name || "TBD"}</span>
        {isHome && <span className="text-xl font-bold text-muted-foreground">{teamAbbr}</span>}
      </div>
      
      <div className="flex flex-wrap gap-1 mt-1 justify-end">
        <RoleBadge role={pitcher.role} />
        {pitcher.hand && (
          <Badge variant="outline" className="text-muted-foreground">
            {pitcher.hand}HP
          </Badge>
        )}
        {pitcher.workload_flags?.map((flag: string) => (
          <Badge key={flag} variant="secondary" className="text-xs">
            {flag.replace(/_/g, " ")}
          </Badge>
        ))}
      </div>
      
      {pitcher.expected_pitches != null && (
        <div className="text-xs text-muted-foreground font-mono mt-1">
          EXP: {pitcher.expected_pitches}P / {pitcher.expected_innings}IP
        </div>
      )}
    </div>
  );
}

/**
 * Lock status pill shown in the game card header.
 *
 * LOCKED_IN records the historical cutoff snapshot — the game was CORE when
 * the board locked. The current authorization (final_decision) may differ if
 * a post-lock downgrade occurred (starter scratch, data loss, etc.).
 * We show both states so the operator never confuses cutoff history with
 * live authorization.
 */
function LockStatusBadge({ lockEntry }: { lockEntry: BoardStatusEntry }) {
  const { lock_status, final_decision } = lockEntry;

  if (lock_status === "LOCKED_IN") {
    // Post-lock downgrade: was CORE at cutoff, now NO_CORE. Show amber warning.
    if (final_decision === "NO_CORE") {
      return (
        <span className="flex items-center gap-1 text-warning border border-warning/40 bg-warning/10 px-2 py-0.5 rounded text-[11px] font-medium">
          <Lock className="w-3 h-3" />
          Locked In · Downgraded
        </span>
      );
    }
    // Still CORE (or no publish data yet) — green.
    return (
      <span className="flex items-center gap-1 text-success border border-success/40 bg-success/10 px-2 py-0.5 rounded text-[11px] font-medium">
        <Lock className="w-3 h-3" />
        Locked In
      </span>
    );
  }

  if (lock_status === "LOCKED_OUT") {
    return (
      <span className="flex items-center gap-1 text-warning border border-warning/40 bg-warning/10 px-2 py-0.5 rounded text-[11px] font-medium">
        <LockOpen className="w-3 h-3" />
        Locked Out
      </span>
    );
  }

  if (lock_status === "LOCK_TIME_UNAVAILABLE") {
    // No scheduled start time — lock window unknown; CORE promotion disabled.
    return (
      <span className="flex items-center gap-1 text-muted-foreground border border-border bg-muted/30 px-2 py-0.5 rounded text-[11px] font-medium">
        <LockOpen className="w-3 h-3" />
        Lock Time Unavailable · CORE Disabled
      </span>
    );
  }

  if (lock_status === "LOCK_DATA_UNAVAILABLE") {
    // ≥ 50 % of slate games have no time — entire slate lock suppressed.
    return (
      <span className="flex items-center gap-1 text-muted-foreground border border-border bg-muted/30 px-2 py-0.5 rounded text-[11px] font-medium">
        <LockOpen className="w-3 h-3" />
        Lock Data Unavailable · CORE Disabled
      </span>
    );
  }

  // PRE_LOCK → no indicator
  return null;
}

export function GameCard({ game, lockEntry }: GameCardProps) {
  const isFallbackWeather = game.environment.data_quality === "fallback";

  const timeStr = game.scheduled_utc_time 
    ? new Date(game.scheduled_utc_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : "TBD";

  const showLockBadge =
    lockEntry &&
    (lockEntry.lock_status === "LOCKED_IN" ||
     lockEntry.lock_status === "LOCKED_OUT" ||
     lockEntry.lock_status === "LOCK_TIME_UNAVAILABLE" ||
     lockEntry.lock_status === "LOCK_DATA_UNAVAILABLE");

  return (
    <Card className="flex flex-col">
      <CardHeader className="py-3 px-4 border-b border-border bg-secondary/20 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">{timeStr}</span>
          <span className="text-xs text-muted-foreground">@ {game.venue.name}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {showLockBadge && lockEntry && <LockStatusBadge lockEntry={lockEntry} />}
          {game.game_status.abstractGameState === "Final" ? (
            <Badge variant="outline">FINAL</Badge>
          ) : (
            <span className="text-muted-foreground">{game.game_status.detailedState}</span>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="p-4 flex-1 flex flex-col gap-4">
        {/* Teams & Pitchers */}
        <div className="flex justify-between items-start gap-4">
          <PitcherInfo 
            pitcher={game.away_pitcher} 
            teamAbbr={game.away_team.team_abbr || "AWAY"} 
            isHome={false} 
          />
          <div className="text-muted-foreground font-bold pt-1">@</div>
          <PitcherInfo 
            pitcher={game.home_pitcher} 
            teamAbbr={game.home_team.team_abbr || "HOME"} 
            isHome={true} 
          />
        </div>

        {/* Environment Bar */}
        <div className="mt-auto pt-4 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5" title="Temperature">
              <Thermometer className="w-3.5 h-3.5" />
              <span>{game.environment.temperature_f ?? "--"}°F</span>
            </div>
            <div className="flex items-center gap-1.5" title="Wind">
              <Wind className="w-3.5 h-3.5" />
              <span>{game.environment.wind_speed_mph ?? "--"} mph</span>
            </div>
            <div className="flex items-center gap-1.5" title="Precipitation">
              <CloudRain className="w-3.5 h-3.5" />
              <span>{game.environment.precipitation_probability_pct ?? "--"}%</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isFallbackWeather ? (
              <span className="flex items-center gap-1 text-warning border border-warning/30 px-1.5 py-0.5 rounded text-[10px]">
                <AlertCircle className="w-3 h-3" />
                CLIMATOLOGY
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success border border-success/30 px-1.5 py-0.5 rounded text-[10px]">
                <CheckCircle2 className="w-3 h-3" />
                LIVE WX
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
