import { NextResponse } from 'next/server';
import { sanitizeForTenant, tenantInternalErrorResponse } from '@/lib/api-auth';
import { resolveTenantBackend, TenantAccessError } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { backend, instanceId } = resolveTenantBackend(request);
    const file = await backend.listCronJobs();
    const jobs = file.jobs.map((job) => ({
      id: job.id ?? job.jobId ?? null,
      name: job.name ?? null,
      enabled: job.enabled ?? false,
      schedule: job.schedule ?? null,
      deliveryError: job.deliveryError ?? null,
      lastStatus: job.last_status ?? null,
      lastRunAt: job.last_run_at ?? null,
      nextRunAt: job.next_run_at ?? null,
    }));
    return NextResponse.json(sanitizeForTenant({ instanceId, jobs }));
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return tenantInternalErrorResponse(error);
  }
}
