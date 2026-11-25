/**
 * Session-scoped model selection: parse REST input, validate it against the
 * live llm catalog, and record it on the session only — never on the global
 * default. The validate-then-`agent.model.select()` sequence mirrors what the
 * host's own ACP transport does; `sessionController.selectModel` is avoided
 * because it also overwrites the global default model.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { HttpError } from './errors.ts'
import { NEVER_ABORT } from './util.ts'
import { asReasoningEffort, asSessionId } from './brand.ts'
import type { Deps } from './types.ts'

/** Optional `{provider, model, reasoningEffort}` fields as they arrive on a REST body. */
export interface ModelSelectionInput {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Complete selection after provider inference and validation. */
export interface ResolvedSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Wire shape of a dsh `ModelSelection` (branded effort id, duck-typed here). */
interface HostSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'gateway/bad-request', `body.${field} must be a non-empty string`)
  }
  return value
}

/** Parse the optional fields; `undefined` when the body names none of them. */
export function modelSelectionInput(body: unknown): ModelSelectionInput | undefined {
  const raw = (body ?? {}) as Record<string, unknown>
  const fields = {
    provider: optionalString(raw.provider, 'provider'),
    model: optionalString(raw.model, 'model'),
    reasoningEffort: optionalString(raw.reasoningEffort, 'reasoningEffort'),
  }
  if (fields.provider === undefined && fields.model === undefined && fields.reasoningEffort === undefined) return undefined
  return {
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.reasoningEffort !== undefined ? { reasoningEffort: fields.reasoningEffort } : {}),
  }
}

/** The global default selection as a plain wire object. */
export function defaultSelection(deps: Deps): ResolvedSelection {
  const current = deps.agentDefaultModel.currentSelection()
  return {
    provider: current.provider,
    model: current.model,
    ...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
  }
}

/** Effort ids the adapter declares for the route, for the rejection message. */
async function supportedEfforts(llm: LlmRuntime, provider: string, model: string): Promise<string[]> {
  try {
    const info = await llm.resolveModelInfo(provider, model, NEVER_ABORT)
    return (info.reasoning?.efforts ?? []).map((effort) => String(effort.id))
  } catch {
    return []
  }
}

/**
 * Merge the request onto `base` (the session's current selection) and
 * validate the result: the route must be listed by the provider catalog and
 * the effort must be one the adapter declares for that model — the same two
 * checks the host's own `selectModel` performs before recording. Omitted
 * fields inherit `base`; a model without a provider is looked up across the
 * catalog and rejected as ambiguous when several providers offer it.
 */
export async function resolveModelSelection(llm: LlmRuntime, input: ModelSelectionInput, base: HostSelection | undefined): Promise<ResolvedSelection> {
  const model = input.model ?? base?.model
  if (model === undefined) {
    throw new HttpError(400, 'model/not-found', 'body.model is required: this session has no model to inherit')
  }
  let provider = input.provider ?? base?.provider
  if (provider === undefined) {
    const matches: string[] = []
    for (const entry of llm.listProviders()) {
      try {
        if ((await llm.listModels(entry.id)).some((candidate) => candidate.id === model)) matches.push(entry.id)
      } catch {
        // A provider whose catalog is unavailable simply does not offer the model.
      }
    }
    if (matches.length === 0) throw new HttpError(400, 'model/not-found', `no configured provider offers model "${model}"`)
    if (matches.length > 1) {
      throw new HttpError(400, 'model/ambiguous', `model "${model}" is offered by multiple providers (${matches.join(', ')}); pass body.provider`)
    }
    provider = matches[0]!
  }
  // Catalog membership is only checked for requests that name a route; an
  // effort-only change rides on whatever the session already selects.
  if (input.provider !== undefined || input.model !== undefined) {
    const listed = await llm.listModels(provider)
      .then((items) => items.some((candidate) => candidate.id === model))
      .catch(() => false)
    if (!listed) throw new HttpError(400, 'model/not-found', `provider "${provider}" does not offer model "${model}"`)
  }
  const selected: ResolvedSelection = {
    provider,
    model,
    ...(input.reasoningEffort !== undefined
      ? { reasoningEffort: input.reasoningEffort }
      : base?.reasoningEffort !== undefined ? { reasoningEffort: base.reasoningEffort } : {}),
  }
  try {
    await llm.resolveCallConfig({
      provider,
      model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: asReasoningEffort(selected.reasoningEffort) } : {}),
    }, NEVER_ABORT)
  } catch (error: unknown) {
    const code = (error as { code?: unknown })?.code
    if (code === 'UNSUPPORTED_REASONING_EFFORT') {
      const efforts = await supportedEfforts(llm, provider, model)
      const listed = efforts.length > 0 ? ` (supported: ${efforts.join(', ')})` : ''
      throw new HttpError(400, 'model/reasoning-effort-unsupported',
        `provider "${provider}" model "${model}" does not support reasoning effort "${selected.reasoningEffort}"${listed}`)
    }
    if (code === 'NO_ADAPTER') {
      throw new HttpError(400, 'model/not-found', `no configured provider offers route "${provider}/${model}"`)
    }
    throw error
  }
  return selected
}

async function liveAgent(deps: Deps, sessionId: string): Promise<Agent> {
  const found = await deps.sessionController.resolveAgent(asSessionId(sessionId))
  if ('error' in found) throw found.error
  return found.agent
}

function toHostSelection(selected: ResolvedSelection): ModelSelection {
  return {
    provider: selected.provider,
    model: selected.model,
    ...(selected.reasoningEffort !== undefined ? { reasoningEffort: asReasoningEffort(selected.reasoningEffort) } : {}),
  }
}

/** Record a pre-validated selection on the session (never the global default). */
export async function recordSessionModel(deps: Deps, sessionId: string, selected: ResolvedSelection): Promise<void> {
  const agent = await liveAgent(deps, sessionId)
  agent.model.select(toHostSelection(selected))
}

/** Validate the request against the session's live selection, then record it. */
export async function selectSessionModel(deps: Deps, sessionId: string, input: ModelSelectionInput): Promise<ResolvedSelection> {
  const agent = await liveAgent(deps, sessionId)
  const current = agent.model.current()
  const base = current === undefined ? undefined : {
    provider: current.provider,
    model: current.model,
    ...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
  }
  const selected = await resolveModelSelection(deps.llm, input, base)
  agent.model.select(toHostSelection(selected))
  return selected
}

/**
 * The selection the session's next model step uses: the recorded fold's
 * `next` from a non-activating projections read, falling back to the global
 * default while the session still follows it.
 */
export async function sessionModelSelection(deps: Deps, sessionId: string): Promise<ResolvedSelection | undefined> {
  const value = await deps.sessionController.projections({ sessionId: asSessionId(sessionId) }, NEVER_ABORT)
  const next = (value?.values as { modelSelection?: { next?: HostSelection | null } | undefined } | undefined)?.modelSelection?.next
  if (next !== null && next !== undefined && typeof next.provider === 'string' && typeof next.model === 'string') {
    return {
      provider: next.provider,
      model: next.model,
      ...(typeof next.reasoningEffort === 'string' ? { reasoningEffort: next.reasoningEffort } : {}),
    }
  }
  return defaultSelection(deps)
}
