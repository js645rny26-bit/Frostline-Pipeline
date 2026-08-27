# Frostline repository instructions

Before analyzing or changing the workbook, read:

1. `docs/WORKBOOK_ROADMAP.md`
2. `docs/DAILY_SOP.md`
3. `docs/COMMISSIONING_MANUAL_DOCTRINE.md`

For every slate review, board interpretation, or postmortem:

- report active, dormant, degraded/fallback, and missing/broken components;
- report whether `GAME_SUMMARY.Traffic_Conversion_Runs` and `HR_XBH_Damage_Runs` are active or neutral for each game. They are active, signed components when the exact lineup and matching-starter profile is available; `NEUTRAL` is an explicit evidence gap, not a baseball conclusion. Keep the separate `STATCAST_SHADOW_AUDIT` estimate distinct from the active calculation;
- consider the tentative total range bounded by `GAME_SUMMARY.Projected_Total_Runs` and `STATCAST_SHADOW_AUDIT.Estimated_Projection`;
- treat a market line inside that range as directional instability, not a point-estimate authorization;
- preserve prospective timestamps and frozen records; replay never replaces missing pregame evidence;
- do not infer that a visible column is active—trace its writer and downstream consumer.

When adding or removing a workbook sheet, update `WORKBOOK_ROADMAP` in
`artifacts/api-server/src/lib/workbook/workbookRoadmap.ts`; its test must continue
to match `WORKBOOK_SCHEMA` exactly.
