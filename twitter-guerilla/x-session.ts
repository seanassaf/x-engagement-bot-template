import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import type { AppConfig, FeedCandidate, SessionArgs, TweetRecord } from './lib/types.ts';
import { rand, randomSleep, sleep } from './lib/utils.ts';
import { loadEnvFiles, loadConfig } from './lib/config.ts';
import { fetchTweet } from './lib/x-api.ts';
import { generateReplyOptions } from './lib/llm.ts';
import {
  clickReplyComposerControl,
  ensureLoggedIn,
  getReplyComposerDraftText,
  humanClick,
  humanType,
  isReplyComposerOpen,
  launchBrowser,
  ManualXLoginRequiredError,
  openSearchTimeline,
  openReplyComposerForTweet,
  safeGoto,
  seedBrowserProfileSession,
} from './lib/browser.ts';
import { discoverCandidates, filterAndRank, humanScroll, isLikeFollowerCountAllowed } from './lib/discovery.ts';
import { appendSessionLog, findLatestSuccessfulComment, loadSessionLogsFromDirectory } from './lib/session-log.ts';
import { appendEngagementLeadsToGoogleSheet, type LeadCaptureRow } from './lib/lead-capture.ts';
import { assertCandidateEngagementAllowed, assertTweetEngagementAllowed } from './lib/hard-rules.ts';
import { parseSessionArgs, resolveBuyerIntentSearchQueries } from './lib/session-cli.ts';
import { buildSessionPlan } from './lib/session-progress.ts';
import type { SessionResult } from './lib/x-session.types.ts';
import {
  applyBuyerIntentRoutingOutcome,
  applySearchQueryOutcome,
  buildAdaptiveSearchScanPlan,
  createBuyerIntentRoutingState,
  createSearchQueryStateMap,
  shouldUseBuyerIntentHomeFallback,
  selectAdaptiveSearchQuery,
  type SearchQueryStateMap,
} from './lib/search-adaptation.ts';

loadEnvFiles();

function buildFallbackReferencedTweets(candidate: FeedCandidate): TweetRecord['referencedTweets'] {
  const referencedTweets: NonNullable<TweetRecord['referencedTweets']> = [];

  if (candidate.isRetweet) {
    referencedTweets.push({ id: candidate.tweetId, type: 'retweeted' });
  }

  if (candidate.isQuoteTweet) {
    referencedTweets.push({ id: candidate.tweetId, type: 'quoted' });
  }

  return referencedTweets.length > 0 ? referencedTweets : null;
}

function buildFallbackTweet(candidate: FeedCandidate): TweetRecord {
  return {
    id: candidate.tweetId,
    text: candidate.tweetText,
    createdAt: new Date().toISOString(),
    replySettings: null,
    author: {
      id: '',
      name: candidate.authorUsername,
      username: candidate.authorUsername,
      description: '',
    },
    metrics: null,
    referencedTweets: buildFallbackReferencedTweets(candidate),
  };
}

async function loadCandidateTweet(candidate: FeedCandidate, config: AppConfig): Promise<TweetRecord> {
  try {
    return await fetchTweet(candidate.tweetId, config);
  } catch {
    return buildFallbackTweet(candidate);
  }
}

function getUrlPath(url: string): string {
  return new URL(url).pathname;
}

async function assertOnTargetTweetPage(page: any, tweetUrl: string): Promise<void> {
  if (getUrlPath(page.url()) !== getUrlPath(tweetUrl)) {
    throw new Error(`Navigation did not reach target tweet ${tweetUrl}. Current page: ${page.url()}`);
  }
}

async function likeTweet(page: any, candidate: FeedCandidate, tweetUrl: string): Promise<boolean> {
  assertCandidateEngagementAllowed(candidate, 'like');
  const authorUsername = candidate.authorUsername;

  const articles = await page.$$('article[data-testid="tweet"]');

  for (const article of articles) {
    const hasLink = await article.$(`a[href*="${tweetUrl.replace('https://x.com', '')}"]`);
    if (!hasLink) continue;

    const likeButton = await article.$('button[data-testid="like"]');
    if (!likeButton) {
      const alreadyLiked = await article.$('button[data-testid="unlike"]');
      console.log(alreadyLiked ? `  Already liked: ${tweetUrl}` : `  Like button not found: ${tweetUrl}`);
      return !!alreadyLiked;
    }

    await humanClick(page, likeButton);
    await randomSleep(800, 1500);

    let unlikeCheck = await article.$('button[data-testid="unlike"]');
    if (!unlikeCheck) {
      await randomSleep(1500, 2500);
      unlikeCheck = await article.$('button[data-testid="unlike"]');
    }
    console.log(unlikeCheck ? `  Liked @${authorUsername}'s post` : `  Like may not have registered: ${tweetUrl}`);
    return !!unlikeCheck;
  }

  console.log(`  Could not find like button on target tweet: ${tweetUrl}`);
  return false;
}

async function commentOnPost(
  page: any,
  candidate: FeedCandidate,
  tweet: TweetRecord,
  config: AppConfig,
  buyerIntentMode: boolean,
  dryRun: boolean,
): Promise<string> {
  assertCandidateEngagementAllowed(candidate, 'reply');
  assertTweetEngagementAllowed(tweet, 'reply');
  const replies = await generateReplyOptions(tweet, config, {
    discoveryMode: buyerIntentMode ? 'buyer-intent' : 'baseline',
  });
  const replyText = replies[0];
  const tweetUrl = `https://x.com${candidate.statusUrl}`;

  if (dryRun) {
    console.log(`  [dry-run] Would comment: "${replyText}"`);
    return replyText;
  }

  await safeGoto(page, tweetUrl);
  await assertOnTargetTweetPage(page, tweetUrl);

  const composerMode = await openReplyComposerForTweet(page, tweetUrl);
  console.log(composerMode === 'inline' ? '  Using inline reply composer' : '  Using reply dialog fallback');
  await clickReplyComposerControl(page, 'replyArea', tweetUrl, composerMode);
  await randomSleep(300, 600);
  await humanType(page, replyText);
  await randomSleep(500, 1200);

  await clickReplyComposerControl(page, 'submitButton', tweetUrl, composerMode);
  await randomSleep(2500, 4000);

  const composerStillOpen = await isReplyComposerOpen(page, tweetUrl);
  if (composerStillOpen) {
    const remainingText = await getReplyComposerDraftText(page, tweetUrl);
    if (remainingText.trim().length > 0) {
      throw new Error('Reply dialog remained open with draft text after submission');
    }
  }

  const toastText = await page.evaluate(() => {
    const toast = document.querySelector('[data-testid="toast"]');
    return toast?.textContent ?? null;
  });

  if (toastText && /error|failed|couldn't/i.test(toastText)) {
    throw new Error(`X error: ${toastText}`);
  }

  console.log(`  Commented: "${replyText}"`);
  return replyText;
}

function formatPriorCommentSource(accountKey: string | undefined): string {
  return accountKey ? ` by ${accountKey}` : '';
}

function formatLikeSkipReason(candidate: FeedCandidate): string {
  if (candidate.authorFollowersCount === null) {
    return 'follower count unavailable';
  }

  return `${candidate.authorFollowersCount.toLocaleString()} followers`;
}

type DiscoverySource = {
  key: string;
  label: string;
  kind: 'search' | 'home' | 'community';
  searchQuery: string | null;
  finite: boolean;
  open: (page: any) => Promise<void>;
};

function buildDiscoverySource(searchQueries: string[], args: SessionArgs, discoveryPass: number): DiscoverySource {
  if (searchQueries.length > 0) {
    const query = searchQueries[(discoveryPass - 1) % searchQueries.length];
    return {
      key: `search:${query.toLowerCase()}`,
      label: `search "${query}"`,
      kind: 'search',
      searchQuery: query,
      finite: true,
      open: (page: any) => openSearchTimeline(page, query),
    };
  }

  if (args.communityUrl) {
    const communityMatch = args.communityUrl.match(/\/i\/communities\/(\d+)/u);
    const label = communityMatch ? `community ${communityMatch[1]}` : args.communityUrl;

    return {
      key: args.communityUrl,
      label,
      kind: 'community',
      searchQuery: null,
      finite: true,
      open: (page: any) => safeGoto(page, args.communityUrl as string),
    };
  }

  return {
    key: 'https://x.com/home',
    label: 'home feed',
    kind: 'home',
    searchQuery: null,
    finite: false,
    open: (page: any) => safeGoto(page, 'https://x.com/home'),
  };
}

function buildAdaptiveDiscoverySource(
  searchQueries: string[],
  args: SessionArgs,
  discoveryPass: number,
  queryStateMap: SearchQueryStateMap | null,
  useHomeFallback = false,
): DiscoverySource {
  if (useHomeFallback) {
    return {
      key: 'buyer-intent-home-fallback',
      label: 'home feed fallback',
      kind: 'home',
      searchQuery: null,
      finite: false,
      open: (page: any) => safeGoto(page, 'https://x.com/home'),
    };
  }

  if (searchQueries.length > 0 && args.buyerIntentMode && queryStateMap) {
    const query = selectAdaptiveSearchQuery(searchQueries, queryStateMap, discoveryPass);
    return {
      key: `search:${query.toLowerCase()}`,
      label: `search "${query}"`,
      kind: 'search',
      searchQuery: query,
      finite: true,
      open: (page: any) => openSearchTimeline(page, query),
    };
  }

  return buildDiscoverySource(searchQueries, args, discoveryPass);
}

async function discoverCandidatesWithRetry(
  page: any,
  targetCount: number,
  source: DiscoverySource,
  options: { minScrolls?: number; maxExtraScrolls?: number } = {},
): Promise<FeedCandidate[]> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await discoverCandidates(page, targetCount, {
        sourceLabel: source.label,
        reloadSource: () => source.open(page),
        minScrolls: options.minScrolls,
        maxExtraScrolls: options.maxExtraScrolls,
      });
    } catch (error: unknown) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Discovery attempt ${attempt}/3 failed: ${message}`);

      if (attempt < 3) {
        console.log(`Reloading ${source.label} before retrying discovery...`);
        await source.open(page);
        await randomSleep(2000, 4000);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runSession(): Promise<void> {
  const args = parseSessionArgs(process.argv.slice(2));
  const config = loadConfig(args.accountInput);
  const effectiveSearchQueries =
    args.searchQueries.length > 0
      ? args.searchQueries
      : args.buyerIntentMode
        ? resolveBuyerIntentSearchQueries()
        : [];
  const acquisitionMode = args.buyerIntentMode ? 'targeted' as const : 'general' as const;
  const sessionId = randomBytes(8).toString('hex');
  const sharedSessionLogsDir = dirname(config.sessionLogPath);
  const discoveryModeLabel =
    effectiveSearchQueries.length > 0
      ? `search (${effectiveSearchQueries.length} quer${effectiveSearchQueries.length === 1 ? 'y' : 'ies'})`
      : args.communityUrl
        ? buildDiscoverySource([], args, 1).label
        : 'home feed';

  console.log('');
  console.log('┌─────────────────────────────────────────┐');
  console.log('│           X SESSION                      │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Session    ${sessionId.padEnd(28)}│`);
  console.log(`│  Account    ${config.account.key.padEnd(28)}│`);
  console.log(`│  Model      ${config.llmModel.padEnd(28)}│`);
  console.log(`│  Likes      ${String(args.likes).padEnd(28)}│`);
  console.log(`│  Comments   ${String(args.comments).padEnd(28)}│`);
  if (args.dryRun) console.log('│  Mode       DRY RUN                    │');
  if (args.freshSession) console.log('│  Browser    fresh disposable session   │');
  console.log('└─────────────────────────────────────────┘');
  console.log('');
  console.log(`Discovery source: ${discoveryModeLabel}`);
  if (effectiveSearchQueries.length > 0) {
    if (args.buyerIntentMode && args.searchQueries.length === 0) {
      console.log('No explicit discovery source provided. Using the buyer-intent query rotation for this account.');
    }
    console.log(`Search queries: ${effectiveSearchQueries.join(' | ')}`);
  }

  console.log('\nLaunching browser...');
  let { browser, page } = await launchBrowser(config, { freshSession: args.freshSession });
  const capturedLeads: LeadCaptureRow[] = [];

  try {
    let authenticatedUsername: string;

    try {
      authenticatedUsername = await ensureLoggedIn(page, config);
    } catch (error: unknown) {
      if (!(error instanceof ManualXLoginRequiredError)) throw error;

      await browser.close();
      await seedBrowserProfileSession(config);
      ({ browser, page } = await launchBrowser(config, { freshSession: args.freshSession }));
      authenticatedUsername = await ensureLoggedIn(page, config);
    }

    console.log(`Browser account: @${authenticatedUsername}`);

    console.log('\n--- Engagement Phase ---');
    const results: SessionResult[] = [];
    const attemptedTweetIds = new Set<string>();
    const discoveredTweetIds = new Set<string>();
    const queryStateMap = args.buyerIntentMode ? createSearchQueryStateMap(effectiveSearchQueries) : null;
    const buyerIntentRoutingState = args.buyerIntentMode ? createBuyerIntentRoutingState() : null;
    let likeCount = 0;
    let commentCount = 0;
    let discoveryPass = 0;

    while (true) {
      const sessionPlan = buildSessionPlan(args, { likes: likeCount, comments: commentCount });
      if (sessionPlan.complete) break;

      discoveryPass++;
      console.log(`\n--- Discovery Phase ${discoveryPass} ---`);
      console.log(`Need ${sessionPlan.likesRemaining} likes and ${sessionPlan.commentsRemaining} comments more`);
      const useHomeFallback =
        !!args.buyerIntentMode &&
        !!queryStateMap &&
        !!buyerIntentRoutingState &&
        shouldUseBuyerIntentHomeFallback(
          buyerIntentRoutingState,
          effectiveSearchQueries,
          queryStateMap,
          discoveryPass,
        );
      const discoverySource = buildAdaptiveDiscoverySource(
        effectiveSearchQueries,
        args,
        discoveryPass,
        queryStateMap,
        useHomeFallback,
      );
      console.log(`Using ${discoverySource.label}`);

      const scanPlan =
        args.buyerIntentMode && discoverySource.searchQuery && queryStateMap
          ? buildAdaptiveSearchScanPlan(sessionPlan.targetCount, queryStateMap[discoverySource.searchQuery])
          : {
              targetCount: sessionPlan.targetCount,
              minScrolls: undefined,
              maxExtraScrolls: undefined,
            };

      await discoverySource.open(page);
      await randomSleep(1000, 2000);

      const rawCandidates = await discoverCandidatesWithRetry(
        page,
        scanPlan.targetCount,
        discoverySource,
        {
          minScrolls: scanPlan.minScrolls,
          maxExtraScrolls: scanPlan.maxExtraScrolls,
        },
      );
      console.log(`Found ${rawCandidates.length} posts in feed`);

      const freshDiscoveryCandidates = rawCandidates.filter((candidate) => !discoveredTweetIds.has(candidate.tweetId));
      for (const candidate of rawCandidates) {
        discoveredTweetIds.add(candidate.tweetId);
      }

      const unseenCandidates = (discoverySource.finite ? freshDiscoveryCandidates : rawCandidates)
        .filter((candidate) => !attemptedTweetIds.has(candidate.tweetId));
      const skippedCandidates = rawCandidates.length - unseenCandidates.length;
      if (skippedCandidates > 0) {
        console.log(`Skipped ${skippedCandidates} already attempted posts`);
      }

      if (discoverySource.finite && freshDiscoveryCandidates.length === 0) {
        console.log(`No newly discovered posts in ${discoverySource.label}.`);
      }

      const targets = await filterAndRank(
        unseenCandidates,
        authenticatedUsername,
        sessionPlan.targetCount,
        config,
        {
          acquisitionMode,
          discoveryKind: discoverySource.kind,
          searchQuery: discoverySource.searchQuery,
          likeEligibilityMode:
            sessionPlan.shouldLike && !sessionPlan.shouldComment
              ? 'require'
              : sessionPlan.shouldLike
                ? 'prefer'
                : 'ignore',
        },
      );

      const commentHistory = loadSessionLogsFromDirectory(sharedSessionLogsDir);
      const prioritizedTargets = sessionPlan.shouldComment
        ? [...targets].sort((left, right) => {
            const leftHasPriorComment = !!findLatestSuccessfulComment(commentHistory, left.tweetId);
            const rightHasPriorComment = !!findLatestSuccessfulComment(commentHistory, right.tweetId);
            return Number(leftHasPriorComment) - Number(rightHasPriorComment);
          })
        : targets;
      const deprioritizedCount = sessionPlan.shouldComment
        ? prioritizedTargets.filter((candidate) => !!findLatestSuccessfulComment(commentHistory, candidate.tweetId)).length
        : 0;
      console.log(`Selected ${targets.length} targets after filtering\n`);
      if (deprioritizedCount > 0) {
        console.log(`Deprioritized ${deprioritizedCount} posts already commented by our accounts\n`);
      }
      if (sessionPlan.shouldLike && targets.length === 0) {
        console.log('No like-eligible targets found in this discovery pass.');
      }

      let passCommentCount = 0;

      if (prioritizedTargets.length === 0) {
        if (discoverySource.searchQuery && queryStateMap) {
          queryStateMap[discoverySource.searchQuery] = applySearchQueryOutcome(
            queryStateMap[discoverySource.searchQuery],
            {
              discoveryPass,
              selectedTargets: 0,
              successfulComments: 0,
              hadNewCandidates: freshDiscoveryCandidates.length > 0,
            },
          );

          const updatedState = queryStateMap[discoverySource.searchQuery];
          if (updatedState.exhausted) {
            console.log(`Exhausting ${discoverySource.label} for the rest of this session.`);
          } else if (updatedState.cooldownUntilPass > discoveryPass) {
            console.log(`Cooling down ${discoverySource.label} until phase ${updatedState.cooldownUntilPass}.`);
          }
        }
        if (buyerIntentRoutingState) {
          const nextRoutingState = applyBuyerIntentRoutingOutcome(buyerIntentRoutingState, {
            selectedTargets: 0,
            successfulComments: 0,
            usedHomeFallback: discoverySource.kind === 'home',
          });
          Object.assign(buyerIntentRoutingState, nextRoutingState);
          if (buyerIntentRoutingState.homeFallbackPassesRemaining > 0) {
            console.log(`Buyer-intent fallback armed for ${buyerIntentRoutingState.homeFallbackPassesRemaining} home passes.`);
          }
        }

        const wait = rand(45, 90);
        console.log(`No suitable posts found. Waiting ${wait}s before retrying...`);
        await sleep(wait * 1000);
        continue;
      }

      for (const target of prioritizedTargets) {
        console.log(`  @${target.authorUsername} | ${target.likeCount} likes | ${target.tweetText.slice(0, 80)}...`);
      }

      for (let i = 0; i < prioritizedTargets.length; i++) {
        const candidate = prioritizedTargets[i];
        attemptedTweetIds.add(candidate.tweetId);

        const engagementPlan = buildSessionPlan(args, { likes: likeCount, comments: commentCount });
        if (engagementPlan.complete) break;

        const tweetUrl = `https://x.com${candidate.statusUrl}`;
        const shouldLike = engagementPlan.shouldLike && isLikeFollowerCountAllowed(candidate.authorFollowersCount);
        const priorCommentEntry = engagementPlan.shouldComment
          ? findLatestSuccessfulComment(loadSessionLogsFromDirectory(sharedSessionLogsDir), candidate.tweetId)
          : null;
        const shouldComment = engagementPlan.shouldComment && !priorCommentEntry;
        const hasAction = shouldLike || shouldComment;

        console.log(`\n[${i + 1}/${prioritizedTargets.length}] @${candidate.authorUsername}`);

        if (priorCommentEntry) {
          console.log(`  Skipping comment: already commented on this post${formatPriorCommentSource(priorCommentEntry.accountKey)}`);
        }
        if (engagementPlan.shouldLike && !shouldLike) {
          console.log(`  Skipping like: ${formatLikeSkipReason(candidate)} (likes require sub-8,000 followers)`);
        }
        if (!hasAction) {
          continue;
        }

        let liked = false;
        let commented = false;
        let replyText = '';
        let tweet: TweetRecord | null = null;
        const errors: string[] = [];

        try {
          assertCandidateEngagementAllowed(candidate, 'engage');
          tweet = await loadCandidateTweet(candidate, config);
          assertTweetEngagementAllowed(tweet, 'engage');
          await safeGoto(page, tweetUrl);
          await assertOnTargetTweetPage(page, tweetUrl);
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10_000 }).catch(() => {});
          await randomSleep(1000, 2000);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          console.error(`  Failed: ${message}`);
        }

        if (errors.length === 0 && shouldLike) {
          try {
            if (args.dryRun) {
              console.log(`  [dry-run] Would like: ${tweetUrl}`);
              liked = true;
            } else {
              liked = await likeTweet(page, candidate, tweetUrl);
            }

            if (liked) likeCount++;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`like failed: ${message}`);
            console.error(`  Like failed: ${message}`);
          }
        }

        if (errors.length === 0 && shouldComment) {
          try {
            if (!tweet) {
              throw new Error('Target tweet metadata was not loaded before comment attempt');
            }

            replyText = await commentOnPost(page, candidate, tweet, config, args.buyerIntentMode, args.dryRun);
            commentCount++;
            passCommentCount++;
            commented = true;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`comment failed: ${message}`);
            console.error(`  Comment failed: ${message}`);
          }
        }

        const persistedAction: 'liked' | 'commented' | 'liked + commented' | 'failed' =
          liked && commented ? 'liked + commented' :
          commented ? 'commented' :
          liked ? 'liked' :
          'failed';
        const action: SessionResult['action'] =
          args.dryRun
            ? liked && commented ? 'would like + comment'
            : commented ? 'would comment'
            : liked ? 'would like'
            : 'failed'
            : persistedAction;
        const errorMessage = errors.length > 0 ? errors.join(' | ') : undefined;

        if (!args.dryRun) {
          appendSessionLog({
            accountKey: config.account.key,
            acquisitionMode,
            discoveryKey: discoverySource.key,
            discoveryLabel: discoverySource.label,
            sessionId,
            tweetId: candidate.tweetId,
            authorUsername: candidate.authorUsername,
            action: persistedAction,
            replyText,
            searchQuery: discoverySource.searchQuery,
            timestamp: new Date().toISOString(),
            success: persistedAction !== 'failed',
            error: errorMessage,
          }, config.sessionLogPath);

          if (persistedAction !== 'failed') {
            capturedLeads.push({
              username_id: candidate.authorUsername,
              followers: candidate.authorFollowersCount,
            });
          }
        }

        results.push({
          authorUsername: candidate.authorUsername,
          discoveryLabel: discoverySource.label,
          tweetUrl,
          action,
          replyText,
          error: errorMessage,
        });

        const nextPlan = buildSessionPlan(args, { likes: likeCount, comments: commentCount });
        if (nextPlan.complete) break;

        if (i < prioritizedTargets.length - 1) {
          const isLikeOnly = !shouldComment;
          if (isLikeOnly) {
            if (Math.random() < 0.3) await randomSleep(3000, 6000);
            else await randomSleep(1000, 3000);
          } else if (Math.random() < 0.4) {
            console.log(`\n  Scrolling ${discoverySource.label}...`);
            await discoverySource.open(page);
            await randomSleep(1000, 2000);
            await humanScroll(page);
            await humanScroll(page);
            await randomSleep(2000, 5000);
          } else {
            const wait = rand(15, 45);
            console.log(`\n  Waiting ${wait}s...`);
            await sleep(wait * 1000);
          }
        }
      }

      if (discoverySource.searchQuery && queryStateMap) {
        queryStateMap[discoverySource.searchQuery] = applySearchQueryOutcome(
          queryStateMap[discoverySource.searchQuery],
          {
            discoveryPass,
            selectedTargets: targets.length,
            successfulComments: passCommentCount,
            hadNewCandidates: freshDiscoveryCandidates.length > 0,
          },
        );

        const updatedState = queryStateMap[discoverySource.searchQuery];
        if (updatedState.exhausted) {
          console.log(`Exhausting ${discoverySource.label} for the rest of this session.`);
        } else if (updatedState.cooldownUntilPass > discoveryPass) {
          console.log(`Cooling down ${discoverySource.label} until phase ${updatedState.cooldownUntilPass}.`);
        }
      }
      if (buyerIntentRoutingState) {
        const nextRoutingState = applyBuyerIntentRoutingOutcome(buyerIntentRoutingState, {
          selectedTargets: targets.length,
          successfulComments: passCommentCount,
          usedHomeFallback: discoverySource.kind === 'home',
        });
        Object.assign(buyerIntentRoutingState, nextRoutingState);
        if (buyerIntentRoutingState.homeFallbackPassesRemaining > 0) {
          console.log(`Buyer-intent fallback armed for ${buyerIntentRoutingState.homeFallbackPassesRemaining} home passes.`);
        }
      }
    }

    console.log('\n--- Session Summary ---');
    const failedCount = results.filter((r) => r.action === 'failed').length;
    console.log(
      args.dryRun
        ? `${likeCount}/${args.likes} would like, ${commentCount}/${args.comments} would comment, ${failedCount} failed\n`
        : `${likeCount}/${args.likes} liked, ${commentCount}/${args.comments} commented, ${failedCount} failed\n`,
    );

    for (const r of results) {
      const icon = r.action === 'failed' ? 'x' : 'v';
      console.log(`  [${icon}] @${r.authorUsername} — ${r.action}`);
      if (r.discoveryLabel) {
        console.log(`      Source: ${r.discoveryLabel}`);
      }
      console.log(`      ${r.tweetUrl}`);
      if (r.replyText) {
        console.log(`      Reply: "${r.replyText}"`);
      }
      if (r.error) {
        console.log(`      Error: ${r.error}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (!args.dryRun) {
    try {
      await appendEngagementLeadsToGoogleSheet(capturedLeads);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Lead capture failed after session completion: ${message}`);
    }
  }
}

runSession().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
