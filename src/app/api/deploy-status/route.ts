import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

function getInstanceId(request: Request): string | null {
  try {
    const url = new URL(request.url);
    return url.searchParams.get('instance') || url.searchParams.get('namespace');
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = requireApiUser(request as Request);
  if (auth) return auth;

  try {
    const backend = resolveBackend(getInstanceId(request) ?? undefined);
    const status = await backend.readDeployStatus();

    return NextResponse.json({
      instance: backend.instanceId,
      service: {
        name: status.serviceName,
        state: status.serviceState,
      },
      deploy: {
        script_path: status.scriptPath || null,
        lock_file: status.lockFile,
        lock_exists: status.lockExists,
        running_pids: status.runningPids,
      },
      openclaw: {
        bin: status.openclawBin,
        config_validate: status.configValidation,
      },
      latest_log: status.latestLog,
    });
  } catch (error) {
    console.error('GET /api/deploy-status error:', error);
    return NextResponse.json({ error: 'Failed to read deploy status' }, { status: 500 });
  }
}
