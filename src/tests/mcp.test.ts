import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import type { BrowserAccess } from '../codeforces/browser.js';
import type { TokenVerifier } from '../auth/verifier.js';

const browser: BrowserAccess = {
  knownHandle: () => undefined, withPage: async () => { throw new Error('Browser must not start'); },
  getSessionStatus: async () => ({ authenticated: false, handle: null, method: 'none', message: 'Not configured.' }),
  ensureLoggedIn: async () => { throw new Error('Browser must not start'); },
};
const oauth = { mode: 'oauth' as const, allowLocalUnauthenticatedSubmissions: false,
  oauth: { issuer: 'https://issuer.example', audience: 'https://mcp.example/mcp', resourceUrl: 'https://mcp.example/mcp', jwksUrl: 'https://issuer.example/jwks' } };
const verifier: TokenVerifier = { verify: async (token) => {
  if (token === 'read') return { subject: 'test', scopes: new Set(['cf.read']) };
  if (token === 'submit') return { subject: 'test', scopes: new Set(['cf.submit']) };
  throw Error('invalid');
} };
function healthWithHost(base: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/health`, { headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
test('local health accepts loopback Host headers and rejects other hosts', async () => {
  const app = createApp({ host: '127.0.0.1', env: {} }, browser);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const host of ['localhost', '127.0.0.1', `localhost:${port}`, `127.0.0.1:${port}`]) {
      const response = await healthWithHost(base, host);
      assert.equal(response.status, 200, `Host: ${host}`);
      assert.deepEqual(JSON.parse(response.body), { status: 'ok', service: 'cf-agent-mcp' });
    }
    assert.equal((await fetch(`${base}/health`)).status, 200); // Normal curl Host includes the port.
    const rejected = await healthWithHost(base, 'evil.example');
    assert.equal(rejected.status, 403);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
async function call(base: string, method: string, params?: object, token?: string) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.text(); const data = body.split('\n').find((line) => line.startsWith('data: '));
  return { response, value: JSON.parse(data ? data.slice(6) : body) };
}
test('HTTP MCP advertises nine scoped tools; OAuth blocks unauthenticated and read-only write calls', async () => {
  const app = createApp({ auth: oauth, verifier, env: { DATA_DIR: './data' } }, browser);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', service: 'cf-agent-mcp' });
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as { authorization_servers: string[] };
    assert.deepEqual(metadata.authorization_servers, ['https://issuer.example']);
    const listed = (await call(base, 'tools/list')).value;
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
      ['get_account_profile','get_contest_problems','get_contests','get_problem','get_submission_verdict','register_contest','session_status','submit_solution','wait_for_verdict']);
    for (const tool of listed.result.tools) {
      const write = ['submit_solution', 'register_contest'].includes(tool.name);
      assert.deepEqual(tool.securitySchemes[0].scopes, [write ? 'cf.submit' : 'cf.read']);
      assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
      assert.equal(tool.annotations.readOnlyHint, !write);
    }
    const args = { contestId: 4, problemIndex: 'A', sourceCode: 'class Main {}' };
    const noToken = await call(base, 'tools/call', { name: 'submit_solution', arguments: args });
    assert.equal(noToken.response.status, 401); assert.match(noToken.response.headers.get('www-authenticate') ?? '', /resource_metadata/);
    assert.match(noToken.value.result._meta['mcp/www_authenticate'][0], /error_description=/);
    const wrongScope = await call(base, 'tools/call', { name: 'submit_solution', arguments: args }, 'read');
    assert.equal(wrongScope.response.status, 403);
    assert.match(wrongScope.value.result._meta['mcp/www_authenticate'][0], /insufficient_scope/);
    const registerArgs = { contestId: 4 };
    const registerNoToken = await call(base, 'tools/call', { name: 'register_contest', arguments: registerArgs });
    assert.equal(registerNoToken.response.status, 401);
    const registerReadToken = await call(base, 'tools/call', { name: 'register_contest', arguments: registerArgs }, 'read');
    assert.equal(registerReadToken.response.status, 403);
    assert.match(registerReadToken.value.result._meta['mcp/www_authenticate'][0], /cf.submit/);
    const invalidRegister = await call(base, 'tools/call', { name: 'register_contest', arguments: { contestId: -1 } }, 'submit');
    assert.ok(invalidRegister.value.error || invalidRegister.value.result?.isError);
    const session = await call(base, 'tools/call', { name: 'session_status', arguments: {} }, 'read');
    assert.equal(session.value.result.structuredContent.authenticated, false);
    const blocked = await call(base, 'tools/call', { name: 'submit_solution', arguments: args }, 'submit');
    assert.equal(blocked.value.result.structuredContent.error.code, 'REAL_SUBMISSIONS_DISABLED');
    const invalid = await call(base, 'tools/call', { name: 'submit_solution', arguments: { ...args, language: 'python' } }, 'submit');
    assert.ok(invalid.value.error || invalid.value.result?.isError);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test('remote binding requires OAuth and persistent metadata', () => {
  assert.throws(() => createApp({ host: '0.0.0.0' }, browser), /AUTH_MODE=oauth/);
  assert.throws(() => createApp({ host: '0.0.0.0', auth: oauth, verifier, env: {} }, browser), /ALLOWED_HOSTS/);
  assert.throws(() => createApp({ host: '0.0.0.0', auth: oauth, verifier, env: { ALLOWED_HOSTS: 'mcp.example' } }, browser), /Supabase/);
  const baseEnv = { ALLOWED_HOSTS: 'mcp.example', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test', ALLOW_REAL_SUBMISSIONS: 'true' };
  assert.throws(() => createApp({ host: '0.0.0.0', auth: oauth, verifier, env: baseEnv }, browser), /CF_EXPECTED_HANDLE/);
  assert.throws(() => createApp({ host: '0.0.0.0', auth: oauth, verifier, env: { ...baseEnv, CF_EXPECTED_HANDLE: 'tester' } }, browser), /Codeforces auth/);
  assert.doesNotThrow(() => createApp({ host: '0.0.0.0', auth: oauth, verifier, env: { ...baseEnv, CF_EXPECTED_HANDLE: 'tester', CF_STORAGE_STATE_B64: 'configured-at-runtime' } }, browser));
});
test('register_contest is unavailable through a local MCP endpoint without OAuth', async () => {
  const app = createApp({ host: '127.0.0.1', env: {} }, browser);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const blocked = await call(base, 'tools/call', { name: 'register_contest', arguments: { contestId: 4 } });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.value.error.code, 'MCP_AUTH_REQUIRED');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test('bootstrap service is health-only and cannot enable submissions', async () => {
  const app = createApp({ host: '0.0.0.0', env: { AUTH_MODE: 'bootstrap' } }, browser);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.throws(() => createApp({ host: '0.0.0.0', env: { AUTH_MODE: 'bootstrap', ALLOW_REAL_SUBMISSIONS: 'true' } }, browser), /Bootstrap/);
});
