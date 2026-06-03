// Brand-safety filter: drop posts that touch politics, religion, geopolitics, armed
// conflict, and other hot-button social topics so the bot never engages
// with them. Conservative by design — when in doubt it blocks (skipping a post is
// cheap and the feed has plenty of alternatives). Word-boundary matched to avoid
// false positives on normal crypto/business words (jewelry, occupation, "woke up",
// "conservative position size", etc.).

const SENSITIVE_TERMS = [
  // Politics / government
  'election', 'elections', 'president', 'presidential', 'senate', 'senator', 'congress',
  'parliament', 'government shutdown', 'democrat', 'democrats', 'republican', 'republicans',
  'gop', 'maga', 'communist', 'socialist', 'dictator', 'impeach', 'impeachment',
  'deportation', 'immigration', 'border wall', 'gun control', 'second amendment',
  'abortion', 'pro-life', 'pro-choice', 'roe v wade',
  'trump', 'biden', 'kamala', 'obama', 'desantis', 'newsom', 'pelosi', 'aoc',
  'putin', 'zelensky', 'netanyahu', 'modi', 'erdogan',
  // Religion
  'jewish', 'jews', 'muslim', 'muslims', 'islam', 'islamic', 'islamophobia',
  'christianity', 'christians', 'catholic', 'mosque', 'synagogue', 'quran', 'koran',
  'torah', 'hindu', 'buddhist', 'rabbi', 'imam', 'allah', 'antisemitism', 'antisemitic',
  // Geopolitics / armed conflict
  'genocide', 'war crime', 'war crimes', 'ethnic cleansing', 'israel', 'israeli',
  'palestine', 'palestinian', 'gaza', 'west bank', 'hamas', 'hezbollah', 'idf',
  'zionist', 'zionism', 'intifada', 'ukraine', 'ukrainian', 'russian invasion', 'nato',
  'taiwan', 'uyghur', 'syria', 'syrian', 'iran', 'iraq', 'afghanistan', 'isis',
  'terrorist', 'terrorism', 'jihad', 'ceasefire', 'apartheid', 'world war', 'ww3',
  'nuclear war',
  // Race / social hot-buttons
  'racism', 'racist', 'white supremacy', 'white supremacist', 'black lives matter', 'blm',
  'slavery', 'holocaust', 'nazi', 'nazis', 'kkk', 'lgbtq', 'transgender',
  'gender ideology', 'wokeness', 'critical race theory',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const SENSITIVE_REGEXES = SENSITIVE_TERMS.map(
  (term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'iu'),
);

export function isSensitiveTopic(text: string | null | undefined): boolean {
  if (!text) return false;
  return SENSITIVE_REGEXES.some((pattern) => pattern.test(text));
}

export const SENSITIVE_TOPIC_TERMS = SENSITIVE_TERMS;
