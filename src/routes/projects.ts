import type { RouteSpec } from '../http.ts'
import { HttpError, json } from '../errors.ts'
import { NEVER_ABORT, sessionTitles } from '../util.ts'
import { asWorkspaceId } from '../brand.ts'
import type { Deps } from '../types.ts'

/**
 * Projects map 1:1 onto dsh Workspaces: a stable id over a canonical path
 * with a display title and an ordered session ledger. `create` is idempotent
 * per canonical path, so POST reports 201 only for genuinely new projects.
 */
export function projectRoutes(deps: Deps): RouteSpec[] {
  const { workspaceRegistry, sessionController } = deps

  const rowOf = (workspace: {
    id: string
    path: string
    title: string
    createdAt: string
    updatedAt: string
    sessionIds: readonly string[]
  }) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    sessionIds: [...workspace.sessionIds],
    archivedSessionIds: workspaceRegistry.archivedSessionIds
      .filter((id) => workspace.sessionIds.includes(id)),
  })

  return [
    {
      method: 'GET',
      path: '/projects',
      async handler(_req, res) {
        json(res, 200, { items: workspaceRegistry.list().map(rowOf) })
      },
    },
    {
      method: 'POST',
      path: '/projects',
      async handler(_req, res, _params, body) {
        const { path, title } = (body ?? {}) as { path?: unknown; title?: unknown }
        if (typeof path !== 'string' || path.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.path (absolute directory) is required')
        }
        const existing = await workspaceRegistry.resolveByPath(path)
        if (existing !== undefined) {
          json(res, 200, { created: false, project: rowOf(existing) })
          return
        }
        const created = await workspaceRegistry.create(
          path,
          typeof title === 'string' && title.length > 0 ? title : undefined,
        )
        json(res, 201, { created: true, project: rowOf(created) })
      },
    },
    {
      method: 'GET',
      path: '/projects/:id',
      async handler(_req, res, params) {
        const workspace = workspaceRegistry.get(asWorkspaceId(params.id!))
        if (workspace === undefined) throw new HttpError(404, 'workspace/not-found', `project "${params.id}" not found`)
        json(res, 200, { project: { ...rowOf(workspace), status: await workspace.status() } })
      },
    },
    {
      method: 'PATCH',
      path: '/projects/:id',
      async handler(_req, res, params, body) {
        const workspace = workspaceRegistry.get(asWorkspaceId(params.id!))
        if (workspace === undefined) throw new HttpError(404, 'workspace/not-found', `project "${params.id}" not found`)
        const { title } = (body ?? {}) as { title?: unknown }
        if (typeof title !== 'string' || title.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.title (non-empty string) is required')
        }
        await workspace.setTitle(title)
        json(res, 200, { project: rowOf(workspace) })
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:id',
      async handler(_req, res, params) {
        // Only the registration is removed; session logs stay on disk and the
        // affected sessions become "Ungrouped", mirroring the WebUI behavior.
        const deleted = await workspaceRegistry.delete(asWorkspaceId(params.id!))
        json(res, deleted ? 200 : 404, deleted
          ? { deleted: true, note: 'session logs were kept; affected sessions are now ungrouped' }
          : { error: { code: 'workspace/not-found', message: `project "${params.id}" not found` } })
      },
    },
    {
      method: 'GET',
      path: '/projects/:id/sessions',
      async handler(_req, res, params) {
        const workspace = workspaceRegistry.get(asWorkspaceId(params.id!))
        if (workspace === undefined) throw new HttpError(404, 'workspace/not-found', `project "${params.id}" not found`)
        const { items } = await sessionController.list({}, NEVER_ABORT)
        const byId = new Map(items.map((item) => [item.sessionId, item]))
        const archived = new Set(workspaceRegistry.archivedSessionIds)
        const rows = [...workspace.sessionIds].map((sessionId) => ({
          ...(byId.get(sessionId) ?? { sessionId, running: false, blank: false, updatedAt: 0 }),
          archived: archived.has(sessionId),
        }))
        const titles = await sessionTitles(sessionController, rows.map((row) => row.sessionId))
        json(res, 200, {
          items: rows.map((row) => ({ ...row, title: titles.get(row.sessionId) ?? null })),
        })
      },
    },
  ]
}
