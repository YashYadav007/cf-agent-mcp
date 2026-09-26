import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonSubmissionStore } from '../storage/submissions.js';
const metadata = (id: number) => ({ submissionId: id, contestId: 4, problemIndex: 'A', language: 'java17' as const, submittedAt: '2026-09-25T00:00:00.000Z' });
test('metadata survives store recreation and concurrent writes without losing entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-storage-'));
  try {
    const store = new JsonSubmissionStore(directory);
    assert.equal(await store.get(1), undefined);
    await store.checkWritable();
    const other = new JsonSubmissionStore(directory);
    await Promise.all([store.put(metadata(1)), other.put(metadata(2)), store.put(metadata(3))]);
    assert.deepEqual(await new JsonSubmissionStore(directory).get(2), metadata(2));
    assert.equal(JSON.parse(await readFile(join(directory, 'submissions.json'), 'utf8')).length, 3);
    assert.equal((await stat(join(directory, 'submissions.json'))).mode & 0o777, 0o600);
    await store.recordAttempt({ ...metadata(1), attemptId: 'fbc96388-705d-4f76-9185-7ad6d9c4c01e', state: 'uncertain', fingerprint: 'a'.repeat(64) });
    const attempt = JSON.parse(await readFile(join(directory, 'attempt-fbc96388-705d-4f76-9185-7ad6d9c4c01e.json'), 'utf8'));
    assert.equal(attempt.state, 'uncertain'); assert.equal(attempt.language, 'java17');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('empty storage works; corruption is reported without overwriting records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-storage-'));
  try {
    const file = join(directory, 'submissions.json'); const store = new JsonSubmissionStore(directory);
    await writeFile(file, ''); assert.equal(await store.get(1), undefined);
    await writeFile(file, '{broken');
    await assert.rejects(store.put(metadata(1)), { code: 'STORAGE_ERROR' });
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
