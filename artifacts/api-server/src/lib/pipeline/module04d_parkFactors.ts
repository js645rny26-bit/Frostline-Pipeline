/**
 * Module 04d: 2026 Seasonal Park Factors (Static Baseline)
 *
 * Source: Multi-year (2023-2025) MLB park factor consensus, venue-adjusted for
 * 2026 playing conditions (Oakland → Sacramento, Houston Daikin Park rename).
 * Values are integer percentages vs. league average (e.g. +17 = 17% more runs).
 *
 * These are stable seasonal constants — appropriate for:
 *   - Historical replay where mlbstartingnine.com cannot supply historical data
 *   - Live-day fallback when the live scrape hasn't resolved all venues yet
 *
 * Key: canonical team abbreviation (home team = venue owner).
 * runs_pct drives module09's park_multiplier; hr/woba pcts are stored for
 * reference but not currently consumed by the projection formula.
 *
 * References: Baseball Reference Park Factors 2023-2025, Statcast park data.
 */

import type { ParkFactors } from "./module04c_startingNine.js";

/**
 * 2026 seasonal park factors for all 30 MLB home venues.
 * runs_pct: signed integer %, positive = hitter-friendly.
 * hr_l_pct / hr_r_pct: LHB / RHB HR %, asymmetric for quirky parks.
 * woba_l_pct / woba_r_pct: overall wOBA %, left/right batter split.
 */
export const SEASONAL_PARK_FACTORS_2026: Record<string, ParkFactors> = {
  // ── American League East ──────────────────────────────────────────────────
  NYY: { runs_pct:  3, hr_l_pct: +14, hr_r_pct:  -1, woba_l_pct:  4, woba_r_pct:  2 },  // Yankee Stadium — short RF porch
  BAL: { runs_pct:  1, hr_l_pct:  +2, hr_r_pct:  +2, woba_l_pct:  1, woba_r_pct:  1 },  // Oriole Park at Camden Yards
  TOR: { runs_pct:  0, hr_l_pct:  +1, hr_r_pct:  +1, woba_l_pct:  0, woba_r_pct:  0 },  // Rogers Centre
  BOS: { runs_pct:  4, hr_l_pct:  -4, hr_r_pct:  +9, woba_l_pct:  3, woba_r_pct:  5 },  // Fenway Park — Green Monster/Pesky Pole asymmetry
  TBR: { runs_pct: -3, hr_l_pct:  -5, hr_r_pct:  -5, woba_l_pct: -2, woba_r_pct: -2 },  // Tropicana Field

  // ── American League Central ──────────────────────────────────────────────
  MIN: { runs_pct: -1, hr_l_pct:  -2, hr_r_pct:  -2, woba_l_pct: -1, woba_r_pct: -1 },  // Target Field
  DET: { runs_pct: -2, hr_l_pct:  -4, hr_r_pct:  -3, woba_l_pct: -1, woba_r_pct: -1 },  // Comerica Park
  KCR: { runs_pct:  2, hr_l_pct:  +3, hr_r_pct:  +3, woba_l_pct:  1, woba_r_pct:  1 },  // Kauffman Stadium
  CHW: { runs_pct: -1, hr_l_pct:  -1, hr_r_pct:  -1, woba_l_pct: -1, woba_r_pct: -1 },  // Guaranteed Rate Field
  CLE: { runs_pct: -1, hr_l_pct:  -2, hr_r_pct:  -2, woba_l_pct: -1, woba_r_pct: -1 },  // Progressive Field

  // ── American League West ─────────────────────────────────────────────────
  HOU: { runs_pct:  2, hr_l_pct:  +4, hr_r_pct:  +3, woba_l_pct:  1, woba_r_pct:  1 },  // Minute Maid / Daikin Park
  OAK: { runs_pct: -2, hr_l_pct:  -3, hr_r_pct:  -3, woba_l_pct: -1, woba_r_pct: -1 },  // Sutter Health Park (Sacramento, since 2025)
  SEA: { runs_pct: -4, hr_l_pct:  -7, hr_r_pct:  -7, woba_l_pct: -2, woba_r_pct: -2 },  // T-Mobile Park
  TEX: { runs_pct:  5, hr_l_pct:  +9, hr_r_pct:  +9, woba_l_pct:  3, woba_r_pct:  3 },  // Globe Life Field
  LAA: { runs_pct:  0, hr_l_pct:   0, hr_r_pct:   0, woba_l_pct:  0, woba_r_pct:  0 },  // Angel Stadium

  // ── National League East ─────────────────────────────────────────────────
  ATL: { runs_pct:  0, hr_l_pct:  +1, hr_r_pct:  +1, woba_l_pct:  0, woba_r_pct:  0 },  // Truist Park
  MIA: { runs_pct: -6, hr_l_pct: -10, hr_r_pct: -10, woba_l_pct: -4, woba_r_pct: -4 },  // loanDepot Park — strong pitcher's park
  NYM: { runs_pct: -3, hr_l_pct:  -5, hr_r_pct:  -5, woba_l_pct: -2, woba_r_pct: -2 },  // Citi Field
  PHI: { runs_pct:  0, hr_l_pct:  +1, hr_r_pct:  +1, woba_l_pct:  0, woba_r_pct:  0 },  // Citizens Bank Park
  WSN: { runs_pct: -2, hr_l_pct:  -3, hr_r_pct:  -3, woba_l_pct: -1, woba_r_pct: -1 },  // Nationals Park

  // ── National League Central ──────────────────────────────────────────────
  CHC: { runs_pct:  3, hr_l_pct:  +4, hr_r_pct:  +5, woba_l_pct:  2, woba_r_pct:  2 },  // Wrigley Field — net hitter after wind adjustment
  CIN: { runs_pct:  5, hr_l_pct: +10, hr_r_pct: +10, woba_l_pct:  3, woba_r_pct:  3 },  // Great American Ball Park
  MIL: { runs_pct:  1, hr_l_pct:  +2, hr_r_pct:  +2, woba_l_pct:  1, woba_r_pct:  1 },  // American Family Field
  PIT: { runs_pct: -1, hr_l_pct:  -2, hr_r_pct:  -2, woba_l_pct: -1, woba_r_pct: -1 },  // PNC Park
  STL: { runs_pct: -3, hr_l_pct:  -5, hr_r_pct:  -5, woba_l_pct: -2, woba_r_pct: -2 },  // Busch Stadium

  // ── National League West ─────────────────────────────────────────────────
  LAD: { runs_pct: -2, hr_l_pct:  -3, hr_r_pct:  -3, woba_l_pct: -1, woba_r_pct: -1 },  // Dodger Stadium
  SDP: { runs_pct: -5, hr_l_pct:  -9, hr_r_pct:  -9, woba_l_pct: -3, woba_r_pct: -3 },  // Petco Park
  COL: { runs_pct: 17, hr_l_pct: +28, hr_r_pct: +27, woba_l_pct: 10, woba_r_pct:  9 },  // Coors Field — altitude extreme
  ARI: { runs_pct:  7, hr_l_pct: +12, hr_r_pct: +12, woba_l_pct:  4, woba_r_pct:  4 },  // Chase Field
  SFG: { runs_pct: -4, hr_l_pct:  -7, hr_r_pct:  -7, woba_l_pct: -2, woba_r_pct: -2 },  // Oracle Park — cold, marine layer
};

/**
 * Returns the 2026 seasonal park factor for a home team's venue, or null if
 * the abbreviation is not recognized.
 */
export function getSeasonalParkFactor(homeAbbr: string): ParkFactors | null {
  return SEASONAL_PARK_FACTORS_2026[homeAbbr] ?? null;
}
