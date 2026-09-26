import * as cheerio from 'cheerio';
import * as z from 'zod/v4';
import type { Page } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { CodeforcesError } from './errors.js';
import { assertNoManualVerification, authenticatedHandle, navigate, type BrowserAccess } from './browser.js';
import { sleep } from './async.js';
import { SubmissionSafety } from './safety.js';
import type { SubmissionStore, SubmissionMetadata } from '../storage/types.js';

export const submitInput = z.object({
  contestId: z.number().int().positive().safe(),
  problemIndex: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/),
  sourceCode: z.string().min(1).max(256 * 1024),
}).strict();
export type SubmitInput = z.infer<typeof submitInput>;
export type SubmitResult = SubmissionMetadata & { submitted: true };
export interface LanguageOption { value: string; label: string; disabled?: boolean }

export function isJava17(label: string): boolean {
  return /^\s*(?:java\s+(?:openjdk\s+)?|openjdk\s+)17(?=$|[\s.(])/i.test(label);
}
export function resolveJava17(options: LanguageOption[]): string {
  const matches = options.filter((option) => !option.disabled && option.value && isJava17(option.label));
  if (matches.length !== 1) throw new CodeforcesError('A unique Java 17 option is not available on the Codeforces submission form.', 'JAVA17_NOT_AVAILABLE');
  return matches[0]!.value;
}
export function validateJavaSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, '\n');
  if (!normalized.trim() || Buffer.byteLength(normalized, 'utf8') > 256 * 1024 || !/\bclass\s+[\p{L}_$][\p{L}\p{N}_$]*/u.test(normalized)) {
    throw new CodeforcesError('Provide nonempty Java source containing a class, at most 256 KiB in UTF-8.', 'INVALID_INPUT');
  }
  return normalized;
}

export interface OwnSubmissionRow { id: number; contestId: number; problemIndex: string; language: string }
export function parseOwnSubmissionRows(html: string, handle: string): OwnSubmissionRow[] {
  const $ = cheerio.load(html);
  const rows: OwnSubmissionRow[] = [];
  $('tr[data-submission-id]').each((_, element) => {
    const row = $(element);
    const id = Number(row.attr('data-submission-id'));
    const authors = row.find('a[href^="/profile/"]').toArray().map((a) => $(a).attr('href')?.split('/')[2]?.toLowerCase());
    if (!Number.isSafeInteger(id) || id <= 0 || !authors.includes(handle.toLowerCase())) return;
    let problem: RegExpMatchArray | null = null;
    row.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      problem ??= href.match(/^\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z][A-Za-z0-9]*)/) ??
        href.match(/^\/problemset\/problem\/(\d+)\/([A-Za-z][A-Za-z0-9]*)/);
    });
    if (!problem) return;
    const matched = problem as RegExpMatchArray;
    const cells = row.children('td').toArray();
    const headers = row.closest('table').find('tr').first().children('th,td').toArray();
    const langIndex = headers.findIndex((th) => /^lang(?:uage)?$/i.test($(th).text().trim()));
    const language = langIndex >= 0 ? $(cells[langIndex]).text().trim() :
      cells.map((cell) => $(cell).text().trim()).find(isJava17) ?? '';
    rows.push({ id, contestId: Number(matched[1]), problemIndex: matched[2]!, language });
  });
  return rows;
}

export function identifyNewSubmission(before: readonly OwnSubmissionRow[], after: readonly OwnSubmissionRow[], input: SubmitInput): number | undefined {
  const highWatermark = Math.max(0, ...before.map((row) => row.id));
  const matches = after.filter((row) => row.id > highWatermark && row.contestId === input.contestId &&
    row.problemIndex.toUpperCase() === input.problemIndex.toUpperCase() && isJava17(row.language));
  if (matches.length > 1) throw new CodeforcesError('Multiple matching new submissions were observed. Inspect your own recent submissions; do not resubmit automatically.', 'SUBMISSION_STATE_UNCERTAIN');
  return matches[0]?.id;
}

export interface SubmissionForm {
  prepare(input: SubmitInput, handle: string): Promise<void>;
  clickOnce(): Promise<void>;
  captureId(): Promise<number>;
}

export class PlaywrightSubmissionForm implements SubmissionForm {
  private input!: SubmitInput;
  private handle!: string;
  private before: OwnSubmissionRow[] = [];
  private base!: string;
  private clicked = false;
  constructor(private readonly page: Page) {}

  private async verifySession(): Promise<void> {
    await assertNoManualVerification(this.page);
    if (authenticatedHandle(await this.page.content())?.toLowerCase() !== this.handle.toLowerCase()) {
      throw new CodeforcesError('The Codeforces session expired or changed accounts.', 'SESSION_EXPIRED');
    }
  }
  private async ownRows(): Promise<OwnSubmissionRow[]> {
    await navigate(this.page, `${this.base}/my`);
    await this.verifySession();
    if (!new URL(this.page.url()).pathname.endsWith('/my')) throw new CodeforcesError('Codeforces did not open your submissions page.', 'CF_PAGE_FETCH_FAILED');
    await this.page.locator('table.status-frame-datatable').waitFor({ state: 'attached', timeout: 10_000 });
    return parseOwnSubmissionRows(await this.page.content(), this.handle);
  }

  async prepare(input: SubmitInput, handle: string): Promise<void> {
    this.input = input; this.handle = handle;
    this.base = `https://codeforces.com/${input.contestId >= 100000 ? 'gym' : 'contest'}/${input.contestId}`;
    this.before = await this.ownRows();
    await navigate(this.page, `${this.base}/submit`);
    await this.verifySession();
    const form = this.page.locator('form').filter({ has: this.page.locator('select[name="programTypeId"]') });
    if (await form.count() !== 1) throw new CodeforcesError('Codeforces submission form is unavailable. Check contest access and registration.', 'SUBMISSION_FAILED');
    const action = await form.getAttribute('action');
    if (new URL(action || this.page.url(), this.page.url()).pathname !== `${new URL(this.base).pathname}/submit`) {
      throw new CodeforcesError('Unexpected Codeforces submission form destination.', 'SUBMISSION_FAILED');
    }
    await form.locator('select[name="submittedProblemIndex"]').selectOption(input.problemIndex);
    const options = await form.locator('select[name="programTypeId"] option').evaluateAll((nodes) => nodes.map((node) => {
      const option = node as HTMLOptionElement;
      return { value: option.value, label: option.textContent ?? '', disabled: option.disabled };
    }));
    await form.locator('select[name="programTypeId"]').selectOption(resolveJava17(options));
    // Update the underlying field and Ace (when present); source is never logged or transformed.
    const inserted = await form.evaluate((element, source) => {
      const textarea = element.querySelector<HTMLTextAreaElement>('textarea[name="source"]');
      if (!textarea) return false;
      const editorElement = element.querySelector<HTMLElement>('.ace_editor');
      if (editorElement) {
        const ace = (window as unknown as { ace?: { edit(el: HTMLElement): { setValue(s: string, p: number): void; getValue(): string } } }).ace;
        if (!ace) return false;
        const editor = ace.edit(editorElement);
        editor.setValue(source, -1);
        if (editor.getValue() !== source) return false;
      }
      textarea.value = source;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return textarea.value === source;
    }, input.sourceCode);
    if (!inserted) throw new CodeforcesError('Source could not be inserted into the Codeforces editor.', 'SUBMISSION_FAILED');
    await assertNoManualVerification(this.page);
    let submissionPosts = 0;
    // A JS double-submit or repeated form POST on this page is blocked as well.
    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.origin === 'https://codeforces.com' && url.pathname === `${new URL(this.base).pathname}/submit`) {
        submissionPosts++;
        if (submissionPosts > 1) { await route.abort(); return; }
      }
      await route.fallback();
    });
  }

  async clickOnce(): Promise<void> {
    if (this.clicked) throw new CodeforcesError('Submission action has already been attempted.', 'SUBMISSION_STATE_UNCERTAIN');
    this.clicked = true;
    await this.page.locator('form').filter({ has: this.page.locator('select[name="programTypeId"]') })
      .locator('input[type="submit"], button[type="submit"]').first().click({ timeout: 15_000 });
  }

  async captureId(): Promise<number> {
    await assertNoManualVerification(this.page);
    // Only inspect our own status tables. Never open a submission/source-code link.
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = identifyNewSubmission(this.before, await this.ownRows(), this.input);
      if (id) return id;
      if (attempt < 2) await sleep(2000);
    }
    throw new CodeforcesError('No unique submission ID could be confirmed. Inspect your own recent submissions before another invocation.', 'SUBMISSION_STATE_UNCERTAIN');
  }
}

export class SubmissionService {
  private writing = false;
  constructor(private readonly browser: BrowserAccess, private readonly store: SubmissionStore,
    private readonly formFactory: (page: Page) => SubmissionForm = (page) => new PlaywrightSubmissionForm(page),
    readonly safety = new SubmissionSafety()) {}

  stopWrites(): void { this.safety.stopWrites(); }

  private async assertContestAuthorized(contestId: number): Promise<void> {
    if (!await this.store.isContestAuthorized(contestId))
      throw new CodeforcesError('This contest has no active Supabase authorization.', 'CONTEST_NOT_AUTHORIZED');
    this.safety.assertStaticContestAllowed(contestId);
  }

  async submit(raw: unknown): Promise<SubmitResult> {
    const parsed = submitInput.safeParse(raw);
    if (!parsed.success) throw new CodeforcesError('Expected contestId, problemIndex, and Java sourceCode only.', 'INVALID_INPUT');
    const input = { ...parsed.data, sourceCode: validateJavaSource(parsed.data.sourceCode) };
    this.safety.assertEnabled();
    if (this.writing) throw new CodeforcesError('Another submission is in progress.', 'WRITE_BUSY', true);
    this.writing = true;
    try {
      await this.assertContestAuthorized(input.contestId);
      const session = await this.browser.ensureLoggedIn();
      if (!session.authenticated || !session.handle) throw new CodeforcesError('An authenticated Codeforces handle is required.', 'CF_AUTH_REQUIRED');
      this.safety.assertAccount(session.handle);
      await this.store.checkWritable();
      return await this.browser.withPage(async (page) => {
        const form = this.formFactory(page);
        await form.prepare(input, session.handle!);
        const submittedAt = new Date().toISOString();
        const attempt = { attemptId: randomUUID(), contestId: input.contestId, problemIndex: input.problemIndex, language: 'java17' as const, submittedAt,
          fingerprint: createHash('sha256').update(`${input.contestId}\0${input.problemIndex.toUpperCase()}\0${input.sourceCode}`).digest('hex') };
        if (!await this.store.reserveAttempt({ ...attempt, state: 'prepared' }, this.safety.config.duplicateWindowSeconds))
          throw new CodeforcesError('An identical submission was requested recently. Inspect your own submissions before retrying.', 'DUPLICATE_SUBMISSION_REQUEST');
        // Shutdown is checked again just before the sole external write.
        this.safety.assertEnabled();
        await this.assertContestAuthorized(input.contestId);
        this.safety.assertEnabled();
        let submissionId: number | undefined;
        try {
          // Exactly one call. Everything after entering this block is potentially committed upstream.
          await form.clickOnce();
          submissionId = await form.captureId();
          const metadata: SubmissionMetadata = { submissionId, contestId: input.contestId, problemIndex: input.problemIndex, language: 'java17', submittedAt };
          await this.store.put(metadata);
          await this.store.recordAttempt({ ...attempt, state: 'confirmed', submissionId });
          console.error('[CF] submission created', { id: submissionId });
          return { ...metadata, submitted: true };
        } catch (error) {
          await this.store.recordAttempt({ ...attempt, state: 'uncertain', ...(submissionId ? { submissionId } : {}) }).catch(() => undefined);
          if (error instanceof CodeforcesError && ['SESSION_REQUIRES_MANUAL_LOGIN', 'SESSION_EXPIRED', 'CF_AUTH_REQUIRED', 'ACCOUNT_MISMATCH'].includes(error.code))
            await this.store.recordAuthInterruption?.(input.contestId, input.problemIndex).catch(() => undefined);
          throw new CodeforcesError(submissionId
            ? `Submission ${submissionId} was observed, but confirmation/storage did not complete. Do not submit again; inspect that ID with contestId ${input.contestId}.`
            : 'The submission may have been created. Inspect your own recent submissions before another invocation. No automatic retry was performed.',
          'SUBMISSION_STATE_UNCERTAIN');
        }
      });
    } catch (error) {
      // A challenge before the click has no submission attempt to reconcile, but
      // the run still needs a durable manual-auth checkpoint.
      if (error instanceof CodeforcesError && ['SESSION_REQUIRES_MANUAL_LOGIN', 'SESSION_EXPIRED', 'CF_AUTH_REQUIRED', 'ACCOUNT_MISMATCH'].includes(error.code))
        await this.store.recordAuthInterruption?.(input.contestId, input.problemIndex).catch(() => undefined);
      throw error;
    } finally { this.writing = false; }
  }
}
