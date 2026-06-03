import type { AppConfig, TweetRecord } from './types.ts';
import { getObject, getString, parseJsonObject, stripTrailingSlash } from './utils.ts';
import {
  assertReplyCandidatesAllowed,
  assertReplyTextAllowed,
  repairReplyText,
  resolveReplyPolicy,
  type ReplyPolicy,
} from './reply-policy.ts';

const DEFAULT_REPLY_COUNT = 3;
const MAX_REPLY_LENGTH = 240;
const MAX_GENERATION_ATTEMPTS = 3;
// TODO: terms that mark a post as analytical/technical in your niche (drives reply tone).
const ANALYTICAL_TERMS = [
  'data', 'metric', 'metrics', 'analysis', 'workflow', 'process', 'strategy',
  'integration', 'automation', 'roi', 'conversion', 'efficiency', 'benchmark',
];
const CASUAL_TERMS = [
  'pizza', 'beer', 'coffee', 'breakfast', 'lunch', 'dinner', 'weekend',
  'lol', 'lmao', 'haha', 'gm', 'gn', 'bro', 'buddy', 'sleep', 'nap',
  'vacation', 'wife', 'husband', 'dog', 'cat', 'celebrating', 'treat',
];
const CELEBRATION_TERMS = [
  'congrats', 'congratulations', 'won', 'win', 'winning', 'closed', 'signed',
  'lets go', "let's go", 'lfg', 'finally', 'payday', 'milestone', 'shipped',
];

export type ReplyMode = {
  replyStyleHint: string;
  sourceStyle: 'analytical' | 'casual' | 'celebratory' | 'mixed';
};

export type AccountReplyDirective = {
  candidatePlan: [string, string, string];
  strategy: 'best-engagement' | 'buyer-intent-qualification' | 'viral-first';
  strategyHint: string;
};

export type ReplyGenerationContext = {
  discoveryMode?: 'baseline' | 'buyer-intent' | 'manual';
};

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 400;

export async function generateReplyOptions(
  tweet: TweetRecord,
  config: AppConfig,
  context: ReplyGenerationContext = {},
): Promise<string[]> {
  const replyMode = inferReplyMode(tweet);
  const replyPolicy = resolveReplyPolicy(config.account.key, tweet);
  const accountDirective = inferAccountReplyDirective(config.account.key, tweet, context);
  const systemPrompt = buildSystemPrompt(config.engagementPersona, replyPolicy, context);
  const userPrompt = JSON.stringify(
    {
      replyGenerationContext: {
        discoveryMode: context.discoveryMode ?? 'manual',
      },
      context: config.engagementContext,
      accountDirective,
      replyPolicy,
      replyMode,
      sourcePost: {
        id: tweet.id,
        text: tweet.text,
        createdAt: tweet.createdAt,
        author: tweet.author,
        metrics: tweet.metrics,
      },
    },
    null,
    2,
  );

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      const response = await requestLlmCompletion(config, systemPrompt, userPrompt);
      const payload = await parseJsonResponse(response);
      const content = extractLlmTextContent(payload, config.llmBaseUrl);

      if (!content) {
        throw new Error(`LLM response did not contain message content: ${JSON.stringify(payload)}`);
      }

      const parsed = parseJsonObject(content);
      const candidates = normalizeCandidates(parsed.comments);
      const repairedCandidates = repairReplyCandidates(candidates, tweet, config.account.key, replyPolicy);

      if (repairedCandidates.length === 0) {
        throw new Error('LLM did not produce any reply candidate that could be normalized into policy.');
      }

      if (repairedCandidates.length < DEFAULT_REPLY_COUNT) {
        console.warn(
          `Recovered ${repairedCandidates.length}/${DEFAULT_REPLY_COUNT} policy-safe replies from the model output.`,
        );
      }

      console.log('Reply options:\n');
      for (const [index, candidate] of repairedCandidates.entries()) {
        console.log(`${index + 1}. ${candidate}\n`);
      }

      return repairedCandidates;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_GENERATION_ATTEMPTS) {
        console.warn(`Reply generation attempt ${attempt} rejected: ${lastError.message}`);
      }
    }
  }

  throw lastError ?? new Error('Reply generation failed.');
}

async function requestLlmCompletion(
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<Response> {
  const baseUrl = stripTrailingSlash(config.llmBaseUrl);

  if (isAnthropicBaseUrl(baseUrl)) {
    return fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        'x-api-key': config.llmApiKey,
      },
      body: JSON.stringify({
        model: config.llmModel,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: systemPrompt,
        temperature: 0.9,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
    });
  }

  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.9,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    }),
  });
}

function isAnthropicBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase().includes('anthropic.com');
  } catch {
    return value.toLowerCase().includes('anthropic.com');
  }
}

function extractLlmTextContent(payload: Record<string, unknown>, llmBaseUrl: string): string | null {
  if (isAnthropicBaseUrl(llmBaseUrl)) {
    const contentBlocks = Array.isArray(payload.content) ? payload.content : [];

    for (const block of contentBlocks) {
      const entry = getObject(block);
      if (!entry || getString(entry.type) !== 'text') continue;
      const text = getString(entry.text);
      if (text) return text;
    }

    return null;
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = getObject(choices[0]);
  const message = getObject(firstChoice?.message);
  return getString(message?.content);
}

export function inferReplyMode(tweet: TweetRecord): ReplyMode {
  const text = tweet.text.toLowerCase();
  const analyticalScore = countMatches(text, ANALYTICAL_TERMS) + (/\b\d+(?:\.\d+)?%/u.test(text) ? 1 : 0);
  const casualScore = countMatches(text, CASUAL_TERMS);
  const celebrationScore = countMatches(text, CELEBRATION_TERMS);

  if (celebrationScore > 0 && analyticalScore <= 1) {
    return {
      sourceStyle: 'celebratory',
      replyStyleHint:
        'Favor a human social reply. Congratulate them, tease lightly, or ask for a celebratory share. Do not force market jargon.',
    };
  }

  if (casualScore > 0 && analyticalScore <= 1) {
    return {
      sourceStyle: 'casual',
      replyStyleHint:
        'Favor a natural thread reply. Sound like a smart human reacting in the moment, not an analyst performing for the timeline.',
    };
  }

  if (analyticalScore >= 2 && celebrationScore === 0) {
    return {
      sourceStyle: 'analytical',
      replyStyleHint:
        'Lead with the sharpest analytical angle or structural observation. Add edge, not summary.',
    };
  }

  return {
    sourceStyle: 'mixed',
    replyStyleHint:
      'Blend human tone with one sharp observation. Keep it natural and context-matched.',
  };
}

export function inferAccountReplyDirective(
  accountKey: string,
  tweet: TweetRecord,
  context: ReplyGenerationContext = {},
): AccountReplyDirective {
  const replyPolicy = resolveReplyPolicy(accountKey, tweet);
  if (replyPolicy.profile === 'buyer-intent' || context.discoveryMode === 'buyer-intent') {
    return {
      strategy: 'buyer-intent-qualification',
      strategyHint:
        'This session is trying to identify clear buyer intent for your niche. Candidate 1 should reflect the specific pain or need the author expressed and sound genuinely useful to them. Prefer diagnostic, problem-aware framing over generic engagement: name the friction or where their current process breaks. Prefer qualifying questions and how they currently handle the problem over clever timeline banter. Keep candidate 1 product-free.',
      candidatePlan: [
        'best problem-aware reply that makes the author feel understood and names their pain',
        'short diagnostic question about how they currently handle the problem',
        'observation that frames the gap or friction, with no product pitch',
      ],
    };
  }

  if (isFreshViralWindow(tweet.createdAt)) {
    return {
      strategy: 'viral-first',
      strategyHint:
        'This post is less than 10 minutes old. Candidate 1 must optimize for maximum viral pickup in the thread: instantly clear, punchy, specific, native to X, and more likely to earn likes than a dense niche take. Stay relevant to the post and never drift into generic praise.',
      candidatePlan: [
        'most viral publish ready reply for this fresh thread',
        'question that can trigger fast back and forth',
        'sharp observation with strong social pickup potential',
      ],
    };
  }

  return {
    strategy: 'best-engagement',
    strategyHint:
      'Lead with the strongest publish ready reply. Keep it useful, human, and context matched.',
    candidatePlan: [
      'strongest publish ready engagement for this thread',
      'question that could spark a reply',
      'sharp observation with human tone',
    ],
  };
}

function buildSystemPrompt(
  persona: string,
  replyPolicy: ReplyPolicy,
  context: ReplyGenerationContext,
): string {
  return [
    persona,
    '',
    'ENGAGEMENT STRATEGY (applies regardless of persona):',
    '- Sound like a real person, not an AI. Genuine reactions only.',
    '- Quality beats quantity. Only produce replies that add clear value: insight, angle, a sharp workflow observation, or a funny but relevant take.',
    '- If the best reply would be filler, praise, or emoji spam, do not go there. Stay sharp and useful.',
    '- Match the vibe of the post before anything else.',
    '- Do NOT force analytical/technical jargon onto casual, personal, meme, or celebratory posts.',
    '- If the source post is casual or celebratory, social replies beat abstract domain metaphors.',
    '- For casual or celebratory posts, prefer congratulations, playful envy, teasing, or a light ask over jargon.',
    '- For analytical posts, add edge, structure, or the sharper implication others missed.',
    '- Concrete human reactions beat vague cleverness.',
    '- Replies that invite a real back-and-forth beat sterile one-liners.',
    '- Candidate 1 is the one that gets posted automatically. Make candidate 1 the strongest publish ready option.',
    '- The user payload includes accountDirective with the exact candidate plan. Follow it.',
    '- The user payload includes replyPolicy. Obey it exactly.',
    context.discoveryMode === 'buyer-intent'
      ? '- This is a buyer-intent discovery session. Optimize for relevance and qualification, not generic virality. Identify the workflow pain and speak to it directly.'
      : '- This is a baseline engagement session. Optimize for native, high-signal participation in the thread, not qualification or product discovery.',
    '- On problem-heavy posts, prefer diagnostic framing: name where the author\'s current process breaks or where the friction lives.',
    '- Good buyer-intent comments sound diagnostic, problem-aware, or process-aware. They do not sound like ads.',
    '- If accountDirective says the post is fresh, optimize candidate 1 for virality in the thread while staying specific to the post.',
    '- Do not mention your product or any product by name.',
    '',
    'LENGTH RULE (CRITICAL):',
    `- MAXIMUM ${replyPolicy.maxWords} WORDS per reply. This is the hardest constraint. Count your words.`,
    replyPolicy.maxWords <= 8
      ? '- Think bumper sticker, not paragraph. If it needs explaining, it\'s too long.'
      : '- Keep it tight. Use the extra room only when it materially improves clarity on the problem or detail.',
    '- Examples of good length: "that is the part everyone underestimates" / "congrats, the hard part is done" / "the gap is always in the handoff"',
    '',
    'FORMATTING RULES:',
    '- NEVER use dashes: no --, —, or –.',
    '- Lowercase is fine. No hashtags. No emojis unless perfect fit.',
    '- Avoid stiff corporate jargon unless the source post is clearly in that register.',
    '',
    'BAD VS GOOD:',
    '- Bad on a casual win post: "impressive workflow optimization"',
    '- Good on a casual win post: "congrats, that one looked hard"',
    '- Good on a casual win post: "huge, what is the next move"',
    '- Good on a problem post: "the easy part is spotting it, the hard part is the follow-through"',
    '- Good on a problem post: "most of the friction lives in the handoff"',
    '',
    'OUTPUT RULES:',
    '- Generate exactly 3 distinct reply candidates.',
    `- EVERY reply must be ${replyPolicy.maxWords} words or fewer. NO EXCEPTIONS.`,
    '- Vary the style: one punchy take, one question, one observation.',
    '- Return ONLY valid JSON: {"comments":["...", "...", "..."]}',
  ].join('\n');
}

function normalizeCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('LLM JSON response is missing a comments array.');
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((entry) => entry.slice(0, MAX_REPLY_LENGTH));
}

function repairReplyCandidates(
  candidates: string[],
  tweet: TweetRecord,
  accountKey: string,
  policy: ReplyPolicy,
): string[] {
  const uniqueCandidates: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const repaired = repairReplyText(candidate, tweet, { accountKey, policy });
    if (!repaired) continue;

    const normalized = repaired.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueCandidates.push(repaired);
  }

  if (uniqueCandidates.length > 0) {
    for (const candidate of uniqueCandidates) {
      assertReplyTextAllowed(candidate, tweet, { accountKey, policy });
    }
    return uniqueCandidates;
  }

  assertReplyCandidatesAllowed(candidates, tweet, { accountKey, policy });
  return candidates;
}

function countMatches(text: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score++;
  }
  return score;
}

function isFreshViralWindow(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - createdAtMs <= 10 * 60 * 1000;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = text ? parseJsonObject(text) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }

  return payload;
}
