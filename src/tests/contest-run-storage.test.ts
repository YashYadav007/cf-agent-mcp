import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createContestRun, recordSubmissionAttempt, startContestRun } from '../contest/run.js';
import { SupabaseContestRunStore } from '../storage/contestRuns.js';

test('Supabase run state reloads after restart and rejects stale version updates', async () => {
  const rows = new Map<number, Record<string, unknown>>();
  const client = { from: (table: string) => {
    assert.equal(table, 'cf_contest_runs');
    let operation: 'read' | 'update' = 'read';
    let patch: Record<string, unknown> = {};
    const filters = new Map<string, unknown>();
    const query = {
      select: (_columns: string) => query,
      eq: (column: string, value: unknown) => { filters.set(column, value); return query; },
      maybeSingle: async () => {
        const id = Number(filters.get('contest_id'));
        const row = rows.get(id);
        if (operation === 'update') {
          if (!row || row.version !== filters.get('version')) return { data: null, error: null };
          rows.set(id, { ...row, ...patch });
          return { data: { contest_id: id }, error: null };
        }
        return { data: row ? structuredClone(row) : null, error: null };
      },
      update: (value: Record<string, unknown>) => { operation = 'update'; patch = value; return query; },
      insert: async (value: Record<string, unknown>) => {
        const id = Number(value.contest_id);
        if (rows.has(id)) return { error: { message: 'duplicate' } };
        rows.set(id, structuredClone(value));
        return { error: null };
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  const first = new SupabaseContestRunStore('https://example.supabase.co', 'server-only-test-key', client);
  const initial = createContestRun(2268, ['A', 'B', 'C', 'D', 'E'].map((index) => ({ index })));
  await first.create(initial);
  const restarted = new SupabaseContestRunStore('https://example.supabase.co', 'server-only-test-key', client);
  const loaded = await restarted.get(2268);
  assert.deepEqual(loaded?.problemOrder, ['A', 'B', 'C', 'D']);
  const advanced = recordSubmissionAttempt(startContestRun(loaded!, '2026-09-26T00:00:00Z'), 'A');
  await restarted.save(advanced);
  const reloaded = await first.get(2268);
  assert.equal(reloaded?.version, 1);
  assert.deepEqual(reloaded?.distinctProblemsStarted, ['A']);
  assert.equal(reloaded?.submissionAttempts.A, 1);
  await assert.rejects(first.save(initial), { code: 'RUN_VERSION_CONFLICT' });
  assert.deepEqual((await first.get(2268))?.distinctProblemsStarted, ['A']);
});
