/** Host-side push channel that hands REST-issued open-session requests to WebUI clients. */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** One live push frame consumed by the plugin's WebUI client module. */
export interface OpenSessionFrame {
  readonly type: 'open-session'
  readonly sessionId: string
  readonly requestId: string
  /**
   * Panel routing key. `'*'` reaches every tab; a concrete key reaches only
   * tabs opened with the matching `?dshTarget=` value. The field is omitted
   * only by pre-0.2 hosts, which the client treats as legacy broadcast.
   */
  readonly target?: string
  readonly time: number
  /** Browser callback endpoint for the commit acknowledgement. */
  readonly ack: {
    readonly url: string
    readonly key: string
  }
}

/**
 * SRC-mode Remote service exposing the `restApi/open-requests` stream. The
 * plugin's WebUI client module (`lib/client.js`) mounts a zero-parameter
 * contribution for this endpoint, filters frames by its panel target, and
 * calls `uiWorkspace.openSession` only for accepted frames. Delivery is
 * live-only: frames are never buffered for tabs that are not currently
 * subscribed, so `delivered` reflects the subscription count at push time and
 * `wait=true` acknowledgements are the confirmation signal.
 */
export class RestApiRemotes extends TypertRemoteService {
  private readonly streams = new Set<FrameQueue<OpenSessionFrame>>()

  /** @param ctx - Host context; the Gateway discovers this service by SRC reflection. */
  constructor(ctx: Context) {
    super(ctx, 'restApiRemotes', { namespace: 'restApi' })
  }

  /**
   * Open one generation of the live open-request feed.
   * @param signal - Remote stream cancellation.
   * @returns every REST-issued open-session request from subscription time on.
   */
  @Remote({ mode: 'stream' })
  async *openRequests(signal: AbortSignal): AsyncIterable<OpenSessionFrame> {
    signal.throwIfAborted()
    const queue = new FrameQueue<OpenSessionFrame>()
    this.streams.add(queue)
    try {
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  /**
   * Push one frame to every subscribed client.
   * @returns the subscriber count the frame reached (0 = no WebUI tab is listening).
   */
  broadcast(frame: OpenSessionFrame): number {
    for (const queue of this.streams) queue.push(frame)
    return this.streams.size
  }

  /** Number of currently subscribed WebUI streams. */
  subscriberCount(): number {
    return this.streams.size
  }
}

/** Unbounded buffer between one REST caller and one live stream consumer. */
class FrameQueue<T> {
  private readonly buffer: T[] = []
  private wake: (() => void) | undefined
  private done = false

  push(frame: T): void {
    if (this.done) return
    this.buffer.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (!signal.aborted && this.buffer.length > 0) yield this.buffer.shift() as T
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
