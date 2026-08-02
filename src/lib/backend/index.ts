import { getInstance, getTenantInstance, type HermesInstance } from '../instances';
import { requireApiTenant } from '../api-auth';
import { requireUser } from '../auth';
import { HermesAgentBackend } from './hermesAgent';
import { OpenClawBackend } from './openclaw';
import type { AgentBackend } from './types';

const backends = new Map<string, AgentBackend>();

function backendForInstance(instance: HermesInstance): AgentBackend {
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

export function resolveBackend(instanceId?: string): AgentBackend {
  const instance = getInstance(instanceId);
  return backendForInstance(instance);
}

export type TenantAccessErrorCode =
  | 'forbidden'
  | 'tenant_instance_mismatch'
  | 'tenant_not_provisioned';

export class TenantAccessError extends Error {
  readonly status = 403;

  constructor(readonly code: TenantAccessErrorCode) {
    super(code);
    this.name = 'TenantAccessError';
  }
}

export function resolveTenantBackend(request: Request): {
  backend: AgentBackend;
  instanceId: string;
} {
  const denied = requireApiTenant(request);
  if (denied) throw new TenantAccessError('forbidden');

  const user = requireUser(request);
  const instanceId = user.tenant_instance_id;
  if (!instanceId) throw new TenantAccessError('tenant_not_provisioned');

  const url = new URL(request.url);
  for (const parameter of ['instance', 'namespace']) {
    const supplied = url.searchParams.get(parameter);
    if (supplied !== null && supplied !== instanceId) {
      throw new TenantAccessError('tenant_instance_mismatch');
    }
  }

  const instance = getTenantInstance(instanceId);
  if (!instance) throw new TenantAccessError('tenant_not_provisioned');
  return { backend: backendForInstance(instance), instanceId };
}

export type {
  AgentBackend,
  AgentDefinition,
  AgentSkill,
  BackendKind,
  CronJobConfig,
  CronJobsFile,
} from './types';
