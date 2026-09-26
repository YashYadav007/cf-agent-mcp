import { CodeforcesError } from '../codeforces/errors.js';
import type { Contest } from '../codeforces/types.js';
import type { AccountProfile } from '../codeforces/profile.js';
import type { ContestRegistrationStatus } from '../codeforces/registration.js';

export type DivisionDecision = 'DIV1_CANDIDATE' | 'NOT_DIV1' | 'NOT_REGULAR' | 'NOT_UPCOMING' |
  'RATING_INELIGIBLE' | 'REGISTRATION_UNAVAILABLE' | 'REGISTRATION_OPEN' | 'REGISTERED';
export interface ContestEligibility {
  contestId: number;
  eligible: boolean;
  decision: DivisionDecision;
  registrationStatus: ContestRegistrationStatus['status'] | null;
  currentRating: number | null;
  reason: string;
}

/** Contest names are official metadata; rating is informational until Codeforces confirms registration eligibility. */
export function isDiv1Contest(contest: Pick<Contest, 'name' | 'type'>): boolean {
  const name = contest.name.replace(/\s+/g, ' ').trim();
  return contest.type === 'CF' && !/\b(?:educational|unrated|practice|test(?:ing)?|gym|icpc|mirror)\b/i.test(name) &&
    !/\bdiv(?:ision)?\.?\s*1\s*(?:\+|&|and)\s*(?:div(?:ision)?\.?\s*)?2\b/i.test(name) &&
    !/\bdiv(?:ision)?\.?\s*[2345]\b/i.test(name) &&
    /(?:\(\s*div(?:ision)?\.?\s*1\s*\)|\bdiv(?:ision)?\.?\s*1\b)/i.test(name);
}

export function selectUpcomingDiv1(contests: readonly Contest[]): Contest[] {
  return contests.filter((contest) => contest.phase === 'BEFORE' && isDiv1Contest(contest))
    .sort((a, b) => (a.startTimeSeconds ?? Number.MAX_SAFE_INTEGER) - (b.startTimeSeconds ?? Number.MAX_SAFE_INTEGER));
}

export function evaluateContestEligibility(contest: Contest, profile?: AccountProfile,
  registration?: ContestRegistrationStatus): ContestEligibility {
  const base = { contestId: contest.id, registrationStatus: registration?.status ?? null,
    currentRating: profile?.rating ?? null };
  if (contest.type !== 'CF') return { ...base, eligible: false, decision: 'NOT_REGULAR', reason: 'Only regular Codeforces contests are supported.' };
  if (!isDiv1Contest(contest)) return { ...base, eligible: false, decision: 'NOT_DIV1', reason: 'Experiment policy allows Div.1 only.' };
  if (contest.phase !== 'BEFORE') return { ...base, eligible: false, decision: 'NOT_UPCOMING', reason: 'Contest is not upcoming.' };
  if (registration?.status === 'rating_ineligible') return { ...base, eligible: false, decision: 'RATING_INELIGIBLE',
    reason: registration.reason ?? 'Codeforces says this account is ineligible to register.' };
  if (registration?.status === 'registered') return { ...base, eligible: true, decision: 'REGISTERED', reason: 'Codeforces confirms registration.' };
  if (registration?.status === 'not_registered') return { ...base, eligible: true, decision: 'REGISTRATION_OPEN', reason: 'Official registration form is available.' };
  if (registration) return { ...base, eligible: false, decision: 'REGISTRATION_UNAVAILABLE',
    reason: `Official registration status is ${registration.status}.` };
  return { ...base, eligible: true, decision: 'DIV1_CANDIDATE',
    reason: 'Div.1 candidate; official registration eligibility remains unchecked.' };
}

export function assertDiv1Contest(contest: Contest): void {
  if (!isDiv1Contest(contest)) throw new CodeforcesError('Experiment policy allows registration for Div.1 contests only.', 'CONTEST_DIVISION_NOT_ALLOWED');
}
