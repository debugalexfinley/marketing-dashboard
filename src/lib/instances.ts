import os from 'node:os';
import path from 'node:path';
import { lstatSync, statSync } from 'node:fs';

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

export function getDefaultInstanceId(): string {
  const v = process.env.HERMES_DEFAULT_INSTANCE?.trim();
  return v ? v : 'default';
}

export function getInstances(): HermesInstance[] {
  const fromEnv = parseInstancesFromEnv();
  if (fromEnv) return fromEnv;

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
      kind: 'openclaw',
      cronUser: process.env.HERMES_CRON_USER?.trim() || undefined,
    },
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
