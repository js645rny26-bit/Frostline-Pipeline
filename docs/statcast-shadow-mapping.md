# Statcast Preview Shadow Mapping

**Phase 3 — shadow feature mapping and double-counting audit**
**Status:** Phase 3 implementation complete. No projection or authorization influence.

---

## Available Statcast Fields

Fields available from `StatcastPreviewGameResult` (Baseball Savant game preview page).

### Pitcher fields (away and home probable starters)

| Raw field | Definition | Pregame available | Unit | Expected range |
|---|---|---|---|---|
| `xwoba` | Expected wOBA allowed (contact quality) | Yes, season-to-date | — | 0.250 – 0.420 |
| `k_percent` | Season strikeout rate | Yes | % | 10 – 40 |
| `bb_percent` | Season walk rate | Yes | % | 3 – 16 |
| `exit_velocity_avg` | Average exit velocity allowed | Yes | mph | 83 – 94 |
| `whiff_percent` | Swinging-strike rate | Yes | % | 15 – 45 |
| `hard_hit_percent` | Hard-hit % allowed (EV ≥ 95 mph) | Yes | % | 28 – 55 |
| `barrel_batted_rate` | Barrel rate % | Yes | % | 4 – 18 |
| `did_not_qualify` | Insufficient batters-faced sample | Yes | bool | — |

### Hitter aggregate fields (qualified hitters, per team)

| Raw field | Definition | Pregame available | Unit | Expected range |
|---|---|---|---|---|
| `xwoba_avg` | Mean xwOBA (qualified hitters) | Yes, season-to-date | — | 0.270 – 0.360 |
| `ev_avg` | Mean exit velocity | Yes | mph | 85 – 92 |
| `hard_hit_avg` | Mean hard-hit % | Yes | % | 30 – 45 |
| `k_pct_avg` | Mean strikeout rate | Yes | % | 16 – 28 |
| `bb_pct_avg` | Mean walk rate | Yes | % | 5 – 12 |

---

## Double-Counting Audit

Each field is compared against currently active model inputs.

### Current model inputs (module09)

| Component | Source | How it enters the model |
|---|---|---|
| Offense rate (L30) | FanGraphs wRC+ → runs/9 (STUB — constant splits) | Blended 65% with L10 actual RS |
| Offense rate (L10) | Actual RS/game, last 10 games | Blended 35% with L30 |
| Starter quality | FIP/ERA from MLB Stats API; K-BB% from FanGraphs (STUB = 0) | `fipFactor × (1 − kBBAdj)` |
| Bullpen quality | Weighted-average reliever ERA | Applied to bullpen innings fraction |
| Lineup factor | Per-batter OPS + xwOBA from module02d Statcast leaderboard | Multiplicative on offense rate |
| Park multiplier | mlbstartingnine.com seasonal venue factor | Multiplicative on scoring |
| Weather multiplier | Temperature/wind/rain day-specific deviation | Multiplicative on scoring |
| Expected innings | Pitcher role / pitch-count model | Starter vs bullpen innings split |

### Pitcher field decisions

| Statcast field | Double-counting risk | Decision | Rationale |
|---|---|---|---|
| **`xwoba` allowed** | Partially overlaps FIP (both measure pitcher quality). xwOBA adds contact quality; FIP captures K/BB/HR independently. Not the same signal. | **INCLUDE — primary shadow signal** | Independent contact-quality dimension not fully captured by FIP. Blend weight 0.25 prevents amplification. |
| `k_percent` | FanGraphs `k_pct` is the same metric. Model currently uses it (STUB = 0). | **EXCLUDED** — reserved for FanGraphs stub-replacement. Using it here would double-count once FanGraphs is real. |
| `bb_percent` | Same as `k_percent` — identical FanGraphs stub situation. | **EXCLUDED** — reserved for FanGraphs stub-replacement. |
| `exit_velocity_avg` | Strongly correlated with xwOBA (both measure contact quality). | **EXCLUDED** — additive use with xwOBA would count contact quality twice. |
| `hard_hit_percent` | Correlated with xwOBA (a subset of hard contact). | **EXCLUDED** — proxied by xwOBA. |
| `whiff_percent` | Correlated with K% (same event, different denominator). | **EXCLUDED** — correlated with K% which is reserved for FanGraphs replacement. |
| `barrel_batted_rate` | Partially independent from xwOBA (barrel-specific HR tendency). Minor incremental signal. | **EXCLUDED in Phase 3** — independent signal but small magnitude; reserved for Phase 5 with empirical validation. |

### Hitter aggregate field decisions

| Statcast field | Double-counting risk | Decision | Rationale |
|---|---|---|---|
| `xwoba_avg` (hitters) | Module09 `computeLineupStrength` already blends per-batter xwOBA from module02d (Statcast leaderboard) at `STATCAST_BLEND_WEIGHT = 0.25`. The preview aggregate and module02d measure the same metric for largely the same players. | **EXCLUDED** — direct double-count with lineup factor. |
| `ev_avg` (hitters) | Correlated with hitter xwOBA. Module02d also has `exit_velo_avg`. | **EXCLUDED** — proxied by lineup xwOBA. |
| `hard_hit_avg` (hitters) | Module02d has `hard_hit_pct`. | **ESTIMATE in Phase 4** — signed HR/XBH damage estimate, capped and retained outside the active projection. |
| `k_pct_avg` (hitters) | Not currently in the lineup model. Independent signal. | **ESTIMATE in Phase 4** — combined with BB% for a signed traffic-conversion estimate. |
| `bb_pct_avg` (hitters) | Not currently in the lineup model. Independent signal. | **ESTIMATE in Phase 4** — combined with K% for a signed traffic-conversion estimate. |

---

## Accepted Shadow Signal: Pitcher xwOBA Allowed

### Transformation

```
xwobaQualFactor  = clamp(xwoba_allowed / 0.315, 0.40, 1.80)
shadowQual       = currentQual × 0.75 + xwobaQualFactor × 0.25
delta_away_runs  = awayAdjRate × (homeIP / 9) × (shadowHomeQual − currentHomeQual)
delta_home_runs  = homeAdjRate × (awayIP / 9) × (shadowAwayQual − currentAwayQual)
totalAdj         = clamp(delta_away + delta_home, −0.30, +0.30)
shadowProjection = currentProjection + totalAdj
```

Where `awayAdjRate = away_offense_rate_used × combined_run_multiplier × away_lineup_factor`.

### Constants

| Constant | Value | Justification |
|---|---|---|
| `LEAGUE_AVG_XWOBA_ALLOWED` | 0.315 | Aligns with `LEAGUE_AVG_XWOBA` in module09 (same xwOBA scale) |
| `SHADOW_BLEND_WEIGHT` | 0.25 | Conservative: xwOBA and FIP are correlated; low weight prevents double-amplification |
| `SHADOW_ADJUSTMENT_CAP` | ±0.30 runs | Maximum per-game shadow adjustment; prevents extreme projections from a single data point |

### Missing-data behaviour

| Condition | Behaviour |
|---|---|
| Preview not AVAILABLE | Both pitcher deltas = 0; `missing_fields = ["preview_not_available"]` |
| Pitcher `did_not_qualify` | That side's delta = 0; field listed in `missing_fields` |
| Pitcher `xwoba` is null | Same as above |
| `null` preview passed | Both deltas = 0; `preview_availability = "UNAVAILABLE"` |

### Cap behaviour

When `|totalUncapped| > 0.30`:
- `shadow_projection = current_projection ± 0.30`
- `cap_applied = true` (visible in the workbook)
- `shadow_xwoba_adjustment` retains the uncapped value for auditability

---

## Phase 3 Authorisation Boundaries

- `Preview_Used_In_Projection = "NO"` for every row in every output.
- No change to `projected_total_runs`, `baseball_only_projection`, or any survival gate input.
- No change to CORE/NO_CORE decisions.
- The STATCAST_SHADOW_AUDIT sheet is a read-only analysis surface.

## Phase 4 Hitter-Tail Estimates

`STATCAST_SHADOW_AUDIT` also records inexpensive candidate estimates:

```
trafficIndex = ((BB% / 8.5) + (22.5 / K%)) / 2
trafficAdj   = clamp(projectedTeamRuns * (trafficIndex - 1), -0.35, +0.35)
damageIndex  = HardHit% / 38.5
damageAdj    = clamp(projectedTeamRuns * (damageIndex - 1), -0.35, +0.35)
combinedTail = clamp(sum(team traffic + team damage), -0.60, +0.60)
estimatedProjection = currentProjection + cappedStarterAdjustment + combinedTail
```

Missing inputs produce a zero estimate for that subcomponent and an explicit
`PARTIAL` or `UNAVAILABLE` status. The active GAME_SUMMARY placeholders remain
zero while these estimates accumulate evidence.

## Fields Reserved for Future Phases

| Field | Reserved phase | Prerequisite |
|---|---|---|
| Pitcher K%/BB% | Phase 5 (stub replacement) | Requires removing FanGraphs stub; calibration across ≥30 slates |
| Pitcher barrel rate | Phase 5 | Empirical δ-runs-per-barrel calibration |
| Hitter K%/BB% avg promotion | Phase 5 | Shadow validation evidence across ≥30 slates |
| Cached-payload reuse detection | Phase 3 infrastructure | Cache-loading path not yet implemented |
