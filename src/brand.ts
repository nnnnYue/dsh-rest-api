/**
 * Cast helpers for dsh's branded id/JSON types. Wire strings arriving from
 * REST are validated structurally by the routers before reaching these casts.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export const asSessionId = (value: string): SessionId => value as never
export const asSessionRequestId = (value: string): SessionRequestId => value as never
export const asWorkspaceId = (value: string): WorkspaceId => value as never
export const asCredentialRef = (value: string): CredentialRef => value as never
export const asReasoningEffort = (value: string): ReasoningEffortId => value as never
export const asJsonValue = (value: unknown): JsonValue => value as never
