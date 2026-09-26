import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import * as z from 'zod/v4';
import { Mutex, sleep } from './async.js';
import { CodeforcesError, manualLoginRequired, publicError } from './errors.js';

export type AuthMethod = 'cdp' | 'storage_state' | 'credentials' | 'none';
export interface SessionStatus { authenticated: boolean; handle: string | null; method: AuthMethod; message: string }
export interface BrowserAccess {
  ensureLoggedIn(): Promise<SessionStatus>;
  getSessionStatus(): Promise<SessionStatus>;
  withPage<T>(operation: (page: Page) => Promise<T>): Promise<T>;
  knownHandle(): string | undefined;
  /** Read-only GET used during manual-auth recovery; never interacts with a form. */
  probeSubmissionPage?(contestId: number): Promise<boolean>;
}

type StorageState = Exclude<Parameters<Browser['newContext']>[0], undefined>['storageState'];
const stateSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
    expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
  })),
  origins: z.array(z.object({ origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) })),
});

export function decodeStorageState(encoded: string): StorageState {
  try {
    if (encoded.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    return stateSchema.parse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
  } catch { throw new CodeforcesError('Configured storage state is invalid. Generate a new local session.', 'CF_AUTH_REQUIRED'); }
}

export function hasManualVerification(html: string): boolean {
  const $ = cheerio.load(html);
  return /just a moment|attention required|security verification/i.test($('title').text()) ||
    $('#challenge-form, #challenge-running, .cf-turnstile, .g-recaptcha, #captcha, input[name="captcha"], img[src*="captcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"]').length > 0 ||
    /verify (?:you are|that you are) human|performing security verification|checking your browser/i.test($('body').text());
}

export function authenticatedHandle(html: string): string | null {
  const $ = cheerio.load(html);
  const header = $('#header, .lang-chooser');
  if (!header.find('a[href*="/logout"]').length) return null;
  const href = header.find('a[href^="/profile/"]').first().attr('href');
  const value = href?.match(/^\/profile\/([^/?#]+)/)?.[1];
  return value ? decodeURIComponent(value) : null;
}

export async function assertNoManualVerification(page: Page): Promise<void> {
  if (hasManualVerification(await page.content())) throw manualLoginRequired();
}

const navigationLock = new Mutex();
let lastNavigation = 0;
/** Only GET navigation is retried; the submission click never passes through this helper. */
export async function navigate(page: Page, url: string, addLocale = true): Promise<void> {
  const target = new URL(url);
  if (target.origin !== 'https://codeforces.com') throw new CodeforcesError('Unsupported browser destination.', 'INVALID_INPUT');
  for (let attempt = 0; attempt < 2; attempt++) {
    await navigationLock.run(async () => {
      await sleep(Math.max(0, lastNavigation + 1000 - Date.now()));
      lastNavigation = Date.now();
    });
    try {
      if (addLocale) target.searchParams.set('locale', 'en');
      const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await assertNoManualVerification(page);
      const status = response?.status() ?? 200;
      if (status === 429 || status >= 500) throw new CodeforcesError('Codeforces page is temporarily unavailable.', 'CF_PAGE_FETCH_FAILED', true);
      if (status === 404) throw new CodeforcesError('Codeforces page was not found.', 'PROBLEM_NOT_FOUND');
      if (status === 401 || status === 403) throw manualLoginRequired();
      if (status >= 400) throw new CodeforcesError('Codeforces page could not be loaded.', 'CF_PAGE_FETCH_FAILED');
      return;
    } catch (error) {
      if (error instanceof CodeforcesError && !error.retryable) throw error;
      if (attempt === 1) throw new CodeforcesError('Codeforces page navigation failed or timed out.', 'CF_PAGE_FETCH_FAILED', true);
      await sleep(1500);
    }
  }
}

export class CodeforcesBrowser implements BrowserAccess {
  private browser?: Browser;
  private context?: BrowserContext;
  private ownsBrowser = false;
  private readonly lock = new Mutex();
  private status: SessionStatus = { authenticated: false, handle: null, method: 'none', message: 'No Codeforces session is available.' };
  private authError?: CodeforcesError;
  private credentialsAttempted = false;
  private stateError?: CodeforcesError;
  private storageStateHash?: string;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private readonly connect: (url: string) => Promise<Browser> = (url) => chromium.connectOverCDP(url, { timeout: 5000 })) {}

  knownHandle(): string | undefined { return this.env.CF_HANDLE || this.status.handle || undefined; }

  private async getContext(): Promise<BrowserContext> {
    if (this.env.CF_BROWSER_CDP_URL) {
      if (this.context) return this.context;
      let endpoint: URL;
      try { endpoint = new URL(this.env.CF_BROWSER_CDP_URL); }
      catch { throw new CodeforcesError('CF_BROWSER_CDP_URL must be a local HTTP URL.', 'INVALID_INPUT'); }
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
          !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
        throw new CodeforcesError('CF_BROWSER_CDP_URL must point to a local Chrome debugging port.', 'INVALID_INPUT');
      try {
        const browser = await this.connect(endpoint.toString());
        const context = browser.contexts()[0];
        if (!context) throw new Error('No existing Chrome context');
        this.browser = browser;
        this.context = context;
        this.ownsBrowser = false;
        return context;
      } catch {
        throw new CodeforcesError('Local Chrome CDP is unavailable. Run npm run session:create, log in manually, and retry.', 'BROWSER_UNAVAILABLE');
      }
    }
    let storageState: StorageState | undefined;
    if (this.env.CF_STORAGE_STATE_B64_FILE) {
      // Cloud Run's mounted latest-version secret is read on every operation.
      // Recreate only our own context after an operator rotates the session.
      let encoded: string;
      try { encoded = (await readFile(this.env.CF_STORAGE_STATE_B64_FILE, 'utf8')).trim(); }
      catch { throw new CodeforcesError('Configured storage-state secret is unavailable.', 'CF_AUTH_REQUIRED'); }
      storageState = decodeStorageState(encoded);
      const hash = createHash('sha256').update(encoded).digest('hex');
      if (this.context && hash !== this.storageStateHash) {
        await this.context.close().catch(() => undefined);
        this.context = undefined;
        this.status = { authenticated: false, handle: null, method: 'storage_state', message: 'Codeforces session must be verified.' };
      }
      this.storageStateHash = hash;
    }
    if (this.context) return this.context;
    if (!storageState && this.env.CF_STORAGE_STATE_B64) {
      try { storageState = decodeStorageState(this.env.CF_STORAGE_STATE_B64.trim()); }
      catch (error) { this.stateError = error as CodeforcesError; }
    }
    try {
      this.browser ??= await this.launch();
      this.ownsBrowser = true;
      this.context = await this.browser.newContext({ storageState, locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' });
      this.context.setDefaultTimeout(10_000);
      this.context.setDefaultNavigationTimeout(30_000);
      return this.context;
    } catch {
      await this.browser?.close().catch(() => undefined);
      this.browser = undefined; this.ownsBrowser = false;
      throw new CodeforcesError('Chromium could not start. Install the matching Playwright browser and system dependencies.', 'BROWSER_UNAVAILABLE');
    }
  }

  withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const context = await this.getContext();
      const page = await context.newPage();
      try { return await operation(page); }
      catch (error) {
        if (error instanceof CodeforcesError) throw error;
        throw new CodeforcesError('Codeforces browser operation failed. Check the session and page availability.', 'CF_PAGE_FETCH_FAILED');
      } finally { await page.close().catch(() => undefined); }
    });
  }

  private async verify(page: Page, method: AuthMethod): Promise<SessionStatus> {
    await assertNoManualVerification(page);
    const handle = authenticatedHandle(await page.content());
    if (!handle) throw new CodeforcesError('The Codeforces session has expired or login did not succeed.', 'SESSION_EXPIRED');
    if (this.env.CF_HANDLE && handle.toLowerCase() !== this.env.CF_HANDLE.toLowerCase()) {
      throw new CodeforcesError('The browser session does not match CF_HANDLE. Use the experiment account session.', 'CF_AUTH_REQUIRED');
    }
    if (method === 'cdp' && this.env.CF_EXPECTED_HANDLE &&
        handle.toLowerCase() !== this.env.CF_EXPECTED_HANDLE.trim().toLowerCase())
      throw new CodeforcesError('The browser session does not match CF_EXPECTED_HANDLE.', 'ACCOUNT_MISMATCH');
    this.authError = undefined;
    return this.status = { authenticated: true, handle, method, message: 'Authenticated Codeforces session is available.' };
  }

  async getSessionStatus(): Promise<SessionStatus> {
    const method: AuthMethod = this.env.CF_BROWSER_CDP_URL ? 'cdp' :
      this.env.CF_STORAGE_STATE_B64_FILE || this.env.CF_STORAGE_STATE_B64 ? 'storage_state' :
      this.env.CF_HANDLE && this.env.CF_PASSWORD ? 'credentials' : 'none';
    if (method === 'none') {
      this.authError = new CodeforcesError('Configure CF_BROWSER_CDP_URL, CF_STORAGE_STATE_B64, or CF_HANDLE and CF_PASSWORD.', 'CF_AUTH_REQUIRED');
      return this.status = { authenticated: false, handle: null, method, message: this.authError.message };
    }
    try {
      return await this.withPage(async (page) => {
        if (this.stateError) throw this.stateError;
        await navigate(page, 'https://codeforces.com/');
        if (authenticatedHandle(await page.content())) return this.verify(page, method);
        if (method === 'cdp') throw new CodeforcesError('Log in manually in the dedicated Chrome session before retrying.', 'CF_AUTH_REQUIRED');
        if (method === 'storage_state') throw new CodeforcesError('Stored Codeforces session expired. Create a new storage state.', 'SESSION_EXPIRED');
        if (this.credentialsAttempted) throw this.authError ?? new CodeforcesError('Credential login was already attempted. Create a manual session or restart after correcting credentials.', 'CF_AUTH_REQUIRED');
        await navigate(page, 'https://codeforces.com/enter');
        await page.locator('#handleOrEmail').fill(this.env.CF_HANDLE!);
        await page.locator('#password').fill(this.env.CF_PASSWORD!);
        await assertNoManualVerification(page);
        this.credentialsAttempted = true;
        await page.locator('#enterForm input[type="submit"], #enterForm button[type="submit"]').first().click();
        await page.waitForLoadState('domcontentloaded');
        await assertNoManualVerification(page);
        // A safe GET confirms that the login cookie is usable; never retry the login POST.
        await navigate(page, 'https://codeforces.com/');
        return this.verify(page, method);
      });
    } catch (error) {
      const safe = publicError(error);
      this.authError = new CodeforcesError(safe.message, safe.code, safe.retryable);
      return this.status = { authenticated: false, handle: null, method, message: safe.message };
    }
  }

  async ensureLoggedIn(): Promise<SessionStatus> {
    const status = await this.getSessionStatus();
    if (!status.authenticated) throw this.authError ?? new CodeforcesError('Codeforces authentication is required.', 'CF_AUTH_REQUIRED');
    return status;
  }

  async probeSubmissionPage(contestId: number): Promise<boolean> {
    if (!Number.isSafeInteger(contestId) || contestId <= 0)
      throw new CodeforcesError('Expected a positive contest ID.', 'INVALID_INPUT');
    try {
      return await this.withPage(async (page) => {
        await navigate(page, `https://codeforces.com/contest/${contestId}/submit`);
        return true;
      });
    } catch (error) {
      if (error instanceof CodeforcesError && error.code === 'SESSION_REQUIRES_MANUAL_LOGIN') return false;
      throw error;
    }
  }

  closeBrowser(): Promise<void> {
    return this.lock.run(async () => {
      if (this.ownsBrowser) {
        await this.context?.close().catch(() => undefined);
        await this.browser?.close().catch(() => undefined);
      }
      this.context = undefined; this.browser = undefined;
      this.ownsBrowser = false;
      this.storageStateHash = undefined;
      this.stateError = undefined;
      this.credentialsAttempted = false;
      this.status = { authenticated: false, handle: null, method: 'none', message: 'Browser session is closed.' };
    });
  }
}

export const codeforcesBrowser = new CodeforcesBrowser();
export const ensureLoggedIn = () => codeforcesBrowser.ensureLoggedIn();
export const getSessionStatus = () => codeforcesBrowser.getSessionStatus();
export const closeBrowser = () => codeforcesBrowser.closeBrowser();
