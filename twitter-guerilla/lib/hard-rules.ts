import type { FeedCandidate, TweetRecord, TweetReferenceType } from './types.ts';

// TODO: add X usernames (lowercase, no @) that must NEVER be engaged in any mode
// (e.g. direct competitors). Leave empty if none.
const BLOCKED_USERNAMES = new Set<string>([
  // 'competitor_one',
  // 'competitor_two',
]);
const RETWEET_PREFIX = /^RT\s*@/iu;

export function normalizeUsername(username: string): string {
  return username.trim().replace(/^@+/u, '').toLowerCase();
}

export function isBlockedUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  return BLOCKED_USERNAMES.has(normalizeUsername(username));
}

export function isRetweetText(text: string): boolean {
  return RETWEET_PREFIX.test(text.trimStart());
}

export function isRetweetCandidate(candidate: Pick<FeedCandidate, 'isRetweet' | 'tweetText'>): boolean {
  return candidate.isRetweet === true || isRetweetText(candidate.tweetText);
}

export function isQuoteTweetCandidate(candidate: Pick<FeedCandidate, 'isQuoteTweet'>): boolean {
  return candidate.isQuoteTweet === true;
}

function hasReferencedTweetType(tweet: TweetRecord, type: TweetReferenceType): boolean {
  return (tweet.referencedTweets ?? []).some((reference) => reference.type === type);
}

function buildAmplifiedPostError(action: 'engage' | 'like' | 'reply', kind: 'retweet' | 'quote tweet'): Error {
  return new Error(`Hard rule: refusing to ${action} with ${kind}.`);
}

export function assertEngagementAllowed(
  username: string | null | undefined,
  action: 'engage' | 'like' | 'reply',
): void {
  if (!username) {
    throw new Error(`Hard rule: refusing to ${action} because the author could not be verified.`);
  }

  const normalized = normalizeUsername(username);
  if (BLOCKED_USERNAMES.has(normalized)) {
    throw new Error(`Hard rule: refusing to ${action} with blocked account @${normalized}.`);
  }
}

export function assertCandidateEngagementAllowed(
  candidate: Pick<FeedCandidate, 'authorUsername' | 'isQuoteTweet' | 'isRetweet' | 'tweetText'>,
  action: 'engage' | 'like' | 'reply',
): void {
  assertEngagementAllowed(candidate.authorUsername, action);

  if (isRetweetCandidate(candidate)) {
    throw buildAmplifiedPostError(action, 'retweet');
  }

  if (isQuoteTweetCandidate(candidate)) {
    throw buildAmplifiedPostError(action, 'quote tweet');
  }
}

export function assertTweetEngagementAllowed(
  tweet: TweetRecord,
  action: 'engage' | 'like' | 'reply',
): void {
  assertEngagementAllowed(tweet.author?.username, action);

  if (hasReferencedTweetType(tweet, 'retweeted') || isRetweetText(tweet.text)) {
    throw buildAmplifiedPostError(action, 'retweet');
  }

  if (hasReferencedTweetType(tweet, 'quoted')) {
    throw buildAmplifiedPostError(action, 'quote tweet');
  }
}
