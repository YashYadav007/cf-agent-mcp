import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FileSubmissionStore } from '../storage/submissions.js';
import { SupabaseSubmissionStore, createSubmissionStore, getSupabaseAdminKey } from '../storage/supabase.js';
import { SubmissionSafety, readSubmissionSafety, isContestAllowed } from '../codeforces/safety.js';
import { SubmissionService, type SubmissionForm } from '../codeforces/submissions.js';
import type { BrowserAccess } from '../codeforces/browser.js';
import type { SubmissionAttempt, SubmissionMetadata, SubmissionStore } from '../storage/types.js';
import { hasScope } from '../auth/verifier.js';
import { readAuthSettings, requiredScope } from '../auth/middleware.js';
import { listenConfig } from '../server.js';

const input = { contestId: 4, problemIndex: 'A', sourceCode: 'class Main {}' };
const enabled = (extra: Partial<ReturnType<typeof readSubmissionSafety>> = {}) => new SubmissionSafety({ enabled: true, allowedContestIds: null, expectedHandle: null, duplicateWindowSeconds: 120, ...extra });
const session = { authenticated: true, handle: 'tester', method: 'storage_state' as const, message: 'ok' };
const browser: BrowserAccess = { knownHandle: () => 'tester', getSessionStatus: async () => session,
  ensureLoggedIn: async () => session, withPage: async (fn) => fn({} as Page) };
function memoryStore(): SubmissionStore {
  const attempts = new Map<string, SubmissionAttempt>(); const records = new Map<number, SubmissionMetadata>();
  return { isContestAuthorized: async () => true,
    get: async (id) => records.get(id), has: async (id) => records.has(id), put: async (item) => { records.set(item.submissionId, item); },
    checkWritable: async () => undefined, recordAttempt: async (item) => { attempts.set(item.attemptId, item); },
    reserveAttempt: async (item, seconds) => {
      if ([...attempts.values()].some((old) => old.fingerprint === item.fingerprint && Date.now() - Date.parse(old.submittedAt) < seconds * 1000)) return false;
      attempts.set(item.attemptId, item); return true;
    } };
}
const form = (click: () => Promise<void> = async () => undefined): SubmissionForm => ({ prepare: async () => undefined, clickOnce: click, captureId: async () => 42 });
test('safe defaults, allowlists, expected account and shutdown block before click', async () => {
  assert.equal(readSubmissionSafety({}).enabled, false);
  assert.equal(isContestAllowed(4, readSubmissionSafety({ CF_ALLOWED_CONTEST_IDS: '4,5' })), true);
  assert.equal(isContestAllowed(6, readSubmissionSafety({ CF_ALLOWED_CONTEST_IDS: '4,5' })), false);
  assert.throws(() => readSubmissionSafety({ CF_ALLOWED_CONTEST_IDS: '4,nope' }));
  let clicks = 0;
  const service = (safety: SubmissionSafety) => new SubmissionService(browser, memoryStore(), () => form(async () => { clicks++; }), safety);
  await assert.rejects(service(new SubmissionSafety(readSubmissionSafety({}))).submit(input), { code: 'REAL_SUBMISSIONS_DISABLED' });
  await assert.rejects(service(enabled({ allowedContestIds: new Set([5]) })).submit(input), { code: 'CONTEST_NOT_IN_STATIC_ALLOWLIST' });
  await assert.rejects(service(enabled({ expectedHandle: 'personal' })).submit(input), { code: 'ACCOUNT_MISMATCH' });
  const stopping = service(enabled()); stopping.stopWrites();
  await assert.rejects(stopping.submit(input), { code: 'WRITE_BUSY' });
  assert.equal(clicks, 0);
});
test('duplicate request is rejected, concurrent write is busy, each accepted invocation clicks once', async () => {
  let clicks = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new SubmissionService(browser, memoryStore(), () => form(async () => { clicks++; await gate; }), enabled());
  const first = service.submit(input);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.submit(input), { code: 'WRITE_BUSY' });
  release(); await first;
  await assert.rejects(service.submit(input), { code: 'DUPLICATE_SUBMISSION_REQUEST' });
  assert.equal(clicks, 1);
});
test('file store persists metadata and atomic duplicate reservation across instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-phase3-'));
  try {
    const first = new FileSubmissionStore(directory); const second = new FileSubmissionStore(directory);
    const attempt: SubmissionAttempt = { attemptId: 'fbc96388-705d-4f76-9185-7ad6d9c4c01e', contestId: 4, problemIndex: 'A', language: 'java17', submittedAt: new Date().toISOString(), state: 'prepared', fingerprint: 'b'.repeat(64) };
    assert.equal(await first.reserveAttempt(attempt, 120), true);
    assert.equal(await second.reserveAttempt({ ...attempt, attemptId: 'c96b3d3d-0614-4a51-aa51-ac8aa441c25f' }, 120), false);
    assert.equal(await first.has(42), false);
    await first.put({ submissionId: 42, contestId: 4, problemIndex: 'A', language: 'java17', submittedAt: attempt.submittedAt });
    assert.equal(await second.has(42), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Supabase store maps metadata and reservations without exposing service key', async () => {
  const rows: Record<string, unknown>[] = [];
  const client = { from: () => ({
    select: () => ({ eq: (_field: string, id: number) => ({ maybeSingle: async () => ({ data: rows.find((r) => r.submission_id === id) ?? null, error: null }) }), limit: async () => ({ error: null }) }),
    upsert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
  }), rpc: async () => ({ data: true, error: null }) } as unknown as SupabaseClient;
  const store = new SupabaseSubmissionStore('https://example.supabase.co', 'never-log-me', client);
  await store.checkWritable();
  await store.put({ submissionId: 42, contestId: 4, problemIndex: 'A', language: 'java17', submittedAt: new Date().toISOString() });
  assert.equal((await store.get(42))?.submissionId, 42); assert.equal(await store.has(42), true);
  const attempt: SubmissionAttempt = { attemptId: 'fbc96388-705d-4f76-9185-7ad6d9c4c01e', contestId: 4, problemIndex: 'A', language: 'java17', submittedAt: new Date().toISOString(), state: 'prepared', fingerprint: 'a'.repeat(64) };
  assert.equal(await store.reserveAttempt(attempt, 120), true);
  await store.recordAttempt({ ...attempt, state: 'confirmed', submissionId: 42 });
  assert.equal(rows.at(-1)?.submission_id, 42);
  assert.ok(createSubmissionStore({ DATA_DIR: '/tmp' }) instanceof FileSubmissionStore);
  assert.ok(createSubmissionStore({ SUPABASE_URL: 'https://example.supabase.co' }) instanceof FileSubmissionStore);
  assert.equal(getSupabaseAdminKey({ SUPABASE_SECRET_KEY: 'sb_secret_server-only' }), 'sb_secret_server-only');
  assert.throws(() => getSupabaseAdminKey({ SUPABASE_SECRET_KEY: 'sb_publishable_public' }), /publishable/);
  assert.throws(() => createSubmissionStore({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_public' }), /publishable/);
});
test('OAuth scope parsing and production PORT configuration', () => {
  assert.equal(requiredScope({ method: 'tools/call', params: { name: 'submit_solution' } }), 'cf.submit');
  assert.equal(requiredScope({ method: 'tools/call', params: { name: 'register_contest' } }), 'cf.submit');
  assert.equal(requiredScope({ method: 'tools/call', params: { name: 'get_problem' } }), 'cf.read');
  assert.equal(hasScope({ subject: 'x', scopes: new Set(['cf.read']) }, 'cf.submit'), false);
  assert.equal(readAuthSettings({}).mode, 'disabled');
  assert.throws(() => readAuthSettings({ AUTH_MODE: 'oauth' }));
  assert.deepEqual(listenConfig({ NODE_ENV: 'production' }), { host: '0.0.0.0', port: 8080, timeoutMs: 15000 });
  assert.equal(listenConfig({ PORT: '9000' }).port, 9000);
});
