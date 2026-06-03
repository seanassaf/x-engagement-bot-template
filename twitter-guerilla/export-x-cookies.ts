import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadEnvFiles, loadConfig } from './lib/config.ts';
import { launchBrowser } from './lib/browser.ts';

loadEnvFiles();

async function main(): Promise<void> {
  const { accountInput, outputPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(accountInput);

  const { browser } = await launchBrowser(config);

  try {
    const context = browser.defaultBrowserContext();
    const cookies = await context.cookies('https://x.com', 'https://twitter.com');
    const filtered = cookies.filter((cookie: any) => {
      const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
      return domain.includes('x.com') || domain.includes('twitter.com');
    });

    if (filtered.length === 0) {
      throw new Error('No X/Twitter cookies were found in the current browser profile.');
    }

    const serialized = JSON.stringify(filtered, null, 2);
    const base64 = Buffer.from(serialized, 'utf8').toString('base64');
    const destination = resolve(outputPath ?? defaultOutputPath(config.browserProfileDir));

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${serialized}\n`, 'utf8');

    console.log(`Exported ${filtered.length} X/Twitter cookies to ${destination}`);
    console.log(`\nPaste this value into Railway as X_COOKIES_B64_${config.account.envKey}:\n`);
    console.log(base64);
  } finally {
    await browser.close().catch(() => {});
  }
}

function defaultOutputPath(browserProfileDir: string): string {
  return resolve(browserProfileDir, 'x-cookies.json');
}

function parseArgs(argv: string[]): { accountInput: string | null; outputPath: string | null } {
  let accountInput: string | null = 'myaccount';
  let outputPath: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];

    if (value === '--account') {
      accountInput = argv[++index] ?? null;
      continue;
    }

    if (value === '--output') {
      outputPath = argv[++index] ?? null;
      continue;
    }
  }

  return { accountInput, outputPath };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
