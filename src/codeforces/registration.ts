import * as cheerio from 'cheerio';
import * as z from 'zod/v4';
import type { Page } from 'playwright';
import type { CodeforcesApi } from './api.js';
import type { BrowserAccess } from './browser.js';
import { authenticatedHandle, hasManualVerification, navigate } from './browser.js';
import { CodeforcesError } from './errors.js';
import type { Contest } from './types.js';
import { assertDiv1Contest } from '../contest/eligibility.js';

export const registrationInput = z.object({ contestId: z.number().int().positive().safe() }).strict();
export type RegistrationState = 'registered' | 'not_registered' | 'registration_not_open' |
  'registration_closed' | 'verification_required' | 'rating_ineligible' | 'unknown';
export interface ContestRegistrationStatus { contestId: number; handle: string | null; status: RegistrationState; reason?: string }
export interface ContestRegistrationResult { registered: true; alreadyRegistered: boolean; contestId: number; handle: string }

interface RegistrationPageState { status: RegistrationState; reason?: string; formIndex?: number; buttonIndex?: number; registrationLink?: string }
const registrationUrl = (contestId: number) => `https://codeforces.com/contestRegistration/${contestId}`;
const contestsUrl = 'https://codeforces.com/contests';
const alternativeMode = /\b(?:team|unofficial|unrated|out[ -]of[ -]competition)\b/i;
const submitSelector = 'button:not([type]),button[type="submit"],input[type="submit"]';

/** Keep the exact official href, including backUrl; never follow a foreign or different-contest link. */
export function discoverRegistrationLink(html: string, contestId: number): string | null {
  if (hasManualVerification(html)) return null;
  const $ = cheerio.load(html);
  const links = $('a[href]').toArray().flatMap((element) => {
    try {
      const url = new URL($(element).attr('href')!, contestsUrl);
      return url.origin === 'https://codeforces.com' && url.pathname === `/contestRegistration/${contestId}` ? [url.toString()] : [];
    } catch { return []; }
  });
  return [...new Set(links)].length === 1 ? links[0]! : null;
}

/** Official listing links can lead to combined pages such as /contests/2268,2269. */
export function discoverContestPage(html: string, contestId: number): string | null {
  const $ = cheerio.load(html);
  const matches = $('a[href]').toArray().flatMap((element) => {
    try {
      const url = new URL($(element).attr('href')!, contestsUrl);
      if (url.origin !== 'https://codeforces.com') return [];
      const ids = /^\/contests\/([1-9]\d*(?:,[1-9]\d*)+)$/.exec(url.pathname)?.[1]?.split(',').map(Number);
      return ids?.includes(contestId) ? [url.toString()] : [];
    } catch { return []; }
  });
  return [...new Set(matches)].length === 1 ? matches[0]! : null;
}

function isTargetContestPage(actualUrl: string, contestId: number): boolean {
  try {
    const url = new URL(actualUrl);
    if (url.origin !== 'https://codeforces.com') return false;
    const ids = /^\/contests\/([1-9]\d*(?:,[1-9]\d*)*)$/.exec(url.pathname)?.[1]?.split(',').map(Number);
    return !!ids?.includes(contestId);
  } catch { return false; }
}

function isTargetRegistrationResponse(actualUrl: string, contestId: number, discoveredLink: boolean): boolean {
  try {
    const url = new URL(actualUrl);
    if (url.origin !== 'https://codeforces.com') return false;
    if (url.pathname === `/contestRegistration/${contestId}`) return true;
    // A response to a discovered, exact Register link may return to its round page.
    // A guessed URL redirect cannot establish which contest supplied a notice.
    return discoveredLink && isTargetContestPage(actualUrl, contestId);
  } catch { return false; }
}

/** Parse only the official registration page; uncertain layouts never authorize a click. */
export function parseRegistrationPage(html: string, contestId: number): RegistrationPageState {
  if (hasManualVerification(html)) return { status: 'verification_required' };
  const $ = cheerio.load(html);
  const root = $('#pageContent').first().length ? $('#pageContent').first() : $('body');
  const clean = root.clone();
  clean.find('#header, #sidebar, .sidebar, nav, footer, script, style').remove();
  const text = clean.text().replace(/\s+/g, ' ').trim();
  const ratingPattern = /rating\s+should\s+be\s+between\s+\d+\s+and\s+\d+\s+in\s+order\s+to\s+register\s+for\s+the\s+contest/i;
  const ratingMessage = ratingPattern.exec(text) ?? ratingPattern.exec($('body').text().replace(/\s+/g, ' ').trim());
  if (ratingMessage) return { status: 'rating_ineligible', reason: ratingMessage[0] };
  const expectedPath = `/contestRegistration/${contestId}`;
  const registrationHref = (href: string | undefined): boolean => {
    if (!href) return true;
    try {
      const url = new URL(href, registrationUrl(contestId));
      return url.origin === 'https://codeforces.com' && url.pathname === expectedPath;
    }
    catch { return false; }
  };
  if (/\b(?:you (?:are|have been) (?:already )?registered|you have already registered|registration (?:was )?(?:successful|confirmed))\b/i.test(text) ||
      root.find('a,button,input[type="submit"]').toArray().some((element) => {
        const label = $(element).text() || $(element).attr('value') || '';
        return /\b(?:unregister|cancel registration)\b/i.test(label) && registrationHref($(element).attr('href'));
      })) return { status: 'registered' };
  if (/\bregistration (?:is |has been )?closed\b|\bregistration has ended\b|\btoo late to register\b/i.test(text))
    return { status: 'registration_closed' };
  if (/\bregistration (?:is )?not (?:yet )?open\b|\bbefore registration\b|\bregistration (?:opens|will open)\b/i.test(text))
    return { status: 'registration_not_open' };
  if (/\b(?:unofficial only|out[ -]of[ -]competition only|cannot participate officially)\b/i.test(text))
    return { status: 'unknown' };

  const forms = $('form').toArray();
  const candidates = forms.map((element, formIndex) => {
    const form = $(element);
    let action: URL;
    try { action = new URL(form.attr('action') || registrationUrl(contestId), registrationUrl(contestId)); }
    catch { return null; }
    if (action.origin !== 'https://codeforces.com' || action.pathname !== expectedPath ||
        (form.attr('method') ?? 'get').toLowerCase() !== 'post') return null;
    const buttons = form.find(submitSelector).toArray();
    const matches = buttons.map((button, buttonIndex) => ({
      button, buttonIndex, label: ($(button).text() || $(button).attr('value') || '').trim(),
    })).filter(({ label }) => /^(?:register|register for (?:this |the )?contest|confirm registration)$/i.test(label));
    if (matches.length !== 1 || $(matches[0]!.button).is(':disabled')) return null;

    // Only a form whose current selections are clearly personal and official is safe.
    for (const select of form.find('select').toArray()) {
      const selected = $(select).find('option:selected').first();
      const option = selected.length ? selected : $(select).find('option').first();
      const choice = `${option.attr('value') ?? ''} ${option.text()}`;
      if (/\b(?:unofficial|unrated|out[ -]of[ -]competition)\b/i.test(choice) ||
          ((/team/i.test($(select).attr('name') ?? '') || /\bteam\b/i.test(choice)) &&
            !/\b(?:individual|personal|no team)\b/i.test(choice))) return null;
    }
    for (const control of form.find('input[type="radio"],input[type="checkbox"]').toArray()) {
      const field = $(control);
      if (field.is(':checked')) {
        const value = field.attr('value') ?? '';
        if (/\b(?:unofficial|unrated|out[ -]of[ -]competition)\b/i.test(value) ||
            (/team/i.test(field.attr('name') ?? '') && !/\b(?:individual|personal|no team)\b/i.test(value))) return null;
      }
      if (field.is('[required]') && field.is('input[type="radio"]') && !form.find(`input[name="${field.attr('name') ?? ''}"]:checked`).length) return null;
    }
    for (const hidden of form.find('input[type="hidden"]').toArray()) {
      const field = $(hidden);
      const name = field.attr('name') ?? '';
      const value = field.attr('value')?.trim() ?? '';
      if (/team/i.test(name) && value && !/^(?:0|-1|none|individual|personal)$/i.test(value)) return null;
      if (alternativeMode.test(name) && /^(?:1|true|yes|unofficial|unrated|team)$/i.test(value)) return null;
    }
    if (/\b(?:unofficial only|out[ -]of[ -]competition only|cannot participate officially|(?:register|participate) (?:as )?(?:unofficial|unrated|a team|out[ -]of[ -]competition))\b/i.test(form.text())) return null;
    return { status: 'not_registered' as const, formIndex, buttonIndex: matches[0]!.buttonIndex };
  }).filter((value) => value !== null);
  return candidates.length === 1 ? candidates[0]! : { status: 'unknown' };
}

export class ContestRegistrationService {
  private writing = false;
  private stopping = false;
  constructor(private readonly api: Pick<CodeforcesApi, 'contests'>, private readonly browser: BrowserAccess,
    private readonly env: NodeJS.ProcessEnv = process.env) {}

  stopWrites(): void { this.stopping = true; }
  private assertWritable(): void {
    if (this.stopping) throw new CodeforcesError('The server is shutting down.', 'WRITE_BUSY');
  }
  private async contest(contestId: number): Promise<Contest> {
    if (!registrationInput.safeParse({ contestId }).success) throw new CodeforcesError('Expected a positive contest ID.', 'INVALID_INPUT');
    if (contestId >= 100000) throw new CodeforcesError('Gym registration is not supported.', 'GYM_REGISTRATION_UNSUPPORTED');
    const contests = await this.api.contests(false);
    if (!Array.isArray(contests)) throw new CodeforcesError('Codeforces contest data is unavailable.', 'CF_API_ERROR');
    const contest = contests.find((item) => item.id === contestId);
    if (!contest) throw new CodeforcesError('Codeforces contest was not found.', 'CONTEST_NOT_FOUND');
    return contest;
  }
  private async handle(): Promise<string> {
    const expected = [this.env.CF_EXPECTED_HANDLE?.trim(), this.env.CF_HANDLE?.trim()].filter((value): value is string => !!value);
    if (!expected.length) throw new CodeforcesError('Configure CF_EXPECTED_HANDLE or CF_HANDLE before contest registration.', 'CF_AUTH_REQUIRED');
    const session = await this.browser.ensureLoggedIn();
    if (!session.authenticated || !session.handle) throw new CodeforcesError('An authenticated Codeforces session is required.', 'CF_AUTH_REQUIRED');
    if (expected.some((value) => value.toLowerCase() !== session.handle!.toLowerCase()))
      throw new CodeforcesError('The authenticated Codeforces account does not match the expected handle.', 'ACCOUNT_MISMATCH');
    return session.handle;
  }
  private async inspect(page: Page, contestId: number, handle: string): Promise<RegistrationPageState> {
    const read = async (url: string, preserveUrl = false): Promise<boolean> => {
      try { await navigate(page, url, !preserveUrl); return true; }
      catch (error) {
        if (error instanceof CodeforcesError && error.code === 'SESSION_REQUIRES_MANUAL_LOGIN') {
          if (hasManualVerification(await page.content().catch(() => ''))) throw error;
          return false; // HTTP denial or ordinary redirect alone is not evidence of a challenge.
        }
        throw error;
      }
    };
    if (!await read(contestsUrl)) return { status: 'unknown' };
    const listing = await page.content();
    const listingHandle = authenticatedHandle(listing);
    if (!listingHandle) return { status: 'unknown' };
    if (listingHandle.toLowerCase() !== handle.toLowerCase())
      throw new CodeforcesError('The Codeforces account changed during registration.', 'ACCOUNT_MISMATCH');
    let registrationLink = discoverRegistrationLink(listing, contestId);
    if (!registrationLink) {
      const combinedPage = discoverContestPage(listing, contestId);
      if (combinedPage) {
        if (!await read(combinedPage, true)) return { status: 'unknown' };
        if (!isTargetContestPage(page.url(), contestId)) return { status: 'unknown' };
        const combinedHtml = await page.content();
        const combinedHandle = authenticatedHandle(combinedHtml);
        if (!combinedHandle) return { status: 'unknown' };
        if (combinedHandle.toLowerCase() !== handle.toLowerCase())
          throw new CodeforcesError('The Codeforces account changed during registration.', 'ACCOUNT_MISMATCH');
        registrationLink = discoverRegistrationLink(combinedHtml, contestId);
        if (!registrationLink) {
          // A combined page can explicitly say "Before registration" before any
          // contestRegistration href exists. Do not turn this into an unknown
          // status by visiting a guessed standalone URL.
          const notice = parseRegistrationPage(combinedHtml, contestId);
          if (notice.status === 'registration_not_open') return notice;
        }
      }
    }
    // The canonical page is used only for read-only status when no Register link exists.
    if (!await read(registrationLink ?? registrationUrl(contestId), !!registrationLink)) return { status: 'unknown' };
    const html = await page.content();
    const state = parseRegistrationPage(html, contestId);
    if (state.status === 'verification_required') return state;
    if (!isTargetRegistrationResponse(page.url(), contestId, !!registrationLink)) return { status: 'unknown' };
    const actual = authenticatedHandle(html);
    if (!actual && state.status === 'rating_ineligible') return { ...state, registrationLink: registrationLink ?? undefined };
    if (!actual) return { status: 'unknown' };
    if (actual.toLowerCase() !== handle.toLowerCase()) throw new CodeforcesError('The Codeforces account changed during registration.', 'ACCOUNT_MISMATCH');
    // A form reached through a guessed route is not proof that an official
    // Register action for this contest is currently available.
    if (state.status === 'not_registered' && (!registrationLink || state.formIndex === undefined || state.buttonIndex === undefined))
      return { status: 'unknown' };
    return { ...state, registrationLink: registrationLink ?? undefined };
  }
  async status(raw: unknown): Promise<ContestRegistrationStatus> {
    const parsed = registrationInput.safeParse(raw);
    if (!parsed.success) throw new CodeforcesError('Expected contestId as a positive integer.', 'INVALID_INPUT');
    const contestId = parsed.data.contestId;
    const contest = await this.contest(contestId);
    if (contest.phase !== 'BEFORE') return { contestId, handle: null, status: 'registration_closed' };
    let handle: string;
    try { handle = await this.handle(); }
    catch (error) {
      if (error instanceof CodeforcesError && error.code === 'SESSION_REQUIRES_MANUAL_LOGIN')
        return { contestId, handle: null, status: 'verification_required' };
      throw error;
    }
    try {
      const state = await this.browser.withPage((page) => this.inspect(page, contestId, handle));
      return { contestId, handle, status: state.status, ...(state.reason ? { reason: state.reason } : {}) };
    } catch (error) {
      if (error instanceof CodeforcesError && error.code === 'SESSION_REQUIRES_MANUAL_LOGIN')
        return { contestId, handle, status: 'verification_required' };
      if (error instanceof CodeforcesError && ['CF_PAGE_FETCH_FAILED', 'PROBLEM_NOT_FOUND'].includes(error.code))
        return { contestId, handle, status: 'unknown' };
      throw error;
    }
  }
  async register(raw: unknown): Promise<ContestRegistrationResult> {
    const parsed = registrationInput.safeParse(raw);
    if (!parsed.success) throw new CodeforcesError('Expected contestId as a positive integer.', 'INVALID_INPUT');
    this.assertWritable();
    if (this.writing) throw new CodeforcesError('Another registration is in progress.', 'WRITE_BUSY', true);
    this.writing = true;
    try {
      const contestId = parsed.data.contestId;
      const contest = await this.contest(contestId);
      assertDiv1Contest(contest);
      if (contest.phase === 'FINISHED' || ['SYSTEM_TEST', 'PENDING_SYSTEM_TEST'].includes(contest.phase))
        throw new CodeforcesError('This contest has finished.', 'CONTEST_ALREADY_FINISHED');
      if (contest.phase !== 'BEFORE' || (contest.startTimeSeconds !== undefined && contest.startTimeSeconds <= Date.now() / 1000))
        throw new CodeforcesError('Registration for this contest is closed.', 'REGISTRATION_CLOSED');
      const handle = await this.handle();
      return await this.browser.withPage(async (page) => {
        const initial = await this.inspect(page, contestId, handle);
        if (initial.status === 'registered') return { registered: true, alreadyRegistered: true, contestId, handle };
        if (initial.status === 'rating_ineligible') throw new CodeforcesError(initial.reason ??
          'Codeforces says this account is ineligible to register.', 'CONTEST_REGISTRATION_INELIGIBLE');
        if (initial.status === 'verification_required') throw new CodeforcesError('Codeforces requires manual verification before registration.', 'SESSION_REQUIRES_MANUAL_LOGIN');
        if (initial.status === 'registration_not_open') throw new CodeforcesError('Contest registration is not open yet.', 'REGISTRATION_NOT_OPEN');
        if (initial.status === 'registration_closed') throw new CodeforcesError('Contest registration is closed.', 'REGISTRATION_CLOSED');
        if (initial.status !== 'not_registered' || !initial.registrationLink ||
            initial.formIndex === undefined || initial.buttonIndex === undefined)
          throw new CodeforcesError('The official individual registration form could not be identified safely.', 'REGISTRATION_FORM_UNAVAILABLE');
        this.assertWritable();
        const path = `/contestRegistration/${contestId}`;
        let registrationPosts = 0;
        await page.route('https://codeforces.com/**', async (route) => {
          const request = route.request();
          if (request.method() === 'POST') {
            const url = new URL(request.url());
            if (url.pathname !== path || ++registrationPosts > 1) { await route.abort(); return; }
          }
          await route.fallback();
        });
        const button = page.locator('form').nth(initial.formIndex)
          .locator(submitSelector).nth(initial.buttonIndex);
        this.assertWritable();
        // The click may commit upstream even if Playwright throws. Never repeat it.
        try {
          await button.click({ timeout: 15_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
          if (hasManualVerification(await page.content()))
            throw new CodeforcesError('Codeforces presented manual verification after the registration attempt.', 'REGISTRATION_RESULT_UNCERTAIN');
          const confirmed = await this.inspect(page, contestId, handle);
          if (confirmed.status === 'registered') return { registered: true, alreadyRegistered: false, contestId, handle };
          throw new CodeforcesError('Registration could not be confirmed from Codeforces. Check status before any retry.', 'REGISTRATION_RESULT_UNCERTAIN');
        } catch (error) {
          const verification = error instanceof CodeforcesError &&
            ['SESSION_REQUIRES_MANUAL_LOGIN', 'REGISTRATION_RESULT_UNCERTAIN'].includes(error.code) &&
            /verification/i.test(error.message);
          throw new CodeforcesError(verification
            ? 'Codeforces presented manual verification after the registration click. Check status after completing it manually; no retry was made.'
            : 'Registration may have been created. Check contest registration status before another attempt; no automatic retry was made.',
          'REGISTRATION_RESULT_UNCERTAIN');
        }
      });
    } finally { this.writing = false; }
  }
}
