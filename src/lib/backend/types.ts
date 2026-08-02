export type BackendKind = 'openclaw' | 'hermes';

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  category: 'marketing' | 'sales' | 'research' | 'ops';
}

export interface CronJob {
  id: string;
  label: string;
  skill: string;
  schedule: string;
  cron: string;
  days?: string[];
  deliveryError?: string | null;
}

export interface AgentDefinition {
  id: string;
  name: string;
  emoji: string;
  role: string;
  description: string;
  model: string;
  fallbacks: string[];
  tools: string[];
  skills: AgentSkill[];
  cronJobs: CronJob[];
  workspace: string;
  gatewayRunning?: boolean;
  distribution?: string | null;
}

export type CronSchedule = {
  kind?: string;
  expr?: string;
  tz?: string;
  at?: string;
  everyMs?: number;
  staggerMs?: number;
};

export type CronJobConfig = {
  id?: string;
  jobId?: string;
  agentId?: string;
  name?: string;
  enabled?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule?: CronSchedule;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  skill?: string;
  deliveryError?: string | null;
  state?: Record<string, unknown>;
  [k: string]: unknown;
};

export type CronJobsFile = {
  version?: number;
  jobs: CronJobConfig[];
  [k: string]: unknown;
};

export type CronRun = {
  ts?: number | string;
  jobId?: string;
  status?: string;
  summary?: string | null;
  error?: string | null;
  durationMs?: number;
  [k: string]: unknown;
};

export type SessionContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  [k: string]: unknown;
};

export type SessionEntry = {
  type: string;
  id: string;
  parentId?: string;
  timestamp: string;
  message?: {
    role: string;
    content: SessionContentBlock[];
    timestamp?: number;
    usage?: {
      totalTokens?: number;
      cost?: { total?: number; [k: string]: unknown };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type SessionFileRef = {
  path: string;
  name: string;
  sessionId: string;
  agentId: string;
  mtimeMs: number;
  size: number;
};

export type RootKind = 'agent-workspace' | 'openclaw' | 'workspace' | 'agent';

export type Root = {
  id: string;
  label: string;
  kind: RootKind;
  writable: boolean;
  agents?: string[];
};

export type InstanceSummary = {
  id: string;
  label: string;
};

export type WorkspaceEntry = {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceRoot = Omit<Root, 'agents'> & {
  abs: string;
};

export type WorkspaceReadResult =
  | { root: WorkspaceRoot; type: 'directory'; path?: string; entries: WorkspaceEntry[] }
  | {
      root: WorkspaceRoot;
      type: 'file';
      path: string;
      size: number;
      mtimeMs: number;
      content: string;
    }
  | {
      root: WorkspaceRoot;
      type: 'error';
      error: 'Invalid path' | 'Not found' | 'Unsupported file type' | 'File too large';
    };

export type WorkspaceMutationResult =
  | { ok: true }
  | { ok: false; error: 'Root is read-only' | 'Invalid path' | 'Not found' | 'File too large' };

export type DeployStatus = {
  serviceName: string;
  serviceState: string;
  scriptPath: string;
  lockFile: string;
  lockExists: boolean;
  runningPids: string[];
  openclawBin: string;
  configValidation: {
    available: boolean;
    ok: boolean;
    details?: unknown;
    error?: string;
  };
  latestLog: { path: string; mtime: string; tail: string[] } | null;
};

export type AgentUsageTotals = {
  tokens_today: number;
  tokens_week: number;
  cost_today: number;
  cost_week: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number | null;
  cost_status?: string | null;
  cost_source?: string | null;
};

export type AgentModelConfig = {
  primary: string;
  fallbacks: string[];
};

export type ModelRouting = Record<string, AgentModelConfig>;

export type HermesModelRef = {
  provider: string | null;
  model: string;
};

export type HermesModelRouting = {
  default: HermesModelRef;
  fallbacks: HermesModelRef[];
  moa?: {
    enabled: boolean;
    referenceModels: HermesModelRef[];
    aggregator: HermesModelRef;
  };
  cronOverrides: Array<HermesModelRef & { jobId: string }>;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  response?: string;
  sessionId?: string;
  available?: boolean;
  ok?: boolean;
  details?: unknown;
  error?: string;
};

export type HealthReportKind =
  | 'memory-health'
  | 'memory-drift-weekly'
  | 'memory-alerts'
  | 'memory-policy'
  | 'memory-alert-policy'
  | 'gateway';

export interface AgentBackend {
  kind: BackendKind;
  readonly instanceId: string;
  cronWritesAllowed(): boolean;
  policyWritesAllowed(): boolean;
  workspaceWritesAllowed(): boolean;
  listInstances(): Promise<{ defaultInstance: string; instances: InstanceSummary[] }>;
  listActionMappings(): Promise<Record<string, { agent: string; skill: string }>>;
  listAgents(): Promise<AgentDefinition[]>;
  listConfiguredAgents(): Promise<AgentDefinition[]>;
  readModelRouting(): Promise<ModelRouting>;
  listCronJobs(): Promise<CronJobsFile>;
  readCronJobsTolerant(): Promise<unknown[]>;
  readRawCronJobs(): Promise<CronJobConfig[]>;
  readCronNotificationJobs(): Promise<CronJobConfig[] | null>;
  writeCronJobs(file: CronJobsFile): Promise<void>;
  upsertCronJob(job: CronJobConfig): Promise<void>;
  toggleCronJob(id: string, enabled: boolean): Promise<void>;
  readCronRuns(jobId: string, limit: number): Promise<CronRun[]>;
  readCronRunsInfo(jobId: string, limit: number): Promise<{ exists: boolean; runs: CronRun[] }>;
  tailCronLog(jobId: string, bytes: number): Promise<string>;
  readCronLogInfo(
    jobId: string,
    bytes: number,
  ): Promise<{ content: string; modifiedAt: string } | null>;
  readSessions(agentId: string): Promise<SessionFileRef[]>;
  readSessionEntries(
    ref: SessionFileRef,
    fromOffset: number,
  ): Promise<{ entries: SessionEntry[]; nextOffset: number }>;
  readSessionUsage(agentId: string): Promise<AgentUsageTotals>;
  /** CommandResult supersets the former { response, sessionId? } shape, so existing destructuring is unaffected. */
  sendAgentMessage(agentId: string, message: string, sessionId?: string): Promise<CommandResult>;
  sendOrchestratorMessage(message: string, sessionId?: string): Promise<CommandResult>;
  validateConfig(): Promise<CommandResult>;
  readHealthReport(kind: HealthReportKind): Promise<unknown | null>;
  readRequiredHealthReport(kind: HealthReportKind): Promise<unknown | null>;
  readSendingPauseState(): Promise<{ paused: boolean; reason: string | null }>;
  writeHealthPolicy(
    kind: 'memory-policy' | 'memory-alert-policy',
    body: unknown,
    auditEntry: unknown,
  ): Promise<void>;
  readAuditLog(name: string, limit: number): Promise<unknown[]>;
  readDeployLogs(): Promise<string[]>;
  readDeployStatus(): Promise<DeployStatus>;
  listWorkspaceRoots(): Promise<Root[]>;
  resolveWorkspacePath(rootId: string, relPath: string): Promise<string>;
  readWorkspace(rootId: string, relPath: string): Promise<WorkspaceReadResult>;
  createWorkspaceFile(
    rootId: string,
    relPath: string,
    content: string,
  ): Promise<WorkspaceMutationResult>;
  updateWorkspaceFile(
    rootId: string,
    relPath: string,
    content: string,
  ): Promise<WorkspaceMutationResult>;
  deleteWorkspaceFile(rootId: string, relPath: string): Promise<WorkspaceMutationResult>;
}
