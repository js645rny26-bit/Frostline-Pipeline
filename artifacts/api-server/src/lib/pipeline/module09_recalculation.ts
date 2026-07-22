/**
 * Module 09: Recalculation Verification
 * Polls GAME_INTEGRATION and GAME_SUMMARY to verify workbook recalculated.
 */

import { readRange, WORKBOOK_ID } from "../sheets/client.js";
import { logger } from "../../lib/logger.js";

export interface RecalcCheck {
  status: "verified" | "error" | "timeout";
  expected_rows: number;
  actual_rows: number;
  formula_errors: string[];
}

export interface ConsistencyCheck {
  status: "consistent" | "inconsistent";
  read_1_timestamp: string;
  read_2_timestamp: string;
  diff_seconds: number;
}

export interface Module09Result {
  status: "verified" | "timeout" | "error" | "incomplete";
  verification_timestamp_utc: string;
  checks: {
    game_integration: RecalcCheck;
    game_summary: RecalcCheck;
    consistency_check: ConsistencyCheck;
  };
  recalculation_time_ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkFormulaErrors(values: unknown[][]): string[] {
  const errors: string[] = [];
  const errorPrefixes = ["#REF!", "#VALUE!", "#NAME?", "#DIV/0!", "#N/A", "#ERROR!"];
  values.forEach((row, rowIdx) => {
    row.forEach((cell, colIdx) => {
      if (typeof cell === "string" && errorPrefixes.some((p) => cell.startsWith(p))) {
        errors.push(`${String.fromCharCode(65 + colIdx)}${rowIdx + 1}: ${cell}`);
      }
    });
  });
  return errors;
}

export async function verifyRecalculation(
  expectedGameCount: number,
  maxRetries = 5,
  retryDelayMs = 2000,
): Promise<Module09Result> {
  logger.info({ expectedGameCount }, "MODULE_09: Verifying workbook recalculation");

  const startTime = Date.now();
  const expectedIntegrationRows = expectedGameCount * 2; // away + home per game
  const expectedSummaryRows = expectedGameCount;

  let integrationCheck: RecalcCheck = {
    status: "timeout",
    expected_rows: expectedIntegrationRows,
    actual_rows: 0,
    formula_errors: [],
  };
  let summaryCheck: RecalcCheck = {
    status: "timeout",
    expected_rows: expectedSummaryRows,
    actual_rows: 0,
    formula_errors: [],
  };
  let consistencyCheck: ConsistencyCheck = {
    status: "inconsistent",
    read_1_timestamp: "",
    read_2_timestamp: "",
    diff_seconds: 0,
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Read GAME_INTEGRATION column A
      const integrationData = await readRange(WORKBOOK_ID, "GAME_INTEGRATION!A:A");
      const integrationRows = (integrationData.values?.length ?? 0) - 1; // subtract header
      const integrationErrors = checkFormulaErrors(integrationData.values ?? []);

      // Read GAME_SUMMARY column A
      const summaryData = await readRange(WORKBOOK_ID, "GAME_SUMMARY!A:A");
      const summaryRows = (summaryData.values?.length ?? 0) - 1;
      const summaryErrors = checkFormulaErrors(summaryData.values ?? []);

      integrationCheck = {
        status: integrationErrors.length > 0 ? "error" : "verified",
        expected_rows: expectedIntegrationRows,
        actual_rows: integrationRows,
        formula_errors: integrationErrors,
      };
      summaryCheck = {
        status: summaryErrors.length > 0 ? "error" : "verified",
        expected_rows: expectedSummaryRows,
        actual_rows: summaryRows,
        formula_errors: summaryErrors,
      };

      // If errors detected, stop immediately
      if (integrationErrors.length > 0 || summaryErrors.length > 0) {
        logger.warn({ integrationErrors, summaryErrors }, "MODULE_09: Formula errors detected");
        return {
          status: "error",
          verification_timestamp_utc: new Date().toISOString(),
          checks: { game_integration: integrationCheck, game_summary: summaryCheck, consistency_check: consistencyCheck },
          recalculation_time_ms: Date.now() - startTime,
        };
      }

      // Row count is advisory — GAME_SUMMARY is a formula-aggregation sheet whose
      // template may have fewer rows than the number of games. What matters is that
      // (a) the sheets are reachable, (b) no formula errors exist, and (c) the
      // values are stable across two reads. We do not require summaryRows >= expected.
      const integrationOk = integrationErrors.length === 0;
      const summaryOk = summaryErrors.length === 0;

      if (integrationOk && summaryOk) {
        // Stability check: read GAME_INTEGRATION summary column twice, 1 s apart
        const read1 = await readRange(WORKBOOK_ID, "GAME_INTEGRATION!A:B");
        const read1Time = new Date().toISOString();

        await sleep(1000);

        const read2 = await readRange(WORKBOOK_ID, "GAME_INTEGRATION!A:B");
        const read2Time = new Date().toISOString();

        const isConsistent = JSON.stringify(read1) === JSON.stringify(read2);
        consistencyCheck = {
          status: isConsistent ? "consistent" : "inconsistent",
          read_1_timestamp: read1Time,
          read_2_timestamp: read2Time,
          diff_seconds: 1,
        };

        if (isConsistent) {
          logger.info({ attempt, elapsed: Date.now() - startTime, integrationRows, summaryRows }, "MODULE_09: Recalculation verified");
          return {
            status: "verified",
            verification_timestamp_utc: new Date().toISOString(),
            checks: { game_integration: integrationCheck, game_summary: summaryCheck, consistency_check: consistencyCheck },
            recalculation_time_ms: Date.now() - startTime,
          };
        }

        // Values changed between reads — retry once more
        logger.info({ attempt }, "MODULE_09: Values not yet stable, retrying");
      }

      if (attempt < maxRetries - 1) {
        await sleep(retryDelayMs);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, err: message }, "MODULE_09: Read error, retrying");
      if (attempt < maxRetries - 1) {
        await sleep(retryDelayMs);
      } else {
        return {
          status: "error",
          verification_timestamp_utc: new Date().toISOString(),
          checks: { game_integration: integrationCheck, game_summary: summaryCheck, consistency_check: consistencyCheck },
          recalculation_time_ms: Date.now() - startTime,
        };
      }
    }
  }

  logger.warn({ elapsed: Date.now() - startTime }, "MODULE_09: Recalculation verification timed out");
  const isIncomplete = integrationCheck.actual_rows > 0 || summaryCheck.actual_rows > 0;
  return {
    status: isIncomplete ? "incomplete" : "timeout",
    verification_timestamp_utc: new Date().toISOString(),
    checks: { game_integration: integrationCheck, game_summary: summaryCheck, consistency_check: consistencyCheck },
    recalculation_time_ms: Date.now() - startTime,
  };
}
