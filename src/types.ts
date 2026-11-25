/**
 * Plugin configuration and the typed dependency bundle shared by route modules.
 *
 * All dsh service types are imported with `import type` only: at runtime this
 * plugin resolves services through Cordis DI (`inject`), so it carries zero
 * runtime npm dependencies and works inside any composition that provides them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController, SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SettingsController } from '@deepseek-ai/dsh-api-settings-controller'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { RestApiRemotes } from './remotes.ts'

/** Resolved plugin configuration after schema validation. */
export interface RestApiConfig {
  /** Bearer token required on every request; `null` permits loopback-only access. */
  readonly apiKey: string | null
  /** Absolute pathname prefix (no trailing slash) that owns the REST surface. */
  readonly prefix: string
}

/** Minimal structural shape of a Standard Schema validator (schema.org/spec v1). */
export interface ConfigSchemaLike<T> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly value?: undefined; readonly issues: readonly { readonly message: string }[] }
  }
}

export const DEFAULT_PREFIX = '/rest/v1'

/**
 * Hand-rolled Standard Schema validator. Cordis applies it to the raw config
 * before `apply` runs, so the plugin needs no runtime schemastery dependency.
 */
export const ConfigSchema: ConfigSchemaLike<RestApiConfig> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-rest-api',
    validate(value) {
      const raw = (value ?? {}) as Record<string, unknown>
      const issues: { message: string }[] = []
      let apiKey: string | null = null
      if (raw.apiKey !== undefined && raw.apiKey !== null) {
        if (typeof raw.apiKey !== 'string' || raw.apiKey.length === 0) {
          issues.push({ message: 'config.apiKey must be a non-empty string or null' })
        } else {
          apiKey = raw.apiKey
        }
      }
      let prefix = DEFAULT_PREFIX
      if (raw.prefix !== undefined && raw.prefix !== null) {
        if (typeof raw.prefix !== 'string' || !raw.prefix.startsWith('/') || raw.prefix === '/') {
          issues.push({ message: 'config.prefix must be an absolute pathname like "/rest/v1"' })
        } else {
          prefix = ('/' + raw.prefix.replace(/^\/+|\/+$/g, '')) || DEFAULT_PREFIX
        }
      }
      if (issues.length > 0) return { issues }
      return { value: { apiKey, prefix } }
    },
  },
}

/**
 * Every host service the REST surface consumes, all optional at the type level:
 * route modules receive a bundle where missing services were filtered out at
 * load time by Cordis (`inject`) — apply() never runs without them.
 */
export interface Deps {
  readonly ctx: Context
  readonly config: RestApiConfig
  readonly webServer: WebServer
  readonly sessionController: SessionController
  readonly workspaceRegistry: WorkspaceRegistry
  readonly llm: LlmRuntime
  readonly agentDefaultModel: AgentDefaultModelConfig
  readonly credentials: CredentialProvider
  readonly skills: SkillRegistry
  readonly sessionSkillCatalog: SessionSkillCatalog
  readonly settingsController: SettingsController
  readonly settings: SettingsForms
  /** Plugin-owned push channel toward WebUI client modules. */
  readonly remotes: RestApiRemotes
}

/** Route registration shape bridging published (0.2.2-rc.x) and master webserver. */
export interface RouteRegistration {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  /** Master-only field; rc.x runtimes ignore it. */
  readonly auth?: 'anonymous' | 'required' | 'deny'
}
