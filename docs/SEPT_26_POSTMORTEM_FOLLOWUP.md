# Sept. 26 Postmortem / Pipeline Follow-up

Status: **SHADOW / RESEARCH ONLY**
Projection or authorization consumer: **NONE**

## Authoritative workbook readback

The Commissioning Shadow workbook remained on schema v78 during this code/test
turn; no direct workbook write or artificial publication was performed. Direct
readback found five successful Sept. 26 runs ending with
`RUN_20260926233815577`, all with validation `PASS` and zero critical failures.
`SHADOW_OUTCOMES` and `DECISION_AUDIT_LOG` each contain exactly 13 settled
Sept. 26 Game_IDs. All 13 executable-market fields are blank, so operator grades
are `UNGRADABLE`; the populated Starting Nine lines remain reference research
only. Existing frozen projections, decisions, outcomes, and human fields were
not changed.

## Preserved baseline

The settled 13-game Sept. 26 slate remains immutable:

| Layer | Direction vs prospectively supplied operator line | MAE | Bias |
| --- | ---: | ---: | ---: |
| Frostline | 7-6 | 3.486 | -1.934 |
| Human | 6-7 | 3.815 | -2.200 |

Frozen human mechanism review: 7 `CONFIRMED`, 6 `FAILED`.

These figures are comparison evidence, not coefficient targets. No projection,
decision, confidence, or authorization weight is changed by this work.

## Presentation and identity contract

- Every stored or exported game uses the date-qualified `Game_ID`, for example
  `20260926_TBR_PHI`. Readable prose may additionally say
  `2026-09-26 TBR @ PHI`; a bare matchup is never the sole identifier.
- Future `REPLAY_RESULTS` rebuilds emit the same canonical form. The legacy
  `YYYY-MM-DD_AWAY@HOME` parser remains only as a backward-compatible odds-join
  reader; it is not the default display format.
- `VEHICLE_POSTMORTEM` remains the default compact one-row-per-game settlement
  view. Its original columns remain in place and the appended compact fields
  show final score, separated market provenance, model/human point results,
  allocation, mechanism grade, and one primary miss.
- Long prose is reserved for a genuinely new repeated structural result.

## Market boundary

The reference market remains the standing research benchmark. A persisted
operator/executable line is a distinct object. Operator direction is
`UNGRADABLE` when that object is absent; reference lines are never silently
substituted into an operator scoreboard.

## Prospective human truth

Beginning after Sept. 26, a new canonical human read must carry:

- `Workbook_Exposure_Status`: `WORKBOOK_BLIND` or `WORKBOOK_EXPOSED`;
- `Market_Exposure_Status`: `PRICE_BLIND` or `MARKET_EXPOSED`;
- `Human_Context_Mode`: `BASEBALL_ONLY`.

`BASEBALL_ONLY` means the human P50/allocation can use confirmed lineup,
offense/contact/damage/conversion, starter role/workload/survival, bullpen
state/deployment, and script interaction. It cannot numerically consume park,
weather, roof, umpire, or market inputs. The object freezes and hashes before
workbook and market reveal. New pregame baseball information creates a new
prospective version; no post-first-pitch backfill is allowed.

The existing `Manual_Away_Run_View`, `Manual_Home_Run_View`,
`Manual_Total_View`, `Manual_Confidence`, and `Freeze_TS` columns remain the
numeric/timestamp carriers. The new fields do not duplicate them. Sept. 25 V1
hashes and Sept. 26 human P50s are not rewritten.

Human/model agreement is descriptive only. The compact postmortem API returns
separate agreement/disagreement cohort N, directional accuracy, MAE, and bias
using the reference line as a research benchmark. The summary is explicitly
`RESEARCH_ONLY_NO_AUTHORIZATION_WEIGHT`.

## Research-only season phase

`GAME_TRUTH_REPLAY_V1.Season_Phase_Tag` supports:

- `NORMAL_REGULAR_SEASON`
- `SEPTEMBER_EXPANDED_ROSTER`
- `POSTSEASON`

The tag has zero active impact. September regular-season games are identified
from the date. `POSTSEASON` requires an official MLB game-type value; until
that field is carried into the frozen packet, postseason tagging is available
to fixture/replay callers but is an upstream observability limitation.

## Named replay fixtures

| Game_ID | Required lesson |
| --- | --- |
| `20260926_NYM_WSN` | A close total must not imply correct phase shape. |
| `20260926_TEX_MIN` | An accurate P50 must not auto-confirm the mechanism. |
| `20260926_ARI_SDP` | Audit starter identity, workload, and bullpen state together. |
| `20260926_STL_MIL` | Expected continuation is a probability, not guaranteed scoring. |

## `20260926_ARI_SDP` observability audit

The final frozen packet used Ryne Nelson. Settlement records Taylor Clarke as
the actual starter. The frozen packet was produced about 62 minutes before
first pitch from an MLBAM-verified Starting Nine team-page observation, and
the retained page snapshot still named Nelson. The current retained source
chronology does not prove that a later authoritative pregame source named
Clarke before the final refresh.

Therefore the case remains:

`STARTER_IDENTITY_OBSERVABILITY_UNRESOLVED`

It must not calibrate Ryne Nelson performance parameters. It becomes
`DATA_INTEGRITY / STARTER_IDENTITY_MISS` only if timestamped authoritative
evidence later proves Clarke was observable before a refresh opportunity.
Otherwise it remains an unpreventable prospective information miss. No
postgame identity is substituted into the frozen packet.

## Bullpen-state finding

The large Sept. 26 bullpen-window errors reinforce the existing workload,
deployment-state, transition-probability, and conditional-severity research.
They do not authorize a global bullpen run increase.
