import type { Context } from '@deepseek-ai/cordis'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { guard } from './auth.ts'
import { json } from './errors.ts'
import { createDispatcher, type RouteSpec } from './http.ts'
import { openapiDocument } from './openapi.ts'
import { OpenRequestRegistry } from './open-requests.ts'
import { RestApiRemotes } from './remotes.ts'
import { EventHub } from './sse.ts'
import { ApprovalRegistry, approvalRoutes, registerApprovalAnswerer } from './routes/approvals.ts'
import { modelRoutes } from './routes/models.ts'
import { projectRoutes } from './routes/projects.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { skillRoutes } from './routes/skills.ts'
import { streamRoutes } from './routes/stream.ts'
import { ConfigSchema, type Deps, type RestApiConfig, type RouteRegistration } from './types.ts'

export const name = 'dsh-rest-api'

export const Config = ConfigSchema

export const inject = [
  'webServer',
  'sessionController',
  'workspaceRegistry',
  'llm',
  'agentDefaultModel',
  'credentials',
  'skills',
  'sessionSkillCatalog',
  'settingsController',
  'settings',
]

export function apply(ctx: Context, config: RestApiConfig): void {
  // The Gateway discovers this SRC Remote service through shared reflect props
  // and re-scans on every `internal/service` event, so late registration is fine.
  const remotes = new RestApiRemotes(ctx)
  const openRequests = new OpenRequestRegistry()
  ctx.effect(() => () => openRequests.dispose(), 'dsh-rest-api: open-request ledger')

  const deps: Deps = {
    ctx,
    config,
    webServer: ctx.webServer,
    sessionController: ctx.sessionController,
    workspaceRegistry: ctx.workspaceRegistry,
    llm: ctx.llm,
    agentDefaultModel: ctx.agentDefaultModel,
    credentials: ctx.credentials,
    skills: ctx.skills,
    sessionSkillCatalog: ctx.sessionSkillCatalog,
    settingsController: ctx.settingsController,
    settings: ctx.settings,
    remotes,
    openRequests,
  }

  // Bridge the harness event feed to per-connection SSE writers. Cordis
  // disposes these global listeners automatically on plugin unload.
  const hub = new EventHub()
  hub.attach(ctx)

  // Park every tool-approval ask until a REST client answers it. Cordis
  // disposes the answerer listener automatically on plugin unload.
  const approvals = new ApprovalRegistry()
  registerApprovalAnswerer(ctx, approvals)

  const routes: RouteSpec[] = [
    {
      method: 'GET',
      path: '/health',
      public: true,
      handler(_req, res) {
        json(res, 200, {
          ok: true,
          healthy: true,
          version: getDshRuntimeVersion(),
          prefix: config.prefix,
          auth: config.apiKey !== null ? 'bearer' : 'loopback-only',
        })
      },
    },
    {
      method: 'GET',
      path: '/openapi.json',
      public: true,
      handler(_req, res) {
        json(res, 200, openapiDocument(config))
      },
    },
    ...projectRoutes(deps),
    ...sessionRoutes(deps, hub),
    ...streamRoutes(deps, hub),
    ...approvalRoutes(deps, approvals),
    ...modelRoutes(deps),
    ...skillRoutes(deps),
  ]

  const dispatch = createDispatcher(config.prefix, routes, (req, pathname) => {
    void pathname
    guard(req, config)
  })

  const registration: RouteRegistration = {
    kind: 'prefix',
    path: config.prefix,
    // The dsh admission fence stays anonymous for this prefix; authentication
    // is enforced inside the dispatcher (Bearer token or loopback-only).
    auth: 'anonymous',
    handler(req, res) {
      void dispatch(req, res)
    },
  }
  ctx.effect(
    () => ctx.webServer.register(registration as Parameters<typeof ctx.webServer.register>[0]),
    'dsh-rest-api: prefix route',
  )

  ctx.logger.info(
    'dsh-rest-api serving %s with %d routes (%s)',
    config.prefix,
    routes.length,
    config.apiKey !== null ? 'bearer auth' : 'loopback-only — set config.apiKey for remote access',
  )
}
