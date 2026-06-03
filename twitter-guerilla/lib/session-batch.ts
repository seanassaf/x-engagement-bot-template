import { isKnownAccountInput, listAvailableAccounts, resolveAccount } from './accounts.ts';
import type { SessionBatchArgs } from './session-batch.types.ts';

const DEFAULT_SESSION_ALL_ORDER = ['myaccount'];

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function listDefaultSessionAccounts(): string[] {
  const available = new Set(listAvailableAccounts());
  const ordered = DEFAULT_SESSION_ALL_ORDER.filter((account) => available.has(account));
  const extra = [...available]
    .filter((account) => !DEFAULT_SESSION_ALL_ORDER.includes(account))
    .sort((left, right) => left.localeCompare(right));

  return [...ordered, ...extra];
}

function normalizeAccounts(accounts: string[]): string[] {
  if (accounts.length === 0) return listDefaultSessionAccounts();

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const account of accounts) {
    const key = resolveAccount(account).key;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

export function parseSessionBatchArgs(argv: string[]): SessionBatchArgs {
  const accounts: string[] = [];
  const passthroughArgs: string[] = [];
  let sessionsPerAccount = 1;
  let continueOnError = true;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];

    if (value === '--') {
      passthroughArgs.push(...argv.slice(index + 1));
      break;
    }

    if (value === '--sessions') {
      const raw = argv[++index] ?? '';
      sessionsPerAccount = parsePositiveInteger(raw, '--sessions');
      continue;
    }

    if (value === '--account') {
      const account = argv[++index] ?? '';
      if (!account) throw new Error('--account requires an account value');
      accounts.push(account);
      continue;
    }

    if (value === '--fail-fast') {
      continueOnError = false;
      continue;
    }

    if (isKnownAccountInput(value)) {
      accounts.push(value);
      continue;
    }

    passthroughArgs.push(value);
  }

  return {
    accounts: normalizeAccounts(accounts),
    continueOnError,
    sessionArgs: passthroughArgs,
    sessionsPerAccount,
  };
}
