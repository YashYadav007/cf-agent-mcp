import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodeforcesError } from '../codeforces/errors.js';
import type { Contest, Submission } from '../codeforces/types.js';
import { selectUpcomingDiv1 } from '../contest/eligibility.js';
import { GitHubWorkTrigger } from '../integrations/githubWorkTrigger.js';
import { loadExperimentConfig } from '../orchestrator/config.js';
import { transition } from '../orchestrator/stateMachine.js';
import type { ExperimentRun, ProblemExecution, RunStore } from '../orchestrator/types.js';
import { ExperimentWatcher, newExperimentRun, scheduleProblems, type WatcherDependencies } from '../orchestrator/watcher.js';
import type { SubmissionAttempt, SubmissionMetadata } from '../storage/types.js';

const start = Date.parse('2030-10-02T12:00:00.000Z');
const contest: Contest = { id: 2273, name: 'Codeforces Round 1124 (Div. 1)', type: 'CF', phase: 'BEFORE',
  frozen: false, durationSeconds: 7200, startTimeSeconds: start / 1000 };
const div2: Contest = { ...contest, id: 2274, name: 'Codeforces Round 1124 (Div. 2)' };
const config = loadExperimentConfig({ EXPERIMENT_ENABLED: 'true', EXPERIMENT_HANDLE: 'testaccount',
  CF_EXPECTED_HANDLE: 'testaccount', CF_STORAGE_STATE_B64: 'configured-for-mock' });

class MemoryRuns implements RunStore {
  run?: ExperimentRun;
  problems: ProblemExecution[] = [];
  claims = 0;
  saves = 0;
  async listOpen() { return this.run && !['RATING_UPDATED', 'RATING_TIMEOUT', 'BLOCKED', 'FAILED'].includes(this.run.state)
    ? [structuredClone(this.run)] : []; }
  async get(id: number) { return this.run?.contestId === id ? structuredClone(this.run) : undefined; }
  async create(run: ExperimentRun) { if (this.run) return false; this.run = structuredClone(run); return true; }
  async claim(id: number, owner: string, now: Date) {
    if (!this.run || this.run.contestId !== id || this.run.leaseOwner) return undefined;
    this.claims++;
    this.run = { ...this.run, leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 240_000).toISOString(),
      version: this.run.version + 1 };
    return structuredClone(this.run);
  }
  async save(run: ExperimentRun) {
    if (!this.run || this.run.version !== run.version || this.run.leaseOwner !== run.leaseOwner)
      throw new CodeforcesError('stale', 'RUN_VERSION_CONFLICT');
    this.saves++;
    this.run = { ...structuredClone(run), version: run.version + 1 };
    return structuredClone(this.run);
  }
  async release(run: ExperimentRun) {
    if (this.run?.version === run.version && this.run.leaseOwner === run.leaseOwner)
      this.run = { ...this.run, leaseOwner: null, leaseExpiresAt: null, version: run.version + 1 };
  }
  async listProblems(runId: string) { return structuredClone(this.problems.filter((p) => p.runId === runId)); }
  async createProblems(problems: ProblemExecution[]) {
    if (!this.problems.length) this.problems = structuredClone(problems);
  }
  async saveProblem(problem: ProblemExecution) {
    const index = this.problems.findIndex((p) => p.ordinal === problem.ordinal);
    if (index < 0 || this.problems[index]!.version !== problem.version) throw new Error('stale problem');
    this.problems[index] = { ...structuredClone(problem), version: problem.version + 1 };
    return structuredClone(this.problems[index]!);
  }
}

function fixture() {
  const runs = new MemoryRuns();
  let now = new Date('2030-10-01T12:00:00.000Z');
  let sessionHandle: string | null = 'testaccount';
  let submissionPageClear = true;
  let registrationStatus: 'not_registered' | 'registered' | 'verification_required' | 'registration_not_open' |
    'registration_closed' | 'rating_ineligible' | 'unknown' = 'not_registered';
  let registrationThrows: CodeforcesError | null = null;
  let clicks = 0;
  let statusReads = 0;
  let authWrites = 0;
  let triggerWrites = 0;
  let submissionRecords: Submission[] = [];
  let contestApiUnavailable = false;
  let ratingChanges: Array<{ contestId: number; contestName: string; handle: string; rank: number;
    ratingUpdateTimeSeconds: number; oldRating: number; newRating: number }> = [];
  let attempts: SubmissionAttempt[] = [];
  let metadata: SubmissionMetadata[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: WatcherDependencies = {
    api: {
      contests: async () => { if (contestApiUnavailable) throw new CodeforcesError('temporary', 'CF_API_ERROR', true);
        return [contest, div2]; },
      contestProblems: async () => 'ABCDE'.split('').map((index) => ({ index, name: index, type: 'PROGRAMMING', tags: [] })),
      submissionPage: async () => submissionRecords,
      contestRatingChanges: async () => ratingChanges, userRating: async () => [],
    },
    browser: { getSessionStatus: async () => ({ authenticated: !!sessionHandle, handle: sessionHandle,
      method: 'cdp', message: '' }), probeSubmissionPage: async () => submissionPageClear },
    profile: { getAccountProfile: async () => ({ handle: 'testaccount', rating: 2051, maxRating: 2051,
      rank: 'candidate master', maxRank: 'candidate master' }) },
    registration: {
      status: async () => { statusReads++; return { contestId: contest.id, handle: sessionHandle, status: registrationStatus }; },
      register: async () => { clicks++; if (registrationThrows) throw registrationThrows;
        return { registered: true as const, alreadyRegistered: false, contestId: contest.id, handle: 'testaccount' }; },
    },
    runs,
    submissions: { findForProblem: async () => metadata, findAttemptsForProblem: async () => attempts },
    authorization: {
      isContestAuthorized: async () => true,
      authorizeContest: async () => { authWrites++; },
      completeContest: async () => { authWrites++; }, blockContest: async () => { authWrites++; },
    },
    trigger: { find: async () => null, ensure: async (input) => { triggerWrites++;
      return { branch: `cf-run/${input.contestId}/p${input.ordinal}`, prNumber: 123 }; } },
    config, now: () => now, log: (event) => logs.push(event),
  };
  return { runs, deps, watcher: new ExperimentWatcher(deps), logs,
    setNow: (value: string) => { now = new Date(value); },
    setSession: (handle: string | null) => { sessionHandle = handle; },
    setSubmissionPageClear: (value: boolean) => { submissionPageClear = value; },
    setRegistration: (status: typeof registrationStatus) => { registrationStatus = status; },
    setRegistrationError: (error: CodeforcesError | null) => { registrationThrows = error; },
    setSubmission: (records: Submission[], inputAttempts: SubmissionAttempt[], inputMetadata: SubmissionMetadata[]) => {
      submissionRecords = records; attempts = inputAttempts; metadata = inputMetadata;
    },
    setRatingChanges: (changes: typeof ratingChanges) => { ratingChanges = changes; },
    setContestApiUnavailable: (value: boolean) => { contestApiUnavailable = value; },
    counts: () => ({ clicks, statusReads, authWrites, triggerWrites }),
  };
}

async function seed(f: ReturnType<typeof fixture>, state: ExperimentRun['state'] = 'DISCOVERED',
  pending: ExperimentRun['pendingOperation'] = null) {
  const run = { ...newExperimentRun(contest, 'testaccount', 2051), state,
    pendingOperation: pending, resumeState: pending ? 'PROBLEM_1_TRIGGERED' as const : null,
    authRequiredAt: pending ? '2030-10-01T11:00:00.000Z' : null,
    currentProblemOrdinal: pending === 'submission' ? 1 as const : null,
    problemOrder: pending === 'submission' ? ['A', 'B', 'C', 'D'] : [] };
  await f.runs.create(run);
  if (pending === 'submission') {
    const problems = scheduleProblems(run, 'ABCDE'.split('').map((index) => ({ index })), config.windows);
    problems[0]!.state = 'triggered';
    problems[0]!.triggeredAt = '2030-10-01T10:00:00.000Z';
    await f.runs.createProblems(problems);
  }
}

async function seedDueProblem(f: ReturnType<typeof fixture>): Promise<void> {
  await seed(f, 'WAITING_PROBLEM_1');
  f.runs.run = { ...f.runs.run!, currentProblemOrdinal: 1, problemOrder: ['A', 'B', 'C', 'D'] };
  await f.runs.createProblems(scheduleProblems(f.runs.run, 'ABCDE'.split('').map((index) => ({ index })), config.windows));
  f.setNow('2030-10-02T12:10:00.000Z');
}

test('contest selector takes only the explicit upcoming regular Div.1 sibling', () => {
  assert.deepEqual(selectUpcomingDiv1([div2, contest, { ...contest, id: 3, name: 'Div. 1 + Div. 2' }]).map((c) => c.id), [2273]);
});
test('explicit transitions reject skipping safeguards', () => {
  assert.equal(transition('NEEDS_MANUAL_AUTH', 'REGISTERED'), 'REGISTERED');
  assert.throws(() => transition('WAITING_FOR_REGISTRATION', 'PROBLEM_1_TRIGGERED'), /Invalid run transition/);
});
test('registration challenge persists NEEDS_MANUAL_AUTH and never retries the click', async () => {
  const f = fixture(); await seed(f);
  f.setRegistrationError(new CodeforcesError('manual verification after click', 'REGISTRATION_RESULT_UNCERTAIN'));
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  assert.equal(f.runs.run?.pendingOperation, 'registration');
  assert.ok(f.runs.run?.authRequiredAt);
  assert.equal(f.counts().clicks, 1);
  f.setRegistration('verification_required');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  assert.equal(f.counts().clicks, 1);
});
test('challenge still present after manual intervention keeps state and logs safe check', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setRegistration('verification_required'); await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  assert.ok(f.runs.run?.lastAuthCheckAt);
  assert.ok(f.logs.some((event) => event.action === 'AUTH_STILL_REQUIRED'));
  assert.equal(f.counts().clicks, 0);
});
test('completed manual verification reconciles successful registration with zero new clicks', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setRegistration('registered'); await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTERED');
  assert.ok(f.runs.run?.authRecoveredAt);
  assert.equal(f.runs.run?.pendingOperation, null);
  assert.equal(f.counts().clicks, 0);
  assert.equal(f.counts().authWrites, 0);
});
test('manual verification with no registration returns to ready but does not click in recovery pass', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTRATION_READY');
  assert.equal(f.counts().clicks, 0);
  assert.equal(f.counts().authWrites, 0);
});
test('wrong authenticated handle remains in manual auth and skips status/mutation', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setSession('personalAccount'); await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  assert.equal(f.counts().statusReads, 0);
  assert.equal(f.counts().clicks, 0);
});
test('refreshed storage-state session is observed automatically on a later pass', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setSession(null); await f.watcher.once(); assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  f.setSession('testaccount'); f.setRegistration('registered'); await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTERED');
  assert.equal(f.counts().clicks, 0);
});
test('manual auth recovery still runs when public contest API is temporarily unavailable', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setContestApiUnavailable(true); f.setRegistration('registered');
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'REGISTERED');
  assert.equal(f.counts().clicks, 0);
});
test('rating ineligible after auth recovery blocks without registration click', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration');
  f.setRegistration('rating_ineligible'); await f.watcher.once();
  assert.equal(f.runs.run?.state, 'BLOCKED'); assert.equal(f.counts().clicks, 0);
});
test('submission auth recovery reuses an officially confirmed account submission', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'submission');
  const submission: Submission = { id: 123, contestId: 2273, problem: { contestId: 2273, index: 'A', name: 'A',
    type: 'PROGRAMMING', tags: [] }, programmingLanguage: 'Java 17', verdict: 'OK', passedTestCount: 2,
    timeConsumedMillis: 100, memoryConsumedBytes: 4096, author: { members: [{ handle: 'testaccount' }] } };
  const submittedAt = '2030-10-01T11:30:00.000Z';
  f.setSubmission([submission], [{ attemptId: 'attempt', contestId: 2273, problemIndex: 'A', language: 'java17',
    submittedAt, fingerprint: 'a'.repeat(64), state: 'confirmed', submissionId: 123 }],
  [{ submissionId: 123, contestId: 2273, problemIndex: 'A', language: 'java17', submittedAt }]);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'PROBLEM_1_SUBMITTED');
  assert.equal(f.runs.problems[0]?.submissionId, 123);
  assert.equal(f.counts().clicks, 0);
});
test('submit-page challenge remains blocked even when the homepage session is valid', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'submission');
  f.setSubmissionPageClear(false);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  assert.equal(f.counts().clicks, 0);
  f.setSubmissionPageClear(true);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'PROBLEM_1_TRIGGERED');
});
test('submission challenge before any reserved attempt safely returns to triggered state', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'submission');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'PROBLEM_1_TRIGGERED');
  assert.equal(f.counts().clicks, 0);
});
test('uncertain submission attempt never causes automatic resubmission', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'submission');
  f.setSubmission([], [{ attemptId: 'attempt', contestId: 2273, problemIndex: 'A', language: 'java17',
    submittedAt: '2030-10-01T11:30:00.000Z', fingerprint: 'a'.repeat(64), state: 'uncertain' }], []);
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'SUBMISSION_RESULT_UNCERTAIN');
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'SUBMISSION_RESULT_UNCERTAIN');
  assert.equal(f.counts().clicks, 0);
});
test('a different account or problem cannot be associated with recovered submission', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'submission');
  const submittedAt = '2030-10-01T11:30:00.000Z';
  f.setSubmission([{ id: 123, contestId: 2273, problem: { index: 'B', name: 'B', type: 'PROGRAMMING', tags: [] },
    programmingLanguage: 'Java 17', passedTestCount: 1, timeConsumedMillis: 1, memoryConsumedBytes: 1,
    author: { members: [{ handle: 'other' }] } }],
  [{ attemptId: 'attempt', contestId: 2273, problemIndex: 'A', language: 'java17', submittedAt,
    fingerprint: 'a'.repeat(64), state: 'confirmed', submissionId: 123 }],
  [{ submissionId: 123, contestId: 2273, problemIndex: 'A', language: 'java17', submittedAt }]);
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'SUBMISSION_RESULT_UNCERTAIN');
});
test('schedule persists only first four distinct official problems and fixed windows', () => {
  const run = newExperimentRun(contest, 'testaccount', 2051);
  const problems = scheduleProblems(run, 'ABCDE'.split('').map((index) => ({ index })), config.windows);
  assert.deepEqual(problems.map((p) => p.problemIndex), ['A', 'B', 'C', 'D']);
  assert.equal(problems[0]?.windowStart, new Date(start + 10 * 60_000).toISOString());
  assert.equal(problems[3]?.windowEnd, new Date(start + 110 * 60_000).toISOString());
});
test('dry run reads candidate and run state without claiming, clicking, authorizing, or triggering', async () => {
  const f = fixture(); await seed(f);
  await f.watcher.once({ dryRun: true });
  assert.equal(f.runs.claims, 0); assert.equal(f.runs.saves, 0);
  assert.deepEqual(f.counts(), { clicks: 0, statusReads: 0, authWrites: 0, triggerWrites: 0 });
});
test('registration not open leaves the run waiting and never clicks or authorizes', async () => {
  const f = fixture(); await seed(f); f.setRegistration('registration_not_open');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().clicks, 0); assert.equal(f.counts().authWrites, 0);
});
test('an upcoming Div.1 contest without a validated interface is checked again on later passes', async () => {
  const f = fixture(); await seed(f); f.setRegistration('unknown');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().statusReads, 1);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().statusReads, 2);
  assert.equal(f.counts().clicks, 0);
  f.setRegistration('not_registered');
  await f.watcher.once();
  assert.ok(f.logs.some((event) => event.action === 'REGISTRATION_READY'));
  assert.equal(f.runs.run?.state, 'REGISTERED');
  assert.equal(f.counts().clicks, 1);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_START');
  assert.equal(f.counts().authWrites, 1);
});
test('temporary closed and unknown registration statuses wait, while explicit ineligibility blocks', async () => {
  for (const status of ['registration_closed', 'unknown'] as const) {
    const f = fixture(); await seed(f); f.setRegistration(status);
    await f.watcher.once();
    assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
    assert.equal(f.counts().clicks, 0);
  }
  const ineligible = fixture(); await seed(ineligible); ineligible.setRegistration('rating_ineligible');
  await ineligible.watcher.once();
  assert.equal(ineligible.runs.run?.state, 'BLOCKED');
  assert.equal(ineligible.counts().clicks, 0);
});
test('manual challenge recovers to waiting when the registration interface is still absent', async () => {
  const f = fixture(); await seed(f); f.setRegistration('verification_required');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'NEEDS_MANUAL_AUTH');
  f.setRegistration('unknown');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().clicks, 0);
});
test('manual recovery preserves a prior uncertain registration result when status remains unavailable', async () => {
  const f = fixture(); await seed(f, 'NEEDS_MANUAL_AUTH', 'registration_status');
  f.runs.run = { ...f.runs.run!, resumeState: 'REGISTRATION_RESULT_UNCERTAIN' };
  f.setRegistration('unknown');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTRATION_RESULT_UNCERTAIN');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTRATION_RESULT_UNCERTAIN');
  assert.equal(f.counts().clicks, 0);
});
test('uncertain registration is never replayed when availability becomes unknown', async () => {
  const f = fixture(); await seed(f, 'REGISTRATION_RESULT_UNCERTAIN'); f.setRegistration('unknown');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'REGISTRATION_RESULT_UNCERTAIN');
  assert.equal(f.counts().clicks, 0);
});
test('legacy 2273 temporary registration block reopens only while official contest and account remain eligible', async () => {
  const f = fixture(); await seed(f, 'BLOCKED');
  f.runs.run = { ...f.runs.run!, registrationStatus: 'registration_closed',
    lastErrorCode: 'REGISTRATION_CLOSED', completedAt: '2030-10-01T11:00:00.000Z' };
  f.setRegistration('registration_not_open');
  await f.watcher.once();
  assert.equal(f.runs.run?.contestId, 2273);
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.runs.run?.completedAt, null);
  assert.equal(f.runs.run?.lastErrorCode, null);
  assert.equal(f.counts().clicks, 0);
  assert.ok(f.logs.some((event) => event.action === 'TEMPORARY_REGISTRATION_BLOCK_RECOVERED'));
});
test('permanent and wrong-account blocked runs stay blocked', async () => {
  for (const block of [
    { registrationStatus: 'rating_ineligible' as const, lastErrorCode: 'RATING_INELIGIBLE' },
    { registrationStatus: null, lastErrorCode: 'CONTEST_NOT_ELIGIBLE' },
    { registrationStatus: 'registration_closed' as const, lastErrorCode: 'OPERATOR_BLOCKED' },
    { registrationStatus: 'registration_closed' as const, lastErrorCode: null },
  ]) {
    const f = fixture(); await seed(f, 'BLOCKED'); f.runs.run = { ...f.runs.run!, ...block };
    await f.watcher.once();
    assert.equal(f.runs.run?.state, 'BLOCKED'); assert.equal(f.runs.claims, 0);
  }
  const wrong = fixture(); await seed(wrong, 'BLOCKED');
  wrong.runs.run = { ...wrong.runs.run!, registrationStatus: 'registration_closed',
    lastErrorCode: 'REGISTRATION_CLOSED' };
  wrong.setSession('personalAccount'); await wrong.watcher.once();
  assert.equal(wrong.runs.run?.state, 'BLOCKED');
});
test('confirmed registration alone activates authorization on the next pass', async () => {
  const f = fixture(); await seed(f); f.setRegistration('registered');
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'REGISTERED'); assert.equal(f.counts().authWrites, 0);
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'WAITING_FOR_START'); assert.equal(f.counts().authWrites, 1);
});
test('due first problem creates one PR, persists A-D, and repeated pass does not duplicate trigger', async () => {
  const f = fixture(); await seed(f, 'REGISTERED');
  f.setNow('2030-10-02T12:10:00.000Z');
  await f.watcher.once(); // authorization
  await f.watcher.once(); // official first four + P1 trigger
  assert.equal(f.runs.run?.state, 'PROBLEM_1_TRIGGERED');
  assert.deepEqual(f.runs.problems.map((p) => p.problemIndex), ['A', 'B', 'C', 'D']);
  assert.equal(f.counts().triggerWrites, 1);
  await f.watcher.once();
  assert.equal(f.counts().triggerWrites, 1);
});
test('an entirely missed window is recorded and P2 waits for the terminal P1 mark', async () => {
  const f = fixture(); await seed(f, 'WAITING_PROBLEM_1');
  f.runs.run = { ...f.runs.run!, currentProblemOrdinal: 1, problemOrder: ['A', 'B', 'C', 'D'] };
  await f.runs.createProblems(scheduleProblems(f.runs.run, 'ABCDE'.split('').map((index) => ({ index })), config.windows));
  f.setNow('2030-10-02T12:26:00.000Z');
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'MISSED_WINDOW');
  assert.equal(f.runs.problems[0]?.state, 'missed');
  assert.equal(f.counts().triggerWrites, 0);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'WAITING_PROBLEM_2');
  assert.equal(f.counts().triggerWrites, 0);
});
test('official contest-specific rating change stores delta without trusting a stale profile', async () => {
  const f = fixture(); await seed(f, 'WAITING_FOR_RATING');
  f.runs.run = { ...f.runs.run!, completedAt: '2030-10-02T14:00:00.000Z',
    ratingDeadlineAt: '2030-10-05T14:00:00.000Z' };
  f.setNow('2030-10-03T12:00:00.000Z');
  f.setRatingChanges([{ contestId: 2273, contestName: contest.name, handle: 'testaccount', rank: 100,
    ratingUpdateTimeSeconds: Math.floor(Date.parse('2030-10-03T10:00:00Z') / 1000), oldRating: 2051, newRating: 2060 }]);
  await f.watcher.once();
  assert.equal(f.runs.run?.state, 'RATING_UPDATED');
  assert.equal(f.runs.run?.ratingAfter, 2060); assert.equal(f.runs.run?.ratingDelta, 9);
  assert.equal(f.runs.run?.rankAfter, null);
});
test('fourth terminal problem completes the run and closes contest authorization', async () => {
  const f = fixture(); await seed(f, 'PROBLEM_4_DONE');
  f.runs.run = { ...f.runs.run!, currentProblemOrdinal: 4, problemOrder: ['A', 'B', 'C', 'D'] };
  await f.runs.createProblems(scheduleProblems(f.runs.run, 'ABCDE'.split('').map((index) => ({ index })), config.windows));
  f.runs.problems[3]!.state = 'done'; f.runs.problems[3]!.verdict = 'WRONG_ANSWER';
  f.setNow('2030-10-02T13:50:00.000Z');
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'CONTEST_COMPLETE');
  assert.equal(f.counts().authWrites, 0);
  await f.watcher.once(); assert.equal(f.runs.run?.state, 'WAITING_FOR_RATING');
  assert.equal(f.counts().authWrites, 1);
  assert.equal(f.counts().triggerWrites, 0);
});
test('safe structured run logs omit configured token and source material', async () => {
  const f = fixture(); await seed(f); f.setRegistration('registration_not_open');
  await f.watcher.once();
  const serialized = JSON.stringify(f.logs);
  assert.match(serialized, /RECONCILE_START/);
  assert.doesNotMatch(serialized, /storage-state|password|Bearer|sourceCode/);
});

test('enabled discovery creates a waiting-for-registration run without GitHub credentials', async () => {
  const f = fixture(); f.setRegistration('registration_not_open');
  assert.equal(config.githubRepository, ''); assert.equal(config.githubToken, '');
  f.deps.trigger = new GitHubWorkTrigger(config.githubRepository, config.githubToken);
  await new ExperimentWatcher(f.deps).once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().triggerWrites, 0);
});

test('registration_not_open reconciliation does not validate GitHub credentials', async () => {
  const f = fixture(); await seed(f, 'WAITING_FOR_REGISTRATION'); f.setRegistration('registration_not_open');
  f.deps.trigger = new GitHubWorkTrigger('', '');
  await new ExperimentWatcher(f.deps).once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_REGISTRATION');
  assert.equal(f.counts().clicks, 0);
});

test('WAITING_FOR_START does not validate GitHub credentials', async () => {
  const f = fixture(); await seed(f, 'WAITING_FOR_START');
  f.deps.trigger = new GitHubWorkTrigger('', '');
  await new ExperimentWatcher(f.deps).once();
  assert.equal(f.runs.run?.state, 'WAITING_FOR_START');
});

test('a due problem requires GitHub configuration at the trigger action', async () => {
  const f = fixture(); await seedDueProblem(f);
  f.deps.trigger = new GitHubWorkTrigger('', '', async () => { throw new Error('GitHub must not be contacted'); });
  await assert.rejects(new ExperimentWatcher(f.deps).once(), { code: 'TRIGGER_CONFIG_ERROR' });
  assert.equal(f.runs.run?.state, 'PROBLEM_1_TRIGGERING');
  assert.equal(f.counts().triggerWrites, 0);
});

test('a due problem with configured trigger invokes it exactly once', async () => {
  const f = fixture(); await seedDueProblem(f);
  f.deps.config = { ...config, githubRepository: 'owner/repo', githubToken: 'test-token' };
  const watcher = new ExperimentWatcher(f.deps);
  await watcher.once();
  await watcher.once();
  assert.equal(f.runs.run?.state, 'PROBLEM_1_TRIGGERED');
  assert.equal(f.counts().triggerWrites, 1);
});

test('dry run without GitHub credentials succeeds and never invokes the adapter', async () => {
  const f = fixture(); await seed(f);
  f.deps.trigger = new GitHubWorkTrigger('', '', async () => { throw new Error('GitHub must not be contacted'); });
  await new ExperimentWatcher(f.deps).once({ dryRun: true });
  assert.equal(f.runs.claims, 0); assert.equal(f.runs.saves, 0);
  assert.equal(f.counts().triggerWrites, 0);
});

test('dry run reports a due Work trigger without GitHub token or mutation', async () => {
  const f = fixture(); await seedDueProblem(f);
  f.deps.trigger = new GitHubWorkTrigger('', '', async () => { throw new Error('GitHub must not be contacted'); });
  await new ExperimentWatcher(f.deps).once({ dryRun: true });
  const report = f.logs.find((event) => event.action === 'DRY_RUN');
  assert.deepEqual(report?.runs, [{ contestId: 2273, state: 'WAITING_PROBLEM_1', wouldTriggerGithub: true }]);
  assert.equal(f.runs.claims, 0); assert.equal(f.runs.saves, 0);
  assert.equal(f.counts().triggerWrites, 0);
});
