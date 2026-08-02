import { NextRequest, NextResponse } from 'next/server';
import { requireApiEditor, requireApiUser } from '@/lib/api-auth';
import { requireUser } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { resolveBackend, type CronJobConfig, type CronJobsFile } from '@/lib/backend';

export const dynamic = 'force-dynamic';

function stripDerivedFields(job: CronJobConfig): CronJobConfig {
  const out = { ...(job as Record<string, unknown>) };
  delete out.lastRun;
  delete out.lastResult;
  return out as CronJobConfig;
}

function normalizeJobId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
  return id;
}

function resolveCronJobId(job: CronJobConfig): string | null {
  return normalizeJobId(job.id ?? job.jobId);
}

function upsertCronJob(jobsFile: CronJobsFile, job: CronJobConfig): CronJobsFile {
  const id = resolveCronJobId(job);
  if (!id) return jobsFile;
  const normalized = { ...job, id, jobId: id };
  const now = Date.now();
  const existing = jobsFile.jobs.find((item) => resolveCronJobId(item) === id);
  if (existing) {
    const merged = { ...existing, ...normalized, id, jobId: id, updatedAtMs: now };
    return {
      ...jobsFile,
      jobs: jobsFile.jobs.map((item) => (resolveCronJobId(item) === id ? merged : item)),
    };
  }
  return {
    ...jobsFile,
    jobs: [
      ...jobsFile.jobs,
      {
        ...normalized,
        enabled: normalized.enabled !== false,
        createdAtMs: typeof normalized.createdAtMs === 'number' ? normalized.createdAtMs : now,
        updatedAtMs: now,
      },
    ],
  };
}

function deleteCronJob(jobsFile: CronJobsFile, id: string): CronJobsFile {
  return { ...jobsFile, jobs: jobsFile.jobs.filter((job) => resolveCronJobId(job) !== id) };
}

function getInstanceId(req: NextRequest): string | null {
  try {
    return req.nextUrl.searchParams.get('instance') || req.nextUrl.searchParams.get('namespace');
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = requireApiUser(req as unknown as Request);
  if (auth) return auth;
  try {
    const actor = requireUser(req as unknown as Request);
    const backend = resolveBackend(getInstanceId(req) ?? undefined);
    const jobsFile = await backend.listCronJobs();
    const canWrite = backend.cronWritesAllowed() && (actor.role === 'admin' || actor.role === 'editor');
    return NextResponse.json({ instance: backend.instanceId, jobs: jobsFile.jobs, can_write: canWrite });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceId(req) ?? undefined);
  if (!backend.cronWritesAllowed()) {
    return NextResponse.json({ error: 'Cron writes are disabled (set HERMES_ALLOW_CRON_WRITE=true)' }, { status: 403 });
  }
  const actor = requireUser(req as unknown as Request);
  const body = await req.json().catch(() => ({}));

  const rawJob = body?.job as CronJobConfig | undefined;
  const job = rawJob ? stripDerivedFields(rawJob) : undefined;
  const id = normalizeJobId(job?.id ?? job?.jobId);
  if (!id) return NextResponse.json({ error: 'Invalid job.id' }, { status: 400 });

  try {
    const jobsFile = await backend.listCronJobs();
    if (jobsFile.jobs.some((j) => normalizeJobId(j.id ?? j.jobId) === id)) {
      return NextResponse.json({ error: 'Job already exists' }, { status: 409 });
    }
    const next = upsertCronJob(jobsFile, { ...(job || {}), id, jobId: id });
    await backend.writeCronJobs(next);

    logAudit({
      actor,
      action: 'cron.create',
      target: `cron:${backend.instanceId}:${id}`,
      detail: { instance: backend.instanceId },
    });

    return NextResponse.json({ ok: true, jobs: next.jobs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceId(req) ?? undefined);
  if (!backend.cronWritesAllowed()) {
    return NextResponse.json({ error: 'Cron writes are disabled (set HERMES_ALLOW_CRON_WRITE=true)' }, { status: 403 });
  }
  const actor = requireUser(req as unknown as Request);
  const body = await req.json().catch(() => ({}));

  const rawJob = body?.job as CronJobConfig | undefined;
  const job = rawJob ? stripDerivedFields(rawJob) : undefined;
  const id = normalizeJobId(job?.id ?? job?.jobId);
  if (!id) return NextResponse.json({ error: 'Invalid job.id' }, { status: 400 });

  try {
    const jobsFile = await backend.listCronJobs();
    if (!jobsFile.jobs.some((j) => normalizeJobId(j.id ?? j.jobId) === id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const next = upsertCronJob(jobsFile, { ...(job || {}), id, jobId: id });
    await backend.writeCronJobs(next);

    logAudit({
      actor,
      action: 'cron.update',
      target: `cron:${backend.instanceId}:${id}`,
      detail: { instance: backend.instanceId },
    });

    return NextResponse.json({ ok: true, jobs: next.jobs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceId(req) ?? undefined);
  if (!backend.cronWritesAllowed()) {
    return NextResponse.json({ error: 'Cron writes are disabled (set HERMES_ALLOW_CRON_WRITE=true)' }, { status: 403 });
  }
  const actor = requireUser(req as unknown as Request);

  const id = normalizeJobId(req.nextUrl.searchParams.get('id') || req.nextUrl.searchParams.get('jobId'));
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    const jobsFile = await backend.listCronJobs();
    if (!jobsFile.jobs.some((j) => normalizeJobId(j.id ?? j.jobId) === id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const next = deleteCronJob(jobsFile, id);
    await backend.writeCronJobs(next);

    logAudit({
      actor,
      action: 'cron.delete',
      target: `cron:${backend.instanceId}:${id}`,
      detail: { instance: backend.instanceId },
    });

    return NextResponse.json({ ok: true, jobs: next.jobs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
