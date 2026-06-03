import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeLeadRows } from '../../twitter-guerilla/lib/lead-capture.ts';

test('dedupeLeadRows normalizes handles and keeps first follower value', () => {
  assert.deepEqual(
    dedupeLeadRows([
      { username_id: '@Example', followers: 1200 },
      { username_id: 'example', followers: 9999 },
      { username_id: 'SecondUser', followers: null },
      { username_id: '', followers: 1 },
    ]),
    [
      { username_id: 'example', followers: 1200 },
      { username_id: 'seconduser', followers: null },
    ],
  );
});
