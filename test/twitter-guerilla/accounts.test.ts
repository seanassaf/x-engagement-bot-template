import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAccountMatchesSelection, isKnownAccountInput, resolveAccount } from '../../twitter-guerilla/lib/accounts.ts';

test('resolveAccount accepts persona slug, handle, and profile URL', () => {
  assert.equal(resolveAccount().key, 'myaccount');
  assert.equal(resolveAccount('myaccount').envKey, 'MYACCOUNT');
  assert.equal(resolveAccount('https://x.com/myaccount').key, 'myaccount');
  assert.match(resolveAccount('myaccount').personaPath, /myaccount\.md$/u);
});

test('isKnownAccountInput rejects tweet URLs and unknown inputs', () => {
  assert.equal(isKnownAccountInput('https://x.com/myaccount/status/1234567890'), false);
  assert.equal(isKnownAccountInput('not-a-real-account'), false);
});

test('assertAccountMatchesSelection throws on username mismatch', () => {
  assert.throws(
    () => assertAccountMatchesSelection('myaccount', 'OtherHandle', 'Browser session'),
    /selected persona expects @myaccount/u,
  );
});

test('assertAccountMatchesSelection ignores non-handle login values', () => {
  assert.doesNotThrow(() => assertAccountMatchesSelection('user@example.com', 'ExampleUser', 'Browser session'));
});
