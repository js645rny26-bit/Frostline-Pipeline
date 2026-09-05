/**
 * Full-game total market-line normalization.
 *
 * Frostline's executable full-game total convention is Hard Rock's
 * half-number board. A source that reports an integer total is therefore
 * normalized to the immediately lower half number (10 -> 9.5, 7 -> 6.5).
 * We never round a non-half fractional source value: it is not an executable
 * Hard Rock total and must be treated as unavailable rather than invented.
 *
 * This is market representation only. It must not be imported by or affect
 * price-blind projection math.
 */

const HALF_NUMBER_EPSILON = 1e-8;

export type FullGameTotalNormalizationStatus =
  | "ALREADY_HALF_NUMBER"
  | "INTEGER_TO_LOWER_HALF"
  | "UNSUPPORTED_OR_MISSING";

export interface FullGameTotalNormalization {
  normalized_total: number | null;
  status: FullGameTotalNormalizationStatus;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Returns an executable Hard Rock full-game total. Integer inputs move down
 * one half-run; existing half-number inputs are preserved; all other inputs
 * fail closed.
 */
export function describeFullGameTotalNormalization(value: unknown): FullGameTotalNormalization {
  const parsed = numeric(value);
  if (parsed === null || parsed <= 0) {
    return { normalized_total: null, status: "UNSUPPORTED_OR_MISSING" };
  }
  const halfSteps = Math.round(parsed * 2);
  if (Math.abs(parsed * 2 - halfSteps) > HALF_NUMBER_EPSILON) {
    return { normalized_total: null, status: "UNSUPPORTED_OR_MISSING" };
  }
  const normalized = halfSteps % 2 === 0
    ? (halfSteps - 1) / 2
    : halfSteps / 2;
  return {
    normalized_total: Number(normalized.toFixed(1)),
    status: halfSteps % 2 === 0 ? "INTEGER_TO_LOWER_HALF" : "ALREADY_HALF_NUMBER",
  };
}

export function normalizeFullGameTotalLine(value: unknown): number | null {
  return describeFullGameTotalNormalization(value).normalized_total;
}

/** True only for an already-valid positive half-number total. */
export function isHalfNumberFullGameTotal(value: unknown): boolean {
  const parsed = numeric(value);
  return parsed !== null
    && parsed > 0
    && Math.abs((parsed % 1) - 0.5) <= HALF_NUMBER_EPSILON;
}

function formatLine(line: number): string {
  return line.toFixed(1);
}

/**
 * Normalizes a user-entered Hard Rock total ladder without changing its
 * delimiters or directional labels. Unsupported fractional values remain
 * visible and will be rejected by the existing half-number settlement parser.
 */
export function normalizeHardRockTotalLineList(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.split(/([;,|])/).map((part) => {
    if (/^[;,|]$/.test(part)) return part;
    const match = part.match(/\d+(?:\.\d+)?/);
    if (!match) return part;
    const normalized = normalizeFullGameTotalLine(match[0]);
    return normalized === null
      ? part
      : part.replace(match[0], formatLine(normalized));
  }).join("");
}

/** Normalizes the numeric threshold inside a manual total vehicle label. */
export function normalizeFullGameTotalVehicle(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return raw;
  const normalized = normalizeFullGameTotalLine(match[0]);
  return normalized === null ? raw : raw.replace(match[0], formatLine(normalized));
}
