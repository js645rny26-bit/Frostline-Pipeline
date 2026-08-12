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
function key(value: unknown): string {
  return value == null ? "" : String(value).trim();
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
