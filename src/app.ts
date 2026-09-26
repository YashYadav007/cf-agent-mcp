import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { CodeforcesApi } from './codeforces/api.js';
import { codeforcesBrowser, type BrowserAccess } from './codeforces/browser.js';
import { SubmissionService } from './codeforces/submissions.js';
import { ContestRegistrationService } from './codeforces/registration.js';
import { AccountProfileService } from './codeforces/profile.js';
import { SubmissionSafety, readSubmissionSafety } from './codeforces/safety.js';
import { VerdictService } from './codeforces/verdicts.js';
import { createSubmissionStore, getSupabaseAdminKey } from './storage/supabase.js';
import { authMiddleware, readAuthSettings, type AuthSettings } from './auth/middleware.js';
import { JwksTokenVerifier, type TokenVerifier } from './auth/verifier.js';
import { addToolSecuritySchemes, protectedResource } from './auth/protectedResource.js';
import { registerContests } from './tools/contests.js';
import { registerProblems } from './tools/problems.js';
import { registerSubmissions } from './tools/submissions.js';
import { registerSession } from './tools/session.js';
import { registerContestRegistration } from './tools/registration.js';
import { registerAccountProfile } from './tools/profile.js';
import { createInternalOrchestrator } from './orchestrator/controller.js';
import { registerInternalOrchestrator, type InternalOrchestrator } from './orchestrator/internalEndpoint.js';

export interface AppOptions {
  host?: string; allowedHosts?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv;
  verifier?: TokenVerifier; auth?: AuthSettings;
  internalOrchestrator?: InternalOrchestrator;
}
export function createApp(options: AppOptions = {}, browser: BrowserAccess = codeforcesBrowser) {
  const env = options.env ?? process.env;
  const host = options.host ?? '127.0.0.1';
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const auth = options.auth ?? readAuthSettings(env);
  if (auth.mode === 'bootstrap') {
    if (env.ALLOW_REAL_SUBMISSIONS === 'true') throw new Error('Bootstrap mode cannot enable real submissions.');
    const bootstrap = express();
    bootstrap.disable('x-powered-by');
    bootstrap.locals.stopWrites = () => undefined;
    bootstrap.get('/health', (_req, res) => res.json({ status: 'ok', service: 'cf-agent-mcp' }));
    bootstrap.all('/mcp', (_req, res) => res.status(503).json({ error: { code: 'BOOTSTRAP_ONLY', message: 'MCP is unavailable until OAuth configuration is complete.', retryable: false } }));
    return bootstrap;
  }
  if (!local && auth.mode !== 'oauth') throw new Error('Remote binding requires AUTH_MODE=oauth.');
  if (auth.mode === 'disabled' && !local) throw new Error('Disabled authentication is local only.');
  if (auth.mode === 'disabled' && env.ALLOW_REAL_SUBMISSIONS === 'true' && !auth.allowLocalUnauthenticatedSubmissions)
    console.error('[AUTH] local submissions remain blocked without explicit local override');
  const allowedHosts = options.allowedHosts?.length ? options.allowedHosts : env.ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
  if (!local && !allowedHosts?.length) throw new Error('Remote deployment requires ALLOWED_HOSTS.');
  const effectiveHosts = local ? ['localhost', '127.0.0.1', '[::1]'] : allowedHosts;
  if (!local && env.ALLOW_REAL_SUBMISSIONS === 'true') {
    const safety = readSubmissionSafety(env);
    if (!env.SUPABASE_URL || !getSupabaseAdminKey(env) || !safety.expectedHandle ||
      !(env.CF_STORAGE_STATE_B64 || (env.CF_HANDLE && env.CF_PASSWORD)))
      throw new Error('Remote real submissions require Supabase, CF_EXPECTED_HANDLE, and Codeforces auth configuration.');
  }
  const api = new CodeforcesApi(options.timeoutMs ?? 15000);
  const store = createSubmissionStore(env);
  if (!local && (!env.SUPABASE_URL || !getSupabaseAdminKey(env))) throw new Error('Remote deployment requires Supabase submission metadata storage.');
  const submissions = new SubmissionService(browser, store, undefined, new SubmissionSafety(readSubmissionSafety(env)));
  const registrations = new ContestRegistrationService(api, browser, env);
  const profiles = new AccountProfileService(api, env, () => browser.knownHandle());
  const verdicts = new VerdictService(api, store, () => browser.knownHandle());
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'codeforces-controller', version: '3.0.0' });
    registerContests(server, api);
    registerProblems(server, api, options.timeoutMs ?? 15000);
    registerSubmissions(server, submissions, verdicts);
    registerContestRegistration(server, registrations);
    registerAccountProfile(server, profiles);
    registerSession(server, browser);
    return server;
  });
  // The SDK currently omits top-level securitySchemes from tools/list; add the
  // standard field to the serialized list without changing tool execution.
  const decoratedHandler = { fetch: async (request: globalThis.Request, params?: Parameters<typeof handler.fetch>[1]) => {
    const response = await handler.fetch(request, params);
    const body = params?.parsedBody as { method?: string } | undefined;
    if (body?.method !== 'tools/list' || !response.ok) return response;
    const contentType = response.headers.get('content-type') ?? '';
    const original = await response.text();
    let output = original;
    try {
      if (contentType.includes('text/event-stream')) output = original.split('\n').map((line) => line.startsWith('data: ') ?
        `data: ${JSON.stringify(addToolSecuritySchemes(JSON.parse(line.slice(6))))}` : line).join('\n');
      else output = JSON.stringify(addToolSecuritySchemes(JSON.parse(original)));
    } catch { return new globalThis.Response(original, response); }
    const headers = new Headers(response.headers); headers.delete('content-length');
    return new globalThis.Response(output, { status: response.status, headers });
  } };
  const app = createMcpExpressApp({ host, allowedHosts: effectiveHosts, jsonLimit: '2mb' });
  app.disable('x-powered-by');
  let stopping = false;
  app.locals.stopWrites = () => { stopping = true; submissions.stopWrites(); registrations.stopWrites(); };
  const nodeHandler = toNodeHandler(decoratedHandler);
  app.get('/health', (_req: Request, res: Response) => { res.json({ status: 'ok', service: 'cf-agent-mcp' }); });
  const internal = options.internalOrchestrator ??
    (env.EXPERIMENT_ENABLED === 'true' && !local ? createInternalOrchestrator(env, browser, options.timeoutMs ?? 15000) : undefined);
  if (internal) registerInternalOrchestrator(app, internal, () => stopping);
  if (auth.oauth) {
    const metadata = protectedResource(auth.oauth);
    app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req: Request, res: Response) => res.json(metadata));
  }
  const verifier = auth.oauth ? options.verifier ?? new JwksTokenVerifier(auth.oauth) : undefined;
  app.all('/mcp', authMiddleware(auth, verifier), (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body).catch(() => {
      console.error('[MCP] transport error');
      if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'MCP transport error.', retryable: false } });
    });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status === 413 ? 413 : 400;
    res.status(status).json({ error: { code: 'INVALID_INPUT', message: 'Invalid or oversized JSON request.', retryable: false } });
  });
  return app;
}
