import { getInstance } from '../instances';
import { OpenClawBackend } from './openclaw';
import type { AgentBackend } from './types';

const backends = new Map<string, AgentBackend>();

export function resolveBackend(instanceId?: string): AgentBackend {
  const instance = getInstance(instanceId);
  const kind = instance.kind ?? 'openclaw';
  if (kind === 'hermes') throw new Error('hermes backend: phase 2');

  const cacheKey = `${instance.id}:${instance.openclawHome}`;
  const cached = backends.get(cacheKey);
  if (cached) return cached;

  const backend = new OpenClawBackend(instance);
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
