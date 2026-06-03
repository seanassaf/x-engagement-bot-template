import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBuyerIntentRoutingOutcome,
  applySearchQueryOutcome,
  buildAdaptiveSearchScanPlan,
  createBuyerIntentRoutingState,
  createSearchQueryStateMap,
  hasRunnableSearchQueries,
  shouldUseBuyerIntentHomeFallback,
  selectAdaptiveSearchQuery,
} from '../../twitter-guerilla/lib/search-adaptation.ts';

test('selectAdaptiveSearchQuery prefers unexplored queries first', () => {
  const queries = ['one', 'two', 'three'];
  const stateMap = createSearchQueryStateMap(queries);
  stateMap.one = applySearchQueryOutcome(stateMap.one, {
    discoveryPass: 1,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: true,
  });

  assert.equal(selectAdaptiveSearchQuery(queries, stateMap, 2), 'two');
});

test('applySearchQueryOutcome cools down sparse queries after repeated zero-target passes', () => {
  let state = applySearchQueryOutcome(undefined, {
    discoveryPass: 1,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: true,
  });
  state = applySearchQueryOutcome(state, {
    discoveryPass: 2,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: true,
  });

  assert.equal(state.cooldownUntilPass, 6);
  assert.equal(state.exhausted, false);
});

test('applySearchQueryOutcome exhausts queries after repeated stale passes', () => {
  let state = applySearchQueryOutcome(undefined, {
    discoveryPass: 1,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: false,
  });
  state = applySearchQueryOutcome(state, {
    discoveryPass: 2,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: false,
  });

  assert.equal(state.exhausted, true);
});

test('selectAdaptiveSearchQuery revisits productive queries after exploration', () => {
  const queries = ['one', 'two'];
  const stateMap = createSearchQueryStateMap(queries);
  stateMap.one = applySearchQueryOutcome(stateMap.one, {
    discoveryPass: 1,
    selectedTargets: 2,
    successfulComments: 1,
    hadNewCandidates: true,
  });
  stateMap.two = applySearchQueryOutcome(stateMap.two, {
    discoveryPass: 2,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: true,
  });

  assert.equal(selectAdaptiveSearchQuery(queries, stateMap, 3), 'one');
});

test('buildAdaptiveSearchScanPlan shrinks scan size for sparse queries', () => {
  const sparsePlan = buildAdaptiveSearchScanPlan(40, {
    passes: 1,
    selectedTargets: 0,
    successfulComments: 0,
    consecutiveZeroTargetPasses: 1,
    stalePasses: 0,
    cooldownUntilPass: 0,
    exhausted: false,
    lastUsedPass: 1,
  });
  const productivePlan = buildAdaptiveSearchScanPlan(40, {
    passes: 1,
    selectedTargets: 2,
    successfulComments: 1,
    consecutiveZeroTargetPasses: 0,
    stalePasses: 0,
    cooldownUntilPass: 0,
    exhausted: false,
    lastUsedPass: 1,
  });

  assert.deepEqual(sparsePlan, {
    targetCount: 7,
    minScrolls: 9,
    maxExtraScrolls: 2,
  });
  assert.deepEqual(productivePlan, {
    targetCount: 10,
    minScrolls: 12,
    maxExtraScrolls: 3,
  });
});

test('shouldUseBuyerIntentHomeFallback turns on when routing state has home passes queued', () => {
  const queries = ['one'];
  const stateMap = createSearchQueryStateMap(queries);
  const routingState = createBuyerIntentRoutingState();
  routingState.homeFallbackPassesRemaining = 2;

  assert.equal(shouldUseBuyerIntentHomeFallback(routingState, queries, stateMap, 3), true);
});

test('shouldUseBuyerIntentHomeFallback turns on when no search queries are runnable', () => {
  const queries = ['one'];
  const stateMap = createSearchQueryStateMap(queries);
  stateMap.one = applySearchQueryOutcome(stateMap.one, {
    discoveryPass: 1,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: false,
  });
  stateMap.one = applySearchQueryOutcome(stateMap.one, {
    discoveryPass: 2,
    selectedTargets: 0,
    successfulComments: 0,
    hadNewCandidates: false,
  });

  assert.equal(hasRunnableSearchQueries(queries, stateMap, 3), false);
  assert.equal(
    shouldUseBuyerIntentHomeFallback(createBuyerIntentRoutingState(), queries, stateMap, 3),
    true,
  );
});

test('applyBuyerIntentRoutingOutcome arms fallback after repeated weak search passes', () => {
  let routingState = createBuyerIntentRoutingState();
  routingState = applyBuyerIntentRoutingOutcome(routingState, {
    selectedTargets: 0,
    successfulComments: 0,
    usedHomeFallback: false,
  });
  routingState = applyBuyerIntentRoutingOutcome(routingState, {
    selectedTargets: 0,
    successfulComments: 0,
    usedHomeFallback: false,
  });
  routingState = applyBuyerIntentRoutingOutcome(routingState, {
    selectedTargets: 0,
    successfulComments: 0,
    usedHomeFallback: false,
  });

  assert.equal(routingState.homeFallbackPassesRemaining, 2);
});

test('applyBuyerIntentRoutingOutcome consumes queued home fallback passes', () => {
  let routingState = createBuyerIntentRoutingState();
  routingState.homeFallbackPassesRemaining = 2;

  routingState = applyBuyerIntentRoutingOutcome(routingState, {
    selectedTargets: 1,
    successfulComments: 1,
    usedHomeFallback: true,
  });

  assert.equal(routingState.homeFallbackPassesRemaining, 1);
  assert.equal(routingState.homePasses, 1);
  assert.equal(routingState.homeSuccessfulComments, 1);
});
