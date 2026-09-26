import { CodeforcesError } from './errors.js';

export interface SubmissionSafetyConfig {
  enabled: boolean;
  allowedContestIds: ReadonlySet<number> | null;
  expectedHandle: string | null;
  duplicateWindowSeconds: number;
}
export function readSubmissionSafety(env: NodeJS.ProcessEnv = process.env): SubmissionSafetyConfig {
  const ids = env.CF_ALLOWED_CONTEST_IDS?.trim();
  const values = ids ? ids.split(',').map((id) => Number(id.trim())) : [];
  if (values.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('CF_ALLOWED_CONTEST_IDS must contain positive integer IDs.');
  const window = Number(env.CF_DUPLICATE_WINDOW_SECONDS || 120);
  if (!Number.isInteger(window) || window < 1 || window > 3600) throw new Error('CF_DUPLICATE_WINDOW_SECONDS must be 1–3600.');
  return { enabled: env.ALLOW_REAL_SUBMISSIONS === 'true', allowedContestIds: ids ? new Set(values) : null,
    expectedHandle: env.CF_EXPECTED_HANDLE?.trim() || null, duplicateWindowSeconds: window };
}
export function isContestAllowed(contestId: number, config: SubmissionSafetyConfig): boolean {
  return !config.allowedContestIds || config.allowedContestIds.has(contestId);
}
export class SubmissionSafety {
  private stopping = false;
  constructor(readonly config: SubmissionSafetyConfig = readSubmissionSafety()) {}
  stopWrites(): void { this.stopping = true; }
  assertEnabled(): void {
    if (this.stopping) throw new CodeforcesError('The server is shutting down.', 'WRITE_BUSY');
    if (!this.config.enabled) throw new CodeforcesError('Real Codeforces submissions are disabled by server configuration.', 'REAL_SUBMISSIONS_DISABLED');
  }
  assertStaticContestAllowed(contestId: number): void {
    if (!isContestAllowed(contestId, this.config))
      throw new CodeforcesError('This contest is not in the configured static allowlist.', 'CONTEST_NOT_IN_STATIC_ALLOWLIST');
  }
  assertPreflight(contestId: number): void {
    this.assertEnabled();
    this.assertStaticContestAllowed(contestId);
  }
  assertAccount(handle: string): void {
    if (this.config.expectedHandle && handle.toLowerCase() !== this.config.expectedHandle.toLowerCase())
      throw new CodeforcesError('The authenticated Codeforces account does not match the expected handle.', 'ACCOUNT_MISMATCH');
  }
}
