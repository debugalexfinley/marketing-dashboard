import { NextResponse } from 'next/server';
import { sanitizeForTenant } from '@/lib/api-auth';
import { resolveTenantBackend, TenantAccessError } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { backend, instanceId } = resolveTenantBackend(request);
    const agents = await backend.listAgents();
    const profiles = agents.map(({ name, model, gatewayRunning }) => ({
      name,
      model,
      gatewayRunning: gatewayRunning ?? false,
    }));
    return NextResponse.json(sanitizeForTenant({ instanceId, profiles }));
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
}
