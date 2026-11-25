import type { IncomingMessage } from 'node:http'
import { HttpError } from './errors.ts'
import type { RestApiConfig } from './types.ts'

function isLoopback(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

/**
 * Guard every non-public REST request.
 *
 * - With `config.apiKey` set: require an exact `Authorization: Bearer <key>` match.
 * - Without it: fail closed for non-loopback clients (configure `apiKey` to
 *   serve remote callers), so a fresh install never exposes the harness.
 */
export function guard(req: IncomingMessage, config: RestApiConfig): void {
  if (config.apiKey !== null) {
    const header = req.headers.authorization
    const token = header !== undefined && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (token === undefined || token !== config.apiKey) {
      throw new HttpError(401, 'rest/unauthorized', 'missing or invalid Bearer token (configure config.apiKey of dsh-rest-api)')
    }
    return
  }
  const socket = req.socket as { remoteAddress?: string | undefined }
  if (!isLoopback(socket.remoteAddress)) {
    throw new HttpError(401, 'rest/unauthorized',
      'dsh-rest-api has no apiKey configured; loopback access only — set config.apiKey to enable remote access')
  }
}
