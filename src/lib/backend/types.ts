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

export type AgentUsageTotals = {
  tokens_today: number;
  tokens_week: number;
  cost_today: number;
  cost_week: number;
};

export type AgentModelConfig = {
  primary: string;
  fallbacks: string[];
};

export type ModelRouting = Record<string, AgentModelConfig>;

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
  | 'memory-alert-policy';

export interface AgentBackend {
  kind: BackendKind;
  listAgents(): Promise<AgentDefinition[]>;
  readModelRouting(): Promise<ModelRouting>;
  listCronJobs(): Promise<CronJobsFile>;
  writeCronJobs(file: CronJobsFile): Promise<void>;
  upsertCronJob(job: CronJobConfig): Promise<void>;
  toggleCronJob(id: string, enabled: boolean): Promise<void>;
  readCronRuns(jobId: string, limit: number): Promise<CronRun[]>;
  tailCronLog(jobId: string, bytes: number): Promise<string>;
  readSessions(agentId: string): Promise<SessionFileRef[]>;
  readSessionEntries(
    ref: SessionFileRef,
    fromOffset: number,
  ): Promise<{ entries: SessionEntry[]; nextOffset: number }>;
  readSessionUsage(agentId: string): Promise<AgentUsageTotals>;
  sendAgentMessage(agentId: string, message: string, sessionId?: string): Promise<CommandResult>;
  sendOrchestratorMessage(message: string): Promise<CommandResult>;
  validateConfig(): Promise<CommandResult>;
  readHealthReport(kind: HealthReportKind): Promise<unknown | null>;
  writeHealthPolicy(
    kind: 'memory-policy' | 'memory-alert-policy',
    body: unknown,
    auditEntry: unknown,
  ): Promise<void>;
  readAuditLog(name: string, limit: number): Promise<unknown[]>;
  readDeployLogs(): Promise<string[]>;
  listWorkspaceRoots(): Promise<Root[]>;
  resolveWorkspacePath(rootId: string, relPath: string): Promise<string>;
}
