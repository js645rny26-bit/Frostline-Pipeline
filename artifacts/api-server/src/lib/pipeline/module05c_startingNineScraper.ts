/**
 * Module 05c: MLB Starting Nine — Market Line Scraper
 *
 * Primary source for game-total O/U lines. Scrapes mlbstartingnine.com,
 * which serves today's slate as server-rendered HTML with no auth required.
 * Falls back to The Odds API (module05b) if the scrape returns 0 lines or
 * encounters a network/parse error.
 *
 * Parsing strategy:
 *   • Split the HTML on `id="game-XXXXXX"` to isolate each game card.
 *   • Extract the O/U total from `<span class="badge bg-secondary ...">O/U 8.5</span>`.
 *   • Identify teams via the MLB static logo URL: `/team-cap-on-light/109.svg`
 *     — the number is the MLB Stats API team ID, which is also the key in
 *     SOURCE_MAPPINGS, giving us the canonical 2–3 letter abbreviation.
 *   • Build the legacy_game_id from the caller-supplied date + resolved abbrs.
 *   • over_odds / under_odds default to −110 (standard juice); mlbstartingnine
 *     does not expose individual book lines.
 */

import { logger } from "../../lib/logger.js";
import { SOURCE_MAPPINGS } from "./config.js";
import { fetchMarketOdds, buildOddsMap } from "./module05b_marketOdds.js";
import { normalizeFullGameTotalLine } from "./marketLineNormalization.js";
import type { OddsResult, MarketLine } from "./module05b_marketOdds.js";

export { buildOddsMap } from "./module05b_marketOdds.js";

// Build MLB team-id (number) → canonical abbreviation lookup from SOURCE_MAPPINGS.
// SOURCE_MAPPINGS keys ARE the MLB Stats API team IDs (as strings).
const TEAM_ID_TO_ABBR = new Map<number, string>(
  Object.entries(SOURCE_MAPPINGS).map(([id, { canonical_abbr }]) => [parseInt(id, 10), canonical_abbr]),
);

function buildGameId(dateStr: string, awayAbbr: string, homeAbbr: string): string {
  return `${dateStr.replace(/-/g, "")}_${awayAbbr}_${homeAbbr}`;
}

/** Fetch and parse mlbstartingnine.com for today's game totals. */
async function scrapeStartingNine(date: string): Promise<OddsResult> {
  const url = "https://mlbstartingnine.com";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let html: string;

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Frostline/1.0)" },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err; // re-throw; caller handles fallback
  }

  const lines: MarketLine[] = [];

  // Split on card boundaries. Each game card starts with the element that
  // has id="game-XXXXXX". We discard everything before the first card.
  const cardChunks = html.split(/(?=<[^>]+id="game-\d+")/).slice(1);

  for (const chunk of cardChunks) {
    // ── O/U line ──────────────────────────────────────────────────────────
    const ouMatch = chunk.match(/O\/U\s+(\d+\.?\d*)/);
    if (!ouMatch) continue;
    const sourceTotal = parseFloat(ouMatch[1]!);
    const total = normalizeFullGameTotalLine(sourceTotal);
    if (total === null) {
      logger.warn(
        { sourceTotal },
        "MODULE_05c: Unsupported non-half full-game total rejected",
      );
      continue;
    }

    // ── Team IDs from logo URLs ───────────────────────────────────────────
    // Logo pattern: /team-cap-on-light/109.svg  (first = away, second = home)
    const logoMatches = [...chunk.matchAll(/team-cap-on-light\/(\d+)\.svg/g)];
    if (logoMatches.length < 2) continue;

    const awayId = parseInt(logoMatches[0]![1]!, 10);
    const homeId = parseInt(logoMatches[1]![1]!, 10);

    const awayAbbr = TEAM_ID_TO_ABBR.get(awayId);
    const homeAbbr = TEAM_ID_TO_ABBR.get(homeId);

    if (!awayAbbr || !homeAbbr) {
      logger.warn({ awayId, homeId }, "MODULE_05c: unrecognised team logo ID — skipping card");
      continue;
    }

    const gameId = buildGameId(date, awayAbbr, homeAbbr);

    // Avoid duplicates (some cards may repeat a logo URL in a stats thumbnail)
    if (lines.some((l) => l.game_id === gameId)) continue;

    lines.push({
      game_id:          gameId,
      away_abbr:        awayAbbr,
      home_abbr:        homeAbbr,
      total,
      over_odds:        -110,
      under_odds:       -110,
      bookmaker:        "mlbstartingnine",
      market_available: true,
      // mlbstartingnine is a totals-only source; spread/ML not available here
      away_spread:      null,
      away_spread_odds: null,
      home_spread_odds: null,
      away_ml:          null,
      home_ml:          null,
    });
  }

  return { status: "success", date, lines, requests_remaining: null };
}

/**
 * Primary entry point — wraps the scraper with OddsAPI fallback.
 *
 * Resolution order:
 *   1. mlbstartingnine.com  — free, no key, server-rendered HTML
 *   2. The Odds API (module05b) — keyed, used if scrape fails or returns 0 lines
 */
export async function fetchMarketOddsWithFallback(date: string): Promise<OddsResult> {
  // ── Attempt 1: mlbstartingnine ──────────────────────────────────────────
  try {
    const result = await scrapeStartingNine(date);

    if (result.lines.length > 0) {
      logger.info(
        { date, lines: result.lines.length, source: "mlbstartingnine" },
        "MODULE_05c: Market lines from StartingNine",
      );
      return result;
    }

    // Got a response but 0 lines — could be an off-day or parse regression.
    logger.warn(
      { date },
      "MODULE_05c: StartingNine returned 0 lines — falling back to OddsAPI",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: message },
      "MODULE_05c: StartingNine scrape failed — falling back to OddsAPI",
    );
  }

  // ── Attempt 2: The Odds API ─────────────────────────────────────────────
  const fallback = await fetchMarketOdds(date);
  if (fallback.status === "success") {
    logger.info(
      { date, lines: fallback.lines.length, source: "oddsapi" },
      "MODULE_05c: Market lines from OddsAPI fallback",
    );
  }
  return fallback;
}
