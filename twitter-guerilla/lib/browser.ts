import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AppConfig, TweetRecord } from './types.ts';
import { rand, randomSleep, sleep } from './utils.ts';
import { buildTweetUrl } from './x-api.ts';
import { assertTweetEngagementAllowed, normalizeUsername } from './hard-rules.ts';
import { assertAccountMatchesSelection } from './accounts.ts';

const REPLY_DIALOG_SELECTOR = '[role="dialog"]';
const REPLY_TEXTAREA_SELECTOR = 'div[data-testid="tweetTextarea_0"]';
const REPLY_TEXTAREA_EDITABLE_SELECTOR = `${REPLY_TEXTAREA_SELECTOR} div[contenteditable="true"]`;
const DIALOG_REPLY_TEXTAREA_EDITABLE_SELECTOR = `${REPLY_DIALOG_SELECTOR} ${REPLY_TEXTAREA_EDITABLE_SELECTOR}`;
const DIALOG_REPLY_TEXTAREA_FALLBACK_SELECTOR = `${REPLY_DIALOG_SELECTOR} ${REPLY_TEXTAREA_SELECTOR}`;
const DIALOG_REPLY_SUBMIT_SELECTOR = `${REPLY_DIALOG_SELECTOR} button[data-testid="tweetButton"]`;
const INLINE_REPLY_SUBMIT_SELECTOR = 'button[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]';
const X_SESSION_CHECK_TIMEOUT_MS = 25_000;
const X_SESSION_CHECK_POLL_MS = 500;
const COMPOSE_POST_PATH = '/compose/post';
const X_SEARCH_INPUT_SELECTOR = 'input[data-testid="SearchBox_Search_Input"]';
const X_SEARCH_LIVE_TAB_SELECTOR = 'a[href*="/search?"][href*="f=live"]';
const X_LOGIN_USERNAME_SELECTOR = 'input[autocomplete="username"]';
const X_LOGIN_PASSWORD_SELECTOR = 'input[name="password"]';
const X_LOGIN_VERIFICATION_SELECTOR = 'input[data-testid="ocfEnterTextTextInput"]';

type XSessionState = 'logged_in' | 'logged_out' | 'unknown';
export type ReplyComposerMode = 'inline' | 'dialog';
export type XLoginFlowStep = 'password' | 'verification' | 'unknown';
type XLoginFlowProgress = XLoginFlowStep | 'logged_in';
type XLoginSubmitStrategy = 'button' | 'enter' | 'tab_enter';

export class ManualXLoginRequiredError extends Error {
  accountKey: string;
  browserProfileDir: string;

  constructor(accountKey: string, browserProfileDir: string) {
    super(`Manual X login required for ${accountKey}`);
    this.name = 'ManualXLoginRequiredError';
    this.accountKey = accountKey;
    this.browserProfileDir = browserProfileDir;
  }
}

export function shouldAutoAcceptDialog(dialogType: string): boolean {
  return dialogType === 'beforeunload';
}

export function isComposePostUrl(url: string): boolean {
  try {
    return new URL(url, 'https://x.com').pathname === COMPOSE_POST_PATH;
  } catch {
    return url.includes(COMPOSE_POST_PATH);
  }
}

export function buildSearchResultsUrl(query: string, live = true): string {
  const params = new URLSearchParams({
    q: query,
    src: 'typed_query',
  });

  if (live) {
    params.set('f', 'live');
  }

  return `https://x.com/search?${params.toString()}`;
}

export function inferXLoginFlowStep(signals: {
  hasPasswordInput: boolean;
  hasVerificationInput: boolean;
}): XLoginFlowStep {
  if (signals.hasPasswordInput) return 'password';
  if (signals.hasVerificationInput) return 'verification';
  return 'unknown';
}

export function resolveXLoginVerificationValue(config: Pick<AppConfig, 'xLoginIdentifier' | 'xLoginUser'>): string | null {
  return config.xLoginIdentifier ?? config.xLoginUser;
}

export function inferUnexpectedPostComposerState(signals: {
  dialogLinkHrefs: string[];
  hasDialogReplyArea: boolean;
  hasDialogTweetButton: boolean;
  pageUrl: string;
}): boolean {
  if (isComposePostUrl(signals.pageUrl)) {
    return true;
  }

  return (
    signals.hasDialogReplyArea &&
    signals.hasDialogTweetButton &&
    !signals.dialogLinkHrefs.some((href) => /\/status\/\d+/u.test(getPathFromHref(href) ?? ''))
  );
}

export function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error('Chrome not found. Install Google Chrome or set CHROME_PATH in your environment.');
}

function isDetachedDomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Attempted to use detached Frame|Execution context was destroyed|Cannot find context with specified id|Node is detached/i.test(message);
}

export async function launchBrowser(
  config: AppConfig,
  options: { freshSession?: boolean } = {},
): Promise<{ browser: any; page: any }> {
  const puppeteer = await import('puppeteer-core');
  const chromePath = findChrome();
  const profileDir = resolve(config.browserProfileDir);

  if (!config.browserHeadless && !options.freshSession && await hasChromeProcessForProfile(profileDir)) {
    console.log('Closing an existing Chrome process for this browser profile before relaunching automation...');
    await terminateChromeProcessesForProfile(profileDir);
  }

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    // Keep rendering the page even when the window is occluded/backgrounded.
    // Without these, macOS Chrome pauses paint on an unfocused automation window
    // (black screen) and the lazy-loaded timeline never populates → 0 visible posts.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  if (config.browserDisableSandbox) {
    launchArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  const browser = await puppeteer.default.launch({
    executablePath: chromePath,
    headless: config.browserHeadless,
    ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain'],
    ...(options.freshSession ? {} : { userDataDir: profileDir }),
    protocolTimeout: 60_000,
    // In headed mode a forced device-metrics viewport paints the visible window
    // black on macOS; let the real window drive the size. Keep the fixed viewport
    // for headless (where there is no window and it renders correctly).
    defaultViewport: config.browserHeadless ? { width: 1280, height: 900 } : null,
    args: launchArgs,
  });

  const existingPages = await browser.pages();
  const startupPages = existingPages.filter((candidate: any) => {
    const url = typeof candidate.url === 'function' ? candidate.url() : '';
    return !url.startsWith('devtools://') && !url.startsWith('chrome-extension://');
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      get: () => undefined,
    });

    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => ['en-US', 'en'],
    });

    Object.defineProperty(navigator, 'plugins', {
      configurable: true,
      get: () => [
        { name: 'Chrome PDF Plugin' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Native Client' },
      ],
    });

    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get: () => 'MacIntel',
    });

    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        app: {},
        runtime: {},
      },
    });

    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = ((parameters: PermissionDescriptor) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters)) as typeof window.navigator.permissions.query;
  });
  // Derive the User-Agent from the actual Chrome binary so it matches the
  // sec-ch-ua client hints. A stale/mismatched UA (e.g. claiming Chrome 131 on a
  // Chrome 148 binary) is a strong automation signal and makes X serve a blank page.
  const browserVersion = await browser.version().catch(() => '');
  const chromeVersion = browserVersion.match(/\/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? '148.0.0.0';
  await page.setUserAgent(
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  );
  await page.bringToFront().catch(() => {});

  for (const startupPage of startupPages) {
    if (startupPage === page) continue;

    const url = typeof startupPage.url === 'function' ? startupPage.url() : '';
    if (url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') {
      await startupPage.close().catch(() => {});
    }
  }

  page.on('dialog', (dialog: any) => {
    void (async () => {
      const dialogType = typeof dialog.type === 'function' ? dialog.type() : '';

      try {
        if (shouldAutoAcceptDialog(dialogType)) {
          console.log(`Auto-accepting browser dialog (${dialogType}).`);
          await dialog.accept();
          return;
        }

        await dialog.dismiss();
      } catch {}
    })();
  });

  return { browser, page };
}

export async function safeGoto(page: any, url: string): Promise<void> {
  await recoverUnexpectedComposerState(page, url);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(3000);
      return;
    } catch {
      await recoverUnexpectedComposerState(page, url);
      await sleep(2000);
    }
  }

  await sleep(3000);
}

async function clearVisibleInput(page: any, input: any): Promise<void> {
  await humanClick(page, input);
  await randomSleep(150, 300);

  const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifierKey);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(modifierKey);
  await randomSleep(80, 160);
  await page.keyboard.press('Backspace');
  await randomSleep(120, 220);
}

async function openLatestSearchTab(page: any, query: string): Promise<void> {
  if (page.url().includes('f=live')) return;

  const liveTab = await findVisibleElement(page, X_SEARCH_LIVE_TAB_SELECTOR).catch((error: unknown) => {
    if (isDetachedDomError(error)) return null;
    throw error;
  });

  if (liveTab) {
    await humanClick(page, liveTab);
    await sleep(2500);
  }

  if (!page.url().includes('f=live')) {
    await safeGoto(page, buildSearchResultsUrl(query, true));
  }
}

export async function openSearchTimeline(page: any, query: string): Promise<void> {
  const normalizedQuery = query.trim().replace(/\s+/gu, ' ');
  if (!normalizedQuery) throw new Error('Search query must not be empty');

  await safeGoto(page, 'https://x.com/explore');
  await randomSleep(800, 1400);

  const input = await waitForVisibleElement(page, X_SEARCH_INPUT_SELECTOR, 15_000);
  await clearVisibleInput(page, input);
  await humanType(page, normalizedQuery);
  await randomSleep(250, 600);
  await page.keyboard.press('Enter');
  await sleep(3000);

  if (!page.url().includes('/search?')) {
    await safeGoto(page, buildSearchResultsUrl(normalizedQuery, false));
  }

  await openLatestSearchTab(page, normalizedQuery);
}

export async function ensureLoggedIn(page: any, config: AppConfig): Promise<string> {
  await safeGoto(page, 'https://x.com/home');

  let sessionState = await waitForXSessionState(page);
  if (sessionState === 'unknown') {
    console.log('Stored X session is still loading. Retrying before login flow...');
    await safeGoto(page, 'https://x.com/home');
    sessionState = await waitForXSessionState(page, 15_000);
  }

  if (sessionState === 'logged_in') {
    console.log('Reusing stored X session from the browser profile.');
    return assertBrowserAccount(page, config);
  }

  console.log('No valid stored X session detected. Starting login flow...');
  if (config.xLoginManual) {
    throw new ManualXLoginRequiredError(config.account.key, config.browserProfileDir);
  }
  await handleXLogin(page, config);
  await safeGoto(page, 'https://x.com/home');
  return assertBrowserAccount(page, config);
}

export async function seedBrowserProfileSession(config: AppConfig, timeoutMs = 600_000): Promise<void> {
  if (config.browserHeadless) {
    throw new Error(
      `Manual browser-profile seeding is unavailable in headless mode for ${config.account.key}. ` +
      'Use username/password login on the server, or seed the profile locally and copy it into the mounted volume first.',
    );
  }

  const profileDir = resolve(config.browserProfileDir);
  const loginUrl = 'https://x.com/';

  console.log(`\nOpening a normal Chrome window for ${config.account.key}...`);
  console.log(`Profile: ${profileDir}`);
  console.log('Log in to X in that window using the seeded profile. If X lands on a generic home page, click Sign in there instead of using a stuck /i/flow/login screen. After login succeeds, close that Chrome window.\n');

  const child = process.platform === 'darwin'
    ? spawn(
        'open',
        [
          '-n',
          '-a',
          'Google Chrome',
          '--args',
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          loginUrl,
        ],
        { stdio: 'ignore' },
      )
    : spawn(
        findChrome(),
        [
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          loginUrl,
        ],
        { stdio: 'ignore' },
      );

  await new Promise<void>((resolvePromise, reject) => {
    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Manual Chrome login window exited with code ${code}.`));
        return;
      }

      resolvePromise();
    });
  });

  const startedAt = Date.now();
  let reportedAuthCookies = false;
  let sawProfileChrome = false;

  while (Date.now() - startedAt < timeoutMs) {
    const profileChromeRunning = await hasChromeProcessForProfile(profileDir);
    if (profileChromeRunning) {
      sawProfileChrome = true;
    }

    if (profileHasXAuthCookies(profileDir)) {
      if (!reportedAuthCookies) {
        console.log('Detected X auth cookies in the seeded browser profile.');
        console.log('Closing any remaining Chrome processes for that seeded profile so the automation can continue.\n');
        reportedAuthCookies = true;
      }

      await terminateChromeProcessesForProfile(profileDir);
      if (!(await hasChromeProcessForProfile(profileDir))) {
        await sleep(1_500);
        return;
      }
    }

    if (sawProfileChrome && !profileChromeRunning) {
      console.log('The seeded Chrome profile window has closed. Continuing to verify the saved X session.\n');
      await sleep(1_500);
      return;
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for manual Chrome login after ${Math.round(timeoutMs / 60_000)} minutes.`);
}

export async function checkXLoggedIn(page: any): Promise<boolean> {
  return (await waitForXSessionState(page)) === 'logged_in';
}

export async function findReplyArea(page: any): Promise<any> {
  const selectors = [
    'div[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
    'div[data-testid="tweetTextarea_0"]',
  ];

  for (const selector of selectors) {
    const el = await page.$(selector);
    if (el) return el;
  }

  const replyIcon = await page.$('[data-testid="reply"]');
  if (replyIcon) {
    await humanClick(page, replyIcon);
    await randomSleep(800, 1500);
    for (const selector of selectors) {
      const el = await page.$(selector);
      if (el) return el;
    }
  }

  return null;
}

export async function openReplyComposerForTweet(
  page: any,
  tweetUrl: string,
): Promise<ReplyComposerMode> {
  const existingComposer = await waitForReplyComposerReady(page, 750, tweetUrl);
  if (existingComposer === 'dialog') return existingComposer;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const tweetArticle = await findTweetArticle(page, tweetUrl);
    if (!tweetArticle) {
      throw new Error(`Target tweet article not found for ${tweetUrl}`);
    }

    const replyButton = await tweetArticle.$('[data-testid="reply"]');
    if (!replyButton) {
      throw new Error(`Reply button not found on target tweet ${tweetUrl}`);
    }

    await replyButton
      .evaluate((el: Element) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      })
      .catch(() => {});

    try {
      await humanClick(page, replyButton);
    } catch (error: unknown) {
      if (!isDetachedDomError(error)) throw error;
    }

    const dialogComposer = await waitForSpecificReplyComposerMode(page, tweetUrl, 'dialog', 1_500);
    if (dialogComposer) return dialogComposer;

    const composerOpened = await waitForReplyComposerReady(page, 3_000, tweetUrl);
    if (composerOpened) return composerOpened;

    await replyButton
      .click()
      .catch((error: unknown) => {
        if (!isDetachedDomError(error)) throw error;
      });

    const fallbackDialogComposer = await waitForSpecificReplyComposerMode(page, tweetUrl, 'dialog', 2_000);
    if (fallbackDialogComposer) return fallbackDialogComposer;

    const fallbackComposer = await waitForReplyComposerReady(page, 4_000, tweetUrl);
    if (fallbackComposer) return fallbackComposer;

    await randomSleep(500, 1_200);
  }

  const composer = await waitForReplyComposerReady(page, 2_000, tweetUrl);
  if (!composer) throw new Error(`Reply composer did not become ready for ${tweetUrl}`);
  return composer;
}

export async function getReplyComposerControls(
  page: any,
  tweetUrl?: string,
  preferredMode?: ReplyComposerMode,
): Promise<{ mode: ReplyComposerMode; replyArea: any; submitButton: any }> {
  let mode = preferredMode ?? (tweetUrl ? await getReplyComposerMode(page, tweetUrl) : null);

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!mode) {
      throw new Error(
        tweetUrl
          ? `Reply composer not ready for ${tweetUrl}.`
          : 'Reply composer is not open on the current page.',
      );
    }

    try {
      if (mode === 'inline') {
        if (tweetUrl) {
          await assertInlineReplyComposerTargetsTweet(page, tweetUrl);
        }

        const replyArea = await findReplyAreaByScope(page, 'inline');
        if (!replyArea) {
          throw new Error('Inline reply text area not found on the target tweet page.');
        }

        const submitButton = await findReplySubmitButtonByScope(page, 'inline');
        if (!submitButton) {
          throw new Error('Inline reply submit button not found on the target tweet page.');
        }

        return { mode, replyArea, submitButton };
      }

      if (tweetUrl) {
        await assertDialogReplyComposerTargetsTweet(page, tweetUrl);
      }

      const replyArea =
        (await page.$(DIALOG_REPLY_TEXTAREA_EDITABLE_SELECTOR)) ??
        (await page.$(DIALOG_REPLY_TEXTAREA_FALLBACK_SELECTOR));
      if (!replyArea) {
        throw new Error('Reply text area not found inside reply dialog.');
      }

      const submitButton = await page.$(DIALOG_REPLY_SUBMIT_SELECTOR);
      if (!submitButton) {
        throw new Error('Reply submit button not found inside reply dialog.');
      }

      return { mode, replyArea, submitButton };
    } catch (error: unknown) {
      if (attempt === 2 || !tweetUrl || !preferredMode) {
        throw error;
      }

      const fallbackMode = await getReplyComposerMode(page, tweetUrl);
      if (!fallbackMode || fallbackMode === mode) {
        throw error;
      }

      mode = fallbackMode;
    }
  }

  throw new Error(
    tweetUrl
      ? `Reply composer not ready for ${tweetUrl}.`
      : 'Reply composer is not open on the current page.',
  );
}

export async function isReplyComposerOpen(page: any, tweetUrl?: string): Promise<boolean> {
  if (tweetUrl) {
    return Boolean(await getReplyComposerMode(page, tweetUrl));
  }

  return Boolean(
    (await page.$(REPLY_DIALOG_SELECTOR)) ??
    (await findReplyAreaByScope(page, 'inline')),
  );
}

async function isReplyComposerReady(page: any, tweetUrl?: string): Promise<boolean> {
  if (!tweetUrl) {
    return Boolean(
      (await page.$(REPLY_DIALOG_SELECTOR)) ??
      (await findReplyAreaByScope(page, 'inline')),
    );
  }

  return Boolean(await getReplyComposerMode(page, tweetUrl));
}

async function waitForReplyComposerReady(
  page: any,
  timeoutMs: number,
  tweetUrl?: string,
): Promise<ReplyComposerMode | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (tweetUrl) {
      const mode = await getReplyComposerMode(page, tweetUrl);
      if (mode) return mode;
    } else if (await isReplyComposerReady(page)) {
      return 'dialog';
    }

    await sleep(200);
  }

  return null;
}

async function waitForSpecificReplyComposerMode(
  page: any,
  tweetUrl: string,
  expectedMode: ReplyComposerMode,
  timeoutMs: number,
): Promise<ReplyComposerMode | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const mode = await getReplyComposerMode(page, tweetUrl);
    if (mode === expectedMode) return mode;
    await sleep(200);
  }

  return null;
}

export async function getReplyComposerDraftText(page: any, tweetUrl?: string): Promise<string> {
  try {
    const { replyArea } = await getReplyComposerControls(page, tweetUrl);
    return await replyArea
      .evaluate((el: Element) => el.textContent ?? '')
      .catch((error: unknown) => {
        if (isDetachedDomError(error)) return '';
        throw error;
      });
  } catch {
    return '';
  }
}

export async function clickReplyComposerControl(
  page: any,
  controlName: 'replyArea' | 'submitButton',
  tweetUrl?: string,
  preferredMode?: ReplyComposerMode,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controls = await getReplyComposerControls(page, tweetUrl, preferredMode);
    const control = controls[controlName];

    try {
      await humanClick(page, control);
      return;
    } catch (error: unknown) {
      if (!isDetachedDomError(error) || attempt === 2) throw error;
      await randomSleep(200, 500);
    }
  }
}

export async function handleXLogin(page: any, config: AppConfig): Promise<void> {
  const loginUser = config.xLoginUser;
  const loginPass = config.xLoginPass;
  const initialLoginIdentifiers = [...new Set([config.xLoginIdentifier, loginUser].filter(Boolean))] as string[];

  if (!loginUser || !loginPass) {
    console.log(`\nX login required for persona "${config.account.key}". Please log in in the browser window.`);
    console.log(
      `(Set X_USER_${config.account.envKey} and X_PASS_${config.account.envKey} in .env for automatic login)`,
    );
    console.log('Waiting up to 10 minutes...\n');
    await waitForLoginComplete(page);
    return;
  }

  console.log('Logging in to X automatically...');

  const url = page.url();
  if (!url.includes('/login') && !url.includes('/i/flow')) {
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    });
    await sleep(2000);
  }

  console.log('Entering username...');
  let usernameStepResolved = false;
  const usernameSubmitStrategies: XLoginSubmitStrategy[] = ['button', 'enter', 'tab_enter'];

  for (const [index, identifier] of initialLoginIdentifiers.entries()) {
    console.log(`Trying initial login identifier ${index + 1}/${initialLoginIdentifiers.length}...`);
    for (const strategy of usernameSubmitStrategies) {
      await fillLoginInput(page, X_LOGIN_USERNAME_SELECTOR, identifier);
      await logVisibleInputValue(page, X_LOGIN_USERNAME_SELECTOR, `Username step before submit (${strategy})`);
      await randomSleep(900, 1500);

      await submitXLoginStep(page, 'Next', strategy);
      await randomSleep(1500, 2500);
      await logVisibleInputValue(page, X_LOGIN_USERNAME_SELECTOR, `Username step after submit (${strategy})`);

      if (!(await isUsernameStepActive(page))) {
        usernameStepResolved = true;
        break;
      }

      console.log(`Username step still active after ${strategy} submit.`);
    }

    if (usernameStepResolved) break;
    console.log(`Initial login identifier rejected: ${identifier}`);
  }

  if (!usernameStepResolved && await isUsernameStepActive(page)) {
    console.log('\nX rejected the automatic first-step login identifiers.');
    console.log('Complete the first login step manually in the browser. Waiting for password or completed login...\n');
    const progress = await waitForXLoginFlowStepOrCompletion(page, 600_000);

    if (progress === 'logged_in') {
      console.log('Login completed after manual first-step entry.');
      return;
    }
  }

  let loginStep = await waitForXLoginFlowStep(page, 20_000);

  if (loginStep === 'verification') {
    const verificationValue = resolveXLoginVerificationValue(config);

    if (!verificationValue) {
      console.log('\nX is asking for additional verification. Please complete it in the browser.');
      console.log(
        `(Optional: set X_LOGIN_IDENTIFIER_${config.account.envKey}, X_IDENTIFIER_${config.account.envKey}, or X_EMAIL_${config.account.envKey} in .env for automatic verification)`,
      );
      console.log('Waiting for password step...\n');
      await page.waitForSelector(X_LOGIN_PASSWORD_SELECTOR, { timeout: 600_000 });
      await sleep(500);
    } else {
      console.log('X requested additional verification. Entering identifier...');
      await fillLoginInput(page, X_LOGIN_VERIFICATION_SELECTOR, verificationValue);

      const verificationNextButton = await findButtonByText(page, 'Next');
      if (verificationNextButton) {
        await humanClick(page, verificationNextButton);
      } else {
        await page.keyboard.press('Enter');
      }

      await randomSleep(1500, 2500);
      loginStep = await waitForXLoginFlowStep(page, 30_000);
    }
  }

  if (loginStep === 'unknown') {
    const diagnostics = await captureXLoginDiagnostics(page);
    console.log('\nX showed an alternate login challenge after the username step.');
    console.log(`Login challenge snapshot: ${diagnostics}`);
    console.log('Complete the challenge in the browser if needed. Waiting for password or completed login...\n');

    loginStep = await waitForXLoginFlowStepOrCompletion(page, 600_000);

    if (loginStep === 'logged_in') {
      console.log('Login completed after alternate challenge.');
      return;
    }
  }

  if (loginStep !== 'password') {
    throw new Error('X login did not reach the password step after entering the username.');
  }

  console.log('Entering password...');
  await fillLoginInput(page, X_LOGIN_PASSWORD_SELECTOR, loginPass);

  const loginButton =
    (await page.$('button[data-testid="LoginForm_Login_Button"]')) ??
    (await findButtonByText(page, 'Log in'));
  if (loginButton) await humanClick(page, loginButton);
  await randomSleep(2500, 4000);

  const stillOnLogin = await page.evaluate(
    () =>
      window.location.href.includes('/login') ||
      window.location.href.includes('/i/flow'),
  );

  if (stillOnLogin) {
    console.log('\nLogin may require 2FA or extra verification. Complete it in the browser.');
    await waitForLoginComplete(page);
    return;
  }

  console.log('Login successful.');
}

export async function postReplyViaBrowser(
  tweet: TweetRecord,
  replyText: string,
  config: AppConfig,
): Promise<void> {
  assertTweetEngagementAllowed(tweet, 'reply');

  const { browser, page } = await launchBrowser(config);
  const tweetUrl = buildTweetUrl(tweet);

  console.log('\nLaunching browser...');

  try {
    console.log(`Opening ${tweetUrl}`);
    await safeGoto(page, tweetUrl);

    const isLoggedIn = await checkXLoggedIn(page);

    if (!isLoggedIn) {
      await handleXLogin(page, config);
      console.log('Navigating back to tweet...');
      await safeGoto(page, tweetUrl);
    }

    await assertBrowserAccount(page, config);

    console.log('Opening reply composer...');
    const composerMode = await openReplyComposerForTweet(page, tweetUrl);
    console.log(composerMode === 'inline' ? 'Using inline reply composer.' : 'Using reply dialog fallback.');
    await clickReplyComposerControl(page, 'replyArea', tweetUrl, composerMode);
    await randomSleep(300, 600);

    console.log('Typing reply...');
    await humanType(page, replyText);
    await randomSleep(500, 1200);

    console.log('Submitting reply...');
    await clickReplyComposerControl(page, 'submitButton', tweetUrl, composerMode);
    await randomSleep(2500, 4000);

    const toastText = await page.evaluate(() => {
      const toast = document.querySelector('[data-testid="toast"]');
      return toast?.textContent ?? null;
    });

    if (toastText && /error|failed|couldn't/i.test(toastText)) {
      throw new Error(`X showed an error after posting: ${toastText}`);
    }

    const composerStillOpen = await isReplyComposerOpen(page, tweetUrl);
    if (composerStillOpen) {
      const remainingText = await getReplyComposerDraftText(page, tweetUrl);
      if (remainingText.trim().length > 0) {
        throw new Error('Reply dialog remained open with draft text after submission');
      }
    }

    console.log('\nReply posted successfully via browser.');
  } finally {
    await browser.close();
  }
}

export async function humanType(page: any, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    await page.keyboard.type(char);

    const isSpace = char === ' ';
    const isPunctuation = /[.,!?;:]/.test(char);

    if (isPunctuation) {
      await randomSleep(120, 280);
    } else if (isSpace) {
      await randomSleep(60, 160);
    } else {
      await randomSleep(35, 110);
    }

    if (isSpace && Math.random() < 0.15) {
      await randomSleep(300, 700);
    }
  }
}

export async function humanClick(page: any, element: any): Promise<void> {
  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  await humanMove(page, targetX, targetY);
  await randomSleep(50, 150);
  await page.mouse.click(targetX, targetY);
  await randomSleep(100, 300);
}

export async function humanMove(page: any, toX: number, toY: number): Promise<void> {
  const steps = rand(8, 18);
  const startX = toX + (Math.random() > 0.5 ? 1 : -1) * rand(40, 200);
  const startY = toY + (Math.random() > 0.5 ? 1 : -1) * rand(40, 200);

  const cpX = (startX + toX) / 2 + (Math.random() - 0.5) * 80;
  const cpY = (startY + toY) / 2 + (Math.random() - 0.5) * 80;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const x = (1 - ease) * (1 - ease) * startX + 2 * (1 - ease) * ease * cpX + ease * ease * toX;
    const y = (1 - ease) * (1 - ease) * startY + 2 * (1 - ease) * ease * cpY + ease * ease * toY;
    await page.mouse.move(x, y);
    await sleep(rand(5, 20));
  }
}

async function waitForLoginComplete(page: any): Promise<void> {
  await page.waitForFunction(
    () =>
      !window.location.href.includes('/login') &&
      !window.location.href.includes('/i/flow/login'),
    { timeout: 600_000, polling: 1000 },
  );
  await sleep(2000);
}

async function fillLoginInput(page: any, selector: string, value: string): Promise<void> {
  const input = await waitForVisibleElement(page, selector, 15_000);
  await humanClick(page, input);
  await randomSleep(150, 300);

  const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifierKey);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(modifierKey);
  await randomSleep(80, 160);
  await page.keyboard.press('Backspace');
  await randomSleep(120, 220);

  await input
    .type(value, { delay: rand(35, 85) })
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return;
      throw error;
    });
  await randomSleep(300, 600);

  const currentValue = await input
    .evaluate((el: Element) => (el as HTMLInputElement).value ?? '')
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return '';
      throw error;
    });

  if (currentValue !== value) {
    await input
      .evaluate(
        (el: Element, nextValue: string) => {
          const input = el as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          input.focus();
          if (setter) {
            setter.call(input, nextValue);
          } else {
            input.value = nextValue;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        value,
      )
      .catch((error: unknown) => {
        if (isDetachedDomError(error)) return;
        throw error;
      });
    await randomSleep(200, 400);
  }

  const finalValue = await input
    .evaluate((el: Element) => (el as HTMLInputElement).value ?? '')
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return '';
      throw error;
    });
  console.log(`Filled login input ${selector} with ${finalValue.length} characters.`);
}

async function waitForXLoginFlowStep(page: any, timeoutMs: number): Promise<XLoginFlowStep> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [passwordInput, verificationInput] = await Promise.all([
      findVisibleElement(page, X_LOGIN_PASSWORD_SELECTOR).catch((error: unknown) => {
        if (isDetachedDomError(error)) return null;
        throw error;
      }),
      findVisibleElement(page, X_LOGIN_VERIFICATION_SELECTOR).catch((error: unknown) => {
        if (isDetachedDomError(error)) return null;
        throw error;
      }),
    ]);
    const step = inferXLoginFlowStep({
      hasPasswordInput: Boolean(passwordInput),
      hasVerificationInput: Boolean(verificationInput),
    });

    if (step !== 'unknown') return step;
    await sleep(250);
  }

  return 'unknown';
}

async function isUsernameStepActive(page: any): Promise<boolean> {
  const [usernameInput, passwordInput, verificationInput] = await Promise.all([
    findVisibleElement(page, X_LOGIN_USERNAME_SELECTOR).catch((error: unknown) => {
      if (isDetachedDomError(error)) return null;
      throw error;
    }),
    findVisibleElement(page, X_LOGIN_PASSWORD_SELECTOR).catch((error: unknown) => {
      if (isDetachedDomError(error)) return null;
      throw error;
    }),
    findVisibleElement(page, X_LOGIN_VERIFICATION_SELECTOR).catch((error: unknown) => {
      if (isDetachedDomError(error)) return null;
      throw error;
    }),
  ]);

  return Boolean(usernameInput) && !passwordInput && !verificationInput;
}

async function waitForXLoginFlowStepOrCompletion(page: any, timeoutMs: number): Promise<XLoginFlowProgress> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const sessionState = await waitForXSessionState(page, 1_000);
    if (sessionState === 'logged_in') {
      return 'logged_in';
    }

    const step = await waitForXLoginFlowStep(page, 1_000);
    if (step !== 'unknown') return step;
    await sleep(250);
  }

  return 'unknown';
}

async function captureXLoginDiagnostics(page: any): Promise<string> {
  const snapshot = await page
    .evaluate(() => {
      const visibleInputs = Array.from(document.querySelectorAll('input'))
        .map((input) => {
          const element = input as HTMLInputElement;
          const style = window.getComputedStyle(element);
          const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0;

          return {
            autocomplete: element.getAttribute('autocomplete') ?? '',
            name: element.getAttribute('name') ?? '',
            placeholder: element.getAttribute('placeholder') ?? '',
            testid: element.getAttribute('data-testid') ?? '',
            type: element.getAttribute('type') ?? '',
            valuePreview:
              element.value.length > 24 ? `${element.value.slice(0, 24)}...` : element.value,
            visible,
          };
        })
        .filter((input) => input.visible)
        .slice(0, 6);

      const buttonTexts = Array.from(document.querySelectorAll('button'))
        .map((button) => button.textContent?.trim() ?? '')
        .filter(Boolean)
        .slice(0, 6);

      const pageText = Array.from(document.querySelectorAll('h1, h2, span, div'))
        .map((element) => element.textContent?.trim() ?? '')
        .filter(Boolean)
        .filter((text) => text.length >= 8 && text.length <= 160)
        .slice(0, 20);

      return {
        buttonTexts,
        pageText,
        inputSummary: visibleInputs.map((input) =>
          [
            input.type || 'text',
            input.name,
            input.autocomplete,
            input.testid,
            input.placeholder,
            input.valuePreview ? `value=${input.valuePreview}` : '',
          ]
            .filter(Boolean)
            .join(':'),
        ),
        url: window.location.href,
      };
    })
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) {
        return {
          buttonTexts: [] as string[],
          inputSummary: [] as string[],
          url: page.url(),
        };
      }

      throw error;
    });

  return JSON.stringify(snapshot);
}

async function findButtonByText(page: any, text: string): Promise<any> {
  const buttons = await page.$$('button[role="button"]');
  for (const button of buttons) {
    if (!(await isElementVisible(button))) continue;

    const isDisabled = await button
      .evaluate((el: Element) => {
        const htmlButton = el as HTMLButtonElement;
        return Boolean(htmlButton.disabled || el.getAttribute('aria-disabled') === 'true');
      })
      .catch((error: unknown) => {
        if (isDetachedDomError(error)) return true;
        throw error;
      });
    if (isDisabled) continue;

    const content = await button
      .evaluate((el: Element) => el.textContent?.trim())
      .catch((error: unknown) => {
        if (isDetachedDomError(error)) return null;
        throw error;
      });
    if (content === text) return button;
  }
  return null;
}

async function submitXLoginStep(
  page: any,
  buttonText: string,
  strategy: XLoginSubmitStrategy = 'button',
): Promise<void> {
  if (strategy === 'enter') {
    await page.keyboard.press('Enter');
    return;
  }

  if (strategy === 'tab_enter') {
    await page.keyboard.press('Tab');
    await randomSleep(120, 220);
    await page.keyboard.press('Enter');
    return;
  }

  const button = await findButtonByText(page, buttonText);
  if (!button) {
    await page.keyboard.press('Enter');
    return;
  }

  await button
    .evaluate((el: Element) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      (el as HTMLElement).click();
    })
    .catch(async (error: unknown) => {
      if (isDetachedDomError(error)) return;
      throw error;
    });
}

async function logVisibleInputValue(page: any, selector: string, label: string): Promise<void> {
  const input = await findVisibleElement(page, selector).catch((error: unknown) => {
    if (isDetachedDomError(error)) return null;
    throw error;
  });

  if (!input) {
    console.log(`${label}: no visible input`);
    return;
  }

  const value = await input
    .evaluate((el: Element) => (el as HTMLInputElement).value ?? '')
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return '';
      throw error;
    });
  console.log(`${label}: visible input has ${value.length} characters.`);
}

async function findVisibleElement(page: any, selector: string): Promise<any | null> {
  const matches = await page.$$(selector);

  for (const match of matches) {
    if (await isElementVisible(match)) return match;
  }

  return null;
}

async function waitForVisibleElement(page: any, selector: string, timeoutMs: number): Promise<any> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const match = await findVisibleElement(page, selector).catch((error: unknown) => {
      if (isDetachedDomError(error)) return null;
      throw error;
    });

    if (match) return match;
    await sleep(250);
  }

  throw new Error(`Waiting for visible selector \`${selector}\` failed`);
}

function profileHasXAuthCookies(profileDir: string): boolean {
  const cookiesPath = resolve(profileDir, 'Default/Cookies');
  if (!existsSync(cookiesPath)) return false;

  try {
    const output = spawnSyncText(
      'sqlite3',
      [cookiesPath, "select name from cookies where (host_key like '%x.com%' or host_key like '%twitter.com%') and name in ('auth_token','twid') order by name;"],
    );
    return output.includes('auth_token') || output.includes('twid');
  } catch {
    return false;
  }
}

async function hasChromeProcessForProfile(profileDir: string): Promise<boolean> {
  try {
    return getChromePidsForProfile(profileDir).length > 0;
  } catch {
    return false;
  }
}

async function terminateChromeProcessesForProfile(profileDir: string): Promise<void> {
  const pids = getChromePidsForProfile(profileDir);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (getChromePidsForProfile(profileDir).length === 0) return;
    await sleep(250);
  }

  for (const pid of getChromePidsForProfile(profileDir)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function getChromePidsForProfile(profileDir: string): number[] {
  const output = spawnSyncText('ps', ['-axo', 'pid,command']);
  const needle = `--user-data-dir=${profileDir}`;

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .map((line) => Number.parseInt(line.split(/\s+/u, 1)[0] ?? '', 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function spawnSyncText(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.error) throw result.error;
  if (typeof result.stdout !== 'string') return '';
  return result.stdout;
}

async function findTweetArticle(page: any, tweetUrl: string): Promise<any> {
  const statusPath = getStatusPath(tweetUrl);
  const articles = await page.$$('article[data-testid="tweet"]');

  for (const article of articles) {
    const matchingLink =
      (await article.$(`a[href="${statusPath}"]`)) ??
      (await article.$(`a[href*="${statusPath}"]`));
    if (matchingLink) {
      return article;
    }
  }

  return null;
}

function getStatusPath(tweetUrl: string): string {
  return new URL(tweetUrl).pathname;
}

function isLoginUrl(url: string): boolean {
  return url.includes('/login') || url.includes('/i/flow');
}

export function inferXSessionState(signals: {
  hasAccountSwitcher: boolean;
  hasAuthTokenCookie: boolean;
  hasPasswordInput: boolean;
  hasPrimaryColumn: boolean;
  hasReplyBox: boolean;
  hasTwidCookie: boolean;
  hasUsernameInput: boolean;
  url: string;
}): XSessionState {
  if (isLoginUrl(signals.url) || signals.hasUsernameInput || signals.hasPasswordInput) {
    return 'logged_out';
  }

  if (signals.hasReplyBox || signals.hasAccountSwitcher) {
    return 'logged_in';
  }

  if (signals.hasPrimaryColumn && (signals.hasAuthTokenCookie || signals.hasTwidCookie)) {
    return 'logged_in';
  }

  return 'unknown';
}

function getPathFromHref(href: string): string | null {
  try {
    return new URL(href, 'https://x.com').pathname;
  } catch {
    return null;
  }
}

export function replyComposerContainsTargetTweet(tweetUrl: string, hrefs: string[]): boolean {
  const statusPath = getStatusPath(tweetUrl);

  return hrefs.some((href) => getPathFromHref(href) === statusPath);
}

export function inferReplyComposerMode(signals: {
  dialogLinkHrefs: string[];
  hasDialogReplyArea: boolean;
  hasInlineReplyArea: boolean;
  hasTargetTweetArticle: boolean;
  pageUrl: string;
  targetTweetUrl: string;
}): ReplyComposerMode | null {
  if (
    signals.hasInlineReplyArea &&
    getStatusPath(signals.pageUrl) === getStatusPath(signals.targetTweetUrl)
  ) {
    return 'inline';
  }

  if (
    signals.hasDialogReplyArea &&
    replyComposerContainsTargetTweet(signals.targetTweetUrl, signals.dialogLinkHrefs)
  ) {
    return 'dialog';
  }

  return null;
}

async function getReplyComposerMode(page: any, tweetUrl: string): Promise<ReplyComposerMode | null> {
  return inferReplyComposerMode(await collectReplyComposerSignals(page, tweetUrl));
}

async function getReplyDialogLinkHrefs(page: any): Promise<string[]> {
  return page
    .$$eval(`${REPLY_DIALOG_SELECTOR} a[href]`, (links: Element[]) =>
      links
        .map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? '')
        .filter(Boolean),
    )
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return [];
      throw error;
    });
}

async function assertDialogReplyComposerTargetsTweet(page: any, tweetUrl: string): Promise<void> {
  const hrefs = await getReplyDialogLinkHrefs(page);

  if (replyComposerContainsTargetTweet(tweetUrl, hrefs)) {
    return;
  }

  throw new Error(
    `Safety stop: reply composer is not visibly attached to ${tweetUrl}. Refusing to submit because this may create an original post.`,
  );
}

async function assertInlineReplyComposerTargetsTweet(page: any, tweetUrl: string): Promise<void> {
  const currentPageUrl = page.url();
  if (getStatusPath(currentPageUrl) !== getStatusPath(tweetUrl)) {
    throw new Error(
      `Safety stop: inline reply box is not on the target tweet page ${tweetUrl}. Refusing to submit because this may create an original post.`,
    );
  }

  const inlineReplyArea = await findReplyAreaByScope(page, 'inline');
  if (!inlineReplyArea) {
    throw new Error(
      `Safety stop: inline reply box could not be found on the target tweet page ${tweetUrl}.`,
    );
  }
}

async function collectReplyComposerSignals(page: any, tweetUrl: string): Promise<{
  dialogLinkHrefs: string[];
  hasDialogReplyArea: boolean;
  hasInlineReplyArea: boolean;
  hasTargetTweetArticle: boolean;
  pageUrl: string;
  targetTweetUrl: string;
}> {
  const dialogReplyArea =
    (await page.$(DIALOG_REPLY_TEXTAREA_EDITABLE_SELECTOR)) ??
    (await page.$(DIALOG_REPLY_TEXTAREA_FALLBACK_SELECTOR));
  const inlineReplyArea = await findReplyAreaByScope(page, 'inline');

  return {
    dialogLinkHrefs: await getReplyDialogLinkHrefs(page),
    hasDialogReplyArea: Boolean(dialogReplyArea),
    hasInlineReplyArea: Boolean(inlineReplyArea),
    hasTargetTweetArticle: Boolean(await findTweetArticle(page, tweetUrl)),
    pageUrl: page.url(),
    targetTweetUrl: tweetUrl,
  };
}

async function findReplyAreaByScope(page: any, scope: ReplyComposerMode): Promise<any> {
  for (const selector of [REPLY_TEXTAREA_EDITABLE_SELECTOR, REPLY_TEXTAREA_SELECTOR]) {
    const matches = await page.$$(selector);

    for (const match of matches) {
      if (!(await isElementInReplyComposerScope(match, scope))) continue;
      if (!(await isElementVisible(match))) continue;
      return match;
    }
  }

  return null;
}

async function findReplySubmitButtonByScope(page: any, scope: ReplyComposerMode): Promise<any> {
  if (scope === 'dialog') {
    return page.$(DIALOG_REPLY_SUBMIT_SELECTOR);
  }

  const buttons = await page.$$(INLINE_REPLY_SUBMIT_SELECTOR);

  for (const button of buttons) {
    if (!(await isElementInReplyComposerScope(button, 'inline'))) continue;
    if (!(await isElementVisible(button))) continue;
    if (!(await looksLikeReplySubmitButton(button))) continue;
    return button;
  }

  return null;
}

async function isElementInReplyComposerScope(element: any, scope: ReplyComposerMode): Promise<boolean> {
  return element
    .evaluate(
      (el: Element, dialogSelector: string, currentScope: ReplyComposerMode) =>
        currentScope === 'dialog'
          ? Boolean(el.closest(dialogSelector))
          : !el.closest(dialogSelector),
      REPLY_DIALOG_SELECTOR,
      scope,
    )
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return false;
      throw error;
    });
}

async function isElementVisible(element: any): Promise<boolean> {
  try {
    const box = await element.boundingBox();
    return Boolean(box && box.width > 0 && box.height > 0);
  } catch (error: unknown) {
    if (isDetachedDomError(error)) return false;
    throw error;
  }
}

async function looksLikeReplySubmitButton(button: any): Promise<boolean> {
  return button
    .evaluate((el: Element) => {
      const text = el.textContent ?? '';
      const ariaLabel = el.getAttribute('aria-label') ?? '';
      const title = el.getAttribute('title') ?? '';
      return /reply/i.test(`${text} ${ariaLabel} ${title}`);
    })
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return false;
      throw error;
    });
}

async function collectUnexpectedPostComposerSignals(page: any): Promise<{
  dialogLinkHrefs: string[];
  hasDialogReplyArea: boolean;
  hasDialogTweetButton: boolean;
  pageUrl: string;
}> {
  const dialogReplyArea =
    (await page.$(DIALOG_REPLY_TEXTAREA_EDITABLE_SELECTOR)) ??
    (await page.$(DIALOG_REPLY_TEXTAREA_FALLBACK_SELECTOR));

  return {
    dialogLinkHrefs: await getReplyDialogLinkHrefs(page),
    hasDialogReplyArea: Boolean(dialogReplyArea),
    hasDialogTweetButton: Boolean(await page.$(DIALOG_REPLY_SUBMIT_SELECTOR)),
    pageUrl: page.url(),
  };
}

async function closeUnexpectedComposer(page: any): Promise<boolean> {
  const selectors = [
    'button[data-testid="app-bar-close"]',
    '[role="dialog"] button[aria-label="Close"]',
    'button[aria-label="Close"]',
    '[role="button"][aria-label="Close"]',
  ];

  for (const selector of selectors) {
    const matches = await page.$$(selector);

    for (const match of matches) {
      if (!(await isElementVisible(match))) continue;

      try {
        await humanClick(page, match);
        return true;
      } catch (error: unknown) {
        if (!isDetachedDomError(error)) throw error;
      }
    }
  }

  return false;
}

export async function recoverUnexpectedComposerState(page: any, recoveryUrl = 'https://x.com/home'): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const signals = await collectUnexpectedPostComposerSignals(page);
    if (!inferUnexpectedPostComposerState(signals)) {
      return;
    }

    console.log('Recovering from unexpected post composer state...');

    const dismissed = await closeUnexpectedComposer(page);
    if (dismissed) {
      await randomSleep(400, 900);
      continue;
    }

    await page.keyboard.press('Escape').catch(() => {});
    await randomSleep(300, 700);

    const nextSignals = await collectUnexpectedPostComposerSignals(page);
    if (!inferUnexpectedPostComposerState(nextSignals)) {
      return;
    }

    try {
      await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {}

    await sleep(2000);
  }
}

async function waitForXSessionState(page: any, timeoutMs = X_SESSION_CHECK_TIMEOUT_MS): Promise<XSessionState> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = inferXSessionState(await collectXSessionSignals(page));
    if (state !== 'unknown') return state;
    await sleep(X_SESSION_CHECK_POLL_MS);
  }

  return inferXSessionState(await collectXSessionSignals(page));
}

async function collectXSessionSignals(page: any): Promise<{
  hasAccountSwitcher: boolean;
  hasAuthTokenCookie: boolean;
  hasPasswordInput: boolean;
  hasPrimaryColumn: boolean;
  hasReplyBox: boolean;
  hasTwidCookie: boolean;
  hasUsernameInput: boolean;
  url: string;
}> {
  const url = page.url();
  const [cookieNames, domSignals] = await Promise.all([
    page
      .cookies('https://x.com')
      .then((cookies: Array<{ name: string }>) => new Set(cookies.map((cookie) => cookie.name)))
      .catch(() => new Set<string>()),
    page
      .evaluate(() => ({
        hasAccountSwitcher: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'),
        hasPasswordInput: !!document.querySelector('input[name="password"]'),
        hasPrimaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
        hasReplyBox: !!document.querySelector('div[data-testid="tweetTextarea_0"]'),
        hasUsernameInput: !!document.querySelector('input[autocomplete="username"]'),
      }))
      .catch(() => ({
        hasAccountSwitcher: false,
        hasPasswordInput: false,
        hasPrimaryColumn: false,
        hasReplyBox: false,
        hasUsernameInput: false,
      })),
  ]);

  return {
    ...domSignals,
    hasAuthTokenCookie: cookieNames.has('auth_token'),
    hasTwidCookie: cookieNames.has('twid'),
    url,
  };
}

async function assertBrowserAccount(page: any, config: AppConfig): Promise<string> {
  const username = await getBrowserUsername(page);
  if (!username) {
    throw new Error(
      `Could not verify the logged-in browser account on X for persona "${config.account.key}".`,
    );
  }

  assertAccountMatchesSelection(config.xLoginUser, username, 'Browser session');
  return username;
}

async function getBrowserUsername(page: any): Promise<string | null> {
  const accountSwitcher = await page
    .waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15_000 })
    .catch(() => null);

  if (accountSwitcher) {
    const switcherText = await page
      .$eval('[data-testid="SideNav_AccountSwitcher_Button"]', (el: Element) => {
        const text = el.textContent ?? '';
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        return `${text}\n${ariaLabel}`;
      })
      .catch((error: unknown) => {
        if (isDetachedDomError(error)) return null;
        throw error;
      });
    if (switcherText) {
    const match = switcherText.match(/@([A-Za-z0-9_]+)/u);
    if (match) return normalizeUsername(match[1]);
    }
  }

  const profileLink = await page.$('a[data-testid="AppTabBar_Profile_Link"]');
  if (!profileLink) return null;

  const href = await page
    .$eval('a[data-testid="AppTabBar_Profile_Link"]', (el: Element) => (el as HTMLAnchorElement).href ?? '')
    .catch((error: unknown) => {
      if (isDetachedDomError(error)) return '';
      throw error;
    });
  try {
    const url = new URL(href);
    const username = url.pathname.split('/').filter(Boolean)[0];
    return username ? normalizeUsername(username) : null;
  } catch {
    return null;
  }
}
