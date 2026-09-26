import type { McpServer } from '@modelcontextprotocol/server';
import { registrationInput, type ContestRegistrationService } from '../codeforces/registration.js';
import { failure, result, submitSecurityMeta } from './shared.js';

export function registerContestRegistration(server: McpServer, registrations: ContestRegistrationService): void {
  server.registerTool('register_contest', {
    description: 'Register the configured Codeforces experiment account for an upcoming regular contest. Checks official registration status first, clicks at most once, and never authorizes submissions in Supabase. After an uncertain result, check registration status before retrying.',
    inputSchema: registrationInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: submitSecurityMeta,
  }, async (input) => {
    console.error('[MCP] register_contest', { contestId: input.contestId });
    try { return result(await registrations.register(input)); }
    catch (error) { return failure(error); }
  });
}
