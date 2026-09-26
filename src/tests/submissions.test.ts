import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { SubmissionSafety } from '../codeforces/safety.js';
import { resolveJava17, submitInput, validateJavaSource, identifyNewSubmission, parseOwnSubmissionRows, SubmissionService, type SubmissionForm } from '../codeforces/submissions.js';
import type { BrowserAccess } from '../codeforces/browser.js';
import type { SubmissionStore, SubmissionMetadata, SubmissionAttempt } from '../storage/types.js';
import { CodeforcesError } from '../codeforces/errors.js';
const enabled = () => new SubmissionSafety({ enabled: true, allowedContestIds: null, expectedHandle: null, duplicateWindowSeconds: 120 });
const input = { contestId: 4, problemIndex: 'A', sourceCode: 'public class Main { }' };
const session = { authenticated: true, handle: 'tester', method: 'storage_state' as const, message: 'ok' };
const browser: BrowserAccess = { ensureLoggedIn: async () => session, getSessionStatus: async () => session,
  knownHandle: () => 'tester', withPage: async (operation) => operation({} as Page) };
function memoryStore() {
  const records: SubmissionMetadata[] = []; const attempts: SubmissionAttempt[] = [];
  const store: SubmissionStore = { isContestAuthorized: async () => true,
    has: async (id) => records.some((s) => s.submissionId === id), reserveAttempt: async (a) => { attempts.push(a); return true; }, get: async (id) => records.find((s) => s.submissionId === id), put: async (r) => { records.push(r); },
    checkWritable: async () => undefined, recordAttempt: async (a) => { attempts.push(a); } };
  return { store, records, attempts };
}
test('Java 17 is resolved by label with changed IDs; other languages and ambiguity rejected', () => {
  assert.equal(resolveJava17([{ value: '999', label: 'Java 17 64bit' }, { value: '2', label: 'Java 21' }]), '999');
  assert.equal(resolveJava17([{ value: '123', label: 'Java OpenJDK 17.0.1' }]), '123');
  for (const label of ['Java 8', 'Java 11', 'Java 21', 'Java 170', 'Kotlin 1.7', 'C++17', 'Python 3']) {
    assert.throws(() => resolveJava17([{ value: '1', label }]), { code: 'JAVA17_NOT_AVAILABLE' });
  }
  assert.throws(() => resolveJava17([{ value: '1', label: 'Java 17' }, { value: '2', label: 'OpenJDK 17' }]), { code: 'JAVA17_NOT_AVAILABLE' });
  assert.equal(submitInput.safeParse({ ...input, language: 'python' }).success, false);
  assert.equal(submitInput.safeParse({ ...input, language: 'java17' }).success, false);
});
test('Java source stays opaque apart from line ending normalization and basic size/class validation', () => {
  const source = 'public class Main {\r\n  // no rewrite\r\n}';
  assert.equal(validateJavaSource(source), source.replace(/\r\n/g, '\n'));
  for (const source of ['', '  ', 'System.out.println(1);', 'class Main {}' + 'x'.repeat(262144)]) assert.throws(() => validateJavaSource(source), { code: 'INVALID_INPUT' });
});
test('captures only a unique new own Java 17 submission, without opening source links', () => {
  const row = (id: number, who: string, lang: string) => `<tr data-submission-id="${id}"><td><a href="/contest/4/submission/${id}">${id}</a></td><td><a href="/profile/${who}">${who}</a></td><td><a href="/contest/4/problem/A">A</a></td><td>${lang}</td></tr>`;
  const html = `<table><tr><th>#</th><th>Who</th><th>Problem</th><th>Lang</th></tr>${row(90,'tester','Java 17')}${row(91,'other','Java 17')}${row(92,'tester','Java 21')}</table>`;
  const records = parseOwnSubmissionRows(html, 'tester');
  assert.equal(records.length, 2);
  assert.equal(identifyNewSubmission([], records, input), 90);
  assert.equal(identifyNewSubmission(records, records, input), undefined);
  assert.throws(() => identifyNewSubmission([], [...records, { ...records[0]!, id: 93 }], input), { code: 'SUBMISSION_STATE_UNCERTAIN' });
});
test('successful explicit invocation clicks once and persists submission and attempt metadata', async () => {
  const { store, records, attempts } = memoryStore(); let clicks = 0;
  const form: SubmissionForm = { prepare: async () => undefined, clickOnce: async () => { clicks++; }, captureId: async () => 100 };
  const service = new SubmissionService(browser, store, () => form, enabled());
  const result = await service.submit(input);
  assert.equal(clicks, 1); assert.equal(result.submitted, true); assert.equal(result.language, 'java17');
  assert.equal(records[0]?.submissionId, 100); assert.deepEqual(attempts.map((a) => a.state), ['prepared', 'confirmed']);
  assert.doesNotMatch(JSON.stringify(attempts), /sourceCode|public class/);
});
test('click errors, lost confirmations, and post-submit storage failures never retry', async () => {
  for (const stage of ['click', 'capture', 'storage']) {
    const { store, attempts } = memoryStore(); let clicks = 0;
    if (stage === 'storage') store.put = async () => { throw new Error('disk failure'); };
    const form: SubmissionForm = { prepare: async () => undefined,
      clickOnce: async () => { clicks++; if (stage === 'click') throw new Error('network lost source=SECRET'); },
      captureId: async () => { if (stage === 'capture') throw new Error('timeout'); return 100; },
    };
    await assert.rejects(new SubmissionService(browser, store, () => form, enabled()).submit(input), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'SUBMISSION_STATE_UNCERTAIN');
      assert.doesNotMatch(String(error), /SECRET/); return true;
    });
    assert.equal(clicks, 1); assert.equal(attempts.at(-1)?.state, 'uncertain');
  }
});
test('a preflight storage failure prevents any real submit action', async () => {
  const { store } = memoryStore(); let clicks = 0;
  store.checkWritable = async () => { throw new Error('disk unavailable'); };
  const form: SubmissionForm = { prepare: async () => undefined, clickOnce: async () => { clicks++; }, captureId: async () => 1 };
  await assert.rejects(new SubmissionService(browser, store, () => form, enabled()).submit(input)); assert.equal(clicks, 0);
});
test('manual challenge before the submit click records a safe recovery marker with zero clicks', async () => {
  const { store } = memoryStore(); let clicks = 0; const markers: Array<[number, string]> = [];
  store.recordAuthInterruption = async (contestId, index) => { markers.push([contestId, index]); };
  const form: SubmissionForm = { prepare: async () => { throw new CodeforcesError('manual verification', 'SESSION_REQUIRES_MANUAL_LOGIN'); },
    clickOnce: async () => { clicks++; }, captureId: async () => 1 };
  await assert.rejects(new SubmissionService(browser, store, () => form, enabled()).submit(input),
    { code: 'SESSION_REQUIRES_MANUAL_LOGIN' });
  assert.equal(clicks, 0); assert.deepEqual(markers, [[4, 'A']]);
});
test('manual challenge after the sole submit click records recovery and remains uncertain', async () => {
  const { store, attempts } = memoryStore(); let clicks = 0; const markers: Array<[number, string]> = [];
  store.recordAuthInterruption = async (contestId, index) => { markers.push([contestId, index]); };
  const form: SubmissionForm = { prepare: async () => undefined, clickOnce: async () => { clicks++; },
    captureId: async () => { throw new CodeforcesError('manual verification', 'SESSION_REQUIRES_MANUAL_LOGIN'); } };
  await assert.rejects(new SubmissionService(browser, store, () => form, enabled()).submit(input),
    { code: 'SUBMISSION_STATE_UNCERTAIN' });
  assert.equal(clicks, 1); assert.deepEqual(markers, [[4, 'A']]);
  assert.equal(attempts.at(-1)?.state, 'uncertain');
});
