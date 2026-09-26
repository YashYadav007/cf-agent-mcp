import type { CallToolResult } from '@modelcontextprotocol/server';
import { publicError } from '../codeforces/errors.js';
import { toolSecuritySchemes } from '../auth/protectedResource.js';
export const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const readSecurityMeta = { securitySchemes: toolSecuritySchemes('cf.read') };
export const submitSecurityMeta = { securitySchemes: toolSecuritySchemes('cf.submit') };
export function result<T extends object>(value: T): CallToolResult {
  return { structuredContent: value as Record<string, unknown>, content: [{ type: 'text', text: 'Structured JSON result attached.' }] };
}
export function failure(error: unknown): CallToolResult {
  const safe = publicError(error);
  console.error('[MCP] error', { code: safe.code, retryable: safe.retryable });
  return { isError: true, structuredContent: { error: safe }, content: [{ type: 'text', text: JSON.stringify({ error: safe }) }] };
}
