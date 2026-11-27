import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteSpec } from '../http.ts'
import { HttpError, json } from '../errors.ts'
import { NEVER_ABORT, assistantText, sessionTitle, sessionTitles } from '../util.ts'
import { asSessionId, asSessionRequestId, asWorkspaceId } from '../brand.ts'
import {
  defaultSelection,
  modelSelectionInput,
  recordSessionModel,
  resolveModelSelection,
  selectSessionModel,
  sessionModelSelection,
  type ResolvedSelection,
} from '../model-selection.ts'
import { SseWriter, type EventHub } from '../sse.ts'
import { projectMessages } from '../projection.ts'
import { DEFAULT_OPEN_WAIT_MS, MAX_OPEN_WAIT_MS } from '../open-requests.ts'
import type { Deps } from '../types.ts'

const REPLAY_PAGE_MESSAGES = 400
const REPLAY_MAX_PAGES = 200
const DEFAULT_EVENT_LIMIT = 1000
const MAX_EVENT_LIMIT = 10_000
const MAX_OPEN_TARGET_LENGTH = 128

/** Validate the optional panel routing key carried by an open request. */
function openTarget(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OPEN_TARGET_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, 'gateway/bad-request',
      `body.target must be a non-empty string of at most ${MAX_OPEN_TARGET_LENGTH} printable characters`)
  }
  return value
}

interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
  readonly surfaceOp?: unknown
}

/**
 * Sessions are driven exclusively through `sessionController` so every
 * mutation lands in the same live store the WebUI observes — REST-created
 * sessions, prompts, and cancellations appear there in real time.
 */
export function sessionRoutes(deps: Deps, hub: EventHub): RouteSpec[] {
  const { sessionController, workspaceRegistry } = deps

  /** Summaries keyed for project lookups; includes global archived flags. */
  async function sessionIndex(): Promise<{
    byId: Map<string, { sessionId: string; running: boolean; blank: boolean; updatedAt: number; cwd?: string; parentSessionId?: string; origin?: string }>
    archived: Set<string>
    workspaceOf: Map<string, string>
  }> {
    const { items } = await sessionController.list({}, NEVER_ABORT)
    const archived = new Set(workspaceRegistry.archivedSessionIds)
    const workspaceOf = new Map<string, string>()
    for (const workspace of workspaceRegistry.list()) {
      for (const sessionId of workspace.sessionIds) workspaceOf.set(sessionId, workspace.id)
    }
    const byId = new Map(items.map((item) => [item.sessionId, item]))
    return { byId, archived, workspaceOf }
  }

  function assertFound(sessionId: string, index: { byId: Map<string, unknown> }): void {
    if (!index.byId.has(sessionId)) {
      throw new HttpError(404, 'session/not-found', `session "${sessionId}" not found`)
    }
  }
  void assertFound

  /** Backwards-paged history collection down to `afterSeq` (inclusive cut). */
  async function collectEvents(sessionId: string, afterSeq: number | undefined, limit: number): Promise<{ events: WireEvent[]; hasMore: boolean }> {
    const state = await sessionController.state({ sessionId: asSessionId(sessionId) }, NEVER_ABORT)
    const collected: WireEvent[] = []
    let before: number | undefined
    let hasMore = false
    for (let page = 0; page < REPLAY_MAX_PAGES; page++) {
      const result = await sessionController.events({
        address: { kind: 'session', sessionId: asSessionId(sessionId) },
        throughSeq: state.cursor,
        ...(before !== undefined ? { beforeSeq: before } : {}),
        maxMessages: REPLAY_PAGE_MESSAGES,
      }, NEVER_ABORT)
      const events = result.records.map((record) => record.event as WireEvent)
      collected.push(...events)
      hasMore = result.hasMore
      if (!result.hasMore || events.length === 0) break
      const minSeq = Math.min(...events.map((event) => event.seq))
      if (afterSeq !== undefined && minSeq <= afterSeq + 1) break
      if (collected.length >= limit) break
      before = minSeq
    }
    const events = collected
      .filter((event) => afterSeq === undefined || event.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
    return { events, hasMore: hasMore && events.length >= limit }
  }

  /** SSE bridge: replay from the log, then forward live durable + delta frames. */
  async function streamSession(req: IncomingMessage, res: ServerResponse, sessionId: string, afterSeq: number | undefined, deltas: boolean): Promise<void> {
    const sse = new SseWriter(res)
    sse.hello()

    let draining = true
    let lastReplayedSeq = afterSeq ?? 0
    const buffered: WireEvent[] = []
    const bufferedDeltas: unknown[] = []

    // Subscribe before replay so nothing can slip through the gap; while
    // draining, live frames buffer, after which the same listeners stream
    // directly — no resubscription window.
    const unsubscribeSession = hub.subscribeSession(sessionId, (event) => {
      const wire = event as WireEvent
      if (draining) {
        buffered.push(wire)
        return
      }
      if (wire.seq <= lastReplayedSeq) return
      sse.send('session', String(wire.seq), wire)
      lastReplayedSeq = wire.seq
    })
    const unsubscribeDeltas = deltas
      ? hub.subscribeDeltas(sessionId, (frame) => {
          if (draining) bufferedDeltas.push(frame)
          else sse.send('delta', null, frame)
        })
      : () => {}

    let finished = false
    const finish = (endFrame?: unknown) => {
      if (finished) return
      finished = true
      unsubscribeSession()
      unsubscribeDeltas()
      if (endFrame !== undefined) sse.send('end', null, endFrame)
      sse.close()
    }
    req.on('close', () => finish())

    try {
      const { events } = await collectEvents(sessionId, afterSeq, MAX_EVENT_LIMIT)
      for (const event of events) {
        if (sse.closed || finished) return
        sse.send('session', String(event.seq), event)
        lastReplayedSeq = event.seq
      }
    } catch (error: unknown) {
      finish({ error: error instanceof Error ? error.message : String(error) })
      return
    }

    // Transition to live: flush deltas first (transient, ordered), then any
    // durable events buffered during replay above the watermark.
    for (const frame of bufferedDeltas.splice(0, bufferedDeltas.length)) {
      sse.send('delta', null, frame)
    }
    for (const wire of buffered.splice(0, buffered.length)) {
      if (wire.seq > lastReplayedSeq) {
        sse.send('session', String(wire.seq), wire)
        lastReplayedSeq = wire.seq
      }
    }
    draining = false
  }

  return [
    {
      method: 'GET',
      path: '/sessions',
      async handler(_req, res) {
        const { byId, archived, workspaceOf } = await sessionIndex()
        const rows = [...byId.values()].map((item) => ({
          ...item,
          archived: archived.has(item.sessionId),
          projectId: workspaceOf.get(item.sessionId),
        }))
        const titles = await sessionTitles(sessionController, rows.map((row) => row.sessionId))
        json(res, 200, {
          items: rows.map((row) => ({ ...row, title: titles.get(row.sessionId) ?? null })),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id',
      async handler(_req, res, params) {
        const state = await sessionController.state({ sessionId: asSessionId(params.id!) }, NEVER_ABORT)
        const archived = workspaceRegistry.archivedSessionIds.includes(asSessionId(params.id!))
        const model = await sessionModelSelection(deps, params.id!)
        json(res, 200, { sessionId: params.id, title: await sessionTitle(sessionController, params.id!), ...state, archived, model: model ?? null })
      },
    },
    {
      method: 'PATCH',
      path: '/sessions/:id',
      async handler(_req, res, params, body) {
        const { title } = (body ?? {}) as { title?: unknown }
        if (title !== undefined && (typeof title !== 'string' || title.length === 0)) {
          throw new HttpError(400, 'gateway/bad-request', 'body.title must be a non-empty string')
        }
        const model = modelSelectionInput(body)
        if (title === undefined && model === undefined) {
          throw new HttpError(400, 'gateway/bad-request', 'body.title or body.{provider, model, reasoningEffort} is required')
        }
        const selected = model !== undefined ? await selectSessionModel(deps, params.id!, model) : undefined
        const renamed = typeof title === 'string'
          ? await sessionController.rename({ sessionId: asSessionId(params.id!), title })
          : undefined
        json(res, 200, {
          sessionId: params.id,
          ...(renamed !== undefined ? { title: renamed.title, seq: renamed.seq } : {}),
          ...(selected !== undefined ? { model: selected } : {}),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/events',
      async handler(_req, res, params, _body, query) {
        const afterRaw = query.get('afterSeq')
        const afterSeq = afterRaw === null || afterRaw === '' ? undefined : Number(afterRaw)
        if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
          throw new HttpError(400, 'gateway/bad-request', 'query.afterSeq must be a non-negative integer')
        }
        const limitRaw = query.get('limit')
        const limit = limitRaw === null || limitRaw === '' ? DEFAULT_EVENT_LIMIT : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
          throw new HttpError(400, 'gateway/bad-request', `query.limit must be an integer in [1, ${MAX_EVENT_LIMIT}]`)
        }
        const { events, hasMore } = await collectEvents(params.id!, afterSeq, limit)
        json(res, 200, { sessionId: params.id, events, hasMore })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/messages',
      async handler(_req, res, params, _body, query) {
        const afterRaw = query.get('afterSeq')
        const afterSeq = afterRaw === null || afterRaw === '' ? undefined : Number(afterRaw)
        if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
          throw new HttpError(400, 'gateway/bad-request', 'query.afterSeq must be a non-negative integer')
        }
        const { events, hasMore } = await collectEvents(params.id!, afterSeq, MAX_EVENT_LIMIT)
        json(res, 200, { sessionId: params.id, messages: projectMessages(events), hasMore })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/stream',
      handler: async (req, res, params, _body, query) => {
        // EventSource resume semantics: the Last-Event-ID header carries the
        // last seen seq; an explicit afterSeq query parameter overrides it.
        const lastEventId = Number(req.headers['last-event-id'])
        const afterRaw = query.get('afterSeq')
        const afterSeq = afterRaw !== null && afterRaw !== ''
          ? Number(afterRaw)
          : Number.isInteger(lastEventId) && lastEventId >= 0
            ? lastEventId
            : undefined
        if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
          throw new HttpError(400, 'gateway/bad-request', 'query.afterSeq must be a non-negative integer')
        }
        const deltas = query.get('deltas') !== 'false'
        await streamSession(req, res, params.id!, afterSeq, deltas)
      },
    },
    {
      method: 'POST',
      path: '/projects/:id/sessions',
      async handler(_req, res, params, body) {
        const workspace = workspaceRegistry.get(asWorkspaceId(params.id!))
        if (workspace === undefined) throw new HttpError(404, 'workspace/not-found', `project "${params.id}" not found`)
        const { sessionId: named, agentPreset, title } = (body ?? {}) as {
          sessionId?: unknown
          agentPreset?: unknown
          title?: unknown
        }
        const model = modelSelectionInput(body)
        // Validate before create so a rejected selection leaves no empty session behind.
        let selected: ResolvedSelection | undefined
        if (model !== undefined) {
          const base = typeof named === 'string'
            ? await sessionModelSelection(deps, named).catch(() => undefined)
            : defaultSelection(deps)
          selected = await resolveModelSelection(deps.llm, model, base)
        }
        const created = await sessionController.create({
          workspaceId: asWorkspaceId(workspace.id),
          ...(typeof named === 'string' ? { sessionId: asSessionId(named) } : {}),
          ...(typeof agentPreset === 'string' ? { agentPreset } : {}),
        })
        if (selected !== undefined) await recordSessionModel(deps, created.sessionId, selected)
        if (typeof title === 'string' && title.length > 0) {
          await sessionController.rename({ sessionId: asSessionId(created.sessionId), title })
        }
        const effective = selected ?? await sessionModelSelection(deps, created.sessionId)
        json(res, 201, {
          sessionId: created.sessionId,
          agentPreset: created.agentPreset,
          projectId: workspace.id,
          model: effective ?? null,
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/messages',
      async handler(_req, res, params, body) {
        const sessionId = params.id!
        const { text, mode, wait, timeoutMs, clientTimeZone } = (body ?? {}) as {
          text?: unknown
          mode?: unknown
          wait?: unknown
          timeoutMs?: unknown
          clientTimeZone?: unknown
        }
        const model = modelSelectionInput(body)
        if (typeof text !== 'string' || text.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.text (non-empty string) is required; "/skill-name args" invokes a user-invocable skill')
        }
        if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
          throw new HttpError(400, 'gateway/bad-request', 'body.mode must be "queue" or "steer"')
        }
        if (model !== undefined) await selectSessionModel(deps, sessionId, model)
        const requestId = randomUUID()
        await sessionController.prompt({
          requestId: asSessionRequestId(requestId),
          sessionId: asSessionId(sessionId),
          mode: mode ?? 'queue',
          content: [{ type: 'text', text }],
          ...(typeof clientTimeZone === 'string' ? { clientTimeZone } : {}),
        }, NEVER_ABORT)
        if (wait === true) {
          const value = await sessionController.wait({
            sessionId: asSessionId(sessionId),
            timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000,
          }, NEVER_ABORT)
          const outputText = value.output.records
            .map((record) => assistantText((record as { event?: { type?: string; data?: unknown } }).event))
            .filter((text): text is string => text !== undefined)
            .join('\n')
          json(res, 200, { accepted: true, requestId, wait: { reason: value.reason, state: value.state, outputText } })
          return
        }
        json(res, 202, { accepted: true, requestId })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/open',
      async handler(_req, res, params, body) {
        const sessionId = params.id!
        const payload = (body ?? {}) as {
          target?: unknown
          wait?: unknown
          timeoutMs?: unknown
        }
        const target = openTarget(payload.target)
        if (payload.wait !== undefined && typeof payload.wait !== 'boolean') {
          throw new HttpError(400, 'gateway/bad-request', 'body.wait must be a boolean')
        }
        const timeoutRaw = payload.timeoutMs
        if (timeoutRaw !== undefined && (typeof timeoutRaw !== 'number' || !Number.isInteger(timeoutRaw)
          || timeoutRaw < 1 || timeoutRaw > MAX_OPEN_WAIT_MS)) {
          throw new HttpError(400, 'gateway/bad-request',
            `body.timeoutMs must be an integer in [1, ${MAX_OPEN_WAIT_MS}]`)
        }
        const wait = payload.wait === true
        const timeoutMs = typeof timeoutRaw === 'number' ? timeoutRaw : DEFAULT_OPEN_WAIT_MS
        // Unknown sessions throw RemoteError('session/not-found') → mapped to 404.
        await sessionController.state({ sessionId: asSessionId(sessionId) }, NEVER_ABORT)
        if (workspaceRegistry.archivedSessionIds.includes(asSessionId(sessionId))) {
          throw new HttpError(409, 'session/archived',
            `session "${sessionId}" is archived; unarchive it in the WebUI first`)
        }
        const subscribers = deps.remotes.subscriberCount()
        const policy = deps.config.openPolicy
        if (target === undefined && policy === 'auto' && subscribers > 1) {
          throw new HttpError(409, 'open/target-required',
            `${subscribers} WebUI streams are connected; pass body.target (the panel ?dshTarget key) or body.target="*" to broadcast`)
        }
        const mode = target === '*' ? 'broadcast' : target !== undefined ? 'targeted' : policy === 'broadcast' ? 'broadcast' : 'single'
        const targetField = target !== undefined ? { target } : {}
        if (subscribers === 0) {
          json(res, 202, {
            sessionId,
            accepted: true,
            mode,
            ...targetField,
            subscribers: 0,
            delivered: false,
            opened: false,
            reason: 'no-client',
          })
          return
        }
        const { requestId, ackKey } = deps.openRequests.create({
          sessionId,
          ...(target !== undefined ? { target } : {}),
        })
        // A no-target request is safe only because the policy above admitted
        // it; `'*'` also lets an explicitly targeted single panel accept it.
        const frameTarget = target ?? '*'
        deps.remotes.broadcast({
          type: 'open-session',
          sessionId,
          requestId,
          target: frameTarget,
          time: Date.now(),
          ack: { url: `${deps.config.prefix}/open-requests/${requestId}/ack`, key: ackKey },
        })
        if (!wait) {
          json(res, 202, {
            sessionId,
            requestId,
            accepted: true,
            mode,
            ...targetField,
            subscribers,
            // A concrete target is only confirmed by a browser ack; do not
            // claim delivery from the host-side subscriber count.
            ...(target === undefined || target === '*' ? { delivered: true } : {}),
          })
          return
        }
        const abort = new AbortController()
        const onClose = (): void => { if (!res.writableEnded) abort.abort() }
        res.once('close', onClose)
        const result = await deps.openRequests.wait(requestId, timeoutMs, abort.signal)
        res.off('close', onClose)
        if (abort.signal.aborted) return
        if (result.opened) {
          const snapshot = deps.openRequests.get(requestId)
          json(res, 200, {
            sessionId,
            requestId,
            mode,
            ...targetField,
            opened: true,
            subscribers,
            ackedBy: snapshot === undefined ? [] : snapshot.acks.filter((ack) => ack.ok),
          })
          return
        }
        json(res, 202, {
          sessionId,
          requestId,
          mode,
          ...targetField,
          opened: false,
          reason: result.reason ?? 'timeout',
          ...(result.error !== undefined ? { error: result.error } : {}),
          subscribers,
        })
      },
    },
    {
      method: 'POST',
      path: '/open-requests/:requestId/ack',
      // Browser callback. With an apiKey configured the WebUI cannot carry the
      // Bearer token, so the guard is skipped and the one-time frame key
      // authenticates the request; without one the normal loopback fence stays.
      public: deps.config.apiKey !== null,
      async handler(_req, res, params, body) {
        const { key, clientId, target, sessionId, ok, error } = (body ?? {}) as {
          key?: unknown
          clientId?: unknown
          target?: unknown
          sessionId?: unknown
          ok?: unknown
          error?: unknown
        }
        if (typeof key !== 'string' || key.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.key is required')
        }
        if (typeof clientId !== 'string' || clientId.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.clientId is required')
        }
        if (target !== undefined && typeof target !== 'string') {
          throw new HttpError(400, 'gateway/bad-request', 'body.target must be a string when present')
        }
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.sessionId is required')
        }
        if (typeof ok !== 'boolean') {
          throw new HttpError(400, 'gateway/bad-request', 'body.ok must be a boolean')
        }
        if (error !== undefined && typeof error !== 'string') {
          throw new HttpError(400, 'gateway/bad-request', 'body.error must be a string when present')
        }
        const result = deps.openRequests.ack(params.requestId!, {
          key,
          clientId,
          ...(target !== undefined ? { target } : {}),
          sessionId,
          ok,
          ...(error !== undefined ? { error: error.slice(0, 500) } : {}),
        })
        if (result === 'not-found') {
          throw new HttpError(404, 'open/request-not-found', `open request "${params.requestId}" not found or expired`)
        }
        if (result === 'key-mismatch') {
          throw new HttpError(409, 'open/ack-key-mismatch', 'ack key does not match the open request')
        }
        if (result === 'target-mismatch') {
          throw new HttpError(409, 'open/target-mismatch', 'ack target does not match the open request target')
        }
        if (result === 'session-mismatch') {
          throw new HttpError(409, 'open/session-mismatch', 'ack sessionId does not match the open request session')
        }
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      },
    },
    {
      method: 'GET',
      path: '/open-requests/:requestId',
      async handler(_req, res, params) {
        const snapshot = deps.openRequests.get(params.requestId!)
        if (snapshot === undefined) {
          throw new HttpError(404, 'open/request-not-found', `open request "${params.requestId}" not found or expired`)
        }
        json(res, 200, snapshot)
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/cancel',
      async handler(_req, res, params) {
        const value = sessionController.cancel({ sessionId: asSessionId(params.id!) })
        json(res, 200, { accepted: value.accepted })
      },
    },
    {
      method: 'DELETE',
      path: '/sessions/:id',
      async handler(_req, res, params, _body, query) {
        const sessionId = params.id!
        const stop = query.get('stopActivity')
        const stopActivity = stop === null ? false : stop !== 'false'
        const owner = workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(asSessionId(sessionId)))
        if (owner === undefined) {
          throw new HttpError(409, 'workspace/not-attached',
            'only sessions attached to a project can be archived via the REST API; the WebUI can remove ungrouped sessions')
        }
        await workspaceRegistry.archiveSession(asSessionId(sessionId), { stopActivity })
        json(res, 200, { archived: true, projectId: owner.id })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/skills',
      async handler(_req, res, params) {
        const value = await deps.sessionSkillCatalog.list({ sessionId: asSessionId(params.id!) }, NEVER_ABORT)
        json(res, 200, { sessionId: params.id, items: value.skills })
      },
    },
  ]
}
