export interface WorkbookRoadmapEntry {
  sheet: string;
  stage:
    | "PREGAME_INPUT"
    | "PROJECTION"
    | "DECISION"
    | "AUDIT"
    | "SETTLEMENT"
    | "REPLAY"
    | "META";
  timing: string;
  purpose: string;
  boardRelationship: string;
  readNote: string;
}

/**
 * Operator-facing registry for every workbook tab. A schema test requires exact
 * one-to-one coverage so newly added sheets cannot become undocumented pages.
 */
export const WORKBOOK_ROADMAP: WorkbookRoadmapEntry[] = [
  {
    sheet: "DAILY_MATCHUPS",
    stage: "PREGAME_INPUT",
    timing: "Every publish (Module 08)",
    purpose:
      "Game identity, probable pitchers, workloads, weather, park, prior outing, umpire, and market context.",
    boardRelationship:
      "Mirrors source evidence used by normalization and projection; it is not itself a spreadsheet-formula dependency.",
    readNote:
      "Start here to confirm the correct slate, starters, and obvious source gaps.",
  },
  {
    sheet: "TODAY_LINEUPS",
    stage: "PREGAME_INPUT",
    timing: "Every publish (Module 08)",
    purpose:
      "Posted or projected batting orders with batter form and platoon context.",
    boardRelationship:
      "Module 09 uses the same lineup payload to calculate lineup factors before GAME_SUMMARY.",
    readNote:
      "Check official/projected status and coverage before trusting allocation.",
  },
  {
    sheet: "TEAM_FORM_INPUT",
    stage: "PREGAME_INPUT",
    timing: "Every publish (Module 08)",
    purpose:
      "Recent team run-rate and form inputs used to establish offensive baselines.",
    boardRelationship:
      "Feeds Module 09 offense rates and therefore team and total projections.",
    readNote: "Audit when recent form appears to dominate a team allocation.",
  },
  {
    sheet: "BULLPEN_USAGE_DAILY",
    stage: "PREGAME_INPUT",
    timing: "Every publish (Module 08)",
    purpose:
      "Daily reliever availability, five-day pitch workload, matched seven-day innings history, and bullpen quality context.",
    boardRelationship:
      "Feeds Module 09 bullpen innings and continuation components.",
    readNote:
      "Start with explicit AVAILABLE/TIRED/UNAVAILABLE status and the five-day pitch map. Inside The Pen is innings-history fallback only; Notes are not durable.",
  },
  {
    sheet: "RUN_ENVIRONMENT",
    stage: "PREGAME_INPUT",
    timing: "Every publish (Modules 08/09 environment resolver)",
    purpose:
      "Authoritative park, weather, roof, wind, certainty, run multiplier, and HR factor.",
    boardRelationship:
      "The same resolver and multiplier are consumed by Module 09; environment cannot originate a thesis.",
    readNote:
      "Check fallback, roof-pending, and weather-vehicle status before using an environmental edge.",
  },
  {
    sheet: "ODDS_HISTORY",
    stage: "PREGAME_INPUT",
    timing: "Append on every publish (Module 05d)",
    purpose:
      "Time-stamped total snapshots; the earliest daily row is the opener.",
    boardRelationship:
      "Supplies movement context and line provenance; price remains downstream of baseball truth.",
    readNote:
      "Use for movement and stale-line diagnosis, not projection construction.",
  },
  {
    sheet: "STATCAST_GAME_PREVIEW",
    stage: "PREGAME_INPUT",
    timing: "Every publish when Savant preview is available (Modules 02e/08b)",
    purpose:
      "Timestamped preview identity, pitcher metrics, hitter aggregates, availability, and parser warnings.",
    boardRelationship:
      "Does not directly alter the board; feeds the Statcast estimate audit and records preview availability in Decision Audit.",
    readNote:
      "Confirm identity, lineup status, timestamp, and missing fields before using it.",
  },

  {
    sheet: "GAME_INTEGRATION",
    stage: "PROJECTION",
    timing: "Every publish (Module 09)",
    purpose:
      "Two rows per game—one per team—combining offense, opposing starter, bullpen, lineup, and environment.",
    boardRelationship: "Feeds the team allocations summarized in GAME_SUMMARY.",
    readNote:
      "Use when the total seems plausible but the away/home split looks wrong.",
  },
  {
    sheet: "GAME_SUMMARY",
    stage: "PROJECTION",
    timing: "Every publish (Module 09)",
    purpose:
      "One-row active team-run projection with away runs, home runs, total, starter/bullpen windows, lineup-pitcher traffic/damage conversion, environment, and lineage.",
    boardRelationship: "Primary projection input to Module 11 and SLATE_BOARD.",
    readNote:
      "Read the two matchup factors, effective starter IP, and bullpen exposure beside the active traffic/damage components. NEUTRAL means the required exact matchup evidence was unavailable, not that it was assumed away.",
  },
  {
    sheet: "PLAYER_INTEGRATION",
    stage: "PROJECTION",
    timing: "Every publish (Module 09)",
    purpose:
      "Per-batter lineup identity, opponent, environment, available statistics, and explicit gaps.",
    boardRelationship:
      "Audit lineage for lineup factors; it does not independently authorize a board decision.",
    readNote: "Use for player-level identity and missing-stat debugging.",
  },
  {
    sheet: "STATCAST_SHADOW_AUDIT",
    stage: "PROJECTION",
    timing: "Every publish after GAME_SUMMARY (Module 09s)",
    purpose:
      "Starter xwOBA plus estimated traffic and HR/XBH tail adjustments, with primary and sensitivity low-center challengers and an upper-tail band.",
    boardRelationship:
      "Supplies the tentative decision range and a manual low-center risk warning; it never replaces the active Module 09 total or creates authorization.",
    readNote:
      "Compare Current_Projection with Estimated_Projection; when Low_Center_Volatility_Flag is set, inspect both challengers, upper-tail band, and reason tags as distribution evidence only.",
  },
  {
    sheet: "LOW_CENTER_CALIBRATION_HISTORY",
    stage: "AUDIT",
    timing: "Append every pregame Module 09s run for low-center games",
    purpose:
      "Durable timestamped capture of the base, +1.50 primary, and +2.00 sensitivity candidates.",
    boardRelationship:
      "No board input. It prevents settlement from recreating or backdating a candidate.",
    readNote:
      "Use the latest row strictly before Scheduled_First_Pitch; later or invalid snapshots are not prospective evidence.",
  },
  {
    sheet: "LOW_CENTER_CALIBRATION_REPORT",
    stage: "SETTLEMENT",
    timing: "Every settlement after final scores arrive",
    purpose:
      "Per-game base-versus-challenger error comparison from preserved prospective candidates.",
    boardRelationship:
      "No board input. This is the promotion evidence for low-center calibration only.",
    readNote:
      "Compare Base_Abs_Error, Primary_Abs_Error, and Sensitivity_Abs_Error; do not promote a challenger from isolated results.",
  },
  {
    sheet: "COLLISION_CALIBRATION_HISTORY",
    stage: "AUDIT",
    timing: "Every legitimate pre-first-pitch Module 09s run",
    purpose:
      "One timestamped Statcast collision record per game, including traffic, damage, allocation evidence, and explicit source availability.",
    boardRelationship:
      "No board input. It freezes candidate evidence so settlement never recreates current Savant data for a completed game.",
    readNote:
      "Only PROSPECTIVE_SHADOW_CANDIDATE rows are gradable collision candidates. SOURCE_UNAVAILABLE and INSUFFICIENT_INPUT are evidence gaps, not zero signals.",
  },
  {
    sheet: "COLLISION_CALIBRATION_REPORT",
    stage: "SETTLEMENT",
    timing: "Every settlement after final scores arrive",
    purpose:
      "Base-versus-preserved-collision total, allocation, and market-direction comparison.",
    boardRelationship:
      "No board input. It is the promotion-or-retirement evidence for the collision candidate.",
    readNote:
      "Compare collision error only where a real prospective candidate exists; never draw a conclusion from an unavailable source row.",
  },
  {
    sheet: "COLLISION_REPLAY_V1",
    stage: "REPLAY",
    timing: "Every settlement after collision rows are written (Module 22)",
    purpose:
      "Aggregate base, xwOBA, traffic, damage, tail-only, and combined collision candidates by tail direction.",
    boardRelationship:
      "No board input. It compares prospective shadow candidates without changing any projection, vehicle, market, or authorization.",
    readNote:
      "Compare like-for-like N, catastrophic tails, allocation MAE, false Overs, and fragile-Under averted counts; blank legacy component allocations are evidence gaps.",
  },
  {
    sheet: "STARTER_SURVIVAL_CALIBRATION_HISTORY",
    stage: "AUDIT",
    timing: "Every pre-first-pitch Module 09t run",
    purpose:
      "Timestamped four-state starter survival/failure branch totals, probabilities, and continuous FDS diagnostics.",
    boardRelationship:
      "No board input. It is visible evidence for manual review only and cannot change projection, vehicle, market, or authorization.",
    readNote:
      "Only a snapshot strictly before Scheduled_First_Pitch is prospective. p = clamp(Projected_Starter_Innings / 9, 0, 1) is a temporary shadow default.",
  },
  {
    sheet: "STARTER_SURVIVAL_CALIBRATION_REPORT",
    stage: "SETTLEMENT",
    timing: "Every settlement after actuals arrive",
    purpose:
      "Base-versus-SSAT error, market-direction, actual starter workload, and survival grading from preserved snapshots.",
    boardRelationship:
      "No board input. It measures the challenger without backfilling it.",
    readNote:
      "Read Base_Abs_Error beside SSAT_Abs_Error and actual starter survival results; no coefficient or threshold is promoted from one slate.",
  },
  {
    sheet: "STARTER_SURVIVAL_V2_CALIBRATION_HISTORY",
    stage: "AUDIT",
    timing: "Every pre-first-pitch Module 09u run",
    purpose:
      "Empirical starter survival probability and conditional failure-severity candidate beside frozen base and SSAT v1 values.",
    boardRelationship:
      "No board input. It cannot change projection, vehicle, market, or authorization.",
    readNote:
      "Uses strictly earlier settled evidence only. If empirical history is insufficient, it records a gap rather than using the v1 IP/9 proxy.",
  },
  {
    sheet: "STARTER_SURVIVAL_V2_CALIBRATION_REPORT",
    stage: "SETTLEMENT",
    timing: "Every settlement after actuals arrive",
    purpose:
      "Preserved base-versus-v1-versus-v2 calibration comparison and starter workload grading.",
    boardRelationship:
      "No board input. It measures candidate performance without historical reconstruction.",
    readNote:
      "Read SSAT_V2 error next to v1 and base; inspect empirical cohort and failure severity before drawing a conclusion.",
  },
  {
    sheet: "STARTER_SURVIVAL_DIFFERENTIATION_AUDIT",
    stage: "AUDIT",
    timing: "Every pregame Module 09v run",
    purpose:
      "Observational v1/v2 output-correlation, difference, repeated-probability, cohort-provenance, and input-association audit.",
    boardRelationship:
      "No board input. It cannot alter either challenger, projection, vehicle, market, BET/PASS, or authorization.",
    readNote:
      "Treat v1/v2 as one SSAT evidence family. Read the total-difference metrics and repeated-probability profile before counting any apparent agreement as corroboration.",
  },

  {
    sheet: "SLATE_INPUT",
    stage: "DECISION",
    timing: "Seeded/refreshed every publish (Module 10)",
    purpose:
      "Pipeline score inputs plus operator-owned vehicle, line, odds, notes, overrides, and frozen market fields.",
    boardRelationship:
      "Direct decision input to Module 11. Operator edits only O–W; authoritative pregame fields are pipeline-owned.",
    readNote:
      "Authoritative_Pregame_Total outranks the display/live Line after freeze.",
  },
  {
    sheet: "SLATE_BOARD",
    stage: "DECISION",
    timing: "Every publish for still-mutable games (Module 11)",
    purpose:
      "Full current-slate decision output, scores, projection, market comparison, blockers, survival gate, and lock state.",
    boardRelationship: "This is the complete decision board.",
    readNote:
      "Read Projection, line, tentative range, Decision, blocker, lock status, and lineage together.",
  },
  {
    sheet: "ACTIVE_BOARD_SNAPSHOT",
    stage: "DECISION",
    timing: "Every publish (Module 11)",
    purpose: "Condensed view of currently authorized board entries.",
    boardRelationship:
      "Filtered operational view of SLATE_BOARD; it does not create authorization.",
    readNote:
      "Use for quick execution only after verifying the full board and lock state.",
  },
  {
    sheet: "BOARD_LOCK_STATE",
    stage: "AUDIT",
    timing: "Created/updated per game at lock (Module 11)",
    purpose:
      "Immutable record of the single authoritative final authorization and lock provenance.",
    boardRelationship:
      "Records the board decision; it must never calculate an independent decision.",
    readNote:
      "Use to resolve any disagreement between displayed decision surfaces.",
  },
  {
    sheet: "VEHICLE_LOG",
    stage: "AUDIT",
    timing: "Published/frozen after Module 11 (Module 17 phase 1)",
    purpose:
      "Immutable prospective vehicle, projection, market line, direction, and decision record.",
    boardRelationship:
      "Freezes what SLATE_BOARD actually published for later settlement.",
    readNote:
      "This—not a later recalculation—is the historical prediction source.",
  },
  {
    sheet: "PREGAME_PACKET_HISTORY",
    stage: "AUDIT",
    timing: "Every legitimate pre-first-pitch publish (Module 20a)",
    purpose:
      "One atomic packet containing the exact projection, allocation, market state, starter/bullpen, lineup, environment, collision, low-center, and survival dependencies available before first pitch.",
    boardRelationship:
      "Preserves provenance for settlement and replay; it cannot change the board, market, vehicle, or authorization.",
    readNote:
      "OPEN_PROSPECTIVE may refresh only before first pitch. FROZEN_PREGAME is immutable. MARKET_SNAPSHOT_MISSING is an explicit research gap, never a replacement market line.",
  },
  {
    sheet: "OPERATOR_EVIDENCE_OVERLAY",
    stage: "PREGAME_INPUT",
    timing:
      "Operator enters a timestamped field before first pitch; Module 20b captures it on publish",
    purpose:
      "Durable source-governance input for explicitly supplied lineup, pitcher role, venue, weather, bullpen, umpire, and executable-market facts.",
    boardRelationship:
      "Records authoritative operator evidence for the named field only; it does not silently alter the live projection, board, or authorization.",
    readNote:
      "One row = one field. Use Source MANUAL_OPERATOR and an ISO Supplied_TS strictly before first pitch. Blank fields change nothing.",
  },
  {
    sheet: "FULL_LADDER_AUDIT",
    stage: "AUDIT",
    timing:
      "Module 20b mirrors each legitimate packet; freezes at first pitch; settlement appends grades",
    purpose:
      "Price-blind manual full-game total ladder: run band, executable half-number lines, selected vehicle, PASS/BET reasoning, and settlement counterfactuals.",
    boardRelationship:
      "Shadow-only decision evidence. It cannot create a wager, modify a projection, or authorize BET/PASS.",
    readNote:
      "Fill ladder values through OPERATOR_EVIDENCE_OVERLAY before first pitch. Frozen records are immutable; NO_WAGER_REPORTED stays distinct from a vehicle grade.",
  },
  {
    sheet: "DECISION_AUDIT_LOG",
    stage: "AUDIT",
    timing:
      "Pregame update/freeze on publish; settlement append later (Module 20)",
    purpose:
      "Model state, manual overlay, reasoning source, authorization, result, and independent grading.",
    boardRelationship:
      "Consumes the authoritative decision; tracks why it was authorized or passed.",
    readNote:
      "OPEN fields may update; frozen pregame fields must not change after lock.",
  },

  {
    sheet: "SHADOW_VALIDATION",
    stage: "AUDIT",
    timing: "Every publish after Module 09 (Module 12s)",
    purpose: "Current-slate repaired-versus-legacy projection comparison.",
    boardRelationship: "Validation only; no authorization influence.",
    readNote: "Use to detect unexpected projection drift during commissioning.",
  },
  {
    sheet: "SHADOW_HISTORY",
    stage: "AUDIT",
    timing: "Append on every publish (Module 12s)",
    purpose: "Historical accumulation of SHADOW_VALIDATION snapshots.",
    boardRelationship:
      "No direct board influence; preserves commissioning change history.",
    readNote: "Use for time-series drift, not the current executable board.",
  },
  {
    sheet: "RUN_LOG",
    stage: "AUDIT",
    timing: "Append at the end of every publish (Module 12)",
    purpose:
      "Run ID, schema, module status, counts, validation, errors, warnings, and source observability.",
    boardRelationship:
      "Certifies whether the board-producing run completed semantically.",
    readNote:
      "Read first after every workflow; a green workflow is insufficient if this row is partial or stale.",
  },

  {
    sheet: "SHADOW_OUTCOMES",
    stage: "SETTLEMENT",
    timing: "Daily settlement (Module 14)",
    purpose:
      "One row per game with frozen projection, final score, errors, direction, and pitcher provenance.",
    boardRelationship:
      "Grades the preserved prospective board state without rerunning it.",
    readNote:
      "Primary settled truth table; verify projection source is frozen/published.",
  },
  {
    sheet: "ALLOCATION_SETTLEMENT_DIAGNOSTICS",
    stage: "SETTLEMENT",
    timing: "Daily settlement after frozen-packet verification (Module 24)",
    purpose:
      "Separate away/home/total/margin errors and raw team-allocation reversals.",
    boardRelationship:
      "Diagnostic only; never converts a settlement result into a live allocation coefficient.",
    readNote:
      "Use with the total error: a good total can conceal a reversed allocation.",
  },
  {
    sheet: "STARTER_OUTCOME_DIAGNOSTICS",
    stage: "SETTLEMENT",
    timing: "Daily settlement after official boxscore retrieval (Module 24)",
    purpose:
      "Starter workload, traffic, contact availability, damage, run prevention, K/whiff, and exit-inning evidence for each side.",
    boardRelationship:
      "Diagnostic only; a workload shortfall is not a live Over signal or generic failure label.",
    readNote:
      "Read WORKLOAD, TRAFFIC, DAMAGE, and RUN PREVENTION separately before diagnosing starter paths.",
  },
  {
    sheet: "BULLPEN_TIMING_DIAGNOSTICS",
    stage: "SETTLEMENT",
    timing: "Daily settlement after official linescore retrieval (Module 24)",
    purpose:
      "Starter-window versus bullpen and inning-band scoring shape, actual bullpen chain, and explicit evidence of whether a named pregame leverage plan was available to compare.",
    boardRelationship:
      "Diagnostic only; it captures a transition without assigning bullpen coefficients.",
    readNote:
      "Compare starter-exit, post-exit runs, actual chain, 1-3/4-6/7+ runs, and extras before calling a game a bullpen failure. A named bridge is NOT_EVALUABLE when it was not frozen pregame.",
  },
  {
    sheet: "CONVERSION_SETTLEMENT_DIAGNOSTICS",
    stage: "SETTLEMENT",
    timing:
      "Daily settlement from frozen packet plus official team boxscore (Module 24)",
    purpose:
      "Team-level traffic, damage, and realized-conversion evidence alongside the frozen collision signal and allocation.",
    boardRelationship:
      "Diagnostic only; it cannot turn traffic, damage, or conversion into an active run adjustment.",
    readNote:
      "Read baserunners, HR/XBH, runs per baserunner, and the frozen traffic flag together. MLB boxscore contact fields remain explicit gaps.",
  },
  {
    sheet: "GAME_TRUTH_REPLAY_V1",
    stage: "REPLAY",
    timing:
      "Daily settlement after frozen packet and postgame diagnostics (Module 24)",
    purpose:
      "Joined game-truth replay for total center, allocation, starter paths, bullpen timing, conversion outcomes, and observed scoring mechanism.",
    boardRelationship:
      "Shadow-only diagnosis. It creates no replacement projection, vehicle, BET/PASS result, or coefficient.",
    readNote:
      "Use the separate center, allocation, starter, bullpen, and conversion fields to identify the failed link before proposing a challenger.",
  },
  {
    sheet: "DISTRIBUTION_WIDTH_REPLAY_V1",
    stage: "REPLAY",
    timing:
      "Daily settlement after GAME_TRUTH_REPLAY_V1 refresh (Module 25)",
    purpose:
      "One frozen-packet research row per settled game, joining conditional uncertainty evidence to total, starter-window, bullpen-window, and allocation error.",
    boardRelationship:
      "Research-only. It cannot change a projection, run band, coefficient, vehicle, price, or BET/PASS result.",
    readNote:
      "Compare pregame bullpen exposure, starter pressure shortfall, SSAT-family spread, collision, low-center, and allocation separation with the observed error fields. Missing evidence stays blank rather than neutral.",
  },
  {
    sheet: "DISTRIBUTION_WIDTH_REPLAY_SUMMARY",
    stage: "REPLAY",
    timing:
      "Rebuilt with Distribution Width Replay during daily settlement (Module 25)",
    purpose:
      "Raw feature-to-error correlation table for conditional variance research, with each result's own eligible sample size.",
    boardRelationship:
      "No operational role. Correlation is descriptive evidence, not a threshold, promotion, or decision gate.",
    readNote:
      "Start with Eligible_N; then inspect the correlation against total, starter-window, bullpen-window, and allocation error before proposing any distribution change.",
  },
  {
    sheet: "FAILURE_CLASSIFICATION_SHADOW_V1",
    stage: "REPLAY",
    timing:
      "Every legitimate pre-first-pitch publish, then packet finalization (Module 26)",
    purpose:
      "Price-blind structural labels for opener-chain uncertainty, starter-versus-bullpen scoring dependence, and traffic/damage evidence. The label is tied to the same pregame packet used for settlement.",
    boardRelationship:
      "Shadow-only. It cannot alter a projection, market line, vehicle, BET/PASS result, confidence, or authorization.",
    readNote:
      "A known opener is not a known relief chain; traffic and damage are not conversion; a bullpen-dependent path is not a prediction of bullpen damage.",
  },
  {
    sheet: "FAILURE_CLASSIFICATION_REPLAY_V1",
    stage: "REPLAY",
    timing:
      "Daily settlement after GAME_TRUTH_REPLAY_V1 refresh (Module 26)",
    purpose:
      "Joins frozen structural labels to settled total error, starter/bullpen timing, allocation, and conversion outcomes so proof and anti-proof cases can be measured prospectively.",
    boardRelationship:
      "Research-only. No label creates a threshold, a center correction, or an automatic veto.",
    readNote:
      "Read label frequencies and outcomes alongside sample size. Do not turn one opener game, one bullpen collapse, or one market improvement into a global rule.",
  },
  {
    sheet: "FULL_LADDER_SETTLEMENT",
    stage: "SETTLEMENT",
    timing: "Daily settlement for frozen FULL_LADDER_AUDIT rows (Module 24)",
    purpose:
      "Counterfactual result for every frozen available half-number threshold plus selected/adjacent vehicle grades.",
    boardRelationship:
      "No board input and no wager inference; price remains execution metadata only.",
    readNote:
      "Use to distinguish direction failure, threshold failure, clean capture, and right-total/wrong-mechanism cases.",
  },
  {
    sheet: "PROJECTION_REPLAY",
    stage: "SETTLEMENT",
    timing: "Daily settlement (Module 14)",
    purpose: "Frozen-published projection replay against actual results.",
    boardRelationship:
      "Measures the board that existed pregame, not a repaired postgame estimate.",
    readNote: "Use for per-game error and frozen-versus-repaired comparison.",
  },
  {
    sheet: "VEHICLE_POSTMORTEM",
    stage: "SETTLEMENT",
    timing: "After outcomes (Module 17 phase 2)",
    purpose:
      "Ticket, thesis, capture, blocker, and failure/survival grading by game.",
    boardRelationship:
      "Grades the selected vehicle and authorization separately from the raw projection.",
    readNote:
      "A push is neutral and a passed winner is not automatically a bad pass.",
  },
  {
    sheet: "SURVIVAL_GATE_REPLAY",
    stage: "SETTLEMENT",
    timing: "Settlement/replay (Module 18)",
    purpose:
      "Re-grades Over candidates through the component survival floor with provenance.",
    boardRelationship:
      "Audits one authorization gate; it does not rewrite the historical board.",
    readNote:
      "Use to separate environment-manufactured Overs from baseball-supported Overs.",
  },
  {
    sheet: "STARTER_AUDIT",
    stage: "SETTLEMENT",
    timing: "After settlement (Module 16)",
    purpose: "Starter-level projection accuracy and provenance summary.",
    boardRelationship:
      "Learning surface only; starters cannot independently define game truth.",
    readNote:
      "Compare survival and failure paths across samples, not one result.",
  },
  {
    sheet: "REGRESSION_REPORT",
    stage: "SETTLEMENT",
    timing: "After settlement or explicit regression run (Module 15)",
    purpose:
      "MAE, median error, bias, miss rate, over/under projection rates, and windows.",
    boardRelationship:
      "Controls evidence about model reliability; does not rewrite a prior board.",
    readNote:
      "Separate total accuracy from allocation and direction before tuning.",
  },
  {
    sheet: "MONOTONICITY",
    stage: "SETTLEMENT",
    timing: "With regression report (Module 15)",
    purpose:
      "Tests whether larger frozen projection edges produce better directional results by side and tier.",
    boardRelationship:
      "Authorization governance reads its verdict; low samples must fail closed.",
    readNote: "Check sample size before trusting a PASS verdict.",
  },
  {
    sheet: "MONOTONICITY_V2",
    stage: "REPLAY",
    timing: "Every settlement (Module 23)",
    purpose:
      "Shadow-only pooled edge-magnitude calibration by OVER/UNDER with fixed-tier-free reliability regions and explicit evidence state.",
    boardRelationship:
      "No board input. UNVERIFIED receives no edge credit and is never a blocker; V1 authorization remains live until separately commissioned.",
    readNote:
      "Compare direction-specific state, confidence intervals, pooled regions, and V1/V2 blocked winner-loser counts before proposing any gate change.",
  },
  {
    sheet: "MONOTONICITY_V2_REPLAY",
    stage: "REPLAY",
    timing: "Every settlement (Module 23)",
    purpose:
      "One frozen record per eligible settled decision comparing the historical V1 wall, a no-V1-gate counterfactual, and V2 shadow policy.",
    boardRelationship:
      "No board input. It preserves that a V1 block is historical fact while V2 is counterfactual evidence only.",
    readNote:
      "Use this to identify V1 suppressed winners, V1 saved losers, and whether V2 would merely withhold edge credit or flag anti-monotonic evidence.",
  },

  {
    sheet: "REPLAY_RESULTS",
    stage: "REPLAY",
    timing: "Explicit historical replay only (Module 13)",
    purpose:
      "Date-anchored baseline-versus-candidate game results with historical environment provenance.",
    boardRelationship:
      "Offline candidate evaluation; never substitutes for a prospective board record.",
    readNote: "Missing historical weather must remain flagged and neutral.",
  },
  {
    sheet: "REPLAY_METRICS",
    stage: "REPLAY",
    timing: "Each historical replay (Module 13)",
    purpose:
      "Aggregate metrics for baseline and candidate variants, including calibration and direction where lines exist.",
    boardRelationship:
      "Supports commissioning decisions, not game authorization.",
    readNote: "Compare variants on multiple metrics and bands, not MAE alone.",
  },

  {
    sheet: "SCHEMA_REFERENCE",
    stage: "META",
    timing: "Schema repair/settlement documentation step",
    purpose:
      "Generated column dictionary with type, format, ownership, and description.",
    boardRelationship: "Documentation only.",
    readNote: "Use when a column name or ownership rule is unclear.",
  },
  {
    sheet: "MODEL_INPUT_CATALOG",
    stage: "META",
    timing: "Every schema repair; current source materialization attached on every pregame publish",
    purpose:
      "Canonical source, statistical-window, game-window, freshness, projection-class, and missing-behavior registry for active math, shadows, frozen snapshots, aliases, display-only fields, and known gaps.",
    boardRelationship:
      "Documentation and source-health only. It cannot change projection, market comparison, vehicle, or BET/PASS output.",
    readNote:
      "Use before adding or trusting a statistic: verify ACTIVE versus SHADOW_ONLY/DISPLAY_ONLY, the correlation family, source cadence, freshness surface, and fallback behavior.",
  },
  {
    sheet: "README",
    stage: "META",
    timing: "Schema repair/settlement documentation step",
    purpose:
      "Workbook orientation, schema version, quick read order, roadmap summaries, and operating cautions.",
    boardRelationship: "Documentation only.",
    readNote: "Start here when returning after time away.",
  },
];

export function buildWorkbookRoadmapReadmeRows(): string[][] {
  return WORKBOOK_ROADMAP.map((entry) => [
    `Tab_${entry.sheet}`,
    `${entry.stage} | ${entry.timing} | ${entry.purpose} Board: ${entry.boardRelationship} Read: ${entry.readNote}`,
  ]);
}
