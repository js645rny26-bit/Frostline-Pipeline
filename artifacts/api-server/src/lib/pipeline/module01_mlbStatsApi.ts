/**
 * Module 01: MLB StatsAPI
 * Fetch authoritative schedule, game identity, probable pitchers.
 */

import { SOURCE_MAPPINGS } from "./config.js";
import { logger } from "../../lib/logger.js";

const STATSAPI_BASE = "https://statsapi.mlb.com/api/v1";

export interface ProbablePitcherData {
  id: number | null;
  fullName: string | null;
  hand: string | null;
}

export interface GameTeamData {
  id: number | null;
  name: string | null;
  abbreviation: string;
}

export interface VenueData {
  id: number | null;
  name: string | null;
  timeZone: string | null;
}

export interface GameStatusData {
  abstractGameState: string | null;
  detailedState: string | null;
  codedGameState: string | null;
}

export interface ScheduleGameData {
  gamePk: number;
  legacy_game_id: string;
  officialDate: string | null;   // YYYY-MM-DD in ET — canonical calendar date for this game
  gameDateTime: string | null;   // UTC ISO timestamp (first-pitch time)
  venue: VenueData;
  awayTeam: GameTeamData;
  homeTeam: GameTeamData;
  awayProbablePitcher: ProbablePitcherData;
  homeProbablePitcher: ProbablePitcherData;
  status: GameStatusData;
  doubleheaderStatus: string;
  gameNumber: number | null;
}

export interface GameScheduleResult {
  retrieval_timestamp_utc: string;
  date: string;
  total_games: number;
  games: ScheduleGameData[];
  status: string;
  error?: string;
}

/**
 * Return the date/away/home portion of a Frostline game identity.
 *
 * Regular games retain this familiar identifier. The schedule module adds a
 * suffix only when the official schedule contains a same-day doubleheader,
 * so team-only sources can still be matched conservatively by their base ID.
 */
export function baseGameId(gameId: string): string {
  return gameId.replace(/__G(?:\d+|PK\d+)$/, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeGame(raw: any): ScheduleGameData {
  const awayRaw = raw?.teams?.away ?? {};
  const homeRaw = raw?.teams?.home ?? {};

  const awayTeamId = awayRaw?.team?.id ?? null;
  const homeTeamId = homeRaw?.team?.id ?? null;

  const awayInfo = SOURCE_MAPPINGS[String(awayTeamId)] ?? null;
  const homeInfo = SOURCE_MAPPINGS[String(homeTeamId)] ?? null;

  const awayAbbr = awayInfo?.canonical_abbr ?? awayRaw?.team?.abbreviation ?? "UNK";
  const homeAbbr = homeInfo?.canonical_abbr ?? homeRaw?.team?.abbreviation ?? "UNK";

  // officialDate  = YYYY-MM-DD in ET — the canonical calendar date for this game
  // gameDate      = UTC ISO datetime (first-pitch time); for late-night West Coast
  //                 games this ticks into the next UTC day, so must NOT be used
  //                 for the calendar date in the game_id.
  const officialDate: string | null = raw?.officialDate ?? null;
  const gameDateTime: string | null = raw?.gameDate ?? null;

  // Build the date component from officialDate (ET). Fall back to UTC only if
  // officialDate is absent (should never happen for real scheduled games).
  const gameDate = officialDate
    ? officialDate.replace(/-/g, "")
    : (gameDateTime ? gameDateTime.split("T")[0].replace(/-/g, "") : "00000000");

  const legacyGameId = `${gameDate}_${awayAbbr}_${homeAbbr}`;

  const awayProb = awayRaw?.probablePitcher ?? {};
  const homeProb = homeRaw?.probablePitcher ?? {};

  return {
    gamePk: raw?.gamePk ?? 0,
    legacy_game_id: legacyGameId,
    officialDate,
    gameDateTime,
    venue: {
      id: raw?.venue?.id ?? null,
      name: raw?.venue?.name ?? null,
      timeZone: raw?.venue?.timeZone?.id ?? raw?.venue?.timeZone ?? "America/New_York",
    },
    awayTeam: {
      id: awayTeamId,
      name: awayRaw?.team?.name ?? null,
      abbreviation: awayAbbr,
    },
    homeTeam: {
      id: homeTeamId,
      name: homeRaw?.team?.name ?? null,
      abbreviation: homeAbbr,
    },
    awayProbablePitcher: {
      id: awayProb?.id ?? null,
      fullName: awayProb?.fullName ?? null,
      hand: awayProb?.pitchHand?.code ?? null,
    },
    homeProbablePitcher: {
      id: homeProb?.id ?? null,
      fullName: homeProb?.fullName ?? null,
      hand: homeProb?.pitchHand?.code ?? null,
    },
    status: {
      abstractGameState: raw?.status?.abstractGameState ?? null,
      detailedState: raw?.status?.detailedState ?? null,
      codedGameState: raw?.status?.codedGameState ?? null,
    },
    doubleheaderStatus: raw?.doubleheaderStatus ?? "N",
    gameNumber: raw?.gameNumber ?? null,
  };
}

/**
 * Give each official game a worksheet-safe identity.
 *
 * The former date_away_home form is retained for normal slates. It is not
 * unique on doubleheader days, however, so the two official games receive
 * stable __G1 / __G2 suffixes based on MLB's gameNumber. If MLB omits that
 * field, the official gamePk is used rather than guessing from source order.
 */
export function assignUniqueScheduleGameIds(games: readonly ScheduleGameData[]): ScheduleGameData[] {
  const groups = new Map<string, ScheduleGameData[]>();
  for (const game of games) {
    const base = baseGameId(game.legacy_game_id);
    const group = groups.get(base) ?? [];
    group.push(game);
    groups.set(base, group);
  }

  return games.map((game) => {
    const base = baseGameId(game.legacy_game_id);
    const group = groups.get(base) ?? [];
    if (group.length < 2) return game;

    const gameNumber = game.gameNumber;
    const numberIsUnique = Number.isInteger(gameNumber)
      && gameNumber !== null
      && group.filter((candidate) => candidate.gameNumber === gameNumber).length === 1;
    const suffix = numberIsUnique ? `G${gameNumber}` : `GPK${game.gamePk}`;
    return { ...game, legacy_game_id: `${base}__${suffix}` };
  });
}

export async function fetchMlbSchedule(dateStr: string): Promise<GameScheduleResult> {
  logger.info({ date: dateStr }, "MODULE_01: Fetching MLB schedule");

  try {
    const url = new URL(`${STATSAPI_BASE}/schedule`);
    url.searchParams.set("sportId", "1");
    url.searchParams.set("date", dateStr);
    url.searchParams.set("hydrate", "probablePitcher(note)");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`StatsAPI HTTP ${response.status}`);
    }

    const data = await response.json() as { dates?: Array<{ games?: unknown[] }> };
    const allGames: unknown[] = [];
    for (const dateEntry of data?.dates ?? []) {
      allGames.push(...(dateEntry?.games ?? []));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalizedGames = assignUniqueScheduleGameIds(allGames.map((g: any) => normalizeGame(g)));

    logger.info({ count: normalizedGames.length }, "MODULE_01: Schedule fetched");

    return {
      retrieval_timestamp_utc: new Date().toISOString(),
      date: dateStr,
      total_games: normalizedGames.length,
      games: normalizedGames,
      status: "success",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_01: Failed");
    return {
      retrieval_timestamp_utc: new Date().toISOString(),
      date: dateStr,
      total_games: 0,
      games: [],
      status: "failed",
      error: message,
    };
  }
}
