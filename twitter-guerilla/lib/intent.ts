// Buyer-intent scoring.
//
// This module scores a post for how strongly it signals that the author is a
// potential customer for YOUR product/niche. The scoring *engine* below is
// reusable as-is; you only need to fill in the vocabulary lists with terms,
// phrases, and patterns specific to your niche.
//
// ── HOW TO CUSTOMIZE ──
// 1. BUYER_INTENT_QUERIES  — the X search queries used in buyer-intent mode.
// 2. DEMAND_SIDE_PHRASES   — phrases a prospective buyer uses to express the pain you solve.
// 3. OPERATOR_SIGNAL_PHRASES — markers that the author is your ideal customer.
// 4. AUTOMATION_PHRASES / *_TERMS / *_PATTERNS — supporting signals (see comments).
// 5. CATEGORY_CONTEXT_TERMS — words that anchor a post to your domain.
// 6. COMPETITOR_VENDOR_USERNAMES — handles of competing products to skip in buyer-intent mode.
//
// Leave a list empty ([]) if it doesn't apply to your niche.

// Account keys that should run in buyer-intent ("targeted") acquisition mode by default.
const TARGET_ACCOUNT_KEYS = new Set<string>();

// TODO: add the X usernames (lowercase, no @) of competing products to skip in targeted mode.
const COMPETITOR_VENDOR_USERNAMES = new Set<string>([
  // 'competitor_one',
  // 'competitor_two',
]);

// TODO: replace with the exact X search queries that surface your buyers' pain.
export const BUYER_INTENT_QUERIES = [
  'your search query one',
  'your search query two',
  'your niche pain phrase',
];

// Demand-side: phrases a prospective buyer uses to express the problem you solve.
// TODO: replace with phrases specific to your niche.
const DEMAND_SIDE_PHRASES = [
  'looking for a tool',
  'how do i',
  'need a better way',
  'anyone know a',
  'wish there was',
  'tired of',
  'struggling with',
];

// Operator signal: markers that the author is your ideal customer (role/context).
// TODO: replace with role/context terms for your audience.
const OPERATOR_SIGNAL_PHRASES = [
  'our team',
  'my workflow',
  'we use',
  'i run',
];

// Automation/solution-seeking signals.
// TODO: tailor to your product category (e.g. 'ai agent', 'automation', 'integration').
const AUTOMATION_PHRASES = [
  'automation',
  'automate',
  'ai agent',
  'workflow',
  'integration',
];

// Single-token supporting terms (capped contribution). TODO: replace per niche.
const DEMAND_WORKFLOW_TERMS = [
  'tool',
  'workflow',
  'manual',
  'process',
  'switching',
];

const OPERATOR_SIGNAL_TERMS = [
  'team',
  'founder',
  'ops',
];

const AUTOMATION_TERMS = [
  'bot',
  'agent',
  'automation',
  'ai',
];

const SOLUTION_TERMS = [
  'tool',
  'app',
  'platform',
  'integration',
];

// Pain patterns — regexes for solution-seeking language. These are fairly generic
// and work for many niches; extend as needed.
const PAIN_PATTERNS = [
  /\bhow do i\b/iu,
  /\bhow do you\b/iu,
  /\banyone (?:know|use|using|recommend)\b/iu,
  /\blooking for\b/iu,
  /\bneed (?:a|an|to|better)\b/iu,
  /\bwish there was\b/iu,
  /\btired of\b/iu,
  /\bwhat'?s the best\b/iu,
];

const OPERATOR_SIGNAL_PATTERNS = [
  /\bi run\b/iu,
  /\bour (?:team|company)\b/iu,
  /\bwe (?:use|run)\b/iu,
];

const AUTOMATION_PATTERNS = [
  /\bai agent\b/iu,
  /\bauto(?:mate|mated)?\b/iu,
  /\bworkflow automation\b/iu,
];

// Domain-context terms — words that anchor a post to your space (capped at 2).
// TODO: replace with your niche's core domain terms.
const CATEGORY_CONTEXT_TERMS = [
  'your-domain-term-one',
  'your-domain-term-two',
];

function scoreBucket(text: string, phrases: string[], terms: string[], patterns: RegExp[]): number {
  let score = 0;
  score += countUniqueMatches(text, phrases) * 4;
  score += Math.min(countUniqueMatches(text, terms), 4) * 2;

  for (const pattern of patterns) {
    if (pattern.test(text)) score += 3;
  }

  return score;
}

function scoreDemandSideIntent(text: string): number {
  return scoreBucket(text, DEMAND_SIDE_PHRASES, DEMAND_WORKFLOW_TERMS, PAIN_PATTERNS);
}

function scoreOperatorSignalIntent(text: string): number {
  return scoreBucket(text, OPERATOR_SIGNAL_PHRASES, OPERATOR_SIGNAL_TERMS, OPERATOR_SIGNAL_PATTERNS);
}

function scoreAutomationIntent(text: string): number {
  return scoreBucket(text, AUTOMATION_PHRASES, AUTOMATION_TERMS, AUTOMATION_PATTERNS);
}

function scoreCategoryContext(text: string): number {
  return Math.min(countUniqueMatches(text, CATEGORY_CONTEXT_TERMS), 2);
}

// A small bridge score for posts that combine your domain with solution-seeking.
// TODO: adjust the terms to your niche's strongest co-occurrence signals.
function scoreSolutionBridge(text: string): number {
  let score = 0;
  if (CATEGORY_CONTEXT_TERMS.some((term) => text.includes(term))) score += 1;
  if (SOLUTION_TERMS.some((term) => text.includes(term))) score += 1;
  if (AUTOMATION_TERMS.some((term) => text.includes(term))) score += 1;
  return Math.min(score, 3);
}

function scoreQuestionAndPain(text: string): number {
  let score = 0;
  if (/\?/u.test(text)) score += 1;
  if (text.includes('manual') || text.includes('switching') || text.includes('tired')) score += 1;
  if (CATEGORY_CONTEXT_TERMS.some((term) => text.includes(term))) score += 1;
  return score;
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function countUniqueMatches(text: string, terms: string[]): number {
  return terms.filter((term) => text.includes(term)).length;
}

export function isTargetAccountKey(accountKey: string | null | undefined): boolean {
  if (!accountKey) return false;
  return TARGET_ACCOUNT_KEYS.has(accountKey.trim().toLowerCase());
}

export function isCompetitorVendorUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  return COMPETITOR_VENDOR_USERNAMES.has(username.trim().replace(/^@+/u, '').toLowerCase());
}

export function scoreBuyerIntent(text: string): number {
  const normalized = normalize(text);
  if (!normalized) return 0;

  let score = scoreDemandSideIntent(normalized)
    + scoreOperatorSignalIntent(normalized)
    + scoreAutomationIntent(normalized);
  score += scoreCategoryContext(normalized);
  score += scoreSolutionBridge(normalized);
  score += scoreQuestionAndPain(normalized);

  return score;
}

export function isHighIntentText(text: string): boolean {
  return scoreBuyerIntent(text) >= 8;
}

// Retained for potential future use (solution-seeking term detection).
export const TEMPLATE_SOLUTION_TERMS = SOLUTION_TERMS;
