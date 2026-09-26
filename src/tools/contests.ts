import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { CodeforcesApi, CodeforcesError } from '../codeforces/api.js';
import { failure, result, readOnlyAnnotations, readSecurityMeta } from './shared.js';

export function registerContests(server: McpServer, api: CodeforcesApi): void {
  server.registerTool('get_contests', {
    description: 'Get public Codeforces contests. Upcoming contests appear first, sorted by start time.',
    annotations: readOnlyAnnotations,
    _meta: readSecurityMeta,
    inputSchema: z.object({ gym: z.boolean().optional().describe('True for Gym contests; false for regular contests.') }),
  }, async ({ gym = false }) => {
    console.error('[MCP] get_contests', { gym });
    try {
      const contests = await api.contests(gym);
      if (!Array.isArray(contests)) throw new CodeforcesError('Invalid contest list from Codeforces.', 'CF_API_ERROR');
      const normalized = contests.map((c) => ({
        id: c.id, name: c.name, type: c.type, phase: c.phase, frozen: c.frozen,
        durationSeconds: c.durationSeconds, startTimeSeconds: c.startTimeSeconds ?? null,
        relativeTimeSeconds: c.relativeTimeSeconds ?? null,
      }));
      normalized.sort((a, b) => {
        const aUpcoming = a.phase === 'BEFORE';
        const bUpcoming = b.phase === 'BEFORE';
        if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
        const aTime = a.startTimeSeconds ?? 0;
        const bTime = b.startTimeSeconds ?? 0;
        return aUpcoming ? aTime - bTime : bTime - aTime;
      });
      return result({ contests: normalized });
    } catch (error) { return failure(error); }
  });
}
