import type { ExperimentRun, ProblemExecution } from './types.js';

export type WakeupReason = 'registration' | 'start' | 'problem' | 'manual_auth' | 'rating';
export interface PlannedWakeup { reason: WakeupReason; runAt: string }

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const at = (value: number): string => new Date(value).toISOString();
const after = (now: Date, milliseconds: number): string => at(now.getTime() + milliseconds);

/** Cloud Tasks accepts at most 30 days of lead time; re-evaluate well before that limit. */
function boundedStart(start: number, now: Date): string {
  return at(Math.min(start, now.getTime() + 29 * day));
}

export function registrationCheckInterval(startTime: string, now: Date): number {
  const remaining = Date.parse(startTime) - now.getTime();
  return remaining > 48 * hour ? 6 * hour : remaining >= 12 * hour ? hour : 15 * minute;
}

/** Pure, one-shot scheduling policy. No worker sleeps for a contest window. */
export function planNextWakeup(run: ExperimentRun, now: Date, problem?: ProblemExecution): PlannedWakeup | null {
  const start = Date.parse(run.contestStartAt);
  if (!Number.isFinite(start)) return null;
  if (['RATING_UPDATED', 'RATING_TIMEOUT', 'BLOCKED', 'FAILED'].includes(run.state)) return null;

  if (run.state === 'NEEDS_MANUAL_AUTH')
    return { reason: 'manual_auth', runAt: after(now, 15 * minute) };
  if (['DISCOVERED', 'WAITING_FOR_REGISTRATION', 'REGISTRATION_READY', 'REGISTERING',
    'REGISTRATION_RESULT_UNCERTAIN'].includes(run.state)) {
    if (start <= now.getTime()) return null;
    const interval = run.state === 'REGISTERING' || run.state === 'REGISTRATION_RESULT_UNCERTAIN' ?
      15 * minute : registrationCheckInterval(run.contestStartAt, now);
    return { reason: 'registration', runAt: at(Math.min(start, now.getTime() + interval)) };
  }
  if (run.state === 'REGISTERED')
    return { reason: 'start', runAt: after(now, 1000) }; // finish authorization before sleeping until start
  if (['AUTHORIZED', 'WAITING_FOR_START'].includes(run.state))
    return { reason: 'start', runAt: boundedStart(start, now) };
  if (run.state === 'CONTEST_COMPLETE')
    return { reason: 'rating', runAt: after(now, 1000) };
  if (run.state === 'WAITING_FOR_RATING') {
    const deadline = run.ratingDeadlineAt ? Date.parse(run.ratingDeadlineAt) : NaN;
    const interval = run.lastRatingCheckAt ? 3 * hour : hour;
    return { reason: 'rating', runAt: at(Number.isFinite(deadline) ?
      Math.min(deadline, now.getTime() + interval) : now.getTime() + interval) };
  }

  const ordinal = run.currentProblemOrdinal;
  if (run.state === 'RUNNING' || run.state === 'MISSED_WINDOW' || /^PROBLEM_[1-4]_DONE$/.test(run.state))
    return { reason: 'problem', runAt: after(now, 1000) };
  if (ordinal && run.state === `WAITING_PROBLEM_${ordinal}`) {
    const due = problem ? Date.parse(problem.windowStart) : NaN;
    return { reason: 'problem', runAt: Number.isFinite(due) && due > now.getTime() ? at(due) : after(now, 1000) };
  }
  if (ordinal && run.state === `PROBLEM_${ordinal}_TRIGGERING`)
    return { reason: 'problem', runAt: after(now, 2 * minute) };
  if (ordinal && run.state === `PROBLEM_${ordinal}_TRIGGERED`)
    return { reason: 'problem', runAt: after(now, 5 * minute) };
  if (ordinal && run.state === `PROBLEM_${ordinal}_SUBMITTED`)
    return { reason: 'problem', runAt: after(now, 3 * minute) };
  if (run.state === 'SUBMISSION_RESULT_UNCERTAIN')
    return { reason: 'problem', runAt: after(now, 15 * minute) };
  return null;
}
