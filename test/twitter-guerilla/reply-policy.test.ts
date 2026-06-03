import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertReplyCandidatesAllowed,
  assertReplyTextAllowed,
  countWords,
  repairReplyText,
  resolveReplyPolicy,
} from '../../twitter-guerilla/lib/reply-policy.ts';
import type { TweetRecord } from '../../twitter-guerilla/lib/types.ts';

// Kept deliberately below the high-intent threshold so default-policy (8-word) tests apply.
const tweet: TweetRecord = {
  author: {
    description: 'operator',
    id: '1',
    name: 'Example User',
    username: 'example',
  },
  createdAt: '2026-04-02T00:00:00.000Z',
  id: '123',
  metrics: null,
  replySettings: null,
  text: 'Spent the whole morning catching up on threads after a busy week of calls.',
};

test('countWords uses the enforced 8-word limit semantics', () => {
  assert.equal(countWords('the handoff is where it all breaks'), 7);
});

test('assertReplyTextAllowed accepts concise original replies', () => {
  assert.doesNotThrow(() => assertReplyTextAllowed('the handoff is where it breaks', tweet));
});

test('assertReplyTextAllowed rejects obvious policy violations', () => {
  assert.throws(
    () => assertReplyTextAllowed('this is a total game changer', tweet),
    /hype\/spam language/u,
  );
  assert.throws(
    () => assertReplyTextAllowed('catching up on threads', tweet),
    /paraphrase the source post/u,
  );
});

test('assertReplyCandidatesAllowed rejects duplicate candidates', () => {
  assert.throws(
    () =>
      assertReplyCandidatesAllowed(
        ['the handoff is where it breaks', 'the handoff is where it breaks', 'context always gets lost'],
        tweet,
      ),
    /must be distinct/u,
  );
});

test('repairReplyText trims long replies down to policy-safe length', () => {
  assert.equal(
    repairReplyText('managing every single thread by hand still breaks down constantly', tweet),
    'managing every single thread by hand still breaks',
  );
});

test('repairReplyText removes forbidden formatting when possible', () => {
  assert.equal(
    repairReplyText('clean handoff - no tool needed #ops', tweet),
    'clean handoff no tool needed ops',
  );
});

test('resolveReplyPolicy opens a longer reply lane on high-intent threads', () => {
  const policy = resolveReplyPolicy(
    'myaccount',
    { ...tweet, text: 'anyone know a good tool for this? looking for a better way to automate the whole process' },
  );

  assert.equal(policy.profile, 'buyer-intent');
  assert.equal(policy.maxWords, 14);
});

test('default policy still blocks product mentions on non-intent threads', () => {
  assert.throws(
    () => assertReplyTextAllowed('yourbrand tracks this cleanly', tweet),
    /mentions yourbrand outside an explicit high-intent thread/u,
  );
});

test('high-intent threads still block explicit product mentions', () => {
  const intentTweet = {
    ...tweet,
    text: 'anyone know a tool to automate this? looking for a better way, tired of doing it by hand',
  };

  assert.throws(() =>
    assertReplyTextAllowed('yourbrand handles this cleanly', intentTweet, {
      accountKey: 'myaccount',
    }),
    /mentions yourbrand outside an explicit high-intent thread/u,
  );
});
