import { createHash, randomUUID } from 'node:crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import { CodeforcesError } from '../codeforces/errors.js';
import type { WakeupReason } from '../orchestrator/scheduling.js';

export interface WakeupRequest {
  runId: string;
  contestId: number;
  reason: WakeupReason;
  runAt: string;
  repair?: boolean;
}
export interface WakeupScheduler {
  schedule(input: WakeupRequest): Promise<string>;
  exists(name: string): Promise<boolean>;
  cancel(name: string): Promise<void>;
}
export interface CloudTasksConfig {
  projectId: string;
  region: string;
  queue: string;
  serviceUrl: string;
  serviceAccount: string;
}

export function readCloudTasksConfig(env: NodeJS.ProcessEnv = process.env): CloudTasksConfig {
  const projectId = env.GCP_PROJECT_ID?.trim() ?? '';
  const region = env.GCP_REGION?.trim() ?? '';
  const queue = env.CLOUD_TASKS_QUEUE?.trim() ?? '';
  const serviceUrl = env.ORCHESTRATOR_SERVICE_URL?.trim().replace(/\/$/, '') ?? '';
  const serviceAccount = env.CLOUD_TASKS_SERVICE_ACCOUNT?.trim() ?? '';
  let url: URL;
  try { url = new URL(serviceUrl); }
  catch { throw new CodeforcesError('Configure the Cloud Tasks service URL and queue.', 'SCHEDULER_CONFIG_ERROR'); }
  if (!/^[a-z][a-z0-9-:.]{3,62}$/i.test(projectId) || !/^[a-z][a-z0-9-]*$/i.test(region) ||
      !/^[a-z][a-z0-9-]*$/i.test(queue) || url.protocol !== 'https:' || url.pathname !== '/' ||
      !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(serviceAccount))
    throw new CodeforcesError('Configure GCP_PROJECT_ID, GCP_REGION, CLOUD_TASKS_QUEUE, ORCHESTRATOR_SERVICE_URL, and CLOUD_TASKS_SERVICE_ACCOUNT.', 'SCHEDULER_CONFIG_ERROR');
  return { projectId, region, queue, serviceUrl: url.origin, serviceAccount };
}

function grpcCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'number' ? error.code : undefined;
}

export function wakeupTaskId(input: Omit<WakeupRequest, 'repair'>): string {
  return createHash('sha256').update(`${input.runId}\0${input.contestId}\0${input.reason}\0${input.runAt}`)
    .digest('hex').slice(0, 32);
}

/** ADC signs API calls; Cloud Tasks attaches the configured service account's OIDC ID token. */
export class CloudTasksWakeupScheduler implements WakeupScheduler {
  private readonly parent: string;
  private readonly client: Pick<CloudTasksClient, 'createTask' | 'getTask' | 'deleteTask'>;
  constructor(private readonly config: CloudTasksConfig,
    client: Pick<CloudTasksClient, 'createTask' | 'getTask' | 'deleteTask'> = new CloudTasksClient()) {
    this.client = client;
    this.parent = `projects/${config.projectId}/locations/${config.region}/queues/${config.queue}`;
  }
  private name(input: WakeupRequest, repair: boolean): string {
    const id = wakeupTaskId(input);
    return `${this.parent}/tasks/${repair ? `${id}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : id}`;
  }
  private async create(input: WakeupRequest, name: string): Promise<void> {
    const runAt = Date.parse(input.runAt);
    if (!Number.isFinite(runAt) || runAt <= 0 || runAt - Date.now() > 30 * 24 * 3600_000)
      throw new CodeforcesError('Cloud Tasks wakeup must be within 30 days.', 'SCHEDULER_CONFIG_ERROR');
    const body = Buffer.from(JSON.stringify({ runId: input.runId, contestId: input.contestId,
      reason: input.reason, taskName: name }));
    await this.client.createTask({ parent: this.parent, task: {
      name, scheduleTime: { seconds: Math.floor(runAt / 1000), nanos: (runAt % 1000) * 1_000_000 },
      httpRequest: { httpMethod: 'POST', url: `${this.config.serviceUrl}/internal/orchestrator/reconcile`,
        headers: { 'Content-Type': 'application/json' }, body,
        oidcToken: { serviceAccountEmail: this.config.serviceAccount, audience: this.config.serviceUrl } },
    } });
  }
  async schedule(input: WakeupRequest): Promise<string> {
    let name = this.name(input, !!input.repair);
    try { await this.create(input, name); return name; }
    catch (error) {
      if (grpcCode(error) !== 6) {
        if (error instanceof CodeforcesError) throw error;
        throw new CodeforcesError('Cloud Tasks could not schedule the next reconciliation.', 'SCHEDULER_ERROR', true);
      }
    }
    if (await this.exists(name)) return name;
    // Cloud Tasks can reserve a recently completed/deleted name for up to 24h.
    name = this.name(input, true);
    try { await this.create(input, name); return name; }
    catch { throw new CodeforcesError('Cloud Tasks could not repair a consumed wakeup.', 'SCHEDULER_ERROR', true); }
  }
  async exists(name: string): Promise<boolean> {
    if (!name.startsWith(`${this.parent}/tasks/`)) return false;
    try { await this.client.getTask({ name }); return true; }
    catch (error) {
      if (grpcCode(error) === 5) return false;
      throw new CodeforcesError('Cloud Tasks wakeup status is unavailable.', 'SCHEDULER_ERROR', true);
    }
  }
  async cancel(name: string): Promise<void> {
    if (!name.startsWith(`${this.parent}/tasks/`)) return;
    try { await this.client.deleteTask({ name }); }
    catch (error) {
      if (grpcCode(error) !== 5) throw new CodeforcesError('Cloud Tasks could not remove a superseded wakeup.', 'SCHEDULER_ERROR', true);
    }
  }
}
