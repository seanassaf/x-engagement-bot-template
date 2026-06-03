import test from 'node:test';
import assert from 'node:assert/strict';

import { isSensitiveTopic } from '../../twitter-guerilla/lib/sensitive-content.ts';

test('isSensitiveTopic flags politics, religion, geopolitics, and social hot-buttons', () => {
  assert.equal(isSensitiveTopic('the election results just dropped'), true);
  assert.equal(isSensitiveTopic('Official Statement Regarding the Israel Gaza ceasefire'), true);
  assert.equal(isSensitiveTopic('the public is ready for Jewish-Arab partnership'), true);
  assert.equal(isSensitiveTopic('Trump said something about crypto again'), true);
  assert.equal(isSensitiveTopic('this is straight up nazi behavior'), true);
  assert.equal(isSensitiveTopic('abortion rights are on the ballot'), true);
});

test('isSensitiveTopic does NOT false-positive on normal crypto/business words', () => {
  assert.equal(isSensitiveTopic('our workflow needs serious work'), false);
  assert.equal(isSensitiveTopic('i woke up and checked my phone'), false);
  assert.equal(isSensitiveTopic('running a conservative position size on this trade'), false);
  assert.equal(isSensitiveTopic("what's your occupation these days?"), false);
  assert.equal(isSensitiveTopic('new jewelry brand just launched on-chain'), false);
  assert.equal(isSensitiveTopic('best tool for a small team'), false);
});

test('isSensitiveTopic handles empty input', () => {
  assert.equal(isSensitiveTopic(''), false);
  assert.equal(isSensitiveTopic(null), false);
  assert.equal(isSensitiveTopic(undefined), false);
});
