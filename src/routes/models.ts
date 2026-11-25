import type { RouteSpec } from '../http.ts'
import { HttpError, json } from '../errors.ts'
import { NEVER_ABORT } from '../util.ts'
import { asCredentialRef, asJsonValue, asReasoningEffort } from '../brand.ts'
import type { Deps } from '../types.ts'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

interface ProviderProfile {
  readonly displayName?: string
  readonly api?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  readonly models?: readonly { id: string; name?: string; input?: readonly string[]; description?: string }[]
  readonly [key: string]: unknown
}

interface MutableProviderProfile {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  models?: readonly { id: string; name?: string; input?: readonly string[]; description?: string }[]
  [key: string]: unknown
}

/**
 * Model configuration is a thin REST face over two seams:
 *
 * - Catalog reads go to `ctx.llm` (live adapters) and `ctx.agentDefaultModel`.
 * - Custom provider CRUD writes the `providers` volatile dict of the llm
 *   gateway plugin (default entry id `llm-pi-ai`) through the settings
 *   controller, which persists into the profile patch and hot-reloads — the
 *   same path the WebUI settings page uses, so both stay in sync.
 */
export function modelRoutes(deps: Deps): RouteSpec[] {
  const { llm, agentDefaultModel, credentials, settingsController } = deps

  /** Locate the settings namespace carrying the providers dict. */
  async function resolveProvidersNamespace(): Promise<{ ns: string; revision: number; providers: Record<string, ProviderProfile> }> {
    const describe = await settingsController.describe()
    const preferred = describe.namespaces.find((view) => view.ns === 'llm-pi-ai')
      ?? describe.namespaces.find((view) => {
        const providers = (view.value as { providers?: unknown } | null)?.providers
        return typeof providers === 'object' && providers !== null
      })
    if (preferred === undefined) {
      throw new HttpError(503, 'settings/unavailable',
        'no llm gateway namespace with a "providers" dict is composed; mount @deepseek-ai/dsh-llm-pi-ai to manage custom providers')
    }
    const providers = (preferred.value as { providers?: Record<string, ProviderProfile> }).providers ?? {}
    return { ns: preferred.ns, revision: preferred.revision, providers }
  }

  async function mutateProviders(
    ns: string,
    revision: number,
    ops: readonly ({ readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] })[],
  ): Promise<void> {
    await settingsController.mutate(ns, ops.map((op) => op.op === 'set'
      ? { op: 'set', path: [...op.path], value: asJsonValue(op.value) }
      : { op: 'unset', path: [...op.path] }), revision)
  }

  return [
    {
      method: 'GET',
      path: '/models',
      async handler(_req, res) {
        const providers = llm.listProviders()
        const items = []
        for (const provider of providers) {
          const models = await llm.listModels(provider.id)
          items.push({
            ...provider,
            models: await Promise.all(models.map(async (model) => {
              try {
                const info = await llm.resolveModelInfo(provider.id, model.id, NEVER_ABORT)
                return info.reasoning === undefined ? model : { ...model, reasoning: info.reasoning }
              } catch {
                return model
              }
            })),
          })
        }
        let fallback
        try {
          fallback = agentDefaultModel.currentSelection()
        } catch {
          fallback = undefined
        }
        json(res, 200, { items, defaultSelection: fallback ?? null })
      },
    },
    {
      method: 'GET',
      path: '/models/default',
      async handler(_req, res) {
        json(res, 200, { selection: agentDefaultModel.currentSelection() })
      },
    },
    {
      method: 'PUT',
      path: '/models/default',
      async handler(_req, res, _params, body) {
        const { provider, model, reasoningEffort } = (body ?? {}) as {
          provider?: unknown
          model?: unknown
          reasoningEffort?: unknown
        }
        if (typeof provider !== 'string' || typeof model !== 'string') {
          throw new HttpError(400, 'gateway/bad-request', 'body.provider and body.model are required strings')
        }
        await agentDefaultModel.saveSelection({
          provider,
          model,
          ...(typeof reasoningEffort === 'string' ? { reasoningEffort: asReasoningEffort(reasoningEffort) } : {}),
        })
        json(res, 200, { selection: agentDefaultModel.currentSelection() })
      },
    },
    {
      method: 'GET',
      path: '/models/providers',
      async handler(_req, res) {
        const { providers } = await resolveProvidersNamespace()
        json(res, 200, { items: Object.entries(providers).map(([name, profile]) => ({ name, ...profile })) })
      },
    },
    {
      method: 'GET',
      path: '/models/providers/:name',
      async handler(_req, res, params) {
        const name = params.name!
        const { providers } = await resolveProvidersNamespace()
        const profile = providers[name]
        if (profile === undefined) throw new HttpError(404, 'provider/not-found', `provider "${name}" is not configured`)
        json(res, 200, { name, ...profile })
      },
    },
    {
      method: 'POST',
      path: '/models/providers',
      async handler(_req, res, _params, body) {
        const { name, displayName, api, baseURL, apiKeyEnv, models, ...rest } = (body ?? {}) as {
          name?: unknown
          displayName?: unknown
          api?: unknown
          baseURL?: unknown
          apiKeyEnv?: unknown
          models?: unknown
        } & Record<string, unknown>
        if (typeof name !== 'string' || !PROVIDER_NAME_PATTERN.test(name)) {
          throw new HttpError(400, 'gateway/bad-request', 'body.name must match /^[a-z0-9][a-z0-9-]*$/')
        }
        if (api !== undefined && typeof api !== 'string') throw new HttpError(400, 'gateway/bad-request', 'body.api must be a string (openai-completions | openai-responses | anthropic-messages | google-generative-ai)')
        if (baseURL !== undefined && typeof baseURL !== 'string') throw new HttpError(400, 'gateway/bad-request', 'body.baseURL must be a string')
        if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || !CREDENTIAL_REF_PATTERN.test(apiKeyEnv))) {
          throw new HttpError(400, 'gateway/bad-request', 'body.apiKeyEnv must be a POSIX env-var name (credential reference)')
        }
        const profile: ProviderProfile = {
          ...(typeof displayName === 'string' ? { displayName } : {}),
          ...(typeof api === 'string' ? { api } : {}),
          ...(typeof baseURL === 'string' ? { baseURL } : {}),
          ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}),
          ...(Array.isArray(models) ? { models: models as ProviderProfile['models'] } : {}),
          ...rest,
        }
        const { ns, revision, providers } = await resolveProvidersNamespace()
        if (providers[name] !== undefined) {
          throw new HttpError(409, 'provider/already-exists', `provider "${name}" already exists; use PATCH to update`)
        }
        await mutateProviders(ns, revision, [{ op: 'set', path: ['providers', name], value: profile }])
        json(res, 201, { name, ...profile })
      },
    },
    {
      method: 'PATCH',
      path: '/models/providers/:name',
      async handler(_req, res, params, body) {
        const name = params.name!
        const { ns, revision, providers } = await resolveProvidersNamespace()
        const current = providers[name]
        if (current === undefined) throw new HttpError(404, 'provider/not-found', `provider "${name}" is not configured`)
        const patch = (body ?? {}) as Record<string, unknown>
        if (patch.apiKeyEnv !== undefined && (typeof patch.apiKeyEnv !== 'string' || !CREDENTIAL_REF_PATTERN.test(patch.apiKeyEnv))) {
          throw new HttpError(400, 'gateway/bad-request', 'body.apiKeyEnv must be a POSIX env-var name')
        }
        const next: MutableProviderProfile = { ...current, ...patch }
        delete next.name
        await mutateProviders(ns, revision, [{ op: 'set', path: ['providers', name], value: next }])
        json(res, 200, { name, ...next })
      },
    },
    {
      method: 'DELETE',
      path: '/models/providers/:name',
      async handler(_req, res, params) {
        const name = params.name!
        const { ns, revision, providers } = await resolveProvidersNamespace()
        if (providers[name] === undefined) throw new HttpError(404, 'provider/not-found', `provider "${name}" is not configured`)
        await mutateProviders(ns, revision, [{ op: 'unset', path: ['providers', name] }])
        json(res, 200, { deleted: true, name })
      },
    },
    {
      method: 'POST',
      path: '/credentials',
      async handler(_req, res, _params, body) {
        const { ref, value } = (body ?? {}) as { ref?: unknown; value?: unknown }
        if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) {
          throw new HttpError(400, 'gateway/bad-request', 'body.ref must be a POSIX env-var name (credential reference)')
        }
        if (typeof value !== 'string' || value.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.value must be a non-empty string')
        }
        await credentials.set(asCredentialRef(ref), value)
        const info = await credentials.describe(asCredentialRef(ref))
        json(res, 201, { ref, configured: info.configured, source: info.source, masked: info.masked })
      },
    },
    {
      method: 'GET',
      path: '/credentials/:ref',
      async handler(_req, res, params) {
        const ref = params.ref!
        if (!CREDENTIAL_REF_PATTERN.test(ref)) throw new HttpError(400, 'gateway/bad-request', 'credential ref must be a POSIX env-var name')
        const info = await credentials.describe(asCredentialRef(ref))
        json(res, 200, { ref, ...info })
      },
    },
    {
      method: 'DELETE',
      path: '/credentials/:ref',
      async handler(_req, res, params) {
        const ref = params.ref!
        if (!CREDENTIAL_REF_PATTERN.test(ref)) throw new HttpError(400, 'gateway/bad-request', 'credential ref must be a POSIX env-var name')
        await credentials.unset(asCredentialRef(ref))
        json(res, 200, { deleted: true, ref })
      },
    },
  ]
}
