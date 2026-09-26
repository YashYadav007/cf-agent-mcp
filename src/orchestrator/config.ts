import { CodeforcesError } from '../codeforces/errors.js';
import { ORDINALS } from './stateMachine.js';

export interface ExperimentConfig {
  enabled: boolean;
  handle: string;
  windows: ReadonlyArray<{ earliestMinute: number; latestMinute: number }>;
  githubRepository: string;
  githubToken: string;
}

export function loadExperimentConfig(env: NodeJS.ProcessEnv = process.env): ExperimentConfig {
  const enabled = env.EXPERIMENT_ENABLED === 'true';
  const handle = (env.EXPERIMENT_HANDLE || env.CF_EXPECTED_HANDLE || env.CF_HANDLE || '').trim();
  if (enabled) {
    if (!handle || !env.CF_EXPECTED_HANDLE || handle.toLowerCase() !== env.CF_EXPECTED_HANDLE.trim().toLowerCase() ||
        (env.CF_HANDLE && env.CF_HANDLE.trim().toLowerCase() !== handle.toLowerCase()))
      throw new CodeforcesError('EXPERIMENT_HANDLE and CF_EXPECTED_HANDLE must identify the same test account.', 'EXPERIMENT_CONFIG_ERROR');
    if (env.EXPERIMENT_PROBLEMS && env.EXPERIMENT_PROBLEMS !== '4')
      throw new CodeforcesError('Exactly four problems are required.', 'EXPERIMENT_CONFIG_ERROR');
    if (env.EXPERIMENT_LANGUAGE && env.EXPERIMENT_LANGUAGE !== 'JAVA_17')
      throw new CodeforcesError('Only Java 17 is supported.', 'EXPERIMENT_CONFIG_ERROR');
    if (!env.CF_STORAGE_STATE_B64 && !env.CF_BROWSER_CDP_URL)
      throw new CodeforcesError('Configure a manually authenticated storage state or local CDP session.', 'EXPERIMENT_CONFIG_ERROR');
  }
  const defaults = [[10, 25], [30, 50], [55, 80], [85, 110]] as const;
  const windows = ORDINALS.map((ordinal) => {
    const fallback = defaults[ordinal - 1]!;
    const first = Number(env[`PROBLEM_${ordinal}_EARLIEST_MINUTE`] ?? fallback[0]);
    const last = Number(env[`PROBLEM_${ordinal}_LATEST_MINUTE`] ?? fallback[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last <= first || last > 120)
      throw new CodeforcesError('Problem windows must be ordered whole minutes inside 120 minutes.', 'EXPERIMENT_CONFIG_ERROR');
    return { earliestMinute: first, latestMinute: last };
  });
  if (windows.some((window, index) => index > 0 && window.earliestMinute < windows[index - 1]!.latestMinute))
    throw new CodeforcesError('Problem pacing windows must not overlap.', 'EXPERIMENT_CONFIG_ERROR');
  return { enabled, handle, windows,
    githubRepository: (env.GITHUB_TRIGGER_REPO || '').trim(), githubToken: (env.GITHUB_TRIGGER_TOKEN || '').trim() };
}
