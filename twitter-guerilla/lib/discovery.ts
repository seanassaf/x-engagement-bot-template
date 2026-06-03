import type { AppConfig, FeedCandidate, UserProfile } from './types.ts';
import { safeGoto } from './browser.ts';
import { parseLikeCount, rand, randomSleep, shuffle, sleep } from './utils.ts';
import { fetchUserProfiles } from './x-api.ts';
import { isBlockedUsername, isQuoteTweetCandidate, isRetweetCandidate } from './hard-rules.ts';
import { isCompetitorVendorUsername, scoreBuyerIntent } from './intent.ts';
import { isSensitiveTopic } from './sensitive-content.ts';

const MIN_LIKES = 3;
const MAX_LIKES = 50_000;
const MAX_LIKE_AUTHOR_FOLLOWERS = 8_000;
const MAX_AUTHOR_FOLLOWERS = 50_000;
const IDEAL_FOLLOWER_MIN = 1_000;
const IDEAL_FOLLOWER_MAX = 10_000;
const TWITTER_EPOCH = 1288834974657;
const MAX_POST_AGE_MS = 3 * 60 * 60 * 1000;
const LOW_SIGNAL_TOKENS = new Set([
  'gm', 'gn', 'good', 'morning', 'night', 'goodnight', 'hello', 'hi', 'hey',
  'everyone', 'all', 'guys', 'team', 'thanks', 'lol', 'sup',
]);

// ── CUSTOMIZE FOR YOUR NICHE ──
// Strong-signal anchor terms — the core topics of your niche (scored 2 pts each).
// TODO: replace with your niche's primary keywords.
const CORE_KEYWORDS = [
  'your-core-keyword-one',
  'your-core-keyword-two',
  'your-core-keyword-three',
];

// Broader relevance net used in general (non-buyer-intent) discovery (scored 1 pt each).
// TODO: replace with adjacent/secondary keywords for your niche.
const RELEVANCE_KEYWORDS = [
  ...CORE_KEYWORDS,
  'your-secondary-keyword-one',
  'your-secondary-keyword-two',
];

// Patterns that mark a post as a competitor / vendor self-promotion (a product pitching
// itself) rather than a genuine prospect. These are fairly generic; extend as needed.
const PROMO_TEXT_PATTERNS = [
  /\bbook a demo\b/iu,
  /\bsign\s*up\b/iu,
  /\bfree trial\b/iu,
  /\bwaitlist\b/iu,
  /\bget started (?:free|today|now)\b/iu,
  /\bt\.me\/[a-z0-9_]+/iu,
  /\blink in bio\b/iu,
  /\bintroducing\b/iu,
  /\bnow live\b/iu,
  /\bavailable now\b/iu,
  /\btry .*(?:free|now)\b/iu,
];
// TODO: add brand terms of competing products (names, @handles, domains).
const COMPETITOR_BRAND_TERMS: string[] = [
  // 'competitorbrand', '@competitor', 'competitor.com',
];
// Bio/profile terms suggesting the account is a vendor product, not a prospect.
const VENDOR_PROFILE_TERMS = [
  'app',
  'bot',
  'platform',
  'tool',
  'saas',
  'automation',
];
const PROMO_TEXT_TERMS = [
  'sign up',
  'free trial',
  'book a demo',
  'waitlist',
  'get started',
  'now live',
  'available now',
  'introducing',
  'link in bio',
];

function candidateText(candidate: Pick<FeedCandidate, 'tweetText' | 'visibleText'>): string {
  return `${candidate.tweetText} ${candidate.visibleText ?? ''}`.trim().toLowerCase();
}

type StatusLinkCandidate = {
  authorUsername: string;
  href: string;
  tweetId: string;
};

export function selectPrimaryStatusLink(
  hrefs: string[],
  preferredAuthorUsername?: string | null,
): StatusLinkCandidate | null {
  const parsed = hrefs
    .map((href) => {
      const match = href.match(/^\/([^/]+)\/status\/(\d+)/u);
      if (!match) return null;
      return {
        authorUsername: match[1],
        href,
        tweetId: match[2],
      } satisfies StatusLinkCandidate;
    })
    .filter((value): value is StatusLinkCandidate => !!value);

  if (parsed.length === 0) return null;

  const preferred = preferredAuthorUsername?.trim().replace(/^@+/u, '').toLowerCase() ?? null;
  const filtered = preferred
    ? parsed.filter((candidate) => candidate.authorUsername.toLowerCase() === preferred)
    : parsed;
  const pool = filtered.length > 0 ? filtered : parsed;

  return [...pool].sort((left, right) => {
    const leftId = BigInt(left.tweetId);
    const rightId = BigInt(right.tweetId);
    if (leftId === rightId) return 0;
    return leftId > rightId ? -1 : 1;
  })[0];
}

type FilterAndRankOptions = {
  acquisitionMode?: 'general' | 'targeted';
  discoveryKind?: 'search' | 'home' | 'community';
  likeEligibilityMode?: 'ignore' | 'prefer' | 'require';
  searchQuery?: string | null;
};

type DiscoveryOptions = {
  sourceLabel?: string;
  reloadSource?: (() => Promise<void>) | null;
  minScrolls?: number;
  maxExtraScrolls?: number;
};

function isTransientFeedDomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Attempted to use detached Frame|Execution context was destroyed|Cannot find context with specified id|Node is detached/i.test(message);
}

export async function humanScroll(page: any): Promise<void> {
  const distance = rand(300, 800);
  const steps = rand(5, 12);
  const stepSize = distance / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: stepSize + rand(-20, 20) });
    await sleep(rand(30, 80));
  }
}

export async function discoverCandidates(
  page: any,
  targetCount: number,
  options: DiscoveryOptions = {},
): Promise<FeedCandidate[]> {
  const sourceLabel = options.sourceLabel ?? 'home feed';
  const reloadSource = options.reloadSource ?? (() => safeGoto(page, 'https://x.com/home'));
  const seenIds = new Set<string>();
  const candidates: FeedCandidate[] = [];
  const minScrolls = options.minScrolls ?? Math.max(15, targetCount);
  const maxScrolls = minScrolls + rand(2, options.maxExtraScrolls ?? 5);
  let emptyFeedScrolls = 0;

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    let articles: any[] = [];
    try {
      articles = await page.$$('article[data-testid="tweet"]');
    } catch (error: unknown) {
      if (!isTransientFeedDomError(error)) throw error;
      console.log('  Feed refreshed while scanning posts. Retrying on the next scroll...');
    }

    if (articles.length === 0) {
      emptyFeedScrolls++;
      if (emptyFeedScrolls >= 3) {
        console.log(`  Discovery source is still blank. Reloading ${sourceLabel} before continuing...`);
        await reloadSource();
        emptyFeedScrolls = 0;
      }
    } else {
      emptyFeedScrolls = 0;
    }

    if (scroll === 0 || (scroll + 1) % 5 === 0 || scroll === maxScrolls - 1) {
      console.log(`  Discovery scan ${scroll + 1}/${maxScrolls}: ${articles.length} visible posts, ${candidates.length} candidates`);
    }

    for (const article of articles) {
      let data: FeedCandidate | null = null;
      try {
        data = await article.evaluate((el: Element) => {
          const authorProfileHref = (
            el.querySelector('[data-testid="User-Name"] a[href^="/"]') as HTMLAnchorElement | null
          )?.getAttribute('href') ?? '';
          const preferredAuthorUsername = authorProfileHref.match(/^\/([^/]+)$/u)?.[1] ?? null;
          const statusHrefs = Array.from(el.querySelectorAll('a[href*="/status/"]'))
            .map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? '')
            .filter(Boolean);
          const selectPrimaryStatusLink = (
            hrefs: string[],
            preferredAuthor: string | null,
          ) => {
            const parsed = hrefs
              .map((candidateHref) => {
                const parsedMatch = candidateHref.match(/^\/([^/]+)\/status\/(\d+)/u);
                if (!parsedMatch) return null;
                return {
                  authorUsername: parsedMatch[1],
                  href: candidateHref,
                  tweetId: parsedMatch[2],
                };
              })
              .filter(Boolean) as Array<{ authorUsername: string; href: string; tweetId: string }>;

            if (parsed.length === 0) return null;

            const normalizedPreferred = preferredAuthor?.toLowerCase() ?? null;
            const filtered = normalizedPreferred
              ? parsed.filter((candidate) => candidate.authorUsername.toLowerCase() === normalizedPreferred)
              : parsed;
            const pool = filtered.length > 0 ? filtered : parsed;

            return [...pool].sort((left, right) => {
              const leftId = BigInt(left.tweetId);
              const rightId = BigInt(right.tweetId);
              if (leftId === rightId) return 0;
              return leftId > rightId ? -1 : 1;
            })[0];
          };
          const primaryStatusLink = selectPrimaryStatusLink(statusHrefs, preferredAuthorUsername);
          if (!primaryStatusLink) return null;

          const textEl = el.querySelector('[data-testid="tweetText"]');
          const text = textEl?.textContent ?? '';

          const likeBtn = el.querySelector('[data-testid="like"]');
          const unlikeBtn = el.querySelector('[data-testid="unlike"]');
          const alreadyLiked = !!unlikeBtn;
          const countEl = (likeBtn || unlikeBtn)?.querySelector(
            '[data-testid="app-text-transition-container"]',
          );
          const likeCountText = countEl?.textContent ?? '0';

          const fullText = el.textContent ?? '';
          const isPromoted =
            fullText.includes('Promoted') ||
            fullText.includes('Ad') && !!el.querySelector('[data-testid="placementTracking"]');
          const socialContext = el.querySelector('[data-testid="socialContext"]')?.textContent ?? '';
          const statusTweetIds = statusHrefs
            .map((value) => value.match(/^\/[^/]+\/status\/(\d+)/u)?.[1] ?? null)
            .filter((value): value is string => !!value);
          const uniqueStatusTweetIds = Array.from(new Set(statusTweetIds));
          const isRetweet = /^RT\s*@/iu.test(text.trim()) || /\b(reposted|retweeted)\b/iu.test(socialContext);
          const isQuoteTweet = uniqueStatusTweetIds.length > 1;

          return {
            authorUsername: primaryStatusLink.authorUsername,
            authorFollowersCount: null,
            tweetId: primaryStatusLink.tweetId,
            tweetText: text.slice(0, 500),
            visibleText: fullText.slice(0, 1500),
            likeCount: 0,
            statusUrl: primaryStatusLink.href,
            alreadyLiked,
            isPromoted,
            isQuoteTweet,
            isRetweet,
            _likeCountRaw: likeCountText,
          } as any;
        });
      } catch (error: unknown) {
        if (!isTransientFeedDomError(error)) throw error;
        continue;
      }

      if (!data || seenIds.has(data.tweetId)) continue;

      data.likeCount = parseLikeCount((data as any)._likeCountRaw ?? '0');
      delete (data as any)._likeCountRaw;
      seenIds.add(data.tweetId);
      candidates.push(data);
    }

    try {
      await humanScroll(page);
    } catch (error: unknown) {
      if (!isTransientFeedDomError(error)) {
        await sleep(2000);
      }
    }
    try {
      await randomSleep(2000, 4000);
    } catch (error: unknown) {
      if (!isTransientFeedDomError(error)) {
        throw error;
      }
      await sleep(2000);
    }
  }

  return candidates;
}

function tweetAgeMs(tweetId: string): number {
  return Date.now() - (Number(BigInt(tweetId) >> 22n) + TWITTER_EPOCH);
}

export function isLowSignalPostText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return true;

  if (!/[a-z0-9]/iu.test(trimmed)) {
    return true;
  }

  const tokens = trimmed.match(/[a-z0-9']+/giu) ?? [];
  if (tokens.length === 0) return true;

  if (tokens.length <= 6 && tokens.every((token) => LOW_SIGNAL_TOKENS.has(token))) {
    return true;
  }

  return false;
}

function extractSearchTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9]+/giu) ?? [],
    ),
  ).filter((token) => token.length >= 3);
}

function matchesSearchQuery(text: string, searchQuery: string | null | undefined): boolean {
  if (!searchQuery) return false;

  const normalizedText = text.toLowerCase();
  const normalizedQuery = searchQuery.toLowerCase().trim();
  if (!normalizedQuery) return true;
  if (normalizedText.includes(normalizedQuery)) return true;

  const tokens = extractSearchTokens(normalizedQuery);
  if (tokens.length === 0) return true;

  const matchingTokens = tokens.filter((token) => normalizedText.includes(token)).length;
  const requiredMatches = tokens.length === 1 ? 1 : Math.min(tokens.length, 2);
  return matchingTokens >= requiredMatches;
}

function isRelevant(
  candidate: FeedCandidate,
  searchQuery?: string | null,
  acquisitionMode: FilterAndRankOptions['acquisitionMode'] = 'general',
  discoveryKind: FilterAndRankOptions['discoveryKind'] = 'search',
): boolean {
  const text = candidateText(candidate);
  if (searchQuery) {
    return matchesSearchQuery(text, searchQuery);
  }

  if (acquisitionMode === 'targeted') {
    const threshold = discoveryKind === 'home' ? 6 : 3;
    return scoreBuyerIntent(text) >= threshold;
  }

  return RELEVANCE_KEYWORDS.some((kw) => text.includes(kw));
}

function relevanceScore(
  candidate: FeedCandidate,
  searchQuery?: string | null,
  acquisitionMode: FilterAndRankOptions['acquisitionMode'] = 'general',
  discoveryKind: FilterAndRankOptions['discoveryKind'] = 'search',
): number {
  const text = candidateText(candidate);
  let score = 0;

  if (searchQuery) {
    const normalizedQuery = searchQuery.toLowerCase().trim();
    if (normalizedQuery && text.includes(normalizedQuery)) {
      score += 8;
    }

    for (const token of extractSearchTokens(normalizedQuery)) {
      if (text.includes(token)) score += 2;
    }
  }

  for (const kw of CORE_KEYWORDS) {
    if (text.includes(kw)) score += 2;
  }
  for (const kw of RELEVANCE_KEYWORDS) {
    if (!CORE_KEYWORDS.includes(kw) && text.includes(kw)) score += 1;
  }

  if (acquisitionMode === 'targeted') {
    score += scoreBuyerIntent(text);
    if (discoveryKind === 'home') {
      score += scoreBuyerIntent(text) >= 8 ? 4 : -6;
    }
  }

  return score;
}

function looksLikeCompetitorPromotion(
  candidate: FeedCandidate,
  profile: Pick<UserProfile, 'username' | 'name' | 'description'> | undefined,
): boolean {
  const text = candidateText(candidate);
  const profileHaystack = [
    candidate.authorUsername,
    profile?.username ?? '',
    profile?.name ?? '',
    profile?.description ?? '',
  ]
    .join(' ')
    .toLowerCase();

  const promoPatternHits = PROMO_TEXT_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const brandProfileHits = VENDOR_PROFILE_TERMS.filter((term) => profileHaystack.includes(term)).length;
  const promoTextHits = PROMO_TEXT_TERMS.filter((term) => text.includes(term)).length;
  const competitorBrandHits = COMPETITOR_BRAND_TERMS.filter((term) => text.includes(term)).length;
  const userPainScore = scoreBuyerIntent(text);

  if (promoPatternHits >= 2) return true;
  if (competitorBrandHits >= 1 && promoPatternHits >= 1) return true;
  if (competitorBrandHits >= 1 && promoTextHits >= 1) return true;
  if (brandProfileHits >= 2 && promoPatternHits >= 1) return true;
  if (brandProfileHits >= 2 && promoTextHits >= 2 && userPainScore < 10) return true;
  return false;
}

export function recencyScoreFromAgeMs(ageMs: number): number {
  if (ageMs <= 30 * 60 * 1000) return 4;
  if (ageMs <= 60 * 60 * 1000) return 3;
  if (ageMs <= 2 * 60 * 60 * 1000) return 2;
  if (ageMs <= MAX_POST_AGE_MS) return 1;
  return 0;
}

export function isPostAgeAllowed(ageMs: number): boolean {
  return ageMs <= MAX_POST_AGE_MS;
}

export function followerBandScore(
  authorFollowers: number | undefined,
  _ownFollowers: number | undefined,
): number {
  if (!authorFollowers) return 0;

  if (authorFollowers >= IDEAL_FOLLOWER_MIN && authorFollowers <= IDEAL_FOLLOWER_MAX) return 4;
  if (authorFollowers >= 500 && authorFollowers < IDEAL_FOLLOWER_MIN) return 1;
  if (authorFollowers > IDEAL_FOLLOWER_MAX && authorFollowers <= MAX_AUTHOR_FOLLOWERS) return 1;
  return -3;
}

export function isLikeFollowerCountAllowed(authorFollowersCount: number | null | undefined): boolean {
  return typeof authorFollowersCount === 'number' && authorFollowersCount < MAX_LIKE_AUTHOR_FOLLOWERS;
}

// A large account that is clearly a priority target for your niche (e.g. an official
// brand/ecosystem account) can stay a valid engagement target even above the normal
// follower-size cap. TODO: implement your own rule, e.g. matching a profile keyword.
// Returns false by default (no accounts are exempt from the follower cap).
export function isPriorityAccountProfile(
  _profile: Pick<UserProfile, 'username' | 'name' | 'description'> | undefined,
  _fallbackUsername = '',
): boolean {
  return false;
}

export async function filterAndRank(
  candidates: FeedCandidate[],
  ownUsername: string,
  count: number,
  config: AppConfig,
  options: FilterAndRankOptions = {},
): Promise<FeedCandidate[]> {
  const acquisitionMode = options.acquisitionMode ?? 'general';
  const discoveryKind = options.discoveryKind ?? 'search';
  const likeEligibilityMode = options.likeEligibilityMode ?? 'ignore';
  const searchQuery = options.searchQuery ?? null;
  const preFiltered = candidates.filter((c) => {
    if (c.authorUsername.toLowerCase() === ownUsername.toLowerCase()) return false;
    if (isBlockedUsername(c.authorUsername)) {
      console.log(`  Skipping blocked account @${c.authorUsername}`);
      return false;
    }
    if (c.alreadyLiked) return false;
    if (c.isPromoted) return false;
    if (c.likeCount < MIN_LIKES || c.likeCount > MAX_LIKES) return false;
    if (!isPostAgeAllowed(tweetAgeMs(c.tweetId))) return false;
    if (isRetweetCandidate(c)) return false;
    if (isQuoteTweetCandidate(c)) return false;
    if (isLowSignalPostText(c.tweetText)) return false;
    if (isSensitiveTopic(candidateText(c))) {
      console.log(`  Skipping @${c.authorUsername} (sensitive topic)`);
      return false;
    }
    c.intentScore = acquisitionMode === 'targeted' ? scoreBuyerIntent(candidateText(c)) : null;
    if (!isRelevant(c, searchQuery, acquisitionMode, discoveryKind)) return false;
    return true;
  });

  const usernames = [...new Set([...preFiltered.map((c) => c.authorUsername), ownUsername])];
  const userProfiles = await fetchUserProfiles(usernames, config);
  const ownFollowers = userProfiles.get(ownUsername.toLowerCase())?.followersCount ?? undefined;

  const filtered = preFiltered.filter((c) => {
    const profile = userProfiles.get(c.authorUsername.toLowerCase());
    const followers = profile?.followersCount ?? undefined;
    c.authorFollowersCount = profile?.followersCount ?? null;
    const isPriorityAccount = isPriorityAccountProfile(profile, c.authorUsername);
    if (!isPriorityAccount && followers !== undefined && followers > MAX_AUTHOR_FOLLOWERS) {
      console.log(`  Skipping @${c.authorUsername} (${followers.toLocaleString()} followers)`);
      return false;
    }
    if (isPriorityAccount && followers !== undefined && followers > MAX_AUTHOR_FOLLOWERS) {
      console.log(`  Allowing @${c.authorUsername} despite ${followers.toLocaleString()} followers because it is a priority account`);
    }
    if (acquisitionMode === 'targeted' && isCompetitorVendorUsername(c.authorUsername)) {
      console.log(`  Skipping known competitor account @${c.authorUsername} in targeted mode`);
      return false;
    }
    if (acquisitionMode === 'targeted' && looksLikeCompetitorPromotion(c, profile)) {
      console.log(`  Skipping competitor-promotional account @${c.authorUsername} in targeted mode`);
      return false;
    }
    if (acquisitionMode === 'targeted' && discoveryKind === 'home' && isPriorityAccount && (c.intentScore ?? 0) < 8) {
      console.log(`  Skipping broad priority account @${c.authorUsername} in home fallback`);
      return false;
    }
    return true;
  });

  const actionable = likeEligibilityMode === 'require'
    ? filtered.filter((candidate) => isLikeFollowerCountAllowed(candidate.authorFollowersCount))
    : filtered;

  const shuffled = shuffle(actionable);
  shuffled.sort((a, b) => {
    const aProfile = userProfiles.get(a.authorUsername.toLowerCase());
    const bProfile = userProfiles.get(b.authorUsername.toLowerCase());
    const aFollowers = aProfile?.followersCount ?? undefined;
    const bFollowers = bProfile?.followersCount ?? undefined;
    const aBandScore = isPriorityAccountProfile(aProfile, a.authorUsername)
      ? Math.max(followerBandScore(aFollowers, ownFollowers), 2)
      : followerBandScore(aFollowers, ownFollowers);
    const bBandScore = isPriorityAccountProfile(bProfile, b.authorUsername)
      ? Math.max(followerBandScore(bFollowers, ownFollowers), 2)
      : followerBandScore(bFollowers, ownFollowers);
    const aScore =
      relevanceScore(a, searchQuery, acquisitionMode, discoveryKind) +
      recencyScoreFromAgeMs(tweetAgeMs(a.tweetId)) +
      aBandScore +
      likeEligibilityScore(a.authorFollowersCount, likeEligibilityMode);
    const bScore =
      relevanceScore(b, searchQuery, acquisitionMode, discoveryKind) +
      recencyScoreFromAgeMs(tweetAgeMs(b.tweetId)) +
      bBandScore +
      likeEligibilityScore(b.authorFollowersCount, likeEligibilityMode);
    return bScore - aScore;
  });
  return shuffled.slice(0, count);
}

function likeEligibilityScore(
  authorFollowersCount: number | null,
  likeEligibilityMode: FilterAndRankOptions['likeEligibilityMode'],
): number {
  if (likeEligibilityMode === 'ignore') return 0;
  if (isLikeFollowerCountAllowed(authorFollowersCount)) return 6;
  return likeEligibilityMode === 'prefer' ? -6 : 0;
}
