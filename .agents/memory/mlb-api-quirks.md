---
name: MLB Stats API quirks
description: Non-obvious MLB Stats API response shapes and behaviors that cost debugging cycles; check here before writing new MLB API fetchers.
---

# MLB Stats API quirks (statsapi.mlb.com)

## Game log: gameType is at the SPLIT level
In `/people/{id}/stats?stats=gameLog`, each split has `split.gameType` ("R" etc.) and `split.game.gamePk` — but there is NO `game.gameType`. Filtering on `split.game.gameType` silently matches nothing.
**Why:** This exact mistake made a starter-outing module return 0/10 results with no errors.
**How to apply:** filter `s.gameType === "R"`, take gamePk from `s.game.gamePk`.

## Batched season stats: one people call covers ~40 pitchers
`/people?personIds=1,2,...&hydrate=stats(group=[pitching],type=[season,sabermetrics],season=YYYY)` returns, per person: `pitchHand.code`, season stats (era, whip, strikeOuts, battersFaced, homeRunsPer9 — era/whip are strings, use Number()), and sabermetrics (fip, xfip, eraMinus). K% is NOT provided — compute strikeOuts/battersFaced.
**How to apply:** prefer this over per-pitcher stat calls; ~270 pitchers = 7 requests. Also the cheapest source of throwing hand for platoon math.

## Team names: the A's are just "Athletics"
Schedule endpoints return `team.name = "Athletics"` (no city) as of 2026, while most mapping tables key the full historical name. Any full-name→abbr join must alias it or silently drop the team.

## Umpire assignments: boxscore only, posted ~noon ET
`schedule?hydrate=officials` returns an empty array. Plate umps come from `/game/{gamePk}/boxscore` → `officials[]` with `officialType: "Home Plate"`, and are empty until assignments post (~noon ET). Morning runs legitimately produce zero umps — re-run later, don't treat as failure.

## Schedule range calls include final scores
`/schedule?sportId=1&startDate=A&endDate=B` already contains `teams.{away,home}.score` for Final games — no hydrate needed. One range call replaces 30 per-team log fetches for L10 run rates. All-Star games appear as their own "teams" ("American League All-Stars") — filter by name mapping, not by assuming 30 teams.
