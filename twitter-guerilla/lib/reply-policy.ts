import type { TweetRecord } from './types.ts';
import { isHighIntentText } from './intent.ts';

export const MAX_REPLY_WORDS = 8;
export const MAX_INTENT_REPLY_WORDS = 14;

type ReplyPolicyOptions = {
  accountKey?: string | null;
  policy?: ReplyPolicy;
};

const UNIVERSAL_BANNED_SUBSTRINGS = [
  'great post',
  'thanks for sharing',
  'this is huge',
];
// TODO: set PRODUCT_NAME to your brand/product. Replies are blocked from naming it
// (outside an explicit high-intent thread) so the bot never pitches.
const PRODUCT_NAME = 'yourbrand';
const BANNED_HARD_CTA_SUBSTRINGS = [
  `use ${PRODUCT_NAME}`,
  `check out ${PRODUCT_NAME}`,
  `sign up for ${PRODUCT_NAME}`,
  'dm me',
  'link in bio',
];
const BANNED_HYPE_PATTERNS = [
  /\bguaranteed\b/iu,
  /\bgame ?changer\b/iu,
  /\brevolutionary\b/iu,
  /\b10x your\b/iu,
  /\bskyrocket\b/iu,
  /\bexplode\b/iu,
  /\bbest .* ever\b/iu,
];
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'from', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'their', 'this', 'to', 'was', 'were', 'with',
]);

export type ReplyPolicy = {
  maxWords: number;
  profile: 'default' | 'buyer-intent';
};

export function resolveReplyPolicy(
  _accountKey: string | null | undefined,
  tweet: Pick<TweetRecord, 'text'>,
): ReplyPolicy {
  if (isHighIntentText(tweet.text)) {
    return {
      maxWords: MAX_INTENT_REPLY_WORDS,
      profile: 'buyer-intent',
    };
  }

  return {
    maxWords: MAX_REPLY_WORDS,
    profile: 'default',
  };
}

export function countWords(value: string): number {
  const words = value.match(/[a-z0-9']+/giu);
  return words?.length ?? 0;
}

function trimToWordLimit(value: string, limit: number): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  const selected: string[] = [];

  for (const part of parts) {
    const nextValue = [...selected, part].join(' ');
    if (countWords(nextValue) > limit) break;
    selected.push(part);
  }

  return selected.join(' ').trim();
}

export function repairReplyText(
  reply: string,
  tweet: TweetRecord,
  options: ReplyPolicyOptions = {},
): string | null {
  const policy = options.policy ?? resolveReplyPolicy(options.accountKey, tweet);
  let candidate = reply
    .trim()
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/#/gu, '')
    .replace(/[—–-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!candidate) return null;

  if (countWords(candidate) > policy.maxWords) {
    candidate = trimToWordLimit(candidate, policy.maxWords);
  }

  if (!candidate) return null;

  return validateReplyText(candidate, tweet, { ...options, policy }).length === 0 ? candidate : null;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9']+/giu) ?? []).filter((token) => !STOPWORDS.has(token));
}

function looksLikeSourceParaphrase(reply: string, sourceText: string): boolean {
  const replyTokens = tokenize(reply);
  const sourceTokens = new Set(tokenize(sourceText));

  if (replyTokens.length < 3) return false;

  const overlap = replyTokens.filter((token) => sourceTokens.has(token)).length;
  return overlap / replyTokens.length >= 0.8;
}

export function validateReplyText(
  reply: string,
  tweet: TweetRecord,
  options: ReplyPolicyOptions = {},
): string[] {
  const policy = options.policy ?? resolveReplyPolicy(options.accountKey, tweet);
  const errors: string[] = [];
  const trimmed = reply.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed) errors.push('reply is empty');
  if (countWords(trimmed) > policy.maxWords) errors.push(`reply exceeds ${policy.maxWords} words`);
  if (/[#]/u.test(trimmed)) errors.push('reply contains a hashtag');
  if (/[—–-]/u.test(trimmed)) errors.push('reply contains a dash');
  if (/https?:\/\//iu.test(trimmed)) errors.push('reply contains a link');

  for (const phrase of UNIVERSAL_BANNED_SUBSTRINGS) {
    if (normalized.includes(phrase)) {
      errors.push(`reply contains banned phrase "${phrase}"`);
    }
  }

  for (const phrase of BANNED_HARD_CTA_SUBSTRINGS) {
    if (normalized.includes(phrase)) {
      errors.push(`reply contains hard-sell phrase "${phrase}"`);
    }
  }

  if (PRODUCT_NAME && normalized.includes(PRODUCT_NAME)) {
    errors.push(`reply mentions ${PRODUCT_NAME} outside an explicit high-intent thread`);
  }

  for (const pattern of BANNED_HYPE_PATTERNS) {
    if (pattern.test(normalized)) {
      errors.push(`reply contains hype/spam language matching ${pattern}`);
    }
  }

  if (looksLikeSourceParaphrase(trimmed, tweet.text)) {
    errors.push('reply appears to paraphrase the source post');
  }

  return errors;
}

export function assertReplyTextAllowed(
  reply: string,
  tweet: TweetRecord,
  options: ReplyPolicyOptions = {},
): void {
  const errors = validateReplyText(reply, tweet, options);
  if (errors.length > 0) {
    throw new Error(`Reply violates policy: ${errors.join('; ')}`);
  }
}

export function assertReplyCandidatesAllowed(
  candidates: string[],
  tweet: TweetRecord,
  options: ReplyPolicyOptions = {},
): void {
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Reply candidates must be distinct. Duplicate candidate: "${candidate}"`);
    }
    seen.add(normalized);
    assertReplyTextAllowed(candidate, tweet, options);
  }
}
