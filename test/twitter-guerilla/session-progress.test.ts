import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionPlan } from '../../twitter-guerilla/lib/session-progress.ts';

test('buildSessionPlan tracks remaining work until both goals are met', () => {
  const plan = buildSessionPlan(
    { likes: 30, comments: 10 },
    { likes: 12, comments: 4 },
  );

  assert.equal(plan.complete, false);
  assert.equal(plan.likesRemaining, 18);
  assert.equal(plan.commentsRemaining, 6);
  assert.equal(plan.shouldLike, true);
  assert.equal(plan.shouldComment, true);
  assert.equal(plan.targetCount, 18);
});

test('buildSessionPlan still allows comments after likes are done', () => {
  const plan = buildSessionPlan(
    { likes: 20, comments: 8 },
    { likes: 20, comments: 7 },
  );

  assert.equal(plan.complete, false);
  assert.equal(plan.shouldLike, false);
  assert.equal(plan.shouldComment, true);
  assert.equal(plan.targetCount, 1);
});

test('buildSessionPlan marks the session complete only when both counts are satisfied', () => {
  const plan = buildSessionPlan(
    { likes: 20, comments: 8 },
    { likes: 21, comments: 8 },
  );

  assert.equal(plan.complete, true);
  assert.equal(plan.likesRemaining, 0);
  assert.equal(plan.commentsRemaining, 0);
  assert.equal(plan.targetCount, 0);
});
