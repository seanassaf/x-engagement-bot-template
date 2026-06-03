import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchResultsUrl, inferReplyComposerMode, inferUnexpectedPostComposerState, inferXLoginFlowStep, inferXSessionState, isComposePostUrl, replyComposerContainsTargetTweet, resolveXLoginVerificationValue, shouldAutoAcceptDialog } from '../../twitter-guerilla/lib/browser.ts';

test('replyComposerContainsTargetTweet matches the exact target status path', () => {
  assert.equal(
    replyComposerContainsTargetTweet('https://x.com/example/status/123', [
      '/example/status/123',
      '/example',
    ]),
    true,
  );

  assert.equal(
    replyComposerContainsTargetTweet('https://x.com/example/status/123', [
      'https://x.com/example/status/123?s=20',
    ]),
    true,
  );
});

test('replyComposerContainsTargetTweet rejects generic composers and wrong targets', () => {
  assert.equal(
    replyComposerContainsTargetTweet('https://x.com/example/status/123', []),
    false,
  );

  assert.equal(
    replyComposerContainsTargetTweet('https://x.com/example/status/123', [
      '/example/status/456',
      '/compose/post',
    ]),
    false,
  );
});

test('isComposePostUrl matches the dedicated compose route', () => {
  assert.equal(isComposePostUrl('https://x.com/compose/post'), true);
  assert.equal(isComposePostUrl('https://x.com/example/status/123'), false);
});

test('buildSearchResultsUrl preserves the exact query and defaults to latest tweets', () => {
  assert.equal(
    buildSearchResultsUrl('your query'),
    'https://x.com/search?q=your+query&src=typed_query&f=live',
  );
  assert.equal(
    buildSearchResultsUrl('your query', false),
    'https://x.com/search?q=your+query&src=typed_query',
  );
});

test('inferUnexpectedPostComposerState flags generic compose surfaces but not attached reply dialogs', () => {
  assert.equal(
    inferUnexpectedPostComposerState({
      dialogLinkHrefs: [],
      hasDialogReplyArea: false,
      hasDialogTweetButton: false,
      pageUrl: 'https://x.com/compose/post',
    }),
    true,
  );

  assert.equal(
    inferUnexpectedPostComposerState({
      dialogLinkHrefs: [],
      hasDialogReplyArea: true,
      hasDialogTweetButton: true,
      pageUrl: 'https://x.com/home',
    }),
    true,
  );

  assert.equal(
    inferUnexpectedPostComposerState({
      dialogLinkHrefs: ['/example/status/123'],
      hasDialogReplyArea: true,
      hasDialogTweetButton: true,
      pageUrl: 'https://x.com/home',
    }),
    false,
  );
});

test('shouldAutoAcceptDialog only accepts beforeunload prompts', () => {
  assert.equal(shouldAutoAcceptDialog('beforeunload'), true);
  assert.equal(shouldAutoAcceptDialog('confirm'), false);
});

test('inferReplyComposerMode prefers the inline composer on the exact tweet page', () => {
  assert.equal(
    inferReplyComposerMode({
      dialogLinkHrefs: [],
      hasDialogReplyArea: false,
      hasInlineReplyArea: true,
      hasTargetTweetArticle: false,
      pageUrl: 'https://x.com/example/status/123',
      targetTweetUrl: 'https://x.com/example/status/123',
    }),
    'inline',
  );
});

test('inferReplyComposerMode falls back to the dialog when the inline page composer is unavailable', () => {
  assert.equal(
    inferReplyComposerMode({
      dialogLinkHrefs: ['/example/status/123'],
      hasDialogReplyArea: true,
      hasInlineReplyArea: false,
      hasTargetTweetArticle: true,
      pageUrl: 'https://x.com/home',
      targetTweetUrl: 'https://x.com/example/status/123',
    }),
    'dialog',
  );
});

test('inferReplyComposerMode rejects unsafe reply contexts', () => {
  assert.equal(
    inferReplyComposerMode({
      dialogLinkHrefs: ['/example/status/999'],
      hasDialogReplyArea: true,
      hasInlineReplyArea: false,
      hasTargetTweetArticle: false,
      pageUrl: 'https://x.com/home',
      targetTweetUrl: 'https://x.com/example/status/123',
    }),
    null,
  );

  assert.equal(
    inferReplyComposerMode({
      dialogLinkHrefs: [],
      hasDialogReplyArea: false,
      hasInlineReplyArea: true,
      hasTargetTweetArticle: true,
      pageUrl: 'https://x.com/example/status/456',
      targetTweetUrl: 'https://x.com/example/status/123',
    }),
    null,
  );
});

test('inferXSessionState treats account-switcher sessions as logged in', () => {
  assert.equal(
    inferXSessionState({
      hasAccountSwitcher: true,
      hasAuthTokenCookie: false,
      hasPasswordInput: false,
      hasPrimaryColumn: false,
      hasReplyBox: false,
      hasTwidCookie: false,
      hasUsernameInput: false,
      url: 'https://x.com/home',
    }),
    'logged_in',
  );
});

test('inferXSessionState treats saved auth cookies on the home UI as logged in', () => {
  assert.equal(
    inferXSessionState({
      hasAccountSwitcher: false,
      hasAuthTokenCookie: true,
      hasPasswordInput: false,
      hasPrimaryColumn: true,
      hasReplyBox: false,
      hasTwidCookie: false,
      hasUsernameInput: false,
      url: 'https://x.com/home',
    }),
    'logged_in',
  );
});

test('inferXSessionState treats visible login forms as logged out', () => {
  assert.equal(
    inferXSessionState({
      hasAccountSwitcher: false,
      hasAuthTokenCookie: true,
      hasPasswordInput: false,
      hasPrimaryColumn: false,
      hasReplyBox: false,
      hasTwidCookie: true,
      hasUsernameInput: true,
      url: 'https://x.com/i/flow/login',
    }),
    'logged_out',
  );
});

test('inferXSessionState leaves ambiguous pages unknown instead of forcing relogin', () => {
  assert.equal(
    inferXSessionState({
      hasAccountSwitcher: false,
      hasAuthTokenCookie: true,
      hasPasswordInput: false,
      hasPrimaryColumn: false,
      hasReplyBox: false,
      hasTwidCookie: false,
      hasUsernameInput: false,
      url: 'https://x.com/home',
    }),
    'unknown',
  );
});

test('inferXLoginFlowStep detects verification before the password form arrives', () => {
  assert.equal(
    inferXLoginFlowStep({
      hasPasswordInput: false,
      hasVerificationInput: true,
    }),
    'verification',
  );
});

test('inferXLoginFlowStep prefers the password step when both selectors are visible', () => {
  assert.equal(
    inferXLoginFlowStep({
      hasPasswordInput: true,
      hasVerificationInput: true,
    }),
    'password',
  );
});

test('resolveXLoginVerificationValue falls back to the login username', () => {
  assert.equal(
    resolveXLoginVerificationValue({
      xLoginIdentifier: null,
      xLoginUser: 'myaccount',
    }),
    'myaccount',
  );
});

test('resolveXLoginVerificationValue prefers a dedicated verification identifier when configured', () => {
  assert.equal(
    resolveXLoginVerificationValue({
      xLoginIdentifier: 'myaccount-login@example.com',
      xLoginUser: 'myaccount',
    }),
    'myaccount-login@example.com',
  );
});
