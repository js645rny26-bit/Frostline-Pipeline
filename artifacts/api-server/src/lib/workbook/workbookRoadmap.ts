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
    sheet: "SOURCE_ACQUISITION_LOG",
    stage: "META",
    timing: "Append before a newly connected external source can fill an active input gap",
    purpose:
      "Immutable source provenance: request, pregame cutoff, response hash, parser contract, coverage, status, fallback, and raw-storage state.",
    boardRelationship:
      "No direct board input. A retained valid source may support a documented active family; retention failure excludes that source from the run.",
    readNote:
      "Verify STORED raw state, schema status, data-through date, and MLBAM coverage before interpreting a source-derived fallback.",
  },
  {
    sheet: "SOURCE_RAW_SNAPSHOT",
    stage: "META",
    timing: "Append with SOURCE_ACQUISITION_LOG for each new retained response",
    purpose:
      "Chunked untouched response bytes keyed by Snapshot_ID for parser audit and reproducible feature engineering.",
    boardRelationship:
      "Never a board or projection input directly; it is provenance evidence for the source that produced one.",
    readNote:
      "Concatenate chunks by Snapshot_ID and Chunk_Index only when auditing an exact retained source response.",
  },
  {
    sheet: "BVH_DAILY_HISTORY_V1",
    stage: "AUDIT",
    timing: "Append after each retained Savant pitch-level daily response (Module 02j)",
    purpose:
      "PA-correct daily batter-versus-pitcher-hand outcome counts with immutable source snapshot lineage.",
    boardRelationship:
      "No direct board input. It is the compact cutoff-safe evidence ledger from which current BVH splits are rebuilt.",
    readNote:
      "Audit PA rather than pitch counts, source snapshot identity, and date cutoff before trusting a split.",
  },
  {
    sheet: "BVH_BATTER_SPLITS_V1",
    stage: "AUDIT",
    timing: "Rebuild every pregame run from canonical BVH daily history (Module 02j)",
    purpose:
      "Raw vs-hand OBP/SLG/OPS, PA, prior, fixed-k shrinkage, status, freshness, parser counters, and deterministic hash for every batter.",
    boardRelationship:
      "Populates TODAY_LINEUPS split evidence. It cannot create an independent run bonus or decision.",
    readNote:
      "Read raw PA, prior source, shrinkage weight, freshness, and status beside every shrunk OPS.",
  },
  {
    sheet: "BVH_PROJECTION_HISTORY_V1",
    stage: "AUDIT",
    timing: "Append for every legitimate pre-first-pitch projection snapshot (Module 09b)",
    purpose:
      "Preserves the active coarse-hand control versus shadow-only BVH team runs and the exact starter-window evidence, coverage, hand, and cutoff lineage.",
    boardRelationship:
      "BVH is shadow-only and cannot feed the price-blind projection or board. The coarse handedness path remains active; neither path reads market evidence.",
    readNote:
      "Use for regression and manual high-delta review; opener-chain uncertainty and missing identities must remain visible.",
  },
  {
    sheet: "BVH_PROJECTION_REPLAY_V1",
    stage: "SETTLEMENT",
    timing: "Every settlement after allocation diagnostics (Module 31)",
    purpose:
      "Grades only prospectively frozen BVH counterfactual team/total projections against canonical team scores.",
    boardRelationship:
      "No board input. Missing pregame BVH evidence is never reconstructed at settlement.",
    readNote:
      "Inspect total and allocation deltas together; REVIEW_REQUIRED is a manual-review threshold, not a promotion signal.",
  },
  {
    sheet: "BVH_PROJECTION_SUMMARY_V1",
    stage: "SETTLEMENT",
    timing: "Every settlement after BVH replay (Module 31)",
    purpose:
      "Summarizes existing-versus-BVH center and team-allocation error for declared coverage, hand, and chain cohorts.",
    boardRelationship:
      "Research only; no row changes projections, vehicles, markets, or authorization.",
    readNote:
      "Treat N<200 descriptively. At N=200 run the declared paired review and acceptance checks; the checkpoint starts a promotion decision and never promotes automatically.",
  },
  {
    sheet: "SWE_APPEARANCE_HISTORY_V1",
    stage: "AUDIT",
    timing: "Append on each retained Savant pitch-level refresh (Module 02i)",
    purpose:
      "Source-derived pitcher appearances with exact pitch counts, batters faced, reconstructed outs, innings, start flag, and explicit unresolved-outs state for Starter Workload Estimator V1.",
    boardRelationship:
      "Shadow-only source evidence. It cannot feed the active Expected_IP lookup, projection, survival, market, or authorization paths.",
    readNote:
      "Use to audit source coverage and the strict pregame cutoff. OUTS_UNRESOLVED is an exclusion, never a zero-inning imputation.",
  },
  {
    sheet: "SWE_WORKLOAD_REPLAY_SUMMARY_V1",
    stage: "REPLAY",
    timing: "Every settlement after starter diagnostics (Module 30)",
    purpose:
      "Role-separated workload research. Conventional starters test predicted versus actual deviation from the 6.0-IP role baseline; MAE, RMSE, bias, and Wilcoxon remain secondary diagnostics.",
    boardRelationship:
      "No board input. A positive result can only propose a separate promotion review; it cannot change today’s innings or decision output.",
    readNote:
      "Do not interpret correlation below 150 conventional starters or before the pre-cutoff actual-IP variance floor is frozen. Opener and bulk rows answer separate hypotheses.",
  },
  {
    sheet: "SWE_WORKLOAD_DEVIATION_V1",
    stage: "REPLAY",
    timing: "Every settlement after starter diagnostics (Module 30)",
    purpose:
      "Per-starter audit of SWE, active baseline, actual innings, and conventional-only predicted/actual deviations and ranks.",
    boardRelationship:
      "Research only. It cannot feed Expected_IP, bullpen exposure, projection, vehicle, or authorization paths.",
    readNote:
      "Use CONVENTIONAL_STARTER rows for personalization discrimination. Atypical roles intentionally leave deviation/rank fields blank and remain separately graded.",
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
      "Timestamped four-state starter survival/failure branch totals, probabilities, continuous FDS diagnostics, and frozen pregame starter roles for prospective V2 role-cohort training.",
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
      "Empirical starter survival probability and conditional workload-failure severity candidate beside frozen base and SSAT v1 values. Failure_Run_Cost is DORMANT_UNCONSUMED metadata, not a scenario input.",
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
      "One atomic packet containing the exact projection, allocation, market state, starter/bullpen, lineup, environment, collision, low-center, survival dependencies, and pre-registered separation-research provenance available before first pitch.",
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
    sheet: "DISTRIBUTION_BENCHMARK_V1",
    stage: "REPLAY",
    timing:
      "Daily settlement after GAME_TRUTH_REPLAY_V1 refresh (Module 28)",
    purpose:
      "Per-game expanding-window benchmark of price-blind total-run distributions: Negative Binomial with MLE dispersion, Poisson, and an empirical residual comparator.",
    boardRelationship:
      "Research-only. It cannot change the published center, create a band, alter a market view, select a vehicle, or affect BET/PASS or authorization.",
    readNote:
      "Verify Training_Through_Date and Prior_Settled_Games first. Every evaluation uses only earlier settled frozen games; insufficient-history rows are visible rather than estimated.",
  },
  {
    sheet: "DISTRIBUTION_BENCHMARK_SUMMARY",
    stage: "REPLAY",
    timing:
      "Rebuilt with the distribution benchmark during daily settlement (Module 28)",
    purpose:
      "Walk-forward CRPS, log loss, deterministic discrete mid-PIT, 50/80/90 interval coverage, and Brier score at each frozen queried threshold for every comparator.",
    boardRelationship:
      "Research-only. No score, coverage rate, or PIT value is an automatic calibration or promotion decision.",
    readNote:
      "Read the self-reported eligible N and frozen threshold provenance before comparing a metric. The market query evaluates probability only; it never enters the fit or location.",
  },
  {
    sheet: "DISTRIBUTION_BENCHMARK_PAIRS",
    stage: "REPLAY",
    timing:
      "Rebuilt with the distribution benchmark during daily settlement (Module 28)",
    purpose:
      "Within-game paired CRPS, log-loss, and queried-threshold Brier comparisons among NB, Poisson, and empirical residual distributions.",
    boardRelationship:
      "Research-only. Paired sign-test evidence cannot tune dispersion, alter a run band, or create any operational authority.",
    readNote:
      "Use paired N, ties, score direction, and the two-sided sign-test result together; neither an isolated p-value nor a point estimate promotes a model.",
  },
  {
    sheet: "GAME_TRUTH_DISTRIBUTION_V2",
    stage: "REPLAY",
    timing: "Daily settlement after GAME_TRUTH_REPLAY_V1 refresh (Module 29)",
    purpose:
      "Direct-total distribution research comparing Poisson, NB, zero-hurdle NB, mean-parameterized COM-Poisson, and empirical residual forms against the same frozen price-blind center.",
    boardRelationship:
      "Research-only. It cannot change a center, create a live band, alter a market view, select a vehicle, or affect BET/PASS or authorization.",
    readNote:
      "Start with Training_Through_Date, Prior_Settled_Games, and Shape_Parameter_Status. A zero-hurdle model with zero training support is an explicit comparator limitation, not low-run evidence.",
  },
  {
    sheet: "GAME_TRUTH_DIST_LINES_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "Standard total-line probabilities and settlement-only Brier evidence derived monotonically from each one frozen research PMF.",
    boardRelationship:
      "No operational relationship. Standard lines are grading queries, not separate betting classifiers or price inputs.",
    readNote:
      "For one Game_ID and Model, probabilities must decline as the standard total line increases. Compare Brier only after checking its eligible N.",
  },
  {
    sheet: "GAME_TRUTH_DIST_SUMMARY_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "Non-randomized count-PIT, secondary deterministic randomized-PIT, proper-score, directional interval-escape, threshold-weighted CRPS, and standard-line Brier summaries, plus sample-size constraints and the recorded no-promotion protocol.",
    boardRelationship:
      "Research-only. This is calibration evidence, not a coefficient or distribution-model selection rule.",
    readNote:
      "Read non-randomized count PIT as the primary view: a U shape means too narrow, a dome too wide, and a slope center bias. At the current sample it is a diagnostic, not a calibration certificate.",
  },
  {
    sheet: "GAME_TRUTH_DIST_PAIRS_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "Within-game paired CRPS, log-score, and posted-region twCRPS evidence among all direct-total research comparators, with slate-date block-bootstrap intervals and a secondary HLN-DM cross-check where applicable.",
    boardRelationship:
      "Research-only. The paired sign test is neither a promotion rule nor a model-selection or authorization input.",
    readNote:
      "Block-bootstrap intervals are primary because games on a slate can co-move. Nested pair HLN-DM values are intentionally unavailable; small-N differences remain ambiguous rather than selecting a model.",
  },
  {
    sheet: "GAME_TRUTH_DIST_CORP_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "CORP-style, PAV/isotonic per-line reliability curves, numerical Brier miscalibration evidence, and whole-slate bootstrap consistency intervals.",
    boardRelationship:
      "Research-only. It does not recalibrate probabilities or influence any center, distribution, market, vehicle, BET/PASS, or authorization state.",
    readNote:
      "PAV groups are data-adaptive rather than arbitrary bins. Read their bootstrap bands and sample size before interpreting any apparent calibration curve.",
  },
  {
    sheet: "GAME_TRUTH_DIST_FEATURE_GOV_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "Predeclared, price-blind mean versus variance/tail governance for candidate structural features, including evidence level, available frozen data, test design, and exclusion guardrails.",
    boardRelationship:
      "No operational relationship. This is not a live feature registry and cannot add a covariate to any production calculation.",
    readNote:
      "Use it to keep evidence-backed candidates, prospective hypotheses, and rejected sequencing/noise features separate before any distributional regression is attempted.",
  },
  {
    sheet: "GAME_TRUTH_SLATE_DIAG_V2",
    stage: "REPLAY",
    timing: "Rebuilt with direct-total distribution research during daily settlement (Module 29)",
    purpose:
      "Per-slate test of aggregate frozen run volume versus individual-game allocation of low, central, and high outcomes.",
    boardRelationship:
      "Research-only. It cannot recenter a slate or change an individual game projection.",
    readNote:
      "Compare aggregate error with per-game MAE/RMSE and rank association. A close slate total does not establish useful game-level tail placement.",
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
      "A known opener is not a known relief chain; traffic and damage are not conversion; traffic-only and damage-only support are asymmetric fragility states, not directional run changes; bullpen-dependent path is not a prediction of bullpen damage.",
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
      "Read warning quadrants and false-negative rows with sample size. Do not turn one opener game, one bullpen collapse, or one market improvement into a global rule.",
  },
  {
    sheet: "FAILURE_CLASSIFICATION_DISCRIMINATION_V1",
    stage: "REPLAY",
    timing:
      "Rebuilt with Failure Classification Replay during daily settlement (Module 26)",
    purpose:
      "Shows whether each frozen classification family actually discriminates center error, 4+ run research misses, reference-market directional results, and starter/bullpen scoring mechanisms.",
    boardRelationship:
      "Research-only. A classification's precision, recall, or miss rate does not create a live penalty, blocker, threshold, or center correction.",
    readNote:
      "Use eligible N before interpreting rates. Compare traffic+damage, traffic-only, damage-only, and neither/unavailable; inspect warned/no-warning quadrants so both false positives and false negatives remain visible.",
  },
  {
    sheet: "SEPARATION_GATE_AUDIT_V1",
    stage: "REPLAY",
    timing:
      "Daily settlement after GAME_TRUTH_REPLAY_V1 refresh (Module 27)",
    purpose:
      "Pre-registered frozen-packet study of whether continuous projection separation improves directional reliability inside a fixed price-blind structural cohort.",
    boardRelationship:
      "Shadow-only. It observes the existing 1.5 rule but cannot change a projection, market, confidence, vehicle, BET/PASS state, or authorization threshold.",
    readNote:
      "Reference-only rows are research evidence, not literal Hard Rock calibration evidence. Read the frozen structural eligibility and exact line provenance before comparing any cohort.",
  },
  {
    sheet: "SEPARATION_GATE_AUDIT_SUMMARY_V1",
    stage: "REPLAY",
    timing:
      "Rebuilt with Separation Gate Audit during daily settlement (Module 27)",
    purpose:
      "Fixed-bin and adjacent-boundary Wilson-interval summary for structural-eligible frozen observations, split between literal Hard Rock half totals and reference-only research.",
    boardRelationship:
      "Research-only. No sample count or rate relaxes the 1.5 authorization boundary without a separate commissioning decision.",
    readNote:
      "Compare 1.25-1.49 with 1.50-1.74 only after meaningful prospective samples exist. Probability calibration fields remain explicitly unavailable until a future probability layer exists.",
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
