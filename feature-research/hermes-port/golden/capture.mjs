#!/usr/bin/env node

// This capture intentionally uses `pnpm build` + `pnpm start`: production mode
// avoids development compilation and hot-reload timing from entering the goldens.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { genHermesHome } from '../fixtures/gen-hermes-home.mjs';

const TEST_USER = 'golden-admin';
const TEST_PASS = 'golden-fixture-password';
const PATH_TOKEN = '<FIXTURE_PATH>';
const REPO_TOKEN = '<REPO_PATH>';
const STATE_TOKEN = '<STATE_PATH>';
const TIMESTAMP_TOKEN = '<TIMESTAMP>';
const HERMES_WORKSPACE_ROOT_TOKEN = 'workspace:<FIXTURE_WORKSPACE_ID>';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const fixtureRoot = path.join(repoRoot, 'feature-research/hermes-port/fixtures/openclaw-home');

function parseArgs(argv) {
  const backendIndex = argv.indexOf('--backend');
  const backend = backendIndex === -1 ? 'openclaw' : argv[backendIndex + 1];
  if (!['openclaw', 'hermes'].includes(backend)) {
    throw new Error('Usage: node capture.mjs [--backend hermes] (--out <dir> | --check)');
  }
  const remaining = backendIndex === -1
    ? argv
    : argv.filter((_, index) => index !== backendIndex && index !== backendIndex + 1);
  if (remaining.includes('--check')) {
    if (remaining.length !== 1) {
      throw new Error('Usage: node capture.mjs [--backend hermes] (--out <dir> | --check)');
    }
    return { backend, check: true };
  }
  const index = remaining.indexOf('--out');
  if (index === -1 || !remaining[index + 1] || remaining[index + 1].startsWith('--')) {
    throw new Error('Usage: node capture.mjs [--backend hermes] (--out <dir> | --check)');
  }
  if (remaining.length !== 2) {
    throw new Error('Usage: node capture.mjs [--backend hermes] (--out <dir> | --check)');
  }
  return { backend, check: false, outDir: path.resolve(repoRoot, remaining[index + 1]) };
}

async function compareJsonDirectories(actualDir, expectedDir) {
  const jsonNames = async (dir) =>
    (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const actualNames = await jsonNames(actualDir);
  const expectedNames = await jsonNames(expectedDir);
  const allNames = [...new Set([...actualNames, ...expectedNames])].sort();
  const mismatches = [];

  for (const name of allNames) {
    if (!actualNames.includes(name)) {
      mismatches.push(`${name}: missing from fresh capture`);
      continue;
    }
    if (!expectedNames.includes(name)) {
      mismatches.push(`${name}: extra file in fresh capture`);
      continue;
    }
    const [actual, expected] = await Promise.all([
      readFile(path.join(actualDir, name)),
      readFile(path.join(expectedDir, name)),
    ]);
    if (actual.equals(expected)) continue;
    const sharedLength = Math.min(actual.length, expected.length);
    let offset = 0;
    while (offset < sharedLength && actual[offset] === expected[offset]) offset += 1;
    const prefix = expected.subarray(0, offset).toString('utf8');
    const line = prefix.split('\n').length;
    const column = offset - prefix.lastIndexOf('\n');
    const expectedByte = offset < expected.length ? `0x${expected[offset].toString(16).padStart(2, '0')}` : '<EOF>';
    const actualByte = offset < actual.length ? `0x${actual[offset].toString(16).padStart(2, '0')}` : '<EOF>';
    mismatches.push(
      `${name}: first difference at byte ${offset} (line ${line}, column ${column}); baseline ${expectedByte}, fresh ${actualByte}`,
    );
  }

  return { count: expectedNames.length, mismatches };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('Failed to reserve a local port');
  return port;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth/providers`, { redirect: 'manual' });
      if (response.status > 0) return;
    } catch {
      // The socket is not accepting requests yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready within 90 seconds');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function replacePaths(value, scratchDir, hermesWorkspaceRootId) {
  let out = value;
  if (hermesWorkspaceRootId) {
    out = out
      .split(encodeURIComponent(hermesWorkspaceRootId))
      .join(encodeURIComponent(HERMES_WORKSPACE_ROOT_TOKEN))
      .split(hermesWorkspaceRootId)
      .join(HERMES_WORKSPACE_ROOT_TOKEN);
  }
  const replacements = [
    [fixtureRoot, PATH_TOKEN],
    [scratchDir, STATE_TOKEN],
    [repoRoot, REPO_TOKEN],
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, token] of replacements) {
    out = out.split(prefix).join(token);
  }
  return out
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, TIMESTAMP_TOKEN)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, TIMESTAMP_TOKEN);
}

function isTimestampKey(key) {
  return /(?:^|_)(?:timestamp|generated_at|synced_at|created_at|updated_at|read_at|mtime|last_message_at|baseline_at|current_at|latest_policy_change)$/.test(key)
    || /(?:AtMs|mtimeMs)$/.test(key)
    || key === 'ts';
}

function normalize(value, scratchDir, key = '', hermesWorkspaceRootId = null) {
  if (isTimestampKey(key) && value !== null) return TIMESTAMP_TOKEN;
  if (typeof value === 'string') return replacePaths(value, scratchDir, hermesWorkspaceRootId);
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, scratchDir, '', hermesWorkspaceRootId));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalize(childValue, scratchDir, childKey, hermesWorkspaceRootId),
      ]),
    );
  }
  return value;
}

function routeSlug(routePath) {
  return routePath.replace(/^\//, '').replaceAll('/', '-');
}

async function responseBody(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return { type: 'json', value: JSON.parse(text) };
    } catch {
      return { type: 'text', value: text };
    }
  }
  return { type: 'text', value: text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let checkOutDir;
  let scratchDir;
  let server;
  try {
    checkOutDir = args.check
      ? await mkdtemp(path.join(os.tmpdir(), 'hermes-golden-check-'))
      : null;
    const outDir = checkOutDir ?? args.outDir;
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'hermes-golden-'));
    const fixtureBinDir = path.join(scratchDir, 'bin');
    const fixturePgrep = path.join(fixtureBinDir, 'pgrep');
    await mkdir(fixtureBinDir, { recursive: true });
    await writeFile(fixturePgrep, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(fixturePgrep, 0o755);

    const hermesFixture = args.backend === 'hermes'
      ? await genHermesHome(path.join(scratchDir, 'hermes-home'))
      : null;
    const hermesHome = hermesFixture?.fullDir ?? null;
    const hermesWorkspaceRootId = hermesFixture
      ? `workspace:${Buffer.from(hermesFixture.workspaceDir).toString('base64url')}`
      : null;
    const hermesBin = path.join(
      repoRoot,
      'feature-research/hermes-port/fixtures/hermes-bin/hermes',
    );

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      TZ: 'America/Chicago',
      LANG: 'en_US.UTF-8',
      PATH: `${fixtureBinDir}${path.delimiter}${process.env.PATH || ''}`,
      HERMES_OPENCLAW_HOME: fixtureRoot,
      HERMES_DEFAULT_INSTANCE: 'default',
      HERMES_STATE_DIR: scratchDir,
      HERMES_DB_PATH: path.join(scratchDir, 'hermes.db'),
      HERMES_AGENT_WORKSPACE_DIR: path.join(fixtureRoot, 'workspace-hermes'),
      AUTH_USER: TEST_USER,
      AUTH_PASS: TEST_PASS,
      AUTH_COOKIE_SECURE: 'false',
      API_KEY: 'golden-fixture-api-key',
      HERMES_ALLOW_POLICY_WRITE: 'false',
      HERMES_ALLOW_CRON_WRITE: 'false',
      HERMES_ALLOW_WORKSPACE_WRITE: 'false',
      HERMES_ADMIN_CLI: path.join(fixtureRoot, 'bin/openclaw'),
      HERMES_DEPLOY_LOG_DIR: path.join(fixtureRoot, 'logs/deploy'),
      HERMES_DEPLOY_LOCK_FILE: path.join(fixtureRoot, 'logs/deploy/not-running.lock'),
      HERMES_DEPLOY_SCRIPT_PATH: path.join(fixtureRoot, 'bin/golden-deploy-marker'),
      HERMES_SERVICE_NAME: 'hermes-golden-fixture.service',
      HERMES_HOST_LOCK: 'off',
      HERMES_USE_DEFAULT_AGENT_META: 'false',
      ...(hermesHome
        ? {
            HERMES_OPENCLAW_INSTANCES: JSON.stringify([
              {
                id: 'default',
                label: 'Default',
                kind: 'hermes',
                openclawHome: '',
                homeDir: hermesHome,
                profile: 'fixture-profile',
                hermesBin,
              },
            ]),
          }
        : {}),
    };

    console.log('Building production app...');
    await run('pnpm', ['build'], { cwd: repoRoot, env, stdio: 'inherit' });

    console.log(`Starting production app on ${baseUrl}...`);
    server = spawn('pnpm', ['start', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      detached: true,
    });
    await waitForServer(baseUrl, server);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });
    if (login.status !== 200) {
      throw new Error(`Login failed (${login.status}): ${await login.text()}`);
    }
    const setCookie = login.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0];
    if (!cookie.startsWith('hermes-session=')) {
      throw new Error('Login response did not include a hermes-session cookie');
    }

    // Only GET handlers are captured. The two chat routes support safe GET reads;
    // their POST handlers are intentionally never invoked.
    const cronJobId = args.backend === 'hermes' ? 'f0e1d2c3b4a5' : 'campaign-digest';
    const workspaceQuery = args.backend === 'hermes'
      ? {
          instance: 'default',
          rootId: hermesWorkspaceRootId,
          path: 'briefs/campaign-brief.txt',
        }
      : {
          instance: 'default',
          rootId: 'workspace-hermes',
          path: 'briefs/campaign-brief.txt',
        };
    const routes = [
      { path: '/api/agents', query: { instance: 'default' } },
      { path: '/api/cron', query: { instance: 'default' } },
      { path: '/api/cron/jobs', query: { instance: 'default' } },
      { path: '/api/cron/runs', query: { instance: 'default', id: cronJobId } },
      { path: '/api/automations', query: { instance: 'default' } },
      { path: '/api/hud', query: { instance: 'default' } },
      { path: '/api/chat/sync-sessions', query: { instance: 'default' } },
      { path: '/api/memory-health', query: { instance: 'default' } },
      { path: '/api/memory-drift', query: { instance: 'default' } },
      { path: '/api/memory-alerts', query: { instance: 'default' } },
      { path: '/api/memory-policy', query: { instance: 'default' } },
      { path: '/api/memory-alert-policy', query: { instance: 'default' } },
      { path: '/api/memory-effect', query: { instance: 'default' } },
      { path: '/api/deploy-status', query: { instance: 'default' } },
      { path: '/api/agents/workspace-roots', query: { instance: 'default' } },
      { path: '/api/agents/workspace', query: workspaceQuery },
      { path: '/api/instances' },
      { path: '/api/mission-control/chat', query: { mode: 'orchestrator', limit: '20' } },
      { path: '/api/chat/messages', query: { limit: '20' } },
    ];

    await mkdir(outDir, { recursive: true });
    const failures = [];
    for (const route of routes) {
      const url = new URL(route.path, baseUrl);
      for (const [key, value] of Object.entries(route.query || {})) {
        url.searchParams.set(key, value);
      }
      const response = await fetch(url, { headers: { cookie } });
      const body = await responseBody(response);
      const record = normalize({
        route: route.path,
        request: `${route.path}${url.search}`,
        status: response.status,
        body_type: body.type,
        body: body.value,
      }, scratchDir, '', hermesWorkspaceRootId);
      const outputPath = path.join(outDir, `${routeSlug(route.path)}.json`);
      await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      console.log(`${response.status} ${route.path} -> ${path.relative(repoRoot, outputPath)}`);
      if (response.status >= 500) failures.push(`${route.path}: ${response.status}`);
    }

    if (failures.length > 0) {
      throw new Error(`Unexpected 5xx responses: ${failures.join(', ')}`);
    }

    if (args.check) {
      const baselineDir = path.join(
        scriptDir,
        args.backend === 'hermes' ? 'baseline-hermes' : 'baseline',
      );
      const comparison = await compareJsonDirectories(outDir, baselineDir);
      if (comparison.mismatches.length > 0) {
        console.log('\nGolden check failed:');
        for (const mismatch of comparison.mismatches) console.log(`- ${mismatch}`);
        throw new Error(`${comparison.mismatches.length} golden file mismatch(es)`);
      }
      console.log(`\nGolden check passed: ${comparison.count} JSON files are byte-identical.`);
    }
  } finally {
    await stopServer(server);
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    if (checkOutDir) await rm(checkOutDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
