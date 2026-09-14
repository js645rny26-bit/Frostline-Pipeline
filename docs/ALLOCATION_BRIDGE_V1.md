# Allocation Bridge V1

## Status and invariant

Allocation Bridge V1 is settlement-time research only. It reads immutable
`FROZEN_PREGAME` packets and canonical settled team scores. It cannot write an
active projection, packet, board, market, vehicle, decision, authorization, or
ticket result.

For every usable row:

```text
Bridge_Away_Projection + Bridge_Home_Projection = Frozen_Total
```

within `1e-9` before workbook rounding. The frozen total is never recomputed or
optimized by this module.

## Structural audit of the active path

The active Module 09 path builds each batting side independently and sums the
two results:

```text
league team-run baseline
  x exact-lineup OPS/xwOBA factor
  x bounded recent-scoring multiplier
  = team active offense center

team active offense center
  x opposing starter quality over effective starter innings
  x bounded team-specific traffic and damage factors
  + team active offense center
  x opposing bullpen quality over inherited bullpen innings
  = baseball-only team projection

baseball-only team projection
  x one common park/weather multiplier
  = projected team runs
```

The two projected team runs are then added to form the game total. Environment
is common to both sides and therefore changes the total, not relative team
support. One team's evidence does not directly change the other team's active
calculation, although their independent results necessarily sum to the game
total.

Known dependency relationships:

- lineup OPS/xwOBA owns the offense center; BB/K and hard-hit enter the related
  traffic/damage family and are not independent votes;
- starter quality owns the central starter-window suppression factor;
- traffic and damage can shorten the starter window and thereby increase the
  opposing bullpen window;
- bullpen quality is applied only inside the inherited bullpen window;
- recent scoring is a bounded modifier inside the offense family;
- collision and SSAT are dependent shadows and are not bridge inputs;
- HR/XBH damage runs are currently zero throughout the eligible frozen bridge
  corpus, so V1 does not fabricate an independent damage run signal;
- no active defense, baserunning, catcher, or umpire allocation input exists.

## Frozen evidence coverage

At the pre-build audit on 2026-09-14, the authoritative workbook contained 254
canonical allocation-settlement rows. All 254 joined to immutable frozen
packets. The component fields needed for V1 were present for 225 games; 29
older packets predate those fields and must remain explicit exclusions.

## Pre-registered V1 bridge

V1 treats the active offense identity and the opponent run-prevention system as
two correlated baseball families. It does not let the starter alone define the
game and does not create independent votes for starter, bullpen, traffic, or
damage.

For each side `i`:

```text
Baseball_Team_Runs_i = Legacy_Team_Projection_i / Run_Multiplier

System_Factor_i = Baseball_Team_Runs_i / Active_Offense_Center_i

Raw_Bridge_Support_i =
  Active_Offense_Center_i * sqrt(System_Factor_i)
```

The square root is the fixed equal-family geometric bridge. Offense identity
retains full weight. The already-combined opponent system—including starter,
workload, traffic/damage moderation, bullpen exposure, and bullpen quality—is
retained once at half log-strength. This is a research challenger, not a fitted
coefficient and not a new additive run adjustment.

The fixed-total allocation is:

```text
Bridge_Away_Share = Away_Raw_Support /
                    (Away_Raw_Support + Home_Raw_Support)

Bridge_Home_Share = 1 - Bridge_Away_Share

Bridge_Away_Projection = Frozen_Total * Bridge_Away_Share
Bridge_Home_Projection = Frozen_Total - Bridge_Away_Projection
```

The second subtraction is deliberate: it makes the fixed-total invariant exact
rather than relying on two separately rounded products.

## Component audit

The packet does not store a standalone numeric bullpen factor, but the active
system factor is recoverable without outside data. V1 reports the following
descriptive decomposition of the system factor:

```text
Starter_Component = Starter_Share * (Starter_Quality - 1)
Traffic_Component = Starter_Share * Starter_Quality * (Traffic_Factor - 1)
Damage_Component  = Starter_Share * Starter_Quality
                    * Traffic_Factor * (Damage_Factor - 1)
Bullpen_Component = System_Factor - 1
                    - Starter_Component
                    - Traffic_Component
                    - Damage_Component
Conversion_Component = 0
```

`Conversion_Component` remains zero because traffic/damage moderation is
already represented once in the matchup factors and no independent frozen
team-level conversion object exists. The inferred bullpen residual is an audit
decomposition only; it is not separately re-added to bridge support.

## Eligibility and missingness

A row is usable only when:

- the packet is `FROZEN_PREGAME`;
- packet and allocation rows agree on game, snapshot, legacy team projections,
  and frozen total;
- the team projections, total, environment multiplier, active offense centers,
  effective starter innings, starter quality, traffic factor, and damage factor
  are finite and structurally valid;
- both independently built supports are positive;
- the fixed-total invariant passes.

Missing or pre-schema evidence is an explicit research exclusion. It never
becomes a neutral statistical value.

## Replay and cohorts

Replay is date ordered and uses each game's own frozen packet. No later slate
or result is used to create bridge support. Actual scores enter only after the
candidate projections have been formed, solely for settlement scoring.

Declared descriptive cohorts:

- allocation strength: `LOW` below 0.50 projected run differential,
  `MEDIUM` from 0.50 to below 1.00, `HIGH` at 1.00 or greater;
- lineup completeness: `FULL` only when both sides are full/complete with at
  least 0.95 coverage, otherwise `PARTIAL_OR_LOWER`;
- starter role: `CONVENTIONAL_BOTH`, `ATYPICAL_PRESENT`, or
  `UNRESOLVED_PRESENT`;
- bullpen data: `AVAILABLE` or `UNAVAILABLE_OR_PARTIAL`;
- total error: `GOOD` at absolute error <= 2, `MODERATE` above 2 through 4,
  `POOR` above 4;
- `TOTAL_GOOD_ALLOCATION_BAD`: total absolute error <= 2 and legacy allocation
  MAE >= 3, matching the existing Module 29 diagnostic definition.

These thresholds are frozen for V1 and are not selected from bridge outcomes.

## Governance

The module may return only `FAIL`, `HOLD`, `CONTINUE_SHADOW`, or
`CANDIDATE_FOR_COMMISSIONING`. No verdict activates the bridge. Any future
production proposal requires a separate commissioning task and must preserve
the fixed-total contract.
