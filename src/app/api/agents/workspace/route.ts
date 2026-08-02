import { NextRequest, NextResponse } from 'next/server';
import { requireApiEditor, requireApiUser } from '@/lib/api-auth';
import { requireUser } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { resolveBackend } from '@/lib/backend';
import { isAllowedWorkspaceWritePath, WORKSPACE_MAX_FILE_BYTES } from '@/lib/agent-workspace';

export const dynamic = 'force-dynamic';

function getInstanceIdFromRequest(req: NextRequest): string | null {
  try {
    const url = new URL(req.url);
    return url.searchParams.get('instance') || url.searchParams.get('namespace');
  } catch {
    return null;
  }
}

function workspaceError(error: 'Invalid path' | 'Not found' | 'Unsupported file type' | 'File too large' | 'Root is read-only') {
  const status = error === 'Not found' ? 404 : error === 'File too large' ? 413 : error === 'Root is read-only' ? 403 : 400;
  return NextResponse.json({ error }, { status });
}

export async function GET(req: NextRequest) {
  const auth = requireApiUser(req as unknown as Request);
  if (auth) return auth;

  const rel = req.nextUrl.searchParams.get('path')?.trim() || '';

  try {
    const backend = resolveBackend(getInstanceIdFromRequest(req) ?? undefined);
    const result = await backend.readWorkspace(
      req.nextUrl.searchParams.get('rootId') ?? '',
      rel,
    );
    if (result.type === 'error') return workspaceError(result.error);

    const { root } = result;
    if (result.type === 'directory') {
      return NextResponse.json({
        rootId: root.id,
        rootLabel: root.label,
        kind: root.kind,
        writable: root.writable,
        ...(result.path ? { path: result.path } : {}),
        entries: result.entries,
      });
    }

    return NextResponse.json({
      rootId: root.id,
      rootLabel: root.label,
      kind: root.kind,
      writable: root.writable,
      path: result.path,
      size: result.size,
      mtimeMs: result.mtimeMs,
      content: result.content,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceIdFromRequest(req) ?? undefined);
  if (!backend.workspaceWritesAllowed()) {
    return NextResponse.json({ error: 'Workspace writes are disabled (set HERMES_ALLOW_WORKSPACE_WRITE=true)' }, { status: 403 });
  }

  const actor = requireUser(req as unknown as Request);
  const body = await req.json().catch(() => ({}));
  const rel = String(body?.path ?? '').trim();
  const content = String(body?.content ?? '');
  const rootId = String(body?.rootId ?? '').trim();

  if (!isAllowedWorkspaceWritePath(rel)) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 400 });
  }
  if (Buffer.byteLength(content, 'utf-8') > WORKSPACE_MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 });
  }

  try {
    const result = await backend.createWorkspaceFile(rootId, rel, content);
    if (!result.ok) return workspaceError(result.error);

    logAudit({
      actor,
      action: 'workspace.create',
      target: `workspace:${rootId || 'agent-workspace'}:${rel}`,
      detail: { bytes: Buffer.byteLength(content, 'utf-8') },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceIdFromRequest(req) ?? undefined);
  if (!backend.workspaceWritesAllowed()) {
    return NextResponse.json({ error: 'Workspace writes are disabled (set HERMES_ALLOW_WORKSPACE_WRITE=true)' }, { status: 403 });
  }

  const actor = requireUser(req as unknown as Request);
  const body = await req.json().catch(() => ({}));
  const rel = String(body?.path ?? '').trim();
  const content = String(body?.content ?? '');
  const rootId = String(body?.rootId ?? '').trim();

  if (!isAllowedWorkspaceWritePath(rel)) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 400 });
  }
  if (Buffer.byteLength(content, 'utf-8') > WORKSPACE_MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 });
  }

  try {
    const result = await backend.updateWorkspaceFile(rootId, rel, content);
    if (!result.ok) return workspaceError(result.error);

    logAudit({
      actor,
      action: 'workspace.update',
      target: `workspace:${rootId || 'agent-workspace'}:${rel}`,
      detail: { bytes: Buffer.byteLength(content, 'utf-8') },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireApiEditor(req as unknown as Request);
  if (auth) return auth;
  const backend = resolveBackend(getInstanceIdFromRequest(req) ?? undefined);
  if (!backend.workspaceWritesAllowed()) {
    return NextResponse.json({ error: 'Workspace writes are disabled (set HERMES_ALLOW_WORKSPACE_WRITE=true)' }, { status: 403 });
  }

  const actor = requireUser(req as unknown as Request);
  const rel = req.nextUrl.searchParams.get('path')?.trim() || '';
  const rootId = req.nextUrl.searchParams.get('rootId')?.trim() || '';

  if (!isAllowedWorkspaceWritePath(rel)) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 400 });
  }

  try {
    const result = await backend.deleteWorkspaceFile(rootId, rel);
    if (!result.ok) return workspaceError(result.error);

    logAudit({
      actor,
      action: 'workspace.delete',
      target: `workspace:${rootId || 'agent-workspace'}:${rel}`,
      detail: null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
