import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { BrowserAccess } from '../codeforces/browser.js';
import { failure, readOnlyAnnotations, readSecurityMeta, result } from './shared.js';
export function registerSession(server: McpServer, browser: BrowserAccess): void {
  server.registerTool('session_status', {
    description: 'Check the configured Codeforces experiment account session without exposing authentication material.',
    inputSchema: z.object({}).strict(), annotations: readOnlyAnnotations,
    _meta: readSecurityMeta,
  }, async () => {
    console.error('[MCP] session_status');
    try { return result(await browser.getSessionStatus()); }
    catch (error) { return failure(error); }
  });
}
