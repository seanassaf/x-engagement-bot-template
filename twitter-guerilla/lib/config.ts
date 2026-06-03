import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AccountProfile, AppConfig } from './types.ts';
import { DEFAULT_ACCOUNT_KEY, resolveAccount } from './accounts.ts';

const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_X_API_BASE_URL = 'https://api.x.com';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../..');
const BASE_PERSONA_PATH = resolve(REPO_ROOT, 'twitter-guerilla/base-persona.md');

const ENV_FILES = ['.env', '.env.local'];

export function loadEnvFiles(): void {
  for (const envFile of ENV_FILES) {
    const path = resolve(REPO_ROOT, envFile);

    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf8');

    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getFirstDefinedEnv(...names: Array<string | undefined>): string | null {
  for (const name of names) {
    if (!name) continue;

    const value = process.env[name];
    if (value) return value;
  }

  return null;
}

function isTruthyEnvValue(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on', 'manual'].includes(value.trim().toLowerCase());
}

function resolveRuntimeRoot(): string {
  const explicitRoot = process.env.RUNTIME_DATA_ROOT?.trim();
  if (explicitRoot) return resolve(explicitRoot);

  const railwayVolumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolumeMountPath) return resolve(railwayVolumeMountPath);

  return REPO_ROOT;
}

function resolveBrowserProfilesDir(): string {
  const explicitProfilesDir = process.env.BROWSER_PROFILES_DIR?.trim();
  if (explicitProfilesDir) return resolve(explicitProfilesDir);

  return resolve(resolveRuntimeRoot(), '.x-browser-profiles');
}

function resolveSessionLogsDir(): string {
  const explicitLogsDir = process.env.SESSION_LOGS_DIR?.trim();
  if (explicitLogsDir) return resolve(explicitLogsDir);

  return resolve(resolveRuntimeRoot(), '.x-session-logs');
}

function personaEnvName(prefix: string, account: AccountProfile): string {
  return `${prefix}_${account.envKey}`;
}

function getAccountEnv(
  account: AccountProfile,
  prefix: string,
  fallbackNames: string[] = [],
): string | null {
  return getFirstDefinedEnv(personaEnvName(prefix, account), ...fallbackNames);
}

function getAccountEnvFromPrefixes(
  account: AccountProfile,
  prefixes: string[],
  fallbackNames: string[] = [],
): string | null {
  return getFirstDefinedEnv(
    ...prefixes.map((prefix) => personaEnvName(prefix, account)),
    ...fallbackNames,
  );
}

function loadPersona(account: AccountProfile): string {
  if (!existsSync(BASE_PERSONA_PATH)) {
    throw new Error(`Base persona file not found at ${BASE_PERSONA_PATH}.`);
  }

  if (!existsSync(account.personaPath)) {
    throw new Error(
      `Persona file not found at ${account.personaPath}. Create twitter-guerilla/personas/${account.key}.md.`,
    );
  }

  const basePersona = readFileSync(BASE_PERSONA_PATH, 'utf8').trim();
  const specificPersona = readFileSync(account.personaPath, 'utf8').trim();

  if (!basePersona) {
    throw new Error(`Base persona file is empty at ${BASE_PERSONA_PATH}.`);
  }

  if (!specificPersona) {
    throw new Error(`Persona file is empty at ${account.personaPath}.`);
  }

  console.log(`Persona loaded for ${account.key} from ${BASE_PERSONA_PATH} + ${account.personaPath}`);
  return [basePersona, '', specificPersona].join('\n');
}

export function loadConfig(accountInput?: string | null): AppConfig {
  const account = resolveAccount(accountInput);
  const browserProfilesDir = resolveBrowserProfilesDir();
  const sessionLogsDir = resolveSessionLogsDir();
  const browserHeadless = isTruthyEnvValue(process.env.BROWSER_HEADLESS ?? null);
  const browserDisableSandbox = isTruthyEnvValue(process.env.BROWSER_DISABLE_SANDBOX ?? null) ||
    Boolean(process.env.RAILWAY_PROJECT_ID);

  return {
    account,
    browserProfileDir: resolve(browserProfilesDir, account.key),
    browserHeadless,
    browserDisableSandbox,
    xApiBaseUrl: process.env.X_API_BASE_URL || DEFAULT_X_API_BASE_URL,
    xApiKey: requireEnv('X_API_KEY'),
    xApiSecret: requireEnv('X_API_SECRET'),
    xAccessToken: requireEnv('X_ACCESS_TOKEN'),
    xAccessSecret: requireEnv('X_ACCESS_SECRET'),
    xLoginUser: getAccountEnv(
      account,
      'X_USER',
      account.key === DEFAULT_ACCOUNT_KEY ? ['X_USER', 'X_LOGIN_USER'] : [],
    ),
    xLoginIdentifier: getAccountEnvFromPrefixes(
      account,
      ['X_LOGIN_IDENTIFIER', 'X_IDENTIFIER', 'X_EMAIL'],
      account.key === DEFAULT_ACCOUNT_KEY ? ['X_LOGIN_IDENTIFIER', 'X_IDENTIFIER', 'X_EMAIL'] : [],
    ),
    xLoginManual: isTruthyEnvValue(
      getAccountEnvFromPrefixes(
        account,
        ['X_LOGIN_MANUAL', 'X_MANUAL_LOGIN'],
        account.key === DEFAULT_ACCOUNT_KEY ? ['X_LOGIN_MANUAL', 'X_MANUAL_LOGIN'] : [],
      ),
    ),
    xLoginPass: getAccountEnv(
      account,
      'X_PASS',
      account.key === DEFAULT_ACCOUNT_KEY ? ['X_PASS', 'X_LOGIN_PASS'] : [],
    ),
    llmApiKey: requireEnv('LLM_API_KEY'),
    llmBaseUrl: process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
    llmModel: requireEnv('LLM_MODEL'),
    sessionLogPath: resolve(sessionLogsDir, `${account.key}.json`),
    engagementContext:
      process.env.ENGAGEMENT_CONTEXT ||
      // TODO: describe your brand/account and the space it operates in (fed to the LLM as context).
      `${account.displayName} operates in <your industry>. <One sentence on what your brand does and who its audience is.>`,
    engagementPersona: loadPersona(account),
  };
}
