import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

    const db = getDb();

    const pauseState = await backend.readSendingPauseState();
    const sending_paused = pauseState.paused;
    const paused_reason = pauseState.reason;

    const content_pending = db
      .prepare("SELECT COUNT(*) as c FROM content_posts WHERE status = 'pending_approval'")
      .get() as { c: number };

    const seq_pending = db
      .prepare("SELECT COUNT(*) as c FROM sequences WHERE status = 'pending_approval'")
      .get() as { c: number };

    const stale_content = db
      .prepare(
        "SELECT COUNT(*) as c FROM content_posts WHERE status = 'pending_approval' AND created_at < datetime('now', '-24 hours')",
      )
      .get() as { c: number };

    const stale_sequences = db
      .prepare(
        "SELECT COUNT(*) as c FROM sequences WHERE status = 'pending_approval' AND created_at < datetime('now', '-24 hours')",
      )
      .get() as { c: number };

    let cron_total = 0;
    let cron_errors = 0;
    try {
      const jobs = await backend.readCronJobsTolerant();
      cron_total = jobs.length;
      cron_errors = jobs.filter((j) => {
        if (!isRecord(j)) return false;
        const enabled = j.enabled;
        if (enabled === false) return false;
        const state = j.state;
        if (!isRecord(state)) return false;
        const lastStatus = state.lastStatus;
        return typeof lastStatus === 'string' && lastStatus !== 'ok';
      }).length;
    } catch {
      // ignore
    }

    return NextResponse.json({
      instance: backend.instanceId,
      sending_paused,
      paused_reason,
      approvals_pending: (content_pending?.c ?? 0) + (seq_pending?.c ?? 0),
      approvals_stale: (stale_content?.c ?? 0) + (stale_sequences?.c ?? 0),
      cron_total,
      cron_errors,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
