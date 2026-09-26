import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CodeforcesError } from '../codeforces/errors.js';
import type { ContestAuthorizationInput, ContestAuthorizationStore, SubmissionAttempt, SubmissionMetadata, SubmissionRecoveryStore, SubmissionStore } from './types.js';

// Service-role access stays on the server. No source code or session material is stored.
export class SupabaseSubmissionStore implements SubmissionStore, SubmissionRecoveryStore, ContestAuthorizationStore {
  private readonly client: SupabaseClient;
  constructor(url: string, key: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  async isContestAuthorized(contestId: number): Promise<boolean> {
    this.assertContestId(contestId);
    const { data, error } = await this.client.from('authorized_contests').select('status,expires_at').eq('contest_id', contestId).maybeSingle();
    if (error) throw this.failure();
    if (data?.status !== 'active') return false;
    if (data.expires_at === null) return true;
    const expiresAt = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }
  async authorizeContest(input: ContestAuthorizationInput): Promise<void> {
    this.assertContestId(input.contestId);
    const source = input.source ?? 'watcher';
    if (!source || source.length > 80) throw new CodeforcesError('Contest authorization source must be 1–80 characters.', 'INVALID_INPUT');
    const expiresAt = input.expiresAt == null ? null : Date.parse(input.expiresAt);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))
      throw new CodeforcesError('Contest authorization expiry must be a future date.', 'INVALID_INPUT');
    const now = new Date().toISOString();
    const { error } = await this.client.from('authorized_contests').upsert({
      contest_id: input.contestId, status: 'active', authorized_at: now,
      expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(), source, updated_at: now,
    }, { onConflict: 'contest_id' });
    if (error) throw this.failure();
  }
  async completeContest(contestId: number): Promise<void> { await this.setContestStatus(contestId, 'completed'); }
  async blockContest(contestId: number): Promise<void> { await this.setContestStatus(contestId, 'blocked'); }
  private async setContestStatus(contestId: number, status: 'completed' | 'blocked'): Promise<void> {
    this.assertContestId(contestId);
    const { data, error } = await this.client.from('authorized_contests').update({ status, updated_at: new Date().toISOString() })
      .eq('contest_id', contestId).select('contest_id').maybeSingle();
    if (error) throw this.failure();
    if (!data) throw new CodeforcesError('Contest authorization record was not found.', 'CONTEST_NOT_AUTHORIZED');
  }
  private assertContestId(contestId: number): void {
    if (!Number.isSafeInteger(contestId) || contestId <= 0) throw new CodeforcesError('Expected a positive contest ID.', 'INVALID_INPUT');
  }
  async get(id: number): Promise<SubmissionMetadata | undefined> {
    const { data, error } = await this.client.from('cf_submission_metadata').select('submission_id,contest_id,problem_index,language,submitted_at').eq('submission_id', id).maybeSingle();
    if (error) throw this.failure();
    return data ? { submissionId: Number(data.submission_id), contestId: Number(data.contest_id), problemIndex: data.problem_index, language: 'java17', submittedAt: data.submitted_at } : undefined;
  }
  async has(id: number): Promise<boolean> { return (await this.get(id)) !== undefined; }
  async findForProblem(contestId: number, problemIndex: string): Promise<SubmissionMetadata[]> {
    const { data, error } = await this.client.from('cf_submission_metadata')
      .select('submission_id,contest_id,problem_index,language,submitted_at')
      .eq('contest_id', contestId).eq('problem_index', problemIndex).order('submitted_at', { ascending: false }).limit(10);
    if (error) throw this.failure();
    return (data ?? []).map((row) => ({ submissionId: Number(row.submission_id), contestId: Number(row.contest_id),
      problemIndex: row.problem_index, language: 'java17' as const, submittedAt: row.submitted_at }));
  }
  async findAttemptsForProblem(contestId: number, problemIndex: string): Promise<SubmissionAttempt[]> {
    const { data, error } = await this.client.from('cf_submission_attempts')
      .select('attempt_id,contest_id,problem_index,language,submitted_at,state,submission_id,fingerprint')
      .eq('contest_id', contestId).eq('problem_index', problemIndex).order('submitted_at', { ascending: false }).limit(10);
    if (error) throw this.failure();
    return (data ?? []).map((row) => ({ attemptId: row.attempt_id, contestId: Number(row.contest_id),
      problemIndex: row.problem_index, language: 'java17' as const, submittedAt: row.submitted_at,
      state: row.state as SubmissionAttempt['state'],
      ...(row.submission_id == null ? {} : { submissionId: Number(row.submission_id) }), fingerprint: row.fingerprint }));
  }
  async put(value: SubmissionMetadata): Promise<void> {
    const { error } = await this.client.from('cf_submission_metadata').upsert({ submission_id: value.submissionId, contest_id: value.contestId, problem_index: value.problemIndex, language: value.language, submitted_at: value.submittedAt }, { onConflict: 'submission_id' });
    if (error) throw this.failure();
  }
  async checkWritable(): Promise<void> {
    const { error } = await this.client.from('cf_submission_metadata').select('submission_id').limit(1);
    if (error) throw this.failure();
  }
  async reserveAttempt(attempt: SubmissionAttempt, windowSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('cf_reserve_submission_attempt', {
      p_attempt_id: attempt.attemptId, p_contest_id: attempt.contestId, p_problem_index: attempt.problemIndex,
      p_language: attempt.language, p_submitted_at: attempt.submittedAt,
      p_fingerprint: attempt.fingerprint, p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== 'boolean') throw this.failure();
    return data;
  }
  async recordAttempt(attempt: SubmissionAttempt): Promise<void> {
    const { error } = await this.client.from('cf_submission_attempts').upsert({
      attempt_id: attempt.attemptId, contest_id: attempt.contestId, problem_index: attempt.problemIndex,
      language: attempt.language, submitted_at: attempt.submittedAt, state: attempt.state,
      submission_id: attempt.submissionId ?? null, fingerprint: attempt.fingerprint,
    }, { onConflict: 'attempt_id' });
    if (error) throw this.failure();
  }
  async recordAuthInterruption(contestId: number, problemIndex: string): Promise<void> {
    const { error } = await this.client.rpc('cf_mark_submission_manual_auth', {
      p_contest_id: contestId, p_problem_index: problemIndex,
    });
    if (error) throw this.failure();
  }
  private failure(): CodeforcesError { return new CodeforcesError('Persistent submission storage is unavailable.', 'STORAGE_ERROR', true); }
}

export function createSubmissionStore(env: NodeJS.ProcessEnv = process.env): SubmissionStore {
  const key = getSupabaseAdminKey(env);
  if (key && !env.SUPABASE_URL) throw new Error('Configure SUPABASE_URL with the server-side Supabase key.');
  if (env.SUPABASE_URL && key) {
    console.error('[STORAGE] backend=supabase');
    return new SupabaseSubmissionStore(env.SUPABASE_URL, key);
  }
  console.error('[STORAGE] backend=file');
  // Dynamic import is unnecessary here; keep the factory synchronous for startup.
  return new FileSubmissionStore(env.DATA_DIR);
}
export function getSupabaseAdminKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
  if (key?.startsWith('sb_publishable_') || key?.startsWith('sb_anon_'))
    throw new Error('A Supabase publishable key cannot access private submission metadata. Configure a server-only secret key.');
  return key;
}
import { FileSubmissionStore } from './submissions.js';
