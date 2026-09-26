import type { Request, Response, NextFunction } from 'express';
import type { TokenVerifier, OAuthConfig, Scope } from './verifier.js';
import { hasScope } from './verifier.js';

export type AuthMode = 'disabled' | 'oauth' | 'bootstrap';
export interface AuthSettings { mode: AuthMode; oauth?: OAuthConfig; allowLocalUnauthenticatedSubmissions: boolean; realSubmissionsEnabled?: boolean }
export function readAuthSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const mode = env.AUTH_MODE || 'disabled';
  if (mode !== 'disabled' && mode !== 'oauth' && mode !== 'bootstrap') throw new Error('AUTH_MODE must be disabled, bootstrap, or oauth.');
  if (mode === 'bootstrap') {
    if (env.ALLOW_REAL_SUBMISSIONS === 'true') throw new Error('Bootstrap mode cannot enable real submissions.');
    return { mode, allowLocalUnauthenticatedSubmissions: false, realSubmissionsEnabled: false };
  }
  if (mode === 'disabled') return { mode, allowLocalUnauthenticatedSubmissions: env.ALLOW_LOCAL_UNAUTHENTICATED_SUBMISSIONS === 'true', realSubmissionsEnabled: env.ALLOW_REAL_SUBMISSIONS === 'true' };
  const issuer = env.MCP_AUTH_ISSUER; const audience = env.MCP_AUTH_AUDIENCE; const jwksUrl = env.MCP_AUTH_JWKS_URL; const resourceUrl = env.MCP_RESOURCE_URL;
  if (!issuer || !audience || !jwksUrl || !resourceUrl || ![issuer, audience, jwksUrl, resourceUrl].every((value) => value.startsWith('https://')))
    throw new Error('OAuth mode requires HTTPS MCP_RESOURCE_URL, MCP_AUTH_ISSUER, MCP_AUTH_AUDIENCE, and MCP_AUTH_JWKS_URL.');
  if (new URL(resourceUrl).pathname !== '/mcp') throw new Error('MCP_RESOURCE_URL must end in /mcp.');
  return { mode, oauth: { issuer, audience, jwksUrl, resourceUrl }, allowLocalUnauthenticatedSubmissions: false };
}
export function requiredScope(body: unknown): Scope | null {
  const calls = Array.isArray(body) ? body : [body];
  const methods = calls.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (methods.some((item) => item.method === 'tools/call' && isWriteTool((item.params as { name?: string } | undefined)?.name))) return 'cf.submit';
  if (methods.some((item) => item.method === 'tools/call')) return 'cf.read';
  return null;
}
function isWriteTool(name?: string): boolean { return name === 'submit_solution' || name === 'register_contest'; }
function requestedScopes(body: unknown): Scope[] {
  const calls = Array.isArray(body) ? body : [body];
  const scopes = new Set<Scope>();
  for (const item of calls) {
    if (!item || typeof item !== 'object') continue;
    const message = item as { method?: string; params?: { name?: string } };
    if (message.method !== 'tools/call') continue;
    scopes.add(isWriteTool(message.params?.name) ? 'cf.submit' : 'cf.read');
  }
  return [...scopes];
}
export function authMiddleware(settings: AuthSettings, verifier: TokenVerifier | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scopes = requestedScopes(req.body);
    const scope = scopes[0] ?? null;
    if (settings.mode === 'bootstrap') { res.status(503).json({ error: { code: 'BOOTSTRAP_ONLY', message: 'MCP is unavailable until OAuth configuration is complete.', retryable: false } }); return; }
    if (settings.mode === 'disabled') {
      const calls = Array.isArray(req.body) ? req.body : [req.body];
      if (calls.some((item) => item?.method === 'tools/call' && item?.params?.name === 'register_contest')) {
        res.status(403).json({ error: { code: 'MCP_AUTH_REQUIRED', message: 'Contest registration requires OAuth cf.submit.', retryable: false } }); return;
      }
      if (scope === 'cf.submit' && settings.realSubmissionsEnabled && !settings.allowLocalUnauthenticatedSubmissions) {
        res.status(403).json({ error: { code: 'MCP_AUTH_REQUIRED', message: 'Local unauthenticated submissions are disabled.', retryable: false } }); return;
      }
      next(); return;
    }
    if (!scope) { next(); return; }
    const resource = new URL(settings.oauth!.resourceUrl);
    const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname.replace(/\/$/, '')}`;
    const challenge = (error: string, status: number, challengedScope: Scope = scope) => {
      const message = status === 401 ? 'A valid OAuth bearer token is required.' : `OAuth scope ${challengedScope} is required.`;
      const bearerChallenge = `Bearer resource_metadata="${metadataUrl}", error="${error}", error_description="${message}", scope="${challengedScope}"`;
      res.setHeader('WWW-Authenticate', bearerChallenge);
      const safeError = { code: status === 401 ? 'MCP_AUTH_REQUIRED' : 'MCP_INSUFFICIENT_SCOPE', message, retryable: false };
      if (req.body && typeof req.body === 'object' && req.body.method === 'tools/call') {
        res.status(status).json({ jsonrpc: '2.0', id: req.body.id ?? null, result: {
          isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: safeError },
          _meta: { 'mcp/www_authenticate': [bearerChallenge] },
        } });
      } else res.status(status).json({ error: safeError });
    };
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match) { challenge('invalid_token', 401); return; }
    try {
      const claims = await verifier!.verify(match[1]!);
      const missing = scopes.find((required) => !hasScope(claims, required));
      if (missing) { challenge('insufficient_scope', 403, missing); return; }
      console.error('[AUTH] validated', { scope: scopes.join(' ') });
      next();
    } catch { challenge('invalid_token', 401); }
  };
}
