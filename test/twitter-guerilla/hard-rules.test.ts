import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCandidateEngagementAllowed,
  assertEngagementAllowed,
  assertTweetEngagementAllowed,
  isBlockedUsername,
  isRetweetText,
  normalizeUsername,
} from '../../twitter-guerilla/lib/hard-rules.ts';
import type { FeedCandidate, TweetRecord } from '../../twitter-guerilla/lib/types.ts';

function buildTweet(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    author: {
      description: '',
      id: '1',
      name: 'Example',
      username: 'example',
    },
    createdAt: '2026-04-05T00:00:00.000Z',
    id: '1',
    metrics: null,
    replySettings: null,
    text: 'this workflow tool is finally getting easier to manage',
    ...overrides,
  };
}

function buildCandidate(overrides: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    alreadyLiked: false,
    authorFollowersCount: 1200,
    authorUsername: 'example',
    isPromoted: false,
    likeCount: 100,
    statusUrl: '/example/status/1',
    tweetId: '1',
    tweetText: 'this workflow tool is finally getting easier to manage',
    ...overrides,
  };
}

test('normalizeUsername strips @ and lowercases handles', () => {
  assert.equal(normalizeUsername('@SomeUser'), 'someuser');
});

test('isBlockedUsername returns false when the blocklist is empty (template default)', () => {
  assert.equal(isBlockedUsername('@anyone'), false);
  assert.equal(isBlockedUsername('someone_else'), false);
});

test('assertEngagementAllowed throws when the author cannot be verified', () => {
  assert.throws(
    () => assertEngagementAllowed(null, 'engage'),
    /refusing to engage because the author could not be verified/u,
  );
});

test('isRetweetText matches classic RT prefixes', () => {
  assert.equal(isRetweetText('RT @someone: the tool is back'), true);
  assert.equal(isRetweetText('fresh take, not a retweet'), false);
});

test('assertCandidateEngagementAllowed throws for retweet and quote-tweet candidates', () => {
  assert.throws(
    () => assertCandidateEngagementAllowed(buildCandidate({ isRetweet: true }), 'engage'),
    /Hard rule: refusing to engage with retweet\./u,
  );
  assert.throws(
    () => assertCandidateEngagementAllowed(buildCandidate({ isQuoteTweet: true }), 'reply'),
    /Hard rule: refusing to reply with quote tweet\./u,
  );
});

test('assertTweetEngagementAllowed throws for retweets and quote tweets from API metadata', () => {
  assert.throws(
    () =>
      assertTweetEngagementAllowed(
        buildTweet({
          referencedTweets: [{ id: '2', type: 'retweeted' }],
        }),
        'like',
      ),
    /Hard rule: refusing to like with retweet\./u,
  );
  assert.throws(
    () =>
      assertTweetEngagementAllowed(
        buildTweet({
          referencedTweets: [{ id: '2', type: 'quoted' }],
        }),
        'reply',
      ),
    /Hard rule: refusing to reply with quote tweet\./u,
  );
});
