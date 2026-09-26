export interface SubmissionMetadata {
  submissionId: number;
  contestId: number;
  problemIndex: string;
  language: 'java17';
  submittedAt: string;
}

export interface SubmissionStore {
  isContestAuthorized(contestId: number): Promise<boolean>;
  get(submissionId: number): Promise<SubmissionMetadata | undefined>;
  has(submissionId: number): Promise<boolean>;
  put(metadata: SubmissionMetadata): Promise<void>;
  checkWritable(): Promise<void>;
  reserveAttempt(attempt: SubmissionAttempt, windowSeconds: number): Promise<boolean>;
  recordAttempt(attempt: SubmissionAttempt): Promise<void>;
  recordAuthInterruption?(contestId: number, problemIndex: string): Promise<void>;
}

export interface ContestAuthorizationInput {
  contestId: number;
  expiresAt?: string | null;
  source?: string;
}

/** Server-side administration only. These methods are never exposed as MCP tools. */
export interface ContestAuthorizationStore {
  isContestAuthorized(contestId: number): Promise<boolean>;
  authorizeContest(input: ContestAuthorizationInput): Promise<void>;
  completeContest(contestId: number): Promise<void>;
  blockContest(contestId: number): Promise<void>;
}

export interface SubmissionAttempt extends Omit<SubmissionMetadata, 'submissionId'> {
  attemptId: string;
  state: 'prepared' | 'confirmed' | 'uncertain';
  submissionId?: number;
  fingerprint: string;
}

/** Read-only evidence for reconciling an interrupted Work submission. */
export interface SubmissionRecoveryStore {
  findForProblem(contestId: number, problemIndex: string): Promise<SubmissionMetadata[]>;
  findAttemptsForProblem(contestId: number, problemIndex: string): Promise<SubmissionAttempt[]>;
}
