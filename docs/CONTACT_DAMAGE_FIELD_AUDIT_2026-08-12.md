# Contact and Damage Field Audit - 2026-08-12

Scope: `GAME_SUMMARY.Traffic_Conversion_Runs` and `GAME_SUMMARY.HR_XBH_Damage_Runs`.

## Finding

Both fields are intentionally dormant reserved components. Module 09 explicitly initializes each to zero, labels each assignment as a stub, and writes the zero into the documented output columns. The workbook schema likewise describes them as reserved components that remain explicit zero until a validated model supplies them.

No missing runtime dependency was found. Current scoring already carries observed run production through the commissioned offense inputs and environment effects through the shared environment resolver. The two reserved fields do not silently alter projections, authorization, or publication.

## Decision

- Keep both fields at explicit zero.
- Preserve their names and audit visibility.
- Record inexpensive signed estimates in `STATCAST_SHADOW_AUDIT` using pregame preview hitter shape:
  - walk/strikeout opportunity for `Traffic_Conversion_Estimate`;
  - hard-hit rate for `HR_XBH_Damage_Estimate`.
- Keep the active `GAME_SUMMARY` components unchanged while the estimates accumulate alongside outcomes.
- Treat any later promotion into the active projection as a separately commissioned model change.

Classification: active components remain dormant; candidate estimates are now observable and testable.
