import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeforcesError, publicError } from '../codeforces/errors.js';
import { failure } from '../tools/shared.js';
import { CodeforcesApi } from '../codeforces/api.js';
import { RateLimiter } from '../codeforces/rateLimiter.js';

test('structured errors include retryable and unknown failures cannot leak browser secrets', () => {
  assert.deepEqual(publicError(new CodeforcesError('Try later.', 'CF_RATE_LIMITED', true)), { code: 'CF_RATE_LIMITED', message: 'Try later.', retryable: true });
  const result = failure(new Error('password=SECRET cookie=SECRET source=SECRET'));
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal((result.structuredContent as { error: { retryable: boolean } }).error.retryable, false);
});
test('API retries safe GET and counts every attempt through the same limiter', async () => {
  let attempts = 0; let gates = 0;
  const fakeFetch: typeof fetch = async (_url, options) => {
    assert.equal(options?.method, undefined);
    return ++attempts === 1 ? new Response('{}', { status: 503 }) : Response.json({ status: 'OK', result: [] });
  };
  const api = new CodeforcesApi(1000, fakeFetch, { wait: async () => { gates++; } });
  assert.deepEqual(await api.contests(false), []); assert.equal(attempts, 2); assert.equal(gates, 2);
});
test('long Retry-After is surfaced and API comments are sanitized', async () => {
  const api = new CodeforcesApi(1000, async () => new Response('{}', { status: 429, headers: { 'Retry-After': '300' } }), { wait: async () => undefined });
  await assert.rejects(api.contests(false), { code: 'CF_RATE_LIMITED', retryable: true });
  const denied = new CodeforcesApi(1000, async () => Response.json({ status: 'FAILED', comment: 'password=SECRET' }), { wait: async () => undefined });
  await assert.rejects(denied.contests(false), (error: unknown) => { assert.doesNotMatch(String(error), /SECRET/); return true; });
});
test('an aborted queued request never consumes an API start', async () => {
  const limiter = new RateLimiter(80);
  await limiter.wait();
  const controller = new AbortController();
  const canceled = limiter.wait(controller.signal);
  controller.abort();
  await assert.rejects(canceled);
  const start = Date.now(); await limiter.wait();
  assert.ok(Date.now() - start >= 65);
});
