import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeforcesBrowser, authenticatedHandle, decodeStorageState, hasManualVerification } from '../codeforces/browser.js';
import { browserMock, header } from './fixtures.js';
import type { Browser } from 'playwright';
const state = Buffer.from(JSON.stringify({ cookies: [], origins: [] })).toString('base64');

test('session status without credentials is unauthenticated and does not launch Chromium', async () => {
  const mock = browserMock(); const browser = new CodeforcesBrowser({}, mock.launch);
  assert.equal((await browser.getSessionStatus()).method, 'none');
  await assert.rejects(browser.ensureLoggedIn(), { code: 'CF_AUTH_REQUIRED' });
  assert.equal(mock.calls.launches, 0);
});
test('valid storage state takes priority and reuses the context', async () => {
  const mock = browserMock({ html: header('tester') });
  const browser = new CodeforcesBrowser({ CF_HANDLE: 'tester', CF_PASSWORD: 'SECRET', CF_STORAGE_STATE_B64: state }, mock.launch);
  assert.deepEqual(await browser.ensureLoggedIn(), { authenticated: true, handle: 'tester', method: 'storage_state', message: 'Authenticated Codeforces session is available.' });
  await browser.getSessionStatus();
  assert.equal(mock.calls.contexts, 1); assert.equal(mock.calls.clicks, 0);
  await browser.closeBrowser(); assert.equal(mock.calls.closes, 1);
});
test('expired storage state does not fall back to credential POSTs', async () => {
  const mock = browserMock({ credentialLogin: true });
  const browser = new CodeforcesBrowser({ CF_HANDLE: 'tester', CF_PASSWORD: 'SECRET', CF_STORAGE_STATE_B64: state }, mock.launch);
  await assert.rejects(browser.ensureLoggedIn(), { code: 'SESSION_EXPIRED' });
  assert.equal(mock.calls.clicks, 0);
});
test('credentials login is verified and is never automatically retried', async () => {
  const mock = browserMock({ credentialLogin: true });
  const browser = new CodeforcesBrowser({ CF_HANDLE: 'tester', CF_PASSWORD: 'SECRET' }, mock.launch);
  assert.equal((await browser.ensureLoggedIn()).method, 'credentials');
  await browser.getSessionStatus(); assert.equal(mock.calls.clicks, 1);
  const failing = browserMock({ loginFails: true });
  const broken = new CodeforcesBrowser({ CF_HANDLE: 'tester', CF_PASSWORD: 'SECRET' }, failing.launch);
  const status = await broken.getSessionStatus();
  assert.equal(status.authenticated, false); assert.doesNotMatch(JSON.stringify(status), /DO_NOT_LEAK|SECRET/);
  await broken.getSessionStatus(); assert.equal(failing.calls.clicks, 1);
});
test('manual verification and account mismatch block authenticated actions', async () => {
  const challenge = new CodeforcesBrowser({ CF_STORAGE_STATE_B64: state }, browserMock({ html: '<title>Just a moment...</title>' }).launch);
  await assert.rejects(challenge.ensureLoggedIn(), { code: 'SESSION_REQUIRES_MANUAL_LOGIN' });
  const mismatch = new CodeforcesBrowser({ CF_HANDLE: 'tester', CF_STORAGE_STATE_B64: state }, browserMock({ html: header('another') }).launch);
  await assert.rejects(mismatch.ensureLoggedIn(), { code: 'CF_AUTH_REQUIRED' });
});
test('malformed storage state is sanitized and session detection ignores unrelated profile links', () => {
  assert.throws(() => decodeStorageState('SECRET!'), { code: 'CF_AUTH_REQUIRED' });
  assert.equal(authenticatedHandle('<a href="/profile/other">other</a>'), null);
  assert.equal(hasManualVerification('<div class="cf-turnstile"></div>'), true);
});

test('CDP mode reuses the existing context, closes only created pages, and never closes Chrome', async () => {
  const calls = { connections: 0, launches: 0, contexts: 0, pages: 0, pageCloses: 0, browserCloses: 0, contextCloses: 0, clicks: 0 };
  const page = { goto: async () => ({ status: () => 200 }), content: async () => header('tester'),
    close: async () => { calls.pageCloses++; }, locator: () => ({ click: async () => { calls.clicks++; } }) };
  const context = { newPage: async () => { calls.pages++; return page; },
    close: async () => { calls.contextCloses++; } };
  const attached = { contexts: () => [context], newContext: async () => { calls.contexts++; return context; },
    close: async () => { calls.browserCloses++; } } as unknown as Browser;
  const browser = new CodeforcesBrowser({ CF_BROWSER_CDP_URL: 'http://127.0.0.1:9222',
    CF_STORAGE_STATE_B64: state, CF_HANDLE: 'tester', CF_PASSWORD: 'SECRET', CF_EXPECTED_HANDLE: 'tester' },
  async () => { calls.launches++; return attached; }, async () => { calls.connections++; return attached; });
  assert.equal((await browser.ensureLoggedIn()).method, 'cdp');
  await browser.withPage(async () => undefined);
  assert.equal(calls.connections, 1);
  assert.equal(calls.launches, 0); assert.equal(calls.contexts, 0); assert.equal(calls.clicks, 0);
  assert.equal(calls.pages, 2); assert.equal(calls.pageCloses, 2);
  await browser.closeBrowser();
  assert.equal(calls.browserCloses, 0); assert.equal(calls.contextCloses, 0);
});

test('CDP mode rejects the wrong handle without attempting credential login', async () => {
  const page = { goto: async () => ({ status: () => 200 }), content: async () => header('personal'),
    close: async () => undefined, locator: () => { throw new Error('Login must not be automated'); } };
  const attached = { contexts: () => [{ newPage: async () => page }],
    close: () => { throw new Error('Externally owned Chrome must remain open'); } } as unknown as Browser;
  const browser = new CodeforcesBrowser({ CF_BROWSER_CDP_URL: 'http://127.0.0.1:9222',
    CF_EXPECTED_HANDLE: 'experiment', CF_PASSWORD: 'SECRET' },
  async () => { throw new Error('Headless Chrome must not launch'); }, async () => attached);
  await assert.rejects(browser.ensureLoggedIn(), { code: 'ACCOUNT_MISMATCH' });
  await browser.closeBrowser();
});

test('unavailable CDP gives local setup instructions and rejects nonlocal endpoints', async () => {
  const unavailable = new CodeforcesBrowser({ CF_BROWSER_CDP_URL: 'http://127.0.0.1:9222' },
    async () => { throw new Error('Must not launch'); }, async () => { throw new Error('SECRET'); });
  const status = await unavailable.getSessionStatus();
  assert.equal(status.authenticated, false); assert.match(status.message, /npm run session:create/);
  assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  const remote = new CodeforcesBrowser({ CF_BROWSER_CDP_URL: 'http://evil.example:9222' });
  await assert.rejects(remote.ensureLoggedIn(), { code: 'INVALID_INPUT' });
});
