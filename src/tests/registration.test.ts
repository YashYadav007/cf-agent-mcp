import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { BrowserAccess } from '../codeforces/browser.js';
import type { CodeforcesApi } from '../codeforces/api.js';
import { ContestRegistrationService, discoverContestPage, discoverRegistrationLink, parseRegistrationPage } from '../codeforces/registration.js';
import type { Contest } from '../codeforces/types.js';
import { header } from './fixtures.js';

const contestId = 4;
const input = { contestId };
const contest: Contest = { id: contestId, name: 'Codeforces Round 1 (Div. 1)', type: 'CF', phase: 'BEFORE', frozen: false,
  durationSeconds: 7200, startTimeSeconds: Math.floor(Date.now() / 1000) + 86_400 };
const pageHtml = (content: string, handle = 'tester') => `<html><body>${header(handle)}<div id="pageContent">${content}</div></body></html>`;
const openForm = pageHtml('<form action="/contestRegistration/4" method="post"><input type="hidden" name="csrf_token" value="DO_NOT_LOG"><input type="submit" value="Register"></form>');
const registered = pageHtml('<p>You are registered for this contest.</p>');
const listing = pageHtml('<a href="/contestRegistration/4?backUrl=%2Fcontests%2F3%2C4">Register</a>');

function setup(options: { before?: string; after?: string; listing?: string; combined?: string; redirectTo?: string; registrationStatus?: number;
  clickError?: boolean; handle?: string; sessionHandle?: string; contests?: Contest[]; postRequests?: number } = {}) {
  const events = { clicks: 0, gotos: [] as string[], routes: 0, postsAllowed: 0, postsAborted: 0, auth: 0, api: 0 };
  let html = options.before ?? openForm;
  let currentUrl = '';
  let routeHandler: ((route: { request(): { method(): string; url(): string }; abort(): Promise<void>; fallback(): Promise<void> }) => Promise<void>) | undefined;
  const page = {
    goto: async (url: string) => { events.gotos.push(url);
      currentUrl = url.startsWith('https://codeforces.com/contestRegistration/') && options.redirectTo ? options.redirectTo : url;
      html = new URL(url).pathname === '/contests' ? (options.listing ?? listing) :
        /^\/contests\/\d+(?:,\d+)+$/.test(new URL(url).pathname) ? (options.combined ?? pageHtml('')) :
        (events.clicks && options.after ? options.after : options.before ?? openForm);
      return { status: () => new URL(url).pathname.startsWith('/contestRegistration/') ? (options.registrationStatus ?? 200) : 200 }; },
    url: () => currentUrl,
    content: async () => html,
    route: async (_pattern: string, handler: typeof routeHandler) => { events.routes++; routeHandler = handler; },
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      assert.equal(selector, 'form');
      return { nth: (_formIndex: number) => ({ locator: (buttonSelector: string) => {
        assert.equal(buttonSelector, 'button:not([type]),button[type="submit"],input[type="submit"]');
        return { nth: (_buttonIndex: number) => ({ click: async () => {
          events.clicks++;
          for (let i = 0; i < (options.postRequests ?? 1); i++) {
            await routeHandler?.({
              request: () => ({ method: () => 'POST', url: () => 'https://codeforces.com/contestRegistration/4' }),
              abort: async () => { events.postsAborted++; }, fallback: async () => { events.postsAllowed++; },
            });
          }
          if (options.after) html = options.after;
          if (options.clickError) throw new Error('timeout after click, csrf=DO_NOT_LOG');
        } }) };
      } }) };
    },
  } as unknown as Page;
  const sessionHandle = options.sessionHandle ?? 'tester';
  const browser: BrowserAccess = {
    knownHandle: () => sessionHandle,
    getSessionStatus: async () => ({ authenticated: true, handle: sessionHandle, method: 'storage_state', message: 'ok' }),
    ensureLoggedIn: async () => { events.auth++; return { authenticated: true, handle: sessionHandle, method: 'storage_state', message: 'ok' }; },
    withPage: async (operation) => operation(page),
  };
  const api = { contests: async (gym: boolean) => { assert.equal(gym, false); events.api++; return options.contests ?? [contest]; } } as Pick<CodeforcesApi, 'contests'>;
  const service = new ContestRegistrationService(api, browser, { CF_EXPECTED_HANDLE: options.handle ?? 'tester' });
  return { service, events, page };
}

test('already registered returns success with zero mutation clicks', async () => {
  const { service, events } = setup({ before: registered });
  assert.deepEqual(await service.register(input), { registered: true, alreadyRegistered: true, contestId, handle: 'tester' });
  assert.equal(events.clicks, 0);
  assert.equal(events.routes, 0);
});

test('open individual registration clicks exactly once and confirms from a fresh official page', async () => {
  const { service, events } = setup({ after: registered });
  assert.deepEqual(await service.register(input), { registered: true, alreadyRegistered: false, contestId, handle: 'tester' });
  assert.equal(events.clicks, 1);
  assert.equal(events.routes, 1);
  assert.equal(events.postsAllowed, 1);
  assert.equal(events.gotos.length, 4);
  assert.equal(new URL(events.gotos[0]!).pathname, '/contests');
  assert.equal(events.gotos[1], 'https://codeforces.com/contestRegistration/4?backUrl=%2Fcontests%2F3%2C4');
  assert.equal(events.gotos[3], 'https://codeforces.com/contestRegistration/4?backUrl=%2Fcontests%2F3%2C4');
});

test('a second registration POST from one click is blocked at the browser route', async () => {
  const { service, events } = setup({ after: registered, postRequests: 2 });
  await service.register(input);
  assert.equal(events.clicks, 1);
  assert.equal(events.postsAllowed, 1);
  assert.equal(events.postsAborted, 1);
});

test('missing and finished contests are rejected before authentication', async () => {
  const missing = setup({ contests: [] });
  await assert.rejects(missing.service.register(input), { code: 'CONTEST_NOT_FOUND' });
  assert.equal(missing.events.auth, 0);
  const finished = setup({ contests: [{ ...contest, phase: 'FINISHED' }] });
  await assert.rejects(finished.service.register(input), { code: 'CONTEST_ALREADY_FINISHED' });
  assert.equal(finished.events.auth, 0);
  const gym = setup();
  await assert.rejects(gym.service.register({ contestId: 100000 }), { code: 'GYM_REGISTRATION_UNSUPPORTED' });
});

test('registration not open and closed are read-only states and block registration', async () => {
  const notOpen = setup({ before: pageHtml('<p>Before registration 2 days.</p>') });
  assert.equal((await notOpen.service.status(input)).status, 'registration_not_open');
  await assert.rejects(notOpen.service.register(input), { code: 'REGISTRATION_NOT_OPEN' });
  assert.equal(notOpen.events.clicks, 0);
  const closed = setup({ before: pageHtml('<p>Registration is closed.</p>') });
  assert.equal((await closed.service.status(input)).status, 'registration_closed');
  await assert.rejects(closed.service.register(input), { code: 'REGISTRATION_CLOSED' });
  assert.equal(closed.events.clicks, 0);
});
test('combined 2273/2274 page with Before registration and no Register link stays not open', async () => {
  const before = pageHtml('<p>Before registration 2 weeks</p>');
  const service = setup({ listing: pageHtml('<a href="/contests/2273,2274">Round 1124</a>'),
    combined: before, contests: [{ ...contest, id: 2273, name: 'Codeforces Round (Div. 1)' }] });
  const result = await service.service.status({ contestId: 2273 });
  assert.equal(result.status, 'registration_not_open');
  assert.equal(service.events.clicks, 0);
});

test('manual verification before mutation blocks without a click or retry', async () => {
  const challenge = setup({ before: '<html><title>Just a moment...</title><body>Verify you are human</body></html>' });
  assert.equal((await challenge.service.status(input)).status, 'verification_required');
  await assert.rejects(challenge.service.register(input), { code: 'SESSION_REQUIRES_MANUAL_LOGIN' });
  assert.equal(challenge.events.clicks, 0);
});

test('manual verification after mutation is uncertain and never clicks again', async () => {
  const challenge = setup({ after: '<html><title>Just a moment...</title><body>Verify you are human</body></html>' });
  await assert.rejects(challenge.service.register(input), { code: 'REGISTRATION_RESULT_UNCERTAIN' });
  assert.equal(challenge.events.clicks, 1);
});

test('timeout after the registration click is uncertain and never retried', async () => {
  const timedOut = setup({ clickError: true });
  await assert.rejects(timedOut.service.register(input), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'REGISTRATION_RESULT_UNCERTAIN');
    assert.doesNotMatch(String(error), /DO_NOT_LOG/);
    return true;
  });
  assert.equal(timedOut.events.clicks, 1);
});

test('wrong authenticated handle blocks registration', async () => {
  const wrong = setup({ handle: 'expected-other' });
  await assert.rejects(wrong.service.register(input), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(wrong.events.clicks, 0);
});

test('registration status helper never mutates, and unknown or unofficial forms fail closed', async () => {
  const open = setup();
  assert.deepEqual(await open.service.status(input), { contestId, handle: 'tester', status: 'not_registered' });
  assert.equal(open.events.clicks, 0); assert.equal(open.events.routes, 0);
  const unofficial = pageHtml('<form action="/contestRegistration/4" method="post"><select name="participation"><option selected value="unofficial">Unofficial</option></select><input type="submit" value="Register"></form>');
  assert.equal(parseRegistrationPage(unofficial, 4).status, 'unknown');
  const individual = pageHtml('<form action="/contestRegistration/4" method="post"><select name="teamId"><option selected value="0">No team</option><option value="123">Team 123</option></select><input type="submit" value="Register"></form>');
  assert.equal(parseRegistrationPage(individual, 4).status, 'not_registered');
  assert.equal(parseRegistrationPage(individual.replace('selected value="0"', 'value="0"').replace('value="123"', 'selected value="123"'), 4).status, 'unknown');
  assert.equal(parseRegistrationPage(pageHtml('<form action="/contestRegistration/4" method="post"><input type="hidden" name="teamId" value="123"><input type="submit" value="Register"></form>'), 4).status, 'unknown');
  const unsupported = setup({ before: unofficial });
  await assert.rejects(unsupported.service.register(input), { code: 'REGISTRATION_FORM_UNAVAILABLE' });
  assert.equal(unsupported.events.clicks, 0);
});

test('registration follows only the exact official Register link and fails closed without it', async () => {
  assert.equal(discoverRegistrationLink(listing, 4), 'https://codeforces.com/contestRegistration/4?backUrl=%2Fcontests%2F3%2C4');
  assert.equal(discoverRegistrationLink(pageHtml('<a href="https://evil.example/contestRegistration/4">Register</a>'), 4), null);
  assert.equal(discoverRegistrationLink(pageHtml('<a href="/contestRegistration/5">Register</a>'), 4), null);
  const missing = setup({ listing: pageHtml('<p>No Register link here.</p>') });
  assert.equal((await missing.service.status(input)).status, 'unknown');
  await assert.rejects(missing.service.register(input), { code: 'REGISTRATION_FORM_UNAVAILABLE' });
  assert.equal(missing.events.clicks, 0);
});

test('an unrelated redirect cannot use another contest page to reject the target', async () => {
  const unrelated = setup({ listing: pageHtml('<p>No target Register link</p>'),
    before: pageHtml('<p>Rating should be between 0 and 1899 in order to register for the contest</p>'),
    redirectTo: 'https://codeforces.com/contests/2268,2269' });
  assert.equal((await unrelated.service.status(input)).status, 'unknown');
  await assert.rejects(unrelated.service.register(input), { code: 'REGISTRATION_FORM_UNAVAILABLE' });
  assert.equal(unrelated.events.clicks, 0);
});

test('combined contest listing discovers both official hrefs by contest ID without relying on link labels', async () => {
  const combinedUrl = 'https://codeforces.com/contests/2268,2269';
  const listingPage = pageHtml('<a href="/contests/2268,2269">Round details</a>');
  const combined = pageHtml('<a href="/contestRegistration/2268?backUrl=%2Fcontests%2F2268%2C2269">Enter first</a>' +
    '<a href="/contestRegistration/2269?backUrl=%2Fcontests%2F2268%2C2269&mode=official">Enter second</a>');
  assert.equal(discoverContestPage(listingPage, 2268), combinedUrl);
  assert.equal(discoverContestPage(listingPage, 2269), combinedUrl);
  assert.equal(discoverRegistrationLink(combined, 2268),
    'https://codeforces.com/contestRegistration/2268?backUrl=%2Fcontests%2F2268%2C2269');
  assert.equal(discoverRegistrationLink(combined, 2269),
    'https://codeforces.com/contestRegistration/2269?backUrl=%2Fcontests%2F2268%2C2269&mode=official');
  for (const id of [2268, 2269]) {
    const chosen = setup({ contests: [{ ...contest, id }], listing: listingPage, combined,
      before: pageHtml(`<form action="/contestRegistration/${id}" method="post"><input type="submit" value="Register"></form>`) });
    assert.equal((await chosen.service.status({ contestId: id })).status, 'not_registered');
    assert.equal(new URL(chosen.events.gotos[2]!).pathname, `/contestRegistration/${id}`);
    assert.equal(chosen.events.clicks, 0);
  }
});

test('rating rejection after official redirect is not verification and blocks mutation', async () => {
  const message = 'Rating should be between 0 and 1899 in order to register for the contest';
  const redirected = setup({ before: pageHtml(`<div>  RATING should be   between 0 and 1899\n in order to register for the contest </div>`),
    redirectTo: 'https://codeforces.com/contests/3,4' });
  const status = await redirected.service.status(input);
  assert.equal(status.status, 'rating_ineligible');
  assert.equal(status.reason?.toLowerCase(), message.toLowerCase());
  assert.equal(redirected.page.url(), 'https://codeforces.com/contests/3,4');
  await assert.rejects(redirected.service.register(input), { code: 'CONTEST_REGISTRATION_INELIGIBLE' });
  assert.equal(redirected.events.clicks, 0);
  const noHeader = setup({ before: `<html><body>${message}</body></html>`, redirectTo: 'https://codeforces.com/contests/3,4' });
  assert.equal((await noHeader.service.status(input)).status, 'rating_ineligible');
  const homepage = setup({ before: pageHtml('<p>Codeforces home page</p>'), redirectTo: 'https://codeforces.com/' });
  assert.equal((await homepage.service.status(input)).status, 'unknown');
  assert.equal(homepage.page.url(), 'https://codeforces.com/');
  const denied = setup({ before: pageHtml('<p>Access denied</p>'), registrationStatus: 403 });
  assert.equal((await denied.service.status(input)).status, 'unknown');
});

test('Div.1 registration policy rejects sibling Div.2 before browser access', async () => {
  const div2 = setup({ contests: [{ ...contest, name: 'Codeforces Round 1124 (Div. 2)' }] });
  await assert.rejects(div2.service.register(input), { code: 'CONTEST_DIVISION_NOT_ALLOWED' });
  assert.equal(div2.events.auth, 0); assert.equal(div2.events.clicks, 0);
});

test('shutdown prevents starting a new registration', async () => {
  const { service, events } = setup();
  service.stopWrites();
  await assert.rejects(service.register(input), { code: 'WRITE_BUSY' });
  assert.equal(events.clicks, 0);
});

test('concurrent registration attempts cannot enter the write flow together', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = { authenticated: true, handle: 'tester', method: 'storage_state' as const, message: 'ok' };
  let currentUrl = '';
  const browser: BrowserAccess = {
    knownHandle: () => 'tester', getSessionStatus: async () => session, ensureLoggedIn: async () => session,
    withPage: async (operation) => operation({ goto: async (url: string) => { currentUrl = url; return { status: () => 200 }; },
      url: () => currentUrl, content: async () => registered } as unknown as Page),
  };
  const api = { contests: async () => { await gate; return [contest]; } } as Pick<CodeforcesApi, 'contests'>;
  const service = new ContestRegistrationService(api, browser, { CF_EXPECTED_HANDLE: 'tester' });
  const first = service.register(input);
  await assert.rejects(service.register(input), { code: 'WRITE_BUSY' });
  release();
  assert.equal((await first).alreadyRegistered, true);
});
