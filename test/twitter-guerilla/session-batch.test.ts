import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSessionBatchArgs } from '../../twitter-guerilla/lib/session-batch.ts';

test('parseSessionBatchArgs defaults to all accounts and one session each', () => {
  const args = parseSessionBatchArgs([]);

  assert.equal(args.sessionsPerAccount, 1);
  assert.equal(args.continueOnError, true);
  assert.deepEqual(args.accounts, ['myaccount']);
  assert.deepEqual(args.sessionArgs, []);
});

test('parseSessionBatchArgs collects accounts and forwards session flags', () => {
  const args = parseSessionBatchArgs([
    '--account',
    'myaccount',
    '--sessions',
    '2',
    '--search',
    'your search query',
    '--fresh-session',
    '--dry-run',
    '--likes',
    '10',
    'myaccount',
  ]);

  assert.equal(args.sessionsPerAccount, 2);
  assert.deepEqual(args.accounts, ['myaccount']);
  assert.deepEqual(args.sessionArgs, ['--search', 'your search query', '--fresh-session', '--dry-run', '--likes', '10']);
});

test('parseSessionBatchArgs supports fail-fast mode', () => {
  const args = parseSessionBatchArgs(['--fail-fast']);

  assert.equal(args.continueOnError, false);
});
