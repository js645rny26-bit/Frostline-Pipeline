/**
 * Google Sheets client wrapper using Replit Connectors SDK.
 * NEVER cache the connectors instance — tokens expire.
 * Always instantiate fresh per-request.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";

const WORKBOOK_ID = "1FY2FgpFbr2pSmFF-0Gowh-HXW3z5QOnj2ujpcTQQRB4";

export { WORKBOOK_ID };

// ─── Low-level proxy helpers ─────────────────────────────────────────────────

async function sheetsRequest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("google-sheet", path, {
    method: options.method ?? "GET",
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sheets API ${response.status} on ${path}: ${text}`);
  }
  return response.json();
}

// Drive API — uses same connector (has drive.file scope)
async function driveRequest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const connectors = new ReplitConnectors();
  // Drive path: /drive/v3/...
  const response = await connectors.proxy("google-sheet", path, {
    method: options.method ?? "GET",
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive API ${response.status} on ${path}: ${text}`);
  }
  return response.json();
}

// ─── Sheets helpers ──────────────────────────────────────────────────────────

export interface SheetValues {
  values?: unknown[][];
}

export async function readRange(
  workbookId: string,
  range: string,
): Promise<SheetValues> {
  const encoded = encodeURIComponent(range);
  return sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encoded}`,
  ) as Promise<SheetValues>;
}

export async function clearRange(
  workbookId: string,
  range: string,
): Promise<void> {
  const encoded = encodeURIComponent(range);
  await sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encoded}:clear`,
    { method: "POST", body: {} },
  );
}

export async function writeRange(
  workbookId: string,
  range: string,
  values: unknown[][],
): Promise<{ updatedRows: number; updatedRange: string }> {
  const encoded = encodeURIComponent(range);
  const result = (await sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encoded}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: { range, values, majorDimension: "ROWS" },
    },
  )) as { updatedRows?: number; updatedRange?: string };
  return {
    updatedRows: result.updatedRows ?? values.length,
    updatedRange: result.updatedRange ?? range,
  };
}

export async function appendRange(
  workbookId: string,
  range: string,
  values: unknown[][],
): Promise<{ updatedRows: number }> {
  const encoded = encodeURIComponent(range);
  const result = (await sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values, majorDimension: "ROWS" } },
  )) as { updates?: { updatedRows?: number } };
  return { updatedRows: result.updates?.updatedRows ?? values.length };
}

// ─── Sheet management ────────────────────────────────────────────────────────

export async function addSheet(workbookId: string, title: string): Promise<void> {
  await sheetsRequest(`/v4/spreadsheets/${workbookId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });
}

export interface CreatedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets: Array<{ sheetId: number; title: string; index: number }>;
}

/**
 * Create a brand-new Google Spreadsheet.
 * `sheetDefs` is the raw sheets[] array accepted by the Sheets v4 spreadsheets.create body.
 */
export async function createSpreadsheet(
  title: string,
  sheetDefs: unknown[],
): Promise<CreatedSpreadsheet> {
  const raw = (await sheetsRequest("/v4/spreadsheets", {
    method: "POST",
    body: { properties: { title }, sheets: sheetDefs },
  })) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    sheets: Array<{ properties: { sheetId: number; title: string; index: number } }>;
  };
  return {
    spreadsheetId: raw.spreadsheetId,
    spreadsheetUrl: raw.spreadsheetUrl,
    sheets: raw.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index,
    })),
  };
}

/** Run a batchUpdate on an existing workbook. */
export async function batchUpdate(workbookId: string, requests: unknown[]): Promise<void> {
  await sheetsRequest(`/v4/spreadsheets/${workbookId}:batchUpdate`, {
    method: "POST",
    body: { requests },
  });
}

// ─── Drive helpers ───────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
}

export async function createDriveFolder(
  name: string,
  parentId: string,
): Promise<DriveFile> {
  return driveRequest("/drive/v3/files", {
    method: "POST",
    body: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
  }) as Promise<DriveFile>;
}

export async function uploadDriveFile(
  name: string,
  content: string,
  mimeType: string,
  parentId: string,
): Promise<DriveFile> {
  // Use multipart upload via metadata + media
  // The connector proxy handles auth; we compose the multipart manually
  const connectors = new ReplitConnectors();
  const boundary = "frostline_boundary_" + Date.now();
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  const response = await connectors.proxy(
    "google-sheet",
    "/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive upload ${response.status}: ${text}`);
  }
  return response.json() as Promise<DriveFile>;
}
