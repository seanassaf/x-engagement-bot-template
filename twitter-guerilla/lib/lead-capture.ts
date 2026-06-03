import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../..');
const GOOGLE_SHEETS_CONFIG_PATHS = [
  resolve(REPO_ROOT, 'config/google-sheets.local.json'),
  resolve(REPO_ROOT, '../x-scraper/config/google-sheets.local.json'),
];
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export type LeadCaptureRow = {
  followers: number | null;
  username_id: string;
};

type GoogleSheetsConfig = {
  credentialsPath: string;
  sheetUrl: string;
  spreadsheetId: string;
};

type GoogleSheetsSession = {
  accessToken: string;
  sheetTitle: string;
  spreadsheetId: string;
};

function toBase64Url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function parseSpreadsheetId(value: string): string {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/u);

  if (urlMatch) {
    return urlMatch[1];
  }

  if (/^[a-zA-Z0-9-_]+$/u.test(trimmed)) {
    return trimmed;
  }

  throw new Error(`Could not parse spreadsheet id from "${value}"`);
}

function loadGoogleSheetsConfig(): GoogleSheetsConfig | null {
  const configPath = GOOGLE_SHEETS_CONFIG_PATHS.find((candidate) => existsSync(candidate));
  if (!configPath) return null;

  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.credentials_path || !parsed.sheet_url) {
    throw new Error(
      `Google Sheets config at ${configPath} must include credentials_path and sheet_url.`,
    );
  }

  return {
    credentialsPath: String(parsed.credentials_path),
    sheetUrl: String(parsed.sheet_url),
    spreadsheetId: parseSpreadsheetId(String(parsed.sheet_url)),
  };
}

async function getGoogleAccessToken(credentialsPath: string): Promise<string> {
  const raw = readFileSync(credentialsPath, 'utf8');
  const credentials = JSON.parse(raw);

  if (!credentials.client_email || !credentials.private_key || !credentials.token_uri) {
    throw new Error(`Invalid Google service account credentials file at ${credentialsPath}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toBase64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: credentials.token_uri,
    exp: now + 3600,
    iat: now,
  }));
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(credentials.private_key, 'base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
  const assertion = `${unsignedToken}.${signature}`;

  const response = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google OAuth token request failed with ${response.status}: ${message}`);
  }

  const payloadData = await response.json();

  if (!payloadData.access_token) {
    throw new Error('Google OAuth token response did not include access_token.');
  }

  return payloadData.access_token;
}

async function googleApiRequest(
  url: string,
  accessToken: string,
  options: { body?: unknown; method?: string } = {},
): Promise<any> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Sheets API request failed with ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function initializeGoogleSheetSession(): Promise<GoogleSheetsSession | null> {
  const config = loadGoogleSheetsConfig();
  if (!config) return null;

  const accessToken = await getGoogleAccessToken(config.credentialsPath);
  const metadata = await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}?fields=sheets.properties.title`,
    accessToken,
  );
  const sheetTitle = metadata?.sheets?.[0]?.properties?.title;

  if (!sheetTitle) {
    throw new Error('Could not determine target Google Sheet tab title.');
  }

  return {
    accessToken,
    sheetTitle,
    spreadsheetId: config.spreadsheetId,
  };
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/u, '').toLowerCase();
}

export function dedupeLeadRows(rows: LeadCaptureRow[]): LeadCaptureRow[] {
  const seen = new Set<string>();
  const uniqueRows: LeadCaptureRow[] = [];

  for (const row of rows) {
    const username = normalizeUsername(row.username_id);
    if (!username || seen.has(username)) continue;

    seen.add(username);
    uniqueRows.push({
      username_id: username,
      followers: row.followers,
    });
  }

  return uniqueRows;
}

async function readExistingLeadUsernames(session: GoogleSheetsSession): Promise<Set<string>> {
  const range = encodeURIComponent(`${session.sheetTitle}!A:A`);
  const existingValues = await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${session.spreadsheetId}/values/${range}`,
    session.accessToken,
  );
  const rows = Array.isArray(existingValues?.values) ? existingValues.values : [];

  return new Set(
    rows
      .map((row: unknown[]) => normalizeUsername(String(row?.[0] ?? '')))
      .filter((value: string) => value && value !== 'username_id'),
  );
}

async function ensureLeadSheetHeader(session: GoogleSheetsSession): Promise<void> {
  const headerRange = encodeURIComponent(`${session.sheetTitle}!A1:B1`);
  const existingValues = await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${session.spreadsheetId}/values/${headerRange}`,
    session.accessToken,
  );
  const hasAnyValues = Array.isArray(existingValues?.values) && existingValues.values.length > 0;

  if (hasAnyValues) return;

  await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${session.spreadsheetId}/values/${headerRange}?valueInputOption=RAW`,
    session.accessToken,
    {
      method: 'PUT',
      body: {
        range: `${session.sheetTitle}!A1:B1`,
        majorDimension: 'ROWS',
        values: [['username_id', 'followers']],
      },
    },
  );
}

async function appendLeadRowsToGoogleSheet(
  session: GoogleSheetsSession,
  rows: LeadCaptureRow[],
): Promise<number> {
  await ensureLeadSheetHeader(session);

  const existingUsernames = await readExistingLeadUsernames(session);
  const rowsToAppend = dedupeLeadRows(rows)
    .filter((row) => !existingUsernames.has(normalizeUsername(row.username_id)));

  if (rowsToAppend.length === 0) {
    return 0;
  }

  const appendRange = encodeURIComponent(`${session.sheetTitle}!A:B`);
  await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${session.spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    session.accessToken,
    {
      method: 'POST',
      body: {
        range: `${session.sheetTitle}!A:B`,
        majorDimension: 'ROWS',
        values: rowsToAppend.map((row) => [row.username_id, row.followers ?? '']),
      },
    },
  );

  return rowsToAppend.length;
}

export async function appendEngagementLeadsToGoogleSheet(rows: LeadCaptureRow[]): Promise<void> {
  const uniqueRows = dedupeLeadRows(rows);
  if (uniqueRows.length === 0) {
    console.log('Lead capture: no successful engagement leads to append.');
    return;
  }

  const session = await initializeGoogleSheetSession();
  if (!session) {
    console.log('Lead capture: Google Sheets config not found, skipping append.');
    return;
  }

  const appendedCount = await appendLeadRowsToGoogleSheet(session, uniqueRows);
  console.log(
    appendedCount > 0
      ? `Lead capture: appended ${appendedCount} new account(s) to Google Sheet.`
      : 'Lead capture: all successful engagement leads were already in the sheet.',
  );
}
