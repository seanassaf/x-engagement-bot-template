import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnvFiles, loadConfig } from './lib/config.ts';
import { findChrome } from './lib/browser.ts';

loadEnvFiles();

type ImportedCookie = {
  domain?: string;
  expires?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: 'Lax' | 'None' | 'Strict';
  secure?: boolean;
  value: string;
};

loadEnvFiles();

async function main(): Promise<void> {
  const accountInput = parseAccountArg(process.argv.slice(2));
  const config = loadConfig(accountInput);
  const cookies = loadCookiesFromEnvOrFile(config.account.envKey);

  if (cookies.length === 0) {
    throw new Error(`No cookies were loaded for ${config.account.key}.`);
  }

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.default.launch({
    executablePath: findChrome(),
    headless: config.browserHeadless,
    ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain'],
    userDataDir: resolve(config.browserProfileDir),
    protocolTimeout: 60_000,
    defaultViewport: { width: 1280, height: 900 },
    args: config.browserDisableSandbox
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [],
  });

  try {
    const context = browser.defaultBrowserContext();
    await context.setCookie(...cookies.map(toSetCookieParam));

    const page = await browser.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 60_000 });

    const persisted = await context.cookies('https://x.com', 'https://twitter.com');
    const hasAuth = persisted.some((cookie: any) => cookie.name === 'auth_token' || cookie.name === 'twid');

    if (!hasAuth) {
      throw new Error('Imported cookies did not produce a persisted X auth session.');
    }

    console.log(`Seeded ${cookies.length} cookies into browser profile ${config.browserProfileDir}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

function parseAccountArg(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--account') {
      return argv[index + 1] ?? null;
    }
  }

  return 'myaccount';
}

function loadCookiesFromEnvOrFile(accountEnvKey: string): ImportedCookie[] {
  const encoded = process.env[`X_COOKIES_B64_${accountEnvKey}`]?.trim();
  if (encoded) {
    return parseCookies(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  const filePath = process.env[`X_COOKIES_FILE_${accountEnvKey}`]?.trim();
  if (filePath) {
    return parseCookies(readFileSync(resolve(filePath), 'utf8'));
  }

  throw new Error(
    `Set X_COOKIES_B64_${accountEnvKey} or X_COOKIES_FILE_${accountEnvKey} before seeding browser cookies.`,
  );
}

function parseCookies(raw: string): ImportedCookie[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Cookie payload must be a JSON array.');
  }

  return parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => {
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        throw new Error('Each cookie must include string name and value fields.');
      }

      const cookie: ImportedCookie = {
        name: entry.name,
        value: entry.value,
      };

      if (typeof entry.domain === 'string') cookie.domain = entry.domain;
      if (typeof entry.path === 'string') cookie.path = entry.path;
      if (typeof entry.expires === 'number') cookie.expires = entry.expires;
      if (typeof entry.httpOnly === 'boolean') cookie.httpOnly = entry.httpOnly;
      if (typeof entry.secure === 'boolean') cookie.secure = entry.secure;
      if (entry.sameSite === 'Lax' || entry.sameSite === 'None' || entry.sameSite === 'Strict') {
        cookie.sameSite = entry.sameSite;
      }

      return cookie;
    });
}

function toSetCookieParam(cookie: ImportedCookie): ImportedCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure ?? true,
    sameSite: cookie.sameSite,
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
