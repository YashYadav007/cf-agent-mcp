import type { McpServer } from '@modelcontextprotocol/server';
import { submitInput, type SubmissionService } from '../codeforces/submissions.js';
import { verdictInput, waitInput, type VerdictService } from '../codeforces/verdicts.js';
import { failure, readOnlyAnnotations, readSecurityMeta, submitSecurityMeta, result } from './shared.js';
export function registerSubmissions(server: McpServer, submissions: SubmissionService, verdicts: VerdictService): void {
  server.registerTool('submit_solution', {
    description: 'Submit the supplied final, locally validated Java 17 source exactly once using the experiment account. Never automatically retry this tool after an uncertain result; inspect your own submissions first.',
    inputSchema: submitInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: submitSecurityMeta,
  }, async (input) => {
    console.error('[MCP] submit_solution', { contest: input.contestId, problem: input.problemIndex, language: 'java17' });
    try { return result(await submissions.submit(input)); }
    catch (error) { return failure(error); }
  });
  server.registerTool('get_submission_verdict', {
    description: 'Read the current verdict once. Resolves contest from local metadata or the configured account history. Does not wait for judging.',
    inputSchema: verdictInput, annotations: readOnlyAnnotations, _meta: readSecurityMeta,
  }, async (input) => {
    console.error('[MCP] get_submission_verdict', { submissionId: input.submissionId, contestId: input.contestId });
    try { return result(await verdicts.get(input)); }
    catch (error) { return failure(error); }
  });
  server.registerTool('wait_for_verdict', {
    description: 'Poll every four seconds for a final verdict; default deadline 60 seconds, maximum 120. Returns the last known fields on timeout.',
    inputSchema: waitInput, annotations: readOnlyAnnotations, _meta: readSecurityMeta,
  }, async (input) => {
    console.error('[MCP] wait_for_verdict', { submissionId: input.submissionId, timeoutSeconds: input.timeoutSeconds });
    try { return result(await verdicts.wait(input)); }
    catch (error) { return failure(error); }
  });
}
