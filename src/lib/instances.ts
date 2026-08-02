import os from 'node:os';
import path from 'node:path';
import fs, { accessSync, constants, lstatSync, statSync } from 'node:fs';

import type { BackendKind } from './backend/types';

export type HermesInstance = {
  id: string;
  label: string;
  openclawHome: string;
  homeDir?: string;
  profile?: string;
  hermesBin?: string;
  cronUser?: string;
  kind?: BackendKind;
};

const DEFAULT_TENANTS_SCAN_TTL_MS = 30_000;
const TENANT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

type TenantScanCacheEntry = {
  scannedAt: number;
  instances: HermesInstance[];
};

const tenantScanCache = new Map<string, TenantScanCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function normalizeLabel(raw: unknown, fallback: string): string {
  const v = String(raw ?? '').trim();
  return v ? v : fallback;
}

function normalizeHome(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  return path.resolve(expandHome(v));
}

function normalizeOptionalString(raw: unknown): string | undefined {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v || undefined;
}

function parseInstancesFromEnv(): HermesInstance[] | null {
  const raw = process.env.HERMES_OPENCLAW_INSTANCES?.trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    const out: HermesInstance[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const id = normalizeId(item.id);
      const kind: BackendKind = item.kind === 'hermes' ? 'hermes' : 'openclaw';
      const openclawHome = normalizeHome(item.openclawHome);
      const homeDir = normalizeHome(item.homeDir);
      if (!id || (!openclawHome && !(kind === 'hermes' && homeDir))) continue;
      out.push({
        id,
        label: normalizeLabel(item.label, id),
        openclawHome,
        homeDir: homeDir || undefined,
        profile: normalizeOptionalString(item.profile),
        hermesBin: normalizeOptionalString(item.hermesBin),
        kind,
        cronUser:
          typeof item.cronUser === 'string' && item.cronUser.trim()
            ? item.cronUser.trim()
            : undefined,
      });
    }

    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function getTenantsScanTtlMs(): number {
  const raw = process.env.HERMES_TENANTS_SCAN_TTL_MS?.trim();
  if (!raw) return DEFAULT_TENANTS_SCAN_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TENANTS_SCAN_TTL_MS;
}

function scanTenantInstances(root: string): HermesInstance[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }

  const instances: HermesInstance[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !TENANT_NAME_PATTERN.test(name)) continue;

    const homeDir = path.join(root, name);
    try {
      if (lstatSync(homeDir).isSymbolicLink()) continue;
      if (!statSync(homeDir).isDirectory()) continue;

      const configPath = path.join(homeDir, 'config.yaml');
      if (!statSync(configPath).isFile()) continue;
      accessSync(configPath, constants.R_OK);
    } catch {
      continue;
    }

    instances.push({
      id: `stagesnap:${name}`,
      label: name,
      openclawHome: '',
      homeDir,
      kind: 'hermes',
    });
  }
  return instances;
}

function getDiscoveredTenantInstances(): HermesInstance[] {
  const configuredRoot = process.env.HERMES_TENANTS_ROOT?.trim();
  if (!configuredRoot) return [];

  const root = path.resolve(expandHome(configuredRoot));
  const now = Date.now();
  const cached = tenantScanCache.get(root);
  if (cached && now - cached.scannedAt < getTenantsScanTtlMs()) {
    return cached.instances;
  }

  const instances = scanTenantInstances(root);
  tenantScanCache.set(root, { scannedAt: now, instances });
  return instances;
}

export function getDefaultInstanceId(): string {
  const v = process.env.HERMES_DEFAULT_INSTANCE?.trim();
  return v ? v : 'default';
}

export function getInstances(): HermesInstance[] {
  const fromEnv = parseInstancesFromEnv();
  const configured = fromEnv ?? (() => {
    const defaultId = getDefaultInstanceId();
    const home =
      process.env.HERMES_OPENCLAW_HOME?.trim() ||
      process.env.OPENCLAW_HOME?.trim() ||
      path.join(os.homedir(), '.openclaw');

    return [
      {
        id: defaultId,
        label: 'Default',
        openclawHome: path.resolve(expandHome(home)),
        kind: 'openclaw' as const,
        cronUser: process.env.HERMES_CRON_USER?.trim() || undefined,
      },
    ];
  })();

  const discovered = getDiscoveredTenantInstances();
  const configuredIds = new Set(configured.map((instance) => instance.id));
  const warnedIds = new Set<string>();
  for (const instance of discovered) {
    if (configuredIds.has(instance.id) && !warnedIds.has(instance.id)) {
      console.warn(`Tenant instance id collision: ${instance.id}`);
      warnedIds.add(instance.id);
    }
  }

  return [
    ...discovered.filter((instance) => !configuredIds.has(instance.id)),
    ...configured,
  ];
}

export function getInstance(id?: string | null): HermesInstance {
  const instances = getInstances();
  const wanted = (id ?? '').trim();

  if (wanted) {
    const match = instances.find((it) => it.id === wanted);
    if (match) return match;

    // Back-compat: older UI used namespace=leads|openclaw.
    // If not configured, fall back to default instance.
    if (wanted === 'leads' || wanted === 'openclaw') {
      return getInstance(getDefaultInstanceId());
    }
  }

  return (
    instances[0] ?? {
      id: getDefaultInstanceId(),
      label: 'Default',
      openclawHome: path.join(os.homedir(), '.openclaw'),
      kind: 'openclaw',
    }
  );
}

/** Strict tenant lookup: exact configured id only, with no legacy/default fallback. */
export function getTenantInstance(id: string): HermesInstance | null {
  const instance = getInstances().find((candidate) => candidate.id === id);
  if (!instance?.homeDir || instance.kind !== 'hermes') return null;
  try {
    if (lstatSync(instance.homeDir).isSymbolicLink()) return null;
    if (!statSync(instance.homeDir).isDirectory()) return null;
    return instance;
  } catch {
    return null;
  }
}

/** @deprecated Import these OpenClaw-specific helpers from backend/openclaw. */
export {
  allowCronWrite,
  allowPolicyWrite,
  allowWorkspaceWrite,
  resolveOpenClawPaths,
} from './backend/openclaw';
