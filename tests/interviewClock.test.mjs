import assert from 'node:assert/strict';
import test from 'node:test';
import { getInterviewClock } from '../src/interviewClock.ts';

const start = 1_000_000;

test('a ten-minute interview starts with its full time budget', () => {
  assert.deepEqual(getInterviewClock(start, 10, start), {
    remainingSeconds: 600, isClosing: false, isExpired: false,
  });
});

test('refreshing or returning to a sleeping tab uses the original deadline', () => {
  assert.equal(getInterviewClock(start, 10, start + 245_000).remainingSeconds, 355);
  assert.equal(getInterviewClock(start, 10, start + 599_500).remainingSeconds, 1);
});

test('early AI conclusions are outside the closing window', () => {
  assert.equal(getInterviewClock(start, 10, start + 120_000).isClosing, false);
  assert.equal(getInterviewClock(start, 10, start + 569_000).isClosing, false);
  assert.equal(getInterviewClock(start, 10, start + 570_000).isClosing, true);
});

test('short interviews reserve a smaller closing window', () => {
  assert.equal(getInterviewClock(start, 1, start + 30_000).isClosing, false);
  assert.equal(getInterviewClock(start, 1, start + 48_000).isClosing, true);
  assert.equal(getInterviewClock(start, 3, start + 150_000).isClosing, true);
});

test('the deadline expires exactly once in time and never becomes negative', () => {
  assert.deepEqual(getInterviewClock(start, 10, start + 600_000), {
    remainingSeconds: 0, isClosing: true, isExpired: true,
  });
  assert.equal(getInterviewClock(start, 10, start + 900_000).remainingSeconds, 0);
});
