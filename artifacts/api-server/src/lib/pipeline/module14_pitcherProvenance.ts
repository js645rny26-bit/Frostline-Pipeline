/**
 * Pure MLB boxscore parsing helpers for postgame pitcher-role provenance.
 *
 * Settlement uses these helpers only after a game is Final.  The resulting
 * snapshot records the actual starter, the most-used non-starter (bulk arm),
 * and the complete pitching chain in appearance order.
 */

export type PitcherMatchStatus = "MATCH" | "MISMATCH" | "UNRESOLVED";
export type PitcherProvenanceStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface TeamPitcherProvenance {
  actual_starter: string;
  bulk_pitcher: string;
  pitcher_chain: string;
  status: PitcherProvenanceStatus;
}

export interface GamePitcherProvenance {
  away: TeamPitcherProvenance;
  home: TeamPitcherProvenance;
  status: PitcherProvenanceStatus;
}

/** Legacy SHADOW_OUTCOMES rows may have unrelated values in the appended columns. */
export function hasUsablePitcherProvenance(status: string): boolean {
  return status === "COMPLETE" || status === "PARTIAL";
}

interface RawPitchingStats {
  gamesStarted?: number;
  inningsPitched?: string;
  outs?: number;
}

interface RawBoxscorePlayer {
  person?: { id?: number; fullName?: string };
  stats?: { pitching?: RawPitchingStats };
}

interface RawBoxscoreTeam {
  pitchers?: Array<number | string>;
  players?: Record<string, RawBoxscorePlayer>;
}

interface RawBoxscore {
  teams?: { away?: RawBoxscoreTeam; home?: RawBoxscoreTeam };
}

interface PitcherAppearance {
  id: string;
  name: string;
  innings_pitched: string;
  outs: number;
  games_started: number;
}

function inningsToOuts(innings: string): number {
  const [wholeRaw, partialRaw = "0"] = innings.split(".");
  const whole = Number.parseInt(wholeRaw ?? "0", 10);
  const partial = Number.parseInt(partialRaw, 10);
  if (!Number.isFinite(whole) || !Number.isFinite(partial) || partial < 0 || partial > 2) return 0;
  return whole * 3 + partial;
}

function normalizePitcherName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function comparePitcherNames(projected: string, actual: string): PitcherMatchStatus {
  const projectedNorm = normalizePitcherName(projected);
  const actualNorm = normalizePitcherName(actual);
  if (!projectedNorm || projectedNorm === "unresolved" || projectedNorm === "tbd" || !actualNorm) {
    return "UNRESOLVED";
  }
  return projectedNorm === actualNorm ? "MATCH" : "MISMATCH";
}

function getPlayer(team: RawBoxscoreTeam, pitcherId: number | string): RawBoxscorePlayer | undefined {
  const id = String(pitcherId);
  return team.players?.[`ID${id}`]
    ?? Object.values(team.players ?? {}).find((player) => String(player.person?.id ?? "") === id);
}

function parseTeam(team: RawBoxscoreTeam | undefined): TeamPitcherProvenance {
  if (!team) {
    return { actual_starter: "", bulk_pitcher: "", pitcher_chain: "", status: "UNAVAILABLE" };
  }

  const orderedIds = team.pitchers ?? [];
  const appearances: PitcherAppearance[] = [];

  for (const pitcherId of orderedIds) {
    const player = getPlayer(team, pitcherId);
    const name = player?.person?.fullName?.trim() ?? "";
    if (!name) continue;
    const stats = player?.stats?.pitching ?? {};
    const innings = String(stats.inningsPitched ?? "");
    appearances.push({
      id: String(pitcherId),
      name,
      innings_pitched: innings,
      outs: Number.isFinite(stats.outs) ? Number(stats.outs) : inningsToOuts(innings),
      games_started: Number(stats.gamesStarted ?? 0),
    });
  }

  if (appearances.length === 0) {
    return { actual_starter: "", bulk_pitcher: "", pitcher_chain: "", status: "UNAVAILABLE" };
  }

  // MLB boxscores order pitchers by appearance. gamesStarted is authoritative;
  // the first appearance is a safe fallback for older/incomplete payloads.
  const starter = appearances.find((pitcher) => pitcher.games_started > 0) ?? appearances[0]!;
  const bulk = appearances
    .filter((pitcher) => pitcher.id !== starter.id)
    .sort((left, right) => right.outs - left.outs)[0];

  const pitcherChain = appearances
    .map((pitcher) => `${pitcher.name} (${pitcher.innings_pitched || "0.0"} IP)`)
    .join(" > ");

  return {
    actual_starter: starter.name,
    bulk_pitcher: bulk?.name ?? "",
    pitcher_chain: pitcherChain,
    status: starter.name && pitcherChain ? "COMPLETE" : "PARTIAL",
  };
}

export function parseGamePitcherProvenance(boxscore: unknown): GamePitcherProvenance {
  const raw = (boxscore ?? {}) as RawBoxscore;
  const away = parseTeam(raw.teams?.away);
  const home = parseTeam(raw.teams?.home);
  const status: PitcherProvenanceStatus =
    away.status === "COMPLETE" && home.status === "COMPLETE" ? "COMPLETE"
    : away.status === "UNAVAILABLE" && home.status === "UNAVAILABLE" ? "UNAVAILABLE"
    : "PARTIAL";
  return { away, home, status };
}
