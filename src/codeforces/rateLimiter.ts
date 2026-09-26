import { performance } from 'node:perf_hooks';
import { Mutex, sleep } from './async.js';

/** Shared process-wide start spacing. Queue waits and deadlines are cancellable. */
export class RateLimiter {
  private nextStart = 0;
  private readonly lock = new Mutex();
  constructor(private readonly intervalMs: number) {}
  wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const turn = this.lock.run(async () => {
      signal?.throwIfAborted();
      while (performance.now() < this.nextStart) await sleep(this.nextStart - performance.now(), signal);
      signal?.throwIfAborted();
      this.nextStart = performance.now() + this.intervalMs;
    });
    if (!signal) return turn;
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
