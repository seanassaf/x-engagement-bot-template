import { spawn } from 'node:child_process';

import { parseSessionBatchArgs } from './lib/session-batch.ts';
import type { SessionRunResult } from './lib/x-session-all.types.ts';

async function runSingleSession(
  account: string,
  sessionNumber: number,
  sessionArgs: string[],
): Promise<SessionRunResult> {
  console.log(`\n=== ${account} | session ${sessionNumber} ===`);

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['twitter-guerilla/x-session.ts', '--account', account, ...sessionArgs],
      {
        env: process.env,
        stdio: 'inherit',
      },
    );

    child.on('error', (error) => {
      console.error(`Failed to start ${account} session ${sessionNumber}: ${error.message}`);
      resolve({
        account,
        code: null,
        sessionNumber,
        signal: null,
        success: false,
      });
    });

    child.on('exit', (code, signal) => {
      resolve({
        account,
        code,
        sessionNumber,
        signal,
        success: code === 0,
      });
    });
  });
}

async function runAllSessions(): Promise<void> {
  const args = parseSessionBatchArgs(process.argv.slice(2));
  const plannedRuns = args.accounts.length * args.sessionsPerAccount;
  const results: SessionRunResult[] = [];

  console.log(`Running ${plannedRuns} sessions across ${args.accounts.length} accounts.`);
  console.log(`Accounts: ${args.accounts.join(', ')}`);
  if (args.sessionArgs.length > 0) {
    console.log(`Forwarding args to each session: ${args.sessionArgs.join(' ')}`);
  }

  for (const account of args.accounts) {
    for (let sessionNumber = 1; sessionNumber <= args.sessionsPerAccount; sessionNumber++) {
      const result = await runSingleSession(account, sessionNumber, args.sessionArgs);
      results.push(result);

      if (!result.success && !args.continueOnError) {
        console.error(`Stopping after ${account} session ${sessionNumber} failed.`);
        process.exitCode = 1;
        break;
      }
    }

    if (process.exitCode === 1 && !args.continueOnError) break;
  }

  const successCount = results.filter((result) => result.success).length;
  console.log('\n=== Batch Summary ===');
  console.log(`${successCount}/${results.length} sessions completed successfully.`);

  for (const result of results) {
    if (result.success) {
      console.log(`[ok] ${result.account} session ${result.sessionNumber}`);
      continue;
    }

    const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`;
    console.log(`[x] ${result.account} session ${result.sessionNumber} (${detail})`);
  }

  if (successCount !== results.length) {
    process.exitCode = 1;
  }
}

runAllSessions().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
