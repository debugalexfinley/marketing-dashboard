import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { requireUser } from '@/lib/auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

interface AlertPolicy {
  window_days: number;
  alert_contradictions_threshold: number;
  alert_duplicates_threshold: number;
  alert_weak_agents_threshold: number;
  alert_never_ratio_threshold: number;
}

const DEFAULT_POLICY: AlertPolicy = {
  window_days: 7,
  alert_contradictions_threshold: 1,
  alert_duplicates_threshold: 1,
  alert_weak_agents_threshold: 1,
  alert_never_ratio_threshold: 0.7,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sanitize(input: Partial<AlertPolicy>): AlertPolicy {
  return {
    window_days: clamp(Number(input.window_days ?? DEFAULT_POLICY.window_days), 1, 90),
    alert_contradictions_threshold: clamp(
      Number(input.alert_contradictions_threshold ?? DEFAULT_POLICY.alert_contradictions_threshold),
      1,
      100,
    ),
    alert_duplicates_threshold: clamp(
      Number(input.alert_duplicates_threshold ?? DEFAULT_POLICY.alert_duplicates_threshold),
      1,
      100,
    ),
    alert_weak_agents_threshold: clamp(
      Number(input.alert_weak_agents_threshold ?? DEFAULT_POLICY.alert_weak_agents_threshold),
      1,
      100,
    ),
    alert_never_ratio_threshold: clamp(
      Number(input.alert_never_ratio_threshold ?? DEFAULT_POLICY.alert_never_ratio_threshold),
      0,
      1,
    ),
  };
}

function getInstanceId(request: Request): string | null {
  try {
    const url = new URL(request.url);
    return url.searchParams.get('instance') || url.searchParams.get('namespace');
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = requireApiUser(request);
  if (auth) return auth;
  try {
    const backend = resolveBackend(getInstanceId(request) ?? undefined);
    return NextResponse.json({
      instance: backend.instanceId,
      policy: await backend.readHealthReport('memory-alert-policy'),
    });
  } catch (error) {
    console.error('GET /api/memory-alert-policy error:', error);
    return NextResponse.json({ error: 'Failed to read memory alert policy' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = requireApiUser(request);
  if (auth) return auth;
  const requestedBackend = resolveBackend(getInstanceId(request) ?? undefined);
  if (!requestedBackend.policyWritesAllowed()) {
    return NextResponse.json(
      { error: 'Policy write disabled (set HERMES_ALLOW_POLICY_WRITE=true to enable)' },
      { status: 403 },
    );
  }

  try {
    const actor = requireUser(request);
    const body = (await request.json()) as Partial<AlertPolicy> & { instance?: string; namespace?: string };
    const instanceId = body.instance ?? body.namespace ?? getInstanceId(request) ?? undefined;
    const backend = resolveBackend(instanceId);
    const before = await backend.readHealthReport('memory-alert-policy');
    const policy = sanitize(body);
    await backend.writeHealthPolicy('memory-alert-policy', policy, {
      timestamp: new Date().toISOString(),
      actor: actor.username,
      actor_role: actor.role,
      instance: backend.instanceId,
      before,
      after: policy,
    });
    return NextResponse.json({ ok: true, instance: backend.instanceId, policy });
  } catch (error) {
    console.error('POST /api/memory-alert-policy error:', error);
    return NextResponse.json({ error: 'Failed to update memory alert policy' }, { status: 500 });
  }
}
