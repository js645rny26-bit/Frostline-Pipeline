/**
 * Module 05b: Market Odds
 * Fetches MLB game totals (over/under lines) from The Odds API.
 * Requires ODDS_API_KEY env var. Gracefully returns an empty map if the
 * key is missing so the rest of the pipeline continues without lines.
 *
 * API docs: https://the-odds-api.com/liveapi/guides/v4/
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { normalizeFullGameTotalLine } from "./marketLineNormalization.js";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Build full_name → abbr reverse lookup once at module load
const FULL_NAME_TO_ABBR: Record<string, string> = {};
for (const { canonical_abbr, full_name } of Object.values(SOURCE_MAPPINGS)) {
  FULL_NAME_TO_ABBR[full_name.toLowerCase()] = canonical_abbr;
}

export interface MarketLine {
  game_id: string;           // legacy_game_id e.g. "20260723_SDP_ATL"
  away_abbr: string;
  home_abbr: string;
  total: number;             // consensus over/under point (e.g. 8.5)
  over_odds: number;         // American odds e.g. -110
  under_odds: number;
  bookmaker: string;         // source bookmaker used for the line
  market_available: boolean;
  // ── Run-line (spread) data — null when no spreads market available ──
  away_spread: number | null;       // point for away team (+1.5 = underdog, -1.5 = favourite)
  away_spread_odds: number | null;  // American odds for away team to cover the spread
  home_spread_odds: number | null;  // American odds for home team to cover the spread
  // ── Moneyline (h2h) data — null when no h2h market available ──
  away_ml: number | null;           // American moneyline for away team to win outright
  home_ml: number | null;           // American moneyline for home team to win outright
}

export interface OddsResult {
  status: "success" | "no_key" | "error";
  date: string;
  lines: MarketLine[];
  requests_remaining: number | null;
  error?: string;
}

/** Resolve a full team name from The Odds API to our 2–3 letter abbreviation */
function resolveAbbr(fullName: string): string | null {
  return FULL_NAME_TO_ABBR[fullName.toLowerCase()] ?? null;
}

/** Build a legacy_game_id from a date string and two abbreviations */
function buildGameId(dateStr: string, awayAbbr: string, homeAbbr: string): string {
  return `${dateStr.replace(/-/g, "")}_${awayAbbr}_${homeAbbr}`;
}

/**
 * Pick a consensus total from a list of bookmaker totals by taking
 * the most-common point value (mode), falling back to median.
 */
function consensusTotal(points: number[]): number {
  if (points.length === 0) return 0;
  const freq = new Map<number, number>();
  for (const p of points) freq.set(p, (freq.get(p) ?? 0) + 1);
  const bestCount = Math.max(...freq.values());
  const modes = [...freq.entries()].filter(([, c]) => c === bestCount).map(([pt]) => pt);
  if (modes.length === 1) return modes[0]!;
  // Tie between equally common totals — fall back to the median posted total.
  // Lower-middle element on even counts, so the result is always a line some
  // book actually posted (never an averaged x.25 that no book offers).
  const sorted = [...points].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export async function fetchMarketOdds(date: string): Promise<OddsResult> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    logger.warn("MODULE_05b: ODDS_API_KEY not set — skipping market lines");
    return { status: "no_key", date, lines: [], requests_remaining: null };
  }

  // The Odds API uses UTC; filter to the target date window
  const from = `${date}T00:00:00Z`;
  const to   = `${date}T23:59:59Z`;

  const qs = new URLSearchParams({
    apiKey,
    regions:            "us",
    markets:            "h2h,totals,spreads",
    oddsFormat:         "american",
    dateFormat:         "iso",
    commenceTimeFrom:   from,
    commenceTimeTo:     to,
  });

  const url = `${ODDS_API_BASE}/sports/baseball_mlb/odds?${qs.toString()}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const remaining = response.headers.get("x-requests-remaining");

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Odds API HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const games = (await response.json()) as Array<{
      id: string;
      home_team: string;
      away_team: string;
      commence_time: string;
      bookmakers: Array<{
        key: string;
        title: string;
        markets: Array<{
          key: string;
          // point is present for totals/spreads but absent for h2h (moneyline)
          outcomes: Array<{ name: string; point?: number; price: number }>;
        }>;
      }>;
    }>;

    const lines: MarketLine[] = [];

    for (const game of games) {
      const awayAbbr = resolveAbbr(game.away_team);
      const homeAbbr = resolveAbbr(game.home_team);
      if (!awayAbbr || !homeAbbr) {
        logger.warn({ away: game.away_team, home: game.home_team }, "MODULE_05b: Could not resolve team abbreviation");
        continue;
      }

      const gameId = buildGameId(date, awayAbbr, homeAbbr);

      // Gather totals, spreads, and moneylines across all bookmakers
      const overPoints:      number[] = [];
      const overOdds:        number[] = [];
      const underOdds:       number[] = [];
      const awaySpreadPts:   number[] = [];
      const awaySpreadPrices: number[] = [];
      const homeSpreadPrices: number[] = [];
      const awayMLPrices:    number[] = [];
      const homeMLPrices:    number[] = [];
      let topBookmaker = "";

      for (const bk of game.bookmakers) {
        // ── Totals (game over/under) ──
        const totalsMarket = bk.markets.find((m) => m.key === "totals");
        if (totalsMarket) {
          const over  = totalsMarket.outcomes.find((o) => o.name === "Over");
          const under = totalsMarket.outcomes.find((o) => o.name === "Under");
          if (over && under && over.point !== undefined) {
            overPoints.push(over.point);
            overOdds.push(over.price);
            underOdds.push(under.price);
            if (!topBookmaker) topBookmaker = bk.title;
          }
        }

        // ── Spreads (run line, typically ±1.5) ──
        const spreadsMarket = bk.markets.find((m) => m.key === "spreads");
        if (spreadsMarket) {
          const awayOut = spreadsMarket.outcomes.find((o) => o.name === game.away_team);
          const homeOut = spreadsMarket.outcomes.find((o) => o.name === game.home_team);
          if (awayOut && homeOut && awayOut.point !== undefined) {
            awaySpreadPts.push(awayOut.point);
            awaySpreadPrices.push(awayOut.price);
            homeSpreadPrices.push(homeOut.price);
          }
        }

        // ── Moneyline (head-to-head outright) ──
        const h2hMarket = bk.markets.find((m) => m.key === "h2h");
        if (h2hMarket) {
          const awayOut = h2hMarket.outcomes.find((o) => o.name === game.away_team);
          const homeOut = h2hMarket.outcomes.find((o) => o.name === game.home_team);
          if (awayOut && homeOut) {
            awayMLPrices.push(awayOut.price);
            homeMLPrices.push(homeOut.price);
          }
        }
      }

      if (overPoints.length === 0) continue; // no totals market for this game — skip entirely

      const avg = (arr: number[]) =>
        arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

      const sourceTotal = consensusTotal(overPoints);
      const total = normalizeFullGameTotalLine(sourceTotal);
      if (total === null) {
        logger.warn(
          { gameId, sourceTotal },
          "MODULE_05b: Unsupported non-half full-game total rejected",
        );
        continue;
      }
      const avgOver  = Math.round(overOdds.reduce((a, b) => a + b, 0) / overOdds.length);
      const avgUnder = Math.round(underOdds.reduce((a, b) => a + b, 0) / underOdds.length);

      lines.push({
        game_id:          gameId,
        away_abbr:        awayAbbr,
        home_abbr:        homeAbbr,
        total,
        over_odds:        avgOver,
        under_odds:       avgUnder,
        bookmaker:        topBookmaker,
        market_available: true,
        away_spread:      awaySpreadPts.length > 0 ? consensusTotal(awaySpreadPts) : null,
        away_spread_odds: avg(awaySpreadPrices),
        home_spread_odds: avg(homeSpreadPrices),
        away_ml:          avg(awayMLPrices),
        home_ml:          avg(homeMLPrices),
      });
    }

    logger.info({ date, lines: lines.length, remaining }, "MODULE_05b: Market odds fetched");
    return {
      status: "success",
      date,
      lines,
      requests_remaining: remaining !== null ? parseInt(remaining, 10) : null,
    };

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MODULE_05b: Odds fetch failed");
    return { status: "error", date, lines: [], requests_remaining: null, error: message };
  }
}

/** Build a lookup map: legacy_game_id → MarketLine */
export function buildOddsMap(result: OddsResult): Map<string, MarketLine> {
  return new Map(result.lines.map((l) => [l.game_id, l]));
}
