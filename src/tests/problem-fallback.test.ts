import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { fetchProblem, parseProblemHtml } from '../codeforces/scraper.js';
import { CodeforcesError } from '../codeforces/errors.js';
import { problemHtml, fakePage } from './fixtures.js';

const problemsetUrl = 'https://codeforces.com/problemset/problem/4/A?locale=en&mobile=false';
const contestUrl = 'https://codeforces.com/contest/4/problem/A?locale=en&mobile=false';

function pageByUrl(htmlForUrl: (url: string) => string, visited: string[]): Page {
  let html = '';
  return {
    goto: async (url: string) => { visited.push(url); html = htmlForUrl(url); return { status: () => 200 }; },
    content: async () => html,
    locator: () => ({ waitFor: async () => undefined }),
  } as unknown as Page;
}

test('valid lightweight HTML does not launch Playwright and samples keep whitespace', async () => {
  const result = await fetchProblem(4, 'A', 1000, {
    http: async () => problemHtml, browser: { withPage: async () => { throw new Error('must not launch'); } },
  });
  assert.equal(result.examples[0]?.input, '  2\n\n3 < 4');
  assert.equal(result.examples[0]?.output, '  yes\nno\n');
  assert.match(result.statement, /\$x\^2\$/); assert.match(result.statement, /\$n\$/);
  assert.doesNotMatch(result.statement, /Noise|secret|rendered/);
});

test('second official HTTP URL succeeds after first fails without launching Playwright', async () => {
  const visited: string[] = [];
  const result = await fetchProblem(4, 'A', 1000, {
    http: async (url) => {
      visited.push(url);
      if (url === problemsetUrl) throw new CodeforcesError('HTTP 403', 'CF_PAGE_FETCH_FAILED');
      return problemHtml;
    },
    browser: { withPage: async () => { throw new Error('must not launch'); } },
  });
  assert.deepEqual(visited, [problemsetUrl, contestUrl]);
  assert.equal(result.name, 'Example');
});

test('both official HTTP URLs failing uses the browser fallback without checking session status', async () => {
  const visited: string[] = [];
  let browserCalls = 0;
  let sessionCalls = 0;
  const result = await fetchProblem(4, 'A', 1000, {
    http: async (url) => { visited.push(url); throw new CodeforcesError('Unavailable', 'CF_PAGE_FETCH_FAILED'); },
    browser: {
      getSessionStatus: async () => { sessionCalls++; throw new Error('public page must not check auth'); },
      withPage: async (operation) => { browserCalls++; return operation(fakePage(problemHtml)); },
    },
  });
  assert.deepEqual(visited, [problemsetUrl, contestUrl]);
  assert.equal(browserCalls, 1);
  assert.equal(sessionCalls, 0);
  assert.equal(result.name, 'Example');
});

test('401, 403, challenge HTML, missing container and incomplete statements use browser fallback', async () => {
  for (const value of [401, 403, '<title>Just a moment...</title>', '<main>not a statement</main>', '<div class="problem-statement"><div class="header"><div class="title">A. Empty</div></div></div>']) {
    const visited: string[] = [];
    let browserCalls = 0;
    const result = await fetchProblem(4, 'A', 1000, {
      http: async (url) => { visited.push(url); if (typeof value === 'number') throw new CodeforcesError(`HTTP ${value}`, 'CF_PAGE_FETCH_FAILED'); return value; },
      browser: { withPage: async (operation) => { browserCalls++; return operation(fakePage(problemHtml)); } },
    });
    assert.deepEqual(visited, [problemsetUrl, contestUrl]);
    assert.equal(browserCalls, 1);
    assert.equal(result.name, 'Example');
  }
});

test('browser continues to the second official URL after public-page verification', async () => {
  const visited: string[] = [];
  const result = await fetchProblem(4, 'A', 1000, {
    http: async () => { throw new CodeforcesError('Unavailable', 'CF_PAGE_FETCH_FAILED'); },
    browser: { withPage: async (operation) => operation(pageByUrl(
      (url) => url.startsWith('https://codeforces.com/problemset/') ? '<title>Just a moment...</title>' : problemHtml,
      visited,
    )) },
  });
  assert.deepEqual(visited, [problemsetUrl, contestUrl]);
  assert.equal(result.name, 'Example');
});

test('public-page verification on all official URLs becomes a page fetch error', async () => {
  const visited: string[] = [];
  let sessionCalls = 0;
  await assert.rejects(fetchProblem(4, 'A', 1000, {
    http: async () => '<html>invalid</html>',
    browser: {
      getSessionStatus: async () => { sessionCalls++; throw new Error('public page must not check auth'); },
      withPage: async (operation) => operation(pageByUrl(() => '<title>Just a moment...</title>', visited)),
    },
  }), (error: unknown) => {
    assert.ok(error instanceof CodeforcesError);
    assert.equal(error.code, 'CF_PAGE_FETCH_FAILED');
    assert.match(error.message, /manual verification.*public problem page/i);
    return true;
  });
  assert.deepEqual(visited, [problemsetUrl, contestUrl]);
  assert.equal(sessionCalls, 0);
  assert.throws(() => parseProblemHtml('<div>no problem</div>', 4, 'A'), { code: 'PROBLEM_NOT_FOUND' });
});

test('Gym uses only its official URL for HTTP and browser fallback', async () => {
  const gymUrl = 'https://codeforces.com/gym/100000/problem/A?locale=en&mobile=false';
  const httpUrls: string[] = [];
  const browserUrls: string[] = [];
  const result = await fetchProblem(100000, 'A', 1000, {
    http: async (url) => { httpUrls.push(url); throw new CodeforcesError('Unavailable', 'CF_PAGE_FETCH_FAILED'); },
    browser: { withPage: async (operation) => operation(pageByUrl(() => problemHtml, browserUrls)) },
  });
  assert.deepEqual(httpUrls, [gymUrl]);
  assert.deepEqual(browserUrls, [gymUrl]);
  assert.equal(result.name, 'Example');
});
