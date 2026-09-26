/** Server-side authorization helper for an operator or future watcher. No MCP tool exposes these writes. */
import 'dotenv/config';
import { SupabaseSubmissionStore, getSupabaseAdminKey } from '../src/storage/supabase.js';

const [action, rawContestId, rawExpiresAt] = process.argv.slice(2);
const contestId = Number(rawContestId);
if (!['authorize', 'complete', 'block'].includes(action ?? '') || !rawContestId ||
    !/^[1-9]\d*$/.test(rawContestId) || !Number.isSafeInteger(contestId) ||
    (action !== 'authorize' && rawExpiresAt !== undefined)) {
  console.error('Usage: npm run contest:{authorize|complete|block} -- <positive-contest-id> [future-expiry-ISO-for-authorize]');
  process.exitCode = 1;
} else {
  try {
    const url = process.env.SUPABASE_URL?.trim();
    const key = getSupabaseAdminKey();
    if (!url || !key) throw new Error('Configure SUPABASE_URL and a server-side Supabase secret key before managing contests.');
    const store = new SupabaseSubmissionStore(url, key);
    if (action === 'authorize') await store.authorizeContest({ contestId, expiresAt: rawExpiresAt ?? null, source: 'manual' });
    else if (action === 'complete') await store.completeContest(contestId);
    else await store.blockContest(contestId);
    console.log(`Contest ${contestId} ${action === 'authorize' ? 'authorized' : action === 'complete' ? 'completed' : 'blocked'}.`);
  } catch {
    console.error('Contest authorization update failed. Check the contest ID, expiry, Supabase credentials, migration, and connection.');
    process.exitCode = 1;
  }
}
