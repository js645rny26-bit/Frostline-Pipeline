/**
 * Google Sheets client with runtime-selectable transports.
 * Replit remains the primary path; Google ADC supports isolated commissioning
 * from GitHub Actions without exporting a long-lived service-account key.
 */
import { readFile } from "node:fs/promises";

export const CANONICAL_WORKBOOK_ID = "1MWsGQYR13tFjwd-L4lMweGShKJkrOsSNJaHzdjiMNHs";
const configuredWorkbook = process.env.FROSTLINE_WORKBOOK_ID?.trim();
export const WORKBOOK_ID = configuredWorkbook || CANONICAL_WORKBOOK_ID;

export type SheetsBackend = "auto" | "replit" | "google";
type TransportKind = Exclude<SheetsBackend, "auto">;
type ApiKind = "sheets" | "drive";

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: boolean;
}

interface SheetsTransport {
  readonly kind: TransportKind;
  request(api: ApiKind, path: string, options?: RequestOptions): Promise<unknown>;
}

function hasReplitIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.REPL_IDENTITY || env.WEB_REPL_RENEWAL);
}

function hasGoogleAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_GHA_CREDS_PATH);
}

/** Pure selection function, exported so fail-closed behavior is unit-testable. */
export function selectSheetsBackend(
  configured: string | undefined = process.env.FROSTLINE_SHEETS_BACKEND,
  env: NodeJS.ProcessEnv = process.env,
): TransportKind {
  const backend = (configured?.trim().toLowerCase() || "auto") as SheetsBackend;
  if (backend !== "auto" && backend !== "replit" && backend !== "google") {
    throw new Error(`Invalid FROSTLINE_SHEETS_BACKEND: ${configured}`);
  }
  if (backend === "replit") {
    if (!hasReplitIdentity(env)) throw new Error("Replit Sheets backend requested but no Replit identity is available");
    return "replit";
  }
  if (backend === "google") {
    if (!hasGoogleAdc(env)) throw new Error("Google Sheets backend requested but no Google Application Default Credentials are available");
    return "google";
  }
  if (hasReplitIdentity(env)) return "replit";
  if (hasGoogleAdc(env)) return "google";
  throw new Error("No Sheets identity is available: configure Replit identity or Google Application Default Credentials");
}

export function assertWorkbookWriteAllowed(workbookId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (workbookId === CANONICAL_WORKBOOK_ID && env.ALLOW_CANONICAL_PUBLISH !== "true") {
    throw new Error("Refusing write to canonical workbook without ALLOW_CANONICAL_PUBLISH=true");
  }
}

class ReplitSheetsTransport implements SheetsTransport {
  readonly kind = "replit" as const;

  async request(_api: ApiKind, path: string, options: RequestOptions = {}): Promise<unknown> {
    // Keep the existing Replit connector behavior as the primary runtime path.
    const moduleName = "@replit/connectors-sdk";
    const { ReplitConnectors } = await import(moduleName) as {
      ReplitConnectors: new () => {
        proxy: (connector: string, path: string, request: {
          method: string; headers?: Record<string, string>; body?: string;
        }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;
      };
    };
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("google-sheet", path, {
      method: options.method ?? "GET",
      headers: options.headers,
      ...(options.body !== undefined
        ? { body: options.rawBody ? String(options.body) : JSON.stringify(options.body) }
        : {}),
    });
    if (!response.ok) throw new Error(`Sheets API ${response.status} on ${path}: ${await response.text()}`);
    return response.json();
  }
}

class GoogleSheetsTransport implements SheetsTransport {
  readonly kind = "google" as const;

  async request(api: ApiKind, path: string, options: RequestOptions = {}): Promise<unknown> {
    const method = options.method ?? "GET";
    const isSheetsWrite = api === "sheets" && method !== "GET" && method !== "HEAD";
    const maxAttempts = isSheetsWrite ? googleSheets429MaxAttempts() : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (isSheetsWrite) await waitForGoogleSheetsWriteSlot();

      const token = await googleAccessToken();
      const origin = api === "sheets" ? "https://sheets.googleapis.com" : "https://www.googleapis.com";
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body !== undefined && !options.rawBody ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined
          ? { body: options.rawBody ? String(options.body) : JSON.stringify(options.body) }
          : {}),
      });

      if (response.ok) return response.json();

      if (response.status === 429 && attempt < maxAttempts) {
        await sleep(googleSheets429RetryDelayMs(response.headers));
        continue;
      }

      throw new Error(`Google ${api} API ${response.status} on ${path}: ${await response.text()}`);
    }

    throw new Error(`Google ${api} API request exhausted retries on ${path}`);
  }
}

const DEFAULT_GOOGLE_SHEETS_WRITE_INTERVAL_MS = 1_100;
const DEFAULT_GOOGLE_SHEETS_429_RETRY_MS = 60_000;
const DEFAULT_GOOGLE_SHEETS_429_MAX_ATTEMPTS = 3;

let googleSheetsWriteQueue: Promise<void> = Promise.resolve();
let nextGoogleSheetsWriteAt = 0;

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = nonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function googleSheetsWriteIntervalMs(): number {
  return nonNegativeInteger(
    process.env.FROSTLINE_GOOGLE_SHEETS_WRITE_INTERVAL_MS,
    DEFAULT_GOOGLE_SHEETS_WRITE_INTERVAL_MS,
  );
}

function googleSheets429MaxAttempts(): number {
  return positiveInteger(
    process.env.FROSTLINE_GOOGLE_SHEETS_429_MAX_ATTEMPTS,
    DEFAULT_GOOGLE_SHEETS_429_MAX_ATTEMPTS,
  );
}

function googleSheets429RetryDelayMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.max(0, retryDate - Date.now());
  }
  return nonNegativeInteger(
    process.env.FROSTLINE_GOOGLE_SHEETS_429_RETRY_MS,
    DEFAULT_GOOGLE_SHEETS_429_RETRY_MS,
  );
}

async function waitForGoogleSheetsWriteSlot(): Promise<void> {
  const prior = googleSheetsWriteQueue;
  let release!: () => void;
  googleSheetsWriteQueue = new Promise<void>((resolve) => { release = resolve; });

  await prior;
  try {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextGoogleSheetsWriteAt);
    const waitMs = scheduledAt - now;
    if (waitMs > 0) await sleep(waitMs);
    nextGoogleSheetsWriteAt = Date.now() + googleSheetsWriteIntervalMs();
  } finally {
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

/**
 * Exchanges the external-account ADC file generated by
 * google-github-actions/auth. This is the standard GitHub OIDC -> Google WIF
 * flow and contains no exported service-account key. The token env var is an
 * equivalent short-lived fast path provided by the same action.
 */
async function googleAccessToken(): Promise<string> {
  if (process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN) return process.env.FROSTLINE_GOOGLE_ACCESS_TOKEN;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) throw new Error("Google Sheets backend requires Google ADC or FROSTLINE_GOOGLE_ACCESS_TOKEN");
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
    type?: string; audience?: string; token_url?: string;
    subject_token_type?: string;
    service_account_impersonation_url?: string;
    credential_source?: { file?: string };
  };
  if (credentials.type !== "external_account" || !credentials.audience || !credentials.token_url || !credentials.credential_source?.file) {
    throw new Error("Google ADC must be an external-account credential generated by Workload Identity Federation");
  }
  const subjectToken = await readFile(credentials.credential_source.file, "utf8");
  const sts = await fetch(credentials.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: credentials.subject_token_type ?? "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subjectToken,
      audience: credentials.audience,
      scope: GOOGLE_SCOPES.join(" "),
    }),
  });
  if (!sts.ok) throw new Error(`Google WIF token exchange failed: ${sts.status} ${await sts.text()}`);
  const federated = await sts.json() as { access_token?: string };
  if (!federated.access_token) throw new Error("Google WIF token exchange returned no access token");
  if (!credentials.service_account_impersonation_url) return federated.access_token;
  const impersonated = await fetch(credentials.service_account_impersonation_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${federated.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: GOOGLE_SCOPES, lifetime: "3600s" }),
  });
  if (!impersonated.ok) throw new Error(`Google service-account impersonation failed: ${impersonated.status} ${await impersonated.text()}`);
  const result = await impersonated.json() as { accessToken?: string };
  if (!result.accessToken) throw new Error("Google service-account impersonation returned no access token");
  return result.accessToken;
}

let cachedTransport: SheetsTransport | undefined;

function transport(): SheetsTransport {
  if (cachedTransport) return cachedTransport;
  cachedTransport = selectSheetsBackend() === "replit" ? new ReplitSheetsTransport() : new GoogleSheetsTransport();
  return cachedTransport;
}

/** Test-only reset; production transport is selected once per process. */
export function resetSheetsTransportForTest(): void {
  cachedTransport = undefined;
  googleSheetsWriteQueue = Promise.resolve();
  nextGoogleSheetsWriteAt = 0;
}

async function sheetsRequest(path: string, options?: RequestOptions): Promise<unknown> {
  return transport().request("sheets", path, options);
}

async function driveRequest(path: string, options?: RequestOptions): Promise<unknown> {
  return transport().request("drive", path, options);
}

export interface SheetValues { values?: unknown[][]; }

export interface SpreadsheetSheetProperties {
  sheetId: number;
  title: string;
}

export async function readRange(workbookId: string, range: string): Promise<SheetValues> {
  return sheetsRequest(`/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}`) as Promise<SheetValues>;
}

/** Returns the stable numeric IDs needed by Sheets batchUpdate grid ranges. */
export async function getSpreadsheetSheetProperties(
  workbookId: string,
): Promise<SpreadsheetSheetProperties[]> {
  const response = await sheetsRequest(
    `/v4/spreadsheets/${workbookId}?fields=sheets.properties(sheetId,title)`,
  ) as { sheets?: Array<{ properties?: Partial<SpreadsheetSheetProperties> }> };

  return (response.sheets ?? []).flatMap((sheet) => {
    const { sheetId, title } = sheet.properties ?? {};
    return typeof sheetId === "number" && typeof title === "string"
      ? [{ sheetId, title }]
      : [];
  });
}

export async function clearRange(workbookId: string, range: string): Promise<void> {
  assertWorkbookWriteAllowed(workbookId);
  await sheetsRequest(`/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}:clear`, { method: "POST", body: {} });
}

export async function writeRange(workbookId: string, range: string, values: unknown[][]): Promise<{ updatedRows: number; updatedRange: string }> {
  assertWorkbookWriteAllowed(workbookId);
  const result = await sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: { range, values, majorDimension: "ROWS" } },
  ) as { updatedRows?: number; updatedRange?: string };
  return { updatedRows: result.updatedRows ?? values.length, updatedRange: result.updatedRange ?? range };
}

export async function appendRange(workbookId: string, range: string, values: unknown[][]): Promise<{ updatedRows: number; updatedRange: string | null }> {
  assertWorkbookWriteAllowed(workbookId);
  const result = await sheetsRequest(
    `/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values, majorDimension: "ROWS" } },
  ) as { updates?: { updatedRows?: number; updatedRange?: string } };
  return { updatedRows: result.updates?.updatedRows ?? values.length, updatedRange: result.updates?.updatedRange ?? null };
}

export async function addSheet(workbookId: string, title: string): Promise<void> {
  await batchUpdate(workbookId, [{ addSheet: { properties: { title } } }]);
}

export interface CreatedSpreadsheet { spreadsheetId: string; spreadsheetUrl: string; sheets: Array<{ sheetId: number; title: string; index: number }>; }

export async function createSpreadsheet(title: string, sheetDefs: unknown[]): Promise<CreatedSpreadsheet> {
  const raw = await sheetsRequest("/v4/spreadsheets", { method: "POST", body: { properties: { title }, sheets: sheetDefs } }) as {
    spreadsheetId: string; spreadsheetUrl: string; sheets: Array<{ properties: { sheetId: number; title: string; index: number } }>;
  };
  return { spreadsheetId: raw.spreadsheetId, spreadsheetUrl: raw.spreadsheetUrl, sheets: raw.sheets.map((s) => s.properties) };
}

export async function batchUpdate(workbookId: string, requests: unknown[]): Promise<void> {
  assertWorkbookWriteAllowed(workbookId);
  await sheetsRequest(`/v4/spreadsheets/${workbookId}:batchUpdate`, { method: "POST", body: { requests } });
}

export async function expandSheetColumns(workbookId: string, sheetTitle: string, targetCols: number): Promise<void> {
  const meta = await sheetsRequest(`/v4/spreadsheets/${workbookId}?fields=sheets.properties`) as {
    sheets: Array<{ properties: { sheetId: number; title: string; gridProperties: { columnCount: number } } }>;
  };
  const sheet = meta.sheets.find((s) => s.properties.title === sheetTitle);
  if (!sheet) throw new Error(`Sheet "${sheetTitle}" not found in workbook`);
  if ((sheet.properties.gridProperties.columnCount ?? 0) >= targetCols) return;
  await batchUpdate(workbookId, [{ updateSheetProperties: { properties: { sheetId: sheet.properties.sheetId, gridProperties: { columnCount: targetCols } }, fields: "gridProperties.columnCount" } }]);
}

export interface DriveFile { id: string; name: string; }

export async function createDriveFolder(name: string, parentId: string): Promise<DriveFile> {
  return driveRequest("/drive/v3/files", { method: "POST", body: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] } }) as Promise<DriveFile>;
}

export async function uploadDriveFile(name: string, content: string, mimeType: string, parentId: string): Promise<DriveFile> {
  const boundary = `frostline_boundary_${Date.now()}`;
  const body = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ name, parents: [parentId] }), `--${boundary}`, `Content-Type: ${mimeType}`, "", content, `--${boundary}--`].join("\r\n");
  return driveRequest("/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", body, rawBody: true,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  }) as Promise<DriveFile>;
}
