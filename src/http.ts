import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, json, writeError } from './errors.ts'

/** One REST endpoint: method + absolute sub-path under the plugin prefix. */
export interface RouteSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Sub-path below the configured prefix, e.g. `/sessions/:id/stream`. */
  readonly path: string
  /** Auth-exempt endpoints (health, openapi) skip the Bearer/loopback guard. */
  readonly public?: boolean
  readonly handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    body: unknown,
    query: URLSearchParams,
  ) => Promise<void> | void
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) throw new HttpError(413, 'gateway/payload-too-large', `request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Route matcher: exact and `:param` segments; trailing slashes tolerated. */
function match(path: string, subPath: string): Record<string, string> | undefined {
  const a = path.split('/').filter((s) => s.length > 0)
  const b = subPath.split('/').filter((s) => s.length > 0)
  if (a.length !== b.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(b[i]!)
    } else if (seg !== b[i]) {
      return undefined
    }
  }
  return params
}

/**
 * Build the dispatcher installed as the single `prefix` route on the web
 * server. The dispatcher owns auth, body parsing, matching, and error
 * mapping; handlers receive parsed JSON bodies and path params.
 */
export function createDispatcher(
  prefix: string,
  routes: readonly RouteSpec[],
  guard: (req: IncomingMessage, pathname: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal.invalid')
    let subPath = url.pathname
    if (subPath.startsWith(prefix)) subPath = subPath.slice(prefix.length)
    if (subPath.length === 0) subPath = '/'
    try {
      for (const route of routes) {
        if (route.method !== req.method) continue
        const params = match(route.path, subPath)
        if (params === undefined) continue
        if (!route.public) guard(req, url.pathname)
        let body: unknown = undefined
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const raw = await readBoundedBody(req, MAX_BODY_BYTES)
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'))
            } catch {
              throw new HttpError(400, 'gateway/bad-request', 'request body is not valid JSON')
            }
          }
        }
        await route.handler(req, res, params, body, url.searchParams)
        if (!res.writableEnded) {
          json(res, 204, undefined)
        }
        return
      }
      throw new HttpError(404, 'gateway/not-found', `no route for ${req.method} ${subPath} under ${prefix}`)
    } catch (error: unknown) {
      writeError(res, error)
    }
  }
}
