import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { CodeforcesApi } from '../codeforces/api.js';
import { fetchProblem } from '../codeforces/scraper.js';
import { failure, result, readOnlyAnnotations, readSecurityMeta } from './shared.js';

const contestId = z.number().int().positive().safe();

export function registerProblems(server: McpServer, api: CodeforcesApi, timeoutMs: number): void {
  server.registerTool('get_contest_problems', {
    description: 'Get the official public problem list for a Codeforces contest.',
    annotations: readOnlyAnnotations,
    _meta: readSecurityMeta,
    inputSchema: z.object({ contestId }),
  }, async ({ contestId }) => {
    console.error('[MCP] get_contest_problems', { contestId });
    try {
      const problems = (await api.contestProblems(contestId)).map((p) => ({
        contestId: p.contestId ?? contestId, index: p.index, name: p.name, type: p.type,
        points: p.points ?? null, rating: p.rating ?? null, tags: p.tags ?? [],
      }));
      return result({ problems });
    } catch (error) { return failure(error); }
  });

  server.registerTool('get_problem', {
    description: 'Read a public Codeforces problem statement with math and examples.',
    annotations: readOnlyAnnotations,
    _meta: readSecurityMeta,
    inputSchema: z.object({ contestId, index: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/) }),
  }, async ({ contestId, index }) => {
    console.error('[MCP] get_problem', { contestId, index });
    try { return result(await fetchProblem(contestId, index, timeoutMs)); }
    catch (error) { return failure(error); }
  });
}
