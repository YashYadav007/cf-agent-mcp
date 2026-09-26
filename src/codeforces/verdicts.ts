import * as z from 'zod/v4';
import { CodeforcesError } from './errors.js';
import { sleep } from './async.js';
import type { CodeforcesApi } from './api.js';
import type { SubmissionStore } from '../storage/types.js';

export interface NormalizedSubmission {
  id: number;
  contestId: number | null;
  problemIndex: string | null;
  programmingLanguage: string | null;
  verdict: string | null;
  passedTestCount: number | null;
  timeConsumedMillis: number | null;
  memoryConsumedBytes: number | null;
}
const numberOrNull = z.number().int().nonnegative().safe().nullish().catch(null);
const submissionSchema = z.object({
  id: z.number().int().positive().safe(), contestId: numberOrNull,
  problem: z.object({ contestId: numberOrNull, index: z.string().nullish().catch(null) }).nullish(),
  programmingLanguage: z.string().nullish().catch(null), verdict: z.string().nullish().catch(null),
  passedTestCount: numberOrNull, timeConsumedMillis: numberOrNull, memoryConsumedBytes: numberOrNull,
});
export function normalizeVerdict(raw: unknown, contestId?: number): NormalizedSubmission {
  const parsed = submissionSchema.safeParse(raw);
  if (!parsed.success) throw new CodeforcesError('Codeforces returned invalid submission metadata.', 'CF_API_ERROR');
  const value = parsed.data;
  return { id: value.id, contestId: value.contestId ?? value.problem?.contestId ?? contestId ?? null,
    problemIndex: value.problem?.index ?? null, programmingLanguage: value.programmingLanguage ?? null,
    verdict: value.verdict?.trim().toUpperCase() || null, passedTestCount: value.passedTestCount ?? null,
    timeConsumedMillis: value.timeConsumedMillis ?? null, memoryConsumedBytes: value.memoryConsumedBytes ?? null };
}
const finalVerdicts = new Set(['FAILED', 'OK', 'PARTIAL', 'COMPILATION_ERROR', 'RUNTIME_ERROR', 'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'IDLENESS_LIMIT_EXCEEDED', 'SECURITY_VIOLATED', 'CRASHED',
  'INPUT_PREPARATION_CRASHED', 'CHALLENGED', 'SKIPPED', 'REJECTED']);
export function isFinalVerdict(verdict: string | null | undefined): boolean {
  return typeof verdict === 'string' && finalVerdicts.has(verdict.trim().toUpperCase());
}
export const verdictInput = z.object({ submissionId: z.number().int().positive().safe(), contestId: z.number().int().positive().safe().optional() }).strict();
export const waitInput = verdictInput.extend({ timeoutSeconds: z.number().int().min(1).max(120).default(60) });
export type VerdictInput = z.infer<typeof verdictInput>;

export class VerdictService {
  constructor(private readonly api: Pick<CodeforcesApi, 'submissionPage'>, private readonly store: Pick<SubmissionStore, 'get'>,
    private readonly knownHandle: () => string | undefined,
    private readonly pollingMs = 4000) {}

  async get(input: VerdictInput, signal?: AbortSignal): Promise<NormalizedSubmission> {
    const metadata = await this.store.get(input.submissionId);
    if (metadata && input.contestId && metadata.contestId !== input.contestId) {
      throw new CodeforcesError('contestId conflicts with the stored submission metadata.', 'INVALID_INPUT');
    }
    const contestId = metadata?.contestId ?? input.contestId;
    const handle = this.knownHandle();
    if (!contestId && !handle) throw new CodeforcesError('Submission contest is unknown. Provide contestId, configure CF_HANDLE, or verify session_status first.', 'SUBMISSION_NOT_FOUND');
    const deadline = AbortSignal.timeout(30_000);
    const boundedSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    try {
      let useUserStatus = !contestId;
      for (let page = 0; page < 10; page++) {
        let records;
        try {
          records = await this.api.submissionPage({ ...(useUserStatus ? {} : { contestId }), handle, from: page * 1000 + 1, count: 1000 }, boundedSignal);
        } catch (error) {
          // The public API may hide contest status while still exposing this user's history.
          if (!useUserStatus && handle && error instanceof CodeforcesError && error.code === 'CF_API_ERROR' && !error.retryable) {
            useUserStatus = true; page = -1; continue;
          }
          throw error;
        }
        const record = records.find((value) => value.id === input.submissionId);
        if (record) {
          const result = normalizeVerdict(record, contestId);
          if (contestId && result.contestId !== contestId) throw new CodeforcesError('Submission does not belong to the requested contest.', 'SUBMISSION_NOT_FOUND');
          console.error('[CF] verdict', { id: result.id, verdict: result.verdict });
          return result;
        }
        if (records.length < 1000 || records.some((value) => value.id < input.submissionId)) break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new CodeforcesError('Submission lookup exceeded its time budget. Supply contestId to narrow the search.', 'CF_API_ERROR', true);
      throw error;
    }
    throw new CodeforcesError('Submission was not found in the accessible account/contest history (up to 10,000 records). Check contestId and handle.', 'SUBMISSION_NOT_FOUND', true);
  }

  async wait(raw: z.input<typeof waitInput>): Promise<{ final: boolean; timedOut: boolean; submission: NormalizedSubmission }> {
    const checked = waitInput.safeParse(raw);
    if (!checked.success) throw new CodeforcesError('Invalid verdict polling input; timeoutSeconds must be between 1 and 120.', 'INVALID_INPUT');
    const input = checked.data;
    const metadata = await this.store.get(input.submissionId);
    let submission = normalizeVerdict({ id: input.submissionId, problem: { index: metadata?.problemIndex } }, input.contestId ?? metadata?.contestId);
    const deadline = AbortSignal.timeout(input.timeoutSeconds * 1000);
    try {
      while (true) {
        try { submission = await this.get(input, deadline); }
        catch (error) {
          deadline.throwIfAborted();
          if (!(error instanceof CodeforcesError) || !error.retryable) throw error;
        }
        if (isFinalVerdict(submission.verdict)) return { final: true, timedOut: false, submission };
        await sleep(this.pollingMs, deadline);
      }
    } catch (error) {
      if (!deadline.aborted) throw error;
      return { final: false, timedOut: true, submission };
    }
  }
}
