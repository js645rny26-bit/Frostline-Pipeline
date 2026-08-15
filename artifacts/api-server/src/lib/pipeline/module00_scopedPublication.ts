/**
 * Per-game publication scope for staggered slates.
 *
 * Rows belonging to games that have reached first pitch (or whose first-pitch
 * time is unavailable) are carried forward from the workbook verbatim. Only
 * rows for mutable, still-pregame games are replaced.
 */

export interface PublicationProtection {
  expected_game_ids: string[];
  protected_game_ids: ReadonlySet<string>;
  protected_team_abbrs: ReadonlySet<string>;
}

export interface PublicationGameIdentity {
  legacy_game_id: string;
  scheduled_utc_time: string | null;
  away_team?: { team_abbr?: string | null };
  home_team?: { team_abbr?: string | null };
}

/**
 * Rebuild protection immediately before a write stage. The guard window keeps
 * a game immutable when first pitch is too close for the pending Sheets write
 * to complete safely. This is deliberately conservative: a skipped refresh is
 * recoverable; a post-first-pitch mutation is not.
 */
export function buildPublicationProtection(
  games: readonly PublicationGameIdentity[],
  checkedAt: string,
  guardWindowMs = 0,
): PublicationProtection {
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error(`PUBLICATION_PROTECTION_INVALID_CLOCK: ${checkedAt}`);
  }
  const nonNegativeGuardMs = Math.max(0, guardWindowMs);
  const protectedGameIds = new Set<string>();
  const protectedTeamAbbrs = new Set<string>();

  for (const game of games) {
    const firstPitchMs = Date.parse(game.scheduled_utc_time ?? "");
    if (!Number.isFinite(firstPitchMs) || firstPitchMs <= checkedAtMs + nonNegativeGuardMs) {
      protectedGameIds.add(game.legacy_game_id);
      const away = game.away_team?.team_abbr;
      const home = game.home_team?.team_abbr;
      if (away) protectedTeamAbbrs.add(away);
      if (home) protectedTeamAbbrs.add(home);
    }
  }

  return {
    expected_game_ids: games.map((game) => game.legacy_game_id),
    protected_game_ids: protectedGameIds,
    protected_team_abbrs: protectedTeamAbbrs,
  };
}

function key(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/**
 * Resolve physical worksheet row numbers by stable identity rather than by
 * schedule position. A protected game may legitimately have no preserved row;
 * in that case the remaining rows compact upward and schedule ordinals are no
 * longer valid worksheet addresses.
 */
export function buildSheetRowNumberMap(
  rows: readonly unknown[][],
  keyColumn: number,
  firstDataRow = 2,
): Map<string, number> {
  const rowNumbers = new Map<string, number>();
  rows.forEach((row, index) => {
    const rowKey = key(row[keyColumn]);
    if (!rowKey) return;
    if (rowNumbers.has(rowKey)) {
      throw new Error(`DUPLICATE_PUBLICATION_KEY: ${rowKey}`);
    }
    rowNumbers.set(rowKey, firstDataRow + index);
  });
  return rowNumbers;
}

/**
 * Merge a replace-style table without recomputing protected rows.
 * Existing protected rows are copied byte-for-byte; incoming protected rows
 * are discarded. Rows are ordered by the supplied key order when present.
 */
export function mergeProtectedRows(
  existingRows: unknown[][],
  incomingRows: unknown[][],
  keyColumn: number,
  protectedKeys: ReadonlySet<string>,
  orderedKeys: readonly string[] = [],
): unknown[][] {
  const protectedRows = existingRows
    .filter((row) => protectedKeys.has(key(row[keyColumn])))
    .map((row) => [...row]);
  const mutableRows = incomingRows
    .filter((row) => !protectedKeys.has(key(row[keyColumn])))
    .map((row) => [...row]);
  const combined = [...protectedRows, ...mutableRows];

  if (orderedKeys.length === 0) return combined;
  const order = new Map(orderedKeys.map((value, index) => [value, index]));
  return combined
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ai = order.get(key(a.row[keyColumn])) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(key(b.row[keyColumn])) ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.index - b.index : ai - bi;
    })
    .map(({ row }) => row);
}
