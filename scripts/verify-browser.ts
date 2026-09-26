/** Offline browser integration: ALL network requests are fulfilled or aborted by mocks. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SubmissionSafety } from '../src/codeforces/safety.js';
import { SubmissionService } from '../src/codeforces/submissions.js';
import type { BrowserAccess } from '../src/codeforces/browser.js';
import type { SubmissionMetadata, SubmissionStore } from '../src/storage/types.js';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
let posts = 0;
const saved: SubmissionMetadata[] = [];
const account = '<div id="header"><a href="/profile/tester">tester</a><a href="/logout">Logout</a></div>';
const statusHtml = () => `${account}<table class="status-frame-datatable"><tr><th>#</th><th>Who</th><th>Problem</th><th>Lang</th></tr>
<tr data-submission-id="${posts ? 100 : 90}"><td>${posts ? 100 : 90}</td><td><a href="/profile/tester">tester</a></td><td><a href="/contest/4/problem/A">A</a></td><td>Java 17 64bit</td></tr></table>`;
await context.route('**/*', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === '/contest/4/my' && request.method() === 'GET') {
    await route.fulfill({ contentType: 'text/html', body: statusHtml() }); return;
  }
  if (path === '/contest/4/submit' && request.method() === 'GET') {
    await route.fulfill({ contentType: 'text/html', body: `${account}<form action="/contest/4/submit" method="post">
      <select name="submittedProblemIndex"><option value="B">B</option><option value="A">A</option></select>
      <select name="programTypeId"><option value="2">Java 21</option><option value="999">Java 17 64bit</option></select>
      <textarea name="source"></textarea><input type="submit" value="Submit"></form>` }); return;
  }
  if (path === '/contest/4/submit' && request.method() === 'POST') {
    posts++;
    const fields = new URLSearchParams(request.postData() ?? '');
    assert.equal(fields.get('programTypeId'), '999');
    assert.equal(fields.get('submittedProblemIndex'), 'A');
    assert.equal(fields.get('source'), 'public class Main { }');
    await route.fulfill({ contentType: 'text/html', body: statusHtml() }); return;
  }
  // This test has no route.continue: nothing can reach Codeforces or any other website.
  await route.abort();
});
const session = { authenticated: true, handle: 'tester', method: 'storage_state' as const, message: 'mock' };
const access: BrowserAccess = {
  knownHandle: () => 'tester', ensureLoggedIn: async () => session, getSessionStatus: async () => session,
  withPage: async (operation) => { const page = await context.newPage(); try { return await operation(page); } finally { await page.close(); } },
};
const store: SubmissionStore = { isContestAuthorized: async () => true, has: async () => false, reserveAttempt: async () => true, get: async (id) => saved.find((r) => r.submissionId === id), put: async (record) => { saved.push(record); }, checkWritable: async () => undefined, recordAttempt: async () => undefined };
try {
  const result = await new SubmissionService(access, store, undefined, new SubmissionSafety({ enabled: true, allowedContestIds: null, expectedHandle: null, duplicateWindowSeconds: 120 })).submit({ contestId: 4, problemIndex: 'A', sourceCode: 'public class Main { }' });
  assert.equal(posts, 1); assert.equal(result.submissionId, 100); assert.equal(saved.length, 1);
  console.log('PASS: headless Chromium; mocked Java 17 form; exactly one intercepted POST; captured/persisted ID. No upstream requests.');
} finally { await browser.close(); }
