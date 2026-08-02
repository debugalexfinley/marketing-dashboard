import assert from 'node:assert/strict';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import type { HermesInstance } from '../instances';
import {
  assertWorkspaceWriteAllowed,
  OpenClawBackend,
} from './openclaw';

const fixtureHome = path.resolve(
  process.cwd(),
  'feature-research/hermes-port/fixtures/openclaw-home',
);
const instance: HermesInstance = {
  id: 'fixture',
  label: 'Fixture',
  openclawHome: fixtureHome,
  kind: 'openclaw',
};

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
