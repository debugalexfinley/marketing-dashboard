import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { genHermesHome } from '../../../feature-research/hermes-port/fixtures/gen-hermes-home.mjs';
import type { HermesInstance } from '../instances';
import { resolveBackend } from './index';
import {
  HermesAgentBackend,
  HermesSchemaVersionError,
  isCronSessionIdForJob,
  parseHermesYaml,
} from './hermesAgent';
import type { SessionFileRef } from './types';

const FIXED_UPDATED_AT_MS = 1_785_625_200_000;
const FIXED_HEARTBEAT_MS = Date.parse('2026-08-01T14:00:30.000000+00:00');
const AGENT_JOB_ID = 'f0e1d2c3b4a5';
const SCRIPT_JOB_ID = 'b1c2d3e4f5a6';
const CRON_SESSION_JOB_ID = 'a9ce2d311889';
const CONFIG_SECRET = 'SENTINEL_DO_NOT_LEAK_9f8a7b';
const CONFIG_PROMPT_SECRET = 'CONFIG_SYSTEM_PROMPT_SENTINEL_DO_NOT_LEAK';
const SESSION_PROMPT_SECRET = 'SYSTEM_PROMPT_SENTINEL_';
const ORIGIN_SECRET = 'ORIGIN_SENTINEL_DO_NOT_LEAK';

let tempRoot = '';
let fullDir = '';
let bareDir = '';
let full: HermesAgentBackend;
let bare: HermesAgentBackend;

function instance(id: string, homeDir: string, profile?: string): HermesInstance {
  return {
    id,
    label: id,
    openclawHome: '',
    homeDir,
    profile,
    kind: 'hermes',
  };
}

function emptyRef(agentId = 'bare'): SessionFileRef {
  return {
    path: 'hermes://state.db/sessions/missing',
    name: 'missing',
    sessionId: 'missing',
    agentId,
    mtimeMs: 0,
    size: 0,
  };
}

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-backend-'));
  ({ fullDir, bareDir } = await genHermesHome(tempRoot));
  full = new HermesAgentBackend(instance('full-fixture', fullDir, 'fixture-profile'));
  bare = new HermesAgentBackend(instance('bare-fixture', bareDir, 'bare-profile'));
});

after(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('minimal YAML parser handles the fixture maps, scalars, and mapping lists', () => {
  const parsed = parseHermesYaml(`model:
  default: grok-4.5
agent:
  reasoning_effort: medium
moa:
  enabled: true
  reference_models:
    - provider: openai-codex
      model: gpt-5.6-sol
    - provider: xai-oauth
      model: grok-4.5
nullable: ~
`);

  assert.deepEqual(parsed.model, { default: 'grok-4.5' });
  assert.deepEqual(parsed.agent, { reasoning_effort: 'medium' });
  assert.deepEqual((parsed.moa as { reference_models: unknown[] }).reference_models, [
    { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    { provider: 'xai-oauth', model: 'grok-4.5' },
  ]);
  assert.equal(parsed.nullable, null);
});

test('agents and two-tier model routing use only whitelisted fixture config', async () => {
  const agents = await full.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'fixture-profile');
  assert.equal(agents[0].description, 'Synthetic full Hermes profile for adapter tests.');
  assert.equal(agents[0].model, 'grok-4.5');
  assert.equal(
    agents[0].gatewayRunning,
    Math.abs(Date.now() - FIXED_HEARTBEAT_MS) <= 120_000,
  );
  assert.deepEqual(await full.listConfiguredAgents(), agents);

  assert.deepEqual(await full.readModelRouting(), {
    'fixture-profile': { primary: 'grok-4.5', fallbacks: [] },
  });
  const rich = await full.readHermesModelRouting();
  assert.deepEqual(rich.default, { provider: 'xai-oauth', model: 'grok-4.5' });
  assert.equal(rich.moa?.referenceModels.length, 3);
  assert.deepEqual(rich.moa?.aggregator, { provider: 'xai-oauth', model: 'grok-4.5' });
  assert.deepEqual(rich.cronOverrides, [{
    jobId: AGENT_JOB_ID,
    provider: 'xai-oauth',
    model: 'grok-4.5',
  }]);
});

test('fresh heartbeat positively marks a generated profile as running', async () => {
  const homeDir = path.join(tempRoot, 'fresh-heartbeat');
  fs.mkdirSync(path.join(homeDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: fresh-model\n');
  fs.writeFileSync(path.join(homeDir, 'state', 'gateway.heartbeat'), JSON.stringify({
    pid: 9001,
    updated_at: new Date().toISOString(),
  }));

  const [agent] = await new HermesAgentBackend(instance('fresh', homeDir)).listAgents();
  assert.equal(agent.gatewayRunning, true);
});

test('cron jobs preserve unknown fields, normalize timestamps, and surface delivery errors', async () => {
  const jobsFile = await full.listCronJobs();
  assert.equal(jobsFile.updated_at, FIXED_UPDATED_AT_MS);
  assert.equal(jobsFile.jobs.length, 3);
  const deliveryJob = jobsFile.jobs.find((job) => job.id === CRON_SESSION_JOB_ID)!;
  assert.equal(deliveryJob.future_field, 'unknown-value');
  assert.equal(
    deliveryJob.deliveryError,
    'no delivery target resolved for deliver=telegram',
  );
  assert.equal(deliveryJob.createdAtMs, Date.parse('2026-07-12T20:42:58.388824-05:00'));
  assert.equal(deliveryJob.state?.nextRunAtMs, Date.parse('2026-08-02T09:00:00-05:00'));
  assert.equal(
    (jobsFile.jobs.find((job) => job.id === SCRIPT_JOB_ID)?.schedule as { everyMs: number }).everyMs,
    3_600_000,
  );
  assert.equal((await full.readCronJobsTolerant()).length, 3);
  assert.equal((await full.readRawCronJobs()).length, 3);
  assert.equal(await full.readCronNotificationJobs(), null);
});

test('cron executions normalize offset timestamps and enrich the guarded session match', async () => {
  const info = await full.readCronRunsInfo(CRON_SESSION_JOB_ID, 10);
  assert.equal(info.exists, true);
  assert.equal(info.runs.length, 3);
  const linked = info.runs.find((run) => run.id === '44444444444444444444444444444444')!;
  assert.equal(linked.ts, Date.parse('2026-08-01T09:00:16.101364-05:00'));
  assert.equal(linked.sessionId, 'cron_a9ce2d311889_20260801_090016');
  assert.equal(linked.estimatedCostUsd, 0.0214);
  assert.equal(linked.actualCostUsd, 0.0208);
  assert.equal(linked.totalTokens, 2_606);

  const agentRuns = await full.readCronRuns(AGENT_JOB_ID, 1);
  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].sessionId, undefined);
  assert.deepEqual(await full.readCronRunsInfo('missing-job', 10), {
    exists: false,
    runs: [],
  });
});

test('cron session join guard is anchored to the exact prefix', () => {
  assert.equal(
    isCronSessionIdForJob('cron_a9ce2d311889_20260801_090016', CRON_SESSION_JOB_ID),
    true,
  );
  assert.equal(isCronSessionIdForJob('foo_cron_a9ce2d311889_123', CRON_SESSION_JOB_ID), false);
  assert.equal(isCronSessionIdForJob('cron_other_a9ce2d311889_123', CRON_SESSION_JOB_ID), false);
});

test('cron log reads newest output first and returns interface empty cases', async () => {
  const info = await full.readCronLogInfo(SCRIPT_JOB_ID, 10_000);
  assert.ok(info);
  assert.match(info.content, /^Status: ok/);
  const newerIndex = info.content.indexOf('Newer synthetic site check passed.');
  const olderIndex = info.content.indexOf('Older synthetic site check passed.');
  assert.ok(newerIndex >= 0 && olderIndex > newerIndex);
  assert.equal(typeof Date.parse(info.modifiedAt), 'number');
  assert.equal(await full.tailCronLog('missing-job', 100), '');
  assert.equal(await full.readCronLogInfo('missing-job', 100), null);
});

test('sessions fabricate stable refs, page by message rowid, and normalize epoch seconds', async () => {
  const refs = await full.readSessions('fixture-profile');
  assert.equal(refs.length, 3);
  const cli = refs.find((ref) => ref.sessionId === '20260730_164700_cli00001')!;
  assert.equal(cli.path, 'hermes://state.db/sessions/20260730_164700_cli00001');
  assert.equal(cli.mtimeMs, 1_785_448_110_000);
  assert.ok(cli.size > 0);

  const first = await full.readSessionEntries(cli, 0);
  assert.equal(first.entries.length, 5);
  assert.equal(first.entries[0].timestamp, new Date(1_785_448_020_000).toISOString());
  assert.deepEqual(first.entries[0].message?.content, [
    { type: 'text', text: 'Draft a synthetic launch plan.' },
  ]);
  assert.equal(first.nextOffset, 5);
  const unchanged = await full.readSessionEntries(cli, first.nextOffset);
  assert.deepEqual(unchanged, { entries: [], nextOffset: 5 });
});

test('session usage aggregates model rows and lets unknown cost status win', async () => {
  const usage = await full.readSessionUsage('fixture-profile');
  assert.equal(usage.input_tokens, 4_607);
  assert.equal(usage.output_tokens, 866);
  assert.equal(usage.cache_read_tokens, 1_792);
  assert.equal(usage.reasoning_tokens, 173);
  assert.equal(usage.estimated_cost_usd, 0.0351);
  assert.equal(usage.actual_cost_usd, null);
  assert.equal(usage.cost_status, 'unknown');
  assert.ok(usage.tokens_today >= 0);
  assert.ok(usage.tokens_week >= 0);
});

test('gateway health combines optional files and normalizes UTC ISO timestamps', async () => {
  const report = await full.readHealthReport('gateway') as {
    heartbeat: { updated_at: number };
    lifecycle: { started_at: number };
    platforms: { updated_at: number };
  };
  assert.equal(report.heartbeat.updated_at, FIXED_HEARTBEAT_MS);
  assert.equal(report.lifecycle.started_at, Date.parse('2026-08-01T00:00:00.250000+00:00'));
  assert.equal(report.platforms.updated_at, FIXED_HEARTBEAT_MS);
  assert.deepEqual(await full.readRequiredHealthReport('gateway'), report);
  assert.equal(await full.readHealthReport('memory-health'), null);
  assert.equal(await full.readRequiredHealthReport('memory-policy'), null);
});

test('inert Hermes-only gaps return explicit empty interface shapes', async () => {
  assert.deepEqual(await full.listActionMappings(), {});
  assert.deepEqual(await full.readSendingPauseState(), { paused: false, reason: null });
  assert.deepEqual(await full.readAuditLog('anything', 100), []);
  assert.deepEqual(await full.readDeployLogs(), []);
  assert.deepEqual(await full.readDeployStatus(), {
    serviceName: '',
    serviceState: 'unavailable',
    scriptPath: '',
    lockFile: '',
    lockExists: false,
    runningPids: [],
    openclawBin: '',
    configValidation: { available: false, ok: false },
    latestLog: null,
  });
  const instances = await full.listInstances();
  assert.equal(typeof instances.defaultInstance, 'string');
  assert.ok(Array.isArray(instances.instances));
});

test('backend resolver constructs and caches HermesAgentBackend instances', () => {
  const previousInstances = process.env.HERMES_OPENCLAW_INSTANCES;
  const previousDefault = process.env.HERMES_DEFAULT_INSTANCE;
  process.env.HERMES_DEFAULT_INSTANCE = 'resolver-hermes-fixture';
  process.env.HERMES_OPENCLAW_INSTANCES = JSON.stringify([{
    id: 'resolver-hermes-fixture',
    label: 'Resolver Hermes Fixture',
    kind: 'hermes',
    homeDir: fullDir,
    profile: 'resolver-profile',
  }]);
  try {
    const first = resolveBackend('resolver-hermes-fixture');
    const second = resolveBackend('resolver-hermes-fixture');
    assert.ok(first instanceof HermesAgentBackend);
    assert.equal(first, second);
  } finally {
    if (previousInstances === undefined) delete process.env.HERMES_OPENCLAW_INSTANCES;
    else process.env.HERMES_OPENCLAW_INSTANCES = previousInstances;
    if (previousDefault === undefined) delete process.env.HERMES_DEFAULT_INSTANCE;
    else process.env.HERMES_DEFAULT_INSTANCE = previousDefault;
  }
});

test('workspace roots union projects and session paths with guarded read-only resolution', async () => {
  const roots = await full.listWorkspaceRoots();
  const rootPaths = await Promise.all(roots.map((root) => full.resolveWorkspacePath(root.id, '')));
  assert.deepEqual(rootPaths, [
    '/work/acme/marketing',
    '/work/experimental',
    '/work/shared',
  ]);
  assert.ok(roots.every((root) => root.kind === 'workspace' && root.writable === false));
  await assert.rejects(full.resolveWorkspacePath(roots[0].id, '../secret'), /Invalid path/);
  assert.deepEqual(await full.readWorkspace(roots[0].id, ''), {
    root: { ...roots[0], abs: '/work/acme/marketing' },
    type: 'error',
    error: 'Not found',
  });
});

test('workspace browsing reads files beneath a real temporary project root', async () => {
  const homeDir = path.join(tempRoot, 'workspace-home');
  const workspaceDir = path.join(tempRoot, 'workspace-files');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: fixture\n');
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Synthetic workspace\n');
  const projects = new Database(path.join(homeDir, 'projects.db'));
  projects.exec(`
    CREATE TABLE project_folders (project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT);
    CREATE TABLE discovered_repos (root TEXT, label TEXT, last_seen TEXT);
  `);
  projects.prepare('INSERT INTO project_folders VALUES (?, ?, ?, 1, NULL)')
    .run('fixture', workspaceDir, 'Fixture workspace');
  projects.close();

  const backend = new HermesAgentBackend(instance('workspace', homeDir));
  const [root] = await backend.listWorkspaceRoots();
  const directory = await backend.readWorkspace(root.id, '');
  assert.equal(directory.type, 'directory');
  if (directory.type === 'directory') {
    assert.deepEqual(directory.entries.map((entry) => entry.path), ['README.md']);
  }
  const file = await backend.readWorkspace(root.id, 'README.md');
  assert.equal(file.type, 'file');
  if (file.type === 'file') assert.equal(file.content, '# Synthetic workspace\n');
});

test('every optional-store read has a non-throwing bare-home empty result', async () => {
  const bareInstances = await bare.listInstances();
  assert.equal(typeof bareInstances.defaultInstance, 'string');
  assert.ok(Array.isArray(bareInstances.instances));
  assert.deepEqual(await bare.listActionMappings(), {});
  assert.equal((await bare.listAgents()).length, 1);
  assert.equal((await bare.listConfiguredAgents()).length, 1);
  assert.deepEqual(await bare.readModelRouting(), {
    'bare-profile': { primary: 'grok-4.5', fallbacks: [] },
  });
  assert.deepEqual(await bare.readHermesModelRouting(), {
    default: { provider: 'xai-oauth', model: 'grok-4.5' },
    fallbacks: [],
    cronOverrides: [],
  });
  assert.deepEqual(await bare.listCronJobs(), { jobs: [] });
  assert.deepEqual(await bare.readCronJobsTolerant(), []);
  assert.deepEqual(await bare.readRawCronJobs(), []);
  assert.equal(await bare.readCronNotificationJobs(), null);
  assert.deepEqual(await bare.readCronRuns('missing', 10), []);
  assert.deepEqual(await bare.readCronRunsInfo('missing', 10), { exists: false, runs: [] });
  assert.equal(await bare.tailCronLog('missing', 100), '');
  assert.equal(await bare.readCronLogInfo('missing', 100), null);
  assert.deepEqual(await bare.readSessions('bare-profile'), []);
  assert.deepEqual(await bare.readSessionEntries(emptyRef(), 0), { entries: [], nextOffset: 0 });
  assert.deepEqual(await bare.readSessionUsage('bare-profile'), {
    tokens_today: 0,
    tokens_week: 0,
    cost_today: 0,
    cost_week: 0,
  });
  assert.equal(await bare.readHealthReport('gateway'), null);
  assert.equal(await bare.readRequiredHealthReport('gateway'), null);
  assert.equal(await bare.readHealthReport('memory-health'), null);
  assert.equal(await bare.readRequiredHealthReport('memory-policy'), null);
  assert.deepEqual(await bare.readSendingPauseState(), { paused: false, reason: null });
  assert.deepEqual(await bare.readAuditLog('anything', 10), []);
  assert.deepEqual(await bare.readDeployLogs(), []);
  assert.equal((await bare.readDeployStatus()).lockExists, false);
  assert.deepEqual(await bare.listWorkspaceRoots(), []);
  assert.deepEqual(await bare.readWorkspace('missing', ''), {
    root: {
      id: 'missing',
      label: 'missing',
      kind: 'workspace',
      writable: false,
      abs: bareDir,
    },
    type: 'error',
    error: 'Not found',
  });
});

test('existing state.db with unsupported schema_version fails loudly and records the version', async () => {
  const homeDir = path.join(tempRoot, 'schema-999');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  const db = new Database(path.join(homeDir, 'state.db'));
  db.prepare('UPDATE schema_version SET version = 999').run();
  db.close();
  const backend = new HermesAgentBackend(instance('schema-999', homeDir));

  await assert.rejects(
    backend.readSessions('schema-999'),
    (error) => error instanceof HermesSchemaVersionError &&
      error.seenVersion === 999 &&
      error.message.includes('999'),
  );
});

test('existing state.db without schema_version fails loudly with the missing sentinel', async () => {
  const homeDir = path.join(tempRoot, 'schema-missing');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  const db = new Database(path.join(homeDir, 'state.db'));
  db.exec('DROP TABLE schema_version');
  db.close();
  const backend = new HermesAgentBackend(instance('schema-missing', homeDir));

  await assert.rejects(
    backend.readSessions('schema-missing'),
    (error) => error instanceof HermesSchemaVersionError &&
      error.seenVersion === -1 &&
      error.message.includes('-1'),
  );
});

test('all full-home read results exclude every config and session secret sentinel', async () => {
  const refs = await full.readSessions('fixture-profile');
  const roots = await full.listWorkspaceRoots();
  const results: unknown[] = [
    await full.listInstances(),
    await full.listActionMappings(),
    await full.listAgents(),
    await full.listConfiguredAgents(),
    await full.readModelRouting(),
    await full.readHermesModelRouting(),
    await full.listCronJobs(),
    await full.readCronJobsTolerant(),
    await full.readRawCronJobs(),
    await full.readCronNotificationJobs(),
    await full.readCronRuns(AGENT_JOB_ID, 10),
    await full.readCronRunsInfo(CRON_SESSION_JOB_ID, 10),
    await full.tailCronLog(SCRIPT_JOB_ID, 10_000),
    await full.readCronLogInfo(SCRIPT_JOB_ID, 10_000),
    refs,
    ...(await Promise.all(refs.map((ref) => full.readSessionEntries(ref, 0)))),
    await full.readSessionUsage('fixture-profile'),
    await full.readHealthReport('gateway'),
    await full.readRequiredHealthReport('gateway'),
    await full.readSendingPauseState(),
    await full.readAuditLog('anything', 10),
    await full.readDeployLogs(),
    await full.readDeployStatus(),
    roots,
    ...(await Promise.all(roots.map((root) => full.resolveWorkspacePath(root.id, '')))),
    ...(await Promise.all(roots.map((root) => full.readWorkspace(root.id, '')))),
  ];
  const serialized = JSON.stringify(results);
  for (const sentinel of [
    CONFIG_SECRET,
    CONFIG_PROMPT_SECRET,
    SESSION_PROMPT_SECRET,
    ORIGIN_SECRET,
  ]) {
    assert.equal(serialized.includes(sentinel), false, `leaked sentinel: ${sentinel}`);
  }
});
