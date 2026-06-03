#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatMarketingHelp, parseMarketingCliArgs } from './twitter-guerilla/lib/marketing-cli.ts';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const parsed = parseMarketingCliArgs(process.argv.slice(2));

  if (parsed.kind === 'help') {
    if (parsed.error) {
      console.error(parsed.error);
      console.error('');
    }

    console.log(formatMarketingHelp(parsed.topic));
    process.exitCode = parsed.exitCode;
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT_DIR, parsed.scriptPath), ...parsed.args],
      {
        env: process.env,
        stdio: 'inherit',
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
