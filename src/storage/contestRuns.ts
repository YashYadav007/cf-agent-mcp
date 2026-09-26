import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as z from 'zod/v4';
import type { ContestRun } from '../contest/run.js';
import { CodeforcesError } from '../codeforces/errors.js';
import { getSupabaseAdminKey } from './supabase.js';

export interface ContestRunStore {
  get(contestId: number): Promise<ContestRun | undefined>;
  create(run: ContestRun): Promise<void>;
  save(run: ContestRun): Promise<void>;
}

const target = z.object({ problemIndex: z.string(), earliestOffsetMinutes: z.number().int().nonnegative(),
  latestOffsetMinutes: z.number().int().nonnegative() });
const runSchema = z.object({ contestId: z.number().int().positive().safe(), status: z.enum(['planned', 'active', 'completed']),
  problemOrder: z.array(z.string()).length(4), currentProblem: z.string().nullable(),
  distinctProblemsStarted: z.array(z.string()), distinctProblemsCompleted: z.array(z.string()),
  submissionAttempts: z.record(z.string(), z.number().int().nonnegative()),
  verdicts: z.record(z.string(), z.string().nullable()), scheduleTargets: z.array(target).length(4),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(), version: z.number().int().nonnegative().safe() });

function toRow(run: ContestRun) {
  return { contest_id: run.contestId, status: run.status, problem_order: run.problemOrder,
    current_problem: run.currentProblem, distinct_problems_started: run.distinctProblemsStarted,
    distinct_problems_completed: run.distinctProblemsCompleted, submission_attempts: run.submissionAttempts,
    verdicts: run.verdicts, schedule_targets: run.scheduleTargets, started_at: run.startedAt,
    completed_at: run.completedAt, version: run.version, updated_at: new Date().toISOString() };
}
function fromRow(row: Record<string, unknown>): ContestRun {
  const parsed = runSchema.safeParse({ contestId: Number(row.contest_id), status: row.status,
    problemOrder: row.problem_order, currentProblem: row.current_problem,
    distinctProblemsStarted: row.distinct_problems_started, distinctProblemsCompleted: row.distinct_problems_completed,
    submissionAttempts: row.submission_attempts, verdicts: row.verdicts, scheduleTargets: row.schedule_targets,
    startedAt: row.started_at, completedAt: row.completed_at, version: Number(row.version) });
  if (!parsed.success) throw new CodeforcesError('Persisted contest run is invalid.', 'STORAGE_ERROR');
  return parsed.data;
}

/** Server-side only. Version-checked writes prevent a stale watcher cycle from overwriting newer progress. */
export class SupabaseContestRunStore implements ContestRunStore {
  private readonly client: SupabaseClient;
  constructor(url: string, key: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  async get(contestId: number): Promise<ContestRun | undefined> {
    if (!Number.isSafeInteger(contestId) || contestId <= 0) throw new CodeforcesError('Expected a positive contest ID.', 'INVALID_INPUT');
    const { data, error } = await this.client.from('cf_contest_runs').select('*').eq('contest_id', contestId).maybeSingle();
    if (error) throw new CodeforcesError('Contest run storage is unavailable.', 'STORAGE_ERROR', true);
    return data ? fromRow(data) : undefined;
  }
  async create(run: ContestRun): Promise<void> {
    if (!runSchema.safeParse(run).success || run.version !== 0 || run.status !== 'planned')
      throw new CodeforcesError('Invalid new contest run.', 'INVALID_INPUT');
    const { error } = await this.client.from('cf_contest_runs').insert(toRow(run));
    if (error) throw new CodeforcesError('Contest run already exists or storage is unavailable.', 'STORAGE_ERROR');
  }
  async save(run: ContestRun): Promise<void> {
    if (!runSchema.safeParse(run).success) throw new CodeforcesError('Invalid contest run.', 'INVALID_INPUT');
    const { data, error } = await this.client.from('cf_contest_runs')
      .update({ ...toRow(run), version: run.version + 1 }).eq('contest_id', run.contestId)
      .eq('version', run.version).select('contest_id').maybeSingle();
    if (error) throw new CodeforcesError('Contest run storage is unavailable.', 'STORAGE_ERROR', true);
    if (!data) throw new CodeforcesError('Contest run changed concurrently. Reload before writing.', 'RUN_VERSION_CONFLICT');
  }
}

export function createContestRunStore(env: NodeJS.ProcessEnv = process.env): ContestRunStore {
  const key = getSupabaseAdminKey(env);
  if (!env.SUPABASE_URL || !key) throw new CodeforcesError('Supabase is required for persistent contest runs.', 'STORAGE_ERROR');
  return new SupabaseContestRunStore(env.SUPABASE_URL, key);
}
