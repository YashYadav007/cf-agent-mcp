import type { BrowserAccess } from '../codeforces/browser.js';
import { CodeforcesApi } from '../codeforces/api.js';
import { AccountProfileService } from '../codeforces/profile.js';
import { ContestRegistrationService } from '../codeforces/registration.js';
import { GoogleServiceAccountVerifier } from '../auth/internalOidc.js';
import { CloudTasksWakeupScheduler, readCloudTasksConfig } from '../integrations/cloudTasks.js';
import { GitHubWorkTrigger } from '../integrations/githubWorkTrigger.js';
import { createOrchestratorStore } from '../storage/orchestrator.js';
import { getSupabaseAdminKey, SupabaseSubmissionStore } from '../storage/supabase.js';
import { loadExperimentConfig } from './config.js';
import type { InternalOrchestrator } from './internalEndpoint.js';
import { ExperimentWatcher } from './watcher.js';

export function createInternalOrchestrator(env: NodeJS.ProcessEnv, browser: BrowserAccess,
  timeoutMs: number): InternalOrchestrator {
  const cloud = readCloudTasksConfig(env);
  const config = loadExperimentConfig(env);
  const key = getSupabaseAdminKey(env);
  if (!env.SUPABASE_URL || !key) throw new Error('Autonomous orchestration requires persistent Supabase storage.');
  const api = new CodeforcesApi(timeoutMs);
  const submissions = new SupabaseSubmissionStore(env.SUPABASE_URL, key);
  const watcher = new ExperimentWatcher({ api, browser,
    profile: new AccountProfileService(api, env, () => browser.knownHandle()),
    registration: new ContestRegistrationService(api, browser, env),
    runs: createOrchestratorStore(env), submissions, authorization: submissions,
    trigger: new GitHubWorkTrigger(config.githubRepository, config.githubToken),
    scheduler: new CloudTasksWakeupScheduler(cloud), config });
  return {
    verifier: new GoogleServiceAccountVerifier(cloud.serviceUrl, cloud.serviceAccount),
    reconcile: (input) => input.reason === 'discovery' ? watcher.once({ heartbeat: true }) :
      watcher.once({ contestId: input.contestId, runId: input.runId,
        taskName: input.taskName, taskReason: input.reason }),
  };
}
