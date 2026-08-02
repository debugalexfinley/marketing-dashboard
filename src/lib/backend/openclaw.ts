import { spawn } from 'node:child_process';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import {
  getAgentWorkspaceRoot,
  resolveWorkspacePath as resolveWorkspaceRelativePath,
} from '../agent-workspace';
import type { HermesInstance } from '../instances';
import type {
  AgentBackend,
  AgentDefinition,
  AgentModelConfig,
  AgentSkill,
  AgentUsageTotals,
  CommandResult,
  CronJob,
  CronJobConfig,
  CronJobsFile,
  CronRun,
  HealthReportKind,
  ModelRouting,
  Root,
  RootKind,
  SessionEntry,
  SessionFileRef,
} from './types';

const ADMIN_CLI = process.env.HERMES_ADMIN_CLI || process.env.OPENCLAW_BIN || 'openclaw';

const CRON_WRITE_DISABLED = 'Cron writes are disabled (set HERMES_ALLOW_CRON_WRITE=true)';
const POLICY_WRITE_DISABLED =
  'Policy write disabled (set HERMES_ALLOW_POLICY_WRITE=true to enable)';
const WORKSPACE_WRITE_DISABLED =
  'Workspace writes are disabled (set HERMES_ALLOW_WORKSPACE_WRITE=true)';

export type OpenClawPaths = {
  openclawHome: string;
  openclawConfigPath: string;
  agentsDir: string;
  cronDir: string;
  healthDir: string;
  logsDir: string;
};

export function resolveOpenClawPaths(instance: HermesInstance): OpenClawPaths {
  const openclawHome = instance.openclawHome;
  return {
    openclawHome,
    openclawConfigPath: path.join(openclawHome, 'openclaw.json'),
    agentsDir: path.join(openclawHome, 'agents'),
    cronDir: path.join(openclawHome, 'cron'),
    healthDir: path.join(openclawHome, 'health'),
    logsDir: path.join(openclawHome, 'logs'),
  };
}

function envFlag(name: string): boolean {
  return String(process.env[name] ?? '').trim().toLowerCase() === 'true';
}

export function allowPolicyWrite(): boolean {
  return envFlag('HERMES_ALLOW_POLICY_WRITE');
}

export function allowCronWrite(): boolean {
  return envFlag('HERMES_ALLOW_CRON_WRITE');
}

export function allowWorkspaceWrite(): boolean {
  return envFlag('HERMES_ALLOW_WORKSPACE_WRITE');
}

export function assertCronWriteAllowed(): void {
  if (!allowCronWrite()) throw new Error(CRON_WRITE_DISABLED);
}

export function assertPolicyWriteAllowed(): void {
  if (!allowPolicyWrite()) throw new Error(POLICY_WRITE_DISABLED);
}

export function assertWorkspaceWriteAllowed(): void {
  if (!allowWorkspaceWrite()) throw new Error(WORKSPACE_WRITE_DISABLED);
}

interface OpenClawModel {
  primary?: unknown;
  fallbacks?: unknown;
}

interface OpenClawAgent {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  dirName?: unknown;
  workspace?: unknown;
  model?: unknown;
  identity?: { emoji?: unknown; theme?: unknown };
  tools?: { allow?: unknown };
}

interface OpenClawConfig {
  agents?: {
    defaults?: { model?: unknown; workspace?: unknown };
    list?: OpenClawAgent[];
  } | OpenClawAgent[];
}

type AgentStaticMeta = {
  name?: string;
  emoji?: string;
  role?: string;
  description?: string;
  skills?: AgentSkill[];
  cronJobs?: CronJob[];
};

const DEFAULT_ORDER = ['main', 'hermes', 'apollo', 'athena', 'metis', 'kb-manager'];

const AGENT_ID_ALIASES: Record<string, string> = {
  marketing: 'hermes',
  sales: 'apollo',
  knowledge: 'athena',
  analytics: 'metis',
  manager: 'main',
  core: 'main',
};

const DEFAULT_STATIC_META: Record<string, AgentStaticMeta> = {
  main: {
    name: 'Main',
    emoji: '🎛️',
    role: 'Orchestrator',
    description: 'Primary agent that coordinates the rest of the system.',
  },
  hermes: {
    name: 'Hermes',
    emoji: '\u{1F3DB}\u{FE0F}',
    role: 'Marketing Engine',
    description:
      'Content creation, social engagement, brand building, and experiment management.',
  },
  apollo: {
    name: 'Apollo',
    emoji: '\u{1F3AF}',
    role: 'Sales Pipeline',
    description: 'Lead discovery, scoring, sequences, and reply triage.',
  },
  athena: {
    name: 'Athena',
    emoji: '\u{1F9E0}',
    role: 'SEO & Content Optimization',
    description: 'SEO strategy, keyword research, and content optimization.',
  },
  metis: {
    name: 'Metis',
    emoji: '\u{1F4CA}',
    role: 'Analytics & Reporting',
    description: 'KPI tracking, reporting, and insight generation.',
  },
  'kb-manager': {
    name: 'KB Manager',
    emoji: '\u{1F4DA}',
    role: 'Knowledge Management',
    description: 'Collective memory steward and hygiene operator.',
  },
};

export const ACTION_TO_AGENT: Record<string, { agent: string; skill: string }> = {
  post: { agent: 'hermes', skill: 'content-engine' },
  engage: { agent: 'hermes', skill: 'social-engagement' },
  research: { agent: 'hermes', skill: 'x-research' },
  discover: { agent: 'apollo', skill: 'cold-outreach' },
  send: { agent: 'apollo', skill: 'cold-outreach' },
  triage: { agent: 'apollo', skill: 'reply-triage' },
  alert: { agent: 'hermes', skill: 'reporting' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function titleCaseFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseModelRouting(value: unknown): AgentModelConfig | null {
  if (!value) return null;
  if (typeof value === 'string') return { primary: value, fallbacks: [] };
  if (typeof value !== 'object') return null;
  const model = value as OpenClawModel;
  const primary = typeof model.primary === 'string' ? model.primary : null;
  const fallbacks = Array.isArray(model.fallbacks)
    ? model.fallbacks.filter((item): item is string => typeof item === 'string')
    : [];
  return primary ? { primary, fallbacks } : null;
}

function normalizeAgentId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return AGENT_ID_ALIASES[normalized] ?? normalized;
}

function sortAgentIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = DEFAULT_ORDER.indexOf(a);
    const ib = DEFAULT_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

function readOpenClawConfig(configPath: string): OpenClawConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as OpenClawConfig;
  } catch {
    return null;
  }
}

function configuredAgentList(config: OpenClawConfig | null): OpenClawAgent[] {
  const agents = config?.agents;
  if (Array.isArray(agents)) return agents;
  return Array.isArray(agents?.list) ? agents.list : [];
}

function discoverAgentIdsFromFs(agentsDir: string): string[] {
  try {
    if (!fs.existsSync(agentsDir)) return [];
    const out: string[] = [];
    for (const dirent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      const fullPath = path.join(agentsDir, dirent.name);
      if (dirent.isDirectory()) {
        out.push(dirent.name);
      } else if (dirent.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) out.push(dirent.name);
        } catch {
          // Ignore broken symlinks.
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function loadStaticMeta(): Record<string, AgentStaticMeta> {
  const useDefault = String(process.env.HERMES_USE_DEFAULT_AGENT_META ?? 'false')
    .trim()
    .toLowerCase() !== 'false';
  const jsonRaw = process.env.HERMES_AGENT_META_JSON?.trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as unknown;
      if (isRecord(parsed)) return parsed as Record<string, AgentStaticMeta>;
    } catch {
      // Ignore invalid optional metadata.
    }
  }
  const filePath = process.env.HERMES_AGENT_META_PATH?.trim();
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (isRecord(parsed)) return parsed as Record<string, AgentStaticMeta>;
    } catch {
      // Ignore invalid optional metadata.
    }
  }
  return useDefault ? DEFAULT_STATIC_META : {};
}

export function getOpenClawAgents(
  instance: HermesInstance,
  includeFilesystemWithConfigured = true,
): AgentDefinition[] {
  const { openclawHome, openclawConfigPath, agentsDir } = resolveOpenClawPaths(instance);
  const staticMeta = loadStaticMeta();
  const config = readOpenClawConfig(openclawConfigPath);
  const agentsConfig = !Array.isArray(config?.agents) ? config?.agents : undefined;
  const defaultsModel = parseModelRouting(agentsConfig?.defaults?.model);
  const defaultsWorkspace =
    typeof agentsConfig?.defaults?.workspace === 'string'
      ? agentsConfig.defaults.workspace.trim()
      : '';
  const configuredById = new Map<string, OpenClawAgent>();
  for (const entry of configuredAgentList(config)) {
    if (typeof entry.id !== 'string' || !entry.id.trim()) continue;
    configuredById.set(normalizeAgentId(entry.id), entry);
  }

  const ids = new Set<string>(configuredById.keys());
  if (configuredById.size === 0 || includeFilesystemWithConfigured) {
    for (const id of discoverAgentIdsFromFs(agentsDir)) ids.add(normalizeAgentId(id));
  }
  if (ids.size === 0) {
    for (const id of Object.keys(staticMeta)) ids.add(id);
  }

  return sortAgentIds([...ids]).map((id) => {
    const configured = configuredById.get(id);
    const meta = staticMeta[id] ?? {};
    const identityEmoji =
      typeof configured?.identity?.emoji === 'string' ? configured.identity.emoji : undefined;
    const identityTheme =
      typeof configured?.identity?.theme === 'string' ? configured.identity.theme : undefined;
    const modelRouting = parseModelRouting(configured?.model) ?? defaultsModel;
    const allowedTools = Array.isArray(configured?.tools?.allow)
      ? configured.tools.allow.filter((tool): tool is string => typeof tool === 'string')
      : [];
    const name =
      (typeof configured?.name === 'string' && configured.name.trim()) ||
      meta.name ||
      toTitleCase(id);
    const workspace =
      (typeof configured?.workspace === 'string' && configured.workspace.trim()) ||
      defaultsWorkspace ||
      path.join(openclawHome, `workspace-${id}`);

    return {
      id,
      name,
      emoji: meta.emoji || identityEmoji || '\u{1F916}',
      role: meta.role || (identityTheme ? toTitleCase(identityTheme) : 'Agent'),
      description: meta.description || `${name} autonomous agent.`,
      model: modelRouting?.primary || 'unknown',
      fallbacks: modelRouting?.fallbacks ?? [],
      tools: allowedTools,
      skills: meta.skills ?? [],
      cronJobs: meta.cronJobs ?? [],
      workspace,
    };
  });
}

export function getJobsPath(cronDir: string): string {
  return path.join(cronDir, 'jobs.json');
}

export function normalizeJobId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
  return id;
}

function resolveCronJobId(job: CronJobConfig): string | null {
  return normalizeJobId(job.id ?? job.jobId);
}

function normalizeCronJobRecord(job: CronJobConfig): CronJobConfig {
  const jobId = resolveCronJobId(job);
  return jobId ? { ...job, id: jobId, jobId } : job;
}

export async function readCronJobsFile(cronDir: string): Promise<CronJobsFile> {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(getJobsPath(cronDir), 'utf-8')) as unknown;
    if (Array.isArray(parsed)) {
      return { version: 1, jobs: (parsed as CronJobConfig[]).map(normalizeCronJobRecord) };
    }
    if (isRecord(parsed)) {
      const jobs = Array.isArray(parsed.jobs)
        ? (parsed.jobs as CronJobConfig[]).map(normalizeCronJobRecord)
        : [];
      const version = typeof parsed.version === 'number' ? parsed.version : 1;
      return { ...parsed, version, jobs };
    }
  } catch {
    // Missing or invalid files are represented as an empty job list.
  }
  return { version: 1, jobs: [] };
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp.${Date.now()}`);
  await fsPromises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await fsPromises.rename(tmp, filePath);
}

export async function writeCronJobsFile(cronDir: string, next: CronJobsFile): Promise<void> {
  const jobsPath = getJobsPath(cronDir);
  const nowIso = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  if (fs.existsSync(jobsPath)) {
    await fsPromises.copyFile(jobsPath, path.join(cronDir, 'jobs.json.bak')).catch(() => null);
    await fsPromises
      .copyFile(jobsPath, path.join(cronDir, `jobs.json.bak.${nowIso}`))
      .catch(() => null);
  }
  await fsPromises.mkdir(cronDir, { recursive: true });
  await writeJsonAtomic(jobsPath, next);
}

export function upsertCronJob(jobsFile: CronJobsFile, job: CronJobConfig): CronJobsFile {
  const jobId = resolveCronJobId(job);
  if (!jobId) return jobsFile;
  const normalizedJob = normalizeCronJobRecord(job);
  const now = Date.now();
  const existing = jobsFile.jobs.find((item) => resolveCronJobId(item) === jobId);
  if (existing) {
    const existingId = resolveCronJobId(existing);
    if (!existingId) return jobsFile;
    const merged = normalizeCronJobRecord({
      ...existing,
      ...normalizedJob,
      id: existingId,
      updatedAtMs: now,
    });
    return {
      ...jobsFile,
      jobs: jobsFile.jobs.map((item) =>
        resolveCronJobId(item) === existingId ? merged : item,
      ),
    };
  }
  const next = {
    ...normalizedJob,
    id: jobId,
    jobId,
    enabled: normalizedJob.enabled !== false,
    createdAtMs: typeof normalizedJob.createdAtMs === 'number' ? normalizedJob.createdAtMs : now,
    updatedAtMs: now,
  };
  return { ...jobsFile, jobs: [...jobsFile.jobs, next] };
}

export function deleteCronJob(jobsFile: CronJobsFile, id: string): CronJobsFile {
  return { ...jobsFile, jobs: jobsFile.jobs.filter((job) => resolveCronJobId(job) !== id) };
}

export function toggleCronJob(jobsFile: CronJobsFile, id: string): CronJobsFile | null {
  const found = jobsFile.jobs.find((job) => resolveCronJobId(job) === id);
  if (!found) return null;
  const next = normalizeCronJobRecord({
    ...found,
    enabled: found.enabled === false,
    updatedAtMs: Date.now(),
  });
  return {
    ...jobsFile,
    jobs: jobsFile.jobs.map((job) => (resolveCronJobId(job) === id ? next : job)),
  };
}

export function triggerCronJobNow(jobsFile: CronJobsFile, id: string): CronJobsFile | null {
  const found = jobsFile.jobs.find((job) => resolveCronJobId(job) === id);
  if (!found) return null;
  const state = isRecord(found.state) ? found.state : {};
  const next = normalizeCronJobRecord({
    ...found,
    state: { ...state, nextRunAtMs: Date.now() },
    updatedAtMs: Date.now(),
  });
  return {
    ...jobsFile,
    jobs: jobsFile.jobs.map((job) => (resolveCronJobId(job) === id ? next : job)),
  };
}

export function runLeadsAdmin(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ADMIN_CLI, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function withParsedResponse(result: CommandResult): CommandResult {
  try {
    const data = JSON.parse(result.stdout) as { response?: string; content?: string; sessionId?: string };
    return {
      ...result,
      response: data.response || data.content || result.stdout.trim(),
      sessionId: data.sessionId,
    };
  } catch {
    return { ...result, response: result.stdout.trim() };
  }
}

export async function sendAgentMessage(
  agentId: string,
  message: string,
  sessionId?: string,
): Promise<CommandResult & { response: string }> {
  const args = ['agent', '--agent', agentId, '--message', message, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  return withParsedResponse(await runLeadsAdmin(args, { timeoutMs: 120_000 })) as CommandResult & {
    response: string;
  };
}

export async function sendOrchestratorMessage(
  message: string,
  sessionId?: string,
): Promise<CommandResult & { response: string }> {
  const args = ['agent', '--message', message, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  return withParsedResponse(await runLeadsAdmin(args, { timeoutMs: 120_000 })) as CommandResult & {
    response: string;
  };
}

const DEFAULT_MEMORY_POLICY = {
  decay_half_life_days: 45,
  min_effective_confidence: 0.35,
  min_keep_confidence: 0.55,
  low_confidence_prune_days: 30,
  default_ttl_days: 90,
};

const DEFAULT_ALERT_POLICY = {
  window_days: 7,
  alert_contradictions_threshold: 1,
  alert_duplicates_threshold: 1,
  alert_weak_agents_threshold: 1,
  alert_never_ratio_threshold: 0.7,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function sanitizePolicy(kind: 'memory-policy' | 'memory-alert-policy', input: unknown): unknown {
  const body = isRecord(input) ? input : {};
  if (kind === 'memory-policy') {
    return {
      decay_half_life_days: clamp(
        Number(body.decay_half_life_days ?? DEFAULT_MEMORY_POLICY.decay_half_life_days),
        7,
        365,
      ),
      min_effective_confidence: clamp(
        Number(body.min_effective_confidence ?? DEFAULT_MEMORY_POLICY.min_effective_confidence),
        0,
        1,
      ),
      min_keep_confidence: clamp(
        Number(body.min_keep_confidence ?? DEFAULT_MEMORY_POLICY.min_keep_confidence),
        0,
        1,
      ),
      low_confidence_prune_days: clamp(
        Number(body.low_confidence_prune_days ?? DEFAULT_MEMORY_POLICY.low_confidence_prune_days),
        1,
        365,
      ),
      default_ttl_days: clamp(
        Number(body.default_ttl_days ?? DEFAULT_MEMORY_POLICY.default_ttl_days),
        7,
        365,
      ),
    };
  }
  return {
    window_days: clamp(Number(body.window_days ?? DEFAULT_ALERT_POLICY.window_days), 1, 90),
    alert_contradictions_threshold: clamp(
      Number(
        body.alert_contradictions_threshold ??
          DEFAULT_ALERT_POLICY.alert_contradictions_threshold,
      ),
      1,
      100,
    ),
    alert_duplicates_threshold: clamp(
      Number(body.alert_duplicates_threshold ?? DEFAULT_ALERT_POLICY.alert_duplicates_threshold),
      1,
      100,
    ),
    alert_weak_agents_threshold: clamp(
      Number(body.alert_weak_agents_threshold ?? DEFAULT_ALERT_POLICY.alert_weak_agents_threshold),
      1,
      100,
    ),
    alert_never_ratio_threshold: clamp(
      Number(body.alert_never_ratio_threshold ?? DEFAULT_ALERT_POLICY.alert_never_ratio_threshold),
      0,
      1,
    ),
  };
}

async function isRealDir(filePath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.lstat(filePath);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

async function isDir(filePath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

type WorkspaceAgentConfig = {
  name: string;
  dirName?: string;
  displayName?: string;
  workspace?: string;
};

function readWorkspaceAgentList(configPath: string): WorkspaceAgentConfig[] {
  const config = readOpenClawConfig(configPath);
  const out: WorkspaceAgentConfig[] = [];
  for (const item of configuredAgentList(config)) {
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    let workspace: string | undefined;
    if (typeof item.workspace === 'string' && item.workspace.trim()) {
      workspace = item.workspace.trim();
    } else if (isRecord(item.workspace)) {
      const candidate = item.workspace.directory ?? item.workspace.path ?? item.workspace.dir;
      if (typeof candidate === 'string' && candidate.trim()) workspace = candidate.trim();
    }
    out.push({
      name,
      dirName: typeof item.dirName === 'string' ? item.dirName.trim() : undefined,
      displayName: typeof item.displayName === 'string' ? item.displayName.trim() : undefined,
      workspace,
    });
  }
  return out;
}

function resolveWorkspaceToRootId(
  workspacePath: string,
  openclawHome: string,
  agentWorkspaceRoot: string,
): string | null {
  const resolved = path.resolve(workspacePath);
  if (resolved === path.resolve(agentWorkspaceRoot)) return 'agent-workspace';
  const resolvedHome = path.resolve(openclawHome);
  const rel = path.relative(resolvedHome, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.startsWith('workspace-')) {
    try {
      const realRel = path.relative(resolvedHome, fs.realpathSync(resolved));
      if (realRel.startsWith('workspace-')) return realRel;
    } catch {
      return rel;
    }
  }
  return null;
}

export class OpenClawBackend implements AgentBackend {
  readonly kind = 'openclaw' as const;
  readonly instance: HermesInstance;
  readonly paths: OpenClawPaths;

  constructor(instance: HermesInstance) {
    this.instance = instance;
    this.paths = resolveOpenClawPaths(instance);
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return getOpenClawAgents(this.instance);
  }

  async readModelRouting(): Promise<ModelRouting> {
    const config = readOpenClawConfig(this.paths.openclawConfigPath);
    const agentsConfig = !Array.isArray(config?.agents) ? config?.agents : undefined;
    const defaults = parseModelRouting(agentsConfig?.defaults?.model);
    const routing: ModelRouting = {};
    for (const agent of configuredAgentList(config)) {
      if (typeof agent.id !== 'string' || !agent.id.trim()) continue;
      const selected = parseModelRouting(agent.model) ?? defaults;
      if (selected) routing[agent.id] = selected;
    }
    return routing;
  }

  async listCronJobs(): Promise<CronJobsFile> {
    return readCronJobsFile(this.paths.cronDir);
  }

  async writeCronJobs(file: CronJobsFile): Promise<void> {
    assertCronWriteAllowed();
    await writeCronJobsFile(this.paths.cronDir, file);
  }

  async upsertCronJob(job: CronJobConfig): Promise<void> {
    assertCronWriteAllowed();
    const current = await this.listCronJobs();
    await writeCronJobsFile(this.paths.cronDir, upsertCronJob(current, job));
  }

  async toggleCronJob(id: string, enabled: boolean): Promise<void> {
    assertCronWriteAllowed();
    const current = await this.listCronJobs();
    const found = current.jobs.find((job) => resolveCronJobId(job) === id);
    if (!found) throw new Error('Not found');
    const next = upsertCronJob(current, { ...found, enabled });
    await writeCronJobsFile(this.paths.cronDir, next);
  }

  async readCronRuns(jobId: string, limit: number): Promise<CronRun[]> {
    const filePath = path.join(this.paths.cronDir, 'runs', `${jobId}.jsonl`);
    try {
      const lines = (await fsPromises.readFile(filePath, 'utf-8')).split('\n').filter(Boolean);
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as CronRun;
          } catch {
            return null;
          }
        })
        .filter((run): run is CronRun => run !== null);
    } catch {
      return [];
    }
  }

  async tailCronLog(jobId: string, bytes: number): Promise<string> {
    const filePath = path.join(this.paths.cronDir, 'logs', `${jobId}.log`);
    const stat = await fsPromises.stat(filePath).catch(() => null);
    if (!stat) return '';
    const handle = await fsPromises.open(filePath, 'r');
    try {
      const readSize = Math.min(stat.size, bytes);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
      return buffer.toString('utf-8');
    } finally {
      await handle.close();
    }
  }

  async readSessions(agentId: string): Promise<SessionFileRef[]> {
    const sessionsDir = path.join(this.paths.agentsDir, agentId, 'sessions');
    try {
      const names = (await fsPromises.readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'));
      const refs: SessionFileRef[] = [];
      for (const name of names) {
        const filePath = path.join(sessionsDir, name);
        try {
          const stat = await fsPromises.stat(filePath);
          refs.push({
            path: filePath,
            name,
            sessionId: name.replace('.jsonl', ''),
            agentId,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          // Match the current best-effort session walker.
        }
      }
      return refs;
    } catch {
      return [];
    }
  }

  async readSessionEntries(
    ref: SessionFileRef,
    fromOffset: number,
  ): Promise<{ entries: SessionEntry[]; nextOffset: number }> {
    const stat = await fsPromises.stat(ref.path);
    if (stat.size <= fromOffset) return { entries: [], nextOffset: stat.size };
    const raw = await fsPromises.readFile(ref.path, 'utf-8');
    const entries: SessionEntry[] = [];
    for (const line of raw.split('\n').filter((item) => item.trim())) {
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // Skip malformed session lines.
      }
    }
    return { entries, nextOffset: stat.size };
  }

  async readSessionUsage(agentId: string): Promise<AgentUsageTotals> {
    const totals: AgentUsageTotals = {
      tokens_today: 0,
      tokens_week: 0,
      cost_today: 0,
      cost_week: 0,
    };
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    for (const ref of await this.readSessions(agentId)) {
      let entries: SessionEntry[];
      try {
        ({ entries } = await this.readSessionEntries(ref, -1));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !entry.timestamp) {
          continue;
        }
        const timestamp = new Date(entry.timestamp).getTime();
        if (Number.isNaN(timestamp)) continue;
        const tokens = Math.max(0, Number(entry.message.usage?.totalTokens ?? 0));
        const cost = Math.max(0, Number(entry.message.usage?.cost?.total ?? 0));
        if (entry.timestamp.slice(0, 10) === today) {
          totals.tokens_today += tokens;
          totals.cost_today += cost;
        }
        if (timestamp >= weekAgo) {
          totals.tokens_week += tokens;
          totals.cost_week += cost;
        }
      }
    }
    return totals;
  }

  async sendAgentMessage(
    agentId: string,
    message: string,
    sessionId?: string,
  ): Promise<CommandResult> {
    return sendAgentMessage(agentId, message, sessionId);
  }

  async sendOrchestratorMessage(message: string): Promise<CommandResult> {
    return sendOrchestratorMessage(message);
  }

  async validateConfig(): Promise<CommandResult> {
    try {
      const result = await runLeadsAdmin(['config', 'validate', '--json'], {
        timeoutMs: 120_000,
      });
      if (!result.stdout.trim()) return { ...result, available: true, ok: true };
      try {
        const details = JSON.parse(result.stdout) as Record<string, unknown>;
        return {
          ...result,
          available: true,
          ok: typeof details.valid === 'boolean' ? details.valid : true,
          details,
        };
      } catch {
        return { ...result, available: true, ok: true, details: result.stdout.trim() };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /ENOENT|not found/i.test(message);
      return {
        stdout: '',
        stderr: '',
        code: null,
        available: !missing,
        ok: false,
        error: missing ? `${ADMIN_CLI} not found in PATH` : message,
      };
    }
  }

  async readHealthReport(kind: HealthReportKind): Promise<unknown | null> {
    const filePath = path.join(this.paths.healthDir, `${kind}.json`);
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf-8')) as unknown;
      return kind === 'memory-policy' || kind === 'memory-alert-policy'
        ? sanitizePolicy(kind, parsed)
        : parsed;
    } catch {
      if (kind === 'memory-policy') return DEFAULT_MEMORY_POLICY;
      if (kind === 'memory-alert-policy') return DEFAULT_ALERT_POLICY;
      return null;
    }
  }

  async writeHealthPolicy(
    kind: 'memory-policy' | 'memory-alert-policy',
    body: unknown,
    auditEntry: unknown,
  ): Promise<void> {
    assertPolicyWriteAllowed();
    const policy = sanitizePolicy(kind, body);
    await fsPromises.mkdir(this.paths.healthDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(this.paths.healthDir, `${kind}.json`),
      `${JSON.stringify(policy, null, 2)}\n`,
      'utf-8',
    );
    await fsPromises.mkdir(this.paths.logsDir, { recursive: true });
    await fsPromises.appendFile(
      path.join(this.paths.logsDir, `${kind}-audit.jsonl`),
      `${JSON.stringify(auditEntry)}\n`,
      'utf-8',
    );
  }

  async readAuditLog(name: string, limit: number): Promise<unknown[]> {
    const safeName = path.basename(name).replace(/\.jsonl$/, '');
    try {
      const lines = (await fsPromises.readFile(
        path.join(this.paths.logsDir, `${safeName}.jsonl`),
        'utf-8',
      )).split('\n');
      const entries: unknown[] = [];
      for (const line of lines) {
        const value = line.trim();
        if (!value) continue;
        try {
          entries.push(JSON.parse(value));
        } catch {
          // Skip malformed audit lines.
        }
      }
      return limit > 0 ? entries.slice(-limit) : entries;
    } catch {
      return [];
    }
  }

  async readDeployLogs(): Promise<string[]> {
    const logDir =
      process.env.HERMES_DEPLOY_LOG_DIR?.trim() || path.join(this.paths.logsDir, 'deploy');
    try {
      const files = (await fsPromises.readdir(logDir))
        .filter((name) => name.includes('deploy') && name.endsWith('.log'))
        .map((name) => path.join(logDir, name));
      const withStats = await Promise.all(
        files.map(async (filePath) => ({ filePath, stat: await fsPromises.stat(filePath) })),
      );
      withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      if (!withStats[0]) return [];
      const raw = await fsPromises.readFile(withStats[0].filePath, 'utf-8');
      return raw.trim().split('\n').slice(-80);
    } catch {
      return [];
    }
  }

  async listWorkspaceRoots(): Promise<Root[]> {
    const { openclawHome, openclawConfigPath } = this.paths;
    const agentWorkspaceRoot = getAgentWorkspaceRoot();
    const agentList = readWorkspaceAgentList(openclawConfigPath);
    const workspaceAgents = new Map<string, string[]>();
    for (const agent of agentList) {
      if (!agent.workspace) continue;
      const rootId = resolveWorkspaceToRootId(agent.workspace, openclawHome, agentWorkspaceRoot);
      if (!rootId) continue;
      const agents = workspaceAgents.get(rootId) ?? [];
      agents.push(agent.displayName || agent.name);
      workspaceAgents.set(rootId, agents);
    }

    const roots: Root[] = [];
    const agentWorkspaceAgents = workspaceAgents.get('agent-workspace');
    roots.push({
      id: 'agent-workspace',
      label: 'Agent Workspace',
      kind: 'agent-workspace',
      writable: true,
      ...(agentWorkspaceAgents?.length ? { agents: agentWorkspaceAgents } : {}),
    });
    roots.push({ id: 'openclaw', label: '.openclaw', kind: 'openclaw', writable: false });

    try {
      for (const name of await fsPromises.readdir(openclawHome)) {
        if (!name) continue;
        if (name === 'shared') {
          if (await isRealDir(path.join(openclawHome, name))) {
            roots.push({ id: 'shared', label: 'Shared', kind: 'workspace', writable: true });
          }
          continue;
        }
        if (!name.startsWith('workspace-')) continue;
        if (!(await isRealDir(path.join(openclawHome, name)))) continue;
        const agents = workspaceAgents.get(name);
        roots.push({
          id: name,
          label: titleCaseFromSlug(name.slice('workspace-'.length) || name),
          kind: 'workspace',
          writable: true,
          ...(agents?.length ? { agents } : {}),
        });
      }
    } catch {
      // Ignore an unavailable OpenClaw home.
    }

    for (const agent of agentList) {
      const dirSlug = agent.dirName || agent.name.toLowerCase().replace(/\s+/g, '-');
      if (!(await isDir(path.join(openclawHome, 'agents', dirSlug, 'agent')))) continue;
      roots.push({
        id: `agent:${dirSlug}`,
        label: agent.displayName || agent.name,
        kind: 'agent',
        writable: true,
      });
    }

    const order: Record<RootKind, number> = {
      'agent-workspace': 0,
      workspace: 1,
      agent: 2,
      openclaw: 3,
    };
    roots.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
    return roots;
  }

  async resolveWorkspacePath(rootIdRaw: string, relPath: string): Promise<string> {
    const rootId = rootIdRaw.trim() || 'agent-workspace';
    let root: string;
    if (rootId === 'agent-workspace') {
      root = getAgentWorkspaceRoot();
    } else {
      const openclawHome = path.resolve(this.paths.openclawHome);
      if (rootId === 'openclaw') {
        root = openclawHome;
      } else if (rootId === 'shared' || /^workspace-[a-z0-9-]+$/i.test(rootId)) {
        root = path.resolve(openclawHome, rootId);
        if (!root.startsWith(`${openclawHome}${path.sep}`)) throw new Error('Invalid root');
      } else if (rootId.startsWith('agent:')) {
        const name = rootId.slice('agent:'.length).trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error('Invalid root');
        root = path.resolve(openclawHome, 'agents', name, 'agent');
        if (!root.startsWith(`${openclawHome}${path.sep}`)) throw new Error('Invalid root');
      } else {
        throw new Error('Unknown root');
      }
    }
    const resolved = relPath ? resolveWorkspaceRelativePath(root, relPath) : root;
    if (!resolved) throw new Error('Invalid path');
    return resolved;
  }
}
