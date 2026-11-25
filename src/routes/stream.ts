import type { RouteSpec } from '../http.ts'
import { SseWriter, type EventHub } from '../sse.ts'
import type { Deps } from '../types.ts'

/**
 * Global, live-only SSE fan-out across every session: durable events as
 * `event: session` (id = `sessionId:seq`, informational only — this endpoint
 * does not replay or honor Last-Event-ID) plus transient assistant deltas as
 * `event: delta`, each payload tagged with its `sessionId`. Reconnect
 * reconciliation is the client's job via the paged REST reads, mirroring the
 * single-session `/sessions/:id/stream` split of durable resume vs. live feed.
 */
export function streamRoutes(deps: Deps, hub: EventHub): RouteSpec[] {
  void deps
  return [
    {
      method: 'GET',
      path: '/stream',
      handler: async (req, res, _params, _body, query) => {
        const deltas = query.get('deltas') !== 'false'
        const sse = new SseWriter(res)
        sse.hello()

        const unsubscribeSession = hub.subscribeAllSessions((sessionId, event) => {
          sse.send('session', `${sessionId}:${event.seq}`, { sessionId, ...event })
        })
        const unsubscribeDeltas = deltas
          ? hub.subscribeAllDeltas((sessionId, frame) => {
              sse.send('delta', null, { sessionId, frame })
            })
          : () => {}

        req.on('close', () => {
          unsubscribeSession()
          unsubscribeDeltas()
          sse.close()
        })
      },
    },
  ]
}
