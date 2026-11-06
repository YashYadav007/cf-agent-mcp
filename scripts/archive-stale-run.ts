import 'dotenv/config';
import { CodeforcesApi } from '../src/codeforces/api.js';
import { publicError } from '../src/codeforces/errors.js';
import { CloudTasksWakeupScheduler, readCloudTasksConfig } from '../src/integrations/cloudTasks.js';
import { archiveStaleManualAuthRun } from '../src/orchestrator/archiveStaleRun.js';
import { createOrchestratorStore } from '../src/storage/orchestrator.js';
import { getSupabaseAdminKey, SupabaseSubmissionStore } from '../src/storage/supabase.js';

const [rawId] = process.argv.slice(2);
if (process.argv.length !== 3 || !rawId || !/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
  console.error('Usage: npm run orchestrator:archive-stale -- <contest-id>');
  process.exitCode = 1;
} else {
  try {
    const cloud = readCloudTasksConfig();
    const url = process.env.SUPABASE_URL;
    const key = getSupabaseAdminKey();
    if (!url || !key) throw new Error('Persistent Supabase storage is required.');
    const run = await archiveStaleManualAuthRun(Number(rawId), { api: new CodeforcesApi(),
      runs: createOrchestratorStore(), authorization: new SupabaseSubmissionStore(url, key),
      scheduler: new CloudTasksWakeupScheduler(cloud), cloud });
    console.log(JSON.stringify({ contestId: run.contestId, runId: run.runId,
      state: run.state, lastErrorCode: run.lastErrorCode, completedAt: run.completedAt }));
  } catch (error) {
    console.error(JSON.stringify({ error: publicError(error) }));
    process.exitCode = 1;
  }
}
