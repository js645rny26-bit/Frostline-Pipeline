/**
 * Module 09 active game-truth mathematics.
 *
 * This is the live team-run calculation, not a challenger.  It retains the
 * league-anchored lineup center, recent-form modifier, starter run-prevention,
 * bullpen-quality, and environment inputs, then makes their interaction
 * explicit:
 *
 *   lineup traffic × pitcher traffic  -> starter-window traffic pressure
 *   lineup damage  × pitcher damage   -> conversion / damage pressure
 *   starter pressure                 -> effective starter workload
 *   effective workload               -> bullpen exposure
 *
 * The interaction terms are deliberately zero-centred and capped.  They are
 * not additive tail bonuses: traffic primarily changes expected starter
 * workload and only earns a direct run effect when damage/conversion evidence
 * co-signs it. The model never invents an effect when the required pregame
 * inputs are absent.
 */

export interface ActiveLineupProfile {
  coverage: number;
  source: "official" | "projected" | null;
  weighted_obp: number | null;
  weighted_slg: number | null;
  weighted_bb_pct: number | null;
  weighted_k_pct: number | null;
  weighted_xwoba: number | null;
  weighted_hard_hit_pct: number | null;
}

export interface ActiveStarterProfile {
  quality_factor: number;
  expected_innings: number;
  bb_pct: number | null;
  k_pct: number | null;
  whip: number | null;
  hr_per_9: number | null;
}

export interface ActiveTeamProjectionInput {
  /** Active team-run center before park/weather. */
  baseline_offense_rate: number;
  environment_multiplier: number;
  lineup: ActiveLineupProfile;
  opposing_starter: ActiveStarterProfile;
  opposing_bullpen_quality: number;
}

/** Inputs used to build the active team-run center before pitching is applied. */
export interface ActiveOffenseCenterInput {
  /** Recent realized RS/G blend. It is form evidence, not the offensive center. */
  recent_form_rate: number | null;
  /** Existing exact-lineup OPS/xwOBA quality factor. */
  lineup_factor: number;
  lineup: Pick<ActiveLineupProfile, "coverage" | "source">;
}

/** Auditable decomposition of the active offense center. */
export interface ActiveOffenseCenter {
  /** League environment × exact lineup quality before recent form. */
  latent_lineup_rate: number;
  /** Bounded recent-results adjustment; neutral = 1.0. */
  recent_form_multiplier: number;
  /** The live center passed into starter/bullpen calculation. */
  active_offense_center: number;
}

export interface ActiveTeamProjection {
  /** Final projected team runs after the already-resolved park/weather multiplier. */
  projected_runs: number;
  /** Final projection before park/weather.  Components reconcile to this value. */
  baseball_only_runs: number;
  /** Starter-window expectation before traffic/damage conversion deltas. */
  starter_attack_runs: number;
  /** Bullpen-window expectation after starter-pressure changes expected exposure. */
  bullpen_continuation_runs: number;
  /** Signed, bounded conversion effect from traffic pressure. */
  traffic_conversion_runs: number;
  /** Signed, bounded conversion effect from damage pressure. */
  hr_xbh_damage_runs: number;
  /** Original workload less only the justified traffic/damage pressure shortfall. */
  effective_starter_innings: number;
  bullpen_exposure_innings: number;
  /** Neutral = 1.0.  Does not directly equal an additive run adjustment. */
  traffic_matchup_factor: number;
  /** Neutral = 1.0.  Does not directly equal an additive run adjustment. */
  damage_matchup_factor: number;
  /** How complete/reliable the exact lineup profile was for this calculation. */
  matchup_profile_status: "ACTIVE" | "PARTIAL" | "NEUTRAL";
}

const LEAGUE_AVG_BB_PCT = 0.085;
const LEAGUE_AVG_K_PCT = 0.225;
const LEAGUE_AVG_HARD_HIT_PCT = 40;
const LEAGUE_AVG_WHIP = 1.3;
const LEAGUE_AVG_HR_PER_9 = 1.15;
/** League scoring environment used as the latent team-run baseline. */
export const LEAGUE_AVG_RUNS_PER_GAME = 4.5;

/**
 * Recent RS/G is inherently a conversion outcome. It is deliberately a small,
 * capped modifier to the lineup-quality center rather than the center itself.
 */
export const RECENT_FORM_WEIGHT = 0.2;
export const MAX_RECENT_FORM_EFFECT = 0.08;

// These are guardrails, not learned coefficients. They prevent correlated
// lineup/pitcher evidence from overwhelming the active center before the
// preserved prospective sample is large enough to calibrate its strength.
const MAX_TRAFFIC_EFFECT = 0.025;
const MAX_DAMAGE_EFFECT = 0.04;
const MAX_STARTER_SHORTFALL = 0.75;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function round(value: number, digits = 4): number {
  return Number.parseFloat(value.toFixed(digits));
}

function valid(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function weightedIndex(
  values: Array<{ value: number | null; baseline: number; weight: number }>,
): number | null {
  const usable = values.filter(
    (entry) => valid(entry.value) && entry.baseline > 0,
  );
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((sum, entry) => sum + entry.weight, 0);
  return (
    usable.reduce(
      (sum, entry) => sum + (entry.value! / entry.baseline) * entry.weight,
      0,
    ) / totalWeight
  );
}

function geometricMatchup(left: number | null, right: number | null): number {
  if (left === null || right === null || left <= 0 || right <= 0) return 1;
  return Math.sqrt(left * right);
}

function lineupConfidence(lineup: ActiveLineupProfile): number {
  const coverage = clamp(lineup.coverage, 0, 1);
  if (coverage === 0) return 0;
  // Projected lineups are usable evidence, but cannot carry the same exact
  // matchup weight as a confirmed nine.
  return lineup.source === "official" ? coverage : coverage * 0.6;
}

function lineupTrafficIndex(lineup: ActiveLineupProfile): number | null {
  return weightedIndex([
    // OPS/xwOBA already own the lineup-quality center. Traffic keeps the
    // comparatively distinct plate-discipline shape rather than paying OBP
    // a second time here.
    { value: lineup.weighted_bb_pct, baseline: LEAGUE_AVG_BB_PCT, weight: 0.65 },
    {
      value:
        valid(lineup.weighted_k_pct) && lineup.weighted_k_pct > 0
          ? LEAGUE_AVG_K_PCT / lineup.weighted_k_pct
          : null,
      baseline: 1,
      weight: 0.35,
    },
  ]);
}

function pitcherTrafficIndex(starter: ActiveStarterProfile): number | null {
  return weightedIndex([
    { value: starter.bb_pct, baseline: LEAGUE_AVG_BB_PCT, weight: 0.45 },
    { value: starter.whip, baseline: LEAGUE_AVG_WHIP, weight: 0.35 },
    {
      value:
        valid(starter.k_pct) && starter.k_pct > 0
          ? LEAGUE_AVG_K_PCT / starter.k_pct
          : null,
      baseline: 1,
      weight: 0.2,
    },
  ]);
}

function lineupDamageIndex(lineup: ActiveLineupProfile): number | null {
  // SLG and xwOBA already inform the lineup-quality center. Hard-hit rate is
  // retained here as a separate damage/tail characteristic rather than a
  // second payment for the same broad offensive-quality inputs.
  return weightedIndex([
    { value: lineup.weighted_hard_hit_pct, baseline: LEAGUE_AVG_HARD_HIT_PCT, weight: 1 },
  ]);
}

function pitcherDamageIndex(starter: ActiveStarterProfile): number | null {
  return valid(starter.hr_per_9) && starter.hr_per_9 >= 0
    ? starter.hr_per_9 / LEAGUE_AVG_HR_PER_9
    : null;
}

/**
 * Builds the live team offense center.
 *
 * Recent scoring stays visible and useful, but it cannot independently label
 * a team a five- or six-run offense before today's exact lineup and pitching
 * tree have been considered. When lineup quality is unavailable, the center
 * truthfully returns to league average and retains only the small form shift.
 */
export function computeActiveOffenseCenter(
  input: ActiveOffenseCenterInput,
): ActiveOffenseCenter {
  const coverage = clamp(input.lineup.coverage, 0, 1);
  const lineupEvidence =
    input.lineup.source === "official" ? coverage : coverage * 0.6;
  const lineupFactor =
    lineupEvidence > 0 && Number.isFinite(input.lineup_factor)
      ? clamp(input.lineup_factor, 0.82, 1.18)
      : 1;
  const latentLineupRate = LEAGUE_AVG_RUNS_PER_GAME * lineupFactor;
  const recentRate =
    valid(input.recent_form_rate) && input.recent_form_rate > 0
      ? input.recent_form_rate
      : LEAGUE_AVG_RUNS_PER_GAME;
  const recentDeviation = recentRate / LEAGUE_AVG_RUNS_PER_GAME - 1;
  const recentFormEffect = clamp(
    recentDeviation * RECENT_FORM_WEIGHT,
    -MAX_RECENT_FORM_EFFECT,
    MAX_RECENT_FORM_EFFECT,
  );
  const recentFormMultiplier = 1 + recentFormEffect;

  return {
    latent_lineup_rate: round(latentLineupRate, 4),
    recent_form_multiplier: round(recentFormMultiplier, 4),
    active_offense_center: round(latentLineupRate * recentFormMultiplier, 4),
  };
}

/**
 * Computes a live team-run projection with exact, bounded matchup effects.
 *
 * The pre-existing base rate and quality factor remain the centre of the
 * calculation.  The new factors only shift a starter window when the relevant
 * lineup and pitcher inputs jointly support it; otherwise every new term is
 * neutral and the historical formula is preserved exactly.
 */
export function computeActiveTeamProjection(
  input: ActiveTeamProjectionInput,
): ActiveTeamProjection {
  const baselineRate = Math.max(input.baseline_offense_rate, 0);
  const expectedInnings = clamp(input.opposing_starter.expected_innings, 0, 9);
  const starterQuality = Math.max(input.opposing_starter.quality_factor, 0);
  const bullpenQuality = Math.max(input.opposing_bullpen_quality, 0);
  const confidence = lineupConfidence(input.lineup);

  const lineupTraffic = lineupTrafficIndex(input.lineup);
  const pitcherTraffic = pitcherTrafficIndex(input.opposing_starter);
  const lineupDamage = lineupDamageIndex(input.lineup);
  const pitcherDamage = pitcherDamageIndex(input.opposing_starter);
  const hasTrafficMatchup = lineupTraffic !== null && pitcherTraffic !== null;
  const hasDamageMatchup = lineupDamage !== null && pitcherDamage !== null;
  const trafficIndex = geometricMatchup(lineupTraffic, pitcherTraffic);
  const damageIndex = geometricMatchup(lineupDamage, pitcherDamage);

  // Traffic primarily changes workload/bullpen exposure. A positive traffic
  // read becomes direct runs only when damage evidence co-signs conversion.
  // Damage can retain a smaller independent direct effect because an XBH/HR
  // can score without an extended traffic sequence.
  const trafficSignal = trafficIndex - 1;
  const damageSignal = damageIndex - 1;
  const positiveTraffic = Math.max(trafficSignal, 0);
  const positiveDamage = Math.max(damageSignal, 0);
  const sharedConversionSignal = positiveTraffic * positiveDamage;
  const trafficEffect = clamp(
    (trafficSignal < 0 ? trafficSignal * 0.5 : sharedConversionSignal) *
      confidence,
    -MAX_TRAFFIC_EFFECT,
    MAX_TRAFFIC_EFFECT,
  );
  const damageEffect = clamp(
    (damageSignal < 0
      ? damageSignal * 0.5
      : damageSignal * (0.35 + Math.min(positiveTraffic, 0.5))) * confidence,
    -MAX_DAMAGE_EFFECT,
    MAX_DAMAGE_EFFECT,
  );

  // A positive pregame pressure match shortens only the starter portion and
  // moves that exact workload to the bullpen.  It never claims a postgame
  // failure occurred and it cannot remove more than three quarters of an IP.
  const pressureShortfall = clamp(
    (positiveTraffic * 1.5 + positiveDamage * 0.4) *
      confidence,
    0,
    MAX_STARTER_SHORTFALL,
  );
  const effectiveStarterInnings = round(
    Math.max(expectedInnings - pressureShortfall, 0),
    3,
  );
  const bullpenExposureInnings = round(9 - effectiveStarterInnings, 3);

  const starterAttackRuns =
    baselineRate * (effectiveStarterInnings / 9) * starterQuality;
  const trafficRuns = starterAttackRuns * trafficEffect;
  const damageRuns = (starterAttackRuns + trafficRuns) * damageEffect;
  const bullpenRuns =
    baselineRate * (bullpenExposureInnings / 9) * bullpenQuality;
  const baseballOnlyRuns =
    starterAttackRuns + trafficRuns + damageRuns + bullpenRuns;
  const projectedRuns = baseballOnlyRuns * input.environment_multiplier;

  // A populated lineup alone does not make this an exact matchup profile. A
  // matching starter-side traffic or damage input must also exist; otherwise
  // the new effects remain neutral and the audit says so truthfully.
  const hasAnyMatchup = hasTrafficMatchup || hasDamageMatchup;
  const profileStatus: ActiveTeamProjection["matchup_profile_status"] =
    confidence === 0 || !hasAnyMatchup
      ? "NEUTRAL"
      : confidence >= 0.95
        ? "ACTIVE"
        : "PARTIAL";

  return {
    projected_runs: round(projectedRuns, 2),
    baseball_only_runs: round(baseballOnlyRuns, 4),
    starter_attack_runs: round(starterAttackRuns, 4),
    bullpen_continuation_runs: round(bullpenRuns, 4),
    traffic_conversion_runs: round(trafficRuns, 4),
    hr_xbh_damage_runs: round(damageRuns, 4),
    effective_starter_innings: effectiveStarterInnings,
    bullpen_exposure_innings: bullpenExposureInnings,
    traffic_matchup_factor: round(1 + trafficEffect, 4),
    damage_matchup_factor: round(1 + damageEffect, 4),
    matchup_profile_status: profileStatus,
  };
}
