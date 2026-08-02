import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { findAliasedIds, getInstance, getInstances, getTenantInstance } from './instances';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-instances-'));
const envKeys = [
  'HERMES_TENANTS_ROOT',
  'HERMES_TENANTS_SCAN_TTL_MS',
  'HERMES_OPENCLAW_INSTANCES',
  'HERMES_OPENCLAW_HOME',
  'OPENCLAW_HOME',
  'HERMES_DEFAULT_INSTANCE',
  'HERMES_CRON_USER',
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let rootCounter = 0;
let tenantsRoot = '';

function makeTenant(name: string, root = tenantsRoot): string {
  const homeDir = path.join(root, name);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: test\n', 'utf8');
  return homeDir;
}

function ids(): string[] {
  return getInstances().map((instance) => instance.id);
}

before(() => {
  for (const key of envKeys) delete process.env[key];
});

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  tenantsRoot = path.join(tempRoot, `root-${rootCounter++}`);
  fs.mkdirSync(tenantsRoot);
  process.env.HERMES_TENANTS_ROOT = tenantsRoot;
});

after(() => {
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('discovers a valid tenant directory containing config.yaml', () => {
  const homeDir = makeTenant('valid-tenant');
  const instance = getInstances().find((candidate) => candidate.id === 'stagesnap:valid-tenant');
  assert.deepEqual(instance, {
    id: 'stagesnap:valid-tenant',
    label: 'valid-tenant',
    openclawHome: '',
    homeDir,
    kind: 'hermes',
  });
});

test('does not discover a tenant whose config.yaml is a symlink', () => {
  const target = makeTenant('config-target');
  const linkedHome = path.join(tenantsRoot, 'linked-config');
  fs.mkdirSync(linkedHome);
  fs.symlinkSync(
    path.join(target, 'config.yaml'),
    path.join(linkedHome, 'config.yaml'),
    'file',
  );
  assert.equal(ids().includes('stagesnap:linked-config'), false);
});

test('does not discover a tenant whose config.yaml is empty', () => {
  const homeDir = path.join(tenantsRoot, 'empty-config');
  fs.mkdirSync(homeDir);
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), '', 'utf8');
  assert.equal(ids().includes('stagesnap:empty-config'), false);
});

test('does not discover a directory without config.yaml', () => {
  fs.mkdirSync(path.join(tenantsRoot, 'missing-config'));
  assert.equal(ids().includes('stagesnap:missing-config'), false);
});

test('does not discover a symlink pointing at a valid tenant directory', () => {
  const target = makeTenant('target');
  fs.symlinkSync(target, path.join(tenantsRoot, 'linked-tenant'), 'dir');
  assert.equal(ids().includes('stagesnap:linked-tenant'), false);
});

test('does not discover a regular file at the tenants root', () => {
  fs.writeFileSync(path.join(tenantsRoot, 'regular-file'), 'not a directory', 'utf8');
  assert.equal(ids().includes('stagesnap:regular-file'), false);
});

test('rejects hidden, reserved, disallowed, overlong, and unicode names', () => {
  const rejected = ['.hidden', 'has space', 'has:colon', 'a\u0430', 'x'.repeat(200)];
  for (const name of rejected) makeTenant(name);

  const discovered = ids();
  for (const name of [...rejected, '.', '..']) {
    assert.equal(discovered.includes(`stagesnap:${name}`), false, name);
  }
});

test('scans only immediate children and never recurses into nested tenant directories', () => {
  const aHome = makeTenant('a');
  makeTenant('b', aHome);
  const discovered = ids();
  assert.equal(discovered.includes('stagesnap:a'), true);
  assert.equal(discovered.includes('stagesnap:b'), false);
  assert.equal(discovered.includes('stagesnap:a/b'), false);
});

test('an unset tenants root preserves env-configured instance behavior exactly', () => {
  delete process.env.HERMES_TENANTS_ROOT;
  process.env.HERMES_OPENCLAW_INSTANCES = JSON.stringify([
    {
      id: 'configured',
      label: 'Configured',
      openclawHome: '/tmp/configured-openclaw',
      cronUser: 'openclaw',
    },
  ]);
  assert.deepEqual(getInstances(), [
    {
      id: 'configured',
      label: 'Configured',
      openclawHome: '/tmp/configured-openclaw',
      homeDir: undefined,
      profile: undefined,
      hermesBin: undefined,
      kind: 'openclaw',
      cronUser: 'openclaw',
    },
  ]);
});

test('configured instance remains the default ahead of alphabetically earlier tenants', () => {
  makeTenant('aaa');
  makeTenant('aab');
  process.env.HERMES_OPENCLAW_INSTANCES = JSON.stringify([
    {
      id: 'configured-default',
      label: 'Configured Default',
      openclawHome: '/tmp/configured-default',
    },
  ]);

  assert.equal(getInstance().id, 'configured-default');
});

test('discovered tenant ids use case-sensitive exact matching', () => {
  makeTenant('Bob');
  assert.equal(getInstance('stagesnap:Bob').id, 'stagesnap:Bob');
  assert.notEqual(getInstance('stagesnap:bob').id, 'stagesnap:Bob');
});

test('findAliasedIds flags every shared identity and leaves unique identities alone', () => {
  assert.deepEqual(
    findAliasedIds([
      { id: 'stagesnap:one', dev: 10, ino: 20 },
      { id: 'stagesnap:two', dev: 10, ino: 20 },
      { id: 'stagesnap:unique', dev: 10, ino: 21 },
    ]),
    new Set(['stagesnap:one', 'stagesnap:two']),
  );
  assert.deepEqual(findAliasedIds([{ id: 'stagesnap:single', dev: 10, ino: 20 }]), new Set());
});

test('missing and non-directory tenant roots contribute no instances without throwing', () => {
  process.env.HERMES_TENANTS_ROOT = path.join(tempRoot, 'does-not-exist');
  assert.doesNotThrow(() => getInstances());
  assert.deepEqual(ids(), ['default']);

  const fileRoot = path.join(tempRoot, 'root-file');
  fs.writeFileSync(fileRoot, 'not a directory', 'utf8');
  process.env.HERMES_TENANTS_ROOT = fileRoot;
  assert.doesNotThrow(() => getInstances());
  assert.deepEqual(ids(), ['default']);
});

test('env-configured instances win id collisions and warn once per call', () => {
  makeTenant('collision');
  const envHome = path.join(tempRoot, 'env-collision-home');
  fs.mkdirSync(envHome);
  process.env.HERMES_OPENCLAW_INSTANCES = JSON.stringify([
    {
      id: 'stagesnap:collision',
      label: 'Environment winner',
      kind: 'hermes',
      homeDir: envHome,
      profile: 'environment-profile',
    },
  ]);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const matches = getInstances().filter((instance) => instance.id === 'stagesnap:collision');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.label, 'Environment winner');
    assert.equal(matches[0]?.homeDir, envHome);
    assert.equal(matches[0]?.profile, 'environment-profile');
    assert.deepEqual(warnings, [['Tenant instance id collision: stagesnap:collision']]);
  } finally {
    console.warn = originalWarn;
  }
});

test('tenant discovery cache reuses a scan within TTL and refreshes after expiry', async () => {
  process.env.HERMES_TENANTS_SCAN_TTL_MS = '30';
  makeTenant('first');
  const originalReaddirSync = fs.readdirSync;
  let rootScans = 0;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(tenantsRoot)) rootScans += 1;
    return originalReaddirSync(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    assert.equal(ids().includes('stagesnap:first'), true);
    makeTenant('created-without-restart');
    assert.equal(ids().includes('stagesnap:created-without-restart'), false);
    assert.equal(rootScans, 1);

    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(ids().includes('stagesnap:created-without-restart'), true);
    assert.equal(rootScans, 2);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test('getInstances returns fresh instance objects on every call', () => {
  makeTenant('immutable-cache');
  const first = getInstances().find((instance) => instance.id === 'stagesnap:immutable-cache');
  assert.ok(first);
  first.label = 'mutated';

  const second = getInstances().find((instance) => instance.id === 'stagesnap:immutable-cache');
  assert.equal(second?.label, 'immutable-cache');
  assert.notEqual(second, first);
});

test('discovered tenants retain strict getTenantInstance isolation validation', () => {
  const validHome = makeTenant('bound');
  const discovered = getTenantInstance('stagesnap:bound');
  assert.equal(discovered?.homeDir, validHome);
  assert.equal(discovered?.kind, 'hermes');

  const target = makeTenant('symlink-target');
  fs.symlinkSync(target, path.join(tenantsRoot, 'symlink-binding'), 'dir');
  assert.equal(getTenantInstance('stagesnap:symlink-binding'), null);
  assert.equal(getTenantInstance('stagesnap:not-configured'), null);
});

test('invalid tenant scan TTL values fall back without throwing', () => {
  makeTenant('ttl-fallback');
  for (const value of ['not-a-number', '-1']) {
    process.env.HERMES_TENANTS_SCAN_TTL_MS = value;
    assert.doesNotThrow(() => getInstances());
    assert.equal(ids().includes('stagesnap:ttl-fallback'), true);
  }
});
