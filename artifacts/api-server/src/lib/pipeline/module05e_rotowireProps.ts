/**
 * Module 05e: Rotowire Player Props Scraper
 *
 * Fetches the Rotowire MLB player-props page (server-rendered HTML containing
 * inline JSON blobs) and extracts Hard Rock lines for:
 *   • Pitcher strikeouts (K line)
 *   • Pitcher earned runs (ER line)
 *   • Batter total bases (TB line)
 *
 * SHADOW MODE — this module produces informational comparison signals only.
 * It must not influence CORE authorization until historical validation is complete.
 *
 * Data contract:
 *   - Prop market data is classified as market evidence, not baseball truth.
 *   - A high K line does not automatically confirm an UNDER.
 *   - ER lines are the most directly relevant signal, but do not account for
 *     bullpen, unearned runs, or opener/bulk ambiguity.
 *   - Total-base lines are not additive team-run forecasts.
 */

import { logger } from "../../lib/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlayerPropRow {
  gameID: string;
  firstName: string;
  lastName: string;
  name: string;       // "FirstName LastName" — matches pitcher names in GameSummaryRow
  team: string;       // normalized 2–3 letter abbr matching MLB Stats API
  opp: string;
  line: number | null;
  underOdds: number | null;
  overOdds: number | null;
}

export interface RotowirePropsResult {
  status: "success" | "failure";
  snapshot_ts: string;        // ISO 8601 UTC — when the page was fetched
  strikeouts: PlayerPropRow[];
  earned_runs: PlayerPropRow[];
  total_bases: PlayerPropRow[];
  error?: string;
}

export type PropAgreement = "AGREES" | "MIXED" | "CONTRADICTS" | "INSUFFICIENT_COVERAGE";

export interface PropComparisonSignals {
  /** Compact display: "7.5 (U:-145/O:+110) | 6.5 (U:-120/O:-110)" */
  starter_k_market_signal: string;
  /** Compact display: "2.5 (U:-115/O:-115) | 2.5 (U:-155/O:+120)" */
  starter_er_market_signal: string;
  /** Percent of 18 lineup slots (9 per team × 2) with a posted TB line. null = no data. */
  lineup_tb_coverage_pct: number | null;
  /** Direction implied by ER odds — not used for CORE gating. */
  prop_market_direction: "OVER" | "UNDER" | "MIXED" | "INSUFFICIENT_COVERAGE";
  /** How the prop market direction compares to Frostline's direction. */
  prop_market_agreement: PropAgreement;
  /** Human-readable reason when agreement is CONTRADICTS or MIXED. Empty otherwise. */
  prop_market_disagreement_reason: string;
  /** ISO 8601 UTC timestamp of the props snapshot. */
  prop_snapshot_ts: string;
}

// ─── Team abbreviation normalization ─────────────────────────────────────────
// Rotowire and MLB Stats API use slightly different codes in some cases.
// Normalise to the MLB Stats API canonical form.

const TEAM_NORM_MAP: Record<string, string> = {
  WAS: "WSH",   // Nationals (Rotowire uses WAS; MLB API uses WSH)
  KCR: "KC",    // Royals alternate
  TBR: "TB",    // Rays alternate
  SDP: "SD",    // Padres alternate
  SFG: "SF",    // Giants alternate
  OAK: "ATH",   // Athletics (relocated to Sacramento)
  SAC: "ATH",   // Athletics Sacramento alternate
};

function normalizeTeam(abbr: string): string {
  return TEAM_NORM_MAP[abbr] ?? abbr;
}

// ─── Inline JSON extraction ───────────────────────────────────────────────────

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

/**
 * Locates and parses one of the inline JSON arrays embedded in the Rotowire
 * player-props page. Each prop section contains an array of player rows;
 * the array is identified by searching for the first occurrence of the
 * Hard Rock field key, then walking backwards/forwards to extract the
 * enclosing JSON array.
 *
 * @param html  Full HTML string from the Rotowire props page
 * @param hrKey The Hard Rock prop key name, e.g. "strikeouts", "er", "bases"
 */
function extractPropSection(html: string, hrKey: string): PlayerPropRow[] {
  const searchStr = `"hardrock_${hrKey}"`;
  const hitIdx = html.indexOf(searchStr);
  if (hitIdx === -1) {
    logger.debug({ hrKey }, "MODULE_05e: Hard Rock key not found in HTML — prop section absent");
    return [];
  }

  // Walk backwards from hit to find the opening '[' of the enclosing array
  let arrStart = hitIdx;
  while (arrStart > 0 && html[arrStart] !== "[") arrStart--;
  if (arrStart <= 0) return [];

  // Walk forward matching bracket depth to find the closing ']'
  let depth = 0;
  let j = arrStart;
  while (j < html.length) {
    if (html[j] === "[") depth++;
    else if (html[j] === "]") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }

  let rawArr: unknown[];
  try {
    rawArr = JSON.parse(html.slice(arrStart, j + 1)) as unknown[];
  } catch (err) {
    logger.warn({ hrKey, err: err instanceof Error ? err.message : String(err) }, "MODULE_05e: Failed to parse prop section JSON");
    return [];
  }

  return rawArr
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const firstName = String(item.firstName ?? "");
      const lastName = String(item.lastName ?? "");
      return {
        gameID:    String(item.gameID ?? ""),
        firstName,
        lastName,
        name:      String(item.name ?? `${firstName} ${lastName}`).trim(),
        team:      normalizeTeam(String(item.team ?? "")),
        opp:       String(item.opp ?? ""),
        line:      parseNum(item[`hardrock_${hrKey}`]),
        underOdds: parseNum(item[`hardrock_${hrKey}Under`]),
        overOdds:  parseNum(item[`hardrock_${hrKey}Over`]),
      };
    });
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

const ROTOWIRE_URL = "https://www.rotowire.com/betting/mlb/player-props.php?book=hardrock";

/**
 * Fetches the Rotowire MLB player-props page and extracts Hard Rock lines for
 * strikeouts, earned runs, and total bases.
 *
 * Returns an empty-array result (status: "success") when the page loads but
 * a particular prop section is absent (e.g., no ER lines posted yet).
 *
 * Returns status: "failure" only when the HTTP fetch itself fails.
 */
export async function fetchRotowireProps(): Promise<RotowirePropsResult> {
  const snapshot_ts = new Date().toISOString();
  logger.info("MODULE_05e: Fetching Rotowire player props");

  let html: string;
  try {
    const res = await fetch(ROTOWIRE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    html = await res.text();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "MODULE_05e: HTTP fetch failed");
    return { status: "failure", snapshot_ts, strikeouts: [], earned_runs: [], total_bases: [], error: message };
  }

  const strikeouts  = extractPropSection(html, "strikeouts");
  const earned_runs = extractPropSection(html, "er");
  const total_bases = extractPropSection(html, "bases");

  logger.info(
    { strikeouts: strikeouts.length, earned_runs: earned_runs.length, total_bases: total_bases.length },
    "MODULE_05e: Rotowire props fetched",
  );

  return { status: "success", snapshot_ts, strikeouts, earned_runs, total_bases };
}

// ─── Comparison signal computation ───────────────────────────────────────────

/**
 * Formats a single prop line for compact display in a Sheets cell.
 * Example: "7.5 (U:-145/O:+110)"
 */
function fmtLine(row: PlayerPropRow | undefined): string {
  if (!row || row.line === null) return "—";
  const u = row.underOdds !== null ? `U:${row.underOdds > 0 ? "+" : ""}${row.underOdds}` : "";
  const o = row.overOdds  !== null ? `O:${row.overOdds  > 0 ? "+" : ""}${row.overOdds}`  : "";
  const odds = [u, o].filter(Boolean).join("/");
  return odds ? `${row.line} (${odds})` : String(row.line);
}

/**
 * Derives a directional signal from a single ER row's odds.
 * Returns "UNDER" when the under is priced more expensively (more negative),
 * "OVER" when the over is, or "MIXED" when the spread is within 10 pts.
 */
function erDirection(row: PlayerPropRow | undefined): "OVER" | "UNDER" | "MIXED" | null {
  if (!row || row.underOdds === null || row.overOdds === null) return null;
  const spread = row.underOdds - row.overOdds; // under more -ve → spread < 0 → UNDER implied
  if (spread < -10) return "UNDER";
  if (spread > 10)  return "OVER";
  return "MIXED";
}

/**
 * Computes the seven comparison-signal fields for a single game.
 *
 * @param awayTeam          MLB Stats API team abbreviation for the away team
 * @param homeTeam          MLB Stats API team abbreviation for the home team
 * @param awayPitcherName   Full name from GameSummaryRow (e.g. "Chris Sale")
 * @param homePitcherName   Full name from GameSummaryRow
 * @param frostlineDirection OVER | UNDER | NONE — from module11 computeDecision
 * @param propsResult       RotowirePropsResult — may contain empty arrays
 */
export function computePropComparison(
  awayTeam: string,
  homeTeam: string,
  awayPitcherName: string | null,
  homePitcherName: string | null,
  frostlineDirection: "OVER" | "UNDER" | "NONE",
  propsResult: RotowirePropsResult,
): PropComparisonSignals {
  const snapshotTs = propsResult.snapshot_ts;

  // Extract last name for matching (Rotowire lastName field matches the last token of the full name)
  const awayLastName  = awayPitcherName?.split(" ").pop()?.toLowerCase() ?? null;
  const homeLastName  = homePitcherName?.split(" ").pop()?.toLowerCase() ?? null;

  // Lookup starter props by last name (safe for a single-day slate; collisions are rare)
  const findByLast = (rows: PlayerPropRow[], lastName: string | null): PlayerPropRow | undefined => {
    if (!lastName) return undefined;
    return rows.find((r) => r.lastName.toLowerCase() === lastName);
  };

  const awayK  = findByLast(propsResult.strikeouts, awayLastName);
  const homeK  = findByLast(propsResult.strikeouts, homeLastName);
  const awayER = findByLast(propsResult.earned_runs, awayLastName);
  const homeER = findByLast(propsResult.earned_runs, homeLastName);

  // ── K signal (shape comparison only — not a direction vote) ─────────────
  const awayKStr = fmtLine(awayK);
  const homeKStr = fmtLine(homeK);
  const starter_k_market_signal =
    awayK || homeK ? `${awayKStr} | ${homeKStr}` : "INSUFFICIENT_COVERAGE";

  // ── ER signal ────────────────────────────────────────────────────────────
  const awayERStr = fmtLine(awayER);
  const homeERStr = fmtLine(homeER);
  const starter_er_market_signal =
    awayER || homeER ? `${awayERStr} | ${homeERStr}` : "INSUFFICIENT_COVERAGE";

  // ── TB coverage ──────────────────────────────────────────────────────────
  const awayTeamNorm = normalizeTeam(awayTeam);
  const homeTeamNorm = normalizeTeam(homeTeam);
  const tbForGame = propsResult.total_bases.filter(
    (r) => r.team === awayTeamNorm || r.team === homeTeamNorm,
  );
  const lineup_tb_coverage_pct =
    propsResult.total_bases.length > 0
      ? parseFloat(((tbForGame.length / 18) * 100).toFixed(1))
      : null;

  // ── Prop market direction (from ER odds, not K) ──────────────────────────
  const awayDir = erDirection(awayER);
  const homeDir = erDirection(homeER);

  let prop_market_direction: PropComparisonSignals["prop_market_direction"];
  if (awayDir === null && homeDir === null) {
    prop_market_direction = "INSUFFICIENT_COVERAGE";
  } else if (awayDir === "MIXED" || homeDir === "MIXED") {
    prop_market_direction = "MIXED";
  } else if (awayDir !== null && homeDir !== null) {
    prop_market_direction = awayDir === homeDir ? awayDir : "MIXED";
  } else {
    // Only one starter has an ER line — cautiously treat as MIXED
    prop_market_direction = "MIXED";
  }

  // ── Agreement with Frostline direction ───────────────────────────────────
  let prop_market_agreement: PropAgreement;
  let prop_market_disagreement_reason = "";

  if (prop_market_direction === "INSUFFICIENT_COVERAGE") {
    prop_market_agreement = "INSUFFICIENT_COVERAGE";
  } else if (prop_market_direction === "MIXED") {
    prop_market_agreement = "MIXED";
    prop_market_disagreement_reason = "ER market signals split or inconclusive";
  } else if (frostlineDirection === "NONE") {
    prop_market_agreement = "INSUFFICIENT_COVERAGE";
    prop_market_disagreement_reason = "Frostline has no direction (no market line)";
  } else if (prop_market_direction === frostlineDirection) {
    prop_market_agreement = "AGREES";
  } else {
    prop_market_agreement = "CONTRADICTS";
    prop_market_disagreement_reason =
      `ER market implies ${prop_market_direction} ` +
      `(away ER: ${awayER?.line ?? "—"}, home ER: ${homeER?.line ?? "—"}); ` +
      `Frostline projects ${frostlineDirection}`;
  }

  return {
    starter_k_market_signal,
    starter_er_market_signal,
    lineup_tb_coverage_pct,
    prop_market_direction,
    prop_market_agreement,
    prop_market_disagreement_reason,
    prop_snapshot_ts: snapshotTs,
  };
}
