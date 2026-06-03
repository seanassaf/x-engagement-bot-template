export type SessionResult = {
  authorUsername: string;
  discoveryLabel?: string;
  tweetUrl: string;
  action:
    | 'liked'
    | 'commented'
    | 'liked + commented'
    | 'would like'
    | 'would comment'
    | 'would like + comment'
    | 'failed';
  replyText: string;
  error?: string;
};
