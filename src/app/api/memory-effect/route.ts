import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

type DriftRow = {
  timestamp: string;
  namespace?: string;
  contradictions: number;
  duplicates: number;
  weak_agents: number;
  hot_memory: number;
  cold_memory: number;
  never_accessed: number;
  collective_total: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type AuditRow = { timestamp: string } & Record<string, unknown>;
function isAuditRow(value: unknown): value is AuditRow {
  return isRecord(value) && typeof value.timestamp === 'string';
}

function tsMs(ts: string | undefined): number {
  if (!ts) return Number.NaN;
  return Date.parse(ts);
}

function metricDelta(before: number, after: number): { before: number; after: number; delta: number } {
  return { before, after, delta: after - before };
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
    const history = await backend.readAuditLog('memory-drift-history', 0) as DriftRow[];
    const policyAudit = await backend.readAuditLog('memory-policy-audit', 0);
    const alertPolicyAudit = await backend.readAuditLog('memory-alert-policy-audit', 0);
    const changes = [...policyAudit, ...alertPolicyAudit]
      .filter(isAuditRow)
      .sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

    if (history.length < 2 || changes.length === 0) {
      return NextResponse.json({
        instance: backend.instanceId,
        namespace: backend.instanceId, // back-compat for older UI
        available: false,
        reason: 'insufficient_history_or_policy_changes',
        history_points: history.length,
        policy_changes: changes.length,
      });
    }

    const sortedHistory = [...history].sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
    const latestChange = changes[0];
    const changeMs = tsMs(latestChange.timestamp);
    const before =
      [...sortedHistory].reverse().find((h) => tsMs(h.timestamp) <= changeMs) ??
      sortedHistory[sortedHistory.length - 2];
    const after = sortedHistory[sortedHistory.length - 1];

    const beforeTotal = Math.max(1, Number(before.collective_total || 0));
    const afterTotal = Math.max(1, Number(after.collective_total || 0));
    const beforeNeverRatio = Number(before.never_accessed || 0) / beforeTotal;
    const afterNeverRatio = Number(after.never_accessed || 0) / afterTotal;

    return NextResponse.json({
      instance: backend.instanceId,
      namespace: backend.instanceId,
      available: true,
      latest_policy_change: latestChange.timestamp,
      baseline_at: before.timestamp,
      current_at: after.timestamp,
      deltas: {
        contradictions: metricDelta(Number(before.contradictions || 0), Number(after.contradictions || 0)),
        duplicates: metricDelta(Number(before.duplicates || 0), Number(after.duplicates || 0)),
        weak_agents: metricDelta(Number(before.weak_agents || 0), Number(after.weak_agents || 0)),
        hot_memory: metricDelta(Number(before.hot_memory || 0), Number(after.hot_memory || 0)),
        never_accessed_ratio: {
          before: beforeNeverRatio,
          after: afterNeverRatio,
          delta: afterNeverRatio - beforeNeverRatio,
        },
      },
    });
  } catch (error) {
    console.error('GET /api/memory-effect error:', error);
    return NextResponse.json({ error: 'Failed to read memory policy effect' }, { status: 500 });
  }
}
