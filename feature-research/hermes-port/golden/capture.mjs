#!/usr/bin/env node

// This capture intentionally uses `pnpm build` + `pnpm start`: production mode
// avoids development compilation and hot-reload timing from entering the goldens.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEST_USER = 'golden-admin';
const TEST_PASS = 'golden-fixture-password';
const PATH_TOKEN = '<FIXTURE_PATH>';
const REPO_TOKEN = '<REPO_PATH>';
const STATE_TOKEN = '<STATE_PATH>';
const TIMESTAMP_TOKEN = '<TIMESTAMP>';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const fixtureRoot = path.join(repoRoot, 'feature-research/hermes-port/fixtures/openclaw-home');

function parseArgs(argv) {
  const index = argv.indexOf('--out');
  if (index === -1 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error('Usage: node capture.mjs --out <dir>');
  }
  return { outDir: path.resolve(repoRoot, argv[index + 1]) };
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

function replacePaths(value, scratchDir) {
  const replacements = [
    [fixtureRoot, PATH_TOKEN],
    [scratchDir, STATE_TOKEN],
    [repoRoot, REPO_TOKEN],
  ].sort((a, b) => b[0].length - a[0].length);
  let out = value;
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

function normalize(value, scratchDir, key = '') {
  if (isTimestampKey(key) && value !== null) return TIMESTAMP_TOKEN;
  if (typeof value === 'string') return replacePaths(value, scratchDir);
  if (Array.isArray(value)) return value.map((item) => normalize(item, scratchDir));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalize(childValue, scratchDir, childKey),
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
  const { outDir } = parseArgs(process.argv.slice(2));
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'hermes-golden-'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
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
  };

  let server;
  try {
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
    const routes = [
      { path: '/api/agents', query: { instance: 'default' } },
      { path: '/api/cron', query: { instance: 'default' } },
      { path: '/api/cron/jobs', query: { instance: 'default' } },
      { path: '/api/cron/runs', query: { instance: 'default', id: 'campaign-digest' } },
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
      { path: '/api/agents/workspace', query: { instance: 'default', rootId: 'workspace-hermes', path: 'briefs/campaign-brief.txt' } },
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
      }, scratchDir);
      const outputPath = path.join(outDir, `${routeSlug(route.path)}.json`);
      await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      console.log(`${response.status} ${route.path} -> ${path.relative(repoRoot, outputPath)}`);
      if (response.status >= 500) failures.push(`${route.path}: ${response.status}`);
    }

    if (failures.length > 0) {
      throw new Error(`Unexpected 5xx responses: ${failures.join(', ')}`);
    }
  } finally {
    await stopServer(server);
    await rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
