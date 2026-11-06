import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Contest } from '../codeforces/types.js';
import type { CloudTasksConfig } from '../integrations/cloudTasks.js';
import { newExperimentRun } from '../orchestrator/watcher.js';
import type { ExperimentRun, ProblemExecution } from '../orchestrator/types.js';
import { archiveStaleManualAuthRun } from '../orchestrator/archiveStaleRun.js';

const now = new Date('2030-10-02T16:00:00.000Z');
const cloud: CloudTasksConfig = { projectId: 'test-project', region: 'us-central1', queue: 'cf-agent',
  serviceUrl: 'https://cf-agent-abc.run.app', serviceAccount: 'cf-invoker@test-project.iam.gserviceaccount.com' };
const finishedContest: Contest = { id: 2273, name: 'Codeforces Round 1124 (Div. 1)', type: 'CF', phase: 'FINISHED',
  frozen: false, durationSeconds: 7200, startTimeSeconds: Date.parse('2030-10-01T12:00:00Z') / 1000 };

function makeRun(): ExperimentRun {
  return { ...newExperimentRun({ ...finishedContest, phase: 'BEFORE' }, 'testaccount', 2051),
    state: 'NEEDS_MANUAL_AUTH', pendingOperation: 'registration_status',
    recoveryReason: 'SESSION_REQUIRES_MANUAL_LOGIN', lastErrorCode: 'SESSION_REQUIRES_MANUAL_LOGIN',
    lastErrorMessage: null, authRequiredAt: '2030-09-28T18:00:00.000Z',
    nextReconcileAt: '2030-09-28T18:28:48.632Z', nextReconcileReason: 'manual_auth',
    scheduledTaskName: 'projects/test-project/locations/us-central1/queues/cf-agent/tasks/abc123' };
}

function fixture(options: { contest?: Contest; cancelError?: Error } = {}) {
  let run = makeRun(); let saved: ExperimentRun | undefined; let canceled: string | undefined;
  let released: ExperimentRun | undefined;
  const deps = {
    api: { contests: async () => [options.contest ?? finishedContest] },
    cloud,
    runs: {
      get: async () => run,
      claim: async () => { run = { ...run, leaseOwner: 'lease', leaseExpiresAt: '2030-10-02T16:04:00.000Z', version: run.version + 1 }; return run; },
      listProblems: async (): Promise<ProblemExecution[]> => [],
      save: async (next: ExperimentRun) => { saved = { ...next, version: next.version + 1 }; run = saved; return saved; },
      release: async (value: ExperimentRun) => { released = value; },
    },
    authorization: { isContestAuthorized: async () => false },
    scheduler: { cancel: async (name: string) => { if (options.cancelError) throw options.cancelError; canceled = name; } },
    now: () => now,
  };
  return { deps, get run() { return run; }, get saved() { return saved; }, get canceled() { return canceled; }, get released() { return released; } };
}

test('archives only a finished unregistered manual-auth run and cancels its persisted task', async () => {
  const f = fixture();
  const result = await archiveStaleManualAuthRun(2273, f.deps);
  assert.equal(f.canceled, makeRun().scheduledTaskName);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.lastErrorCode, 'STALE_CONTEST_ARCHIVED');
  assert.equal(result.pendingOperation, 'registration_status');
  assert.equal(result.recoveryReason, 'SESSION_REQUIRES_MANUAL_LOGIN');
  assert.equal(result.scheduledTaskName, null);
  assert.equal(result.completedAt, now.toISOString());
  assert.equal(f.released?.version, result.version);
  const audit = JSON.parse(result.lastErrorMessage!);
  assert.equal(audit.action, 'STALE_CONTEST_ARCHIVED');
  assert.equal(audit.previous.pendingOperation, 'registration_status');
  assert.equal(audit.previous.recoveryReason, 'SESSION_REQUIRES_MANUAL_LOGIN');
});

test('does not archive if the official contest is not finished', async () => {
  const f = fixture({ contest: { ...finishedContest, phase: 'BEFORE' } });
  await assert.rejects(archiveStaleManualAuthRun(2273, f.deps), { code: 'CONTEST_NOT_ARCHIVABLE' });
  assert.equal(f.saved, undefined);
  assert.equal(f.canceled, undefined);
});

test('a queue cancellation failure leaves the run state unchanged', async () => {
  const f = fixture({ cancelError: new Error('queue unavailable') });
  await assert.rejects(archiveStaleManualAuthRun(2273, f.deps));
  assert.equal(f.saved, undefined);
  assert.equal(f.run.state, 'NEEDS_MANUAL_AUTH');
});

test('does not archive a run with executed problem records', async () => {
  const f = fixture();
  f.deps.runs.listProblems = async () => [{ runId: f.run.runId, ordinal: 1, problemIndex: 'A',
    windowStart: now.toISOString(), windowEnd: new Date(now.getTime() + 60_000).toISOString(), state: 'waiting',
    triggeredAt: null, githubBranch: null, githubPrNumber: null, submissionId: null, verdict: null,
    lastErrorCode: null, version: 0 }];
  await assert.rejects(archiveStaleManualAuthRun(2273, f.deps), { code: 'RUN_NOT_ARCHIVABLE' });
  assert.equal(f.saved, undefined);
  assert.equal(f.canceled, undefined);
});

test('does not archive while contest authorization is active', async () => {
  const f = fixture();
  f.deps.authorization.isContestAuthorized = async () => true;
  await assert.rejects(archiveStaleManualAuthRun(2273, f.deps), { code: 'RUN_NOT_ARCHIVABLE' });
  assert.equal(f.saved, undefined);
  assert.equal(f.canceled, undefined);
});
