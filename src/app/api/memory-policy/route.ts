import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { requireUser } from '@/lib/auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

interface MemoryPolicy {
  decay_half_life_days: number;
  min_effective_confidence: number;
  min_keep_confidence: number;
  low_confidence_prune_days: number;
  default_ttl_days: number;
}

const DEFAULT_POLICY: MemoryPolicy = {
  decay_half_life_days: 45,
  min_effective_confidence: 0.35,
  min_keep_confidence: 0.55,
  low_confidence_prune_days: 30,
  default_ttl_days: 90,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sanitize(input: Partial<MemoryPolicy>): MemoryPolicy {
  return {
    decay_half_life_days: clamp(
      Number(input.decay_half_life_days ?? DEFAULT_POLICY.decay_half_life_days),
      7,
      365,
    ),
    min_effective_confidence: clamp(
      Number(input.min_effective_confidence ?? DEFAULT_POLICY.min_effective_confidence),
      0,
      1,
    ),
    min_keep_confidence: clamp(
      Number(input.min_keep_confidence ?? DEFAULT_POLICY.min_keep_confidence),
      0,
      1,
    ),
    low_confidence_prune_days: clamp(
      Number(input.low_confidence_prune_days ?? DEFAULT_POLICY.low_confidence_prune_days),
      1,
      365,
    ),
    default_ttl_days: clamp(
      Number(input.default_ttl_days ?? DEFAULT_POLICY.default_ttl_days),
      7,
      365,
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
    const policy = await backend.readHealthReport('memory-policy');
    return NextResponse.json({ instance: backend.instanceId, policy });
  } catch (error) {
    console.error('GET /api/memory-policy error:', error);
    return NextResponse.json({ error: 'Failed to read memory policy' }, { status: 500 });
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
    const body = (await request.json()) as Partial<MemoryPolicy> & { instance?: string; namespace?: string };
    const instanceId = body.instance ?? body.namespace ?? getInstanceId(request) ?? undefined;
    const backend = resolveBackend(instanceId);
    const before = await backend.readHealthReport('memory-policy');
    const policy = sanitize(body);
    await backend.writeHealthPolicy('memory-policy', policy, {
      timestamp: new Date().toISOString(),
      actor: actor.username,
      actor_role: actor.role,
      instance: backend.instanceId,
      before,
      after: policy,
    });
    return NextResponse.json({ ok: true, instance: backend.instanceId, policy });
  } catch (error) {
    console.error('POST /api/memory-policy error:', error);
    return NextResponse.json({ error: 'Failed to update memory policy' }, { status: 500 });
  }
}
