/** Server-side watcher building block. Status is read-only; register performs one real Codeforces action. */
import 'dotenv/config';
import { CodeforcesApi } from '../src/codeforces/api.js';
import { codeforcesBrowser, closeBrowser } from '../src/codeforces/browser.js';
import { ContestRegistrationService } from '../src/codeforces/registration.js';
import { publicError } from '../src/codeforces/errors.js';

const [action, rawContestId] = process.argv.slice(2);
const contestId = Number(rawContestId);
if (!['status', 'register'].includes(action ?? '') || process.argv.length !== 4 ||
    !rawContestId || !/^[1-9]\d*$/.test(rawContestId) || !Number.isSafeInteger(contestId)) {
  console.error('Usage: npm run contest:{status|register} -- <positive-contest-id>');
  process.exitCode = 1;
} else {
  const service = new ContestRegistrationService(new CodeforcesApi(), codeforcesBrowser);
  try {
    const output = action === 'status' ? await service.status({ contestId }) : await service.register({ contestId });
    console.log(JSON.stringify(output));
  } catch (error) {
    const safe = publicError(error);
    console.error(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  } finally { await closeBrowser().catch(() => undefined); }
}
// A CDP connection is externally owned and is never closed through Playwright.
// End only this short-lived CLI process; the user's Chrome keeps running.
if (process.env.CF_BROWSER_CDP_URL) {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
  ]);
  process.exit(process.exitCode ?? 0);
}
