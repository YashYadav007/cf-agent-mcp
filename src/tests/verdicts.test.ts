import test from 'node:test';
import assert from 'node:assert/strict';
import { VerdictService, normalizeVerdict, isFinalVerdict } from '../codeforces/verdicts.js';
import type { CodeforcesApi } from '../codeforces/api.js';
import type { Submission } from '../codeforces/types.js';
import { CodeforcesError } from '../codeforces/errors.js';
const metadata = { submissionId: 20, contestId: 4, problemIndex: 'A', language: 'java17' as const, submittedAt: '2026-09-25T00:00:00.000Z' };
const store = { get: async () => metadata };
const record = (verdict?: string): Submission => ({ id: 20, contestId: 4, problem: { contestId: 4, index: 'A', name: 'Example', type: 'PROGRAMMING', tags: [] }, programmingLanguage: 'Java 17', verdict, passedTestCount: 2, timeConsumedMillis: 10, memoryConsumedBytes: 1024 });
test('verdict normalization preserves real values and safely handles missing fields', () => {
  const minimal = normalizeVerdict({ id: 20 });
  assert.equal(minimal.verdict, null); assert.equal(minimal.passedTestCount, null); assert.equal(minimal.contestId, null);
  const value = normalizeVerdict(record('TESTING'));
  assert.equal(value.verdict, 'TESTING'); assert.equal(value.problemIndex, 'A'); assert.equal(value.timeConsumedMillis, 10);
  assert.throws(() => normalizeVerdict({}), { code: 'CF_API_ERROR' });
});
test('only known final verdicts terminate polling', () => {
  for (const verdict of ['OK', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'PARTIAL', 'FAILED']) assert.equal(isFinalVerdict(verdict), true);
  for (const verdict of [null, undefined, 'TESTING', 'SUBMITTED', 'QUEUED', 'NEW_UNKNOWN_STATUS', '']) assert.equal(isFinalVerdict(verdict), false);
});
test('metadata determines contest and configured handle filters contest.status', async () => {
  const api: Pick<CodeforcesApi, 'submissionPage'> = { submissionPage: async (params) => {
    assert.equal(params.contestId, 4); assert.equal(params.handle, 'tester'); return [record('TESTING')];
  } };
  const service = new VerdictService(api, store, () => 'tester');
  assert.equal((await service.get({ submissionId: 20 })).verdict, 'TESTING');
  await assert.rejects(service.get({ submissionId: 20, contestId: 5 }), { code: 'INVALID_INPUT' });
});
test('unknown contest uses account history and explicit contest works without a handle', async () => {
  let paramsSeen: unknown;
  const api: Pick<CodeforcesApi, 'submissionPage'> = { submissionPage: async (params) => { paramsSeen = params; return [record('OK')]; } };
  const empty = { get: async () => undefined };
  const service = new VerdictService(api, empty, () => 'tester');
  assert.equal((await service.get({ submissionId: 20 })).contestId, 4);
  assert.equal((paramsSeen as { contestId?: number }).contestId, undefined);
  await new VerdictService(api, empty, () => undefined).get({ submissionId: 20, contestId: 4 });
  await assert.rejects(new VerdictService(api, empty, () => undefined).get({ submissionId: 20 }), { code: 'SUBMISSION_NOT_FOUND' });
});
test('contest API access failure can fall back to account API, with no global recent lookup', async () => {
  let calls = 0;
  const api: Pick<CodeforcesApi, 'submissionPage'> = { submissionPage: async (params) => {
    calls++; if (params.contestId) throw new CodeforcesError('hidden', 'CF_API_ERROR'); return [record('OK')];
  } };
  assert.equal((await new VerdictService(api, store, () => 'tester').get({ submissionId: 20 })).verdict, 'OK');
  assert.equal(calls, 2);
});
test('wait returns promptly on final verdict and refuses timeouts above 120 seconds', async () => {
  let calls = 0;
  const api: Pick<CodeforcesApi, 'submissionPage'> = { submissionPage: async () => [record(++calls === 1 ? 'TESTING' : 'OK')] };
  const service = new VerdictService(api, store, () => 'tester', 10);
  const result = await service.wait({ submissionId: 20, timeoutSeconds: 1 });
  assert.equal(result.final, true); assert.equal(result.timedOut, false); assert.equal(calls, 2);
  await assert.rejects(service.wait({ submissionId: 20, timeoutSeconds: 121 }), { code: 'INVALID_INPUT' });
});
test('deadline cancels in-flight API work and returns last known submission fields', async () => {
  let calls = 0;
  const api: Pick<CodeforcesApi, 'submissionPage'> = { submissionPage: async (_params, signal) => {
    calls++; if (calls === 1) return [record('TESTING')];
    return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
  } };
  const service = new VerdictService(api, store, () => 'tester', 10);
  // Keep a referenced timer while the mocked transport waits on AbortSignal.timeout.
  const keepAlive = setTimeout(() => undefined, 2000);
  const start = Date.now();
  try {
    const result = await service.wait({ submissionId: 20, timeoutSeconds: 1 });
    assert.equal(result.final, false); assert.equal(result.timedOut, true); assert.equal(result.submission.verdict, 'TESTING');
    assert.ok(Date.now() - start < 1500);
  } finally { clearTimeout(keepAlive); }
});
