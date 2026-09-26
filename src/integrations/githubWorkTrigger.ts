import { CodeforcesError } from '../codeforces/errors.js';
import type { Ordinal } from '../orchestrator/stateMachine.js';

export interface WorkTriggerInput {
  runId: string;
  contestId: number;
  ordinal: Ordinal;
  problemIndex: string;
  handle: string;
  createdAt: string;
}
export interface WorkTriggerResult { branch: string; prNumber: number }
export interface WorkTrigger { find(input: WorkTriggerInput): Promise<WorkTriggerResult | null>; ensure(input: WorkTriggerInput): Promise<WorkTriggerResult> }

export function triggerBranch(input: Pick<WorkTriggerInput, 'contestId' | 'ordinal'>): string {
  return `cf-run/${input.contestId}/p${input.ordinal}`;
}

/** Creates one deterministic branch/file/PR. An uncertain GitHub write is reconciled by GET on the next pass. */
export class GitHubWorkTrigger implements WorkTrigger {
  private readonly base: string;
  constructor(private readonly repository: string, private readonly token: string,
    private readonly fetcher: typeof fetch = fetch) {
    this.base = `https://api.github.com/repos/${repository}`;
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    // The adapter may exist throughout registration and waiting; credentials
    // become necessary only when a due problem actually reaches this request.
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repository) || !this.token)
      throw new CodeforcesError('Configure GITHUB_TRIGGER_REPO and GITHUB_TRIGGER_TOKEN.', 'TRIGGER_CONFIG_ERROR');
    try {
      return await this.fetcher(`${this.base}${path}`, {
        ...init, signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      });
    } catch { throw new CodeforcesError('GitHub trigger request timed out. Reconcile before retrying a write.', 'TRIGGER_RESULT_UNCERTAIN'); }
  }
  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) throw new CodeforcesError(`GitHub trigger API returned HTTP ${response.status}.`, 'TRIGGER_API_ERROR', response.status >= 500);
    return await response.json() as T;
  }
  async find(input: WorkTriggerInput): Promise<WorkTriggerResult | null> {
    const branch = triggerBranch(input);
    const owner = this.repository.split('/')[0]!;
    const response = await this.request(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
    const pulls = await this.json<Array<{ number: number; head: { ref: string } }>>(response);
    const exact = pulls.find((pull) => pull.head.ref === branch);
    return exact ? { branch, prNumber: exact.number } : null;
  }
  async ensure(input: WorkTriggerInput): Promise<WorkTriggerResult> {
    const existing = await this.find(input);
    if (existing) return existing;
    const branch = triggerBranch(input);
    const ref = await this.request(`/git/ref/heads/${branch}`);
    if (ref.status === 404) {
      const repo = await this.json<{ default_branch: string }>(await this.request(''));
      const head = await this.json<{ object: { sha: string } }>(await this.request(`/git/ref/heads/${encodeURIComponent(repo.default_branch).replace(/%2F/gi, '/')}`));
      const created = await this.request('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
      if (!created.ok) throw new CodeforcesError('GitHub branch creation is uncertain. Reconcile on the next pass.', 'TRIGGER_RESULT_UNCERTAIN');
    } else await this.json(ref);
    const file = `.work-runs/${input.contestId}/p${input.ordinal}.json`;
    const content = Buffer.from(JSON.stringify({ experiment: 'authorized-codeforces-ai-agent',
      contestId: input.contestId, problemOrdinal: input.ordinal, problemIndex: input.problemIndex,
      handle: input.handle, language: 'JAVA_17', createdAt: input.createdAt, runId: input.runId }, null, 2) + '\n').toString('base64');
    const fileResponse = await this.request(`/contents/${file}?ref=${encodeURIComponent(branch)}`);
    if (fileResponse.status === 404) {
      const created = await this.request(`/contents/${file}`, { method: 'PUT', body: JSON.stringify({
        message: `CF_RUN ${input.contestId} P${input.ordinal} ${input.problemIndex}`,
        content, branch,
      }) });
      if (!created.ok) throw new CodeforcesError('GitHub trigger file creation is uncertain. Reconcile on the next pass.', 'TRIGGER_RESULT_UNCERTAIN');
    } else await this.json(fileResponse);
    const again = await this.find(input);
    if (again) return again;
    const repo = await this.json<{ default_branch: string }>(await this.request(''));
    const created = await this.request('/pulls', { method: 'POST', body: JSON.stringify({
      title: `CF_RUN ${input.contestId} P${input.ordinal} ${input.problemIndex}`,
      head: branch, base: repo.default_branch,
      body: `Authorized Codeforces experiment task. Read .work-runs/${input.contestId}/p${input.ordinal}.json and follow the documented Work task contract.`,
    }) });
    if (!created.ok) throw new CodeforcesError('GitHub PR creation is uncertain. Reconcile on the next pass.', 'TRIGGER_RESULT_UNCERTAIN');
    const pr = await this.json<{ number: number }>(created);
    return { branch, prNumber: pr.number };
  }
}
