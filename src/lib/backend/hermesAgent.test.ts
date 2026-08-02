import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { genHermesHome } from '../../../feature-research/hermes-port/fixtures/gen-hermes-home.mjs';
import type { HermesInstance } from '../instances';
import { resolveBackend } from './index';
import {
  cronSessionTimestamp,
  escapeHermesSqlLike,
  HermesAgentBackend,
  HermesSchemaVersionError,
  isCronSessionIdForJob,
  isValidHermesJobId,
  parseHermesYaml,
  toEpochMs,
} from './hermesAgent';
import type { CronJobConfig, SessionFileRef } from './types';

const FIXED_UPDATED_AT_MS = 1_785_625_200_000;
const FIXED_HEARTBEAT_MS = Date.parse('2026-08-01T14:00:30.000000+00:00');
const AGENT_JOB_ID = 'f0e1d2c3b4a5';
const SCRIPT_JOB_ID = 'b1c2d3e4f5a6';
const CRON_SESSION_JOB_ID = 'a9ce2d311889';
const CONFIG_SECRET = 'SENTINEL_DO_NOT_LEAK_9f8a7b';
const CONFIG_PROMPT_SECRET = 'CONFIG_SYSTEM_PROMPT_SENTINEL_DO_NOT_LEAK';
const SESSION_PROMPT_SECRET = 'SYSTEM_PROMPT_SENTINEL_';
const ORIGIN_SECRET = 'ORIGIN_SENTINEL_DO_NOT_LEAK';
const HERMES_STUB_BIN = path.resolve(
  'feature-research/hermes-port/fixtures/hermes-bin/hermes',
);
const ADVERSARIAL_NAME = 'name ; rm -rf / `id` $(id) \'single\' "double"\nnext-name';
const ADVERSARIAL_PROMPT = 'prompt ; rm -rf / `id` $(id) \'single\' "double"\nnext-prompt';
const ADVERSARIAL_MESSAGE = 'message ; rm -rf / `id` $(id) \'single\' "double"\nnext-message';

type StubInvocation = { argv: string[]; home: string };

let tempRoot = '';
let fullDir = '';
let bareDir = '';
let workspaceDir = '';
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

function cliBackend(id: string): HermesAgentBackend {
  const homeDir = path.join(tempRoot, id);
  fs.mkdirSync(homeDir, { recursive: true });
  return new HermesAgentBackend({
    ...instance(id, homeDir),
    hermesBin: HERMES_STUB_BIN,
  });
}

async function captureStubInvocations(
  name: string,
  operation: () => Promise<unknown>,
): Promise<StubInvocation[]> {
  const logPath = path.join(tempRoot, `${name}.jsonl`);
  assert.equal(fs.existsSync(logPath), false, 'stub log path must be fresh');
  const previousLog = process.env.HERMES_STUB_LOG;
  process.env.HERMES_STUB_LOG = logPath;
  try {
    await operation();
    return fs.readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubInvocation);
  } finally {
    if (previousLog === undefined) delete process.env.HERMES_STUB_LOG;
    else process.env.HERMES_STUB_LOG = previousLog;
  }
}

async function captureCronStubInvocations(
  name: string,
  operation: () => Promise<unknown>,
): Promise<StubInvocation[]> {
  const previous = process.env.HERMES_ALLOW_CRON_WRITE;
  process.env.HERMES_ALLOW_CRON_WRITE = 'true';
  try {
    return await captureStubInvocations(name, operation);
  } finally {
    if (previous === undefined) delete process.env.HERMES_ALLOW_CRON_WRITE;
    else process.env.HERMES_ALLOW_CRON_WRITE = previous;
  }
}

function assertSingleArg(argv: string[], expected: string): void {
  assert.equal(argv.filter((arg) => arg === expected).length, 1);
}

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-backend-'));
  ({ fullDir, bareDir, workspaceDir } = await genHermesHome(tempRoot));
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
  assert.equal(agents[0].gatewayRunning, false);
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

test('gateway freshness accepts 30 seconds and rejects five minutes', async () => {
  const now = Date.now();
  const cases = [
    { id: 'fresh-heartbeat', ageMs: 30_000, expected: true },
    { id: 'stale-heartbeat', ageMs: 300_000, expected: false },
  ];
  for (const fixture of cases) {
    const homeDir = path.join(tempRoot, fixture.id);
    fs.mkdirSync(path.join(homeDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: fresh-model\n');
    fs.writeFileSync(path.join(homeDir, 'state', 'gateway.heartbeat'), JSON.stringify({
      pid: 9001,
      updated_at: new Date(now - fixture.ageMs).toISOString(),
    }));

    const [agent] = await new HermesAgentBackend(instance(fixture.id, homeDir)).listAgents();
    assert.equal(agent.gatewayRunning, fixture.expected);
  }
});

test('timestamp normalization rejects absurd epoch magnitudes', () => {
  assert.equal(toEpochMs(Number.MAX_SAFE_INTEGER), null);
  assert.equal(toEpochMs(0.001, true), null);
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

test('cron jobs stay empty when missing but fail loudly when jobs.json is corrupt', async () => {
  assert.deepEqual(await bare.listCronJobs(), { jobs: [] });
  const homeDir = path.join(tempRoot, 'corrupt-jobs-home');
  fs.mkdirSync(path.join(homeDir, 'cron'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: fixture\n');
  fs.writeFileSync(path.join(homeDir, 'cron', 'jobs.json'), '{not valid json');
  const backend = new HermesAgentBackend(instance('corrupt-jobs', homeDir));

  await assert.rejects(backend.listCronJobs(), SyntaxError);
});

test('N2 argv integrity: writeCronJobs create preserves adversarial name and prompt', async () => {
  const backend = cliBackend('n2-write-create');
  const job: CronJobConfig = {
    name: ADVERSARIAL_NAME,
    prompt: ADVERSARIAL_PROMPT,
    enabled: true,
    schedule: { kind: 'interval', everyMs: 15 * 60_000 },
  };
  const invocations = await captureCronStubInvocations(
    'n2-write-create',
    () => backend.writeCronJobs({ jobs: [job] }),
  );

  assert.equal(invocations.length, 1);
  const { argv } = invocations[0];
  assert.deepEqual(argv.slice(0, 3), ['cron', 'create', 'every 15m']);
  assert.equal(argv[3], ADVERSARIAL_PROMPT);
  assert.equal(argv[argv.indexOf('--name') + 1], ADVERSARIAL_NAME);
  assertSingleArg(argv, ADVERSARIAL_PROMPT);
  assertSingleArg(argv, ADVERSARIAL_NAME);
});

test('N2 argv integrity: upsertCronJob create preserves adversarial name and prompt', async () => {
  const backend = cliBackend('n2-upsert-create');
  const job: CronJobConfig = {
    name: ADVERSARIAL_NAME,
    prompt: ADVERSARIAL_PROMPT,
    enabled: true,
    schedule: { kind: 'interval', everyMs: 20 * 60_000 },
  };
  const invocations = await captureCronStubInvocations(
    'n2-upsert-create',
    () => backend.upsertCronJob(job),
  );

  assert.equal(invocations.length, 1);
  const { argv } = invocations[0];
  assert.deepEqual(argv.slice(0, 3), ['cron', 'create', 'every 20m']);
  assert.equal(argv[3], ADVERSARIAL_PROMPT);
  assert.equal(argv[argv.indexOf('--name') + 1], ADVERSARIAL_NAME);
  assertSingleArg(argv, ADVERSARIAL_PROMPT);
  assertSingleArg(argv, ADVERSARIAL_NAME);
});

test('N2 argv integrity: cron edit preserves adversarial name and prompt changes', async () => {
  const backend = cliBackend('n2-edit');
  await captureCronStubInvocations('n2-edit-setup', () => backend.upsertCronJob({
    name: 'Benign starting name',
    prompt: 'Benign starting prompt',
    enabled: true,
    schedule: { kind: 'interval', everyMs: 25 * 60_000 },
  }));
  const [current] = (await backend.listCronJobs()).jobs;
  const invocations = await captureCronStubInvocations('n2-edit', () => backend.upsertCronJob({
    ...current,
    name: ADVERSARIAL_NAME,
    prompt: ADVERSARIAL_PROMPT,
  }));

  assert.equal(invocations.length, 1);
  const { argv } = invocations[0];
  assert.deepEqual(argv.slice(0, 2), ['cron', 'edit']);
  assert.equal(argv[argv.indexOf('--prompt') + 1], ADVERSARIAL_PROMPT);
  assert.equal(argv[argv.indexOf('--name') + 1], ADVERSARIAL_NAME);
  assertSingleArg(argv, ADVERSARIAL_PROMPT);
  assertSingleArg(argv, ADVERSARIAL_NAME);
});

test('N2 argv integrity: sendAgentMessage preserves an adversarial message', async () => {
  const backend = cliBackend('n2-message');
  const invocations = await captureStubInvocations(
    'n2-message',
    () => backend.sendAgentMessage('fixture-agent', ADVERSARIAL_MESSAGE),
  );

  assert.equal(invocations.length, 1);
  const { argv } = invocations[0];
  assert.equal(argv[0], '-z');
  assert.equal(argv[1], ADVERSARIAL_MESSAGE);
  assert.equal(argv[2], '--usage-file');
  assertSingleArg(argv, ADVERSARIAL_MESSAGE);
});

test('cron-mutating stub commands create the jobs lock artifact', async () => {
  const backend = cliBackend('stub-lock');
  const lockPath = path.join(backend.homeDir, 'cron', '.jobs.lock');
  const assertCreated = () => {
    assert.equal(fs.existsSync(lockPath), true);
    fs.unlinkSync(lockPath);
  };
  const previous = process.env.HERMES_ALLOW_CRON_WRITE;
  process.env.HERMES_ALLOW_CRON_WRITE = 'true';
  try {
    await backend.upsertCronJob({
      name: 'Lock fixture',
      prompt: 'Create the lock fixture.',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 30 * 60_000 },
    });
    assertCreated();

    const [created] = (await backend.listCronJobs()).jobs;
    await backend.upsertCronJob({ ...created, name: 'Edited lock fixture' });
    assertCreated();

    await backend.toggleCronJob(String(created.id), false);
    assertCreated();
    await backend.toggleCronJob(String(created.id), true);
    assertCreated();

    await backend.writeCronJobs({ jobs: [] });
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(
      fs.readdirSync(path.dirname(lockPath)).some((name) => name.startsWith('jobs.json.tmp.')),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.HERMES_ALLOW_CRON_WRITE;
    else process.env.HERMES_ALLOW_CRON_WRITE = previous;
  }
});

test('sendAgentMessage parses failed usage details from a non-zero stub exit', async () => {
  const backend = cliBackend('stub-oneshot-failure');
  const result = await backend.sendAgentMessage(
    'fixture-agent',
    'Exercise HERMES_STUB_FORCE_FAILURE for the adapter.',
  );
  const details = result.details as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Hermes stub forced failure/);
  assert.equal(details.completed, false);
  assert.equal(details.failed, true);
  assert.equal(typeof details.failure, 'string');
  assert.ok(String(details.failure).length > 0);
});

test('Hermes stub refuses a home outside the OS temp directory before writing', () => {
  const guardedHome = path.join(process.cwd(), '.hermes-stub-guard-should-not-exist');
  assert.equal(fs.existsSync(guardedHome), false);
  const result = spawnSync(HERMES_STUB_BIN, ['doctor'], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: guardedHome },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to use Hermes home outside OS temp directory/);
  assert.equal(fs.existsSync(guardedHome), false);
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

test('cron usage only joins a session within ten minutes of the run', async () => {
  const runs = await full.readCronRuns(CRON_SESSION_JOB_ID, 10);
  const far = runs.find((run) => run.id === '33333333333333333333333333333333')!;
  const close = runs.find((run) => run.id === '44444444444444444444444444444444')!;

  assert.equal(far.sessionId, undefined);
  assert.equal(far.estimatedCostUsd, undefined);
  assert.equal(far.totalTokens, undefined);
  assert.equal(close.sessionId, 'cron_a9ce2d311889_20260801_090016');
  assert.equal(close.estimatedCostUsd, 0.0214);
  assert.equal(close.totalTokens, 2_606);
});

test('cron session join guard is anchored to the exact prefix', () => {
  assert.equal(
    isCronSessionIdForJob('cron_a9ce2d311889_20260801_090016', CRON_SESSION_JOB_ID),
    true,
  );
  assert.equal(isCronSessionIdForJob('foo_cron_a9ce2d311889_123', CRON_SESSION_JOB_ID), false);
  assert.equal(isCronSessionIdForJob('cron_other_a9ce2d311889_123', CRON_SESSION_JOB_ID), false);
});

test('Hermes job ids and SQL LIKE values reject widening metacharacters', () => {
  assert.equal(isValidHermesJobId(CRON_SESSION_JOB_ID), true);
  assert.equal(isValidHermesJobId('aaaaaaaaaa%%'), false);
  assert.equal(escapeHermesSqlLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
});

test('cron session suffix timestamps use local wall-clock time', () => {
  const sessionId = `cron_${CRON_SESSION_JOB_ID}_20260801_090016`;
  const localTimestamp = new Date(2026, 7, 1, 9, 0, 16).getTime();
  const utcTimestamp = Date.UTC(2026, 7, 1, 9, 0, 16);
  assert.notEqual(localTimestamp, utcTimestamp, 'test requires a non-UTC process timezone');
  assert.equal(cronSessionTimestamp(sessionId, CRON_SESSION_JOB_ID), localTimestamp);
});

test('cron session usage falls back to the local-time id suffix when started_at is null', async () => {
  const homeDir = path.join(tempRoot, 'cron-local-time-fallback');
  fs.mkdirSync(path.join(homeDir, 'cron'), { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));
  fs.copyFileSync(
    path.join(fullDir, 'cron', 'jobs.json'),
    path.join(homeDir, 'cron', 'jobs.json'),
  );
  fs.copyFileSync(
    path.join(fullDir, 'cron', 'executions.db'),
    path.join(homeDir, 'cron', 'executions.db'),
  );
  const db = new Database(path.join(homeDir, 'state.db'));
  db.prepare('UPDATE sessions SET started_at = NULL WHERE id = ?')
    .run(`cron_${CRON_SESSION_JOB_ID}_20260801_090016`);
  db.close();

  const backend = new HermesAgentBackend(instance('cron-local-fallback', homeDir));
  const linked = (await backend.readCronRuns(CRON_SESSION_JOB_ID, 10))
    .find((run) => run.id === '44444444444444444444444444444444')!;
  assert.equal(linked.sessionId, `cron_${CRON_SESSION_JOB_ID}_20260801_090016`);
  assert.equal(linked.totalTokens, 2_606);
});

test('cron log reads newest output first and returns interface empty cases', async () => {
  const info = await full.readCronLogInfo(SCRIPT_JOB_ID, 10_000);
  assert.ok(info);
  assert.match(info.content, /^Status: ok/);
  const newerIndex = info.content.indexOf('Newer synthetic site check passed.');
  const olderIndex = info.content.indexOf('Older synthetic site check passed.');
  assert.ok(newerIndex >= 0 && olderIndex > newerIndex);
  assert.ok(Number.isFinite(Date.parse(info.modifiedAt)));
  const newestPath = path.join(
    fullDir,
    'cron',
    'output',
    SCRIPT_JOB_ID,
    '2026-08-01_08-00-00.md',
  );
  assert.equal(info.modifiedAt, fs.statSync(newestPath).mtime.toISOString());
  assert.equal(await full.tailCronLog('missing-job', 100), '');
  assert.equal(await full.readCronLogInfo('missing-job', 100), null);
});

test('cron log job ids cannot traverse outside the Hermes output directory', async () => {
  const homeDir = path.join(tempRoot, 'g1', 'home');
  const escapedDir = path.resolve(homeDir, 'cron', 'output', '../../../../etc');
  fs.mkdirSync(escapedDir, { recursive: true });
  fs.writeFileSync(path.join(escapedDir, 'leaked.md'), 'outside fixture content');
  const backend = new HermesAgentBackend(instance('g1-traversal', homeDir));

  assert.equal(await backend.readCronLogInfo('../../../../etc', 100), null);
  assert.equal(await backend.tailCronLog('../../../../etc', 100), '');
  assert.equal(await backend.readCronLogInfo('/etc/passwd', 100), null);
  assert.equal(
    await backend.readCronLogInfo('b1c2d3e4f5a6/../../../../etc', 100),
    null,
  );
});

test('wildcard-laden cron job ids return empty usage and runs', async () => {
  assert.deepEqual(await full.readCronRunsInfo('aaaaaaaaaa%%', 10), {
    exists: false,
    runs: [],
  });
  assert.deepEqual(await full.readCronRuns('aaaaaaaaaa%%', 10), []);
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

test('session refs and entry offsets stay in rowid units across two sync passes', async () => {
  const homeDir = path.join(tempRoot, 'session-cursor-home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));
  const sessionId = '20260730_164700_cli00001';
  const db = new Database(path.join(homeDir, 'state.db'));
  db.transaction(() => {
    for (let id = 5; id >= 1; id -= 1) {
      db.prepare('UPDATE messages SET id = ? WHERE id = ?').run(id + 1_000, id);
    }
  })();
  db.close();
  const backend = new HermesAgentBackend(instance('session-cursor', homeDir));
  const offsets = new Map<string, number>();
  const syncPass = async () => {
    const imported = [];
    for (const ref of await backend.readSessions('session-cursor')) {
      if (ref.sessionId !== sessionId) continue;
      const lastOffset = offsets.get(ref.sessionId) ?? 0;
      if (ref.size <= lastOffset) continue;
      const result = await backend.readSessionEntries(ref, lastOffset);
      imported.push(...result.entries);
      offsets.set(ref.sessionId, result.nextOffset);
    }
    return imported;
  };

  const first = await syncPass();
  assert.equal(first.length, 5);
  assert.equal(offsets.get(sessionId), 1_005);

  const writer = new Database(path.join(homeDir, 'state.db'));
  writer.prepare(
    `INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted)
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(1_006, sessionId, 'assistant', 'New message after first sync.', 1_785_448_120);
  writer.close();

  const second = await syncPass();
  assert.deepEqual(second.map((entry) => entry.id), ['1006']);
  assert.equal(offsets.get(sessionId), 1_006);
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
});

test('session usage computes exact today and seven-day token buckets', async () => {
  const now = Date.now();
  const homeDir = path.join(tempRoot, 'current-usage-home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));
  const db = new Database(path.join(homeDir, 'state.db'));
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run((now - 8 * 24 * 60 * 60 * 1000) / 1000, '20260730_164700_cli00001');
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run((now - 3 * 24 * 60 * 60 * 1000) / 1000, '20260731_101500_discord1');
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(now / 1000, `cron_${CRON_SESSION_JOB_ID}_20260801_090016`);
  db.close();

  const usage = await new HermesAgentBackend(instance('current-usage', homeDir))
    .readSessionUsage('current-usage');
  assert.equal(usage.tokens_today, 2_606);
  assert.equal(usage.tokens_week, 3_735);
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

test('workspace roots union projects and session paths with guarded writable resolution', async () => {
  const roots = await full.listWorkspaceRoots();
  const rootPaths = await Promise.all(roots.map((root) => full.resolveWorkspacePath(root.id, '')));
  assert.deepEqual(rootPaths, [
    workspaceDir,
    '/work/experimental',
    '/work/shared',
  ].sort((left, right) => left.localeCompare(right)));
  assert.ok(roots.every((root) => root.kind === 'workspace' && root.writable === true));
  await assert.rejects(full.resolveWorkspacePath(roots[0].id, '../secret'), /Invalid path/);
  const workspaceIndex = rootPaths.indexOf(workspaceDir);
  const file = await full.readWorkspace(roots[workspaceIndex].id, 'briefs/campaign-brief.txt');
  assert.equal(file.type, 'file');
  if (file.type === 'file') {
    assert.equal(
      file.content,
      'Campaign: Synthetic Autumn Launch\nGoal: Exercise the Hermes workspace golden with deterministic text.\n',
    );
  }
});

test('workspace roots exclude the Hermes home and descendants from every root source', async () => {
  const baseDir = path.join(tempRoot, 'workspace-curation');
  const homeDir = path.join(baseDir, 'hermes-home');
  const insideHome = path.join(homeDir, 'workspace');
  const safeDir = path.join(baseDir, 'safe-workspace');
  fs.mkdirSync(insideHome, { recursive: true });
  fs.mkdirSync(safeDir, { recursive: true });
  fs.copyFileSync(path.join(fullDir, 'config.yaml'), path.join(homeDir, 'config.yaml'));
  fs.copyFileSync(path.join(fullDir, 'state.db'), path.join(homeDir, 'state.db'));

  const state = new Database(path.join(homeDir, 'state.db'));
  state.prepare('UPDATE sessions SET cwd = NULL, git_repo_root = NULL').run();
  state.prepare('UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?')
    .run(homeDir, insideHome, '20260730_164700_cli00001');
  state.close();

  const projects = new Database(path.join(homeDir, 'projects.db'));
  projects.exec(`
    CREATE TABLE project_folders (project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT);
    CREATE TABLE discovered_repos (root TEXT, label TEXT, last_seen TEXT);
  `);
  projects.prepare('INSERT INTO project_folders VALUES (?, ?, ?, 1, NULL)')
    .run('home', homeDir, 'Hermes home');
  projects.prepare('INSERT INTO project_folders VALUES (?, ?, ?, 1, NULL)')
    .run('ancestor', baseDir, 'Hermes home ancestor');
  projects.prepare('INSERT INTO discovered_repos VALUES (?, ?, NULL)')
    .run(insideHome, 'Inside Hermes home');
  projects.prepare('INSERT INTO project_folders VALUES (?, ?, ?, 1, NULL)')
    .run('safe', safeDir, 'Safe workspace');
  projects.close();

  const backend = new HermesAgentBackend(instance('workspace-curation', homeDir));
  const roots = await backend.listWorkspaceRoots();
  const rootPaths = await Promise.all(roots.map((root) => backend.resolveWorkspacePath(root.id, '')));
  assert.deepEqual(rootPaths, [fs.realpathSync(safeDir)]);
  assert.ok(roots.every((root) => root.writable === true));
});

test('workspace secret filtering rejects direct file reads independently of root curation', async () => {
  const homeDir = path.join(tempRoot, 'workspace-secret-filter');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.yaml'), 'model:\n  default: fixture\n');
  fs.writeFileSync(path.join(homeDir, '.env'), 'API_KEY=secret\n');
  fs.writeFileSync(path.join(homeDir, 'auth.json'), '{"token":"secret"}\n');
  const backend = new HermesAgentBackend(instance('workspace-secret-filter', homeDir));
  const root = {
    id: 'direct-hermes-home',
    label: 'Direct Hermes home',
    kind: 'workspace' as const,
    writable: false,
    abs: homeDir,
  };
  const readDirectly = (backend as unknown as {
    readWorkspaceAtRoot: (
      candidate: typeof root,
      relPath: string,
    ) => ReturnType<HermesAgentBackend['readWorkspace']>;
  }).readWorkspaceAtRoot.bind(backend);

  for (const relPath of ['.env', 'auth.json']) {
    assert.deepEqual(await readDirectly(root, relPath), {
      root,
      type: 'error',
      error: 'Not found',
    });
  }
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
