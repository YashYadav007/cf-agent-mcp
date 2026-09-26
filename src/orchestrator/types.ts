import type { ContestRegistrationStatus } from '../codeforces/registration.js';
import type { PendingOperation, Ordinal, RunState } from './stateMachine.js';

export interface ExperimentRun {
  runId: string;
  contestId: number;
  contestName: string;
  handle: string;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingDelta: number | null;
  rankAfter: string | null;
  maxRatingAfter: number | null;
  ratedForAccount: boolean | null;
  ratingSource: string | null;
  registrationStatus: ContestRegistrationStatus['status'] | null;
  registrationConfirmedAt: string | null;
  contestStartAt: string;
  state: RunState;
  currentProblemOrdinal: Ordinal | null;
  problemOrder: string[];
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pendingOperation: PendingOperation | null;
  authRequiredAt: string | null;
  authRecoveredAt: string | null;
  lastAuthCheckAt: string | null;
  recoveryReason: string | null;
  resumeState: RunState | null;
  ratingDeadlineAt: string | null;
  completedAt: string | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export type ProblemExecutionState = 'waiting' | 'triggering' | 'triggered' | 'submitted' | 'done' | 'missed';
export interface ProblemExecution {
  runId: string;
  ordinal: Ordinal;
  problemIndex: string;
  windowStart: string;
  windowEnd: string;
  state: ProblemExecutionState;
  triggeredAt: string | null;
  githubBranch: string | null;
  githubPrNumber: number | null;
  submissionId: number | null;
  verdict: string | null;
  lastErrorCode: string | null;
  version: number;
}

export interface RunStore {
  listOpen(): Promise<ExperimentRun[]>;
  get(contestId: number): Promise<ExperimentRun | undefined>;
  create(run: ExperimentRun): Promise<boolean>;
  claim(contestId: number, owner: string, now: Date): Promise<ExperimentRun | undefined>;
  save(run: ExperimentRun): Promise<ExperimentRun>;
  release(run: ExperimentRun): Promise<void>;
  listProblems(runId: string): Promise<ProblemExecution[]>;
  createProblems(problems: ProblemExecution[]): Promise<void>;
  saveProblem(problem: ProblemExecution): Promise<ProblemExecution>;
}
