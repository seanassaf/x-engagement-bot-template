export type SessionRunResult = {
  account: string;
  code: number | null;
  sessionNumber: number;
  signal: NodeJS.Signals | null;
  success: boolean;
};
