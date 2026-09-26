import { RateLimiter } from './rateLimiter.js';
import { sleep } from './async.js';
import { CodeforcesError } from './errors.js';
import type { Contest, Problem, Submission, CodeforcesUser, RatingChange } from './types.js';
export { CodeforcesError } from './errors.js';

const limiter = new RateLimiter(2000);
export function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
  // Long Retry-After delays are surfaced to the caller instead of retrying early.
  return Math.max(2000 * 2 ** attempt, requested);
}

export class CodeforcesApi {
  constructor(private readonly timeoutMs = 15000, private readonly fetcher: typeof fetch = fetch,
    private readonly gate: Pick<RateLimiter, 'wait'> = limiter) {}

  async get<T>(method: string, params: Record<string, string | number | boolean> = {}, signal?: AbortSignal): Promise<T> {
    const url = new URL(method, 'https://codeforces.com/api/');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.gate.wait(signal);
      let retryAfter: string | null = null;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetcher(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'cf-agent-mcp/2.0' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        retryAfter = response.headers.get('retry-after');
        if (!response.ok) {
          await response.body?.cancel();
          throw new CodeforcesError(`Codeforces API returned HTTP ${response.status}.`,
            response.status === 429 ? 'CF_RATE_LIMITED' : 'CF_API_ERROR', response.status === 429 || response.status >= 500);
        }
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('status' in envelope)) {
          throw new CodeforcesError('Codeforces returned invalid API data.', 'CF_API_ERROR');
        }
        const body = envelope as { status: unknown; result?: T; comment?: unknown };
        if (body.status === 'OK' && body.result !== undefined) return body.result;
        const limited = typeof body.comment === 'string' && /call limit|too many|rate limit/i.test(body.comment);
        // Upstream comments are deliberately not reflected into logs/tool results.
        throw new CodeforcesError(limited ? 'Codeforces API rate limit reached. Try again later.' :
          'Codeforces rejected the API request. Check the identifiers and public visibility.',
        limited ? 'CF_RATE_LIMITED' : 'CF_API_ERROR', limited);
      } catch (error) {
        signal?.throwIfAborted();
        const safe = error instanceof CodeforcesError ? error :
          new CodeforcesError('Codeforces API request failed or timed out.', 'CF_API_ERROR', true);
        const delay = retryDelay(attempt, retryAfter);
        if (!safe.retryable || attempt === 2 || delay > 30_000) throw safe;
        await sleep(delay, signal);
      }
    }
    throw new CodeforcesError('Codeforces API unavailable.', 'CF_API_ERROR', true);
  }

  contests(gym: boolean): Promise<Contest[]> { return this.get('contest.list', { gym }); }
  async userInfo(handle: string): Promise<CodeforcesUser> {
    const users = await this.get<CodeforcesUser[]>('user.info', { handles: handle, checkHistoricHandles: false });
    if (!Array.isArray(users) || users.length !== 1 || !users[0] || typeof users[0].handle !== 'string')
      throw new CodeforcesError('Official Codeforces account profile is unavailable.', 'CF_API_ERROR');
    return users[0];
  }
  async contestProblems(contestId: number): Promise<Problem[]> {
    const result = await this.get<{ problems: Problem[] }>('contest.standings', { contestId });
    if (!Array.isArray(result.problems)) throw new CodeforcesError('Contest problem data is unavailable.', 'CF_API_ERROR');
    return result.problems;
  }
  async contestRatingChanges(contestId: number): Promise<RatingChange[]> {
    const changes = await this.get<RatingChange[]>('contest.ratingChanges', { contestId });
    if (!Array.isArray(changes)) throw new CodeforcesError('Contest rating-change data is unavailable.', 'CF_API_ERROR');
    return changes;
  }
  async userRating(handle: string): Promise<RatingChange[]> {
    const changes = await this.get<RatingChange[]>('user.rating', { handle });
    if (!Array.isArray(changes)) throw new CodeforcesError('Account rating history is unavailable.', 'CF_API_ERROR');
    return changes;
  }
  async submissionPage(params: { contestId?: number; handle?: string; from: number; count: number }, signal?: AbortSignal): Promise<Submission[]> {
    if (!params.contestId && !params.handle) throw new CodeforcesError('Provide contestId or configure CF_HANDLE.', 'INVALID_INPUT');
    const query: Record<string, string | number> = { from: params.from, count: params.count };
    if (params.contestId) query.contestId = params.contestId;
    if (params.handle) query.handle = params.handle;
    const records = await this.get<Submission[]>(params.contestId ? 'contest.status' : 'user.status', query, signal);
    if (!Array.isArray(records)) throw new CodeforcesError('Invalid submission list from Codeforces.', 'CF_API_ERROR');
    return records;
  }
}
