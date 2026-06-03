export type XEngagementCliArgs = {
  accountInput: string | null;
  dryRun: boolean;
  quickReply: string | null;
  target: string | null;
};

export type ReplySelection =
  | { kind: 'quit' }
  | { kind: 'regenerate' }
  | { index: number; kind: 'select' };
