import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AccountProfile } from './types.ts';
import { normalizeUsername } from './hard-rules.ts';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const GUERILLA_DIR = resolve(MODULE_DIR, '..');
const PERSONAS_DIR = resolve(GUERILLA_DIR, 'personas');
// Optional short aliases for account keys, e.g. ['acct', 'myaccount'].
const ACCOUNT_ALIASES = new Map<string, string>();

// TODO: set to your default account key (matches personas/<key>.md and X_USER_<KEY>).
export const DEFAULT_ACCOUNT_KEY = 'myaccount';

function extractUsernameFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    if (segments[1]?.toLowerCase() === 'status') return null;
    return segments[0];
  } catch {
    return null;
  }
}

function slugifyPersonaKey(value: string): string {
  return normalizeUsername(value)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function toEnvKey(key: string): string {
  return key.replace(/[^a-z0-9]+/giu, '_').replace(/^_+|_+$/gu, '').toUpperCase();
}

function toDisplayName(key: string): string {
  return key
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function resolvePersonaPath(key: string): string {
  const conventionPath = resolve(PERSONAS_DIR, `${key}.md`);
  if (existsSync(conventionPath)) return conventionPath;

  throw new Error(
    `Unknown persona "${key}". Create twitter-guerilla/personas/${key}.md and set X_USER_${toEnvKey(key)} / X_PASS_${toEnvKey(key)}.`,
  );
}

export function listAvailableAccounts(): string[] {
  const accounts = readdirSync(PERSONAS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.replace(/\.md$/u, ''))
    .filter(Boolean);

  return accounts.sort((left, right) => {
    if (left === DEFAULT_ACCOUNT_KEY) return -1;
    if (right === DEFAULT_ACCOUNT_KEY) return 1;
    return left.localeCompare(right);
  });
}

export function resolveAccount(input: string | null | undefined): AccountProfile {
  const raw = input?.trim() || DEFAULT_ACCOUNT_KEY;
  const fromUrl = extractUsernameFromUrl(raw);
  const derivedKey = slugifyPersonaKey(fromUrl ?? raw);
  const key = ACCOUNT_ALIASES.get(derivedKey) ?? derivedKey;

  if (!key) {
    throw new Error(`Invalid persona "${input}".`);
  }

  return {
    displayName: toDisplayName(key),
    envKey: toEnvKey(key),
    key,
    personaPath: resolvePersonaPath(key),
  };
}

export function isKnownAccountInput(input: string): boolean {
  try {
    resolveAccount(input);
    return true;
  } catch {
    return false;
  }
}

function inferExpectedUsername(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  if (/^@?[A-Za-z0-9_]{1,15}$/u.test(trimmed)) {
    return normalizeUsername(trimmed);
  }

  const fromUrl = extractUsernameFromUrl(trimmed);
  return fromUrl ? normalizeUsername(fromUrl) : null;
}

export function assertAccountMatchesSelection(
  expected: string | null | undefined,
  actualUsername: string,
  source: string,
): void {
  const normalizedExpected = inferExpectedUsername(expected);
  if (!normalizedExpected) return;

  const actual = normalizeUsername(actualUsername);
  if (normalizedExpected !== actual) {
    throw new Error(
      `${source} authenticated as @${actualUsername}, but the selected persona expects @${normalizedExpected}. Check the persona login credentials and browser profile before running again.`,
    );
  }
}
