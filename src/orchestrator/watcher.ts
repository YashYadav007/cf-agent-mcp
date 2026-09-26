import { randomUUID } from 'node:crypto';
import type { CodeforcesApi } from '../codeforces/api.js';
import type { BrowserAccess } from '../codeforces/browser.js';
import { CodeforcesError, publicError } from '../codeforces/errors.js';
import type { AccountProfileService } from '../codeforces/profile.js';
import type { ContestRegistrationService } from '../codeforces/registration.js';
import type { Contest, Submission } from '../codeforces/types.js';
import { isFinalVerdict } from '../codeforces/verdicts.js';
import { selectUpcomingDiv1, isDiv1Contest } from '../contest/eligibility.js';
import type { WorkTrigger, WorkTriggerInput } from '../integrations/githubWorkTrigger.js';
import type { ContestAuthorizationStore, SubmissionRecoveryStore } from '../storage/types.js';
import type { ExperimentConfig } from './config.js';
import { reconcileRating } from './ratingWatcher.js';
import { isAuthChallenge, ORDINALS, transition, type Ordinal, type PendingOperation, type RunState } from './stateMachine.js';
import type { ExperimentRun, ProblemExecution, RunStore } from './types.js';

export interface WatcherDependencies {
  api: Pick<CodeforcesApi, 'contests' | 'contestProblems' | 'submissionPage' | 'contestRatingChanges' | 'userRating'>;
  browser: Pick<BrowserAccess, 'getSessionStatus' | 'probeSubmissionPage'>;
  profile: Pick<AccountProfileService, 'getAccountProfile'>;
  registration: Pick<ContestRegistrationService, 'status' | 'register'>;
  runs: RunStore;
  submissions: SubmissionRecoveryStore;
  authorization: ContestAuthorizationStore;
  trigger: WorkTrigger;
  config: ExperimentConfig;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

type SubmissionEvidence = { kind: 'confirmed'; submission: Submission } | { kind: 'no_mutation' } | { kind: 'uncertain' };
const terminal = new Set<RunState>(['RATING_UPDATED', 'RATING_TIMEOUT', 'BLOCKED', 'FAILED']);
const preRegistration = new Set<RunState>(['DISCOVERED', 'WAITING_FOR_REGISTRATION', 'REGISTRATION_READY',
  'REGISTERING', 'REGISTRATION_RESULT_UNCERTAIN']);
const temporaryRegistrationStatuses = new Set(['registration_not_open', 'registration_closed', 'unknown']);
const temporaryRegistrationCodes = new Set(['REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED',
  'REGISTRATION_FORM_UNAVAILABLE', 'CF_PAGE_FETCH_FAILED']);

/** Reopen only a legacy block with recorded temporary registration evidence. */
export function canRecoverRegistrationBlock(run: ExperimentRun, contest: Contest, expectedHandle: string, now: Date): boolean {
  if (run.state !== 'BLOCKED' || run.contestId !== contest.id || contest.phase !== 'BEFORE' ||
      !isDiv1Contest(contest) || !contest.startTimeSeconds || contest.startTimeSeconds * 1000 <= now.getTime() ||
      run.handle.toLowerCase() !== expectedHandle.toLowerCase() || run.registrationConfirmedAt ||
      run.currentProblemOrdinal || run.problemOrder.length || run.pendingOperation) return false;
  if (run.registrationStatus && !temporaryRegistrationStatuses.has(run.registrationStatus)) return false;
  return !!run.lastErrorCode && temporaryRegistrationCodes.has(run.lastErrorCode);
}

export function newExperimentRun(contest: Contest, handle: string, rating: number | null): ExperimentRun {
  if (!contest.startTimeSeconds || !isDiv1Contest(contest) || contest.phase !== 'BEFORE')
    throw new CodeforcesError('Only an upcoming official Div.1 contest can create a run.', 'CONTEST_NOT_ELIGIBLE');
  return {
    runId: randomUUID(), contestId: contest.id, contestName: contest.name, handle,
    ratingBefore: rating, ratingAfter: null, ratingDelta: null, rankAfter: null, maxRatingAfter: null,
    ratedForAccount: null, ratingSource: null, registrationStatus: null, registrationConfirmedAt: null,
    contestStartAt: new Date(contest.startTimeSeconds * 1000).toISOString(), state: 'DISCOVERED',
    currentProblemOrdinal: null, problemOrder: [], lastErrorCode: null, lastErrorMessage: null,
    pendingOperation: null, authRequiredAt: null, authRecoveredAt: null, lastAuthCheckAt: null,
    recoveryReason: null, resumeState: null, ratingDeadlineAt: null, completedAt: null,
    version: 0, leaseOwner: null, leaseExpiresAt: null,
  };
}

export function scheduleProblems(run: ExperimentRun, official: readonly { index: string }[],
  windows: ExperimentConfig['windows']): ProblemExecution[] {
  const indices = [...new Set(official.map((item) => item.index))].slice(0, 4);
  if (indices.length !== 4 || indices.some((index) => !/^[A-Z][A-Z0-9]*$/.test(index)))
    throw new CodeforcesError('Contest must publish four distinct indexed problems.', 'INSUFFICIENT_CONTEST_PROBLEMS');
  return ORDINALS.map((ordinal) => ({
    runId: run.runId, ordinal, problemIndex: indices[ordinal - 1]!,
    windowStart: new Date(Date.parse(run.contestStartAt) + windows[ordinal - 1]!.earliestMinute * 60_000).toISOString(),
    windowEnd: new Date(Date.parse(run.contestStartAt) + windows[ordinal - 1]!.latestMinute * 60_000).toISOString(),
    state: 'waiting', triggeredAt: null, githubBranch: null, githubPrNumber: null,
    submissionId: null, verdict: null, lastErrorCode: null, version: 0,
  }));
}

export class ExperimentWatcher {
  private run!: ExperimentRun;
  private readonly now: () => Date;
  private readonly log: (event: Record<string, unknown>) => void;
  constructor(private readonly deps: WatcherDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((event) => console.error(JSON.stringify(event)));
  }
  private event(action: string, before: RunState, extra: Record<string, unknown> = {}): void {
    this.log({ runId: this.run.runId, contestId: this.run.contestId, stateBefore: before,
      stateAfter: this.run.state, action, ...extra });
  }
  private async save(to: RunState, action: string, patch: Partial<ExperimentRun> = {}, extra: Record<string, unknown> = {}): Promise<void> {
    const before = this.run.state;
    this.run = await this.deps.runs.save({ ...this.run, ...patch, state: transition(before, to) });
    this.event(action, before, extra);
  }
  private async manual(operation: PendingOperation, reason: string): Promise<void> {
    const now = this.now().toISOString();
    const prior = this.run.state === 'NEEDS_MANUAL_AUTH' ? this.run.resumeState : this.run.state;
    await this.save('NEEDS_MANUAL_AUTH', 'AUTH_REQUIRED', {
      pendingOperation: operation, authRequiredAt: this.run.state === 'NEEDS_MANUAL_AUTH' ? this.run.authRequiredAt ?? now : now,
      authRecoveredAt: null,
      lastAuthCheckAt: now, recoveryReason: reason,
      resumeState: prior, lastErrorCode: reason, lastErrorMessage: null,
    }, { pendingOperation: operation, errorCode: reason });
  }
  private async recovered(to: RunState, action: string, patch: Partial<ExperimentRun> = {}): Promise<void> {
    await this.save(to, action, { authRecoveredAt: this.now().toISOString(), lastAuthCheckAt: this.now().toISOString(),
      pendingOperation: null, recoveryReason: null, resumeState: null, lastErrorCode: null,
      lastErrorMessage: null, ...patch }, { pendingOperation: this.run.pendingOperation });
  }
  private async checkSession(): Promise<boolean> {
    const status = await this.deps.browser.getSessionStatus();
    return status.authenticated && !!status.handle &&
      status.handle.toLowerCase() === this.run.handle.toLowerCase() &&
      status.handle.toLowerCase() === this.deps.config.handle.toLowerCase();
  }
  private async submissionEvidence(problem: ProblemExecution): Promise<SubmissionEvidence> {
    const attempts = await this.deps.submissions.findAttemptsForProblem(this.run.contestId, problem.problemIndex);
    const metadata = await this.deps.submissions.findForProblem(this.run.contestId, problem.problemIndex);
    const ids = new Set(attempts.map((attempt) => attempt.submissionId).filter((id): id is number => !!id));
    const matching = metadata.filter((item) => ids.has(item.submissionId) && item.language === 'java17' &&
      (!problem.triggeredAt || Date.parse(item.submittedAt) >= Date.parse(problem.triggeredAt) - 60_000));
    if (matching.length === 1) {
      const records = await this.deps.api.submissionPage({ contestId: this.run.contestId,
        handle: this.run.handle, from: 1, count: 1000 });
      const record = records.find((item) => item.id === matching[0]!.submissionId);
      if (record && (record.contestId ?? record.problem.contestId) === this.run.contestId && record.problem.index === problem.problemIndex &&
          record.author?.members?.some((member) => member.handle.toLowerCase() === this.run.handle.toLowerCase()))
        return { kind: 'confirmed', submission: record };
    }
    if (!attempts.length && !metadata.length) return { kind: 'no_mutation' };
    return { kind: 'uncertain' };
  }
  private async recoverAuth(): Promise<void> {
    const pending = this.run.pendingOperation;
    const checkedAt = this.now().toISOString();
    if (!await this.checkSession()) {
      await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt });
      return;
    }
    try {
      if (pending === 'registration' || pending === 'registration_status') {
        const status = await this.deps.registration.status({ contestId: this.run.contestId });
        if (status.status === 'verification_required' ||
            (status.handle && status.handle.toLowerCase() !== this.run.handle.toLowerCase())) {
          await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt });
          return;
        }
        if (status.status === 'registered') {
          const profile = await this.deps.profile.getAccountProfile();
          if (profile.handle.toLowerCase() !== this.run.handle.toLowerCase()) {
            await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt });
            return;
          }
          await this.recovered('REGISTERED', 'AUTH_RECOVERY_RECONCILED', {
            registrationStatus: 'registered', registrationConfirmedAt: checkedAt, ratingBefore: profile.rating });
          return;
        }
        if (status.status === 'rating_ineligible') {
          await this.recovered('BLOCKED', 'AUTH_RECOVERY_RECONCILED', {
            registrationStatus: status.status, completedAt: checkedAt,
            lastErrorCode: 'CONTEST_REGISTRATION_INELIGIBLE',
            lastErrorMessage: status.reason ?? null });
          return;
        }
        const available = status.status === 'not_registered';
        await this.recovered(available ? 'REGISTRATION_READY' :
          this.run.resumeState === 'REGISTERING' || this.run.resumeState === 'REGISTRATION_RESULT_UNCERTAIN' ?
            'REGISTRATION_RESULT_UNCERTAIN' : 'WAITING_FOR_REGISTRATION',
        'AUTH_RECOVERY_RECONCILED', { registrationStatus: status.status });
        return; // A later pass may choose to click; this pass never replays the old mutation.
      }
      if (pending === 'submission' || pending === 'verdict') {
        if (!this.deps.browser.probeSubmissionPage ||
            !await this.deps.browser.probeSubmissionPage(this.run.contestId)) {
          await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt });
          return;
        }
        const ordinal = this.run.currentProblemOrdinal;
        const problem = (await this.deps.runs.listProblems(this.run.runId)).find((item) => item.ordinal === ordinal);
        if (!problem) { await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt }); return; }
        const evidence = await this.submissionEvidence(problem);
        if (evidence.kind === 'confirmed') {
          await this.deps.runs.saveProblem({ ...problem, state: 'submitted', submissionId: evidence.submission.id });
          await this.recovered(`PROBLEM_${ordinal}_SUBMITTED` as RunState, 'AUTH_RECOVERY_RECONCILED');
          return;
        }
        if (evidence.kind === 'no_mutation' && pending === 'submission') {
          await this.recovered(`PROBLEM_${ordinal}_TRIGGERED` as RunState, 'AUTH_RECOVERY_RECONCILED');
          return;
        }
        await this.recovered('SUBMISSION_RESULT_UNCERTAIN', 'AUTH_RECOVERY_RECONCILED');
        return;
      }
      // Public problem/contest reads have no mutation to replay. The next pass retries only a safe read.
      const resume = this.run.resumeState ?? 'WAITING_FOR_START';
      await this.recovered(resume, 'AUTH_RECOVERED');
    } catch (error) {
      const safe = publicError(error);
      if (isAuthChallenge(safe.code)) {
        await this.save('NEEDS_MANUAL_AUTH', 'AUTH_STILL_REQUIRED', { lastAuthCheckAt: checkedAt });
        return;
      }
      throw error;
    }
  }
  private async registration(contest: Contest): Promise<void> {
    if (contest.phase !== 'BEFORE' || !isDiv1Contest(contest)) {
      await this.save('BLOCKED', 'CONTEST_NOT_ELIGIBLE', { completedAt: this.now().toISOString() }); return;
    }
    // Fresh official rating and account identity on every eligibility pass.
    const profile = await this.deps.profile.getAccountProfile();
    if (profile.handle.toLowerCase() !== this.run.handle.toLowerCase()) {
      await this.manual('registration_status', 'ACCOUNT_MISMATCH'); return;
    }
    const status = await this.deps.registration.status({ contestId: this.run.contestId });
    if (status.status === 'verification_required') { await this.manual('registration_status', 'SESSION_REQUIRES_MANUAL_LOGIN'); return; }
    if (status.handle && status.handle.toLowerCase() !== this.run.handle.toLowerCase()) {
      await this.manual('registration_status', 'ACCOUNT_MISMATCH'); return;
    }
    if (status.status === 'registered') {
      await this.save('REGISTERED', 'REGISTRATION_CONFIRMED', { registrationStatus: 'registered',
        registrationConfirmedAt: this.now().toISOString(), ratingBefore: profile.rating }); return;
    }
    if (status.status === 'rating_ineligible') {
      await this.save('BLOCKED', 'REGISTRATION_BLOCKED', { registrationStatus: status.status,
        completedAt: this.now().toISOString(), lastErrorCode: status.status.toUpperCase(),
        lastErrorMessage: status.reason ?? null }); return;
    }
    if (temporaryRegistrationStatuses.has(status.status)) {
      if (this.run.state === 'REGISTERING' || this.run.state === 'REGISTRATION_RESULT_UNCERTAIN') {
        await this.save('REGISTRATION_RESULT_UNCERTAIN', 'REGISTRATION_STILL_UNCERTAIN',
          { registrationStatus: status.status });
      } else {
        await this.save('WAITING_FOR_REGISTRATION', 'REGISTRATION_UNAVAILABLE',
          { registrationStatus: status.status, lastErrorCode: null, lastErrorMessage: null });
      }
      return;
    }
    if (status.status !== 'not_registered') return;
    if (this.run.state === 'REGISTERING' || this.run.state === 'REGISTRATION_RESULT_UNCERTAIN') {
      // A fresh read proves registration did not occur, but this pass must not replay the prior click.
      await this.save('REGISTRATION_READY', 'REGISTRATION_RECONCILED', { registrationStatus: status.status }); return;
    }
    if (this.run.state !== 'REGISTRATION_READY')
      await this.save('REGISTRATION_READY', 'REGISTRATION_READY', { registrationStatus: status.status });
    if (!await this.checkSession()) { await this.manual('registration', 'CF_AUTH_REQUIRED'); return; }
    await this.save('REGISTERING', 'REGISTRATION_ATTEMPT_STARTED');
    try {
      await this.deps.registration.register({ contestId: this.run.contestId });
      // The registration service confirms with a fresh official read after its sole click.
      await this.save('REGISTERED', 'REGISTRATION_CONFIRMED', { registrationStatus: 'registered',
        registrationConfirmedAt: this.now().toISOString(), ratingBefore: profile.rating });
    } catch (error) {
      const safe = publicError(error);
      if (isAuthChallenge(safe.code) || (safe.code === 'REGISTRATION_RESULT_UNCERTAIN' && /manual verification/i.test(safe.message)))
        await this.manual('registration', 'SESSION_REQUIRES_MANUAL_LOGIN');
      else if (safe.code === 'REGISTRATION_RESULT_UNCERTAIN')
        await this.save('REGISTRATION_RESULT_UNCERTAIN', 'REGISTRATION_UNCERTAIN', { lastErrorCode: safe.code });
      else throw error;
    }
  }
  private async problem(runContest: Contest): Promise<void> {
    const ordinal = this.run.currentProblemOrdinal;
    if (!ordinal) return;
    let problem = (await this.deps.runs.listProblems(this.run.runId)).find((item) => item.ordinal === ordinal);
    if (!problem) throw new CodeforcesError('Selected problem record is missing.', 'STORAGE_ERROR');
    const now = this.now().getTime();
    const end = Date.parse(this.run.contestStartAt) + runContest.durationSeconds * 1000;
    const waiting = `WAITING_PROBLEM_${ordinal}` as RunState;
    const triggering = `PROBLEM_${ordinal}_TRIGGERING` as RunState;
    const triggered = `PROBLEM_${ordinal}_TRIGGERED` as RunState;
    const submitted = `PROBLEM_${ordinal}_SUBMITTED` as RunState;
    const done = `PROBLEM_${ordinal}_DONE` as RunState;
    if (this.run.state === waiting) {
      if (now < Date.parse(problem.windowStart)) return;
      if (now > Date.parse(problem.windowEnd) || now >= end) {
        await this.deps.runs.saveProblem({ ...problem, state: 'missed', lastErrorCode: 'MISSED_WINDOW' });
        await this.save('MISSED_WINDOW', 'MISSED_WINDOW', { lastErrorCode: 'MISSED_WINDOW' }, { problemOrdinal: ordinal });
        return;
      }
      problem = await this.deps.runs.saveProblem({ ...problem, state: 'triggering', triggeredAt: this.now().toISOString() });
      await this.save(triggering, 'TRIGGER_STARTED', {}, { problemOrdinal: ordinal });
    }
    if (this.run.state === triggering) {
      const input: WorkTriggerInput = { runId: this.run.runId, contestId: this.run.contestId,
        ordinal, problemIndex: problem.problemIndex, handle: this.run.handle, createdAt: problem.windowStart };
      const result = await this.deps.trigger.ensure(input);
      await this.deps.runs.saveProblem({ ...problem, state: 'triggered', triggeredAt: problem.triggeredAt ?? problem.windowStart,
        githubBranch: result.branch, githubPrNumber: result.prNumber });
      await this.save(triggered, 'WORK_TRIGGERED', {}, { problemOrdinal: ordinal });
      return;
    }
    if (this.run.state === triggered || this.run.state === 'SUBMISSION_RESULT_UNCERTAIN') {
      const evidence = await this.submissionEvidence(problem);
      if (evidence.kind === 'confirmed') {
        await this.deps.runs.saveProblem({ ...problem, state: 'submitted', submissionId: evidence.submission.id });
        await this.save(submitted, 'SUBMISSION_RECONCILED', {}, { problemOrdinal: ordinal, submissionId: evidence.submission.id });
      } else if (evidence.kind === 'uncertain' && this.run.state === triggered)
        await this.save('SUBMISSION_RESULT_UNCERTAIN', 'SUBMISSION_UNCERTAIN', {}, { problemOrdinal: ordinal });
      return;
    }
    if (this.run.state === submitted) {
      const id = problem.submissionId;
      if (!id) throw new CodeforcesError('Submitted problem has no submission ID.', 'STORAGE_ERROR');
      const records = await this.deps.api.submissionPage({ contestId: this.run.contestId,
        handle: this.run.handle, from: 1, count: 1000 });
      const record = records.find((item) => item.id === id && (item.contestId ?? item.problem.contestId) === this.run.contestId &&
        item.problem.index === problem.problemIndex && item.author?.members?.some((m) => m.handle.toLowerCase() === this.run.handle.toLowerCase()));
      if (!record || !isFinalVerdict(record.verdict)) return;
      await this.deps.runs.saveProblem({ ...problem, state: 'done', verdict: record.verdict ?? null });
      await this.save(done, 'VERDICT_FINAL', {}, { problemOrdinal: ordinal, submissionId: id, verdict: record.verdict });
    }
  }
  private async advance(): Promise<void> {
    const ordinal = this.run.currentProblemOrdinal;
    if (!ordinal) return;
    if (ordinal === 4) {
      await this.save('CONTEST_COMPLETE', 'FOUR_PROBLEMS_COMPLETE', { completedAt: this.now().toISOString() });
      return;
    }
    await this.save(`WAITING_PROBLEM_${ordinal + 1}` as RunState, 'NEXT_PROBLEM',
      { currentProblemOrdinal: (ordinal + 1) as Ordinal });
  }
  private async reconcile(contest?: Contest): Promise<void> {
    if (this.run.state === 'NEEDS_MANUAL_AUTH') { await this.recoverAuth(); return; }
    if (!contest) { this.event('WAITING_OFFICIAL_CONTEST_DATA', this.run.state); return; }
    if (preRegistration.has(this.run.state)) { await this.registration(contest); return; }
    if (this.run.state === 'REGISTERED') {
      if (this.now().getTime() >= Date.parse(this.run.contestStartAt) + contest.durationSeconds * 1000) {
        await this.save('BLOCKED', 'CONTEST_ENDED_BEFORE_AUTHORIZATION', { completedAt: this.now().toISOString() });
        return;
      }
      await this.deps.authorization.authorizeContest({ contestId: this.run.contestId,
        expiresAt: new Date(Date.parse(this.run.contestStartAt) + contest.durationSeconds * 1000).toISOString(), source: 'watcher' });
      await this.save('AUTHORIZED', 'CONTEST_AUTHORIZED');
    }
    if (this.run.state === 'AUTHORIZED') await this.save('WAITING_FOR_START', 'WAITING_FOR_START');
    if (this.run.state === 'WAITING_FOR_START' && this.now().getTime() >= Date.parse(this.run.contestStartAt)) {
      const problems = scheduleProblems(this.run, await this.deps.api.contestProblems(this.run.contestId), this.deps.config.windows);
      await this.deps.runs.createProblems(problems);
      await this.save('RUNNING', 'CONTEST_STARTED', { problemOrder: problems.map((p) => p.problemIndex), currentProblemOrdinal: 1 });
    }
    if (this.run.state === 'RUNNING') await this.save('WAITING_PROBLEM_1', 'WAITING_PROBLEM_1');
    if (this.run.state === 'MISSED_WINDOW') { await this.advance(); return; }
    if (/^PROBLEM_[1-4]_DONE$/.test(this.run.state)) { await this.advance(); return; }
    if (/^(WAITING_PROBLEM_[1-4]|PROBLEM_[1-4]_(TRIGGERING|TRIGGERED|SUBMITTED))$/.test(this.run.state) ||
        this.run.state === 'SUBMISSION_RESULT_UNCERTAIN') { await this.problem(contest); return; }
    if (this.run.state === 'CONTEST_COMPLETE') {
      await this.deps.authorization.completeContest(this.run.contestId);
      await this.save('WAITING_FOR_RATING', 'CONTEST_AUTHORIZATION_COMPLETED', {
        ratingDeadlineAt: new Date(this.now().getTime() + 72 * 3600_000).toISOString() });
    }
    if (this.run.state === 'WAITING_FOR_RATING') {
      const next = await reconcileRating(this.run, this.deps.api, this.deps.profile, this.now());
      if (next.state !== this.run.state) await this.save(next.state, 'RATING_RECONCILED', next);
    }
  }
  async once(options: { dryRun?: boolean; contestId?: number } = {}): Promise<void> {
    if (!this.deps.config.enabled && !options.dryRun) return;
    const existing = await this.deps.runs.listOpen();
    let contests: Contest[];
    try { contests = await this.deps.api.contests(false); }
    catch (error) {
      if (options.dryRun || !existing.some((run) => run.state === 'NEEDS_MANUAL_AUTH')) throw error;
      this.log({ action: 'OFFICIAL_CONTEST_DATA_UNAVAILABLE', errorCode: publicError(error).code });
      contests = [];
    }
    const upcoming = selectUpcomingDiv1(contests);
    if (options.dryRun) {
      const inspected = await Promise.all(existing.map(async (run) => {
        const ordinal = run.currentProblemOrdinal;
        const triggerPending = ordinal !== null &&
          (run.state === `WAITING_PROBLEM_${ordinal}` || run.state === `PROBLEM_${ordinal}_TRIGGERING`);
        const problem = triggerPending ? (await this.deps.runs.listProblems(run.runId))
          .find((item) => item.ordinal === ordinal) : undefined;
        const wouldTriggerGithub = !!problem && (run.state === `PROBLEM_${ordinal}_TRIGGERING` ||
          (this.now().getTime() >= Date.parse(problem.windowStart) &&
           this.now().getTime() <= Date.parse(problem.windowEnd)));
        return { contestId: run.contestId, state: run.state, wouldTriggerGithub };
      }));
      this.log({ action: 'DRY_RUN', candidateContestIds: upcoming.map((c) => c.id),
        runs: inspected });
      return;
    }
    const selected = options.contestId ? upcoming.find((c) => c.id === options.contestId) : upcoming[0];
    const selectedRun = selected ? await this.deps.runs.get(selected.id) : undefined;
    if (selected && !selectedRun) {
      const profile = await this.deps.profile.getAccountProfile();
      if (profile.handle.toLowerCase() !== this.deps.config.handle.toLowerCase())
        throw new CodeforcesError('Official profile is not the configured experiment handle.', 'ACCOUNT_MISMATCH');
      await this.deps.runs.create(newExperimentRun(selected, profile.handle, profile.rating));
    }
    if (selected && selectedRun && canRecoverRegistrationBlock(selectedRun, selected, this.deps.config.handle, this.now())) {
      const claimed = await this.deps.runs.claim(selected.id, randomUUID(), this.now());
      if (claimed) {
        this.run = claimed;
        try {
          if (canRecoverRegistrationBlock(claimed, selected, this.deps.config.handle, this.now())) {
            const profile = await this.deps.profile.getAccountProfile();
            if (profile.handle.toLowerCase() === claimed.handle.toLowerCase() && await this.checkSession())
              await this.save('WAITING_FOR_REGISTRATION', 'TEMPORARY_REGISTRATION_BLOCK_RECOVERED', {
                registrationStatus: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null,
                ratingBefore: profile.rating,
              });
          }
        } finally { await this.deps.runs.release(this.run); }
      }
    }
    const runs = options.contestId ? [await this.deps.runs.get(options.contestId)].filter((r): r is ExperimentRun => !!r) :
      await this.deps.runs.listOpen();
    for (const open of runs) {
      if (terminal.has(open.state)) continue;
      const contest = contests.find((item) => item.id === open.contestId);
      if (!contest && open.state !== 'NEEDS_MANUAL_AUTH') continue;
      const claimed = await this.deps.runs.claim(open.contestId, randomUUID(), this.now());
      if (!claimed) continue;
      this.run = claimed;
      this.event('RECONCILE_START', this.run.state);
      try { await this.reconcile(contest); }
      catch (error) {
        const safe = publicError(error);
        if (isAuthChallenge(safe.code)) {
          const pending: PendingOperation = preRegistration.has(this.run.state) ?
            this.run.state === 'REGISTERING' ? 'registration' : 'registration_status' :
            /^PROBLEM_[1-4]_SUBMITTED$/.test(this.run.state) ? 'verdict' : 'contest_state';
          await this.manual(pending, safe.code);
        }
        else this.event('RECONCILE_ERROR', this.run.state, { errorCode: safe.code });
        if (!isAuthChallenge(safe.code)) throw error;
      } finally {
        this.event('RECONCILE_COMPLETE', claimed.state);
        await this.deps.runs.release(this.run);
      }
    }
  }
}
