import React from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CloudRain, Wind, Thermometer, AlertCircle, CheckCircle2,
  Clock, Lock, LockOpen, TrendingUp, TrendingDown, Minus,
  ShieldCheck, ShieldAlert, Timer,
} from "lucide-react";
import type { NormalizedGame, PitcherClassification } from "@workspace/api-client-react";
import type { BoardStatusEntry } from "@/hooks/use-board-status";

interface GameCardProps {
  game: NormalizedGame;
  lockEntry?: BoardStatusEntry;
}

/** Format a UTC ISO timestamp as Eastern Time, e.g. "4:40 PM ET" */
function toEtTimeStr(isoUtc: string): string {
  if (!isoUtc) return "";
  try {
    return new Date(isoUtc).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return "";
  }
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
 * PRE_LOCK       — shows "Locks at [time] ET" so the operator knows when
 *                  the window closes.
 * LOCKED_IN      — records the cutoff snapshot (game was CORE when the board
 *                  locked). Shows the decision time and the decision at lock.
 *                  The current authorization (final_decision) may differ if a
 *                  post-lock downgrade occurred; we show both states so the
 *                  operator never confuses cutoff history with live auth.
 * LOCKED_OUT     — shows the blocker reason and a note that any late
 *                  promotion requires a named baseball exception.
 */
function LockStatusBadge({ lockEntry }: { lockEntry: BoardStatusEntry }) {
  const { lock_status, final_decision, lock_cutoff_ts, core_blocker, pre_lock_decision } = lockEntry;
  const cutoffEt = toEtTimeStr(lock_cutoff_ts);

  // ── PRE_LOCK — approaching lock window ────────────────────────────────────
  if (lock_status === "PRE_LOCK") {
    if (!cutoffEt) return null;
    return (
      <span className="flex items-center gap-1 text-muted-foreground border border-border/60 bg-muted/20 px-2 py-0.5 rounded text-[11px] font-medium">
        <Timer className="w-3 h-3 flex-shrink-0" />
        Locks at {cutoffEt}
      </span>
    );
  }

  // ── LOCKED_IN — game was CORE at cutoff snapshot ──────────────────────────
  if (lock_status === "LOCKED_IN") {
    const isDowngraded = final_decision === "NO_CORE";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className={`flex items-center gap-1 border px-2 py-0.5 rounded text-[11px] font-medium ${
          isDowngraded
            ? "text-warning border-warning/40 bg-warning/10"
            : "text-success border-success/40 bg-success/10"
        }`}>
          <Lock className="w-3 h-3 flex-shrink-0" />
          {isDowngraded ? "Locked In · Downgraded" : "Locked In"}
        </span>
        {cutoffEt && (
          <span className="text-[10px] text-muted-foreground font-mono">
            Decision at {cutoffEt}{pre_lock_decision ? ` · ${pre_lock_decision}` : ""}
          </span>
        )}
      </div>
    );
  }

  // ── LOCKED_OUT — missed CORE cutoff; late promotion blocked ───────────────
  if (lock_status === "LOCKED_OUT") {
    // Prefer the current blocker reason; fall back to the decision at lock time.
    const blockerLabel = core_blocker || pre_lock_decision || "";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="flex items-center gap-1 text-warning border border-warning/40 bg-warning/10 px-2 py-0.5 rounded text-[11px] font-medium">
          <LockOpen className="w-3 h-3 flex-shrink-0" />
          Locked Out{cutoffEt ? ` · ${cutoffEt}` : ""}
        </span>
        {blockerLabel && (
          <span
            className="text-[10px] text-muted-foreground font-mono truncate max-w-[220px]"
            title={blockerLabel}
          >
            {blockerLabel.replace(/_/g, " ")}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground italic">
          Promotion requires named baseball exception
        </span>
      </div>
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

  return null;
}

/**
 * Pick decision strip — shows direction, projected vs. line, edge, and survival gate result.
 * Only rendered when the board has published a decision for this game.
 */
function PickDecisionStrip({ entry }: { entry: BoardStatusEntry }) {
  const { final_decision, direction, projected_total, market_line, edge_strength, core_blocker, survival_check, survival_failure_reason } = entry;

  // Nothing to show if no decision has been computed yet
  if (!final_decision || final_decision === "PENDING") return null;

  const isCore    = final_decision === "CORE";
  const isOver    = direction === "OVER";
  const isUnder   = direction === "UNDER";
  const hasLine   = projected_total !== null && market_line !== null;
  const variance  = hasLine ? parseFloat((projected_total! - market_line!).toFixed(2)) : null;

  const DirectionIcon = isOver ? TrendingUp : isUnder ? TrendingDown : Minus;
  const directionColor = isOver
    ? "text-success"
    : isUnder
    ? "text-info"
    : "text-muted-foreground";

  const edgeLabel = edge_strength
    ? edge_strength.replace(/_/g, " ")
    : null;

  const survivalFailed = survival_check === "FAIL";
  const survivalPass   = survival_check === "PASS";

  return (
    <div className={`pt-3 border-t border-border flex flex-col gap-2`}>
      {/* Decision header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isCore ? (
            <span className="px-2 py-0.5 text-[11px] font-bold tracking-wide rounded bg-success/15 text-success border border-success/30">
              CORE
            </span>
          ) : (
            <span className="px-2 py-0.5 text-[11px] font-medium rounded bg-muted/40 text-muted-foreground border border-border">
              NO CORE
            </span>
          )}
          {direction && direction !== "NONE" && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${directionColor}`}>
              <DirectionIcon className="w-3.5 h-3.5" />
              {direction}
            </span>
          )}
        </div>
        {edgeLabel && (
          <span className="text-[10px] font-mono text-muted-foreground border border-border/60 px-1.5 py-0.5 rounded">
            {edgeLabel}
          </span>
        )}
      </div>

      {/* Projection vs. line */}
      {hasLine && (
        <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
          <span>
            Proj <span className="text-foreground font-semibold">{projected_total!.toFixed(1)}</span>
          </span>
          <span className="text-border">vs</span>
          <span>
            Line <span className="text-foreground font-semibold">{market_line!.toFixed(1)}</span>
          </span>
          {variance !== null && (
            <span className={`ml-auto font-semibold ${Math.abs(variance) < 0.5 ? "text-muted-foreground" : isOver ? "text-success" : "text-info"}`}>
              {variance > 0 ? "+" : ""}{variance.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* Survival gate result */}
      {(survivalPass || survivalFailed) && (
        <div className={`flex items-start gap-1.5 text-[11px] ${survivalPass ? "text-success/80" : "text-warning"}`}>
          {survivalPass
            ? <ShieldCheck className="w-3 h-3 flex-shrink-0 mt-0.5" />
            : <ShieldAlert className="w-3 h-3 flex-shrink-0 mt-0.5" />
          }
          <span>
            Survival gate: <span className="font-semibold">{survivalPass ? "PASS" : "FAIL"}</span>
            {survivalFailed && survival_failure_reason && (
              <span className="text-muted-foreground"> — {survival_failure_reason.replace(/_/g, " ")}</span>
            )}
          </span>
        </div>
      )}

      {/* Blocker reason (NO_CORE only) */}
      {!isCore && core_blocker && (
        <div className="text-[10px] text-muted-foreground font-mono bg-muted/30 px-2 py-1 rounded truncate" title={core_blocker}>
          {core_blocker.replace(/_/g, " ")}
        </div>
      )}
    </div>
  );
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
     lockEntry.lock_status === "LOCK_DATA_UNAVAILABLE" ||
     // Show PRE_LOCK pill only when a cutoff time is known — otherwise there's
     // nothing meaningful to display (no "Locks at …" text).
     (lockEntry.lock_status === "PRE_LOCK" && !!lockEntry.lock_cutoff_ts));

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

        {/* Pick decision strip (Task #17) — only when board data is available */}
        {lockEntry && <PickDecisionStrip entry={lockEntry} />}

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
