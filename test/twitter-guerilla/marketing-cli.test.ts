import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarketingCliArgs } from '../../twitter-guerilla/lib/marketing-cli.ts';

test('parseMarketingCliArgs shows root help by default', () => {
  const parsed = parseMarketingCliArgs([]);

  assert.deepEqual(parsed, {
    kind: 'help',
    topic: 'root',
    exitCode: 0,
    error: undefined,
  });
});

test('parseMarketingCliArgs routes single-session aliases through the marketing CLI', () => {
  const parsed = parseMarketingCliArgs(['session', 'myaccount', '--dry-run']);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-session.ts',
    args: ['--account', 'myaccount', '--dry-run'],
  });
});

test('parseMarketingCliArgs forwards session flags that start the argv tail', () => {
  const parsed = parseMarketingCliArgs([
    'session',
    '--community',
    'https://x.com/i/communities/1234567890123456789',
    '--dry-run',
  ]);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-session.ts',
    args: ['--community', 'https://x.com/i/communities/1234567890123456789', '--dry-run'],
  });
});

test('parseMarketingCliArgs forwards exact search flags through the session command', () => {
  const parsed = parseMarketingCliArgs([
    'session',
    'myaccount',
    '--search',
    'your search query',
  ]);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-session.ts',
    args: ['--account', 'myaccount', '--search', 'your search query'],
  });
});

test('parseMarketingCliArgs forwards the keywords shorthand through the session command', () => {
  const parsed = parseMarketingCliArgs([
    'session',
    'myaccount',
    '--keywords',
  ]);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-session.ts',
    args: ['--account', 'myaccount', '--keywords'],
  });
});

test('parseMarketingCliArgs routes batch sessions through the all subcommand', () => {
  const parsed = parseMarketingCliArgs(['session', 'all', 'tb', '--sessions', '2']);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-session-all.ts',
    args: ['tb', '--sessions', '2'],
  });
});

test('parseMarketingCliArgs exposes subcommand help', () => {
  const parsed = parseMarketingCliArgs(['session', 'all', '--help']);

  assert.deepEqual(parsed, {
    kind: 'help',
    topic: 'session-all',
    exitCode: 0,
    error: undefined,
  });
});

test('parseMarketingCliArgs forwards engage arguments untouched', () => {
  const parsed = parseMarketingCliArgs(['engage', 'tb', '123456789']);

  assert.deepEqual(parsed, {
    kind: 'run',
    scriptPath: 'twitter-guerilla/x-engagement.ts',
    args: ['tb', '123456789'],
  });
});

test('parseMarketingCliArgs rejects unknown commands with help output', () => {
  const parsed = parseMarketingCliArgs(['unknown']);

  assert.equal(parsed.kind, 'help');
  assert.equal(parsed.topic, 'root');
  assert.equal(parsed.exitCode, 1);
  assert.match(parsed.error ?? '', /Unknown command/u);
});
