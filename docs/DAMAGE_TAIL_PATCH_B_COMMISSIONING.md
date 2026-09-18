# Damage-Tail Patch B Commissioning

Status: `BUILD_TEST_COPY / CONTINUE_SHADOW`

Patch B audits and repairs Frostline's explicit HR/XBH damage channel without
changing the active price-blind projection.

## Root cause

Module 09 contains a bounded lineup hard-hit × opposing-starter HR/9 damage
interaction. Its batter input comes from the Baseball Savant expected-statistics
leaderboard. The current endpoint materializes player identity, PA, xwOBA, xBA,
and xSLG, but does not expose the hard-hit column the interaction requires.

The previous parser treated a valid xwOBA payload as a fully successful contact
payload. Lineup hard-hit therefore remained null, Module 09 selected a neutral
damage factor, and `GAME_SUMMARY.HR_XBH_Damage_Runs` collapsed to 0.00.

## First commissioning repair

- The source parser now reports the observed schema and separate damage-field
  counts/status.
- A missing hard-hit column is `PARTIAL / SOURCE_SCHEMA_MISSING`, while valid
  xwOBA rows remain available to the lineup-quality path.
- The active damage caller is explicitly gated off and fails closed at 0.00.
- The model-input catalog and operator documentation distinguish active traffic
  from research-only damage.
- Existing `STATCAST_SHADOW_AUDIT` and collision-history damage estimates remain
  the canonical shadow evidence; Patch B does not create a duplicate run term.

## Frozen evidence reviewed

The existing collision calibration report contains 308 eligible settled
prospective games. On that preserved corpus:

- base projection MAE: 3.458474
- damage-only candidate MAE: 3.444026
- full collision candidate MAE: 3.438506
- non-zero damage candidate games: 282
- damage candidate improved 143, worsened 138, tied 1

This supports continuing the damage research path. It does not authorize active
promotion: the improvement is small, the damage-only wins/losses are balanced,
and the intended exact-lineup active source contract is currently incomplete.

## Promotion boundary

The second tranche now completes the factual source boundary:

- retained D-1 pitch events are reduced to one batted ball per plate appearance;
- hard-hit uses the fixed Statcast 95 mph definition;
- daily batter counts retain the raw snapshot ID and fetch/data-through lineage;
- current batter profiles and batting-order-weighted exact-lineup profiles are
  deterministic and expose identity/sample coverage;
- `DAMAGE_LINEUP_SHADOW_V1.Active_Input` is always `NO`; its
  `Collision_Ledger_Status` is explicitly `NOT_MAPPED_PENDING_COMMISSIONING`.

The retained corpus begins when this daily evidence was first accumulated.
Short history must remain visible as low observed coverage; it cannot be
backfilled from current leaderboards or interpreted as neutral talent.

## Source-maturity governance

Patch B version 1.1.0 separates factual observation from sample adequacy:

- `NO_SAMPLE`: 0 retained BBE;
- `LOW_SAMPLE`: 1-24 retained BBE;
- `USABLE_SAMPLE`: at least 25 retained BBE.

The 25-BBE threshold is fixed ex ante from a binomial-rate precision rule. At
the worst-case proportion p=0.5, `ceil(1.96^2 * 0.5 * 0.5 / 0.20^2) = 25`
keeps the approximate 95% margin of error within 20 percentage points. It was
not selected from projection or game outcomes. Raw counts and rates remain
visible in every status.

`DAMAGE_LINEUP_SHADOW_V1.Lineup_State` freezes the exact pregame source state:
`PROJECTED`, `CONFIRMED`, `PARTIAL`, or `UNKNOWN`. Per-side Starting Nine state
is retained so a mixed projected/official card is `PARTIAL`, not falsely
confirmed. League hard-hit substitution remains display-only and traceable as
`MISSING:LEAGUE`; it never counts toward observed or usable coverage.

`BATTER_DAMAGE_MATURITY_V1` reports current-slate identity, observed, low,
usable, and no-sample counts plus weighted observed/usable coverage. It is
research governance only and cannot feed Module 09 or authorization.

Before the active gate may change, Patch B still requires:

1. dependency and double-count audits against collision and traffic paths;
2. a pre-registered mapping from the factual lineup profile into the existing
   collision ledger rather than a second damage vote;
3. frozen historical replay where legitimate;
4. prospective shadow validation and manual review of materially moved games;
5. a separate promotion decision.

No frozen packet, historical projection, active decision, or market record is
modified by this tranche.
