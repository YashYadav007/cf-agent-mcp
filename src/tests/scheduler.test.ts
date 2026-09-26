import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { CloudTasksClient } from '@google-cloud/tasks';
import type { OAuth2Client } from 'google-auth-library';
import { createApp } from '../app.js';
import { GoogleServiceAccountVerifier } from '../auth/internalOidc.js';
import type { BrowserAccess } from '../codeforces/browser.js';
import { CloudTasksWakeupScheduler, readCloudTasksConfig, type WakeupRequest } from '../integrations/cloudTasks.js';
import { newExperimentRun } from '../orchestrator/watcher.js';
import { planNextWakeup, registrationCheckInterval } from '../orchestrator/scheduling.js';
import type { Contest } from '../codeforces/types.js';

const now = new Date('2030-10-01T12:00:00.000Z');
const contest: Contest = { id: 2273, name: 'Codeforces Round 1124 (Div. 1)', type: 'CF', phase: 'BEFORE',
  frozen: false, durationSeconds: 7200, startTimeSeconds: Date.parse('2030-10-02T12:00:00Z') / 1000 };
const run = newExperimentRun(contest, 'testaccount', 2051);

test('adaptive registration wakeups use six hours, one hour, then fifteen minutes', () => {
  const start = '2030-10-05T12:00:00Z';
  assert.equal(registrationCheckInterval(start, now), 6 * 3600_000);
  assert.equal(registrationCheckInterval('2030-10-02T12:00:00Z', now), 3600_000);
  assert.equal(registrationCheckInterval('2030-10-01T20:00:00Z', now), 15 * 60_000);
  assert.deepEqual(planNextWakeup(run, now), { reason: 'registration', runAt: '2030-10-01T13:00:00.000Z' });
});

test('registered runs stop registration polling and schedule official start once', () => {
  assert.deepEqual(planNextWakeup({ ...run, state: 'WAITING_FOR_START' }, now),
    { reason: 'start', runAt: run.contestStartAt });
  assert.deepEqual(planNextWakeup({ ...run, state: 'REGISTERED' }, now),
    { reason: 'start', runAt: '2030-10-01T12:00:01.000Z' });
  assert.equal(planNextWakeup({ ...run, state: 'BLOCKED' }, now), null);
});

test('problem one is due at contest start; later problems and rating use future one-shot checks', () => {
  const first = { runId: run.runId, ordinal: 1 as const, problemIndex: 'A', windowStart: run.contestStartAt,
    windowEnd: '2030-10-02T12:25:00.000Z', state: 'waiting' as const, triggeredAt: null,
    githubBranch: null, githubPrNumber: null, submissionId: null, verdict: null, lastErrorCode: null, version: 0 };
  const startTime = new Date(run.contestStartAt);
  assert.deepEqual(planNextWakeup({ ...run, state: 'WAITING_PROBLEM_1', currentProblemOrdinal: 1 }, startTime, first),
    { reason: 'problem', runAt: '2030-10-02T12:00:01.000Z' });
  assert.deepEqual(planNextWakeup({ ...run, state: 'WAITING_FOR_RATING', lastRatingCheckAt: null }, now),
    { reason: 'rating', runAt: '2030-10-01T13:00:00.000Z' });
  assert.deepEqual(planNextWakeup({ ...run, state: 'WAITING_FOR_RATING', lastRatingCheckAt: now.toISOString() }, now),
    { reason: 'rating', runAt: '2030-10-01T15:00:00.000Z' });
});

test('Cloud Tasks uses OIDC, deterministic names, duplicate handling, and lost-task repair', async () => {
  const config = readCloudTasksConfig({ GCP_PROJECT_ID: 'test-project', GCP_REGION: 'us-central1',
    CLOUD_TASKS_QUEUE: 'cf-agent', ORCHESTRATOR_SERVICE_URL: 'https://cf-agent-abc.run.app',
    CLOUD_TASKS_SERVICE_ACCOUNT: 'cf-invoker@test-project.iam.gserviceaccount.com' });
  const live = new Map<string, Record<string, unknown>>();
  const reserved = new Set<string>();
  const client = {
    createTask: async (request: { task: Record<string, unknown> }) => {
      const name = String(request.task.name);
      if (reserved.has(name)) throw Object.assign(new Error('duplicate'), { code: 6 });
      reserved.add(name); live.set(name, request.task); return [request.task];
    },
    getTask: async (request: { name: string }) => {
      const task = live.get(request.name);
      if (!task) throw Object.assign(new Error('missing'), { code: 5 });
      return [task];
    },
    deleteTask: async (request: { name: string }) => { live.delete(request.name); return [{}]; },
  } as unknown as Pick<CloudTasksClient, 'createTask' | 'getTask' | 'deleteTask'>;
  const scheduler = new CloudTasksWakeupScheduler(config, client);
  const input: WakeupRequest = { runId: run.runId, contestId: 2273, reason: 'start',
    runAt: new Date(Date.now() + 3600_000).toISOString() };
  const first = await scheduler.schedule(input);
  assert.equal(await scheduler.schedule(input), first);
  assert.equal(live.size, 1);
  const task = live.get(first)!;
  const request = task.httpRequest as { oidcToken: { audience: string; serviceAccountEmail: string };
    body: Buffer; url: string };
  assert.equal(request.url, 'https://cf-agent-abc.run.app/internal/orchestrator/reconcile');
  assert.equal(request.oidcToken.audience, config.serviceUrl);
  assert.equal(request.oidcToken.serviceAccountEmail, config.serviceAccount);
  assert.deepEqual(JSON.parse(request.body.toString()), { runId: run.runId, contestId: 2273,
    reason: 'start', taskName: first });
  await scheduler.cancel(first);
  assert.equal(await scheduler.exists(first), false);
  const repaired = await scheduler.schedule(input);
  assert.notEqual(repaired, first);
  assert.equal(live.size, 1);
});

test('internal scheduler endpoint rejects missing or invalid OIDC before reconciliation', async () => {
  let calls = 0;
  const browser: BrowserAccess = { knownHandle: () => undefined,
    withPage: async () => { throw new Error('browser should not start'); },
    ensureLoggedIn: async () => { throw new Error('browser should not start'); },
    getSessionStatus: async () => ({ authenticated: false, handle: null, method: 'none', message: '' }) };
  const app = createApp({ host: '127.0.0.1', env: {}, internalOrchestrator: {
    verifier: { verify: async (token) => token === 'valid-oidc' },
    reconcile: async () => { calls++; },
  } }, browser);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const invoke = (token?: string, body: object = { reason: 'discovery' }, taskName?: string) => fetch(`${base}/internal/orchestrator/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(taskName ? { 'X-CloudTasks-TaskName': taskName } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await invoke()).status, 401);
    assert.equal((await invoke('bad')).status, 401);
    assert.equal(calls, 0);
    assert.equal((await invoke('valid-oidc')).status, 200);
    const taskName = 'projects/test-project/locations/us-central1/queues/cf-agent/tasks/abc123';
    const payload = { reason: 'start', runId: run.runId, contestId: 2273, taskName };
    assert.equal((await invoke('valid-oidc', payload)).status, 403);
    assert.equal((await invoke('valid-oidc', payload, taskName)).status, 200);
    assert.equal(calls, 2);
    app.locals.stopWrites();
    assert.equal((await invoke('valid-oidc')).status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('Google OIDC verifier checks audience, issuer, verified email, and exact service account', async () => {
  const audience = 'https://cf-agent-abc.run.app';
  const serviceAccount = 'cf-invoker@test-project.iam.gserviceaccount.com';
  let payload: Record<string, unknown> = { iss: 'https://accounts.google.com', aud: audience,
    email_verified: true, email: serviceAccount };
  const client = { verifyIdToken: async () => ({ getPayload: () => payload }) } as unknown as Pick<OAuth2Client, 'verifyIdToken'>;
  const verifier = new GoogleServiceAccountVerifier(audience, serviceAccount, client);
  assert.equal(await verifier.verify('opaque-test-token'), true);
  payload = { ...payload, email: 'personal@example.com' };
  assert.equal(await verifier.verify('opaque-test-token'), false);
  payload = { ...payload, email: serviceAccount, aud: 'https://other.run.app' };
  assert.equal(await verifier.verify('opaque-test-token'), false);
  payload = { ...payload, aud: audience, iss: 'https://other.example' };
  assert.equal(await verifier.verify('opaque-test-token'), false);
  payload = { ...payload, iss: 'https://accounts.google.com', email_verified: false };
  assert.equal(await verifier.verify('opaque-test-token'), false);
});
