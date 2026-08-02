import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireApiUser(request);
  if (auth) return auth;
  const backend = resolveBackend();
  const { defaultInstance, instances } = await backend.listInstances();
  return NextResponse.json({
    default_instance: defaultInstance,
    // Do not leak server filesystem paths (openclawHome) to the client.
    instances,
  });
}
