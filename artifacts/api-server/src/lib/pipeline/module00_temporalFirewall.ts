/**
 * Runtime temporal firewall for prospective publication.
 *
 * Prospective mutation is game-granular. Games at/after first pitch (or with
 * an unavailable first-pitch time) are protected while later games on the
 * same slate remain mutable. Historical work belongs on an explicitly
 * labelled REPLAY surface; settlement is append-only.
 */

export type LifecycleSurface = "PUBLISH" | "REPLAY" | "SETTLEMENT";

export interface TemporalGameIdentity {
  legacy_game_id: string;
  scheduled_utc_time: string | null;
}

export interface TemporalFirewallResult {
  surface: LifecycleSurface;
  checked_at: string;
  allowed: boolean;
  mutable_games: string[];
  blocked_games: string[];
  missing_time_games: string[];
  code: "PREGAME_MUTATION_ALLOWED" | "PARTIAL_PREGAME_MUTATION_ALLOWED" | "TEMPORAL_FIREWALL_BLOCKED" | "NON_PREGAME_SURFACE";
}

export function evaluateTemporalFirewall(
  games: TemporalGameIdentity[],
  checkedAt: string,
  surface: LifecycleSurface = "PUBLISH",
): TemporalFirewallResult {
  if (surface !== "PUBLISH") {
    return {
      surface,
      checked_at: checkedAt,
      allowed: true,
      mutable_games: games.map((game) => game.legacy_game_id),
      blocked_games: [],
      missing_time_games: [],
      code: "NON_PREGAME_SURFACE",
    };
  }

  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error(`TEMPORAL_FIREWALL_INVALID_CLOCK: ${checkedAt}`);
  }

  const blockedGames: string[] = [];
  const missingTimeGames: string[] = [];
  const mutableGames: string[] = [];
  for (const game of games) {
    const firstPitchMs = Date.parse(game.scheduled_utc_time ?? "");
    if (!Number.isFinite(firstPitchMs)) {
      missingTimeGames.push(game.legacy_game_id);
      continue;
    }
    if (checkedAtMs >= firstPitchMs) blockedGames.push(game.legacy_game_id);
    else mutableGames.push(game.legacy_game_id);
  }

  const allowed = mutableGames.length > 0;
  const partiallyProtected = allowed && (blockedGames.length > 0 || missingTimeGames.length > 0);
  return {
    surface,
    checked_at: checkedAt,
    allowed,
    mutable_games: mutableGames,
    blocked_games: blockedGames,
    missing_time_games: missingTimeGames,
    code: allowed
      ? partiallyProtected ? "PARTIAL_PREGAME_MUTATION_ALLOWED" : "PREGAME_MUTATION_ALLOWED"
      : "TEMPORAL_FIREWALL_BLOCKED",
  };
}

export function assertProspectivePublicationAllowed(
  games: TemporalGameIdentity[],
  checkedAt: string,
): TemporalFirewallResult {
  const result = evaluateTemporalFirewall(games, checkedAt, "PUBLISH");
  if (!result.allowed) {
    const reasons = [
      result.blocked_games.length > 0
        ? `AT_OR_AFTER_FIRST_PITCH=${result.blocked_games.join(",")}`
        : "",
      result.missing_time_games.length > 0
        ? `PREGAME_TIME_UNAVAILABLE=${result.missing_time_games.join(",")}`
        : "",
    ].filter(Boolean).join("; ");
    throw new Error(
      `TEMPORAL_FIREWALL_BLOCKED: no mutable pregame games remain; ${reasons}. `
      + "Use an explicitly labelled REPLAY surface for historical recalculation.",
    );
  }
  return result;
}

export function isAtOrAfterFirstPitch(scheduledFirstPitch: string, checkedAt: string): boolean {
  const firstPitchMs = Date.parse(scheduledFirstPitch);
  const checkedAtMs = Date.parse(checkedAt);
  return Number.isFinite(firstPitchMs) && Number.isFinite(checkedAtMs) && checkedAtMs >= firstPitchMs;
}
