import { NextResponse } from 'next/server';
import { sanitizeForTenant, tenantInternalErrorResponse } from '@/lib/api-auth';
import { resolveTenantBackend, TenantAccessError } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { backend, instanceId } = resolveTenantBackend(request);
    const agents = await backend.listAgents();
    const sessions = (await Promise.all(agents.map(async (agent) => {
      const refs = (await backend.readSessions(agent.name)).slice(0, 20);
      return Promise.all(refs.map(async (ref) => {
        const { entries } = await backend.readSessionEntries(ref, 0);
        return {
          id: ref.sessionId,
          name: ref.name,
          agent: agent.name,
          updatedAt: ref.mtimeMs,
          messageCount: entries.length,
          entryTokenTotal: entries.reduce(
            (total, entry) => total + (entry.message?.usage?.totalTokens ?? 0),
            0,
          ),
        };
      }));
    }))).flat();
    const usage = await Promise.all(agents.map(async (agent) => ({
      agent: agent.name,
      totals: await backend.readSessionUsage(agent.name),
    })));
    return NextResponse.json(sanitizeForTenant({ instanceId, sessions, usage }));
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return tenantInternalErrorResponse(error);
  }
}
