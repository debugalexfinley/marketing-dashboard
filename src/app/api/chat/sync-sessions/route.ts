import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireApiUser } from '@/lib/api-auth';
import { resolveBackend } from '@/lib/backend';

function getInstanceId(request: Request): string | null {
  try {
    const url = new URL(request.url);
    return url.searchParams.get('instance') || url.searchParams.get('namespace');
  } catch {
    return null;
  }
}

/**
 * POST /api/chat/sync-sessions
 * Reads JSONL session transcripts and imports user<->agent conversation turns
 * into the messages table. Tracks progress via session_sync table.
 */
export async function POST(request: Request) {
  const auth = requireApiUser(request as Request);
  if (auth) return auth;

  const backend = resolveBackend(getInstanceId(request) ?? undefined);

  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const agentIds = (await backend.listConfiguredAgents()).map((agent) => agent.id);

  for (const agentId of agentIds) {
    const refs = await backend.readSessions(agentId);

    for (const ref of refs) {
      const file = ref.name;
      const filePath = ref.path;
      const sessionId = ref.sessionId;
      const conversationId = `session:${backend.instanceId}:${agentId}:${sessionId}`;

      try {
        // Check last sync position
        const syncState = db
          .prepare('SELECT last_offset FROM session_sync WHERE session_file = ?')
          .get(filePath) as { last_offset: number } | undefined;

        const lastOffset = syncState?.last_offset || 0;

        // Read file and get current size
        if (ref.size <= lastOffset) {
          skipped++;
          continue; // No new data
        }

        // Read new content from last offset (simple full read)
        const { entries } = await backend.readSessionEntries(ref, lastOffset);

        const existingCount = db
          .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
          .get(conversationId) as { c: number };

        // Parse all message entries
        const messageEntries: Array<{ role: string; text: string; timestamp: string }> = [];

        for (const entry of entries) {
          if (entry.type !== 'message' || !entry.message) continue;

          const { role, content: contentBlocks } = entry.message;

          if (role === 'user') {
            const textBlock = contentBlocks?.find((b) => b.type === 'text');
            if (textBlock?.text) {
              messageEntries.push({
                role: 'user',
                text: textBlock.text,
                timestamp: entry.timestamp,
              });
            }
          } else if (role === 'assistant') {
            const textBlocks = contentBlocks?.filter((b) => b.type === 'text') || [];
            const combinedText = textBlocks
              .map((b) => b.text)
              .filter(Boolean)
              .join('\n\n');
            if (combinedText) {
              messageEntries.push({
                role: 'assistant',
                text: combinedText,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        // Only import entries beyond what we already have
        const toImport = messageEntries.slice(existingCount.c);

        if (toImport.length > 0) {
          const insert = db.prepare(`
            INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, created_at)
            VALUES (?, ?, ?, ?, 'text', ?, ?)
          `);

          const insertMany = db.transaction((entries: typeof toImport) => {
            for (const entry of entries) {
              const ts = Math.floor(new Date(entry.timestamp).getTime() / 1000);
              const fromAgent = entry.role === 'user' ? 'operator' : agentId;
              const toAgent = entry.role === 'user' ? agentId : 'operator';
              const metadata = JSON.stringify({
                source: 'session_sync',
                session_id: sessionId,
                instance: backend.instanceId,
              });

              insert.run(conversationId, fromAgent, toAgent, entry.text, metadata, ts);
              imported++;
            }
          });

          insertMany(toImport);

          // Create notification for new session messages
          const agentLabel = agentId.charAt(0).toUpperCase() + agentId.slice(1);
          const firstUserMsg = toImport.find((e) => e.role === 'user');
          let title = `${agentLabel} session activity`;

          if (firstUserMsg) {
            const cronMatch = firstUserMsg.text.match(/\\[cron:[\\w-]+\\s+([^\\]]+)\\]/);
            if (cronMatch) title = `${agentLabel}: ${cronMatch[1]}`;
            else if (firstUserMsg.text.startsWith('[Telegram')) title = `${agentLabel}: Telegram message`;
          }

          const lastResponse = [...toImport].reverse().find((e) => e.role === 'assistant');
          const preview = lastResponse ? lastResponse.text.slice(0, 120) : `${toImport.length} new messages`;

          db.prepare(`
            INSERT INTO notifications (type, severity, title, message, data)
            VALUES ('session', 'info', ?, ?, ?)
          `).run(
            title,
            preview,
            JSON.stringify({ conversation_id: conversationId, agent_id: agentId, count: toImport.length, instance: backend.instanceId }),
          );
        }

        // Update sync state
        db.prepare(`
          INSERT INTO session_sync (session_file, last_offset, last_synced_at)
          VALUES (?, ?, unixepoch())
          ON CONFLICT(session_file) DO UPDATE SET
            last_offset = excluded.last_offset,
            last_synced_at = excluded.last_synced_at
        `).run(filePath, ref.size);
      } catch (err) {
        errors.push(`${backend.instanceId}/${agentId}/${file}: ${err}`);
      }
    }
  }

  return NextResponse.json({
    instance: backend.instanceId,
    imported,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    synced_at: new Date().toISOString(),
  });
}

/**
 * GET /api/chat/sync-sessions — status of sync
 */
export async function GET(request: Request) {
  const auth = requireApiUser(request as Request);
  if (auth) return auth;
  const db = getDb();
  const rows = db.prepare('SELECT * FROM session_sync ORDER BY last_synced_at DESC').all();
  return NextResponse.json({ sessions: rows });
}

export const dynamic = 'force-dynamic';
