import { promises as fs } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export const HERMES_STATE_SCHEMA_VERSION = 7;

const FIXED_UPDATED_AT_MS = 1_785_625_200_000;
const CRON_SESSION_JOB_ID = 'a9ce2d311889';

const CONFIG_YAML = `model:
  default: grok-4.5
  provider: xai-oauth
  base_url: https://api.x.ai/v1
agent:
  reasoning_effort: medium
moa:
  enabled: true
  reference_models:
    - provider: openai-codex
      model: gpt-5.6-sol
    - provider: xai-oauth
      model: grok-4.5
    - provider: anthropic
      model: claude-fable-5
  aggregator:
    provider: xai-oauth
    model: grok-4.5
gateway:
  enabled: true
  telegram:
    enabled: true
  discord:
    enabled: true
basic_auth:
  password_hash: "SENTINEL_DO_NOT_LEAK_9f8a7b"
system_prompt: "CONFIG_SYSTEM_PROMPT_SENTINEL_DO_NOT_LEAK"
`;

const BARE_CONFIG_YAML = `model:
  default: grok-4.5
  provider: xai-oauth
`;

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createStateDatabase(filePath) {
  const db = new Database(filePath);
  db.pragma(`user_version = ${HERMES_STATE_SCHEMA_VERSION}`);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT, session_key TEXT, chat_id TEXT, chat_type TEXT,
      thread_id TEXT, display_name TEXT, origin_json TEXT,
      model TEXT, model_config TEXT, system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL, ended_at REAL, end_reason TEXT,
      message_count INTEGER, tool_call_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      cwd TEXT, git_branch TEXT, git_repo_root TEXT,
      billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT,
      estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, cost_source TEXT, pricing_version TEXT,
      title TEXT, api_call_count INTEGER,
      archived INTEGER, pinned INTEGER, profile_name TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
      timestamp REAL, token_count INTEGER, finish_reason TEXT,
      reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
      codex_reasoning_items TEXT, codex_message_items TEXT,
      platform_message_id TEXT,
      active INTEGER, compacted INTEGER,
      api_content TEXT, display_kind TEXT, display_metadata TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      billing_provider TEXT NOT NULL,
      billing_base_url TEXT NOT NULL,
      billing_mode TEXT NOT NULL,
      task TEXT NOT NULL,
      api_call_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, cost_source TEXT,
      first_seen REAL, last_seen REAL,
      PRIMARY KEY (
        session_id, model, billing_provider, billing_base_url, billing_mode, task
      )
    );
  `);

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, source, user_id, session_key, chat_id, chat_type, thread_id,
      display_name, origin_json, model, model_config, system_prompt,
      parent_session_id, started_at, ended_at, end_reason, message_count,
      tool_call_count, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, cwd, git_branch, git_repo_root,
      billing_provider, billing_base_url, billing_mode, estimated_cost_usd,
      actual_cost_usd, cost_status, cost_source, pricing_version, title,
      api_call_count, archived, pinned, profile_name
    ) VALUES (
      @id, @source, @user_id, @session_key, @chat_id, @chat_type, @thread_id,
      @display_name, @origin_json, @model, @model_config, @system_prompt,
      @parent_session_id, @started_at, @ended_at, @end_reason, @message_count,
      @tool_call_count, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_write_tokens, @reasoning_tokens, @cwd, @git_branch, @git_repo_root,
      @billing_provider, @billing_base_url, @billing_mode, @estimated_cost_usd,
      @actual_cost_usd, @cost_status, @cost_source, @pricing_version, @title,
      @api_call_count, @archived, @pinned, @profile_name
    )
  `);

  const common = {
    user_id: null,
    session_key: null,
    chat_id: null,
    chat_type: null,
    thread_id: null,
    display_name: null,
    origin_json: '{"private":"ORIGIN_SENTINEL_DO_NOT_LEAK"}',
    model_config: '{}',
    parent_session_id: null,
    end_reason: 'completed',
    cache_write_tokens: 0,
    billing_base_url: 'https://api.x.ai/v1',
    billing_mode: 'api',
    pricing_version: 'fixture-v1',
    archived: 0,
    pinned: 0,
    profile_name: 'default',
  };

  const sessions = [
    {
      ...common,
      id: '20260730_164700_cli00001', source: 'cli', model: 'grok-4.5',
      system_prompt: 'SYSTEM_PROMPT_SENTINEL_1', started_at: 1_785_448_020,
      ended_at: 1_785_448_110, message_count: 5, tool_call_count: 1,
      input_tokens: 1_420, output_tokens: 318, cache_read_tokens: 256,
      reasoning_tokens: 61, cwd: '/work/acme/marketing', git_branch: 'main',
      git_repo_root: '/work/acme/marketing', billing_provider: 'xai-oauth',
      estimated_cost_usd: 0.0137, actual_cost_usd: 0.0129,
      cost_status: 'estimated', cost_source: 'pricing_table',
      title: 'CLI campaign planning', api_call_count: 2,
    },
    {
      ...common,
      id: '20260731_101500_discord1', source: 'discord', user_id: 'fixture-user',
      session_key: 'discord:fixture', chat_id: 'fixture-channel', chat_type: 'group',
      display_name: 'Synthetic Discord Session', model: 'grok-4.5',
      system_prompt: 'SYSTEM_PROMPT_SENTINEL_2', started_at: 1_785_510_900,
      ended_at: 1_785_510_960, message_count: 3, tool_call_count: 0,
      input_tokens: 982, output_tokens: 147, cache_read_tokens: 512,
      reasoning_tokens: 24, cwd: '/work/shared', git_branch: null,
      git_repo_root: null, billing_provider: 'xai-oauth',
      billing_mode: 'subscription', estimated_cost_usd: 0.0,
      actual_cost_usd: null, cost_status: 'unknown', cost_source: 'none',
      title: 'Discord subscription example', api_call_count: 1,
    },
    {
      ...common,
      id: `cron_${CRON_SESSION_JOB_ID}_20260801_090016`, source: 'cli',
      model: 'grok-4.5', system_prompt: 'SYSTEM_PROMPT_SENTINEL_3',
      started_at: 1_785_592_816, ended_at: 1_785_592_880,
      message_count: 3, tool_call_count: 1, input_tokens: 2_205,
      output_tokens: 401, cache_read_tokens: 1_024, reasoning_tokens: 88,
      cwd: '/work/acme/marketing', git_branch: 'hermes-port-phase2',
      git_repo_root: '/work/acme/marketing', billing_provider: 'xai-oauth',
      estimated_cost_usd: 0.0214, actual_cost_usd: 0.0208,
      cost_status: 'estimated', cost_source: 'pricing_table',
      title: 'Cron balance watch', api_call_count: 3,
    },
  ];
  db.transaction((rows) => rows.forEach((row) => insertSession.run(row)))(sessions);

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, tool_call_id, tool_calls, tool_name,
      timestamp, token_count, finish_reason, reasoning, reasoning_content,
      reasoning_details, codex_reasoning_items, codex_message_items,
      platform_message_id, active, compacted, api_content, display_kind,
      display_metadata
    ) VALUES (
      @id, @session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name,
      @timestamp, @token_count, @finish_reason, @reasoning, @reasoning_content,
      @reasoning_details, @codex_reasoning_items, @codex_message_items,
      @platform_message_id, @active, @compacted, @api_content, @display_kind,
      @display_metadata
    )
  `);
  const messageDefaults = {
    tool_call_id: null, tool_calls: null, tool_name: null, token_count: null,
    finish_reason: null, reasoning: null, reasoning_content: null,
    reasoning_details: null, codex_reasoning_items: null,
    codex_message_items: null, platform_message_id: null, active: 1,
    compacted: 0, api_content: null, display_kind: null, display_metadata: null,
  };
  const messages = [
    [1, sessions[0].id, 'user', 'Draft a synthetic launch plan.', 1_785_448_020, 18],
    [2, sessions[0].id, 'assistant', 'I will inspect the synthetic workspace.', 1_785_448_030, 24],
    [3, sessions[0].id, 'tool', 'Synthetic workspace inventory.', 1_785_448_040, 12],
    [4, sessions[0].id, 'assistant', 'Here is the fixture launch plan.', 1_785_448_080, 96],
    [5, sessions[0].id, 'user', 'Thanks.', 1_785_448_100, 3],
    [6, sessions[1].id, 'user', 'Give a synthetic status update.', 1_785_510_900, 8],
    [7, sessions[1].id, 'assistant', 'All fixture systems are nominal.', 1_785_510_930, 22],
    [8, sessions[1].id, 'user', 'Acknowledged.', 1_785_510_950, 3],
    [9, sessions[2].id, 'user', 'Run the balance-watch fixture.', 1_785_592_816, 9],
    [10, sessions[2].id, 'tool', 'Synthetic balance data loaded.', 1_785_592_830, 11],
    [11, sessions[2].id, 'assistant', 'Balance is within the fixture threshold.', 1_785_592_870, 31],
  ].map(([id, session_id, role, content, timestamp, token_count]) => ({
    ...messageDefaults, id, session_id, role, content, timestamp, token_count,
  }));
  db.transaction((rows) => rows.forEach((row) => insertMessage.run(row)))(messages);

  const insertUsage = db.prepare(`
    INSERT INTO session_model_usage (
      session_id, model, billing_provider, billing_base_url, billing_mode,
      task, api_call_count, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, estimated_cost_usd,
      actual_cost_usd, cost_status, cost_source, first_seen, last_seen
    ) VALUES (
      @session_id, @model, @billing_provider, @billing_base_url, @billing_mode,
      @task, @api_call_count, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_write_tokens, @reasoning_tokens, @estimated_cost_usd,
      @actual_cost_usd, @cost_status, @cost_source, @first_seen, @last_seen
    )
  `);
  const usageRows = [
    { session_id: sessions[0].id, model: 'grok-4.5', billing_provider: 'xai-oauth', billing_base_url: 'https://api.x.ai/v1', billing_mode: 'api', task: 'agent', api_call_count: 1, input_tokens: 1_100, output_tokens: 250, cache_read_tokens: 256, cache_write_tokens: 0, reasoning_tokens: 48, estimated_cost_usd: 0.0108, actual_cost_usd: 0.0101, cost_status: 'estimated', cost_source: 'pricing_table', first_seen: 1_785_448_020, last_seen: 1_785_448_070 },
    { session_id: sessions[0].id, model: 'gpt-5.6-sol', billing_provider: 'openai-codex', billing_base_url: 'https://api.openai.com/v1', billing_mode: 'api', task: 'moa-reference', api_call_count: 1, input_tokens: 320, output_tokens: 68, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 13, estimated_cost_usd: 0.0029, actual_cost_usd: 0.0028, cost_status: 'estimated', cost_source: 'pricing_table', first_seen: 1_785_448_040, last_seen: 1_785_448_060 },
    { session_id: sessions[1].id, model: 'grok-4.5', billing_provider: 'xai-oauth', billing_base_url: 'https://api.x.ai/v1', billing_mode: 'subscription', task: 'agent', api_call_count: 1, input_tokens: 982, output_tokens: 147, cache_read_tokens: 512, cache_write_tokens: 0, reasoning_tokens: 24, estimated_cost_usd: 0.0, actual_cost_usd: null, cost_status: 'unknown', cost_source: 'none', first_seen: 1_785_510_900, last_seen: 1_785_510_950 },
    { session_id: sessions[2].id, model: 'grok-4.5', billing_provider: 'xai-oauth', billing_base_url: 'https://api.x.ai/v1', billing_mode: 'api', task: 'cron', api_call_count: 2, input_tokens: 1_900, output_tokens: 340, cache_read_tokens: 1_024, cache_write_tokens: 0, reasoning_tokens: 75, estimated_cost_usd: 0.0185, actual_cost_usd: 0.018, cost_status: 'estimated', cost_source: 'pricing_table', first_seen: 1_785_592_816, last_seen: 1_785_592_870 },
    { session_id: sessions[2].id, model: 'gpt-5.6-sol', billing_provider: 'openai-codex', billing_base_url: 'https://api.openai.com/v1', billing_mode: 'api', task: 'moa-reference', api_call_count: 1, input_tokens: 305, output_tokens: 61, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 13, estimated_cost_usd: 0.0029, actual_cost_usd: 0.0028, cost_status: 'estimated', cost_source: 'pricing_table', first_seen: 1_785_592_825, last_seen: 1_785_592_850 },
  ];
  db.transaction((rows) => rows.forEach((row) => insertUsage.run(row)))(usageRows);
  db.close();
}

function createExecutionsDatabase(filePath) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      source TEXT NOT NULL,
      process_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_started_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
      claimed_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO executions
      (id, job_id, source, process_id, pid, process_started_at, status,
       claimed_at, started_at, finished_at, error)
    VALUES
      (@id, @job_id, @source, @process_id, @pid, @process_started_at, @status,
       @claimed_at, @started_at, @finished_at, @error)
  `);
  const rows = [
    { id: '11111111111111111111111111111111', job_id: 'f0e1d2c3b4a5', source: 'builtin', process_id: 'fixture-agent-1', pid: 4101, process_started_at: 1_785_510_000, status: 'completed', claimed_at: '2026-07-31T10:00:00.000000-05:00', started_at: '2026-07-31T10:00:00.200000-05:00', finished_at: '2026-07-31T10:00:03.400000-05:00', error: null },
    { id: '22222222222222222222222222222222', job_id: 'f0e1d2c3b4a5', source: 'builtin', process_id: 'fixture-agent-2', pid: 4102, process_started_at: 1_785_596_400, status: 'failed', claimed_at: '2026-08-01T10:00:00.000000-05:00', started_at: '2026-08-01T10:00:00.150000-05:00', finished_at: '2026-08-01T10:00:01.900000-05:00', error: 'Synthetic provider timeout' },
    { id: '33333333333333333333333333333333', job_id: CRON_SESSION_JOB_ID, source: 'builtin', process_id: 'fixture-script-1', pid: 4201, process_started_at: 1_785_506_400, status: 'completed', claimed_at: '2026-07-31T09:00:16.000000-05:00', started_at: '2026-07-31T09:00:16.100000-05:00', finished_at: '2026-07-31T09:00:18.300000-05:00', error: null },
    { id: '44444444444444444444444444444444', job_id: CRON_SESSION_JOB_ID, source: 'builtin', process_id: 'fixture-script-2', pid: 4202, process_started_at: 1_785_592_800, status: 'completed', claimed_at: '2026-08-01T09:00:16.101364-05:00', started_at: '2026-08-01T09:00:16.300000-05:00', finished_at: '2026-08-01T09:00:19.000000-05:00', error: null },
    { id: '55555555555555555555555555555555', job_id: CRON_SESSION_JOB_ID, source: 'builtin', process_id: 'fixture-script-3', pid: 4203, process_started_at: 1_785_593_100, status: 'failed', claimed_at: '2026-08-01T09:05:16.000000-05:00', started_at: '2026-08-01T09:05:16.200000-05:00', finished_at: '2026-08-01T09:05:17.000000-05:00', error: 'Synthetic script failure' },
  ];
  db.transaction((items) => items.forEach((item) => insert.run(item)))(rows);
  db.close();
}

function createProjectsDatabase(filePath) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT, icon TEXT,
      color TEXT, board_slug TEXT, primary_path TEXT, created_at TEXT,
      archived INTEGER
    );
    CREATE TABLE project_folders (
      project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT
    );
    CREATE TABLE discovered_repos (root TEXT, label TEXT, last_seen TEXT);
    INSERT INTO projects VALUES
      ('project-1', 'marketing', 'Marketing', 'Synthetic fixture project', 'megaphone', '#4455aa', 'fixture-board', '/work/acme/marketing', '2026-07-01T12:00:00-05:00', 0);
    INSERT INTO project_folders VALUES
      ('project-1', '/work/acme/marketing', 'Primary marketing repo', 1, '2026-07-01T12:00:00-05:00'),
      ('project-1', '/work/shared', 'Shared assets', 0, '2026-07-02T12:00:00-05:00');
    INSERT INTO discovered_repos VALUES
      ('/work/acme/marketing', 'marketing', '2026-08-01T08:00:00-05:00'),
      ('/work/experimental', 'experimental', '2026-08-01T08:30:00-05:00');
  `);
  db.close();
}

function completeJob(overrides) {
  return {
    id: '000000000000', name: 'fixture-job', prompt: '', skills: [], skill: null,
    model: null, provider: null, provider_snapshot: null, model_snapshot: null,
    base_url: null, script: null, no_agent: false, context_from: null,
    schedule: { kind: 'cron', expr: '0 10 * * *', display: '0 10 * * *' },
    schedule_display: '0 10 * * *', repeat: { times: null, completed: 0 },
    enabled: true, state: 'scheduled', paused_at: null, paused_reason: null,
    created_at: '2026-07-01T12:00:00.000000-05:00',
    next_run_at: '2026-08-02T10:00:00-05:00', last_run_at: null,
    last_status: null, last_error: null, last_delivery_error: null,
    deliver: 'discord', origin: null, enabled_toolsets: null, workdir: null,
    fire_claim: null, ...overrides,
  };
}

async function createFullHome(fullDir) {
  await fs.mkdir(fullDir, { recursive: true });
  await fs.writeFile(path.join(fullDir, 'config.yaml'), CONFIG_YAML, 'utf8');
  await fs.writeFile(
    path.join(fullDir, 'profile.yaml'),
    'description: Synthetic full Hermes profile for adapter tests.\ndescription_auto: false\n',
    'utf8',
  );

  createStateDatabase(path.join(fullDir, 'state.db'));
  const jobs = [
    completeJob({
      id: 'f0e1d2c3b4a5', name: 'daily-campaign-brief',
      prompt: 'Prepare the deterministic fixture campaign brief.',
      model: 'grok-4.5', provider: 'xai-oauth',
      model_snapshot: 'grok-4.5', provider_snapshot: 'xai-oauth',
      last_run_at: '2026-08-01T10:00:00-05:00', last_status: 'error',
      last_error: 'Synthetic provider timeout',
    }),
    completeJob({
      id: 'b1c2d3e4f5a6', name: 'hourly-site-check', prompt: '',
      script: 'site-check.py', no_agent: true,
      schedule: { kind: 'interval', minutes: 60, display: 'every 60m' },
      schedule_display: 'every 60m', deliver: 'telegram',
      last_run_at: '2026-08-01T08:00:00-05:00', last_status: 'ok',
    }),
    completeJob({
      id: CRON_SESSION_JOB_ID, name: 'balance-watch', prompt: '',
      script: 'balance-check.py', no_agent: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
      schedule_display: '0 9 * * *', repeat: { times: null, completed: 20 },
      created_at: '2026-07-12T20:42:58.388824-05:00',
      next_run_at: '2026-08-02T09:00:00-05:00',
      last_run_at: '2026-08-01T09:00:16.101364-05:00', last_status: 'ok',
      last_delivery_error: 'no delivery target resolved for deliver=telegram',
      deliver: 'telegram', future_field: 'unknown-value',
    }),
  ];
  await writeJson(path.join(fullDir, 'cron', 'jobs.json'), {
    jobs,
    updated_at: FIXED_UPDATED_AT_MS,
  });
  createExecutionsDatabase(path.join(fullDir, 'cron', 'executions.db'));

  const outputDir = path.join(fullDir, 'cron', 'output', 'b1c2d3e4f5a6');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, '2026-07-30_16-47-39.md'),
    '# Cron Job: hourly-site-check\n\n**Job ID:** b1c2d3e4f5a6\n**Run Time:** 2026-07-30 16:47:39\n**Mode:** no_agent (script)\n\n---\n\nOlder synthetic site check passed.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(outputDir, '2026-08-01_08-00-00.md'),
    '# Cron Job: hourly-site-check\n\n**Job ID:** b1c2d3e4f5a6\n**Run Time:** 2026-08-01 08:00:00\n**Mode:** no_agent (script)\n\n---\n\nNewer synthetic site check passed.\n',
    'utf8',
  );
  await fs.writeFile(path.join(fullDir, 'cron', 'ticker_heartbeat'), '1785592816\n', 'utf8');

  await writeJson(path.join(fullDir, 'state', 'gateway.heartbeat'), {
    pid: 4242,
    updated_at: '2026-08-01T14:00:30.000000+00:00',
    monotonic: 86194.865,
    start_time: 1_785_542_400.25,
  });
  await writeJson(path.join(fullDir, 'state', 'gateway.lifecycle.json'), {
    phase: 'running', pid: 4242, start_time: 1_785_542_400.25,
    started_at: '2026-08-01T00:00:00.250000+00:00',
  });
  await writeJson(path.join(fullDir, 'gateway_state.json'), {
    gateway_state: 'running',
    active_agents: 1,
    platforms: {
      telegram: {
        state: 'connected', error_code: null, error_message: null,
        updated_at: '2026-08-01T14:00:25.000000+00:00',
      },
      discord: {
        state: 'error', error_code: 'AUTH_REVOKED',
        error_message: 'Synthetic Discord credential was revoked.',
        updated_at: '2026-08-01T13:59:55.000000+00:00',
      },
    },
    updated_at: '2026-08-01T14:00:30.000000+00:00',
  });
  createProjectsDatabase(path.join(fullDir, 'projects.db'));
}

/** Build deterministic sibling `full/` and `bare/` Hermes homes under rootDir. */
export async function genHermesHome(rootDir) {
  const destination = path.resolve(rootDir);
  const fullDir = path.join(destination, 'full');
  const bareDir = path.join(destination, 'bare');
  await fs.mkdir(bareDir, { recursive: true });
  await fs.writeFile(path.join(bareDir, 'config.yaml'), BARE_CONFIG_YAML, 'utf8');
  await createFullHome(fullDir);
  return { fullDir, bareDir };
}
