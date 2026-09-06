/**
 * Full-game total market-line normalization.
 *
 * A normalized lower-half line is a synthetic display/mechanical convention,
 * not an economically equivalent market. A source that reports an integer
 * total may be represented as the immediately lower half number (10 -> 9.5,
 * 7 -> 6.5) only where a caller explicitly needs that synthetic convention.
 * The literal source total remains the authoritative reference market for
 * provenance and grading: whole numbers retain push mass.
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

export type LiteralFullGameTotalConvention =
  | "WHOLE_NUMBER"
  | "HALF_NUMBER"
  | "UNSUPPORTED_OR_MISSING";

/** A literal source total, deliberately without any representation rewrite. */
export interface LiteralFullGameTotal {
  literal_total: number | null;
  convention: LiteralFullGameTotalConvention;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Returns Frostline's synthetic lower-half representation. Integer inputs move
 * down one half-run; existing half-number inputs are preserved; all other
 * inputs fail closed. This result is never literal or executable evidence.
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

/**
 * Preserve a quoted full-game total exactly as posted. This is the only helper
 * market provenance and settlement may use for a literal reference market.
 */
export function describeLiteralFullGameTotal(value: unknown): LiteralFullGameTotal {
  const parsed = numeric(value);
  if (parsed === null || parsed <= 0) {
    return { literal_total: null, convention: "UNSUPPORTED_OR_MISSING" };
  }
  const halfSteps = Math.round(parsed * 2);
  if (Math.abs(parsed * 2 - halfSteps) > HALF_NUMBER_EPSILON) {
    return { literal_total: null, convention: "UNSUPPORTED_OR_MISSING" };
  }
  return {
    literal_total: Number(parsed.toFixed(1)),
    convention: halfSteps % 2 === 0 ? "WHOLE_NUMBER" : "HALF_NUMBER",
  };
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
