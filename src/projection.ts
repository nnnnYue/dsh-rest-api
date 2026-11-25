/**
 * Fold of the durable session log into an opencode-style message shape:
 * `{info, parts}` analog where tool invocations surface as typed parts with
 * derived state (`tool/call` without a paired `tool/result` = running).
 * Purely duck-typed — the wire event union is JsonValue at this boundary.
 */

interface SourceEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
}

interface ContentBlock {
  readonly type?: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string
}

export interface ProjectedPart {
  readonly type: 'text' | 'reasoning' | 'tool'
  /** text / reasoning parts. */
  readonly text?: string
  /** tool parts. */
  readonly callId?: string
  readonly tool?: string
  /** Raw JSON argument string as logged by the harness. */
  readonly arguments?: string
  readonly state?: 'running' | 'completed' | 'error'
  readonly output?: string
  readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string }
}

export interface ProjectedMessage {
  /** dsh message id, or `seq-<n>` for synthetic holders. */
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly seq: number
  readonly time: number
  readonly parts: ProjectedPart[]
}

interface MutablePart {
  type: 'text' | 'reasoning' | 'tool'
  text?: string
  callId?: string
  tool?: string
  arguments?: string
  state?: 'running' | 'completed' | 'error'
  output?: string
  error?: { name?: string; code?: string; reason?: string }
}

interface MutableMessage {
  id: string
  role: 'user' | 'assistant'
  seq: number
  time: number
  parts: MutablePart[]
}

const asBlocks = (value: unknown): readonly ContentBlock[] =>
  Array.isArray(value) ? (value as readonly ContentBlock[]) : []

const textOfBlocks = (blocks: readonly ContentBlock[] | undefined): string | undefined => {
  const joined = (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  return joined.length > 0 ? joined : undefined
}

/**
 * Fold ascending durable events into projected messages. `system/message` and
 * `developer/message` are skipped (ova-style consumers render user/assistant
 * plus tool parts); compaction `surfaceOp` replace ranges drop superseded
 * messages before the replacement is appended.
 */
export function projectMessages(events: readonly SourceEvent[]): ProjectedMessage[] {
  const messages: MutableMessage[] = []
  const toolPartByCallId = new Map<string, { part: MutablePart; holder: MutableMessage }>()
  let lastAssistant: MutableMessage | undefined

  const dropMessage = (message: MutableMessage): void => {
    const index = messages.indexOf(message)
    if (index >= 0) messages.splice(index, 1)
    for (const part of message.parts) {
      if (part.callId !== undefined) toolPartByCallId.delete(part.callId)
    }
    if (lastAssistant === message) lastAssistant = undefined
  }

  const replaceRange = (op: unknown): boolean => {
    if (typeof op !== 'object' || op === null) return false
    const { startSeq, endSeq } = op as { startSeq?: unknown; endSeq?: unknown }
    if (typeof startSeq !== 'number' || typeof endSeq !== 'number') return false
    for (const message of [...messages]) {
      if (message.seq >= startSeq && message.seq <= endSeq) dropMessage(message)
    }
    return true
  }

  for (const event of events) {
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        // The user message body IS the event data.
        const text = textOfBlocks(asBlocks(data.content)) ?? ''
        messages.push({ id: typeof data.id === 'string' ? data.id : `seq-${event.seq}`, role: 'user', seq: event.seq, time: event.time, parts: [{ type: 'text', text }] })
        lastAssistant = undefined
        break
      }
      case 'assistant/message': {
        const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
        const parts: MutablePart[] = []
        for (const block of asBlocks(message.content)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'reasoning' && typeof block.text === 'string') {
            parts.push({ type: 'reasoning', text: block.text })
          } else if (block.type === 'tool-call' && typeof block.id === 'string') {
            parts.push({
              type: 'tool',
              callId: block.id,
              ...(typeof block.name === 'string' ? { tool: block.name } : {}),
              ...(typeof block.arguments === 'string' ? { arguments: block.arguments } : {}),
              state: 'running',
            })
          }
        }
        const projected: MutableMessage = {
          id: typeof message.id === 'string' ? message.id : `seq-${event.seq}`,
          role: 'assistant',
          seq: event.seq,
          time: event.time,
          parts,
        }
        replaceRange(event.surfaceOp)
        messages.push(projected)
        lastAssistant = projected
        for (const part of parts) {
          if (part.callId !== undefined) toolPartByCallId.set(part.callId, { part, holder: projected })
        }
        break
      }
      case 'tool/call': {
        // Execution record; ensure the call has a visible part even when its
        // assistant/message fold was compacted away.
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        if (callId !== undefined && !toolPartByCallId.has(callId)) {
          const part: MutablePart = {
            type: 'tool',
            callId,
            ...(typeof data.name === 'string' ? { tool: data.name } : {}),
            ...(typeof data.arguments === 'string' ? { arguments: data.arguments } : {}),
            state: 'running',
          }
          if (lastAssistant !== undefined) {
            lastAssistant.parts.push(part)
            toolPartByCallId.set(callId, { part, holder: lastAssistant })
          } else {
            const holder: MutableMessage = { id: `seq-${event.seq}`, role: 'assistant', seq: event.seq, time: event.time, parts: [part] }
            messages.push(holder)
            toolPartByCallId.set(callId, { part, holder })
          }
        }
        break
      }
      case 'tool/result': {
        const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
        const entry = callId !== undefined ? toolPartByCallId.get(callId) : undefined
        if (entry !== undefined) {
          const failed = message.isError === true || data.error !== undefined
          entry.part.state = failed ? 'error' : 'completed'
          const output = textOfBlocks(asBlocks(message.content))
          if (output !== undefined) entry.part.output = output
          if (failed) {
            const error = (typeof data.error === 'object' && data.error !== null ? data.error : {}) as Record<string, unknown>
            entry.part.error = {
              ...(typeof error.name === 'string' ? { name: error.name } : {}),
              ...(typeof error.code === 'string' ? { code: error.code } : {}),
              ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
            }
          }
        }
        break
      }
      default:
        break
    }
  }
  return messages
}
