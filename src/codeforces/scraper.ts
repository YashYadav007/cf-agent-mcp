import * as cheerio from 'cheerio';
import { isTag, isText, type AnyNode } from 'domhandler';
import { CodeforcesError } from './errors.js';
import { codeforcesBrowser, hasManualVerification, navigate, assertNoManualVerification, type BrowserAccess } from './browser.js';
import { retryDelay } from './api.js';
import { sleep } from './async.js';
import type { ProblemStatement } from './types.js';

function normalize(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readable(node?: AnyNode): string {
  if (!node) return '';
  if (isText(node)) return node.data;
  if (!isTag(node)) return '';
  const tag = node.name.toLowerCase();
  const classes = (node.attribs.class ?? '').split(/\s+/);
  // MathJax keeps its original TeX in a non-executable math/tex script.
  if (tag === 'script' && node.attribs.type?.startsWith('math/tex')) {
    return `$${node.children.filter(isText).map((child) => child.data).join('')}$`;
  }
  if (['script', 'style', 'svg', 'button', 'nav', 'footer'].includes(tag)) return '';
  if (classes.some((name) => /^MathJax|^mjx-|^MathJax_Preview/.test(name)) || tag.startsWith('mjx-')) return '';
  if (tag === 'img') return node.attribs.alt || '[diagram]';
  if (tag === 'br') return '\n';
  const children = node.children.map(readable).join('');
  if (classes.includes('tex-span') || classes.includes('tex-math')) return children.trim().startsWith('$') ? children : `$${children}$`;
  if (tag === 'sup') return `^(${children})`;
  if (tag === 'sub') return `_(${children})`;
  if (tag === 'li') return `\n- ${children}`;
  if (['p', 'div', 'ul', 'ol', 'table', 'tr', 'pre'].includes(tag)) return `${children}\n`;
  if (tag === 'td' || tag === 'th') return `${children}\t`;
  return children;
}

function sample(node: AnyNode): string {
  if (isText(node)) return node.data.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  if (!isTag(node) || ['script', 'style', 'button'].includes(node.name)) return '';
  if (node.name === 'br') return '\n';
  const text = node.children.map(sample).join('');
  return node.name === 'div' ? `${text}\n` : text;
}

export function parseProblemHtml(html: string, contestId: number, index: string): ProblemStatement {
  if (hasManualVerification(html)) throw new CodeforcesError('Codeforces returned a verification page.', 'CF_PAGE_FETCH_FAILED');
  const $ = cheerio.load(html);
  const root = $('.problem-statement').first();
  const title = normalize(root.find('> .header .title').first().text());
  if (!root.length || !title) throw new CodeforcesError('Codeforces did not return a valid problem statement.', 'PROBLEM_NOT_FOUND');
  const sections: string[] = [];
  root.contents().each((_, element) => {
    if (isTag(element)) {
      const classes = ($(element).attr('class') ?? '').split(/\s+/);
      if (classes.some((name) => ['header', 'input-specification', 'output-specification', 'sample-tests', 'note'].includes(name))) return;
    }
    const value = normalize(readable(element));
    if (value) sections.push(value);
  });
  const section = (name: string): string => {
    const clone = root.find(`> .${name}`).first().clone();
    clone.find('.section-title').remove();
    return normalize(readable(clone.get(0)));
  };
  const inputs = root.find('.sample-tests .input pre').toArray();
  const outputs = root.find('.sample-tests .output pre').toArray();
  if (inputs.length !== outputs.length) throw new CodeforcesError('Problem examples are incomplete.', 'CF_PAGE_FETCH_FAILED');
  const timeLimit = normalize(root.find('> .header .time-limit').first().text().replace(/^time limit per test\s*/i, ''));
  const memoryLimit = normalize(root.find('> .header .memory-limit').first().text().replace(/^memory limit per test\s*/i, ''));
  if (!sections.length || !timeLimit || !memoryLimit) throw new CodeforcesError('Problem statement is incomplete.', 'CF_PAGE_FETCH_FAILED');
  return {
    contestId, index, name: title.replace(/^[A-Za-z][A-Za-z0-9]*\.\s*/, ''), timeLimit, memoryLimit,
    statement: sections.join('\n\n'), input: section('input-specification'), output: section('output-specification'),
    examples: inputs.map((element, i) => ({ input: sample(element), output: sample(outputs[i]!) })), note: section('note'),
  };
}

export async function fetchProblemHttp(url: string, timeoutMs: number): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let delay = 2000 * 2 ** attempt;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'cf-agent-mcp/2.0', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        delay = retryDelay(attempt, response.headers.get('retry-after'));
        await response.body?.cancel();
        throw new CodeforcesError(`Codeforces problem HTTP fetch failed status=${response.status}.`, 'CF_PAGE_FETCH_FAILED', response.status === 429 || response.status >= 500);
      }
      return await response.text();
    } catch (error) {
      if (error instanceof CodeforcesError && !error.retryable) throw error;
      if (attempt === 2 || delay > 30_000) throw new CodeforcesError('Codeforces problem HTTP request failed or timed out.', 'CF_PAGE_FETCH_FAILED', true);
      await sleep(delay);
    }
  }
  throw new CodeforcesError('Codeforces problem page unavailable.', 'CF_PAGE_FETCH_FAILED', true);
}

export async function fetchProblem(contestId: number, index: string, timeoutMs = 15000, deps: {
  http?: typeof fetchProblemHttp; browser?: Pick<BrowserAccess, 'withPage'> & Partial<Pick<BrowserAccess, 'getSessionStatus'>>;
} = {}): Promise<ProblemStatement> {
  const encodedIndex = encodeURIComponent(index);
  const query = '?locale=en&mobile=false';
  const urls = contestId >= 100000
    ? [`https://codeforces.com/gym/${contestId}/problem/${encodedIndex}${query}`]
    : [
      `https://codeforces.com/problemset/problem/${contestId}/${encodedIndex}${query}`,
      `https://codeforces.com/contest/${contestId}/problem/${encodedIndex}${query}`,
    ];
  for (const url of urls) {
    try {
      return parseProblemHtml(await (deps.http ?? fetchProblemHttp)(url, timeoutMs), contestId, index);
    } catch (error) {
      if (!(error instanceof CodeforcesError) || !['CF_PAGE_FETCH_FAILED', 'PROBLEM_NOT_FOUND'].includes(error.code)) throw error;
      console.error('[CF] get_problem HTTP URL failed', { path: new URL(url).pathname, code: error.code });
    }
  }
  const browser = deps.browser ?? codeforcesBrowser;
  return browser.withPage(async (page) => {
    let manualVerification = false;
    for (const url of urls) {
      try {
        await navigate(page, url);
        await page.locator('.problem-statement').waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
        await assertNoManualVerification(page);
        return parseProblemHtml(await page.content(), contestId, index);
      } catch (error) {
        const code = error instanceof CodeforcesError ? error.code : 'CF_PAGE_FETCH_FAILED';
        if (code === 'SESSION_REQUIRES_MANUAL_LOGIN') manualVerification = true;
        console.error('[CF] get_problem browser URL failed', { path: new URL(url).pathname, code });
      }
    }
    throw new CodeforcesError(manualVerification
      ? 'Codeforces presented manual verification while fetching the public problem page.'
      : 'Codeforces public problem page could not be fetched from official URLs.', 'CF_PAGE_FETCH_FAILED');
  });
}
