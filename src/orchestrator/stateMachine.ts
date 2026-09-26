import { CodeforcesError } from '../codeforces/errors.js';

export const ORDINALS = [1, 2, 3, 4] as const;
export type Ordinal = typeof ORDINALS[number];
export type ProblemPhase = 'WAITING' | 'TRIGGERING' | 'TRIGGERED' | 'SUBMITTED' | 'DONE';
export type ProblemState = `${'WAITING_PROBLEM' | 'PROBLEM'}_${Ordinal}${'' | '_TRIGGERING' | '_TRIGGERED' | '_SUBMITTED' | '_DONE'}`;
export type RunState = 'DISCOVERED' | 'WAITING_FOR_REGISTRATION' | 'REGISTRATION_READY' |
  'REGISTERING' | 'REGISTRATION_RESULT_UNCERTAIN' | 'REGISTERED' | 'AUTHORIZED' |
  'WAITING_FOR_START' | 'RUNNING' | ProblemState | 'CONTEST_COMPLETE' |
  'WAITING_FOR_RATING' | 'RATING_UPDATED' | 'RATING_TIMEOUT' |
  'NEEDS_MANUAL_AUTH' | 'SUBMISSION_RESULT_UNCERTAIN' | 'MISSED_WINDOW' | 'BLOCKED' | 'FAILED';
export type PendingOperation = 'registration_status' | 'registration' | 'problem_fetch' |
  'submission' | 'verdict' | 'contest_state';

const base: Record<string, readonly RunState[]> = {
  DISCOVERED: ['WAITING_FOR_REGISTRATION', 'REGISTRATION_READY', 'REGISTERED', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  WAITING_FOR_REGISTRATION: ['REGISTRATION_READY', 'REGISTERED', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  REGISTRATION_READY: ['REGISTERING', 'REGISTERED', 'WAITING_FOR_REGISTRATION', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  REGISTERING: ['REGISTERED', 'REGISTRATION_READY', 'WAITING_FOR_REGISTRATION', 'REGISTRATION_RESULT_UNCERTAIN', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  REGISTRATION_RESULT_UNCERTAIN: ['REGISTERED', 'REGISTRATION_READY', 'WAITING_FOR_REGISTRATION', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  REGISTERED: ['AUTHORIZED', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  AUTHORIZED: ['WAITING_FOR_START', 'RUNNING', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  WAITING_FOR_START: ['RUNNING', 'WAITING_PROBLEM_1', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  RUNNING: ['WAITING_PROBLEM_1', 'CONTEST_COMPLETE', 'NEEDS_MANUAL_AUTH', 'BLOCKED'],
  CONTEST_COMPLETE: ['WAITING_FOR_RATING'],
  WAITING_FOR_RATING: ['RATING_UPDATED', 'RATING_TIMEOUT', 'NEEDS_MANUAL_AUTH'],
  RATING_UPDATED: [], RATING_TIMEOUT: [], BLOCKED: ['WAITING_FOR_REGISTRATION'], FAILED: [],
  MISSED_WINDOW: ['CONTEST_COMPLETE', 'WAITING_PROBLEM_2', 'WAITING_PROBLEM_3', 'WAITING_PROBLEM_4', 'NEEDS_MANUAL_AUTH'],
  SUBMISSION_RESULT_UNCERTAIN: ['NEEDS_MANUAL_AUTH', 'BLOCKED'],
  NEEDS_MANUAL_AUTH: ['WAITING_FOR_REGISTRATION', 'REGISTRATION_READY', 'REGISTERED',
    'REGISTRATION_RESULT_UNCERTAIN', 'WAITING_FOR_START', 'RUNNING',
    'SUBMISSION_RESULT_UNCERTAIN', 'CONTEST_COMPLETE', 'WAITING_FOR_RATING', 'BLOCKED'],
};
for (const ordinal of ORDINALS) {
  const waiting = `WAITING_PROBLEM_${ordinal}`;
  const triggering = `PROBLEM_${ordinal}_TRIGGERING`;
  const triggered = `PROBLEM_${ordinal}_TRIGGERED`;
  const submitted = `PROBLEM_${ordinal}_SUBMITTED`;
  const done = `PROBLEM_${ordinal}_DONE`;
  const next: RunState = ordinal === 4 ? 'CONTEST_COMPLETE' : `WAITING_PROBLEM_${ordinal + 1}` as RunState;
  base[waiting] = [triggering as RunState, 'MISSED_WINDOW', 'NEEDS_MANUAL_AUTH', 'BLOCKED'];
  base[triggering] = [triggered as RunState, 'NEEDS_MANUAL_AUTH', 'BLOCKED'];
  base[triggered] = [submitted as RunState, 'SUBMISSION_RESULT_UNCERTAIN', 'NEEDS_MANUAL_AUTH', 'BLOCKED'];
  base[submitted] = [done as RunState, 'NEEDS_MANUAL_AUTH', 'BLOCKED'];
  base[done] = [next, 'NEEDS_MANUAL_AUTH', 'BLOCKED'];
  base.NEEDS_MANUAL_AUTH = [...base.NEEDS_MANUAL_AUTH!, waiting as RunState, triggered as RunState, submitted as RunState];
  base.SUBMISSION_RESULT_UNCERTAIN = [...base.SUBMISSION_RESULT_UNCERTAIN!, triggered as RunState, submitted as RunState];
}

/** Explicit edges, including recovery; an arbitrary state value cannot skip a safeguard. */
export function transition(from: RunState, to: RunState): RunState {
  if (from === to) return to;
  if (!base[from]?.includes(to)) throw new CodeforcesError(`Invalid run transition ${from} -> ${to}.`, 'INVALID_RUN_TRANSITION');
  return to;
}

export function isAuthChallenge(code: string): boolean {
  return ['SESSION_REQUIRES_MANUAL_LOGIN', 'SESSION_EXPIRED', 'CF_AUTH_REQUIRED', 'ACCOUNT_MISMATCH'].includes(code);
}
