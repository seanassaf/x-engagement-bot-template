import { randomBytes } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import { dirname } from 'node:path';
import { createInterface, Interface } from 'node:readline/promises';

import type { TweetRecord } from './lib/types.ts';
import { isAffirmative } from './lib/utils.ts';
import { loadEnvFiles, loadConfig } from './lib/config.ts';
import { extractTweetId, fetchTweet } from './lib/x-api.ts';
import { generateReplyOptions } from './lib/llm.ts';
import { postReplyViaBrowser } from './lib/browser.ts';
import { isKnownAccountInput } from './lib/accounts.ts';
import { assertTweetEngagementAllowed } from './lib/hard-rules.ts';
import { assertReplyTextAllowed } from './lib/reply-policy.ts';
import { appendSessionLog, findLatestSuccessfulComment, loadSessionLogsFromDirectory } from './lib/session-log.ts';
import type { ReplySelection, XEngagementCliArgs } from './lib/x-engagement.types.ts';
import { isTargetAccountKey } from './lib/intent.ts';

loadEnvFiles();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rl = createInterface({ input, output });

  try {
    const config = loadConfig(args.accountInput);
    console.log(`Selected persona: ${config.account.key}`);

    const target = args.target ?? ((await rl.question('Paste the tweet URL or tweet ID: ')).trim() || null);

    if (!target) {
      console.log('Usage: marketing engage [persona] <tweet-url-or-id> [--dry-run] [--quick "text"]');
      process.exitCode = 1;
      return;
    }

    const tweetId = extractTweetId(target);
    if (!tweetId) throw new Error(`Could not extract a tweet ID from "${target}".`);

    const tweet = await fetchTweet(tweetId, config);
    assertNoPriorAccountComment(config.sessionLogPath, tweetId);
    assertTweetEngagementAllowed(tweet, 'engage');
    printTweet(tweet);

    if (args.quickReply) {
      assertReplyTextAllowed(args.quickReply, tweet, { accountKey: config.account.key });
      console.log(`Quick reply: ${args.quickReply}\n`);
      assertNoPriorAccountComment(config.sessionLogPath, tweet.id);

      if (args.dryRun) {
        console.log('Dry run enabled. No reply was posted.');
        return;
      }

      rl.close();
      await postReplyViaBrowser(tweet, args.quickReply, config);
      recordSuccessfulComment(config.sessionLogPath, config.account.key, tweet, args.quickReply);
      return;
    }

    while (true) {
      const candidates = await generateReplyOptions(tweet, config, { discoveryMode: 'manual' });
      const selection = await promptForReplySelection(rl, candidates);

      if (selection.kind === 'quit') {
        console.log('\nAborted.');
        return;
      }

      if (selection.kind === 'regenerate') {
        console.log('\nGenerating a fresh set of reply options...\n');
        continue;
      }

      const selectedReply = candidates[selection.index];
      console.log(`\nSelected reply:\n${selectedReply}\n`);

      if (args.dryRun) {
        console.log('Dry run enabled. No reply was posted.');
        return;
      }

      const confirmation = await rl.question('Post this reply? [y/N] ');
      if (!isAffirmative(confirmation)) {
        console.log('\nReply not posted.');
        return;
      }

      assertNoPriorAccountComment(config.sessionLogPath, tweet.id);
      rl.close();
      await postReplyViaBrowser(tweet, selectedReply, config);
      recordSuccessfulComment(config.sessionLogPath, config.account.key, tweet, selectedReply);
      return;
    }
  } finally {
    rl.close();
  }
}

function assertNoPriorAccountComment(sessionLogPath: string, tweetId: string): void {
  const priorComment = findLatestSuccessfulComment(
    loadSessionLogsFromDirectory(dirname(sessionLogPath)),
    tweetId,
  );

  if (!priorComment) return;

  const source = priorComment.accountKey ? priorComment.accountKey : 'another account';
  throw new Error(`Hard rule: refusing to reply because ${source} already commented on this post.`);
}

function recordSuccessfulComment(
  sessionLogPath: string,
  accountKey: string,
  tweet: TweetRecord,
  replyText: string,
): void {
  appendSessionLog(
    {
      accountKey,
      acquisitionMode: isTargetAccountKey(accountKey) ? 'targeted' : 'general',
      discoveryKey: 'manual-engage',
      discoveryLabel: 'manual engage',
      sessionId: randomBytes(8).toString('hex'),
      tweetId: tweet.id,
      authorUsername: tweet.author?.username ?? 'unknown',
      action: 'commented',
      replyText,
      searchQuery: null,
      timestamp: new Date().toISOString(),
      success: true,
    },
    sessionLogPath,
  );
}

function parseArgs(argv: string[]): XEngagementCliArgs {
  const args: XEngagementCliArgs = { accountInput: null, dryRun: false, quickReply: null, target: null };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--') continue;
    if (value === '--dry-run') { args.dryRun = true; continue; }
    if (value === '--quick') { args.quickReply = argv[++i]; if (!args.quickReply) throw new Error('--quick requires a reply text argument'); continue; }
    if (value === '--account') {
      args.accountInput = argv[++i] ?? null;
      if (!args.accountInput) throw new Error('--account requires an account value');
      continue;
    }
    if (!args.accountInput && !args.target && isKnownAccountInput(value)) {
      args.accountInput = value;
      continue;
    }
    if (!args.target) { args.target = value; continue; }
    throw new Error(`Unexpected argument: ${value}`);
  }

  return args;
}

function printTweet(tweet: TweetRecord): void {
  const authorLine = tweet.author ? `@${tweet.author.username} (${tweet.author.name})` : 'Unknown author';
  console.log(`\nTarget tweet: ${tweet.id}`);
  console.log(`Author: ${authorLine}`);
  console.log(`Created: ${tweet.createdAt}`);
  console.log(`Reply settings: ${tweet.replySettings ?? 'unknown'}`);
  console.log('\nPost text:\n');
  console.log(tweet.text);
  console.log('');
}

async function promptForReplySelection(rl: Interface, candidates: string[]): Promise<ReplySelection> {
  while (true) {
    const answer = await rl.question(`Pick a reply [1-${candidates.length}], regenerate [r], or quit [q]: `);
    const normalized = answer.trim().toLowerCase();

    if (normalized === 'q') return { kind: 'quit' };
    if (normalized === 'r') return { kind: 'regenerate' };

    const choice = Number.parseInt(normalized, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= candidates.length) {
      return { kind: 'select', index: choice - 1 };
    }

    console.log(`Invalid choice. Enter 1-${candidates.length}, r, or q.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
