import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  WORKSPACE_MAX_FILE_BYTES,
  resolveWorkspacePath as resolveWorkspaceRelativePath,
} from '../agent-workspace';
import { getDefaultInstanceId, getInstances, type HermesInstance } from '../instances';
import { allowCronWrite, allowPolicyWrite, allowWorkspaceWrite } from './openclaw';
import type {
  AgentBackend,
  AgentDefinition,
  AgentUsageTotals,
  CommandResult,
  CronJobConfig,
  CronJobsFile,
  CronRun,
  DeployStatus,
  HealthReportKind,
  HermesModelRef,
  HermesModelRouting,
  ModelRouting,
  Root,
  SessionEntry,
  SessionFileRef,
  WorkspaceEntry,
  WorkspaceMutationResult,
  WorkspaceReadResult,
  WorkspaceRoot,
} from './types';

export const HERMES_STATE_SCHEMA_VERSION = 7;
export const CRON_SESSION_ID_PREFIX = 'cron_';

const GATEWAY_FRESHNESS_MS = 120_000;

type JsonRecord = Record<string, unknown>;

type HermesConfig = {
  model: { default: string; provider: string | null; baseUrl: string | null };
  reasoningEffort: string | null;
  gateway: JsonRecord;
  moa?: {
    enabled: boolean;
    referenceModels: HermesModelRef[];
    aggregator: HermesModelRef;
  };
};

type WorkspaceRootWithAbs = WorkspaceRoot & { abs: string };

type SessionUsageRow = {
  session_id: string;
  api_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  cost_status: string | null;
  cost_source: string | null;
};

export class HermesSchemaVersionError extends Error {
  readonly seenVersion: number;

  constructor(seenVersion: number) {
    super(`Unsupported Hermes state.db schema version: ${seenVersion}`);
    this.name = 'HermesSchemaVersionError';
    this.seenVersion = seenVersion;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function toEpochMs(value: unknown, epochSeconds = false): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return epochSeconds || Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return epochSeconds || Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function parseYamlScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

/** Minimal parser for Hermes config/profile YAML: 2-space maps and mapping lists only. */
export function parseHermesYaml(source: string): JsonRecord {
  type Frame = {
    indent: number;
    container: JsonRecord | unknown[];
    parent?: JsonRecord;
    key?: string;
  };
  const root: JsonRecord = {};
  const stack: Frame[] = [{ indent: -2, container: root }];
  const lastKeyByIndent = new Map<number, { container: JsonRecord; key: string }>();

  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const text = rawLine.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const frame = stack[stack.length - 1];

    if (text.startsWith('- ')) {
      if (!Array.isArray(frame.container)) {
        if (!frame.parent || frame.key === undefined) continue;
        const list: unknown[] = [];
        frame.parent[frame.key] = list;
        frame.container = list;
      }
      const itemText = text.slice(2).trim();
      if (!itemText) {
        const item: JsonRecord = {};
        frame.container.push(item);
        stack.push({ indent, container: item });
        continue;
      }
      const colon = itemText.indexOf(':');
      if (colon === -1) {
        frame.container.push(parseYamlScalar(itemText));
        continue;
      }
      const item: JsonRecord = {};
      const key = itemText.slice(0, colon).trim();
      const value = itemText.slice(colon + 1).trim();
      item[key] = value ? parseYamlScalar(value) : {};
      frame.container.push(item);
      stack.push({ indent, container: item });
      lastKeyByIndent.set(indent, { container: item, key });
      continue;
    }

    const colon = text.indexOf(':');
    if (colon === -1) {
      const previous = lastKeyByIndent.get(indent - 2) ?? lastKeyByIndent.get(indent);
      if (previous && typeof previous.container[previous.key] === 'string') {
        previous.container[previous.key] = `${previous.container[previous.key]} ${text}`;
      }
      continue;
    }
    if (Array.isArray(frame.container)) continue;
    const key = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (value) {
      frame.container[key] = parseYamlScalar(value);
      lastKeyByIndent.set(indent, { container: frame.container, key });
      continue;
    }
    const child: JsonRecord = {};
    frame.container[key] = child;
    stack.push({ indent, container: child, parent: frame.container, key });
    lastKeyByIndent.set(indent, { container: frame.container, key });
  }

  return root;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanTree(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'boolean') out[key] = child;
    else if (isRecord(child)) out[key] = booleanTree(child);
  }
  return out;
}

function extractConfig(raw: JsonRecord): HermesConfig {
  const model = isRecord(raw.model) ? raw.model : {};
  const agent = isRecord(raw.agent) ? raw.agent : {};
  const moa = isRecord(raw.moa) ? raw.moa : null;
  const aggregator = moa && isRecord(moa.aggregator) ? moa.aggregator : {};
  const referenceModels = moa && Array.isArray(moa.reference_models)
    ? moa.reference_models.flatMap((item): HermesModelRef[] => {
        if (!isRecord(item)) return [];
        const modelName = stringValue(item.model);
        return modelName ? [{ provider: stringValue(item.provider), model: modelName }] : [];
      })
    : [];
  const aggregatorModel = stringValue(aggregator.model);

  return {
    model: {
      default: stringValue(model.default) ?? 'unknown',
      provider: stringValue(model.provider),
      baseUrl: stringValue(model.base_url),
    },
    reasoningEffort: stringValue(agent.reasoning_effort),
    gateway: booleanTree(raw.gateway),
    ...(moa && aggregatorModel
      ? {
          moa: {
            enabled: moa.enabled === true,
            referenceModels,
            aggregator: { provider: stringValue(aggregator.provider), model: aggregatorModel },
          },
        }
      : {}),
  };
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizedHealthValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedHealthValue);
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key.endsWith('_at') || key === 'start_time') && child !== null) {
      out[key] = toEpochMs(child);
    } else {
      out[key] = normalizedHealthValue(child);
    }
  }
  return out;
}

function normalizeSchedule(raw: unknown): CronJobConfig['schedule'] {
  if (!isRecord(raw)) return {};
  const kind = stringValue(raw.kind) ?? undefined;
  const expr = stringValue(raw.expr) ?? undefined;
  const minutes = numberOrZero(raw.minutes);
  return {
    ...raw,
    ...(kind ? { kind } : {}),
    ...(expr ? { expr } : {}),
    ...(kind === 'interval' && minutes > 0 ? { everyMs: minutes * 60_000 } : {}),
  };
}

function normalizeJob(raw: JsonRecord): CronJobConfig {
  const id = stringValue(raw.id) ?? stringValue(raw.jobId) ?? undefined;
  const createdAtMs = toEpochMs(raw.created_at ?? raw.createdAtMs);
  const updatedAtMs = toEpochMs(raw.updated_at ?? raw.updatedAtMs);
  const nextRunAtMs = toEpochMs(raw.next_run_at);
  const lastRunAtMs = toEpochMs(raw.last_run_at);
  const stateRecord = isRecord(raw.state) ? raw.state : {};
  return {
    ...raw,
    ...(id ? { id, jobId: id } : {}),
    enabled: raw.enabled !== false,
    schedule: normalizeSchedule(raw.schedule),
    ...(createdAtMs !== null ? { createdAtMs } : {}),
    ...(updatedAtMs !== null ? { updatedAtMs } : {}),
    deliveryError: stringValue(raw.last_delivery_error),
    state: {
      ...stateRecord,
      ...(typeof raw.state === 'string' ? { hermesState: raw.state } : {}),
      ...(nextRunAtMs !== null ? { nextRunAtMs } : {}),
      ...(lastRunAtMs !== null ? { lastRunAtMs } : {}),
      ...(raw.last_status !== undefined ? { lastStatus: raw.last_status } : {}),
      ...(raw.last_error !== undefined ? { lastError: raw.last_error } : {}),
    },
  };
}

export function isCronSessionIdForJob(sessionId: string, jobId: string): boolean {
  return sessionId.startsWith(`${CRON_SESSION_ID_PREFIX}${jobId}_`);
}

function cronSessionTimestamp(sessionId: string, jobId: string): number | null {
  if (!isCronSessionIdForJob(sessionId, jobId)) return null;
  const suffix = sessionId.slice(`${CRON_SESSION_ID_PREFIX}${jobId}_`.length);
  const match = suffix.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

function sessionUsage(rows: SessionUsageRow[]): JsonRecord | null {
  if (rows.length === 0) return null;
  const sum = (key: keyof SessionUsageRow) => rows.reduce((total, row) => total + numberOrZero(row[key]), 0);
  const hasUnknown = rows.some((row) => row.cost_status === 'unknown');
  const actualKnown = rows.some((row) => row.actual_cost_usd !== null);
  const inputTokens = sum('input_tokens');
  const outputTokens = sum('output_tokens');
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: sum('cache_read_tokens'),
    cacheWriteTokens: sum('cache_write_tokens'),
    reasoningTokens: sum('reasoning_tokens'),
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: sum('estimated_cost_usd'),
    actualCostUsd: actualKnown ? sum('actual_cost_usd') : null,
    costStatus: hasUnknown ? 'unknown' : rows.find((row) => row.cost_status)?.cost_status ?? null,
  };
}

function workspaceRootId(abs: string): string {
  return `workspace:${Buffer.from(abs).toString('base64url')}`;
}

function shouldHideWorkspaceEntry(relPosix: string): boolean {
  const segments = relPosix.split('/').filter(Boolean);
  return segments.some((segment) =>
    segment.startsWith('.') ||
    ['node_modules', 'credentials', 'state', 'logs', 'sessions', 'sandboxes', 'sandbox']
      .includes(segment.toLowerCase()),
  );
}

async function listWorkspaceDirectory(
  root: string,
  relDir: string,
  depth: number,
  maxEntries: number,
): Promise<WorkspaceEntry[]> {
  const absDir = relDir ? resolveWorkspaceRelativePath(root, relDir) : root;
  if (!absDir) return [];
  const out: WorkspaceEntry[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: absDir, rel: relDir, depth: 0 },
  ];
  while (queue.length && out.length < maxEntries) {
    const current = queue.shift()!;
    const names = await fsPromises.readdir(current.abs).catch(() => [] as string[]);
    for (const name of names) {
      const abs = path.join(current.abs, name);
      const stat = await fsPromises.stat(abs).catch(() => null);
      if (!stat) continue;
      const rel = current.rel ? `${current.rel.replace(/\/+$/, '')}/${name}` : name;
      const relPosix = rel.split(path.sep).join('/');
      if (shouldHideWorkspaceEntry(relPosix)) continue;
      if (stat.isDirectory()) {
        out.push({ path: relPosix, type: 'dir', mtimeMs: stat.mtimeMs });
        if (current.depth + 1 < depth) {
          queue.push({ abs, rel: relPosix, depth: current.depth + 1 });
        }
      } else if (stat.isFile()) {
        out.push({ path: relPosix, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs });
      }
      if (out.length >= maxEntries) break;
    }
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1,
  );
}

function call3(method: string): never {
  throw new Error(`HermesAgentBackend.${method}: implemented in call 3`);
}

export class HermesAgentBackend implements AgentBackend {
  readonly kind = 'hermes' as const;
  readonly instanceId: string;
  readonly instance: HermesInstance;
  readonly homeDir: string;

  constructor(instance: HermesInstance) {
    if (!instance.homeDir) throw new Error('HermesAgentBackend requires instance.homeDir');
    this.instance = instance;
    this.instanceId = instance.id;
    this.homeDir = path.resolve(instance.homeDir);
  }

  private agentId(): string {
    return this.instance.profile?.trim() || path.basename(this.homeDir) || 'default';
  }

  private async readConfig(): Promise<HermesConfig> {
    try {
      const source = await fsPromises.readFile(path.join(this.homeDir, 'config.yaml'), 'utf8');
      return extractConfig(parseHermesYaml(source));
    } catch {
      return extractConfig({});
    }
  }

  private async withStateDb<T>(empty: T, operation: (db: Database.Database) => T): Promise<T> {
    const filePath = path.join(this.homeDir, 'state.db');
    if (!(await fileExists(filePath))) return empty;
    const db = new Database(filePath, { readonly: true });
    try {
      const version = Number(db.pragma('user_version', { simple: true }));
      if (version !== HERMES_STATE_SCHEMA_VERSION) throw new HermesSchemaVersionError(version);
      return operation(db);
    } finally {
      db.close();
    }
  }

  private async withProjectsDb<T>(empty: T, operation: (db: Database.Database) => T): Promise<T> {
    const filePath = path.join(this.homeDir, 'projects.db');
    if (!(await fileExists(filePath))) return empty;
    const db = new Database(filePath, { readonly: true });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }

  cronWritesAllowed(): boolean {
    return allowCronWrite();
  }

  policyWritesAllowed(): boolean {
    return allowPolicyWrite();
  }

  workspaceWritesAllowed(): boolean {
    return allowWorkspaceWrite();
  }

  async listInstances(): Promise<{
    defaultInstance: string;
    instances: Array<{ id: string; label: string }>;
  }> {
    return {
      defaultInstance: getDefaultInstanceId(),
      instances: getInstances().map((instance) => ({ id: instance.id, label: instance.label })),
    };
  }

  async listActionMappings(): Promise<Record<string, { agent: string; skill: string }>> {
    return {};
  }

  async listAgents(): Promise<AgentDefinition[]> {
    const [config, profile, heartbeat] = await Promise.all([
      this.readConfig(),
      fsPromises.readFile(path.join(this.homeDir, 'profile.yaml'), 'utf8').catch(() => ''),
      readJson(path.join(this.homeDir, 'state', 'gateway.heartbeat')),
    ]);
    const profileYaml = parseHermesYaml(profile);
    const heartbeatRecord = isRecord(heartbeat) ? heartbeat : {};
    const heartbeatMs = toEpochMs(heartbeatRecord.updated_at);
    const gatewayRunning = typeof heartbeatRecord.pid === 'number' &&
      Number.isFinite(heartbeatRecord.pid) &&
      heartbeatMs !== null &&
      Math.abs(Date.now() - heartbeatMs) <= GATEWAY_FRESHNESS_MS;
    const id = this.agentId();
    return [{
      id,
      name: id,
      emoji: '◆',
      role: 'Hermes Agent Profile',
      description: stringValue(profileYaml.description) ?? '',
      model: config.model.default,
      fallbacks: [],
      tools: [],
      skills: [],
      cronJobs: [],
      workspace: this.homeDir,
      gatewayRunning,
      distribution: null,
    }];
  }

  async listConfiguredAgents(): Promise<AgentDefinition[]> {
    return this.listAgents();
  }

  async readModelRouting(): Promise<ModelRouting> {
    const rich = await this.readHermesModelRouting();
    return {
      [this.agentId()]: {
        primary: rich.default.model,
        fallbacks: rich.fallbacks.map((fallback) => fallback.model),
      },
    };
  }

  async readHermesModelRouting(): Promise<HermesModelRouting> {
    const [config, jobs] = await Promise.all([this.readConfig(), this.listCronJobs()]);
    const cronOverrides = jobs.jobs.flatMap((job): HermesModelRouting['cronOverrides'] => {
      const jobId = stringValue(job.id ?? job.jobId);
      const model = stringValue(job.model ?? job.model_snapshot);
      if (!jobId || !model) return [];
      return [{ jobId, provider: stringValue(job.provider ?? job.provider_snapshot), model }];
    });
    return {
      default: { provider: config.model.provider, model: config.model.default },
      fallbacks: [],
      ...(config.moa ? { moa: config.moa } : {}),
      cronOverrides,
    };
  }

  async listCronJobs(): Promise<CronJobsFile> {
    const parsed = await readJson(path.join(this.homeDir, 'cron', 'jobs.json'));
    if (!isRecord(parsed)) return { jobs: [] };
    const jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs.flatMap((job) => isRecord(job) ? [normalizeJob(job)] : [])
      : [];
    const updatedAt = toEpochMs(parsed.updated_at);
    return {
      ...parsed,
      jobs,
      ...(updatedAt !== null ? { updated_at: updatedAt } : {}),
    };
  }

  async readCronJobsTolerant(): Promise<unknown[]> {
    return (await this.listCronJobs()).jobs;
  }

  async readRawCronJobs(): Promise<CronJobConfig[]> {
    return (await this.listCronJobs()).jobs;
  }

  async readCronNotificationJobs(): Promise<CronJobConfig[] | null> {
    return null;
  }

  async writeCronJobs(_file: CronJobsFile): Promise<void> {
    void _file;
    call3('writeCronJobs');
  }

  async upsertCronJob(_job: CronJobConfig): Promise<void> {
    void _job;
    call3('upsertCronJob');
  }

  async toggleCronJob(_id: string, _enabled: boolean): Promise<void> {
    void _id;
    void _enabled;
    call3('toggleCronJob');
  }

  private async cronSessionUsage(jobId: string, runTimestamp: number | null): Promise<JsonRecord | null> {
    return this.withStateDb(null, (db) => {
      const sessions = db.prepare(
        `SELECT id, started_at
         FROM sessions
         WHERE id LIKE ?
         ORDER BY started_at DESC`,
      ).all(`${CRON_SESSION_ID_PREFIX}${jobId}_%`) as Array<{ id: string; started_at: number | null }>;
      const matching = sessions.filter((session) => isCronSessionIdForJob(session.id, jobId));
      if (!matching.length) return null;
      const selected = [...matching].sort((a, b) => {
        if (runTimestamp === null) return numberOrZero(b.started_at) - numberOrZero(a.started_at);
        const aTime = cronSessionTimestamp(a.id, jobId) ?? toEpochMs(a.started_at, true);
        const bTime = cronSessionTimestamp(b.id, jobId) ?? toEpochMs(b.started_at, true);
        return Math.abs((aTime ?? 0) - runTimestamp) - Math.abs((bTime ?? 0) - runTimestamp);
      })[0];
      const usageRows = db.prepare(
        `SELECT session_id, api_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, reasoning_tokens,
                estimated_cost_usd, actual_cost_usd, cost_status, cost_source
         FROM session_model_usage WHERE session_id = ?`,
      ).all(selected.id) as SessionUsageRow[];
      const usage = sessionUsage(usageRows);
      return usage ? { sessionId: selected.id, ...usage } : null;
    });
  }

  async readCronRuns(jobId: string, limit: number): Promise<CronRun[]> {
    return (await this.readCronRunsInfo(jobId, limit)).runs;
  }

  async readCronRunsInfo(
    jobId: string,
    limit: number,
  ): Promise<{ exists: boolean; runs: CronRun[] }> {
    const jobs = await this.listCronJobs();
    const exists = jobs.jobs.some((job) => job.id === jobId || job.jobId === jobId);
    const dbPath = path.join(this.homeDir, 'cron', 'executions.db');
    if (!(await fileExists(dbPath))) return { exists, runs: [] };
    const db = new Database(dbPath, { readonly: true });
    let rows: Array<JsonRecord>;
    try {
      rows = db.prepare(
        `SELECT id, job_id, source, process_id, pid, process_started_at,
                status, claimed_at, started_at, finished_at, error
         FROM executions WHERE job_id = ? ORDER BY claimed_at DESC LIMIT ?`,
      ).all(jobId, Math.max(0, Math.floor(limit))) as JsonRecord[];
    } finally {
      db.close();
    }
    const runs: CronRun[] = [];
    for (const row of rows) {
      const claimedAtMs = toEpochMs(row.claimed_at);
      const startedAtMs = toEpochMs(row.started_at);
      const finishedAtMs = toEpochMs(row.finished_at);
      const usage = await this.cronSessionUsage(jobId, claimedAtMs);
      runs.push({
        id: row.id,
        jobId,
        ts: claimedAtMs ?? String(row.claimed_at ?? ''),
        status: String(row.status ?? 'unknown'),
        summary: row.error ? null : String(row.status ?? ''),
        error: stringValue(row.error),
        ...(startedAtMs !== null ? { startedAtMs } : {}),
        ...(finishedAtMs !== null ? { finishedAtMs } : {}),
        ...(startedAtMs !== null && finishedAtMs !== null
          ? { durationMs: Math.max(0, finishedAtMs - startedAtMs) }
          : {}),
        ...(usage ?? {}),
      });
    }
    return { exists, runs };
  }

  async tailCronLog(jobId: string, bytes: number): Promise<string> {
    return (await this.readCronLogInfo(jobId, bytes))?.content ?? '';
  }

  async readCronLogInfo(
    jobId: string,
    bytes: number,
  ): Promise<{ content: string; modifiedAt: string } | null> {
    const outputDir = path.join(this.homeDir, 'cron', 'output', jobId);
    const names = await fsPromises.readdir(outputDir).catch(() => [] as string[]);
    const markdownNames = names.filter((name) => name.endsWith('.md')).sort().reverse();
    if (!markdownNames.length) return null;
    const chunks: Buffer[] = [];
    let remaining = Math.max(0, Math.floor(bytes));
    for (const name of markdownNames) {
      if (remaining <= 0) break;
      const content = await fsPromises.readFile(path.join(outputDir, name));
      const selected = content.subarray(Math.max(0, content.length - remaining));
      chunks.push(selected);
      remaining -= selected.length;
    }
    const latestPath = path.join(outputDir, markdownNames[0]);
    const stat = await fsPromises.stat(latestPath);
    const job = (await this.listCronJobs()).jobs.find((candidate) => candidate.id === jobId);
    const headline = [
      job?.last_status ? `Status: ${String(job.last_status)}` : '',
      job?.last_error ? `Error: ${String(job.last_error)}` : '',
      job?.deliveryError ? `Delivery error: ${job.deliveryError}` : '',
    ].filter(Boolean).join(' | ');
    const body = chunks.map((chunk) => chunk.toString('utf8')).join('\n\n');
    return {
      content: headline ? `${headline}\n\n${body}` : body,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async readSessions(agentId: string): Promise<SessionFileRef[]> {
    return this.withStateDb([], (db) => {
      const rows = db.prepare(
        `SELECT id, title, started_at, ended_at
         FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC`,
      ).all() as Array<{
        id: string;
        title: string | null;
        started_at: number | null;
        ended_at: number | null;
      }>;
      return rows.map((row) => {
        const name = row.title?.trim() || row.id;
        return {
          path: `hermes://state.db/sessions/${encodeURIComponent(row.id)}`,
          name,
          sessionId: row.id,
          agentId: agentId || this.agentId(),
          mtimeMs: toEpochMs(row.ended_at ?? row.started_at, true) ?? 0,
          size: Buffer.byteLength(`${row.id}\n${name}`, 'utf8'),
        };
      });
    });
  }

  async readSessionEntries(
    ref: SessionFileRef,
    fromOffset: number,
  ): Promise<{ entries: SessionEntry[]; nextOffset: number }> {
    return this.withStateDb({ entries: [], nextOffset: fromOffset }, (db) => {
      const rows = db.prepare(
        `SELECT id, role, content, timestamp, token_count
         FROM messages WHERE session_id = ? AND id > ?
         ORDER BY id, timestamp`,
      ).all(ref.sessionId, Math.max(0, Math.floor(fromOffset))) as Array<{
        id: number;
        role: string;
        content: string | null;
        timestamp: number | null;
        token_count: number | null;
      }>;
      const entries: SessionEntry[] = rows.map((row) => {
        const timestampMs = toEpochMs(row.timestamp, true) ?? 0;
        return {
          type: 'message',
          id: String(row.id),
          timestamp: new Date(timestampMs).toISOString(),
          message: {
            role: row.role,
            content: [{ type: 'text', text: row.content ?? '' }],
            timestamp: timestampMs,
            ...(row.token_count === null
              ? {}
              : { usage: { totalTokens: numberOrZero(row.token_count) } }),
          },
        };
      });
      return {
        entries,
        nextOffset: rows.length ? rows[rows.length - 1].id : fromOffset,
      };
    });
  }

  async readSessionUsage(_agentId: string): Promise<AgentUsageTotals> {
    void _agentId;
    return this.withStateDb(
      { tokens_today: 0, tokens_week: 0, cost_today: 0, cost_week: 0 },
      (db) => {
        const sessions = db.prepare(
          `SELECT id, started_at, input_tokens, output_tokens, cache_read_tokens,
                  cache_write_tokens, reasoning_tokens, estimated_cost_usd,
                  actual_cost_usd, cost_status, cost_source, api_call_count
           FROM sessions`,
        ).all() as Array<JsonRecord>;
        const usageRows = db.prepare(
          `SELECT session_id, api_call_count, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, reasoning_tokens,
                  estimated_cost_usd, actual_cost_usd, cost_status, cost_source
           FROM session_model_usage`,
        ).all() as SessionUsageRow[];
        const bySession = new Map<string, SessionUsageRow[]>();
        for (const row of usageRows) {
          const list = bySession.get(row.session_id) ?? [];
          list.push(row);
          bySession.set(row.session_id, list);
        }
        const now = Date.now();
        const today = new Date(now).toISOString().slice(0, 10);
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const totals: AgentUsageTotals = {
          tokens_today: 0,
          tokens_week: 0,
          cost_today: 0,
          cost_week: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
          cost_status: null,
          cost_source: null,
        };
        let actualUnknown = false;
        for (const session of sessions) {
          const sessionId = String(session.id);
          const rows = bySession.get(sessionId);
          const contributions: Array<JsonRecord> = rows?.length ? rows : [session];
          let tokens = 0;
          let cost = 0;
          for (const row of contributions) {
            const input = numberOrZero(row.input_tokens);
            const output = numberOrZero(row.output_tokens);
            const cacheRead = numberOrZero(row.cache_read_tokens);
            const cacheWrite = numberOrZero(row.cache_write_tokens);
            const reasoning = numberOrZero(row.reasoning_tokens);
            tokens += input + output;
            cost += numberOrZero(row.estimated_cost_usd);
            totals.input_tokens! += input;
            totals.output_tokens! += output;
            totals.cache_read_tokens! += cacheRead;
            totals.cache_write_tokens! += cacheWrite;
            totals.reasoning_tokens! += reasoning;
            totals.estimated_cost_usd! += numberOrZero(row.estimated_cost_usd);
            if (row.actual_cost_usd === null || row.actual_cost_usd === undefined) {
              actualUnknown = true;
            } else {
              totals.actual_cost_usd = numberOrZero(totals.actual_cost_usd) + numberOrZero(row.actual_cost_usd);
            }
            if (row.cost_status === 'unknown') {
              totals.cost_status = 'unknown';
              if (typeof row.cost_source === 'string') totals.cost_source = row.cost_source;
            } else if (!totals.cost_status && typeof row.cost_status === 'string') {
              totals.cost_status = row.cost_status;
            }
            if (!totals.cost_source && typeof row.cost_source === 'string') {
              totals.cost_source = row.cost_source;
            }
          }
          const startedMs = toEpochMs(session.started_at, true);
          if (startedMs === null) continue;
          if (new Date(startedMs).toISOString().slice(0, 10) === today) {
            totals.tokens_today += tokens;
            totals.cost_today += cost;
          }
          if (startedMs >= weekAgo && startedMs <= now) {
            totals.tokens_week += tokens;
            totals.cost_week += cost;
          }
        }
        if (actualUnknown) totals.actual_cost_usd = null;
        return totals;
      },
    );
  }

  async sendAgentMessage(
    _agentId: string,
    _message: string,
    _sessionId?: string,
  ): Promise<CommandResult> {
    void _agentId;
    void _message;
    void _sessionId;
    return call3('sendAgentMessage');
  }

  async sendOrchestratorMessage(_message: string, _sessionId?: string): Promise<CommandResult> {
    void _message;
    void _sessionId;
    return call3('sendOrchestratorMessage');
  }

  async validateConfig(): Promise<CommandResult> {
    return call3('validateConfig');
  }

  async readHealthReport(kind: HealthReportKind): Promise<unknown | null> {
    if (kind !== 'gateway') return null;
    const [heartbeat, lifecycle, platforms] = await Promise.all([
      readJson(path.join(this.homeDir, 'state', 'gateway.heartbeat')),
      readJson(path.join(this.homeDir, 'state', 'gateway.lifecycle.json')),
      readJson(path.join(this.homeDir, 'gateway_state.json')),
    ]);
    if (heartbeat === null && lifecycle === null && platforms === null) return null;
    return {
      heartbeat: heartbeat === null ? null : normalizedHealthValue(heartbeat),
      lifecycle: lifecycle === null ? null : normalizedHealthValue(lifecycle),
      platforms: platforms === null ? null : normalizedHealthValue(platforms),
    };
  }

  async readRequiredHealthReport(kind: HealthReportKind): Promise<unknown | null> {
    return this.readHealthReport(kind);
  }

  async readSendingPauseState(): Promise<{ paused: boolean; reason: string | null }> {
    return { paused: false, reason: null };
  }

  async writeHealthPolicy(
    _kind: 'memory-policy' | 'memory-alert-policy',
    _body: unknown,
    _auditEntry: unknown,
  ): Promise<void> {
    void _kind;
    void _body;
    void _auditEntry;
    call3('writeHealthPolicy');
  }

  async readAuditLog(_name: string, _limit: number): Promise<unknown[]> {
    void _name;
    void _limit;
    return [];
  }

  async readDeployLogs(): Promise<string[]> {
    return [];
  }

  async readDeployStatus(): Promise<DeployStatus> {
    return {
      serviceName: '',
      serviceState: 'unavailable',
      scriptPath: '',
      lockFile: '',
      lockExists: false,
      runningPids: [],
      openclawBin: '',
      configValidation: { available: false, ok: false },
      latestLog: null,
    };
  }

  private async workspaceRootsWithPaths(): Promise<WorkspaceRootWithAbs[]> {
    const roots = new Map<string, { label: string }>();
    for (const row of await this.withProjectsDb([], (db) => {
      const folders = db.prepare('SELECT path, label FROM project_folders').all() as Array<{
        path: string;
        label: string | null;
      }>;
      const repos = db.prepare('SELECT root AS path, label FROM discovered_repos').all() as Array<{
        path: string;
        label: string | null;
      }>;
      return [...folders, ...repos];
    })) {
      const abs = stringValue(row.path);
      if (abs) roots.set(path.resolve(abs), { label: stringValue(row.label) ?? path.basename(abs) });
    }
    for (const row of await this.withStateDb([], (db) => db.prepare(
      `SELECT cwd, git_repo_root FROM sessions
       WHERE cwd IS NOT NULL OR git_repo_root IS NOT NULL`,
    ).all() as Array<{ cwd: string | null; git_repo_root: string | null }>)) {
      for (const candidate of [row.cwd, row.git_repo_root]) {
        const abs = stringValue(candidate);
        if (abs && !roots.has(path.resolve(abs))) {
          roots.set(path.resolve(abs), { label: path.basename(abs) || abs });
        }
      }
    }
    return [...roots.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([abs, metadata]) => ({
        id: workspaceRootId(abs),
        label: metadata.label,
        kind: 'workspace' as const,
        writable: false,
        abs,
      }));
  }

  async listWorkspaceRoots(): Promise<Root[]> {
    return (await this.workspaceRootsWithPaths()).map((root) => ({
      id: root.id,
      label: root.label,
      kind: root.kind,
      writable: root.writable,
    }));
  }

  async resolveWorkspacePath(rootId: string, relPath: string): Promise<string> {
    const root = (await this.workspaceRootsWithPaths()).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error('Unknown root');
    if (!relPath) return root.abs;
    const resolved = resolveWorkspaceRelativePath(root.abs, relPath);
    if (!resolved) throw new Error('Invalid path');
    return resolved;
  }

  async readWorkspace(rootId: string, relPath: string): Promise<WorkspaceReadResult> {
    const root = (await this.workspaceRootsWithPaths()).find((candidate) => candidate.id === rootId);
    const fallbackRoot: WorkspaceRoot = {
      id: rootId,
      label: rootId,
      kind: 'workspace',
      writable: false,
      abs: this.homeDir,
    };
    if (!root) return { root: fallbackRoot, type: 'error', error: 'Not found' };
    const stat = await fsPromises.stat(root.abs).catch(() => null);
    if (!stat?.isDirectory()) return { root, type: 'error', error: 'Not found' };
    if (!relPath) {
      return { root, type: 'directory', entries: await listWorkspaceDirectory(root.abs, '', 4, 5000) };
    }
    const abs = resolveWorkspaceRelativePath(root.abs, relPath);
    if (!abs) return { root, type: 'error', error: 'Invalid path' };
    const childStat = await fsPromises.stat(abs).catch(() => null);
    if (!childStat) return { root, type: 'error', error: 'Not found' };
    if (childStat.isDirectory()) {
      return {
        root,
        type: 'directory',
        path: relPath,
        entries: await listWorkspaceDirectory(root.abs, relPath, 2, 5000),
      };
    }
    if (!childStat.isFile()) return { root, type: 'error', error: 'Unsupported file type' };
    if (childStat.size > WORKSPACE_MAX_FILE_BYTES) {
      return { root, type: 'error', error: 'File too large' };
    }
    return {
      root,
      type: 'file',
      path: relPath,
      size: childStat.size,
      mtimeMs: childStat.mtimeMs,
      content: await fsPromises.readFile(abs, 'utf8'),
    };
  }

  async createWorkspaceFile(
    _rootId: string,
    _relPath: string,
    _content: string,
  ): Promise<WorkspaceMutationResult> {
    void _rootId;
    void _relPath;
    void _content;
    return call3('createWorkspaceFile');
  }

  async updateWorkspaceFile(
    _rootId: string,
    _relPath: string,
    _content: string,
  ): Promise<WorkspaceMutationResult> {
    void _rootId;
    void _relPath;
    void _content;
    return call3('updateWorkspaceFile');
  }

  async deleteWorkspaceFile(_rootId: string, _relPath: string): Promise<WorkspaceMutationResult> {
    void _rootId;
    void _relPath;
    return call3('deleteWorkspaceFile');
  }
}
