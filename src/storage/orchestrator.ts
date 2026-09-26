import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CodeforcesError } from '../codeforces/errors.js';
import type { ExperimentRun, ProblemExecution, RunStore } from '../orchestrator/types.js';
import type { Ordinal, RunState } from '../orchestrator/stateMachine.js';
import { getSupabaseAdminKey } from './supabase.js';

const storageError = () => new CodeforcesError('Contest orchestration storage is unavailable.', 'STORAGE_ERROR', true);
function fromRow(row: Record<string, unknown>): ExperimentRun {
  return {
    runId: String(row.run_id), contestId: Number(row.contest_id), contestName: String(row.contest_name),
    handle: String(row.handle), ratingBefore: row.rating_before == null ? null : Number(row.rating_before),
    ratingAfter: row.rating_after == null ? null : Number(row.rating_after),
    ratingDelta: row.rating_delta == null ? null : Number(row.rating_delta),
    rankAfter: row.rank_after as string | null, maxRatingAfter: row.max_rating_after == null ? null : Number(row.max_rating_after),
    ratedForAccount: row.rated_for_account as boolean | null, ratingSource: row.rating_source as string | null,
    registrationStatus: row.registration_status as ExperimentRun['registrationStatus'],
    registrationConfirmedAt: row.registration_confirmed_at as string | null,
    contestStartAt: String(row.contest_start_at), state: row.orchestration_state as RunState,
    currentProblemOrdinal: row.current_problem_ordinal as Ordinal | null,
    problemOrder: row.problem_order as string[], lastErrorCode: row.last_error_code as string | null,
    lastErrorMessage: row.last_error_message as string | null,
    pendingOperation: row.pending_operation as ExperimentRun['pendingOperation'],
    authRequiredAt: row.auth_required_at as string | null, authRecoveredAt: row.auth_recovered_at as string | null,
    lastAuthCheckAt: row.last_auth_check_at as string | null, recoveryReason: row.recovery_reason as string | null,
    resumeState: row.resume_state as RunState | null, ratingDeadlineAt: row.rating_deadline_at as string | null,
    completedAt: row.completed_at as string | null, version: Number(row.version),
    leaseOwner: row.lease_owner as string | null, leaseExpiresAt: row.lease_expires_at as string | null,
  };
}
function runRow(run: ExperimentRun): Record<string, unknown> {
  const done = ['CONTEST_COMPLETE', 'WAITING_FOR_RATING', 'RATING_UPDATED', 'RATING_TIMEOUT', 'BLOCKED', 'FAILED'].includes(run.state);
  const active = run.problemOrder.length === 4 && !done;
  return {
    run_id: run.runId, contest_id: run.contestId, status: done ? 'completed' : active ? 'active' : 'planned',
    problem_order: run.problemOrder, current_problem: run.currentProblemOrdinal ? run.problemOrder[run.currentProblemOrdinal - 1] : null,
    distinct_problems_started: [], distinct_problems_completed: [], submission_attempts: {}, verdicts: {},
    schedule_targets: [], started_at: active ? run.contestStartAt : null,
    completed_at: done ? run.completedAt ?? new Date().toISOString() : null,
    contest_name: run.contestName, selected_division: 'Div.1', handle: run.handle,
    rating_before: run.ratingBefore, rating_after: run.ratingAfter, rating_delta: run.ratingDelta,
    rank_after: run.rankAfter, max_rating_after: run.maxRatingAfter, rated_for_account: run.ratedForAccount,
    rating_source: run.ratingSource, registration_status: run.registrationStatus,
    registration_confirmed_at: run.registrationConfirmedAt, contest_start_at: run.contestStartAt,
    current_problem_ordinal: run.currentProblemOrdinal, orchestration_state: run.state,
    last_error_code: run.lastErrorCode, last_error_message: run.lastErrorMessage,
    pending_operation: run.pendingOperation, auth_required_at: run.authRequiredAt,
    auth_recovered_at: run.authRecoveredAt, last_auth_check_at: run.lastAuthCheckAt,
    recovery_reason: run.recoveryReason, resume_state: run.resumeState,
    rating_deadline_at: run.ratingDeadlineAt, lease_owner: run.leaseOwner, lease_expires_at: run.leaseExpiresAt,
    updated_at: new Date().toISOString(),
  };
}
function fromProblem(row: Record<string, unknown>): ProblemExecution {
  return {
    runId: String(row.run_id), ordinal: Number(row.ordinal) as Ordinal, problemIndex: String(row.problem_index),
    windowStart: String(row.window_start), windowEnd: String(row.window_end), state: row.state as ProblemExecution['state'],
    triggeredAt: row.triggered_at as string | null, githubBranch: row.github_branch as string | null,
    githubPrNumber: row.github_pr_number as number | null,
    submissionId: row.submission_id == null ? null : Number(row.submission_id), verdict: row.verdict as string | null,
    lastErrorCode: row.last_error_code as string | null, version: Number(row.version),
  };
}
function problemRow(problem: ProblemExecution): Record<string, unknown> {
  return { run_id: problem.runId, ordinal: problem.ordinal, problem_index: problem.problemIndex,
    window_start: problem.windowStart, window_end: problem.windowEnd, state: problem.state,
    triggered_at: problem.triggeredAt, github_branch: problem.githubBranch,
    github_pr_number: problem.githubPrNumber, submission_id: problem.submissionId,
    verdict: problem.verdict, last_error_code: problem.lastErrorCode,
    updated_at: new Date().toISOString() };
}

/** Version-checked writes plus a short lease serialize watcher side effects across jobs. */
export class SupabaseOrchestratorStore implements RunStore {
  private readonly client: SupabaseClient;
  constructor(url: string, key: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  async listOpen(): Promise<ExperimentRun[]> {
    const { data, error } = await this.client.from('cf_contest_runs').select('*').not('orchestration_state', 'is', null).order('contest_start_at');
    if (error) throw storageError();
    return (data ?? []).map(fromRow).filter((run) => !['RATING_UPDATED', 'RATING_TIMEOUT', 'BLOCKED', 'FAILED'].includes(run.state));
  }
  async get(contestId: number): Promise<ExperimentRun | undefined> {
    const { data, error } = await this.client.from('cf_contest_runs').select('*').eq('contest_id', contestId).maybeSingle();
    if (error) throw storageError();
    return data?.orchestration_state ? fromRow(data) : undefined;
  }
  async create(run: ExperimentRun): Promise<boolean> {
    const { error } = await this.client.from('cf_contest_runs').insert({ ...runRow(run), version: 0 });
    if (error?.code === '23505') return false;
    if (error) throw storageError();
    return true;
  }
  async claim(contestId: number, owner: string, now: Date): Promise<ExperimentRun | undefined> {
    const current = await this.get(contestId);
    if (!current || (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > now.getTime())) return undefined;
    const until = new Date(now.getTime() + 4 * 60_000).toISOString();
    const { data, error } = await this.client.from('cf_contest_runs')
      .update({ lease_owner: owner, lease_expires_at: until, version: current.version + 1 })
      .eq('contest_id', contestId).eq('version', current.version)
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${now.toISOString()}`).select('*').maybeSingle();
    if (error) throw storageError();
    return data ? fromRow(data) : undefined;
  }
  async save(run: ExperimentRun): Promise<ExperimentRun> {
    if (!run.leaseOwner) throw new CodeforcesError('Run lease is required to save progress.', 'RUN_LEASE_REQUIRED');
    const { data, error } = await this.client.from('cf_contest_runs')
      .update({ ...runRow(run), version: run.version + 1 })
      .eq('contest_id', run.contestId).eq('version', run.version).eq('lease_owner', run.leaseOwner)
      .select('*').maybeSingle();
    if (error) throw storageError();
    if (!data) throw new CodeforcesError('Run changed concurrently. Reconcile on the next pass.', 'RUN_VERSION_CONFLICT');
    return fromRow(data);
  }
  async release(run: ExperimentRun): Promise<void> {
    if (!run.leaseOwner) return;
    const { error } = await this.client.from('cf_contest_runs')
      .update({ lease_owner: null, lease_expires_at: null, version: run.version + 1 })
      .eq('contest_id', run.contestId).eq('version', run.version).eq('lease_owner', run.leaseOwner);
    if (error) throw storageError();
  }
  async listProblems(runId: string): Promise<ProblemExecution[]> {
    const { data, error } = await this.client.from('cf_contest_run_problems').select('*').eq('run_id', runId).order('ordinal');
    if (error) throw storageError();
    return (data ?? []).map(fromProblem);
  }
  async createProblems(problems: ProblemExecution[]): Promise<void> {
    if (problems.length !== 4 || problems.some((problem, index) => problem.ordinal !== index + 1) ||
        new Set(problems.map((problem) => problem.problemIndex)).size !== 4)
      throw new CodeforcesError('Exactly four distinct official problems are required.', 'INVALID_INPUT');
    const { error } = await this.client.from('cf_contest_run_problems').upsert(problems.map((problem) => ({
      ...problemRow(problem), version: 0,
    })), { onConflict: 'run_id,ordinal', ignoreDuplicates: true });
    if (error) throw storageError();
    const persisted = await this.listProblems(problems[0]!.runId);
    if (persisted.length !== 4 || persisted.some((p, i) => p.problemIndex !== problems[i]!.problemIndex))
      throw new CodeforcesError('Persisted problem selection differs from the official first four.', 'RUN_VERSION_CONFLICT');
  }
  async saveProblem(problem: ProblemExecution): Promise<ProblemExecution> {
    const { data, error } = await this.client.from('cf_contest_run_problems')
      .update({ ...problemRow(problem), version: problem.version + 1 })
      .eq('run_id', problem.runId).eq('ordinal', problem.ordinal).eq('version', problem.version)
      .select('*').maybeSingle();
    if (error) throw storageError();
    if (!data) throw new CodeforcesError('Problem changed concurrently. Reconcile on the next pass.', 'RUN_VERSION_CONFLICT');
    return fromProblem(data);
  }
}

export function createOrchestratorStore(env: NodeJS.ProcessEnv = process.env): RunStore {
  const key = getSupabaseAdminKey(env);
  if (!env.SUPABASE_URL || !key) throw new CodeforcesError('Persistent Supabase storage is required for orchestration.', 'STORAGE_ERROR');
  return new SupabaseOrchestratorStore(env.SUPABASE_URL, key);
}
