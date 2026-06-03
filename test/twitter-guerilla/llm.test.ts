import test from 'node:test';
import assert from 'node:assert/strict';

import { inferAccountReplyDirective, inferReplyMode } from '../../twitter-guerilla/lib/llm.ts';
import type { TweetRecord } from '../../twitter-guerilla/lib/types.ts';

function buildTweet(text: string, id = '1'): TweetRecord {
  return {
    author: { description: '', id, name: 'Example', username: 'example' },
    createdAt: '2026-04-03T00:00:00.000Z',
    id,
    metrics: null,
    replySettings: null,
    text,
  };
}

test('inferReplyMode marks celebratory casual posts as social-first', () => {
  const mode = inferReplyMode(buildTweet('finally won big enough for pizza tonight'));
  assert.equal(mode.sourceStyle, 'celebratory');
  assert.match(mode.replyStyleHint, /Congratulate|human social reply/u);
});

test('inferReplyMode keeps analytical posts in analytical mode', () => {
  const mode = inferReplyMode(buildTweet('the data and metrics show our workflow process needs analysis'));
  assert.equal(mode.sourceStyle, 'analytical');
  assert.match(mode.replyStyleHint, /analytical angle|structural observation/u);
});

test('fresh posts use a viral-first directive across accounts', () => {
  const tweet = {
    ...buildTweet('headline just dropped'),
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  };
  const directive = inferAccountReplyDirective('myaccount', tweet);
  assert.equal(directive.strategy, 'viral-first');
  assert.match(directive.candidatePlan[0], /viral/u);
});

test('baseline non-fresh posts stay engagement-first', () => {
  const directive = inferAccountReplyDirective('myaccount', buildTweet('shipped a clean update today', '2039726228416962932'));
  assert.equal(directive.strategy, 'best-engagement');
  assert.match(directive.candidatePlan[0], /strongest publish ready engagement/u);
});

test('high-intent posts use a buyer-intent qualification directive', () => {
  const directive = inferAccountReplyDirective(
    'myaccount',
    buildTweet('anyone know a tool for this? looking for a better way to automate the whole process', '2039726228416962938'),
  );

  assert.equal(directive.strategy, 'buyer-intent-qualification');
  assert.match(directive.strategyHint, /buyer intent|product-free/u);
  assert.match(directive.candidatePlan[0], /problem-aware/u);
  assert.match(directive.candidatePlan[1], /diagnostic question/u);
  assert.match(directive.candidatePlan[2], /frames the gap|product pitch/u);
});

test('buyer-intent sessions use a qualification directive', () => {
  const directive = inferAccountReplyDirective(
    'myaccount',
    buildTweet('our process is still messy and nobody likes it', '2039726228416962940'),
    { discoveryMode: 'buyer-intent' },
  );

  assert.equal(directive.strategy, 'buyer-intent-qualification');
  assert.match(directive.strategyHint, /buyer intent|product-free/u);
  assert.match(directive.candidatePlan[0], /problem-aware/u);
});
