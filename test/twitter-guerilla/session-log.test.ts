import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findLatestSuccessfulComment,
  isSuccessfulCommentAction,
  loadSessionLogsFromDirectory,
} from '../../twitter-guerilla/lib/session-log.ts';
import type { SessionLogEntry } from '../../twitter-guerilla/lib/types.ts';

function entry(overrides: Partial<SessionLogEntry>): SessionLogEntry {
  return {
    acquisitionMode: 'general',
    discoveryKey: 'search:your topic',
    discoveryLabel: 'search "your topic"',
    sessionId: 'session-1',
    tweetId: 'tweet-1',
    authorUsername: 'author',
    action: 'liked',
    replyText: '',
    searchQuery: 'your topic',
    timestamp: '2026-04-04T00:00:00.000Z',
    success: true,
    ...overrides,
  };
}

test('isSuccessfulCommentAction only treats successful comment actions as comments', () => {
  assert.equal(isSuccessfulCommentAction(entry({ action: 'commented' })), true);
  assert.equal(isSuccessfulCommentAction(entry({ action: 'liked + commented' })), true);
  assert.equal(isSuccessfulCommentAction(entry({ action: 'liked' })), false);
  assert.equal(isSuccessfulCommentAction(entry({ action: 'commented', success: false })), false);
});

test('findLatestSuccessfulComment returns the latest successful comment entry for a tweet', () => {
  const entries: SessionLogEntry[] = [
    entry({ accountKey: 'myaccount', action: 'liked + commented', tweetId: 'tweet-1', timestamp: '2026-04-04T00:00:00.000Z' }),
    entry({ accountKey: 'otherpersona', action: 'failed', tweetId: 'tweet-1', success: false, timestamp: '2026-04-04T01:00:00.000Z' }),
    entry({ accountKey: 'otherpersona', action: 'commented', tweetId: 'tweet-1', timestamp: '2026-04-04T02:00:00.000Z' }),
    entry({ accountKey: 'myaccount', action: 'commented', tweetId: 'tweet-2', timestamp: '2026-04-04T03:00:00.000Z' }),
  ];

  const latest = findLatestSuccessfulComment(entries, 'tweet-1');

  assert.equal(latest?.accountKey, 'otherpersona');
  assert.equal(latest?.action, 'commented');
  assert.equal(findLatestSuccessfulComment(entries, 'missing-tweet'), null);
});

test('loadSessionLogsFromDirectory merges account logs for cross-account comment checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-session-logs-'));

  try {
    writeFileSync(
      join(dir, 'myaccount.json'),
      `${JSON.stringify([
        entry({
          accountKey: 'myaccount',
          action: 'commented',
          tweetId: 'tweet-3',
          timestamp: '2026-04-04T01:00:00.000Z',
        }),
      ], null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'otherpersona.json'),
      `${JSON.stringify([
        entry({
          accountKey: 'otherpersona',
          action: 'liked',
          tweetId: 'tweet-4',
          timestamp: '2026-04-04T02:00:00.000Z',
        }),
        entry({
          accountKey: 'otherpersona',
          action: 'commented',
          tweetId: 'tweet-3',
          timestamp: '2026-04-04T03:00:00.000Z',
        }),
      ], null, 2)}\n`,
      'utf8',
    );

    const entries = loadSessionLogsFromDirectory(dir);
    const latest = findLatestSuccessfulComment(entries, 'tweet-3');

    assert.equal(entries.length, 3);
    assert.equal(latest?.accountKey, 'otherpersona');
    assert.equal(latest?.discoveryLabel, 'search "your topic"');
    assert.equal(latest?.timestamp, '2026-04-04T03:00:00.000Z');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
