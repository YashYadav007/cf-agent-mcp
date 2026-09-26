import { mkdir, readFile, readdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { Mutex } from '../codeforces/async.js';
import { CodeforcesError } from '../codeforces/errors.js';
import type { SubmissionAttempt, SubmissionMetadata, SubmissionRecoveryStore, SubmissionStore } from './types.js';

const metadataSchema = z.object({
  submissionId: z.number().int().positive().safe(), contestId: z.number().int().positive().safe(),
  problemIndex: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/), language: z.literal('java17'),
  submittedAt: z.iso.datetime(),
});
const locks = new Map<string, Mutex>();

/** Atomic replacement, strict corruption detection, serialized read-modify-write. Single-process store. */
export class FileSubmissionStore implements SubmissionStore, SubmissionRecoveryStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly lock: Mutex;
  constructor(directory = process.env.DATA_DIR || './data') {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'submissions.json');
    this.lock = locks.get(this.path) ?? new Mutex();
    locks.set(this.path, this.lock);
  }

  // Local metadata cannot authorize a real contest. Only the Supabase store can.
  async isContestAuthorized(_contestId: number): Promise<boolean> { return false; }

  private async read(): Promise<SubmissionMetadata[]> {
    try {
      const text = await readFile(this.path, 'utf8');
      return text.trim() ? z.array(metadataSchema).parse(JSON.parse(text)) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CodeforcesError('Submission metadata could not be read. Check DATA_DIR and file integrity.', 'STORAGE_ERROR');
    }
  }

  private async write(records: SubmissionMetadata[]): Promise<void> {
    const temporary = join(this.directory, `.submissions-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(records, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } catch {
      throw new CodeforcesError('Submission metadata could not be saved. Check DATA_DIR permissions and free space.', 'STORAGE_ERROR');
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  get(id: number): Promise<SubmissionMetadata | undefined> {
    return this.lock.run(async () => (await this.read()).find((record) => record.submissionId === id));
  }
  async has(id: number): Promise<boolean> { return (await this.get(id)) !== undefined; }

  findForProblem(contestId: number, problemIndex: string): Promise<SubmissionMetadata[]> {
    return this.lock.run(async () => (await this.read()).filter((record) =>
      record.contestId === contestId && record.problemIndex.toUpperCase() === problemIndex.toUpperCase()));
  }

  findAttemptsForProblem(contestId: number, problemIndex: string): Promise<SubmissionAttempt[]> {
    return this.lock.run(async () => {
      const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw new CodeforcesError('Submission attempt metadata could not be read.', 'STORAGE_ERROR');
      });
      const results: SubmissionAttempt[] = [];
      for (const name of entries.filter((value) => /^attempt-[\w-]+\.json$/.test(value))) {
        try {
          const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as SubmissionAttempt;
          if (record.contestId === contestId && record.problemIndex.toUpperCase() === problemIndex.toUpperCase()) results.push(record);
        } catch { throw new CodeforcesError('Submission attempt metadata is corrupt.', 'STORAGE_ERROR'); }
      }
      return results;
    });
  }

  checkWritable(): Promise<void> {
    return this.lock.run(async () => this.write(await this.read()));
  }

  put(metadata: SubmissionMetadata): Promise<void> {
    return this.lock.run(async () => {
      const parsed = metadataSchema.safeParse(metadata);
      if (!parsed.success) throw new CodeforcesError('Invalid submission metadata.', 'INVALID_INPUT');
      const records = (await this.read()).filter((entry) => entry.submissionId !== metadata.submissionId);
      records.push(parsed.data);
      await this.write(records);
    });
  }

  recordAttempt(attempt: SubmissionAttempt): Promise<void> {
    return this.lock.run(async () => {
      await this.writeAttempt(attempt);
    });
  }

  async reserveAttempt(attempt: SubmissionAttempt, windowSeconds: number): Promise<boolean> {
    return this.lock.run(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }).catch(() => { throw new CodeforcesError('Could not prepare submission storage.', 'STORAGE_ERROR'); });
      const entries = await readdir(this.directory);
      for (const name of entries.filter((name) => /^attempt-[\w-]+\.json$/.test(name))) {
        let previous: SubmissionAttempt;
        try { previous = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as SubmissionAttempt; }
        catch { throw new CodeforcesError('Submission attempt metadata is corrupt.', 'STORAGE_ERROR'); }
        if (previous.fingerprint === attempt.fingerprint && Date.now() - Date.parse(previous.submittedAt) < windowSeconds * 1000) return false;
      }
      await this.writeAttempt(attempt);
      return true;
    });
  }

  private async writeAttempt(attempt: SubmissionAttempt): Promise<void> {
    const parsed = metadataSchema.omit({ submissionId: true }).extend({
      attemptId: z.uuid(), state: z.enum(['prepared', 'confirmed', 'uncertain']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      submissionId: z.number().int().positive().safe().optional(),
    }).safeParse(attempt);
    if (!parsed.success) throw new CodeforcesError('Invalid submission attempt metadata.', 'INVALID_INPUT');
    const temporary = join(this.directory, `.attempt-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(parsed.data) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, `attempt-${parsed.data.attemptId}.json`));
    } catch { throw new CodeforcesError('Could not persist submission attempt metadata.', 'STORAGE_ERROR'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}

export { FileSubmissionStore as JsonSubmissionStore };
