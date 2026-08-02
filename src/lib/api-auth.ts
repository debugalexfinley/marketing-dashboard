import os from 'node:os';
import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/auth';
import { getInstances } from '@/lib/instances';
import { roleHasCapability, type Capability } from '@/lib/rbac';

export function requireApiUser(request: Request): NextResponse | null {
  try {
    const user = requireUser(request);
    if (user.role === 'tenant') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    return null;
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
}

export function requireApiTenant(request: Request): NextResponse | null {
  try {
    const user = requireUser(request);
    if (user.role === 'tenant') return null;
  } catch {
    // Tenant routes fail closed with the same response as other non-tenant callers.
  }
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

const TENANT_BLOCKED_KEYS = new Set([
  'system_prompt',
  'origin_json',
  'workspace',
  'workdir',
  'cwd',
  'git_repo_root',
  'path',
  'homeDir',
  'openclawHome',
]);

function normalizeTenantKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

const NORMALIZED_TENANT_BLOCKED_KEYS = new Set(
  [...TENANT_BLOCKED_KEYS].map(normalizeTenantKey),
);

const TENANT_URL_PATTERN = /(https?:\/\/\S+)/g;
const ABSOLUTE_POSIX_PATH_PATTERN = /\/[^/\s"'<>]+\/[^/\s"'<>]+(?:\/[^/\s"'<>]+)*/g;

function redactTenantPaths(value: string): string {
  const sensitivePaths = [
    ...getInstances().flatMap((instance) => instance.homeDir ? [instance.homeDir] : []),
    os.homedir(),
  ]
    .filter((candidate, index, paths) => candidate.length > 0 && paths.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  return value.split(TENANT_URL_PATTERN).map((span, index) => {
    if (index % 2 === 1) return span;
    const exactRedacted = sensitivePaths.reduce(
      (redacted, sensitivePath) => redacted.split(sensitivePath).join('[path]'),
      span,
    );
    return exactRedacted.replace(ABSOLUTE_POSIX_PATH_PATTERN, '[path]');
  }).join('');
}

export function sanitizeForTenant(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForTenant);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !NORMALIZED_TENANT_BLOCKED_KEYS.has(normalizeTenantKey(key)))
        .map(([key, child]) => [key, sanitizeForTenant(child)]),
    );
  }
  if (typeof value === 'string') return redactTenantPaths(value);
  return value;
}

export function tenantInternalErrorResponse(error: unknown): NextResponse {
  console.error('tenant route error', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

export function requireApiAdmin(request: Request): NextResponse | null {
  try {
    requireAdmin(request);
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'unauthorized') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (msg === 'forbidden') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
}

export function requireApiEditor(request: Request): NextResponse | null {
  try {
    const user = requireUser(request);
    if (user.role === 'admin' || user.role === 'editor') {
      return null;
    }
    return NextResponse.json({ error: 'Editor access required' }, { status: 403 });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'unauthorized') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
}

export function requireApiCapability(request: Request, capability: Capability): NextResponse | null {
  try {
    const user = requireUser(request);
    if (!roleHasCapability(user.role as 'admin' | 'editor' | 'viewer', capability)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'unauthorized') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
}
