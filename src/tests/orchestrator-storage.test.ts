import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contest } from '../codeforces/types.js';
import { newExperimentRun } from '../orchestrator/watcher.js';
import { SupabaseOrchestratorStore } from '../storage/orchestrator.js';

test('Supabase watcher lease and version checks reject a competing pass', async () => {
  let row: Record<string, unknown> | null = null;
  const client = { from: (table: string) => {
    assert.equal(table, 'cf_contest_runs');
    const filters = new Map<string, unknown>();
    let patch: Record<string, unknown> | null = null;
    let leaseCutoff: number | null = null;
    const query = {
      select: (_columns: string) => query,
      eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
      or: (predicate: string) => { leaseCutoff = Date.parse(predicate.split('lease_expires_at.lt.')[1]!); return query; },
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      maybeSingle: async () => {
        if (!row || row.contest_id !== filters.get('contest_id')) return { data: null, error: null };
        if (patch) {
          if (row.version !== filters.get('version') ||
              (filters.has('lease_owner') && row.lease_owner !== filters.get('lease_owner')) ||
              (leaseCutoff !== null && row.lease_expires_at && Date.parse(String(row.lease_expires_at)) >= leaseCutoff))
            return { data: null, error: null };
          row = { ...row, ...patch };
        }
        return { data: structuredClone(row), error: null };
      },
      insert: async (value: Record<string, unknown>) => {
        if (row) return { error: { code: '23505' } };
        row = structuredClone(value); return { error: null };
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  const store = new SupabaseOrchestratorStore('https://example.supabase.co', 'server-only-test-key', client);
  const contest: Contest = { id: 2273, name: 'Codeforces Round (Div. 1)', type: 'CF', phase: 'BEFORE',
    frozen: false, durationSeconds: 7200, startTimeSeconds: 1925092800 };
  const initial = newExperimentRun(contest, 'testaccount', 2051);
  assert.equal(await store.create(initial), true);
  assert.equal(await store.create(initial), false);
  const now = new Date('2030-10-01T12:00:00.000Z');
  const claimed = await store.claim(2273, 'owner-one', now);
  assert.equal(claimed?.leaseOwner, 'owner-one');
  assert.equal(await store.claim(2273, 'owner-two', now), undefined);
  const wakeupAt = '2030-10-01T13:00:00.000Z';
  const taskName = 'projects/test-project/locations/us-central1/queues/cf-agent/tasks/abc123';
  const saved = await store.save({ ...claimed!, state: 'WAITING_FOR_REGISTRATION',
    nextReconcileAt: wakeupAt, nextReconcileReason: 'registration', scheduledTaskName: taskName });
  assert.equal(saved.version, claimed!.version + 1);
  assert.equal(saved.nextReconcileAt, wakeupAt);
  assert.equal(saved.nextReconcileReason, 'registration');
  assert.equal(saved.scheduledTaskName, taskName);
  await assert.rejects(store.save({ ...claimed!, state: 'REGISTERED' }), { code: 'RUN_VERSION_CONFLICT' });
  assert.equal((await store.get(2273))?.state, 'WAITING_FOR_REGISTRATION');
});
