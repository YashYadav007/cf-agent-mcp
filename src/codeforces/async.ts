import { setTimeout } from 'node:timers/promises';

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await setTimeout(Math.max(0, ms), undefined, { signal });
}

/** One process owns the browser/account and its JSON store. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.then(operation);
    this.tail = current.catch(() => undefined);
    return current;
  }
}
