import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from './rateLimiter.js';

test('serializes concurrent starts with the configured minimum spacing', async () => {
  const limiter = new RateLimiter(40);
  const started: number[] = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    await limiter.wait();
    started.push(Date.now());
  }));
  assert.equal(started.length, 3);
  assert.ok(started[1]! - started[0]! >= 35);
  assert.ok(started[2]! - started[1]! >= 35);
});
