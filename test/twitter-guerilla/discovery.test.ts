import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterAndRank,
  followerBandScore,
  isLikeFollowerCountAllowed,
  isLowSignalPostText,
  isPostAgeAllowed,
  isPriorityAccountProfile,
  recencyScoreFromAgeMs,
  selectPrimaryStatusLink,
} from '../../twitter-guerilla/lib/discovery.ts';

const TWITTER_EPOCH = 1288834974657n;
const makeTweetId = (ageMs: number) => ((BigInt(Date.now() - ageMs) - TWITTER_EPOCH) << 22n).toString();

function makeConfig(key = 'myaccount') {
  return {
    account: { displayName: 'Test', envKey: key.toUpperCase(), key, personaPath: 'test.md' },
    browserProfileDir: '', engagementContext: '', engagementPersona: '',
    llmApiKey: '', llmBaseUrl: '', llmModel: '', sessionLogPath: '',
    xApiBaseUrl: 'https://api.x.com', xApiKey: 'key', xApiSecret: 'secret',
    xAccessToken: 'token', xAccessSecret: 'access-secret', xLoginPass: null, xLoginUser: null,
  } as any;
}

function profile(username: string, description: string, followers: number, name = username) {
  return { username, name, description, public_metrics: { followers_count: followers } };
}

function candidate(username: string, tweetText: string, extra: Record<string, unknown> = {}) {
  return {
    alreadyLiked: false,
    authorFollowersCount: null,
    authorUsername: username,
    isPromoted: false,
    likeCount: 20,
    statusUrl: `/${username}/status/1`,
    tweetId: makeTweetId(10 * 60 * 1000),
    tweetText,
    ...extra,
  } as any;
}

async function withProfiles<T>(profiles: unknown[], fn: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/2/users/by')) {
      return new Response(JSON.stringify({ data: profiles }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof global.fetch;

  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

// High-intent prospect copy scored by the (placeholder) buyer-intent vocab in lib/intent.ts.
const PROSPECT_PAIN = 'anyone know a tool for this? looking for a better way to automate the whole process';

test('isLowSignalPostText rejects greeting/emoji spam but keeps substantive posts', () => {
  assert.equal(isLowSignalPostText('gm hi hey'), true);
  assert.equal(isLowSignalPostText('🔥🔥🔥'), true);
  assert.equal(isLowSignalPostText('this is a substantive post about a real topic'), false);
});

test('recencyScoreFromAgeMs rewards fresher posts across the three-hour window', () => {
  assert.equal(recencyScoreFromAgeMs(10 * 60 * 1000), 4);
  assert.equal(recencyScoreFromAgeMs(35 * 60 * 1000), 3);
  assert.equal(recencyScoreFromAgeMs(90 * 60 * 1000), 2);
  assert.equal(recencyScoreFromAgeMs(170 * 60 * 1000), 1);
  assert.equal(recencyScoreFromAgeMs(181 * 60 * 1000), 0);
});

test('isPostAgeAllowed accepts posts up to three hours old', () => {
  assert.equal(isPostAgeAllowed(179 * 60 * 1000), true);
  assert.equal(isPostAgeAllowed(181 * 60 * 1000), false);
});

test('followerBandScore prefers authors in the absolute target follower band', () => {
  assert.equal(followerBandScore(5000, 1000), 4);
  assert.equal(followerBandScore(1500, 1000), 4);
  assert.equal(followerBandScore(25000, 1000), 1);
});

test('isPriorityAccountProfile returns false by default (template placeholder)', () => {
  assert.equal(isPriorityAccountProfile({ username: 'x', name: 'X', description: 'anything' }), false);
});

test('selectPrimaryStatusLink prefers the newest status for the preferred author', () => {
  const selected = selectPrimaryStatusLink(
    [
      '/OtherUser/status/2049420195526295639',
      '/PreferredUser/status/275693747',
      '/PreferredUser/status/2049421682864247079',
    ],
    'PreferredUser',
  );

  assert.deepEqual(selected, {
    authorUsername: 'PreferredUser',
    href: '/PreferredUser/status/2049421682864247079',
    tweetId: '2049421682864247079',
  });
});

test('isLikeFollowerCountAllowed only permits likes below 8,000 followers', () => {
  assert.equal(isLikeFollowerCountAllowed(7999), true);
  assert.equal(isLikeFollowerCountAllowed(8000), false);
  assert.equal(isLikeFollowerCountAllowed(null), false);
});

test('filterAndRank requires like-eligible accounts when likes are the only goal', async () => {
  const result = await withProfiles(
    [profile('smallcap', 'operator', 3200), profile('bigcap', 'operator', 12000), profile('me', 'me', 500)],
    () =>
      filterAndRank(
        [
          candidate('smallcap', 'a quick note about your-core-keyword-one today'),
          candidate('bigcap', 'a quick note about your-core-keyword-one today'),
        ],
        'me',
        10,
        makeConfig(),
        { likeEligibilityMode: 'require' },
      ),
  );
  assert.deepEqual(result.map((c) => c.authorUsername), ['smallcap']);
});

test('filterAndRank treats an explicit search query as the relevance gate', async () => {
  const result = await withProfiles(
    [profile('searchmatch', 'operator', 3200), profile('searchmiss', 'operator', 2800), profile('me', 'me', 500)],
    () =>
      filterAndRank(
        [
          candidate('searchmatch', 'your topic has been on my mind all week'),
          candidate('searchmiss', 'completely unrelated chatter about lunch plans'),
        ],
        'me',
        10,
        makeConfig(),
        { searchQuery: 'your topic' },
      ),
  );
  assert.deepEqual(result.map((c) => c.authorUsername), ['searchmatch']);
});

test('filterAndRank in targeted mode prefers explicit buyer-intent and filters broad chatter', async () => {
  const result = await withProfiles(
    [profile('prospect', 'operator', 1800), profile('broad', 'poster', 1900), profile('me', 'me', 500)],
    () =>
      filterAndRank(
        [
          candidate('prospect', PROSPECT_PAIN),
          candidate('broad', 'great weather today, perfect for a long walk'),
        ],
        'me',
        10,
        makeConfig(),
        { acquisitionMode: 'targeted' },
      ),
  );
  assert.deepEqual(result.map((c) => c.authorUsername), ['prospect']);
  assert.ok((result[0].intentScore ?? 0) >= 8);
});

test('filterAndRank in targeted mode recognizes operator and automation signals', async () => {
  const result = await withProfiles(
    [profile('operator', 'founder', 2200), profile('broad', 'poster', 1900), profile('me', 'me', 500)],
    () =>
      filterAndRank(
        [
          candidate('operator', 'i run my whole process and an ai agent automates the workflow for me'),
          candidate('broad', 'markets are choppy and everyone is glued to the news'),
        ],
        'me',
        10,
        makeConfig(),
        { acquisitionMode: 'targeted' },
      ),
  );
  assert.deepEqual(result.map((c) => c.authorUsername), ['operator']);
  assert.ok((result[0].intentScore ?? 0) >= 8);
});

test('filterAndRank in targeted mode skips competitor-promotional accounts', async () => {
  const result = await withProfiles(
    [
      profile('sometool', 'the best tool and platform for teams', 2200, 'Some Tool'),
      profile('realuser', 'operator at a startup', 1400),
      profile('me', 'me', 500),
    ],
    () =>
      filterAndRank(
        [
          candidate('sometool', 'sign up for our tool. free trial. book a demo today.'),
          candidate('realuser', 'whats the best tool for a small team?'),
        ],
        'me',
        10,
        makeConfig(),
        { acquisitionMode: 'targeted', searchQuery: 'tool' },
      ),
  );
  assert.deepEqual(result.map((c) => c.authorUsername), ['realuser']);
});
