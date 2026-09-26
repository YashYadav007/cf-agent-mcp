import 'dotenv/config';
import { CodeforcesApi } from '../src/codeforces/api.js';
import { codeforcesBrowser, closeBrowser } from '../src/codeforces/browser.js';
import { publicError } from '../src/codeforces/errors.js';
import { AccountProfileService } from '../src/codeforces/profile.js';
import { ContestRegistrationService } from '../src/codeforces/registration.js';
import { GitHubWorkTrigger } from '../src/integrations/githubWorkTrigger.js';
import { CloudTasksWakeupScheduler, readCloudTasksConfig } from '../src/integrations/cloudTasks.js';
import { loadExperimentConfig } from '../src/orchestrator/config.js';
import { ExperimentWatcher } from '../src/orchestrator/watcher.js';
import { createOrchestratorStore } from '../src/storage/orchestrator.js';
import { getSupabaseAdminKey, SupabaseSubmissionStore } from '../src/storage/supabase.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['once', 'status', 'dry-run', 'contest'].includes(command ?? ''))
    throw new Error('Use orchestrator:once, orchestrator:status, orchestrator:dry-run, or orchestrator:contest -- <contestId>.');
  const runs = createOrchestratorStore();
  if (command === 'status') {
    const id = process.argv[3] ? Number(process.argv[3]) : undefined;
    const records = id ? [await runs.get(id)].filter((item) => !!item) : await runs.listOpen();
    for (const run of records) console.log(JSON.stringify({ runId: run.runId, contestId: run.contestId,
      state: run.state, pendingOperation: run.pendingOperation, recoveryReason: run.recoveryReason,
      nextReconcileAt: run.nextReconcileAt, nextReconcileReason: run.nextReconcileReason,
      currentProblemOrdinal: run.currentProblemOrdinal, problems: await runs.listProblems(run.runId) }));
    return;
  }
  const config = loadExperimentConfig();
  const api = new CodeforcesApi();
  const key = getSupabaseAdminKey();
  if (!key || !process.env.SUPABASE_URL) throw new Error('Persistent Supabase storage is required.');
  const submissions = new SupabaseSubmissionStore(process.env.SUPABASE_URL, key);
  const profile = new AccountProfileService(api);
  const registration = new ContestRegistrationService(api, codeforcesBrowser);
  const dryRun = command === 'dry-run';
  const trigger = !dryRun && config.enabled ? new GitHubWorkTrigger(config.githubRepository, config.githubToken) :
    { find: async () => null, ensure: async () => { throw new Error('Trigger is disabled.'); } };
  const scheduler = !dryRun && ['GCP_PROJECT_ID', 'GCP_REGION', 'CLOUD_TASKS_QUEUE',
    'ORCHESTRATOR_SERVICE_URL', 'CLOUD_TASKS_SERVICE_ACCOUNT'].every((name) => !!process.env[name]) ?
    new CloudTasksWakeupScheduler(readCloudTasksConfig()) : undefined;
  const watcher = new ExperimentWatcher({ api, browser: codeforcesBrowser, profile, registration,
    runs, submissions, authorization: submissions, trigger, scheduler, config });
  const contestId = command === 'contest' ? Number(process.argv[3]) : undefined;
  if (command === 'contest' && (!Number.isSafeInteger(contestId) || contestId! <= 0))
    throw new Error('Provide a positive contest ID.');
  if (!dryRun) console.error(JSON.stringify({ action: 'ORCHESTRATOR_MUTATION_PASS', enabled: config.enabled }));
  await watcher.once({ dryRun, ...(contestId ? { contestId } : {}) });
}

main().catch((error) => { console.error(JSON.stringify({ action: 'ORCHESTRATOR_FAILED', ...publicError(error) })); process.exitCode = 1; })
  .finally(() => closeBrowser());
