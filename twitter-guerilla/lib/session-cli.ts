import type { SessionArgs } from './types.ts';
import { rand } from './utils.ts';
import { isKnownAccountInput } from './accounts.ts';
import { BUYER_INTENT_QUERIES } from './intent.ts';

const COMMUNITY_URL_PATH_RE = /^\/i\/communities\/(\d+)(?:\/.*)?$/u;
const COMMUNITY_ALIASES = new Map<string, string>();
// TODO: replace with your niche's general topical search phrases (used by --keywords).
const KEYWORD_SEARCH_SET = [
  'your search phrase one',
  'your search phrase two',
  'your search phrase three',
];
// `--search-set <alias>` rotates through a named set of search queries.
// `buyers`/`intent` use the buyer-intent queries (and switch on targeted acquisition mode).
const SEARCH_SET_ALIASES = new Map<string, string[]>([
  ['keywords', KEYWORD_SEARCH_SET],
  ['buyers', BUYER_INTENT_QUERIES],
  ['intent', BUYER_INTENT_QUERIES],
]);
const BUYER_INTENT_SEARCH_SET_ALIASES = new Set(['buyers', 'intent']);

export function randomizeSessionTargets(): { likes: number; comments: number } {
  const likes = rand(15, 30);
  const comments = rand(40, 55);
  return { likes, comments };
}

export function randomizeBuyerIntentTargets(): { likes: number; comments: number } {
  const likes = 0;
  const comments = rand(4, 8);
  return { likes, comments };
}

export function randomizeBuyerIntentLongTargets(): { likes: number; comments: number } {
  const likes = rand(10, 18);
  const comments = rand(14, 24);
  return { likes, comments };
}

function normalizeCommunityUrl(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) throw new Error('--community requires a community URL, numeric ID, or known alias');

  const aliasResolved = COMMUNITY_ALIASES.get(trimmed) ?? trimmed;

  if (/^\d+$/u.test(aliasResolved)) {
    return `https://x.com/i/communities/${aliasResolved}`;
  }

  let url: URL;
  try {
    url = new URL(aliasResolved);
  } catch {
    throw new Error('--community must be an X community URL, numeric ID, or known alias like "zsc"');
  }

  const hostname = url.hostname.toLowerCase();
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(hostname)) {
    throw new Error('--community must point to x.com or twitter.com');
  }

  const match = url.pathname.match(COMMUNITY_URL_PATH_RE);
  if (!match) {
    throw new Error('--community must be an X community URL like https://x.com/i/communities/<id>');
  }

  return `https://x.com/i/communities/${match[1]}`;
}

function normalizeSearchQuery(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, ' ');
  if (!trimmed) throw new Error('--search requires a non-empty query');
  return trimmed;
}

function appendSearchQueries(target: string[], queries: string[]): void {
  const seen = new Set(target.map((query) => query.toLowerCase()));

  for (const query of queries) {
    const normalized = normalizeSearchQuery(query);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(normalized);
  }
}

function resolveSearchSet(value: string): string[] {
  const alias = value.trim().toLowerCase();
  if (!alias) throw new Error('--search-set requires a known alias');

  const set = SEARCH_SET_ALIASES.get(alias);
  if (!set) {
    throw new Error(`Unknown search set "${value}". Available sets: ${Array.from(new Set(SEARCH_SET_ALIASES.keys())).sort().join(', ')}`);
  }

  return set;
}

export function resolveBuyerIntentSearchQueries(): string[] {
  return [...BUYER_INTENT_QUERIES];
}

export function parseSessionArgs(argv: string[]): SessionArgs {
  const { likes, comments } = randomizeSessionTargets();
  const args: SessionArgs = {
    accountInput: null,
    buyerIntentMode: false,
    likes,
    comments,
    dryRun: false,
    freshSession: false,
    homeTimeline: false,
    communityUrl: null,
    searchQueries: [],
  };
  let explicitLikes = false;
  let explicitComments = false;
  let buyerIntentLongRandom = false;

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--') continue;
    if (value === '--dry-run') { args.dryRun = true; continue; }
    if (value === '--fresh-session') { args.freshSession = true; continue; }
    if (value === '--home') {
      args.homeTimeline = true;
      continue;
    }
    if (value === '--buyer-intent') {
      args.buyerIntentMode = true;
      continue;
    }
    if (value === '--buyer-intent-random' || value === '--buyer-intent-long') {
      args.buyerIntentMode = true;
      buyerIntentLongRandom = true;
      continue;
    }
    if (value === '--community' || value === '--community-url') {
      args.communityUrl = normalizeCommunityUrl(argv[++i] ?? '');
      continue;
    }
    if (value === '--search' || value === '--keyword') {
      appendSearchQueries(args.searchQueries, [argv[++i] ?? '']);
      continue;
    }
    if (value === '--keywords') {
      appendSearchQueries(args.searchQueries, resolveSearchSet('keywords'));
      continue;
    }
    if (value === '--search-set') {
      const alias = argv[++i] ?? '';
      appendSearchQueries(args.searchQueries, resolveSearchSet(alias));
      if (BUYER_INTENT_SEARCH_SET_ALIASES.has(alias.trim().toLowerCase())) {
        args.buyerIntentMode = true;
      }
      continue;
    }
    if (value === '--account') {
      args.accountInput = argv[++i] ?? null;
      if (!args.accountInput) throw new Error('--account requires an account value');
      continue;
    }
    if (value === '--likes') {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) throw new Error('--likes must be a non-negative integer');
      args.likes = n;
      explicitLikes = true;
      continue;
    }
    if (value === '--comments') {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) throw new Error('--comments must be a non-negative integer');
      args.comments = n;
      explicitComments = true;
      continue;
    }
    if (!args.accountInput && isKnownAccountInput(value)) {
      args.accountInput = value;
      continue;
    }
    throw new Error(`Unexpected argument: ${value}`);
  }

  if (args.communityUrl && args.searchQueries.length > 0) {
    throw new Error('--community cannot be combined with --search, --search-set, or --keywords');
  }
  if (args.homeTimeline && args.communityUrl) {
    throw new Error('--home cannot be combined with --community');
  }
  if (args.homeTimeline && args.searchQueries.length > 0) {
    throw new Error('--home cannot be combined with --search, --search-set, or --keywords');
  }
  if (args.homeTimeline && args.buyerIntentMode) {
    throw new Error('--home cannot be combined with --buyer-intent');
  }
  if (args.buyerIntentMode && args.communityUrl) {
    throw new Error('--buyer-intent cannot be combined with --community');
  }

  if (args.buyerIntentMode && (!explicitLikes || !explicitComments)) {
    const defaults = buyerIntentLongRandom
      ? randomizeBuyerIntentLongTargets()
      : randomizeBuyerIntentTargets();
    if (!explicitLikes) args.likes = defaults.likes;
    if (!explicitComments) args.comments = defaults.comments;
  }

  return args;
}
