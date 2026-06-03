import { listAvailableAccounts, resolveAccount } from './accounts.ts';
import type { MarketingCliParseResult, MarketingHelpTopic } from './marketing-cli.types.ts';

const SESSION_SCRIPT = 'twitter-guerilla/x-session.ts';
const SESSION_ALL_SCRIPT = 'twitter-guerilla/x-session-all.ts';
const ENGAGE_SCRIPT = 'twitter-guerilla/x-engagement.ts';

const HELP_FLAG_VALUES = new Set(['--help', '-h']);

function includesHelpFlag(argv: string[]): boolean {
  return argv.some((value) => HELP_FLAG_VALUES.has(value));
}

function formatAccountList(): string {
  const accounts = listAvailableAccounts();
  const aliases: string[] = [];

  return [
    ...accounts.map((account) => `  - ${account}`),
    ...aliases.map((alias) => `  - ${alias}`),
  ].join('\n');
}

export function formatMarketingHelp(topic: MarketingHelpTopic): string {
  const accountsSection = formatAccountList();

  switch (topic) {
    case 'session':
      return [
        'Usage:',
        '  marketing session [persona] [--dry-run] [--fresh-session] [--likes N] [--comments N] [--home] [--community <url-or-id-or-alias>]',
        '  marketing session [persona] [--search "exact words"] [--search-set alias]',
        '  marketing session [persona] [--keywords]',
        '  marketing session [persona] [--buyer-intent]',
        '  marketing session [persona] [--buyer-intent-random]',
        '',
        'Run one guerilla engagement session.',
        'With no discovery flags, the baseline broad discovery flow is used.',
        '',
        'Examples:',
        '  marketing session --dry-run',
        '  marketing session myaccount --fresh-session --likes 12 --comments 3',
        '  marketing session myaccount --home',
        '  marketing session myaccount --keywords',
        '  marketing session myaccount --buyer-intent',
        '  marketing session myaccount --buyer-intent-random',
        '  marketing session myaccount --search-set buyers',
        '  marketing session myaccount --search "your search query"',
        '  marketing session myaccount --community https://x.com/i/communities/<id>',
        '',
        'Available personas:',
        accountsSection,
      ].join('\n');
    case 'session-all':
      return [
        'Usage:',
        '  marketing session all [persona ...] [--sessions N] [--fail-fast] [session flags]',
        '',
        'Run the session command across multiple personas.',
        '',
        'Examples:',
        '  marketing session all --dry-run',
        '  marketing session all myaccount --sessions 2 --fresh-session',
        '  marketing session all myaccount --search-set buyers',
        '',
        'Available personas:',
        accountsSection,
      ].join('\n');
    case 'engage':
      return [
        'Usage:',
        '  marketing engage [persona] <tweet-url-or-id> [--dry-run] [--quick "reply"]',
        '',
        'Open a specific tweet and prepare or post a reply.',
        '',
        'Examples:',
        '  marketing engage myaccount https://x.com/example/status/123 --dry-run',
        '  marketing engage myaccount 123456789 --quick "your reply text"',
        '',
        'Available personas:',
        accountsSection,
      ].join('\n');
    case 'root':
    default:
      return [
        'Usage:',
        '  marketing <command> [options]',
        '',
        'Commands:',
        '  session [persona]      Run one guerilla session',
        '  session all            Run sessions for all or selected personas',
        '  engage                 Reply to a specific tweet',
        '  help [command]         Show command help',
        '',
        'Examples:',
        '  marketing session myaccount --dry-run',
        '  marketing session all --dry-run --fresh-session',
        '  marketing engage myaccount https://x.com/example/status/123',
      ].join('\n');
  }
}

function buildHelpResult(topic: MarketingHelpTopic, error?: string): MarketingCliParseResult {
  return {
    kind: 'help',
    topic,
    error,
    exitCode: error ? 1 : 0,
  };
}

function parseSessionCommand(argv: string[]): MarketingCliParseResult {
  if (argv.length === 0 || includesHelpFlag(argv) || argv[0] === 'help') {
    return buildHelpResult(argv[0] === 'all' ? 'session-all' : 'session');
  }

  const [head, ...tail] = argv;

  if (head === 'all') {
    if (tail[0] === 'help') return buildHelpResult('session-all');
    return {
      kind: 'run',
      scriptPath: SESSION_ALL_SCRIPT,
      args: tail,
    };
  }

  if (head.startsWith('-')) {
    return {
      kind: 'run',
      scriptPath: SESSION_SCRIPT,
      args: argv,
    };
  }

  try {
    const account = resolveAccount(head);
    return {
      kind: 'run',
      scriptPath: SESSION_SCRIPT,
      args: ['--account', account.key, ...tail],
    };
  } catch {
    return buildHelpResult('session', `Unknown session target "${head}".`);
  }
}

function parseEngageCommand(argv: string[]): MarketingCliParseResult {
  if (argv.length === 0 || includesHelpFlag(argv) || argv[0] === 'help') {
    return buildHelpResult('engage');
  }

  return {
    kind: 'run',
    scriptPath: ENGAGE_SCRIPT,
    args: argv,
  };
}

function parseHelpCommand(argv: string[]): MarketingCliParseResult {
  if (argv.length === 0) return buildHelpResult('root');
  if (argv[0] === 'session' && argv[1] === 'all') return buildHelpResult('session-all');
  if (argv[0] === 'session') return buildHelpResult('session');
  if (argv[0] === 'engage') return buildHelpResult('engage');
  return buildHelpResult('root', `Unknown help topic "${argv.join(' ')}".`);
}

export function parseMarketingCliArgs(argv: string[]): MarketingCliParseResult {
  if (argv.length === 0) {
    return buildHelpResult('root');
  }

  const [command, ...rest] = argv;

  if (HELP_FLAG_VALUES.has(command)) {
    return buildHelpResult('root');
  }

  if (command === 'help') return parseHelpCommand(rest);
  if (command === 'session') return parseSessionCommand(rest);
  if (command === 'engage') return parseEngageCommand(rest);

  return buildHelpResult('root', `Unknown command "${command}".`);
}
