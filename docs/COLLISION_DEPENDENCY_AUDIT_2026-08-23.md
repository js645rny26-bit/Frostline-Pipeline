# Collision Dependency Audit — 2026-08-23

Scope: commissioning branch only. This document records the data-path audit; it
does not authorize a projection, authorization, vehicle, workbook, or
coefficient change.

## Current path and status

| Surface | Status | Finding |
| --- | --- | --- |
| `STATCAST_GAME_PREVIEW` | Repaired source contract | Savant serves usable Statcast fields in `roster.hitters` and `roster.pitchers` while `hitterPlusRows` is a numeric counter. Treating that counter as a live/completed-page failure caused false `NOT_PUBLISHED` results. |
| Exact lineup input | Shadow ingestion | When a lineup is posted, the parser now uses only hitters with a posted batting order. Before lineup publication it records a roster fallback rather than inventing an order. |
| Exact pitcher input | Shadow ingestion | The parser resolves the known probable pitcher by the pregame player ID from `roster.pitchers`; it never infers a starter from roster position. |
| `STATCAST_SHADOW_AUDIT` | Shadow only | Existing traffic, damage, and conversion estimates can receive the repaired preview inputs. `Preview_Used_In_Projection` remains `NO`. |
| `Traffic_Conversion_Estimate` / `HR_XBH_Damage_Estimate` | Shadow only | These are observed candidate values, not active run components. |
| `COLLISION_CALIBRATION_HISTORY` | Prospective shadow ledger | Freezes one real pre-first-pitch collision record per game, including explicit `SOURCE_UNAVAILABLE` / `INSUFFICIENT_INPUT` states that cannot be graded as neutral zeroes. |
| `COLLISION_CALIBRATION_REPORT` | Settlement only | Grades only frozen available candidates against totals, allocation evidence, and the frozen market line; it never rebuilds a completed game's preview. |
| `GAME_SUMMARY` | Intentionally inactive | `Traffic_Conversion_Runs` and `HR_XBH_Damage_Runs` remain explicit zeroes in the active projection. |
| Final projection / authorization / vehicle | Unchanged | No collision value crosses this boundary in this repair. |

## Source-availability conclusion

The August 2 onward `0 available / 0 parsed` pattern was not ordinary preview
timing and was not a network failure: the source returned HTTP success and
contained roster-level Statcast metrics, but Module 02e chose the generic
empty `stats` object before checking the direct Statcast fields on the same
player row. Parser v1.2.0 corrects that false negative. The numeric
`hitterPlusRows` counter remains accepted only as a counter; roster metrics
remain the source of truth.

The source is still an undocumented HTML page. It remains fail-open and must
not become the sole required dependency for the active game projection.

## Commissioning boundary

This is an ingestion and prospective-calibration repair, not a collision-model
rollout. Each legitimate pregame run now preserves the exact candidate inputs
needed for a settlement comparison. Only a later report with enough preserved
available candidates may support a replay-backed proposal to promote, revise,
or retire any collision calculation. No additive traffic, damage, conversion,
lineup, hand, or bullpen bonus has been enabled.
