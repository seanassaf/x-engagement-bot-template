import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../twitter-guerilla/lib/config.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');

const REQUIRED_ENV = {
  LLM_API_KEY: 'test-llm-key',
  LLM_MODEL: 'test-model',
  X_ACCESS_SECRET: 'test-access-secret',
  X_ACCESS_TOKEN: 'test-access-token',
  X_API_KEY: 'test-api-key',
  X_API_SECRET: 'test-api-secret',
};

test('loadConfig composes base and persona specific instructions', () => {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const config = loadConfig('myaccount');
    assert.match(config.engagementPersona, /You are operating an X persona for/u);
    assert.match(config.engagementPersona, /You are @myaccount/u);
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});


test('browserProfileDir is anchored to the repo root instead of process cwd', () => {
  const previousEnv = new Map<string, string | undefined>();
  const originalCwd = process.cwd();

  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    process.chdir('/tmp');
    const config = loadConfig('myaccount');
    assert.equal(config.browserProfileDir, resolve(REPO_ROOT, '.x-browser-profiles/myaccount'));
    assert.equal(config.sessionLogPath, resolve(REPO_ROOT, '.x-session-logs/myaccount.json'));
  } finally {
    process.chdir(originalCwd);

    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('loadConfig prefers persona-specific verification identifiers for X login challenges', () => {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries({
    ...REQUIRED_ENV,
    X_LOGIN_IDENTIFIER_MYACCOUNT: 'myaccount-login@example.com',
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const config = loadConfig('myaccount');
    assert.equal(config.xLoginIdentifier, 'myaccount-login@example.com');
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('loadConfig reads manual-login flags for new persona accounts', () => {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries({
    ...REQUIRED_ENV,
    X_USER_MYACCOUNT: 'myaccount',
    X_LOGIN_MANUAL_MYACCOUNT: '1',
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const config = loadConfig('myaccount');
    assert.equal(config.xLoginUser, 'myaccount');
    assert.equal(config.xLoginManual, true);
    assert.equal(config.browserProfileDir, resolve(REPO_ROOT, '.x-browser-profiles/myaccount'));
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('loadConfig uses Railway volume-backed runtime paths and headless browser flags when configured', () => {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries({
    ...REQUIRED_ENV,
    RAILWAY_PROJECT_ID: 'project-123',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    BROWSER_HEADLESS: 'true',
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const config = loadConfig('myaccount');
    assert.equal(config.browserProfileDir, '/data/.x-browser-profiles/myaccount');
    assert.equal(config.sessionLogPath, '/data/.x-session-logs/myaccount.json');
    assert.equal(config.browserHeadless, true);
    assert.equal(config.browserDisableSandbox, true);
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('loadConfig respects explicit runtime directory overrides', () => {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries({
    ...REQUIRED_ENV,
    BROWSER_PROFILES_DIR: '/state/browser-profiles',
    SESSION_LOGS_DIR: '/state/session-logs',
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const config = loadConfig('myaccount');
    assert.equal(config.browserProfileDir, '/state/browser-profiles/myaccount');
    assert.equal(config.sessionLogPath, '/state/session-logs/myaccount.json');
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
