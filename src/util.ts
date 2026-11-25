import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { asSessionId } from './brand.ts'

/** Shared signal for in-process calls that the REST client never aborts. */
export const NEVER_ABORT: AbortSignal = new AbortController().signal

/**
 * Read one session's `title` projection (dsh-session-title, latest
 * `session/title` event wins). Null when unset, unreadable, or the session is
 * unknown — titles are display metadata, never worth failing a read over.
 */
export async function sessionTitle(controller: SessionController, sessionId: string): Promise<string | null> {
  try {
    const value = await controller.projections({ sessionId: asSessionId(sessionId) }, NEVER_ABORT)
    if (value === null) return null
    const title = (value.values as { title?: unknown }).title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/** Concurrently read titles for several sessions. */
export async function sessionTitles(controller: SessionController, sessionIds: readonly string[]): Promise<Map<string, string | null>> {
  const entries = await Promise.all(sessionIds.map(async (id) => [id, await sessionTitle(controller, id)] as const))
  return new Map(entries)
}

/**
 * Extract the visible text of one durable assistant event's embedded stream.
 * `assistant/message` data carries both a folded `message` (content blocks)
 * and the exact timed `stream` records; text-chunks dominate the convenience
 * view. Duck-typed on purpose — the wire type is JsonValue at this boundary.
 */
export function assistantText(data: unknown): string | undefined {
  const d = data as {
    message?: { content?: readonly { type?: string; text?: string }[] }
    stream?: readonly Record<string, unknown>[]
  } | undefined
  if (d === undefined) return undefined
  const fromBlocks = d.message?.content
    ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  if (fromBlocks !== undefined && fromBlocks.length > 0) return fromBlocks
  const parts: string[] = []
  for (const record of d.stream ?? []) {
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      parts.push(...(record.texts as string[]))
    } else if (record.type === 'chunk') {
      const chunk = record.chunk as { type?: string; text?: string } | undefined
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
    }
  }
  const joined = parts.join('')
  return joined.length > 0 ? joined : undefined
}
