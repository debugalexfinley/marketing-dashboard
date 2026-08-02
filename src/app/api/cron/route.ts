import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireApiEditor, requireApiUser } from '@/lib/api-auth';
import { requireUser } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { resolveBackend, type CronJobConfig, type CronJobsFile } from '@/lib/backend';

export const dynamic = 'force-dynamic';

function getInstanceId(request: Request): string | null {
  try {
    const url = new URL(request.url);
    return url.searchParams.get('instance') || url.searchParams.get('namespace');
  } catch {
    return null;
  }
}

function normalizeJobId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
  return id;
}

function resolveCronJobId(job: CronJobConfig): string | null {
  return normalizeJobId(job.id ?? job.jobId);
}

function updateCronJob(
  jobsFile: CronJobsFile,
  id: string,
  action: 'toggle' | 'trigger',
): CronJobsFile | null {
  const found = jobsFile.jobs.find((job) => resolveCronJobId(job) === id);
  if (!found) return null;
  const now = Date.now();
  const next = action === 'toggle'
    ? { ...found, id, jobId: id, enabled: found.enabled === false, updatedAtMs: now }
    : {
        ...found,
        id,
        jobId: id,
        state: { ...(typeof found.state === 'object' && found.state ? found.state : {}), nextRunAtMs: now },
        updatedAtMs: now,
      };
  return {
    ...jobsFile,
    jobs: jobsFile.jobs.map((job) => (resolveCronJobId(job) === id ? next : job)),
  };
}

/**
 * POST /api/cron — Check for completed cron jobs and create notifications
 */
export async function POST(request: Request) {
  const auth = requireApiUser(request);
  if (auth) return auth;
  try {
    const backend = resolveBackend(getInstanceId(request) ?? undefined);

    const db = getDb();
    const jobs = await backend.readCronNotificationJobs();
    if (jobs === null) {
      return NextResponse.json({ notified: 0 });
    }
    let notified = 0;

    for (const job of jobs) {
      if (!job.state?.lastRunAtMs) continue;
      const jobId = normalizeJobId(job.id ?? job.jobId);
      if (!jobId) continue;

      // Check if we already notified for this run
      const key = `cron:${backend.instanceId}:${jobId}:${job.state.lastRunAtMs}`;
      const existing = db
        .prepare('SELECT 1 FROM notifications WHERE data LIKE ? LIMIT 1')
        .get(`%${key}%`);

      if (!existing) {
        const status = job.state.lastStatus === 'ok' ? 'info' : 'warning';
        const duration = job.state.lastDurationMs
          ? `${Math.round((job.state.lastDurationMs as number) / 1000)}s`
          : '';
        const agentLabel = (job.agentId || 'unknown').charAt(0).toUpperCase() + (job.agentId || 'unknown').slice(1);

        db.prepare(`
          INSERT INTO notifications (type, severity, title, message, data)
          VALUES ('cron', ?, ?, ?, ?)
        `).run(
          status,
          `${agentLabel}: ${job.name} completed`,
          `${job.skill || jobId} finished in ${duration}. Status: ${job.state.lastStatus || 'unknown'}`,
          JSON.stringify({ key, job_id: jobId, agent_id: job.agentId, duration_ms: job.state.lastDurationMs }),
        );
        notified++;
      }
    }

    return NextResponse.json({ notified });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const auth = requireApiUser(request);
  if (auth) return auth;
  try {
    const actor = requireUser(request);
    const backend = resolveBackend(getInstanceId(request) ?? undefined);

    // Read cron jobs config
    const jobsFile = await backend.listCronJobs();
    const jobs = jobsFile.jobs as CronJobConfig[];

    // Read recent logs for each job
    const enriched = await Promise.all(
      jobs.map(async (job) => {
        try {
          const jobId = normalizeJobId(job.id ?? job.jobId);
          if (!jobId) return { ...job, lastRun: null, lastResult: null };
          const log = await backend.readCronLogInfo(jobId, 2048);
          if (!log) return { ...job, lastRun: null, lastResult: null };
          const lastLines = log.content.trim().split('\n').slice(-5);
          return {
            ...job,
            lastRun: log.modifiedAt,
            lastResult: lastLines.join('\n'),
          };
        } catch {
          return { ...job, lastRun: null, lastResult: null };
        }
      }),
    );

    const isEditor = actor.role === 'admin' || actor.role === 'editor';
    const canWrite = backend.cronWritesAllowed() && isEditor;
    return NextResponse.json({ instance: backend.instanceId, jobs: enriched, can_write: canWrite, can_templates_write: isEditor });
  } catch (error) {
    console.error('GET /api/cron error:', error);
    return NextResponse.json({ error: 'Failed to read cron status' }, { status: 500 });
  }
}

/**
 * PUT /api/cron — Toggle or trigger an existing cron job.
 * Body: { id: string, action: "toggle" | "trigger" }
 */
export async function PUT(request: Request) {
  const auth = requireApiEditor(request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceId(request) ?? undefined);
  if (!backend.cronWritesAllowed()) {
    return NextResponse.json({ error: 'Cron writes are disabled (set HERMES_ALLOW_CRON_WRITE=true)' }, { status: 403 });
  }

  const actor = requireUser(request);
  const body = await request.json().catch(() => ({}));
  const id = normalizeJobId(body?.id ?? body?.jobId);
  const action = body?.action === 'toggle' || body?.action === 'trigger' ? body.action : null;

  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  if (!action) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  try {
    const jobsFile = await backend.listCronJobs();
    const next = updateCronJob(jobsFile, id, action);

    if (!next) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await backend.writeCronJobs(next);

    logAudit({
      actor,
      action: action === 'toggle' ? 'cron.toggle' : 'cron.trigger',
      target: `cron:${backend.instanceId}:${id}`,
      detail: { instance: backend.instanceId },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
