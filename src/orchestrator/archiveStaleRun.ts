import { randomUUID } from 'node:crypto';
import type { CodeforcesApi } from '../codeforces/api.js';
import { CodeforcesError } from '../codeforces/errors.js';
import { isDiv1Contest } from '../contest/eligibility.js';
import type { CloudTasksConfig, WakeupScheduler } from '../integrations/cloudTasks.js';
import type { ContestAuthorizationStore } from '../storage/types.js';
import { transition } from './stateMachine.js';
import type { ExperimentRun, RunStore } from './types.js';

type ArchiveDeps = {
  api: Pick<CodeforcesApi, 'contests'>;
  runs: Pick<RunStore, 'get' | 'claim' | 'save' | 'release' | 'listProblems'>;
  authorization: Pick<ContestAuthorizationStore, 'isContestAuthorized'>;
  scheduler: Pick<WakeupScheduler, 'cancel'>;
  cloud: CloudTasksConfig;
  now?: () => Date;
};

function requireStaleUnregisteredRun(run: ExperimentRun, contestId: number): void {
  if (run.contestId !== contestId || run.state !== 'NEEDS_MANUAL_AUTH' ||
      run.pendingOperation !== 'registration_status' || run.recoveryReason !== 'SESSION_REQUIRES_MANUAL_LOGIN' ||
      run.registrationConfirmedAt || run.currentProblemOrdinal !== null || run.problemOrder.length !== 0) {
    throw new CodeforcesError('Run is not the expected unregistered manual-auth recovery record.', 'RUN_NOT_ARCHIVABLE');
  }
}

/** Close only a finished, unregistered, pre-execution manual-auth run. Does not inspect registration or login state. */
export async function archiveStaleManualAuthRun(contestId: number, deps: ArchiveDeps): Promise<ExperimentRun> {
  const now = deps.now ?? (() => new Date());
  const official = (await deps.api.contests(false)).find((item) => item.id === contestId);
  const ended = official?.phase === 'FINISHED' && isDiv1Contest(official) &&
    official.startTimeSeconds !== undefined && official.startTimeSeconds * 1000 + official.durationSeconds * 1000 <= now().getTime();
  if (!official || !ended) throw new CodeforcesError('Contest is not confirmed finished by official contest.list.', 'CONTEST_NOT_ARCHIVABLE');

  const existing = await deps.runs.get(contestId);
  if (!existing) throw new CodeforcesError('Persisted run was not found.', 'RUN_NOT_ARCHIVABLE');
  requireStaleUnregisteredRun(existing, contestId);
  if (await deps.authorization.isContestAuthorized(contestId))
    throw new CodeforcesError('Contest still has active submission authorization.', 'RUN_NOT_ARCHIVABLE');
  if ((await deps.runs.listProblems(existing.runId)).length !== 0)
    throw new CodeforcesError('Run has problem execution records and cannot be archived by this path.', 'RUN_NOT_ARCHIVABLE');
  const expectedPrefix = `projects/${deps.cloud.projectId}/locations/${deps.cloud.region}/queues/${deps.cloud.queue}/tasks/`;
  if (existing.scheduledTaskName && !existing.scheduledTaskName.startsWith(expectedPrefix))
    throw new CodeforcesError('Persisted wakeup does not belong to the configured queue.', 'SCHEDULER_CONFIG_ERROR');

  const claimed = await deps.runs.claim(contestId, randomUUID(), now());
  if (!claimed) throw new CodeforcesError('Run is leased by another reconciliation pass.', 'RUN_BUSY', true);
  let lease = claimed;
  try {
    requireStaleUnregisteredRun(claimed, contestId);
    if (await deps.authorization.isContestAuthorized(contestId))
      throw new CodeforcesError('Contest still has active submission authorization.', 'RUN_NOT_ARCHIVABLE');
    if ((await deps.runs.listProblems(claimed.runId)).length !== 0)
      throw new CodeforcesError('Run has problem execution records and cannot be archived by this path.', 'RUN_NOT_ARCHIVABLE');
    if (claimed.scheduledTaskName) await deps.scheduler.cancel(claimed.scheduledTaskName);
    const archivedAt = now().toISOString();
    const audit = {
      action: 'STALE_CONTEST_ARCHIVED', reason: 'official_contest_finished_before_registration_or_problem_execution',
      archivedAt, officialContestName: official.name, officialContestPhase: official.phase,
      previous: { state: claimed.state, pendingOperation: claimed.pendingOperation,
        recoveryReason: claimed.recoveryReason, resumeState: claimed.resumeState,
        registrationStatus: claimed.registrationStatus, lastErrorCode: claimed.lastErrorCode,
        lastErrorMessage: claimed.lastErrorMessage, nextReconcileAt: claimed.nextReconcileAt,
        nextReconcileReason: claimed.nextReconcileReason, scheduledTaskName: claimed.scheduledTaskName },
    };
    lease = await deps.runs.save({ ...claimed, state: transition(claimed.state, 'BLOCKED'),
      lastErrorCode: 'STALE_CONTEST_ARCHIVED', lastErrorMessage: JSON.stringify(audit),
      completedAt: archivedAt, nextReconcileAt: null, nextReconcileReason: null, scheduledTaskName: null });
    return lease;
  } finally {
    await deps.runs.release(lease);
  }
}
