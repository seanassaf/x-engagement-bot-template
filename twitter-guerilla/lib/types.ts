export type JsonObject = Record<string, unknown>;

export type AccountProfile = {
  displayName: string;
  envKey: string;
  key: string;
  personaPath: string;
};

export type TweetAuthor = {
  description: string;
  id: string;
  name: string;
  username: string;
};

export type TweetReferenceType = 'quoted' | 'replied_to' | 'retweeted';

export type TweetReference = {
  id: string;
  type: TweetReferenceType;
};

export type UserProfile = {
  description: string;
  followersCount: number | null;
  name: string;
  username: string;
};

export type AuthenticatedUser = {
  id: string;
  name: string;
  username: string;
};

export type TweetRecord = {
  author: TweetAuthor | null;
  createdAt: string;
  id: string;
  metrics: Record<string, unknown> | null;
  referencedTweets?: TweetReference[] | null;
  replySettings: string | null;
  text: string;
};

export type AppConfig = {
  account: AccountProfile;
  browserProfileDir: string;
  browserHeadless: boolean;
  browserDisableSandbox: boolean;
  engagementContext: string;
  engagementPersona: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  sessionLogPath: string;
  xApiBaseUrl: string;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessSecret: string;
  xLoginIdentifier: string | null;
  xLoginManual: boolean;
  xLoginPass: string | null;
  xLoginUser: string | null;
};

export type SessionArgs = {
  accountInput: string | null;
  buyerIntentMode: boolean;
  likes: number;
  comments: number;
  dryRun: boolean;
  freshSession: boolean;
  homeTimeline: boolean;
  communityUrl: string | null;
  searchQueries: string[];
};

export type FeedCandidate = {
  tweetId: string;
  authorUsername: string;
  authorFollowersCount: number | null;
  tweetText: string;
  visibleText?: string;
  intentScore?: number | null;
  likeCount: number;
  statusUrl: string;
  alreadyLiked: boolean;
  isPromoted: boolean;
  isQuoteTweet?: boolean;
  isRetweet?: boolean;
};

export type SessionLogEntry = {
  accountKey?: string;
  acquisitionMode?: 'general' | 'targeted';
  discoveryKey?: string;
  discoveryLabel?: string;
  sessionId: string;
  tweetId: string;
  authorUsername: string;
  action: 'liked' | 'commented' | 'liked + commented' | 'failed';
  replyText: string;
  searchQuery?: string | null;
  timestamp: string;
  success: boolean;
  error?: string;
};
