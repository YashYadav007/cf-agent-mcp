import { CodeforcesError } from '../codeforces/errors.js';
import type { SubmissionWindow, TimingEvaluation } from './types.js';

export const SUBMISSION_WINDOWS: readonly Readonly<SubmissionWindow>[] = Object.freeze([
  { slot: 1, startMinute: 0, endMinute: 25 }, { slot: 2, startMinute: 25, endMinute: 50 },
  { slot: 3, startMinute: 50, endMinute: 80 }, { slot: 4, startMinute: 80, endMinute: 110 },
].map((window) => Object.freeze(window)));

export function getSubmissionWindow(slot: number): Readonly<SubmissionWindow> {
  const window = SUBMISSION_WINDOWS.find((entry) => entry.slot === slot);
  if (!window) throw new CodeforcesError('Slot must be an integer from 1 to 4.', 'INVALID_INPUT');
  return window;
}

/** Dates or ISO strings; numbers are epoch milliseconds, not Codeforces epoch seconds. */
export function evaluateSubmissionTiming({ contestStartTime, slot, now = new Date() }: {
  contestStartTime: Date | string | number; slot: number; now?: Date | string | number;
}): TimingEvaluation {
  const start = new Date(contestStartTime).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) throw new CodeforcesError('Invalid timing date.', 'INVALID_INPUT');
  const window = getSubmissionWindow(slot);
  const begin = start + window.startMinute * 60_000;
  const end = start + window.endMinute * 60_000;
  return {
    allowedNow: current >= begin, windowStart: new Date(begin).toISOString(), windowEnd: new Date(end).toISOString(),
    waitMilliseconds: Math.max(0, begin - current),
    status: current < begin ? 'BEFORE_WINDOW' : current <= end ? 'INSIDE_WINDOW' : 'AFTER_WINDOW',
  };
}
