import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { genHermesHome } from '../../feature-research/hermes-port/fixtures/gen-hermes-home.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tenant-binding-'));
const dbPath = path.join(tempRoot, 'auth.db');
const missingHome = path.join(tempRoot, 'missing-home');
const regularFileHome = path.join(tempRoot, 'regular-file-home');
const symlinkHome = path.join(tempRoot, 'symlink-home');
const backendErrorHome = path.join(tempRoot, 'backend-error-home');

process.env.HERMES_DB_PATH = dbPath;

import { GET as getActivity } from '@/app/api/activity/route';
import { GET as getApprovalHistory } from '@/app/api/approvals/history/route';
import { GET as getContentPerformance } from '@/app/api/content-performance/route';
import { GET as getEngagement } from '@/app/api/engagement/route';
import { GET as getExperiments } from '@/app/api/experiments/route';
import { GET as getWorkspaceRoots } from '@/app/api/agents/workspace-roots/route';
import { GET as getTenantAgent } from '@/app/api/tenant/agent/route';
import { GET as getTenantCron } from '@/app/api/tenant/cron/route';
import { GET as getTenantSessions } from '@/app/api/tenant/sessions/route';
import { sanitizeForTenant } from '@/lib/api-auth';
import { createSession, ensureAuthTables, upsertStagesnapUser } from '@/lib/auth';
import { getDb, resetDbForTests } from '@/lib/db';

type Handler = (request: NextRequest) => Promise<Response>;

const A_MODEL = 'tenant-a-model';
const B_MODEL = 'TENANT_B_ONLY_VALUE';
const CONFIG_SECRET = 'SENTINEL_DO_NOT_LEAK_9f8a7b';
const SESSION_PROMPT_SECRET = 'SYSTEM_PROMPT_SENTINEL_';
const ORIGIN_SECRET = 'ORIGIN_SENTINEL_DO_NOT_LEAK';

let aHome = '';
let bHome = '';

const tenantRoutes: Array<{ name: string; path: string; handler: Handler }> = [
  { name: 'agent', path: '/api/tenant/agent', handler: getTenantAgent },
  { name: 'cron', path: '/api/tenant/cron', handler: getTenantCron },
  { name: 'sessions', path: '/api/tenant/sessions', handler: getTenantSessions },
];

const internalRoutes: Array<{ name: string; path: string; handler: Handler }> = [
  { name: 'activity', path: '/api/activity', handler: getActivity },
  { name: 'approval history', path: '/api/approvals/history', handler: getApprovalHistory },
  { name: 'content performance', path: '/api/content-performance', handler: getContentPerformance },
  { name: 'engagement', path: '/api/engagement', handler: getEngagement },
  { name: 'experiments', path: '/api/experiments', handler: getExperiments },
];

function configuredInstances(): string {
  return JSON.stringify([
    {
      id: 'stagesnap:aaa', label: 'Tenant A', openclawHome: '', homeDir: aHome,
      profile: 'tenant-a-profile', kind: 'hermes',
    },
    {
      id: 'stagesnap:bbb', label: 'Tenant B', openclawHome: '', homeDir: bHome,
      profile: 'tenant-b-profile', kind: 'hermes',
    },
    {
      id: 'stagesnap:missing-home', label: 'Missing', openclawHome: '',
      homeDir: missingHome, profile: 'missing-profile', kind: 'hermes',
    },
    {
      id: 'stagesnap:regular-file', label: 'Regular file', openclawHome: '',
      homeDir: regularFileHome, profile: 'regular-file-profile', kind: 'hermes',
    },
    {
      id: 'stagesnap:symlink-home', label: 'Symlink', openclawHome: '',
      homeDir: symlinkHome, profile: 'symlink-profile', kind: 'hermes',
    },
    {
      id: 'stagesnap:openclaw-home', label: 'Wrong backend kind', openclawHome: aHome,
      homeDir: aHome, profile: 'openclaw-profile', kind: 'openclaw',
    },
    {
      id: 'stagesnap:backend-error', label: 'Backend error', openclawHome: '',
      homeDir: backendErrorHome, profile: 'backend-error-profile', kind: 'hermes',
    },
  ]);
}

function request(pathname: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    ...(token ? { headers: { cookie: `hermes-session=${token}` } } : {}),
  });
}

function tokenForTenant(sub: string): string {
  return createSession(upsertStagesnapUser(sub).id);
}

function tokenForViewer(): string {
  const result = getDb().prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('test-viewer', 'unused', 'viewer')",
  ).run();
  return createSession(Number(result.lastInsertRowid));
}

function replaceFixtureModel(homeDir: string, model: string): void {
  const configPath = path.join(homeDir, 'config.yaml');
  const config = fs.readFileSync(configPath, 'utf8').replaceAll('grok-4.5', model);
  fs.writeFileSync(configPath, config, 'utf8');
}

function replaceFixtureDeliveryError(homeDir: string, deliveryError: string): void {
  const jobsPath = path.join(homeDir, 'cron', 'jobs.json');
  const file = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) as {
    jobs: Array<{ name?: string; last_delivery_error?: string | null }>;
  };
  const job = file.jobs.find((candidate) => candidate.name === 'balance-watch');
  assert.ok(job);
  job.last_delivery_error = deliveryError;
  fs.writeFileSync(jobsPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

before(async () => {
  const a = await genHermesHome(path.join(tempRoot, 'tenant-a'));
  const b = await genHermesHome(path.join(tempRoot, 'tenant-b'));
  aHome = a.fullDir;
  bHome = b.fullDir;
  replaceFixtureModel(aHome, A_MODEL);
  replaceFixtureModel(bHome, B_MODEL);
  replaceFixtureDeliveryError(bHome, `failed reading ${aHome}`);
  fs.writeFileSync(regularFileHome, 'not a tenant home', 'utf8');
  fs.symlinkSync(aHome, symlinkHome, 'dir');
  const backendErrorCronDir = path.join(backendErrorHome, 'cron');
  fs.mkdirSync(backendErrorCronDir, { recursive: true });
  fs.symlinkSync('jobs.json', path.join(backendErrorCronDir, 'jobs.json'));
  process.env.HERMES_OPENCLAW_INSTANCES = configuredInstances();
});

beforeEach(() => {
  process.env.HERMES_OPENCLAW_INSTANCES = configuredInstances();
  ensureAuthTables();
  getDb().exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM google_login_requests;');
});

after(() => {
  delete process.env.HERMES_OPENCLAW_INSTANCES;
  resetDbForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('tenant binding persists on insert and conflict update and is read from the session row', async () => {
  const first = upsertStagesnapUser('aaa');
  assert.equal(first.tenant_instance_id, 'stagesnap:aaa');
  getDb().prepare('UPDATE users SET tenant_instance_id = ? WHERE id = ?').run('tampered', first.id);
  const second = upsertStagesnapUser('aaa');
  assert.equal(second.tenant_instance_id, 'stagesnap:aaa');

  const response = await getTenantAgent(request('/api/tenant/agent', createSession(first.id)));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.instanceId, 'stagesnap:aaa');
  assert.equal(body.profiles[0].model, A_MODEL);
});

test('tenant B agent handler returns only B profile and accepts exact matching params', async () => {
  const token = tokenForTenant('bbb');
  for (const suffix of ['', '?instance=stagesnap%3Abbb', '?namespace=stagesnap%3Abbb']) {
    const response = await getTenantAgent(request(`/api/tenant/agent${suffix}`, token));
    assert.equal(response.status, 200, suffix);
    const body = await response.json();
    assert.equal(body.instanceId, 'stagesnap:bbb');
    assert.equal(body.profiles[0].name, 'tenant-b-profile');
    assert.equal(body.profiles[0].model, B_MODEL);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(A_MODEL));
  }
});

test('every tenant handler rejects mismatched instance and namespace probes without B data', async () => {
  const token = tokenForTenant('aaa');
  const probes = [
    '?instance=stagesnap:bbb',
    '?instance=STAGESNAP%3AAAA',
    '?namespace=STAGESNAP:BBB',
    '?namespace=STAGESNAP%3AAAA',
    '?namespace=stagesnap%3Abbb',
  ];
  for (const route of tenantRoutes) {
    for (const probe of probes) {
      const response = await route.handler(request(`${route.path}${probe}`, token));
      assert.equal(response.status, 403, `${route.name} ${probe}`);
      const text = await response.text();
      assert.match(text, /tenant_instance_mismatch/, `${route.name} ${probe}`);
      assert.doesNotMatch(text, new RegExp(B_MODEL), `${route.name} ${probe}`);
    }
  }
});

test('unconfigured tenant binding fails closed without configured-instance data', async () => {
  const response = await getTenantAgent(request('/api/tenant/agent', tokenForTenant('unconfigured')));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.deepEqual(body, { error: 'tenant_not_provisioned' });
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, new RegExp(A_MODEL));
  assert.doesNotMatch(text, new RegExp(B_MODEL));
});

test('configured tenant binding with a missing homeDir fails closed', async () => {
  const response = await getTenantCron(request('/api/tenant/cron', tokenForTenant('missing-home')));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'tenant_not_provisioned' });
});

test('regular-file and symlink tenant homes fail closed', async () => {
  for (const sub of ['regular-file', 'symlink-home']) {
    const response = await getTenantAgent(request('/api/tenant/agent', tokenForTenant(sub)));
    assert.equal(response.status, 403, sub);
    assert.deepEqual(await response.json(), { error: 'tenant_not_provisioned' }, sub);
  }
});

test('a non-Hermes configured tenant home fails closed', async () => {
  const response = await getTenantAgent(
    request('/api/tenant/agent', tokenForTenant('openclaw-home')),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'tenant_not_provisioned' });
});

test('sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs', () => {
  assert.equal(
    sanitizeForTenant('failed reading /Users/x/.hermes/profiles/stagesnap:bbb/state.db'),
    'failed reading [path]',
  );
  assert.equal(sanitizeForTenant(bHome), '[path]');
  assert.deepEqual(
    sanitizeForTenant({ nested: [{ message: 'see /var/lib/hermes/state.db now' }] }),
    { nested: [{ message: 'see [path] now' }] },
  );
  assert.equal(
    sanitizeForTenant(
      'delivery to https://example.com/hooks/a/b failed at /var/lib/hermes/state.db',
    ),
    'delivery to https://example.com/hooks/a/b failed at [path]',
  );
});

test('sanitizeForTenant removes normalized blocked-key variants', () => {
  assert.deepEqual(sanitizeForTenant({ systemPrompt: 'secret', safe: 'visible' }), {
    safe: 'visible',
  });
  assert.deepEqual(sanitizeForTenant({ System_Prompt: 'secret' }), {});
});

test('the cron route applies tenant sanitization to pass-through delivery errors', async () => {
  const response = await getTenantCron(
    request('/api/tenant/cron', tokenForTenant('bbb')),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const job = body.jobs.find((candidate: { name: string }) => candidate.name === 'balance-watch');
  assert.equal(job.deliveryError, 'failed reading [path]');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(aHome));
});

test('tenant routes return a generic 500 without backend path or message leakage', async () => {
  const originalConsoleError = console.error;
  const loggedArgs: unknown[] = [];
  console.error = (...args: unknown[]) => {
    loggedArgs.push(...args);
  };
  let response: Response;
  try {
    response = await getTenantCron(
      request('/api/tenant/cron', tokenForTenant('backend-error')),
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: 'internal_error' });
  assert.equal(loggedArgs[0], 'tenant route error');
  const rawError = String(loggedArgs[1]);
  assert.match(rawError, new RegExp(backendErrorHome));
  assert.equal(text.includes(backendErrorHome), false);
  assert.equal(text.includes(rawError), false);
  assert.equal(text.includes('EISDIR'), false);
});

test('all tenant routes reject unauthenticated requests without tenant data', async () => {
  for (const route of tenantRoutes) {
    const response = await route.handler(request(route.path));
    assert.equal(response.status, 403, route.name);
    const text = await response.text();
    for (const forbidden of [A_MODEL, B_MODEL, aHome, bHome]) {
      assert.equal(text.includes(forbidden), false, `${route.name}: ${forbidden}`);
    }
  }
});

test('all tenant handlers strip secrets and absolute fixture paths from full response bodies', async () => {
  const token = tokenForTenant('aaa');
  for (const route of tenantRoutes) {
    const response = await route.handler(request(route.path, token));
    assert.equal(response.status, 200, route.name);
    const text = JSON.stringify(await response.json());
    for (const forbidden of [
      'system_prompt', 'origin_json', CONFIG_SECRET, SESSION_PROMPT_SECRET,
      ORIGIN_SECRET, aHome, bHome,
    ]) {
      assert.equal(text.includes(forbidden), false, `${route.name}: ${forbidden}`);
    }
  }
});

test('internal viewer retains request-controlled instance selection on a real handler', async () => {
  const response = await getWorkspaceRoots(
    request('/api/agents/workspace-roots?instance=stagesnap:bbb', tokenForViewer()),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).instance, 'stagesnap:bbb');
});

test('tenant remains forbidden on the same five real internal handlers', async () => {
  const token = tokenForTenant('aaa');
  for (const route of internalRoutes) {
    const response = await route.handler(request(`${route.path}?instance=stagesnap:aaa`, token));
    assert.equal(response.status, 403, route.name);
    assert.deepEqual(await response.json(), { error: 'forbidden' }, route.name);
  }
});

test('path-traversal subject creates only an exact unconfigured binding and cannot escape', async () => {
  const tenant = upsertStagesnapUser('../../etc');
  assert.equal(tenant.tenant_instance_id, 'stagesnap:../../etc');
  const response = await getTenantSessions(
    request('/api/tenant/sessions', createSession(tenant.id)),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'tenant_not_provisioned' });
});
