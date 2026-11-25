import type { ServerResponse } from 'node:http'

/** HTTP-layer failure carrying a dsh-style error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Map an arbitrary thrown value to an HTTP status, honoring dsh RemoteError
 * codes (`<domain>/<reason>`) when present. Duck-typed on purpose: the plugin
 * never imports RemoteError as a runtime value.
 */
export function statusForError(error: unknown): { status: number; code: string } {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : undefined
  if (code !== undefined) {
    if (code.endsWith('/not-found')) return { status: 404, code }
    if (code.endsWith('/bad-request') || code.endsWith('/invalid')) return { status: 400, code }
    if (code.endsWith('/conflict') || code.endsWith('/busy') || code.endsWith('/writer-held')
      || code.endsWith('/already-exists')) return { status: 409, code }
    if (code.endsWith('/unauthorized') || code.endsWith('/forbidden')) return { status: 403, code }
    if (code.endsWith('/unavailable')) return { status: 503, code }
    return { status: 500, code }
  }
  return { status: 500, code: 'gateway/internal' }
}

/** Serialize an error to the uniform `{error: {code, message}}` envelope. */
export function writeError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof HttpError) {
    json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  const { status, code } = statusForError(error)
  const message = error instanceof Error ? error.message : String(error)
  json(res, status, { error: { code, message } })
}

/** Send one JSON response and close the request. */
export function json(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
