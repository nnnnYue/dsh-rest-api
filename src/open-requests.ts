/** In-memory ledger for REST-issued open-session requests and browser acknowledgements. */

import { randomUUID } from 'node:crypto'

/** How long an open request stays queryable after issue. */
export const OPEN_REQUEST_TTL_MS = 60_000
/** Default `wait=true` budget. */
export const DEFAULT_OPEN_WAIT_MS = 5_000
/** Upper bound for `wait=true`, kept below the request retention window. */
export const MAX_OPEN_WAIT_MS = 30_000

/** One browser acknowledgement posted to `/open-requests/:requestId/ack`. */
export interface OpenAckInput {
  /** One-time key carried in the push frame. */
  readonly key: string
  /** Browser-tab identity used for diagnostics and duplicate suppression. */
  readonly clientId: string
  /** Panel routing key the tab is subscribed to. */
  readonly target?: string
  readonly sessionId: string
  readonly ok: boolean
  readonly error?: string
}

/** Stored acknowledgement, stamped with host time. */
export interface OpenAck {
  readonly clientId: string
  readonly target?: string
  readonly sessionId: string
  readonly ok: boolean
  readonly error?: string
  readonly time: number
}

/** Why an acknowledgement was refused. */
export type OpenAckRejection = 'not-found' | 'key-mismatch' | 'target-mismatch' | 'session-mismatch'

/** Public view of one open request; never exposes the ack key. */
export interface OpenRequestSnapshot {
  readonly requestId: string
  readonly sessionId: string
  readonly target?: string
  readonly state: 'pending' | 'acked'
  readonly acks: readonly OpenAck[]
  readonly createdAt: number
  readonly expiresAt: number
}

/** Outcome of waiting for the first successful acknowledgement. */
export interface OpenWaitResult {
  readonly opened: boolean
  readonly reason?: 'timeout' | 'client-error' | 'expired'
  readonly ack?: OpenAck
  readonly error?: string
}

interface PendingOpen {
  readonly requestId: string
  readonly sessionId: string
  readonly target?: string
  readonly ackKey: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly acks: Map<string, OpenAck>
  readonly waiters: Set<(result: OpenWaitResult) => void>
  readonly timer: NodeJS.Timeout
}

/**
 * Tracks open requests long enough to correlate browser acknowledgements and
 * answer `wait=true` / `GET /open-requests/:id`. Retention is in-memory and
 * bounded by {@link OPEN_REQUEST_TTL_MS}; a restarted host forgets pending ids.
 */
export class OpenRequestRegistry {
  private readonly pending = new Map<string, PendingOpen>()

  /**
   * Register one request before pushing its frame.
   * @param input - session to open, panel routing key (if any), and retention.
   * @returns the request id and the one-time key the frame carries.
   */
  create(input: { readonly sessionId: string; readonly target?: string; readonly retentionMs?: number }): {
    requestId: string
    ackKey: string
  } {
    const requestId = randomUUID()
    const ackKey = randomUUID()
    const createdAt = Date.now()
    const retentionMs = input.retentionMs ?? OPEN_REQUEST_TTL_MS
    const entry: PendingOpen = {
      requestId,
      sessionId: input.sessionId,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ackKey,
      createdAt,
      expiresAt: createdAt + retentionMs,
      acks: new Map(),
      waiters: new Set(),
      timer: setTimeout(() => { this.expire(requestId) }, retentionMs),
    }
    entry.timer.unref?.()
    this.pending.set(requestId, entry)
    return { requestId, ackKey }
  }

  /**
   * Record one browser acknowledgement.
   * @param requestId - request addressed by the frame.
   * @param input - validated acknowledgement payload.
   * @returns the stored acknowledgement, or why it was refused.
   */
  ack(requestId: string, input: OpenAckInput): OpenAck | OpenAckRejection {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return 'not-found'
    if (input.key !== entry.ackKey) return 'key-mismatch'
    if (input.sessionId !== entry.sessionId) return 'session-mismatch'
    if (entry.target !== undefined && entry.target !== '*' && input.target !== entry.target) return 'target-mismatch'
    const ack: OpenAck = {
      clientId: input.clientId,
      ...(input.target !== undefined ? { target: input.target } : {}),
      sessionId: input.sessionId,
      ok: input.ok,
      ...(input.error !== undefined ? { error: input.error } : {}),
      time: Date.now(),
    }
    // Keep the first result per tab, but let a later success replace an
    // earlier failure: a retry must not flip a successful switch back to a
    // failure, and a duplicated tab id must not block a real success.
    const existing = entry.acks.get(ack.clientId)
    if (existing === undefined || (!existing.ok && ack.ok)) entry.acks.set(ack.clientId, ack)
    if (ack.ok) this.resolveWaiters(entry, { opened: true, ack })
    return ack
  }

  /**
   * Wait for the first successful acknowledgement.
   * @param requestId - request to observe.
   * @param timeoutMs - budget before settling as unconfirmed.
   * @param signal - caller cancellation; the pending waiter is released.
   * @returns the acknowledgement or a timeout/client-error outcome.
   */
  wait(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<OpenWaitResult> {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return Promise.resolve({ opened: false, reason: 'expired' })
    const success = firstSuccess(entry)
    if (success !== undefined) return Promise.resolve({ opened: true, ack: success })
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const finish = (result: OpenWaitResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        entry.waiters.delete(finish)
        resolve(result)
      }
      timer = setTimeout(() => {
        const failures = [...entry.acks.values()].filter((ack) => !ack.ok)
        const last = failures[failures.length - 1]
        if (last !== undefined) {
          finish({
            opened: false,
            reason: 'client-error',
            ...(last.error !== undefined ? { error: last.error } : {}),
          })
        } else {
          finish({ opened: false, reason: 'timeout' })
        }
      }, timeoutMs)
      entry.waiters.add(finish)
      if (signal !== undefined) {
        onAbort = (): void => { finish({ opened: false, reason: 'timeout' }) }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Read the current state of one request.
   * @param requestId - request to inspect.
   * @returns the snapshot, or `undefined` after retention expiry.
   */
  get(requestId: string): OpenRequestSnapshot | undefined {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return undefined
    const acks = [...entry.acks.values()]
    return {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      ...(entry.target !== undefined ? { target: entry.target } : {}),
      state: acks.some((ack) => ack.ok) ? 'acked' : 'pending',
      acks,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }
  }

  /** Settle every waiter and release retention timers. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      for (const waiter of [...entry.waiters]) waiter({ opened: false, reason: 'expired' })
      entry.waiters.clear()
    }
    this.pending.clear()
  }

  private expire(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return
    this.pending.delete(requestId)
    for (const waiter of [...entry.waiters]) waiter({ opened: false, reason: 'expired' })
    entry.waiters.clear()
  }

  private resolveWaiters(entry: PendingOpen, result: OpenWaitResult): void {
    for (const waiter of [...entry.waiters]) waiter(result)
  }
}

function firstSuccess(entry: PendingOpen): OpenAck | undefined {
  for (const ack of entry.acks.values()) if (ack.ok) return ack
  return undefined
}
