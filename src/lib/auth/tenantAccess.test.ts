import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const tempDir = mkdtempSync(path.join(tmpdir(), 'hermes-tenant-access-test-'));
const dbPath = path.join(tempDir, 'hermes-test.db');

process.env.HERMES_DB_PATH = dbPath;

import { GET as getActivity } from '@/app/api/activity/route';
import { GET as getApprovalHistory } from '@/app/api/approvals/history/route';
import { GET as getContentPerformance } from '@/app/api/content-performance/route';
import { GET as getEngagement } from '@/app/api/engagement/route';
import { GET as getExperiments } from '@/app/api/experiments/route';
import { requireApiTenant, requireApiUser } from '@/lib/api-auth';
import { createSession, ensureAuthTables, upsertStagesnapUser } from '@/lib/auth';
import { getDb, resetDbForTests } from '@/lib/db';
import { TENANT_ALLOWED_PREFIXES } from '@/proxy';

type RouteHandler = (request: NextRequest) => Promise<Response>;

const guardedRoutes: { name: string; path: string; handler: RouteHandler }[] = [
  { name: 'activity', path: '/api/activity', handler: getActivity },
  { name: 'approval history', path: '/api/approvals/history', handler: getApprovalHistory },
  { name: 'content performance', path: '/api/content-performance', handler: getContentPerformance },
  { name: 'engagement', path: '/api/engagement', handler: getEngagement },
  { name: 'experiments', path: '/api/experiments', handler: getExperiments },
];

function resetAuthState(): void {
  ensureAuthTables();
  getDb().exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM google_login_requests;');
}

function sessionForRole(role: string): string {
  const result = getDb().prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
  ).run(`test-${role}`, 'not-used', role);
  return createSession(Number(result.lastInsertRowid));
}

function authenticatedRequest(pathname: string, sessionToken: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: `hermes-session=${sessionToken}` },
  });
}

beforeEach(() => {
  resetAuthState();
});

after(() => {
  resetDbForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

test('tenant sessions receive forbidden from requireApiUser and pass requireApiTenant', async () => {
  const tenant = upsertStagesnapUser('guard-test');
  const token = createSession(tenant.id);
  const request = authenticatedRequest('/api/test', token);

  const denied = requireApiUser(request);
  assert.equal(denied?.status, 403);
  assert.deepEqual(await denied?.json(), { error: 'forbidden' });
  assert.equal(requireApiTenant(request), null);
});

test('admin, editor, viewer, and operator sessions still pass requireApiUser', () => {
  for (const role of ['admin', 'editor', 'viewer', 'operator']) {
    const request = authenticatedRequest('/api/test', sessionForRole(role));
    assert.equal(requireApiUser(request), null, role);
  }
});

test('non-tenant sessions receive forbidden from requireApiTenant', async () => {
  const denied = requireApiTenant(authenticatedRequest('/api/test', sessionForRole('viewer')));
  assert.equal(denied?.status, 403);
  assert.deepEqual(await denied?.json(), { error: 'forbidden' });
});

test('five real requireApiUser route handlers reject tenant sessions', async () => {
  const tenant = upsertStagesnapUser('real-route-test');
  const token = createSession(tenant.id);

  for (const route of guardedRoutes) {
    const response = await route.handler(authenticatedRequest(route.path, token));
    assert.equal(response.status, 403, route.name);
    assert.deepEqual(await response.json(), { error: 'forbidden' }, route.name);
  }
});

test('viewer sessions still pass the same five real requireApiUser route handlers', async () => {
  const token = sessionForRole('viewer');

  for (const route of guardedRoutes) {
    const response = await route.handler(authenticatedRequest(route.path, token));
    assert.equal(response.status, 200, route.name);
  }
});

test('tenant path allowlist contains no broad API or root prefix', () => {
  assert.equal(TENANT_ALLOWED_PREFIXES.includes('/api/'), false);
  assert.equal(TENANT_ALLOWED_PREFIXES.includes('/'), false);
});
