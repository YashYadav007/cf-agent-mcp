export class CodeforcesError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable = false) {
    super(message);
    this.name = 'CodeforcesError';
  }
}

export function publicError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof CodeforcesError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  // Browser exceptions can include filled values, request headers, and page HTML.
  return { code: 'INTERNAL_ERROR', message: 'The controller could not complete the operation.', retryable: false };
}

export function manualLoginRequired(): CodeforcesError {
  return new CodeforcesError('Codeforces requires manual authentication/verification.', 'SESSION_REQUIRES_MANUAL_LOGIN');
}
