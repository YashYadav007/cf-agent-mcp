export interface SubmissionWindow { slot: number; startMinute: number; endMinute: number }
export interface TimingEvaluation {
  allowedNow: boolean;
  windowStart: string;
  windowEnd: string;
  waitMilliseconds: number;
  status: 'BEFORE_WINDOW' | 'INSIDE_WINDOW' | 'AFTER_WINDOW';
}
