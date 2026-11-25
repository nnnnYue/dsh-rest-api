import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

export const HEARTBEAT_MS = 15_000

/**
 * Minimal SSE writer owning the response lifecycle once opened. Frames carry
 * `id:` only for durable session events so `Last-Event-ID` resumes from the
 * last persisted seq; transient delta frames leave the id untouched.
 */
export class SseWriter {
  private readonly heartbeat: ReturnType<typeof setInterval>

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    this.heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }

  /** Initial retry hint for reconnecting EventSource clients. */
  hello(): void {
    if (!this.res.writableEnded) this.res.write('retry: 3000\n\n')
  }

  send(event: string, id: string | null, data: unknown): void {
    if (this.res.writableEnded) return
    const body = JSON.stringify(data)
    let frame = ''
    if (id !== null) frame += `id: ${id}\n`
    frame += `event: ${event}\n`
    frame += `data: ${body}\n\n`
    this.res.write(frame)
  }

  close(): void {
    clearInterval(this.heartbeat)
    if (!this.res.writableEnded) this.res.end()
  }

  get closed(): boolean {
    return this.res.writableEnded || this.res.destroyed
  }
}

type SessionListener = (event: SessionEvent) => void
type DeltaListener = (frame: AssistantStreamFrame) => void
type AllSessionListener = (sessionId: string, event: SessionEvent) => void
type AllDeltaListener = (sessionId: string, frame: AssistantStreamFrame) => void

/**
 * In-process fan-out hub bridging the harness event feed to per-connection
 * SSE writers. Subscriptions use `{ global: true }` because both events are
 * scope-filtered by subject, and this plugin's context is not session-scoped
 * — the same pattern dsh's own session-controller state listener uses.
 */
export class EventHub {
  private readonly sessionSubs = new Map<string, Set<SessionListener>>()
  private readonly deltaSubs = new Map<string, Set<DeltaListener>>()
  private readonly allSessionSubs = new Set<AllSessionListener>()
  private readonly allDeltaSubs = new Set<AllDeltaListener>()

  /** Register global listeners; Cordis auto-disposes them on plugin unload. */
  attach(ctx: Context): void {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const subs = this.sessionSubs.get(session.id)
      if (subs !== undefined) {
        for (const sub of subs) sub(event)
      }
      for (const sub of this.allSessionSubs) sub(session.id, event)
    }, { global: true })
    ctx.on('agent/assistant-stream', (payload: { agent: Agent; frame: AssistantStreamFrame }) => {
      const subs = this.deltaSubs.get(payload.agent.id)
      if (subs !== undefined) {
        for (const sub of subs) sub(payload.frame)
      }
      for (const sub of this.allDeltaSubs) sub(payload.agent.id, payload.frame)
    }, { global: true })
  }

  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    let subs = this.sessionSubs.get(sessionId)
    if (subs === undefined) {
      subs = new Set()
      this.sessionSubs.set(sessionId, subs)
    }
    subs.add(listener)
    return () => {
      subs!.delete(listener)
      if (subs!.size === 0) this.sessionSubs.delete(sessionId)
    }
  }

  subscribeDeltas(sessionId: string, listener: DeltaListener): () => void {
    let subs = this.deltaSubs.get(sessionId)
    if (subs === undefined) {
      subs = new Set()
      this.deltaSubs.set(sessionId, subs)
    }
    subs.add(listener)
    return () => {
      subs!.delete(listener)
      if (subs!.size === 0) this.deltaSubs.delete(sessionId)
    }
  }

  /** Cross-session durable event fan-out (global `/stream` endpoint). */
  subscribeAllSessions(listener: AllSessionListener): () => void {
    this.allSessionSubs.add(listener)
    return () => {
      this.allSessionSubs.delete(listener)
    }
  }

  /** Cross-session transient delta fan-out (global `/stream` endpoint). */
  subscribeAllDeltas(listener: AllDeltaListener): () => void {
    this.allDeltaSubs.add(listener)
    return () => {
      this.allDeltaSubs.delete(listener)
    }
  }
}
