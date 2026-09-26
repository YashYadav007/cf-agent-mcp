import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubWorkTrigger, type WorkTriggerInput } from '../integrations/githubWorkTrigger.js';

const input: WorkTriggerInput = { runId: 'run-1', contestId: 2273, ordinal: 1,
  problemIndex: 'A', handle: 'testaccount', createdAt: '2030-10-02T12:10:00.000Z' };

function githubMock(dropPrResponse = false) {
  let branch = false; let file = false; let pr = false;
  const calls: string[] = [];
  const fetcher = async (resource: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(resource));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/repos/owner/repo', '');
    calls.push(`${method} ${path}`);
    if (path === '/pulls' && method === 'GET') return Response.json(pr ? [{ number: 42, head: { ref: 'cf-run/2273/p1' } }] : []);
    if (path === '' && method === 'GET') return Response.json({ default_branch: 'main' });
    if (path === '/git/ref/heads/main') return Response.json({ object: { sha: 'sha-1' } });
    if (path === '/git/ref/heads/cf-run/2273/p1' && method === 'GET')
      return branch ? Response.json({ object: { sha: 'sha-1' } }) : new Response('', { status: 404 });
    if (path === '/git/refs' && method === 'POST') { branch = true; return Response.json({}, { status: 201 }); }
    if (path === '/contents/.work-runs/2273/p1.json' && method === 'GET')
      return file ? Response.json({ sha: 'file-sha' }) : new Response('', { status: 404 });
    if (path === '/contents/.work-runs/2273/p1.json' && method === 'PUT') {
      file = true; return Response.json({}, { status: 201 });
    }
    if (path === '/pulls' && method === 'POST') {
      pr = true;
      if (dropPrResponse) throw new Error('response lost after creation');
      return Response.json({ number: 42 }, { status: 201 });
    }
    throw new Error(`Unexpected mock request ${method} ${path}`);
  };
  return { fetcher: fetcher as typeof fetch, calls };
}

test('deterministic GitHub trigger creates exactly one branch, file, and PR across repeated invocations', async () => {
  const mock = githubMock(); const trigger = new GitHubWorkTrigger('owner/repo', 'test-token', mock.fetcher);
  assert.deepEqual(await trigger.ensure(input), { branch: 'cf-run/2273/p1', prNumber: 42 });
  assert.deepEqual(await trigger.ensure(input), { branch: 'cf-run/2273/p1', prNumber: 42 });
  assert.equal(mock.calls.filter((call) => call === 'POST /git/refs').length, 1);
  assert.equal(mock.calls.filter((call) => call === 'PUT /contents/.work-runs/2273/p1.json').length, 1);
  assert.equal(mock.calls.filter((call) => call === 'POST /pulls').length, 1);
});

test('lost PR response is reconciled by GET on next pass without another PR creation', async () => {
  const mock = githubMock(true); const trigger = new GitHubWorkTrigger('owner/repo', 'test-token', mock.fetcher);
  await assert.rejects(trigger.ensure(input), { code: 'TRIGGER_RESULT_UNCERTAIN' });
  assert.deepEqual(await trigger.ensure(input), { branch: 'cf-run/2273/p1', prNumber: 42 });
  assert.equal(mock.calls.filter((call) => call === 'POST /pulls').length, 1);
});

test('GitHub credentials are validated on first request, not adapter construction', async () => {
  let requests = 0;
  const trigger = new GitHubWorkTrigger('', '', async () => { requests++; throw new Error('must not fetch'); });
  await assert.rejects(trigger.ensure(input), { code: 'TRIGGER_CONFIG_ERROR' });
  assert.equal(requests, 0);
});
