import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSessionArgs,
  randomizeBuyerIntentLongTargets,
  randomizeBuyerIntentTargets,
  randomizeSessionTargets,
  resolveBuyerIntentSearchQueries,
} from '../../twitter-guerilla/lib/session-cli.ts';

// Mirror the placeholder vocab in lib/session-cli.ts (KEYWORD_SEARCH_SET) and
// lib/intent.ts (BUYER_INTENT_QUERIES). Update these if you change those lists.
const KEYWORD_SEARCH_SET = [
  'your search phrase one',
  'your search phrase two',
  'your search phrase three',
];
const BUYER_INTENT_QUERIES = [
  'your search query one',
  'your search query two',
  'your niche pain phrase',
];

test('parseSessionArgs defaults to a persisted browser profile', () => {
  const args = parseSessionArgs([]);

  assert.equal(args.accountInput, null);
  assert.equal(args.buyerIntentMode, false);
  assert.equal(args.communityUrl, null);
  assert.deepEqual(args.searchQueries, []);
  assert.ok(args.likes >= 15 && args.likes <= 30);
  assert.ok(args.comments >= 40 && args.comments <= 55);
});

test('parseSessionArgs accepts explicit home and buyer-intent discovery modes', () => {
  const homeArgs = parseSessionArgs(['--home']);
  const buyerArgs = parseSessionArgs(['--buyer-intent']);

  assert.equal(homeArgs.homeTimeline, true);
  assert.equal(buyerArgs.buyerIntentMode, true);
  assert.equal(buyerArgs.likes, 0);
  assert.ok(buyerArgs.comments >= 4 && buyerArgs.comments <= 8);
});

test('parseSessionArgs accepts a community URL or numeric ID', () => {
  const fromUrl = parseSessionArgs(['--community', 'https://x.com/i/communities/1234567890123456789']);
  const fromId = parseSessionArgs(['--community', '1234567890123456789']);

  assert.equal(fromUrl.communityUrl, 'https://x.com/i/communities/1234567890123456789');
  assert.equal(fromId.communityUrl, 'https://x.com/i/communities/1234567890123456789');
});

test('parseSessionArgs accepts exact search queries and saved search sets', () => {
  const fromQueries = parseSessionArgs(['--search', 'alpha topic', '--keyword', 'beta topic']);
  const fromSet = parseSessionArgs(['--search-set', 'keywords']);
  const fromKeywords = parseSessionArgs(['--keywords']);
  const fromBuyers = parseSessionArgs(['--search-set', 'buyers']);

  assert.deepEqual(fromQueries.searchQueries, ['alpha topic', 'beta topic']);
  assert.deepEqual(fromSet.searchQueries, KEYWORD_SEARCH_SET);
  assert.deepEqual(fromKeywords.searchQueries, KEYWORD_SEARCH_SET);
  assert.deepEqual(fromBuyers.searchQueries, BUYER_INTENT_QUERIES);
  assert.equal(fromBuyers.buyerIntentMode, true);
});

test('resolveBuyerIntentSearchQueries returns the explicit buyer-intent rotation', () => {
  assert.deepEqual(resolveBuyerIntentSearchQueries(), BUYER_INTENT_QUERIES);
});

test('parseSessionArgs rejects incompatible discovery mode combinations', () => {
  assert.throws(() => parseSessionArgs(['--home', '--buyer-intent']), /cannot be combined/u);
  assert.throws(
    () => parseSessionArgs(['--buyer-intent', '--community', '1234567890123456789']),
    /cannot be combined/u,
  );
});

test('randomizeSessionTargets stays within the configured engagement bands', () => {
  for (let i = 0; i < 200; i++) {
    const { likes, comments } = randomizeSessionTargets();
    assert.ok(likes >= 15 && likes <= 30);
    assert.ok(comments >= 40 && comments <= 55);
  }
});

test('randomizeBuyerIntentTargets stays within the capped buyer-intent band', () => {
  for (let i = 0; i < 200; i++) {
    const { likes, comments } = randomizeBuyerIntentTargets();
    assert.equal(likes, 0);
    assert.ok(comments >= 4 && comments <= 8);
  }
});

test('randomizeBuyerIntentLongTargets stays within the long mixed band', () => {
  for (let i = 0; i < 200; i++) {
    const { likes, comments } = randomizeBuyerIntentLongTargets();
    assert.ok(likes >= 10 && likes <= 18);
    assert.ok(comments >= 14 && comments <= 24);
  }
});

test('parseSessionArgs supports randomized long buyer-intent sessions', () => {
  const args = parseSessionArgs(['--buyer-intent-random']);
  assert.equal(args.buyerIntentMode, true);
  assert.ok(args.likes >= 10 && args.likes <= 18);
  assert.ok(args.comments >= 14 && args.comments <= 24);
});
