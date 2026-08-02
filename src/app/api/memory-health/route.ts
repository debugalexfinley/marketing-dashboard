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
  const auth = requireApiUser(request);
  if (auth) return auth;
  try {
    const backend = resolveBackend(getInstanceId(request) ?? undefined);
    const data = await backend.readRequiredHealthReport('memory-health');
    if (data === null) {
      return NextResponse.json({ error: 'Memory health report not found' }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('GET /api/memory-health error:', error);
    return NextResponse.json({ error: 'Failed to read memory health report' }, { status: 500 });
  }
}
