/**
 * Pregame pitching plans explicitly declared by an authoritative source.
 *
 * This is narrow, dated evidence—not a role inference engine. Every entry must
 * match date, Game_ID, team side, and the MLB probable-pitcher identity before
 * it may override the conventional-starter role. Source-supported followers
 * remain research-only in Active Pitching Inventory V1.
 */

export interface SourceDeclaredPitchingPlan {
  date: string;
  game_id: string;
  team_side: "AWAY" | "HOME";
  pitching_team: string;
  opener_pitcher_id: number;
  opener_pitcher: string;
  opener_role: "OPENER";
  opener_expected_ip_cap: number;
  bulk_pitcher_id: number;
  bulk_pitcher: string;
  bulk_role: "BULK";
  bulk_expected_ip: number;
  source_url: string;
  source_observed_ts: string;
  source_summary: string;
}

const SOURCE_DECLARED_PITCHING_PLANS: readonly SourceDeclaredPitchingPlan[] = [{
  date: "2026-10-01",
  game_id: "20261001_PHI_ATL",
  team_side: "HOME",
  pitching_team: "ATL",
  opener_pitcher_id: 678061,
  opener_pitcher: "Ray Kerr",
  opener_role: "OPENER",
  opener_expected_ip_cap: 1.2,
  bulk_pitcher_id: 656550,
  bulk_pitcher: "Grant Holmes",
  bulk_role: "BULK",
  bulk_expected_ip: 4,
  source_url: "https://www.mlb.com/braves/news/grant-holmes-ray-kerr-brent-suter-braves-nl-wild-card-game-3?t=nl-wild-card-series-a-coverage",
  source_observed_ts: "2026-10-01T22:56:04.932Z",
  source_summary: "MLB announced Kerr as the Game 3 opener and Holmes as the expected follower within the first few innings for at least four innings.",
}];

export function sourceDeclaredPitchingPlansForDate(date: string): readonly SourceDeclaredPitchingPlan[] {
  return SOURCE_DECLARED_PITCHING_PLANS.filter((plan) => plan.date === date);
}

export function sourceDeclaredPitchingPlanForSide(
  plans: readonly SourceDeclaredPitchingPlan[],
  gameId: string,
  side: "AWAY" | "HOME",
): SourceDeclaredPitchingPlan | undefined {
  return plans.find((plan) => plan.game_id === gameId && plan.team_side === side);
}
