import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSubmissionTiming, getSubmissionWindow, SUBMISSION_WINDOWS } from '../pacing/policy.js';
const start = '2026-09-25T00:00:00.000Z';
test('all four configured pacing windows have the expected bounds', () => {
  assert.deepEqual(SUBMISSION_WINDOWS.map((w) => [w.startMinute, w.endMinute]), [[10,25],[30,50],[55,80],[85,110]]);
  assert.equal(getSubmissionWindow(4).slot, 4);
  assert.throws(() => getSubmissionWindow(0), { code: 'INVALID_INPUT' });
});
test('before, inside, boundaries, and after window have deterministic timing', () => {
  const timing = (minute: number) => evaluateSubmissionTiming({ contestStartTime: start, slot: 1, now: Date.parse(start) + minute * 60_000 });
  assert.deepEqual(timing(5), { allowedNow: false, status: 'BEFORE_WINDOW', waitMilliseconds: 300000, windowStart: '2026-09-25T00:10:00.000Z', windowEnd: '2026-09-25T00:25:00.000Z' });
  for (const minute of [10, 20, 25]) { assert.equal(timing(minute).status, 'INSIDE_WINDOW'); assert.equal(timing(minute).allowedNow, true); }
  assert.equal(timing(26).status, 'AFTER_WINDOW'); assert.equal(timing(26).allowedNow, true); assert.equal(timing(26).waitMilliseconds, 0);
  assert.throws(() => evaluateSubmissionTiming({ contestStartTime: 'bad', slot: 1 }), { code: 'INVALID_INPUT' });
});
