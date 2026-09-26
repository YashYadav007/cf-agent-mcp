import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AccountProfileService } from '../codeforces/profile.js';
import { failure, readOnlyAnnotations, readSecurityMeta, result } from './shared.js';

export function registerAccountProfile(server: McpServer, profiles: AccountProfileService): void {
  server.registerTool('get_account_profile', {
    description: 'Read the configured experiment account handle and latest official Codeforces rating and rank. Unrated fields are null; no stored rating is used.',
    inputSchema: z.object({}).strict(), annotations: readOnlyAnnotations, _meta: readSecurityMeta,
  }, async () => {
    console.error('[MCP] get_account_profile');
    try { return result(await profiles.getAccountProfile()); }
    catch (error) { return failure(error); }
  });
}
