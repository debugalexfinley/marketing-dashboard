import { getInstance } from '../instances';
import { HermesAgentBackend } from './hermesAgent';
import { OpenClawBackend } from './openclaw';
import type { AgentBackend } from './types';

const backends = new Map<string, AgentBackend>();

export function resolveBackend(instanceId?: string): AgentBackend {
  const instance = getInstance(instanceId);
  const kind = instance.kind ?? 'openclaw';
  const cacheKey = `${instance.id}:${kind}:${
    kind === 'hermes' ? instance.homeDir : instance.openclawHome
  }`;
  const cached = backends.get(cacheKey);
  if (cached) return cached;

  const backend = kind === 'hermes'
    ? new HermesAgentBackend(instance)
    : new OpenClawBackend(instance);
  backends.set(cacheKey, backend);
  return backend;
}

export type {
  AgentBackend,
  AgentDefinition,
  AgentSkill,
  BackendKind,
  CronJobConfig,
  CronJobsFile,
} from './types';
