# Frostline Single-Point Game Truth Contract v1 — Test Commissioning

Status: **TEST COPY ONLY / NOT COMMISSIONED**  
Production authorization: **NOT GRANTED**  
Active projection or decision consumer: **NONE**

## Purpose

This commissioning surface tests a single immutable human point forecast without changing Frostline's production projection, decision, authorization, distribution, or market logic.

The governing separation is:

- one `Human_Total_P50` owns primary point accuracy;
- Module 29 owns distribution uncertainty;
- the frozen mechanism owns causal explanation;
- Module 33 owns prospective team-allocation research.

No new numbered module is introduced. The deterministic implementation is an inactive Module 20b supporting component.

## Test workbook

The disposable copy is:

`Official Frostline Engine - Prediction Contract Test Copy 2026-09-25`

Spreadsheet ID: `1tWDC6-8gVJjRPoS4MZTTGvX9lP3g4XZHM98rWmxF1KA`

Only the copy was changed. The authoritative workbook was not written.

The test copy extends existing surfaces:

- `FULL_LADDER_AUDIT`: canonical freeze fields in columns `Y:AU` and explicitly post-freeze market comparison fields in `AV:BD`;
- `VEHICLE_POSTMORTEM`: deterministic point/allocation/mechanism settlement fields in columns `T:AQ`.

No new sheet or module was created. A clearly labeled synthetic acceptance row verifies the contract end to end; it is not historical or live evidence.

## Structural audit

The canonical record belongs in the existing Module 20b human-ledger surface. Module 29 remains the distribution owner and Module 33 remains the allocation-research owner. Neither is made an active consumer by this test.

The current `FULL_LADDER_AUDIT.Run_Band_Center` is not a historical human P50. Existing rows populate it from the engine projection unless an operator explicitly supplied a center. A historical human P50 is recoverable only when frozen provenance explicitly records `RUN_BAND_CENTER=<value>`.

The audited workbook contains no such explicit provenance rows. Therefore:

`Historical_Point_Grade_Status = NOT_AVAILABLE`

No band midpoint, engine projection, market line, or later narrative may be substituted.

## Canonical freeze rule

`TRUTH_READY_GATE = PASS` requires:

1. official away and home batting orders;
2. resolved pitching plans sufficient for projection;
3. current D0 bullpen state;
4. usable current run environment;
5. no active full-game integrity freeze;
6. a successful pre-first-pitch refresh incorporating those states.

Readiness does not manufacture a human forecast. The atomic canonical freeze occurs on the first successful pre-first-pitch refresh where the ready gate passes **and** the complete human P50, allocation, mechanism, and exposure-status object is present.

If readiness passes without the human object, status is `CANONICAL_TRUTH_INPUT_PENDING`. If no complete object freezes before first pitch, status is `NO_CANONICAL_PREGAME_FREEZE`. No postgame or in-game backfill is permitted.

## Atomicity and immutability

One freeze operation writes one timestamp, run ID, and deterministic SHA-256 hash over:

- P50 and optional mean;
- away/home conditioned allocation;
- carrier and phase;
- primary/secondary mechanism codes;
- mechanism text;
- market-exposure status;
- version and lineage metadata.

Allocation is constructed by rounding one side and deriving the other as the residual. The mechanism text is capped at 40 words. A material pregame change creates a linked V2 record; it never overwrites V1. Market movement alone cannot cause a refreeze.

## Settlement contract

Ordinary truth settlement includes only point, direction, allocation, and frozen-mechanism results. It deliberately excludes P10/P20/P80/P90, bands, range hits, and central-zone fields.

Mechanism grades are deterministic:

- `CONFIRMED`: carrier, phase, and primary mechanism occurred;
- `PARTIAL`: primary phase/mechanism occurred, but carrier/allocation or a material secondary contribution was wrong;
- `FAILED`: the primary mechanism did not occur or materially inverted;
- `UNGRADABLE`: evidence is insufficient.

## Dependency and consumer audit

- Runner import: none.
- Publisher import: none.
- Settlement import: none.
- Workbook schema import: none.
- Active projection import: none.
- Decision/authorization import: none.
- Market logic import: none.

The test component is callable only from its dedicated tests. Production behavior is therefore invariant.

## Commissioning result

The structural, formula, freeze, market-separation, exact-line, historical-integrity, and deterministic-settlement tests pass locally. The copied workbook readback reconciles the synthetic record hash, P50, residual allocation, market comparison, point error, allocation sign reversal, and failed mechanism grade.

Historical comparative replay remains unavailable because Frostline did not historically freeze explicit human P50/allocation/mechanism objects. That absence is preserved rather than reconstructed.

Final status:

**HOLD — TEST CONTRACT VALIDATED; HISTORICAL HUMAN REPLAY UNAVAILABLE; PRODUCTION AUTHORIZATION NOT GRANTED**
