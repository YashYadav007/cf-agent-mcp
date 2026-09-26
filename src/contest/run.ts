import { CodeforcesError } from '../codeforces/errors.js';
import type { Problem } from '../codeforces/types.js';
import { getSubmissionWindow } from '../pacing/policy.js';

export const MAX_DISTINCT_PROBLEMS_PER_CONTEST = 4;
export type ContestRunStatus = 'planned' | 'active' | 'completed';
export interface ProblemScheduleTarget {
  problemIndex: string;
  earliestOffsetMinutes: number;
  latestOffsetMinutes: number;
}
export interface ContestRun {
  contestId: number;
  status: ContestRunStatus;
  problemOrder: string[];
  currentProblem: string | null;
  distinctProblemsStarted: string[];
  distinctProblemsCompleted: string[];
  submissionAttempts: Record<string, number>;
  verdicts: Record<string, string | null>;
  scheduleTargets: ProblemScheduleTarget[];
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

function validTime(at: string): string {
  if (!Number.isFinite(Date.parse(at))) throw new CodeforcesError('Invalid run timestamp.', 'INVALID_INPUT');
  return new Date(at).toISOString();
}

/** Uses the official contest problem order; the fifth and later problems never enter this run. */
export function createContestRun(contestId: number, problems: readonly Pick<Problem, 'index'>[]): ContestRun {
  if (!Number.isSafeInteger(contestId) || contestId <= 0) throw new CodeforcesError('Expected a positive contest ID.', 'INVALID_INPUT');
  const order = [...new Set(problems.map((problem) => problem.index))];
  if (order.length < MAX_DISTINCT_PROBLEMS_PER_CONTEST || order.slice(0, 4).some((index) => !/^[A-Z][A-Z0-9]*$/.test(index)))
    throw new CodeforcesError('Contest must expose at least four distinct indexed problems.', 'INSUFFICIENT_CONTEST_PROBLEMS');
  const problemOrder = order.slice(0, MAX_DISTINCT_PROBLEMS_PER_CONTEST);
  return { contestId, status: 'planned', problemOrder, currentProblem: null,
    distinctProblemsStarted: [], distinctProblemsCompleted: [], submissionAttempts: {}, verdicts: {},
    scheduleTargets: problemOrder.map((problemIndex, index) => {
      const window = getSubmissionWindow(index + 1);
      return { problemIndex, earliestOffsetMinutes: window.startMinute, latestOffsetMinutes: window.endMinute };
    }), startedAt: null, completedAt: null, version: 0 };
}

export function startContestRun(run: ContestRun, at: string): ContestRun {
  if (run.status !== 'planned' || run.distinctProblemsStarted.length)
    throw new CodeforcesError('Contest run has already started.', 'INVALID_RUN_TRANSITION');
  const first = run.problemOrder[0];
  if (!first) throw new CodeforcesError('Contest run has no problem order.', 'INVALID_RUN_TRANSITION');
  return { ...run, status: 'active', currentProblem: first,
    distinctProblemsStarted: [first], startedAt: validTime(at) };
}

export function recordSubmissionAttempt(run: ContestRun, problemIndex: string): ContestRun {
  if (run.status !== 'active' || run.currentProblem !== problemIndex)
    throw new CodeforcesError('Only the current scheduled problem may receive an attempt.', 'INVALID_RUN_TRANSITION');
  return { ...run, submissionAttempts: { ...run.submissionAttempts,
    [problemIndex]: (run.submissionAttempts[problemIndex] ?? 0) + 1 } };
}

export function recordProblemVerdict(run: ContestRun, problemIndex: string, verdict: string): ContestRun {
  if (run.status !== 'active' || run.currentProblem !== problemIndex ||
      (run.submissionAttempts[problemIndex] ?? 0) < 1 || !verdict)
    throw new CodeforcesError('Verdict does not belong to an attempted current problem.', 'INVALID_RUN_TRANSITION');
  return { ...run, verdicts: { ...run.verdicts, [problemIndex]: verdict } };
}

export function advanceAcceptedProblem(run: ContestRun, at: string): ContestRun {
  const current = run.currentProblem;
  if (run.status !== 'active' || !current || run.verdicts[current] !== 'OK')
    throw new CodeforcesError('An Accepted verdict is required before advancing.', 'INVALID_RUN_TRANSITION');
  const completed = [...run.distinctProblemsCompleted, current];
  if (completed.length > MAX_DISTINCT_PROBLEMS_PER_CONTEST || new Set(completed).size !== completed.length)
    throw new CodeforcesError('Distinct-problem limit exceeded.', 'INVALID_RUN_TRANSITION');
  const next = run.problemOrder[completed.length] ?? null;
  return { ...run, distinctProblemsCompleted: completed, currentProblem: next,
    distinctProblemsStarted: next ? [...run.distinctProblemsStarted, next] : run.distinctProblemsStarted,
    status: next ? 'active' : 'completed', completedAt: next ? null : validTime(at) };
}
