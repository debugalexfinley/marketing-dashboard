import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

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
    const backend = resolveBackend(getInstanceId(req) ?? undefined);

    const id = req.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    const result = await backend.readCronRunsInfo(id, 10);
    if (!result.exists) {
      return NextResponse.json({ runs: [] });
    }

    return NextResponse.json({ instance: backend.instanceId, runs: result.runs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
