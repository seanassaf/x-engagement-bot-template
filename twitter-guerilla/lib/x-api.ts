import { createHmac, randomBytes } from 'node:crypto';

import type {
  AppConfig,
  AuthenticatedUser,
  JsonObject,
  TweetRecord,
  TweetReference,
  UserProfile,
} from './types.ts';
import { getObject, getString, parseJsonObject, requireString } from './utils.ts';

const TWEET_REFERENCE_TYPES = new Set<TweetReference['type']>(['quoted', 'replied_to', 'retweeted']);
const X_WEB_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_GUEST_ACTIVATE_URL = 'https://api.x.com/1.1/guest/activate.json';
const X_USER_BY_SCREEN_NAME_QUERY_ID = 'IGgvgiOx4QZndDHuD3x9TQ';
const X_USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
} as const;
const X_USER_BY_SCREEN_NAME_FIELD_TOGGLES = {
  withPayments: false,
  withAuxiliaryUserLabels: true,
} as const;
const X_WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let cachedGuestToken: { value: string; expiresAt: number } | null = null;

export function extractTweetId(value: string): string | null {
  const statusMatch = value.match(/status\/(\d+)/i);
  if (statusMatch) return statusMatch[1];

  const numericMatch = value.match(/^\d+$/);
  return numericMatch ? numericMatch[0] : null;
}

export function buildTweetUrl(tweet: TweetRecord): string {
  return tweet.author
    ? `https://x.com/${tweet.author.username}/status/${tweet.id}`
    : `https://x.com/i/status/${tweet.id}`;
}

export async function fetchTweet(tweetId: string, config: AppConfig): Promise<TweetRecord> {
  const url = new URL(`${config.xApiBaseUrl}/2/tweets/${tweetId}`);

  url.searchParams.set(
    'tweet.fields',
    'author_id,conversation_id,created_at,public_metrics,referenced_tweets,reply_settings,text',
  );
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'description,name,username');

  const response = await fetch(url, {
    headers: buildAuthHeaders(config, url.toString()),
  });

  const payload = await parseJsonResponse(response);
  const data = getObject(payload.data);
  const includes = getObject(payload.includes);
  const users = Array.isArray(includes?.users) ? includes.users : [];
  const author = getObject(users[0]);

  if (!data) {
    throw new Error(`Tweet lookup failed: ${JSON.stringify(payload)}`);
  }

  const referencedTweets = Array.isArray(data.referenced_tweets)
    ? data.referenced_tweets.flatMap((reference): TweetReference[] => {
        const entry = getObject(reference);
        const id = getString(entry?.id);
        const type = getString(entry?.type);
        if (!id || !type || !TWEET_REFERENCE_TYPES.has(type as TweetReference['type'])) {
          return [];
        }

        return [{ id, type: type as TweetReference['type'] }];
      })
    : [];

  return {
    id: requireString(data.id, 'Tweet response is missing data.id'),
    text: requireString(data.text, 'Tweet response is missing data.text'),
    createdAt: requireString(data.created_at, 'Tweet response is missing data.created_at'),
    referencedTweets: referencedTweets.length > 0 ? referencedTweets : null,
    replySettings: getString(data.reply_settings),
    author: author
      ? {
          id: requireString(author.id, 'Tweet author is missing id'),
          name: requireString(author.name, 'Tweet author is missing name'),
          username: requireString(author.username, 'Tweet author is missing username'),
          description: getString(author.description) ?? '',
        }
      : null,
    metrics: getObject(data.public_metrics),
  };
}

export async function fetchAuthenticatedUser(config: AppConfig): Promise<AuthenticatedUser> {
  const url = new URL(`${config.xApiBaseUrl}/2/users/me`);
  url.searchParams.set('user.fields', 'username,name');

  const response = await fetch(url, {
    headers: buildAuthHeaders(config, url.toString()),
  });

  const payload = await parseJsonResponse(response);
  const data = getObject(payload.data);

  if (!data) {
    throw new Error(`Authenticated user lookup failed: ${JSON.stringify(payload)}`);
  }

  return {
    id: requireString(data.id, 'Authenticated user response is missing data.id'),
    name: requireString(data.name, 'Authenticated user response is missing data.name'),
    username: requireString(data.username, 'Authenticated user response is missing data.username'),
  };
}

export async function fetchFollowerCounts(
  usernames: string[],
  config: AppConfig,
): Promise<Map<string, number>> {
  const profiles = await fetchUserProfiles(usernames, config);
  const result = new Map<string, number>();
  for (const profile of profiles.values()) {
    if (profile.followersCount !== null) {
      result.set(profile.username.toLowerCase(), profile.followersCount);
    }
  }
  return result;
}

export async function fetchUserProfiles(
  usernames: string[],
  config: AppConfig,
): Promise<Map<string, UserProfile>> {
  const result = new Map<string, UserProfile>();
  if (usernames.length === 0) return result;

  const batches: string[][] = [];
  for (let i = 0; i < usernames.length; i += 100) {
    batches.push(usernames.slice(i, i + 100));
  }

  for (const batch of batches) {
    const url = new URL(`${config.xApiBaseUrl}/2/users/by`);
    url.searchParams.set('usernames', batch.join(','));
    url.searchParams.set('user.fields', 'description,name,public_metrics,username');

    try {
      const response = await fetch(url, {
        headers: buildAuthHeaders(config, url.toString()),
      });
      const payload = await parseJsonResponse(response);
      const data = Array.isArray(payload.data) ? payload.data : [];

      for (const user of data) {
        const obj = getObject(user);
        if (!obj) continue;
        const username = getString(obj.username);
        const name = getString(obj.name);
        if (!username || !name) continue;

        const metrics = getObject(obj.public_metrics);
        const followersCount =
          metrics && typeof metrics.followers_count === 'number'
            ? (metrics.followers_count as number)
            : null;

        result.set(username.toLowerCase(), {
          description: getString(obj.description) ?? '',
          followersCount,
          name,
          username,
        });
      }
    } catch {
      // API rate limit or error — skip profile filtering for this batch
    }
  }

  const unresolved = usernames.filter((username) => !result.has(username.toLowerCase()));
  if (unresolved.length === 0) return result;

  for (let index = 0; index < unresolved.length; index += 5) {
    const batch = unresolved.slice(index, index + 5);
    const fallbackProfiles = await Promise.all(
      batch.map((username) => fetchUserProfileViaGuestGraphql(username)),
    );

    for (const profile of fallbackProfiles) {
      if (!profile) continue;
      result.set(profile.username.toLowerCase(), profile);
    }
  }

  return result;
}

function buildAuthHeaders(config: AppConfig, url: string): Record<string, string> {
  return {
    Authorization: buildOAuth1Header({
      accessToken: config.xAccessToken,
      accessTokenSecret: config.xAccessSecret,
      consumerKey: config.xApiKey,
      consumerSecret: config.xApiSecret,
      method: 'GET',
      url,
    }),
  };
}

async function parseJsonResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();
  const payload = text ? parseJsonObject(text) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function fetchUserProfileViaGuestGraphql(username: string): Promise<UserProfile | null> {
  const guestToken = await getGuestToken();
  if (!guestToken) return null;

  const url = new URL(`https://api.x.com/graphql/${X_USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName`);
  url.searchParams.set(
    'variables',
    JSON.stringify({ screen_name: username, withGrokTranslatedBio: true }),
  );
  url.searchParams.set('features', JSON.stringify(X_USER_BY_SCREEN_NAME_FEATURES));
  url.searchParams.set('fieldToggles', JSON.stringify(X_USER_BY_SCREEN_NAME_FIELD_TOGGLES));

  try {
    const response = await fetch(url, {
      headers: buildGuestHeaders(guestToken),
    });
    const payload = await parseJsonResponse(response);
    return parseGuestUserProfile(payload, username);
  } catch {
    return null;
  }
}

async function getGuestToken(): Promise<string | null> {
  if (cachedGuestToken && cachedGuestToken.expiresAt > Date.now()) {
    return cachedGuestToken.value;
  }

  try {
    const response = await fetch(X_GUEST_ACTIVATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
        'User-Agent': X_WEB_USER_AGENT,
      },
    });
    const payload = await parseJsonResponse(response);
    const guestToken = getString(payload.guest_token);
    if (!guestToken) return null;

    cachedGuestToken = {
      value: guestToken,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };

    return guestToken;
  } catch {
    return null;
  }
}

function buildGuestHeaders(guestToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
    Referer: 'https://x.com/',
    'Content-Type': 'application/json',
    'User-Agent': X_WEB_USER_AGENT,
    'X-Guest-Token': guestToken,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'en',
  };
}

function parseGuestUserProfile(payload: JsonObject, fallbackUsername: string): UserProfile | null {
  const data = getObject(payload.data);
  const user = getObject(data?.user);
  const result = getObject(user?.result);
  const core = getObject(result?.core);
  const legacy = getObject(result?.legacy);

  const username = getString(core?.screen_name) ?? fallbackUsername;
  const name = getString(core?.name);
  if (!username || !name) return null;

  const followersCount =
    legacy && typeof legacy.followers_count === 'number'
      ? (legacy.followers_count as number)
      : null;

  return {
    description: getString(legacy?.description) ?? '',
    followersCount,
    name,
    username,
  };
}

function buildOAuth1Header(params: {
  accessToken: string;
  accessTokenSecret: string;
  consumerKey: string;
  consumerSecret: string;
  method: string;
  url: string;
}): string {
  const oauthParams = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: params.accessToken,
    oauth_version: '1.0',
  };

  const signature = createOAuth1Signature({
    accessTokenSecret: params.accessTokenSecret,
    consumerSecret: params.consumerSecret,
    method: params.method,
    params: oauthParams,
    url: params.url,
  });

  return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ')}`;
}

function createOAuth1Signature(args: {
  accessTokenSecret: string;
  consumerSecret: string;
  method: string;
  params: Record<string, string>;
  url: string;
}): string {
  const urlObject = new URL(args.url);
  const queryParams = Array.from(urlObject.searchParams.entries());
  const oauthParams = Object.entries(args.params);

  const normalizedParams = [...queryParams, ...oauthParams]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([lk, lv], [rk, rv]) => (lk === rk ? lv.localeCompare(rv) : lk.localeCompare(rk)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const isDefaultPort =
    (urlObject.protocol === 'https:' && (urlObject.port === '' || urlObject.port === '443')) ||
    (urlObject.protocol === 'http:' && (urlObject.port === '' || urlObject.port === '80'));
  const baseUrl = `${urlObject.protocol}//${urlObject.hostname}${isDefaultPort ? '' : `:${urlObject.port}`}${urlObject.pathname}`;

  const signatureBaseString = [
    args.method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalizedParams),
  ].join('&');

  const signingKey = `${percentEncode(args.consumerSecret)}&${percentEncode(args.accessTokenSecret)}`;

  return createHmac('sha1', signingKey).update(signatureBaseString).digest('base64');
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
