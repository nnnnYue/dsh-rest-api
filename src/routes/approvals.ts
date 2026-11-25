import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { RouteSpec } from '../http.ts'
import { HttpError, json } from '../errors.ts'
import type { Deps } from '../types.ts'

/**
 * REST face over the harness tool-approval waterfall (`approval/request`,
 * `tools/pre-execute` kind:'ask'). This plugin registers itself as the
 * composed answerer: every ask is claimed and parked until a REST client
 * answers via `POST /approvals/:id/respond`. Note this short-circuits other
 * answerers (e.g. a WebUI prompt) — the REST surface becomes the only
 * decision path for sessions in compositions including this plugin.
 */

/** Safety valve: an approval nobody answered for this long settles cancelled. */
const APPROVAL_TTL_MS = 15 * 60_000

interface AnswererRequest {
  readonly agent: { readonly id: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** One parked approval as surfaced by `GET /approvals`. */
export interface PendingApproval {
  readonly id: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  /** Epoch ms when the ask was claimed. */
  readonly askedAt: number
}

interface PendingEntry {
  readonly info: PendingApproval
  readonly resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort: () => void
}

/**
 * Registry of in-flight approvals. The waterfall event carries no service id,
 * so ids are plugin-issued (`randomUUID`) and purely REST-level correlation
 * handles; the harness pairs its own `approval/asked`/`approval/decided`
 * audit events around the returned outcome.
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()

  list(): PendingApproval[] {
    return [...this.pending.values()].map((entry) => entry.info)
  }

  /** Resolve one parked approval; false when the id is unknown or settled. */
  respond(id: string, outcome: 'allowed-once' | 'rejected'): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.settle(id, entry, outcome)
    return true
  }

  private settle(id: string, entry: PendingEntry, outcome: ApprovalOutcome): void {
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
  }

  /** Claim one ask and park it until a REST response, abort, or the TTL. */
  park(req: AnswererRequest): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const id = randomUUID()
      const info: PendingApproval = {
        id,
        sessionId: req.agent.id,
        toolName: req.toolName,
        ...(req.callId !== undefined ? { callId: req.callId } : {}),
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
        askedAt: Date.now(),
      }
      const entry: PendingEntry = {
        info,
        resolve,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        signal: req.signal,
        onAbort: () => this.settle(id, entry, 'cancelled'),
      }
      entry.timer = setTimeout(() => this.settle(id, entry, 'cancelled'), APPROVAL_TTL_MS)
      this.pending.set(id, entry)
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
    })
  }
}

/** Claim every approval ask on behalf of the REST surface. */
export function registerApprovalAnswerer(ctx: Context, registry: ApprovalRegistry): void {
  ctx.on('approval/request', (req: AnswererRequest, _next: () => Promise<ApprovalOutcome>) => {
    return registry.park(req)
  }, { global: true })
}

export function approvalRoutes(deps: Deps, registry: ApprovalRegistry): RouteSpec[] {
  void deps
  return [
    {
      method: 'GET',
      path: '/approvals',
      handler(_req, res) {
        json(res, 200, { items: registry.list() })
      },
    },
    {
      method: 'POST',
      path: '/approvals/:id/respond',
      handler(_req, res, params, body) {
        const { outcome } = (body ?? {}) as { outcome?: unknown }
        if (outcome !== 'allowed-once' && outcome !== 'rejected') {
          throw new HttpError(400, 'gateway/bad-request', 'body.outcome must be "allowed-once" or "rejected"')
        }
        const id = params.id!
        if (!registry.respond(id, outcome)) {
          throw new HttpError(404, 'approval/not-found', `no pending approval "${id}"`)
        }
        json(res, 200, { accepted: true, id, outcome })
      },
    },
  ]
}
