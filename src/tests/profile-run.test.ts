import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeforcesApi } from '../codeforces/api.js';
import { AccountProfileService } from '../codeforces/profile.js';
import { evaluateContestEligibility, isDiv1Contest, selectUpcomingDiv1 } from '../contest/eligibility.js';
import { advanceAcceptedProblem, createContestRun, MAX_DISTINCT_PROBLEMS_PER_CONTEST,
  recordProblemVerdict, recordSubmissionAttempt, startContestRun } from '../contest/run.js';
import type { Contest } from '../codeforces/types.js';

const base: Contest = { id: 2268, name: 'Codeforces Round 1124 (Div. 1)', type: 'CF', phase: 'BEFORE',
  frozen: false, durationSeconds: 7200, startTimeSeconds: 1800000000 };
const problems = ['A', 'B', 'C', 'D', 'E', 'F'].map((index) => ({ index }));

test('official user.info supplies fresh rating and null for unrated accounts', async () => {
  let rating: number | undefined = 1900;
  const urls: string[] = [];
  const api = new CodeforcesApi(1000, (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ status: 'OK', result: [{ handle: 'tester',
      ...(rating === undefined ? {} : { rating, maxRating: 2000, rank: 'candidate master', maxRank: 'candidate master' }) }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch, { wait: async () => undefined });
  const profiles = new AccountProfileService(api, { CF_EXPECTED_HANDLE: 'tester', CF_CURRENT_RATING: '9999' });
  assert.equal((await profiles.getAccountProfile()).rating, 1900);
  rating = 1950;
  assert.equal((await profiles.getAccountProfile()).rating, 1950);
  rating = undefined;
  assert.deepEqual(await profiles.getAccountProfile(), { handle: 'tester', rating: null, maxRating: null, rank: null, maxRank: null });
  assert.ok(urls.every((url) => new URL(url).pathname === '/api/user.info' && new URL(url).searchParams.get('handles') === 'tester'));
  await assert.rejects(new AccountProfileService(api, { CF_HANDLE: 'personal', CF_EXPECTED_HANDLE: 'tester' }).getAccountProfile(),
    { code: 'ACCOUNT_MISMATCH' });
});

test('Div.1 selector accepts only upcoming regular Div.1 and official eligibility overrides rating', () => {
  const names = ['Codeforces Round 1124 (Div. 1)', 'Codeforces Round 1124 (Div. 2)',
    'Codeforces Round 1125 (Div. 3)', 'Codeforces Round 1126 (Div. 4)',
    'Educational Codeforces Round 200 (Div. 2)'];
  const contests = names.map((name, index) => ({ ...base, id: 2268 + index, name }));
  assert.deepEqual(contests.map(isDiv1Contest), [true, false, false, false, false]);
  assert.deepEqual(selectUpcomingDiv1(contests).map((contest) => contest.id), [2268]);
  assert.equal(isDiv1Contest({ ...base, type: 'IOI' }), false);
  const account = { handle: 'tester', rating: 2500, maxRating: 2500, rank: 'master', maxRank: 'master' };
  const rejected = evaluateContestEligibility(base, account, { contestId: 2268, handle: 'tester',
    status: 'rating_ineligible', reason: 'Rating should be between 0 and 1899 in order to register for the contest' });
  assert.equal(rejected.eligible, false); assert.equal(rejected.decision, 'RATING_INELIGIBLE');
  assert.equal(evaluateContestEligibility(contests[1]!, account).decision, 'NOT_DIV1');
});

test('four-problem state selects A-D, counts distinct indices, preserves retries, and stops after D', () => {
  assert.equal(MAX_DISTINCT_PROBLEMS_PER_CONTEST, 4);
  let run = createContestRun(2268, problems);
  assert.deepEqual(run.problemOrder, ['A', 'B', 'C', 'D']);
  assert.deepEqual(run.scheduleTargets.map((target) => [target.problemIndex, target.earliestOffsetMinutes, target.latestOffsetMinutes]),
    [['A', 10, 25], ['B', 30, 50], ['C', 55, 80], ['D', 85, 110]]);
  assert.equal(run.currentProblem, null);
  run = startContestRun(run, '2026-09-26T00:00:00Z');
  run = recordSubmissionAttempt(run, 'A');
  run = recordProblemVerdict(run, 'A', 'WRONG_ANSWER');
  run = recordSubmissionAttempt(run, 'A');
  assert.equal(run.submissionAttempts.A, 2);
  assert.deepEqual(run.distinctProblemsStarted, ['A']);
  assert.throws(() => recordSubmissionAttempt(run, 'E'), { code: 'INVALID_RUN_TRANSITION' });
  assert.throws(() => advanceAcceptedProblem(run, '2026-09-26T00:01:00Z'), { code: 'INVALID_RUN_TRANSITION' });
  for (const index of ['A', 'B', 'C', 'D']) {
    if (index !== 'A') run = recordSubmissionAttempt(run, index);
    run = recordProblemVerdict(run, index, 'OK');
    run = advanceAcceptedProblem(run, '2026-09-26T01:50:00Z');
  }
  assert.equal(run.status, 'completed'); assert.equal(run.currentProblem, null);
  assert.deepEqual(run.distinctProblemsStarted, ['A', 'B', 'C', 'D']);
  assert.deepEqual(run.distinctProblemsCompleted, ['A', 'B', 'C', 'D']);
  assert.equal(run.submissionAttempts.A, 2);
  assert.equal(run.submissionAttempts.E, undefined);
  assert.throws(() => recordSubmissionAttempt(run, 'E'), { code: 'INVALID_RUN_TRANSITION' });
  assert.throws(() => createContestRun(2268, problems.slice(0, 3)), { code: 'INSUFFICIENT_CONTEST_PROBLEMS' });
});
