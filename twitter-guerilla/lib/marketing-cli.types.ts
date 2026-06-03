export type MarketingHelpTopic = 'engage' | 'root' | 'session' | 'session-all';

export type MarketingCliParseResult =
  | {
      kind: 'help';
      exitCode: number;
      error?: string;
      topic: MarketingHelpTopic;
    }
  | {
      args: string[];
      kind: 'run';
      scriptPath: string;
    };
