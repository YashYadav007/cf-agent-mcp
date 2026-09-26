/** Read-only operator commands. Neither command registers or authorizes a contest. */
import 'dotenv/config';
import { CodeforcesApi } from '../src/codeforces/api.js';
import { AccountProfileService } from '../src/codeforces/profile.js';
import { codeforcesBrowser, closeBrowser } from '../src/codeforces/browser.js';
import { ContestRegistrationService } from '../src/codeforces/registration.js';
import { evaluateContestEligibility, isDiv1Contest } from '../src/contest/eligibility.js';
import { CodeforcesError, publicError } from '../src/codeforces/errors.js';

const [action, rawId] = process.argv.slice(2);
const valid = action === 'profile' ? process.argv.length === 3 :
  action === 'eligible' && process.argv.length === 4 && /^[1-9]\d*$/.test(rawId ?? '') && Number.isSafeInteger(Number(rawId));
if (!valid) {
  console.error('Usage: npm run account:profile OR npm run contest:eligible -- <positive-contest-id>');
  process.exitCode = 1;
} else {
  const api = new CodeforcesApi();
  const profiles = new AccountProfileService(api, process.env, () => codeforcesBrowser.knownHandle());
  try {
    const profile = await profiles.getAccountProfile();
    if (action === 'profile') console.log(JSON.stringify(profile));
    else {
      const contestId = Number(rawId);
      const contest = (await api.contests(false)).find((entry) => entry.id === contestId);
      if (!contest) throw new CodeforcesError('Codeforces contest was not found.', 'CONTEST_NOT_FOUND');
      const registration = isDiv1Contest(contest) && contest.phase === 'BEFORE' ?
        await new ContestRegistrationService(api, codeforcesBrowser).status({ contestId }) : undefined;
      console.log(JSON.stringify(evaluateContestEligibility(contest, profile, registration)));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: publicError(error) }));
    process.exitCode = 1;
  } finally { await closeBrowser().catch(() => undefined); }
}
if (process.env.CF_BROWSER_CDP_URL) {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
  ]);
  process.exit(process.exitCode ?? 0);
}
