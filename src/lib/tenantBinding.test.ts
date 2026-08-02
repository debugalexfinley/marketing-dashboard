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
  ]);
}

function request(pathname: string, token: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: `hermes-session=${token}` },
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

before(async () => {
  const a = await genHermesHome(path.join(tempRoot, 'tenant-a'));
  const b = await genHermesHome(path.join(tempRoot, 'tenant-b'));
  aHome = a.fullDir;
  bHome = b.fullDir;
  replaceFixtureModel(aHome, A_MODEL);
  replaceFixtureModel(bHome, B_MODEL);
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

test('tenant binding persists on insert and conflict update and is read from the session row', () => {
  const first = upsertStagesnapUser('aaa');
  assert.equal(first.tenant_instance_id, 'stagesnap:aaa');
  getDb().prepare('UPDATE users SET tenant_instance_id = ? WHERE id = ?').run('tampered', first.id);
  const second = upsertStagesnapUser('aaa');
  assert.equal(second.tenant_instance_id, 'stagesnap:aaa');
});

test('tenant A agent handler returns only A profile and accepts matching case-insensitive params', async () => {
  const token = tokenForTenant('aaa');
  for (const suffix of ['', '?instance=stagesnap%3Aaaa', '?namespace=STAGESNAP%3AAAA']) {
    const response = await getTenantAgent(request(`/api/tenant/agent${suffix}`, token));
    assert.equal(response.status, 200, suffix);
    const body = await response.json();
    assert.equal(body.instanceId, 'stagesnap:aaa');
    assert.equal(body.profiles[0].name, 'tenant-a-profile');
    assert.equal(body.profiles[0].model, A_MODEL);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(B_MODEL));
  }
});

test('every tenant handler rejects mismatched instance and namespace probes without B data', async () => {
  const token = tokenForTenant('aaa');
  const probes = [
    '?instance=stagesnap:bbb',
    '?namespace=STAGESNAP:BBB',
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
