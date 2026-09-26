import type { CodeforcesApi } from '../codeforces/api.js';
import type { AccountProfileService } from '../codeforces/profile.js';
import type { ExperimentRun } from './types.js';

/** Official contest change is authoritative; a later unrelated profile change is not. */
export async function reconcileRating(run: ExperimentRun,
  api: Pick<CodeforcesApi, 'contestRatingChanges' | 'userRating'>,
  profiles: Pick<AccountProfileService, 'getAccountProfile'>, now: Date): Promise<ExperimentRun> {
  const profile = await profiles.getAccountProfile();
  if (profile.handle.toLowerCase() !== run.handle.toLowerCase()) return run;
  let change;
  try {
    change = (await api.contestRatingChanges(run.contestId)).find((item) => item.handle.toLowerCase() === run.handle.toLowerCase());
  } catch { /* Some contests expose no rating changes yet. */ }
  if (!change) {
    try { change = (await api.userRating(run.handle)).find((item) => item.contestId === run.contestId); }
    catch { /* no rating data yet */ }
  }
  if (change) return { ...run, ratingAfter: change.newRating, ratingDelta: change.newRating - change.oldRating,
    rankAfter: profile.rating === change.newRating ? profile.rank : null,
    maxRatingAfter: profile.rating === change.newRating ? profile.maxRating : null, ratedForAccount: true,
    ratingSource: 'official_rating_change', state: 'RATING_UPDATED' };
  if (run.ratingDeadlineAt && now.getTime() >= Date.parse(run.ratingDeadlineAt))
    return { ...run, ratedForAccount: false, ratingSource: 'timeout', state: 'RATING_TIMEOUT' };
  return run;
}
