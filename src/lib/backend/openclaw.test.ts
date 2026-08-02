import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { isAllowedWorkspaceWritePath, WORKSPACE_MAX_FILE_BYTES } from '../agent-workspace';
import type { HermesInstance } from '../instances';
import {
  assertWorkspaceWriteAllowed,
  OpenClawBackend,
} from './openclaw';

const fixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home',
);
const arrayFormFixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home-arrayform',
);
const nullEntryFixtureHome = path.join(arrayFormFixtureHome, 'null-entry');
const hudTolerantFixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home-hud-tolerant',
);
const nonArrayCronFixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home-cron-non-array',
);
const modelAliasFixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home-model-alias',
);
const instance: HermesInstance = {
  id: 'fixture',
  label: 'Fixture',
  openclawHome: fixtureHome,
  kind: 'openclaw',
};

function fixtureInstance(id: string, openclawHome: string): HermesInstance {
  return { id, label: id, openclawHome, kind: 'openclaw' };
}

const originalFlags = {
  cron: process.env.HERMES_ALLOW_CRON_WRITE,
  policy: process.env.HERMES_ALLOW_POLICY_WRITE,
  workspace: process.env.HERMES_ALLOW_WORKSPACE_WRITE,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.HERMES_ALLOW_CRON_WRITE;
  delete process.env.HERMES_ALLOW_POLICY_WRITE;
  delete process.env.HERMES_ALLOW_WORKSPACE_WRITE;
});

after(() => {
  restoreEnv('HERMES_ALLOW_CRON_WRITE', originalFlags.cron);
  restoreEnv('HERMES_ALLOW_POLICY_WRITE', originalFlags.policy);
  restoreEnv('HERMES_ALLOW_WORKSPACE_WRITE', originalFlags.workspace);
});

test('listAgents combines configured-id and filesystem-discovered agents', async () => {
  const backend = new OpenClawBackend(instance);
  const agents = await backend.listAgents();
  const ids = agents.map((agent) => agent.id);

  assert.ok(ids.includes('hermes'), 'expected configured hermes agent');
  assert.ok(ids.includes('apollo'), 'expected configured apollo agent');
  assert.ok(ids.includes('metis'), 'expected filesystem-only metis agent');
});

test('listConfiguredAgents ignores the top-level agents array form', async () => {
  const backend = new OpenClawBackend({
    id: 'array-form-fixture',
    label: 'Array Form Fixture',
    openclawHome: arrayFormFixtureHome,
    kind: 'openclaw',
  });

  assert.deepEqual(await backend.listConfiguredAgents(), []);
});

test('listWorkspaceRoots accepts the top-level agents array form', async () => {
  const backend = new OpenClawBackend({
    id: 'array-form-fixture',
    label: 'Array Form Fixture',
    openclawHome: arrayFormFixtureHome,
    kind: 'openclaw',
  });
  const roots = await backend.listWorkspaceRoots();
  const hermesWorkspace = roots.find((root) => root.id === 'workspace-hermes');

  assert.deepEqual(hermesWorkspace?.agents, ['Hermes Array Fixture']);
});

test('listConfiguredAgents skips null entries in agents.list', async () => {
  const backend = new OpenClawBackend({
    id: 'null-entry-fixture',
    label: 'Null Entry Fixture',
    openclawHome: nullEntryFixtureHome,
    kind: 'openclaw',
  });
  const agents = await backend.listConfiguredAgents();

  assert.deepEqual(agents.map((agent) => agent.id), ['hermes']);
});

test('cron fixture preserves cron, every, and at schedules and parses runs', async () => {
  const backend = new OpenClawBackend(instance);
  const jobsFile = await backend.listCronJobs();
  const scheduleKinds = jobsFile.jobs.map((job) => job.schedule?.kind).sort();

  assert.deepEqual(scheduleKinds, ['at', 'cron', 'every']);
  const runs = await backend.readCronRuns('campaign-digest', 10);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'ok');
  assert.match(String(runs[1].summary), /ITERATE/);
});

test('readCronJobsTolerant counts malformed entries from a top-level array', async () => {
  const backend = new OpenClawBackend(
    fixtureInstance('hud-tolerant-fixture', hudTolerantFixtureHome),
  );
  const jobs = await backend.readCronJobsTolerant();

  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[1], {
    enabled: true,
    state: { lastStatus: 'error' },
  });
  assert.equal(jobs[2], 'malformed-entry');
});

test('readCronRuns swallows non-ENOENT run-file read errors', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-runs-error-'));
  const runsDir = path.join(tempHome, 'cron', 'runs');
  const runPath = path.join(runsDir, 'campaign-digest.jsonl');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.copyFileSync(
    path.join(fixtureHome, 'cron', 'runs', 'campaign-digest.jsonl'),
    runPath,
  );
  fs.chmodSync(runPath, 0o000);

  try {
    const backend = new OpenClawBackend(fixtureInstance('runs-error-fixture', tempHome));
    assert.deepEqual(await backend.readCronRuns('campaign-digest', 10), []);
  } finally {
    fs.chmodSync(runPath, 0o600);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('readSessions propagates session-directory enumeration errors', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-sessions-error-'));
  const sessionsDir = path.join(tempHome, 'agents', 'hermes', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'session.jsonl'), '{}\n');
  fs.chmodSync(sessionsDir, 0o000);

  try {
    const backend = new OpenClawBackend(fixtureInstance('sessions-error-fixture', tempHome));
    await assert.rejects(backend.readSessions('hermes'), { code: 'EACCES' });
  } finally {
    fs.chmodSync(sessionsDir, 0o700);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('readAuditLog returns empty for missing files and propagates other read errors', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-audit-error-'));
  const logsDir = path.join(tempHome, 'logs');
  const auditPath = path.join(logsDir, 'memory-policy-audit.jsonl');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(auditPath, '{"timestamp":"2099-01-01T00:00:00.000Z"}\n');
  fs.chmodSync(auditPath, 0o000);

  try {
    const backend = new OpenClawBackend(fixtureInstance('audit-error-fixture', tempHome));
    assert.deepEqual(await backend.readAuditLog('missing-audit', 0), []);
    await assert.rejects(backend.readAuditLog('memory-policy-audit', 0), { code: 'EACCES' });
  } finally {
    fs.chmodSync(auditPath, 0o600);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('readCronNotificationJobs accepts a non-array jobs value without throwing', async () => {
  const backend = new OpenClawBackend(
    fixtureInstance('cron-non-array-fixture', nonArrayCronFixtureHome),
  );

  assert.equal(await backend.readCronNotificationJobs() as unknown, 'abc');
});

test('readModelRouting uses defaults for a normalized alias miss', async () => {
  const backend = new OpenClawBackend(
    fixtureInstance('model-alias-fixture', modelAliasFixtureHome),
  );
  const [agent] = await backend.listConfiguredAgents();
  const routing = await backend.readModelRouting();
  const effective = routing[agent.id] ?? { primary: agent.model, fallbacks: agent.fallbacks };

  assert.equal(agent.id, 'hermes');
  assert.equal(agent.model, 'synthetic/alias-model');
  assert.deepEqual(effective, {
    primary: 'synthetic/default-model',
    fallbacks: ['synthetic/default-fallback'],
  });
});

test('session walking returns refs and retains full-file offset behavior', async () => {
  const backend = new OpenClawBackend(instance);
  const refs = await backend.readSessions('hermes');

  assert.equal(refs.length, 1);
  const result = await backend.readSessionEntries(refs[0], 0);
  assert.equal(result.entries.length, 4);
  assert.equal(result.nextOffset, refs[0].size);

  const unchanged = await backend.readSessionEntries(refs[0], refs[0].size);
  assert.deepEqual(unchanged.entries, []);
  assert.equal(unchanged.nextOffset, refs[0].size);
});

test('cron write methods throw the route-compatible disabled error', async () => {
  const backend = new OpenClawBackend(instance);
  const expected = /Cron writes are disabled \(set HERMES_ALLOW_CRON_WRITE=true\)/;

  await assert.rejects(backend.writeCronJobs({ version: 1, jobs: [] }), expected);
  await assert.rejects(backend.upsertCronJob({ id: 'blocked' }), expected);
  await assert.rejects(backend.toggleCronJob('campaign-digest', false), expected);
});

test('writeCronJobs through the backend rotates both backup forms', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-cron-write-'));
  const cronDir = path.join(tempHome, 'cron');
  fs.mkdirSync(cronDir, { recursive: true });
  fs.writeFileSync(
    path.join(cronDir, 'jobs.json'),
    `${JSON.stringify({ version: 1, jobs: [{ id: 'existing', enabled: true }] }, null, 2)}\n`,
  );
  const previous = process.env.HERMES_ALLOW_CRON_WRITE;
  process.env.HERMES_ALLOW_CRON_WRITE = 'true';

  try {
    const backend = new OpenClawBackend(fixtureInstance('cron-write-fixture', tempHome));
    const next = { version: 1, jobs: [{ id: 'replacement', enabled: false }] };
    await backend.writeCronJobs(next);

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf-8')), next);
    assert.equal(fs.existsSync(path.join(cronDir, 'jobs.json.bak')), true);
    assert.equal(
      fs.readdirSync(cronDir).some((name) =>
        /^jobs\.json\.bak\.\d{4}-\d{2}-\d{2}T\d+Z$/.test(name),
      ),
      true,
    );
  } finally {
    restoreEnv('HERMES_ALLOW_CRON_WRITE', previous);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('policy and workspace guards throw route-compatible disabled errors', async () => {
  const backend = new OpenClawBackend(instance);

  await assert.rejects(
    backend.writeHealthPolicy('memory-policy', {}, {}),
    /Policy write disabled \(set HERMES_ALLOW_POLICY_WRITE=true to enable\)/,
  );
  assert.throws(
    () => assertWorkspaceWriteAllowed(),
    /Workspace writes are disabled \(set HERMES_ALLOW_WORKSPACE_WRITE=true\)/,
  );
});

test('workspace mutation methods directly enforce the disabled guard', async () => {
  const backend = new OpenClawBackend(instance);
  const expected = /Workspace writes are disabled \(set HERMES_ALLOW_WORKSPACE_WRITE=true\)/;

  await assert.rejects(backend.createWorkspaceFile('shared', 'notes/new.md', 'new'), expected);
  await assert.rejects(backend.updateWorkspaceFile('shared', 'notes/existing.md', 'next'), expected);
  await assert.rejects(backend.deleteWorkspaceFile('shared', 'notes/existing.md'), expected);
});

test('workspace mutations reject disallowed and traversal paths without filesystem changes', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-workspace-paths-'));
  const sharedDir = path.join(tempHome, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const previous = process.env.HERMES_ALLOW_WORKSPACE_WRITE;
  process.env.HERMES_ALLOW_WORKSPACE_WRITE = 'true';

  try {
    const backend = new OpenClawBackend(fixtureInstance('workspace-path-fixture', tempHome));
    const attempts = ['.env', '../etc/passwd', '/etc/passwd'];
    for (const relPath of attempts) {
      assert.equal(isAllowedWorkspaceWritePath(relPath), false);
      assert.deepEqual(
        await backend.createWorkspaceFile('shared', relPath, 'blocked'),
        { ok: false, error: 'Invalid path' },
      );
      assert.deepEqual(
        await backend.updateWorkspaceFile('shared', relPath, 'blocked'),
        { ok: false, error: 'Invalid path' },
      );
      assert.deepEqual(
        await backend.deleteWorkspaceFile('shared', relPath),
        { ok: false, error: 'Invalid path' },
      );
    }
    assert.deepEqual(fs.readdirSync(sharedDir), []);
    assert.equal(fs.existsSync(path.join(tempHome, 'etc', 'passwd')), false);
  } finally {
    restoreEnv('HERMES_ALLOW_WORKSPACE_WRITE', previous);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('workspace create, update, and delete enforce size caps and write safely end to end', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-workspace-write-'));
  const sharedDir = path.join(tempHome, 'shared');
  const relPath = 'notes/brief.md';
  const absPath = path.join(sharedDir, relPath);
  fs.mkdirSync(sharedDir, { recursive: true });
  const previous = process.env.HERMES_ALLOW_WORKSPACE_WRITE;
  process.env.HERMES_ALLOW_WORKSPACE_WRITE = 'true';

  try {
    const backend = new OpenClawBackend(fixtureInstance('workspace-write-fixture', tempHome));
    const oversized = 'x'.repeat(WORKSPACE_MAX_FILE_BYTES + 1);
    assert.deepEqual(
      await backend.createWorkspaceFile('shared', 'notes/oversized.md', oversized),
      { ok: false, error: 'File too large' },
    );
    assert.equal(fs.existsSync(path.join(sharedDir, 'notes', 'oversized.md')), false);

    assert.deepEqual(await backend.createWorkspaceFile('shared', relPath, 'first'), { ok: true });
    assert.equal(fs.readFileSync(absPath, 'utf-8'), 'first');
    assert.deepEqual(
      await backend.updateWorkspaceFile('shared', relPath, oversized),
      { ok: false, error: 'File too large' },
    );
    assert.equal(fs.readFileSync(absPath, 'utf-8'), 'first');

    assert.deepEqual(await backend.updateWorkspaceFile('shared', relPath, 'second'), { ok: true });
    assert.equal(fs.readFileSync(absPath, 'utf-8'), 'second');
    const backups = fs.readdirSync(path.dirname(absPath)).filter((name) =>
      /^brief\.md\.bak\.\d{4}-\d{2}-\d{2}T\d+Z$/.test(name),
    );
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(absPath), backups[0]), 'utf-8'), 'first');
    assert.equal(
      fs.readdirSync(path.dirname(absPath)).some((name) => name.includes('.tmp.')),
      false,
    );

    assert.deepEqual(await backend.deleteWorkspaceFile('shared', relPath), { ok: true });
    assert.equal(fs.existsSync(absPath), false);
  } finally {
    restoreEnv('HERMES_ALLOW_WORKSPACE_WRITE', previous);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('workspace route keeps its existing disabled, path, and size responses', () => {
  const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/app/api/agents/workspace/route.ts'),
    'utf-8',
  );

  assert.match(routeSource, /Workspace writes are disabled .*status: 403/);
  assert.equal(
    routeSource.match(/error: 'Path not allowed' \}, \{ status: 400 \}/g)?.length,
    3,
  );
  assert.equal(
    routeSource.match(/error: 'File too large' \}, \{ status: 413 \}/g)?.length,
    2,
  );
  assert.match(
    routeSource,
    /error === 'File too large' \? 413 : error === 'Root is read-only' \? 403 : 400/,
  );
});
