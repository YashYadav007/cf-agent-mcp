import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SubmissionService, type SubmissionForm } from '../codeforces/submissions.js';
import { SubmissionSafety, readSubmissionSafety } from '../codeforces/safety.js';
import { SupabaseSubmissionStore } from '../storage/supabase.js';
import { FileSubmissionStore } from '../storage/submissions.js';
import type { SubmissionStore } from '../storage/types.js';
import type { BrowserAccess } from '../codeforces/browser.js';

const input = { contestId: 4, problemIndex: 'A', sourceCode: 'class Main {}' };
const session = { authenticated: true, handle: 'tester', method: 'storage_state' as const, message: 'ok' };
const browser: BrowserAccess = {
  knownHandle: () => 'tester', getSessionStatus: async () => session, ensureLoggedIn: async () => session,
  withPage: async (operation) => operation({} as Page),
};

function mockAuthorizedContests() {
  type Row = { contest_id: number; status: string; expires_at: string | null; source?: string; updated_at?: string };
  const rows = new Map<number, Row>();
  const client = {
    from: (table: string) => {
      assert.equal(table, 'authorized_contests');
      return {
        select: () => ({ eq: (_field: string, id: number) => ({ maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }) }) }),
        upsert: async (row: Row) => { rows.set(row.contest_id, row); return { error: null }; },
        update: (change: Partial<Row>) => ({ eq: (_field: string, id: number) => ({ select: () => ({ maybeSingle: async () => {
          const previous = rows.get(id);
          if (!previous) return { data: null, error: null };
          rows.set(id, { ...previous, ...change });
          return { data: { contest_id: id }, error: null };
        } }) }) }),
      };
    },
  } as unknown as SupabaseClient;
  return { rows, store: new SupabaseSubmissionStore('https://example.supabase.co', 'server-only-test-key', client) };
}

function submissionStore(authorized: () => Promise<boolean>): SubmissionStore {
  return {
    isContestAuthorized: async () => authorized(),
    get: async () => undefined, has: async () => false, put: async () => undefined,
    checkWritable: async () => undefined, reserveAttempt: async () => true, recordAttempt: async () => undefined,
  };
}
function service(store: SubmissionStore, env: NodeJS.ProcessEnv, click: () => void): SubmissionService {
  const form: SubmissionForm = {
    prepare: async () => undefined, clickOnce: async () => { click(); }, captureId: async () => 42,
  };
  return new SubmissionService(browser, store, () => form, new SubmissionSafety(readSubmissionSafety(env)));
}

test('real submissions disabled always blocks before querying contest authorization', async () => {
  let checked = false;
  const store = submissionStore(async () => { checked = true; return true; });
  await assert.rejects(service(store, {}, () => assert.fail('must not click')).submit(input), { code: 'REAL_SUBMISSIONS_DISABLED' });
  assert.equal(checked, false);
});

test('enabled submission without Supabase authorization is rejected before login or click', async () => {
  let clicks = 0;
  await assert.rejects(service(submissionStore(async () => false), { ALLOW_REAL_SUBMISSIONS: 'true' }, () => { clicks++; }).submit(input),
    { code: 'CONTEST_NOT_AUTHORIZED' });
  assert.equal(clicks, 0);
});

test('Supabase authorization requires an active, unexpired row and supports server-side transitions', async () => {
  const { rows, store } = mockAuthorizedContests();
  const blocked = async () => assert.rejects(service(submissionStore(() => store.isContestAuthorized(4)),
    { ALLOW_REAL_SUBMISSIONS: 'true' }, () => assert.fail('must not click')).submit(input), { code: 'CONTEST_NOT_AUTHORIZED' });
  assert.equal(await store.isContestAuthorized(4), false);
  await blocked();
  await store.authorizeContest({ contestId: 4, source: 'manual' });
  assert.equal(await store.isContestAuthorized(4), true);
  assert.equal(rows.get(4)?.source, 'manual');
  await store.completeContest(4);
  assert.equal(rows.get(4)?.status, 'completed');
  assert.equal(await store.isContestAuthorized(4), false);
  await blocked();
  await store.authorizeContest({ contestId: 4 });
  assert.equal(await store.isContestAuthorized(4), true);
  await store.blockContest(4);
  assert.equal(rows.get(4)?.status, 'blocked');
  assert.equal(await store.isContestAuthorized(4), false);
  await blocked();
  rows.set(4, { contest_id: 4, status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await store.isContestAuthorized(4), false);
  await blocked();
  rows.set(4, { contest_id: 4, status: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(await store.isContestAuthorized(4), true);
  assert.doesNotMatch(JSON.stringify([...rows.values()]), /server-only-test-key/);
});

test('active DB authorization works without a static allowlist and with a matching static allowlist', async () => {
  for (const staticIds of [undefined, '4,5']) {
    let clicks = 0;
    const env = { ALLOW_REAL_SUBMISSIONS: 'true', ...(staticIds ? { CF_ALLOWED_CONTEST_IDS: staticIds } : {}) };
    const result = await service(submissionStore(async () => true), env, () => { clicks++; }).submit(input);
    assert.equal(result.submissionId, 42);
    assert.equal(clicks, 1);
  }
});

test('static allowlist blocks an active DB contest when its ID is absent', async () => {
  let clicks = 0;
  await assert.rejects(service(submissionStore(async () => true), {
    ALLOW_REAL_SUBMISSIONS: 'true', CF_ALLOWED_CONTEST_IDS: '5,6',
  }, () => { clicks++; }).submit(input), { code: 'CONTEST_NOT_IN_STATIC_ALLOWLIST' });
  assert.equal(clicks, 0);
});

test('authorization is checked again before the one allowed submission click', async () => {
  let checks = 0;
  let clicks = 0;
  const store = submissionStore(async () => ++checks === 1);
  await assert.rejects(service(store, { ALLOW_REAL_SUBMISSIONS: 'true' }, () => { clicks++; }).submit(input),
    { code: 'CONTEST_NOT_AUTHORIZED' });
  assert.equal(checks, 2);
  assert.equal(clicks, 0);
});

test('authorization storage errors fail closed before any browser action', async () => {
  let clicks = 0;
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'secret DB detail' } }) }) }) }) } as unknown as SupabaseClient;
  const store = new SupabaseSubmissionStore('https://example.supabase.co', 'server-only-test-key', client);
  await assert.rejects(service(store, { ALLOW_REAL_SUBMISSIONS: 'true' }, () => { clicks++; }).submit(input),
    { code: 'STORAGE_ERROR', message: 'Persistent submission storage is unavailable.' });
  assert.equal(clicks, 0);
});

test('local file metadata alone never authorizes a contest', async () => {
  assert.equal(await new FileSubmissionStore('/unused-local-data-path').isContestAuthorized(4), false);
});
