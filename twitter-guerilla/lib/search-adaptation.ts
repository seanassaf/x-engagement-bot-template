export type SearchQueryState = {
  passes: number;
  selectedTargets: number;
  successfulComments: number;
  consecutiveZeroTargetPasses: number;
  stalePasses: number;
  cooldownUntilPass: number;
  exhausted: boolean;
  lastUsedPass: number;
};

export type SearchQueryStateMap = Record<string, SearchQueryState>;

export type SearchQueryOutcome = {
  discoveryPass: number;
  selectedTargets: number;
  successfulComments: number;
  hadNewCandidates: boolean;
};

export type SearchScanPlan = {
  targetCount: number;
  minScrolls: number;
  maxExtraScrolls: number;
};

export type BuyerIntentRoutingState = {
  homeFallbackPassesRemaining: number;
  homePasses: number;
  homeSuccessfulComments: number;
  searchPasses: number;
  searchSelectedTargets: number;
  searchSuccessfulComments: number;
  searchZeroTargetPasses: number;
};

function createEmptyState(): SearchQueryState {
  return {
    passes: 0,
    selectedTargets: 0,
    successfulComments: 0,
    consecutiveZeroTargetPasses: 0,
    stalePasses: 0,
    cooldownUntilPass: 0,
    exhausted: false,
    lastUsedPass: 0,
  };
}

export function createSearchQueryStateMap(queries: string[]): SearchQueryStateMap {
  const stateMap: SearchQueryStateMap = {};

  for (const query of queries) {
    stateMap[query] = createEmptyState();
  }

  return stateMap;
}

export function createBuyerIntentRoutingState(): BuyerIntentRoutingState {
  return {
    homeFallbackPassesRemaining: 0,
    homePasses: 0,
    homeSuccessfulComments: 0,
    searchPasses: 0,
    searchSelectedTargets: 0,
    searchSuccessfulComments: 0,
    searchZeroTargetPasses: 0,
  };
}

export function selectAdaptiveSearchQuery(
  queries: string[],
  stateMap: SearchQueryStateMap,
  discoveryPass: number,
): string {
  if (queries.length === 0) {
    throw new Error('At least one query is required.');
  }

  const eligible = queries.filter((query) => {
    const state = stateMap[query] ?? createEmptyState();
    return !state.exhausted && state.cooldownUntilPass < discoveryPass;
  });

  const pool = eligible.length > 0
    ? eligible
    : queries.filter((query) => !(stateMap[query]?.exhausted ?? false));

  if (pool.length === 0) {
    return queries[(discoveryPass - 1) % queries.length];
  }

  const unexplored = pool.filter((query) => (stateMap[query]?.passes ?? 0) === 0);
  if (unexplored.length > 0) {
    return unexplored[0];
  }

  const productive = pool
    .filter((query) => {
      const state = stateMap[query] ?? createEmptyState();
      return state.successfulComments > 0 || state.selectedTargets > 0;
    })
    .sort((left, right) => compareProductiveQueries(left, right, stateMap));
  if (productive.length > 0) {
    return productive[0];
  }

  return [...pool].sort((left, right) => compareSparseQueries(left, right, stateMap))[0];
}

export function hasRunnableSearchQueries(
  queries: string[],
  stateMap: SearchQueryStateMap,
  discoveryPass: number,
): boolean {
  return queries.some((query) => {
    const state = stateMap[query] ?? createEmptyState();
    return !state.exhausted && state.cooldownUntilPass < discoveryPass;
  });
}

function compareProductiveQueries(left: string, right: string, stateMap: SearchQueryStateMap): number {
  const a = stateMap[left] ?? createEmptyState();
  const b = stateMap[right] ?? createEmptyState();

  if (a.successfulComments !== b.successfulComments) {
    return b.successfulComments - a.successfulComments;
  }
  if (a.selectedTargets !== b.selectedTargets) {
    return b.selectedTargets - a.selectedTargets;
  }
  if (a.consecutiveZeroTargetPasses !== b.consecutiveZeroTargetPasses) {
    return a.consecutiveZeroTargetPasses - b.consecutiveZeroTargetPasses;
  }
  return a.lastUsedPass - b.lastUsedPass;
}

function compareSparseQueries(left: string, right: string, stateMap: SearchQueryStateMap): number {
  const a = stateMap[left] ?? createEmptyState();
  const b = stateMap[right] ?? createEmptyState();

  if (a.consecutiveZeroTargetPasses !== b.consecutiveZeroTargetPasses) {
    return a.consecutiveZeroTargetPasses - b.consecutiveZeroTargetPasses;
  }
  if (a.stalePasses !== b.stalePasses) {
    return a.stalePasses - b.stalePasses;
  }
  if (a.passes !== b.passes) {
    return a.passes - b.passes;
  }
  return a.lastUsedPass - b.lastUsedPass;
}

export function applySearchQueryOutcome(
  currentState: SearchQueryState | undefined,
  outcome: SearchQueryOutcome,
): SearchQueryState {
  const previous = currentState ?? createEmptyState();
  const next: SearchQueryState = {
    ...previous,
    passes: previous.passes + 1,
    selectedTargets: previous.selectedTargets + outcome.selectedTargets,
    successfulComments: previous.successfulComments + outcome.successfulComments,
    lastUsedPass: outcome.discoveryPass,
  };

  if (outcome.hadNewCandidates) {
    next.stalePasses = 0;
  } else {
    next.stalePasses = previous.stalePasses + 1;
  }

  if (outcome.selectedTargets > 0) {
    next.consecutiveZeroTargetPasses = 0;
    next.cooldownUntilPass = 0;
  } else {
    next.consecutiveZeroTargetPasses = previous.consecutiveZeroTargetPasses + 1;

    if (next.consecutiveZeroTargetPasses >= 2) {
      const cooldownLength = next.successfulComments > 0 || next.selectedTargets > 0 ? 2 : 4;
      next.cooldownUntilPass = outcome.discoveryPass + cooldownLength;
    }
  }

  if (next.stalePasses >= 2) {
    next.exhausted = true;
  }

  if (next.passes >= 3 && next.selectedTargets === 0 && next.successfulComments === 0) {
    next.exhausted = true;
  }

  return next;
}

export function buildAdaptiveSearchScanPlan(
  defaultTargetCount: number,
  state: SearchQueryState | undefined,
): SearchScanPlan {
  const current = state ?? createEmptyState();
  const productive = current.successfulComments > 0 || current.selectedTargets > 0;
  const sparse = current.passes > 0 && !productive;

  if (productive) {
    return {
      targetCount: Math.min(defaultTargetCount, 10),
      minScrolls: 12,
      maxExtraScrolls: 3,
    };
  }

  if (sparse) {
    return {
      targetCount: Math.min(defaultTargetCount, 7),
      minScrolls: 9,
      maxExtraScrolls: 2,
    };
  }

  return {
    targetCount: Math.min(defaultTargetCount, 9),
    minScrolls: 10,
    maxExtraScrolls: 3,
  };
}

export function shouldUseBuyerIntentHomeFallback(
  state: BuyerIntentRoutingState,
  queries: string[],
  queryStateMap: SearchQueryStateMap,
  discoveryPass: number,
): boolean {
  if (state.homeFallbackPassesRemaining > 0) {
    return true;
  }

  if (!hasRunnableSearchQueries(queries, queryStateMap, discoveryPass)) {
    return true;
  }

  return false;
}

export function applyBuyerIntentRoutingOutcome(
  currentState: BuyerIntentRoutingState,
  outcome: {
    selectedTargets: number;
    successfulComments: number;
    usedHomeFallback: boolean;
  },
): BuyerIntentRoutingState {
  const next: BuyerIntentRoutingState = {
    ...currentState,
  };

  if (outcome.usedHomeFallback) {
    next.homePasses += 1;
    next.homeSuccessfulComments += outcome.successfulComments;
    next.homeFallbackPassesRemaining = Math.max(currentState.homeFallbackPassesRemaining - 1, 0);
    return next;
  }

  next.searchPasses += 1;
  next.searchSelectedTargets += outcome.selectedTargets;
  next.searchSuccessfulComments += outcome.successfulComments;
  next.searchZeroTargetPasses =
    outcome.selectedTargets > 0 ? 0 : currentState.searchZeroTargetPasses + 1;

  const severeUnderperformance =
    next.searchPasses >= 6 && next.searchSuccessfulComments <= 1;
  const earlySearchFailure =
    next.searchPasses >= 4 && next.searchSuccessfulComments === 0;
  const repeatedZeroTargetPasses = next.searchZeroTargetPasses >= 3;

  if (severeUnderperformance || earlySearchFailure || repeatedZeroTargetPasses) {
    next.homeFallbackPassesRemaining = 2;
  }

  return next;
}
