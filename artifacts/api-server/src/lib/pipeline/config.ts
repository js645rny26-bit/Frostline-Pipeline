/**
 * Static config: team mappings, stadium coords, validation rules.
 * Equivalent to the Python config/ JSON files, inlined as TypeScript constants.
 */

export const SOURCE_MAPPINGS: Record<string, { canonical_abbr: string; full_name: string }> = {
  "147": { canonical_abbr: "NYY", full_name: "New York Yankees" },
  "110": { canonical_abbr: "BAL", full_name: "Baltimore Orioles" },
  "141": { canonical_abbr: "TOR", full_name: "Toronto Blue Jays" },
  "111": { canonical_abbr: "BOS", full_name: "Boston Red Sox" },
  "139": { canonical_abbr: "TBR", full_name: "Tampa Bay Rays" },
  "142": { canonical_abbr: "MIN", full_name: "Minnesota Twins" },
  "116": { canonical_abbr: "DET", full_name: "Detroit Tigers" },
  "118": { canonical_abbr: "KCR", full_name: "Kansas City Royals" },
  "145": { canonical_abbr: "CHW", full_name: "Chicago White Sox" },
  "114": { canonical_abbr: "CLE", full_name: "Cleveland Guardians" },
  "158": { canonical_abbr: "MIL", full_name: "Milwaukee Brewers" },
  "112": { canonical_abbr: "CHC", full_name: "Chicago Cubs" },
  "113": { canonical_abbr: "CIN", full_name: "Cincinnati Reds" },
  "134": { canonical_abbr: "PIT", full_name: "Pittsburgh Pirates" },
  "138": { canonical_abbr: "STL", full_name: "St. Louis Cardinals" },
  "120": { canonical_abbr: "WSN", full_name: "Washington Nationals" },
  "143": { canonical_abbr: "PHI", full_name: "Philadelphia Phillies" },
  "144": { canonical_abbr: "ATL", full_name: "Atlanta Braves" },
  "146": { canonical_abbr: "MIA", full_name: "Miami Marlins" },
  "121": { canonical_abbr: "NYM", full_name: "New York Mets" },
  "119": { canonical_abbr: "LAD", full_name: "Los Angeles Dodgers" },
  "135": { canonical_abbr: "SDP", full_name: "San Diego Padres" },
  "115": { canonical_abbr: "COL", full_name: "Colorado Rockies" },
  "109": { canonical_abbr: "ARI", full_name: "Arizona Diamondbacks" },
  "137": { canonical_abbr: "SFG", full_name: "San Francisco Giants" },
  "133": { canonical_abbr: "OAK", full_name: "Oakland Athletics" },
  "136": { canonical_abbr: "SEA", full_name: "Seattle Mariners" },
  "140": { canonical_abbr: "TEX", full_name: "Texas Rangers" },
  "108": { canonical_abbr: "LAA", full_name: "Los Angeles Angels" },
  "117": { canonical_abbr: "HOU", full_name: "Houston Astros" },
};

export const STADIUM_COORDS: Record<string, { latitude: number; longitude: number; timezone: string; elevation_ft: number }> = {
  // Elevation sources: USGS/Google Elevation API spot-checked per venue.
  // Coors Field (5280 ft) is the only outlier that materially affects ball flight.
  // All others are close to sea level or mid-elevation; update if model sensitivity warrants it.
  "Yankee Stadium":               { latitude: 40.8296,  longitude: -73.9262,  timezone: "America/New_York",    elevation_ft: 55   },
  "Oriole Park at Camden Yards":  { latitude: 39.2847,  longitude: -76.6413,  timezone: "America/New_York",    elevation_ft: 30   },
  "Rogers Centre":                { latitude: 43.6426,  longitude: -79.3957,  timezone: "America/Toronto",     elevation_ft: 287  },
  "Fenway Park":                  { latitude: 42.3467,  longitude: -71.0972,  timezone: "America/New_York",    elevation_ft: 20   },
  "Tropicana Field":              { latitude: 27.7686,  longitude: -82.6534,  timezone: "America/New_York",    elevation_ft: 15   },
  "Target Field":                 { latitude: 44.9815,  longitude: -93.2789,  timezone: "America/Chicago",     elevation_ft: 830  },
  "Comerica Park":                { latitude: 42.3391,  longitude: -83.0485,  timezone: "America/Detroit",     elevation_ft: 585  },
  "Kauffman Stadium":             { latitude: 39.0520,  longitude: -94.4803,  timezone: "America/Chicago",     elevation_ft: 1000 },
  "Guaranteed Rate Field":        { latitude: 41.8300,  longitude: -87.6337,  timezone: "America/Chicago",     elevation_ft: 595  },
  "Progressive Field":            { latitude: 41.4956,  longitude: -81.6852,  timezone: "America/New_York",    elevation_ft: 653  },
  "American Family Field":        { latitude: 43.0285,  longitude: -87.9714,  timezone: "America/Chicago",     elevation_ft: 635  },
  "Wrigley Field":                { latitude: 41.9484,  longitude: -87.6553,  timezone: "America/Chicago",     elevation_ft: 595  },
  "Great American Ball Park":     { latitude: 39.0974,  longitude: -84.5076,  timezone: "America/New_York",    elevation_ft: 490  },
  "PNC Park":                     { latitude: 40.4474,  longitude: -80.0075,  timezone: "America/New_York",    elevation_ft: 730  },
  "Busch Stadium":                { latitude: 38.6226,  longitude: -90.1928,  timezone: "America/Chicago",     elevation_ft: 465  },
  "Nationals Park":               { latitude: 38.8729,  longitude: -77.0074,  timezone: "America/New_York",    elevation_ft: 20   },
  "Citizens Bank Park":           { latitude: 39.9060,  longitude: -75.1673,  timezone: "America/New_York",    elevation_ft: 20   },
  "Truist Park":                  { latitude: 33.8908,  longitude: -84.4677,  timezone: "America/New_York",    elevation_ft: 1050 },
  "loanDepot Park":               { latitude: 25.7784,  longitude: -80.2195,  timezone: "America/New_York",    elevation_ft: 6    },
  "Citi Field":                   { latitude: 40.7571,  longitude: -73.8456,  timezone: "America/New_York",    elevation_ft: 20   },
  "Dodger Stadium":               { latitude: 34.0742,  longitude: -118.2400, timezone: "America/Los_Angeles", elevation_ft: 510  },
  "Petco Park":                   { latitude: 32.7075,  longitude: -117.1571, timezone: "America/Los_Angeles", elevation_ft: 20   },
  "Coors Field":                  { latitude: 39.7560,  longitude: -104.9942, timezone: "America/Denver",      elevation_ft: 5280 },
  "Chase Field":                  { latitude: 33.4454,  longitude: -112.0667, timezone: "America/Phoenix",     elevation_ft: 1100 },
  "Oracle Park":                  { latitude: 37.7786,  longitude: -122.3893, timezone: "America/Los_Angeles", elevation_ft: 10   },
  "Oakland Coliseum":             { latitude: 37.7516,  longitude: -122.2008, timezone: "America/Los_Angeles", elevation_ft: 25   },
  "Sacramento's Sutter Health Park": { latitude: 38.5808, longitude: -121.5003, timezone: "America/Los_Angeles", elevation_ft: 25 },
  "T-Mobile Park":                { latitude: 47.5912,  longitude: -122.3320, timezone: "America/Los_Angeles", elevation_ft: 20   },
  "Globe Life Field":             { latitude: 32.7456,  longitude: -97.0832,  timezone: "America/Chicago",     elevation_ft: 551  },
  "Angel Stadium":                { latitude: 33.8003,  longitude: -117.8827, timezone: "America/Los_Angeles", elevation_ft: 160  },
  "Minute Maid Park":             { latitude: 29.7571,  longitude: -95.3555,  timezone: "America/Chicago",     elevation_ft: 40   },
};

/**
 * Venue name aliases — maps alternate names returned by the MLB Stats API
 * to the canonical keys used in STADIUM_COORDS above.
 * Add entries here whenever a new variant is observed in pipeline logs.
 */
export const VENUE_ALIASES: Record<string, string> = {
  // Oakland Athletics — moved to Sacramento in 2025
  "Sutter Health Park":                  "Sacramento's Sutter Health Park",
  "Sutter Health Park (Sacramento)":     "Sacramento's Sutter Health Park",
  // Houston Astros — renamed Minute Maid Park → Daikin Park in 2025
  "Daikin Park":                         "Minute Maid Park",
  // Common MLB API alternate spellings
  "loanDepot park":                      "loanDepot Park",
  "loandepot park":                      "loanDepot Park",
  "LoanDepot Park":                      "loanDepot Park",
  "Loan Depot Park":                     "loanDepot Park",
  "American Family Fields of Phoenix":   "American Family Field",  // spring training overflow
  "Guaranteed Rate Field ":              "Guaranteed Rate Field",  // trailing-space variant
  "PNC Park ":                           "PNC Park",
  "Citi Field ":                         "Citi Field",
  "Yankee Stadium ":                     "Yankee Stadium",
  "Oriole Park":                         "Oriole Park at Camden Yards",
  "Camden Yards":                        "Oriole Park at Camden Yards",
};

/** Resolve a venue name from the MLB API to the STADIUM_COORDS key. */
export function resolveVenueName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (STADIUM_COORDS[trimmed]) return trimmed;
  const aliased = VENUE_ALIASES[trimmed];
  if (aliased && STADIUM_COORDS[aliased]) return aliased;
  // Case-insensitive fallback
  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(STADIUM_COORDS)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

export const VALIDATION_RULES = {
  game_count: { min_expected: 13, max_expected: 16 },
  pitcher_role_categories: [
    "CONVENTIONAL_STARTER", "OPENER", "BULK", "PIGGYBACK_PRIMARY",
    "PIGGYBACK_SECONDARY", "RELIEF_ARM_LISTED_AS_STARTER", "BULLPEN_GAME", "UNRESOLVED",
  ],
  workload_flags: [
    "RESTRICTED_WORKLOAD", "RETURNING_FROM_IL", "REHAB_RETURN",
    "REPORTED_PITCH_LIMIT", "SHORT_REST", "ROLE_CHANGE",
  ],
};

/**
 * Hours before the earliest first pitch of the slate at which the board locks.
 * After the lock cutoff, no new CORE authorizations are issued for games that
 * were not already CORE at the moment the lock fired.  Existing CORE picks may
 * still be downgraded if a disqualifying signal arrives (starter scratch, etc.).
 */
export const BOARD_LOCK_HOURS_BEFORE_FIRST_PITCH = 2.0;

export function getTodayDateStr(): string {
  // Use America/New_York (ET) so the date matches the MLB schedule calendar.
  // UTC would roll to the next day after 20:00 ET, fetching tomorrow's games.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function celsiusToFahrenheit(c: number | null): number | null {
  if (c === null || c === undefined) return null;
  return Math.round(((c * 9) / 5 + 32) * 10) / 10;
}

export function kmhToMph(kmh: number | null): number | null {
  if (kmh === null || kmh === undefined) return null;
  return Math.round(kmh * 0.621371 * 10) / 10;
}
