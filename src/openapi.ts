import type { RestApiConfig } from './types.ts'

/** Compact OpenAPI 3.1 description served at `/openapi.json` (auth-exempt). */
export function openapiDocument(config: RestApiConfig): Record<string, unknown> {
  const p = config.prefix
  const ref = (name: string) => ({ $ref: '#/components/schemas/Error' })
  return {
    openapi: '3.1.0',
    info: {
      title: 'DeepSeek Harness REST API',
      version: '0.1.0',
      description: 'RESTful control surface provided by the dsh-rest-api plugin. All non-public endpoints accept `Authorization: Bearer <apiKey>`; without a configured apiKey only loopback callers are admitted.',
    },
    servers: [{ url: p }],
    paths: {
      '/health': {
        get: { summary: 'Liveness probe (ok, healthy, dsh version, prefix, auth mode)', operationId: 'health', responses: { '200': { description: 'OK' } } },
      },
      '/openapi.json': {
        get: { summary: 'This document', operationId: 'openapi', responses: { '200': { description: 'OK' } } },
      },
      '/models': {
        get: { summary: 'List live provider routes and their models', operationId: 'listModels', responses: { '200': { description: 'OK' }, '401': ref('') } },
      },
      '/models/default': {
        get: { summary: 'Current default model selection', operationId: 'getDefaultModel', responses: { '200': { description: 'OK' } } },
        put: {
          summary: 'Set the default model selection',
          operationId: 'setDefaultModel',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['provider', 'model'], properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'OK' }, '400': ref('') },
        },
      },
      '/models/providers': {
        get: { summary: 'List configured custom providers (gateway plugin settings)', operationId: 'listCustomProviders', responses: { '200': { description: 'OK' }, '503': { description: 'No llm gateway namespace composed' } } },
        post: {
          summary: 'Add a custom OpenAI-compatible provider',
          operationId: 'createCustomProvider',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: {
              name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
              displayName: { type: 'string' },
              api: { type: 'string', enum: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] },
              baseURL: { type: 'string' },
              apiKeyEnv: { type: 'string', description: 'Credential reference (env-var name); set the value via POST /credentials' },
              models: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, input: { type: 'array', items: { type: 'string' } }, description: { type: 'string' } } } },
            } } } },
          },
          responses: { '201': { description: 'Created' }, '409': ref(''), '400': ref('') },
        },
      },
      '/models/providers/{name}': {
        get: { summary: 'Read one configured provider', operationId: 'getCustomProvider', parameters: [nameParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
        patch: {
          summary: 'Update one configured provider (merge patch)',
          operationId: 'updateCustomProvider',
          parameters: [nameParam],
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'OK' }, '404': ref('') },
        },
        delete: { summary: 'Remove one configured provider', operationId: 'deleteCustomProvider', parameters: [nameParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
      },
      '/credentials': {
        post: {
          summary: 'Store a credential value (API key) under a reference name',
          operationId: 'setCredential',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ref', 'value'], properties: { ref: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, value: { type: 'string' } } } } } },
          responses: { '201': { description: 'Created' }, '400': ref('') },
        },
      },
      '/credentials/{ref}': {
        get: { summary: 'Describe a credential (masked, never the value)', operationId: 'describeCredential', parameters: [refParam], responses: { '200': { description: 'OK' } } },
        delete: { summary: 'Remove a stored credential', operationId: 'deleteCredential', parameters: [refParam], responses: { '200': { description: 'OK' } } },
      },
      '/projects': {
        get: { summary: 'List projects (workspaces)', operationId: 'listProjects', responses: { '200': { description: 'OK' } } },
        post: {
          summary: 'Register a project directory (idempotent per canonical path)',
          operationId: 'createProject',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, title: { type: 'string' } } } } } },
          responses: { '201': { description: 'Created' }, '200': { description: 'Already registered' }, '400': ref('') },
        },
      },
      '/projects/{id}': {
        get: { summary: 'Project details', operationId: 'getProject', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
        patch: { summary: 'Rename a project', operationId: 'renameProject', parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '404': ref('') } },
        delete: { summary: 'Unregister a project (session logs kept)', operationId: 'deleteProject', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
      },
      '/projects/{id}/sessions': {
        get: { summary: 'Sessions of a project, ordered as in the WebUI', operationId: 'listProjectSessions', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
        post: {
          summary: 'Create a session inside a project',
          operationId: 'createSession',
          parameters: [idParam],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { sessionId: { type: 'string', description: 'Adopt a named blank session' }, agentPreset: { type: 'string' }, title: { type: 'string' } } } } } },
          responses: { '201': { description: 'Created' }, '404': ref('') },
        },
      },
      '/sessions': {
        get: { summary: 'All visible sessions with project association', operationId: 'listSessions', responses: { '200': { description: 'OK' } } },
      },
      '/sessions/{id}': {
        get: { summary: 'Session state (title, running, queue, pending input)', operationId: 'getSession', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
        patch: { summary: 'Rename a session', operationId: 'renameSession', parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': ref(''), '404': ref('') } },
        delete: {
          summary: 'Archive a session (query stopActivity=true to stop running work first)',
          operationId: 'archiveSession',
          parameters: [idParam, { name: 'stopActivity', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
          responses: { '200': { description: 'OK' }, '404': ref(''), '409': ref('') },
        },
      },
      '/sessions/{id}/events': {
        get: {
          summary: 'Paged durable event history (ascending by seq)',
          operationId: 'listSessionEvents',
          parameters: [idParam, { name: 'afterSeq', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000 } }],
          responses: { '200': { description: 'OK' }, '404': ref('') },
        },
      },
      '/sessions/{id}/messages': {
        get: {
          summary: 'Projected message history (user/assistant with text, reasoning, and tool parts incl. derived run state)',
          operationId: 'listSessionMessages',
          parameters: [idParam, { name: 'afterSeq', in: 'query', schema: { type: 'integer', minimum: 0 } }],
          responses: { '200': { description: 'OK' }, '404': ref('') },
        },
        post: {
          summary: 'Send a prompt (async 202 by default; wait=true blocks until the turn settles). Text beginning with "/skill-name" invokes a user-invocable skill.',
          operationId: 'promptSession',
          parameters: [idParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: {
            text: { type: 'string' },
            mode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
            wait: { type: 'boolean', default: false },
            timeoutMs: { type: 'integer', description: 'Only with wait=true; default 120000' },
            model: { type: 'string', description: 'Switch this session\'s model first' },
            reasoningEffort: { type: 'string' },
            clientTimeZone: { type: 'string' },
          } } } } },
          responses: { '202': { description: 'Accepted (async)' }, '200': { description: 'Turn settled (wait=true)' }, '409': ref('') },
        },
      },
      '/sessions/{id}/cancel': {
        post: { summary: 'Cancel the running turn', operationId: 'cancelSession', parameters: [idParam], responses: { '200': { description: 'OK' } } },
      },
      '/sessions/{id}/open': {
        post: {
          summary: 'Ask every online WebUI tab to switch its main view to this session (202 = delivered to the push stream; delivered=false means no tab is subscribed)',
          operationId: 'openSession',
          parameters: [idParam],
          responses: { '202': { description: 'Accepted (fire-and-forget; the UI switch is not awaited)' }, '404': ref('') },
        },
      },
      '/sessions/{id}/stream': {
        get: {
          summary: 'SSE stream of durable session events (event: session, id = seq) plus live assistant deltas (event: delta). Resumes with Last-Event-ID or ?afterSeq=.',
          operationId: 'streamSession',
          parameters: [idParam, { name: 'afterSeq', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'deltas', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'true' } }],
          responses: { '200': { description: 'text/event-stream' }, '404': ref('') },
        },
      },
      '/stream': {
        get: {
          summary: 'Global live-only SSE fan-out across all sessions (event payloads carry sessionId; no replay or Last-Event-ID resume)',
          operationId: 'streamAllSessions',
          parameters: [{ name: 'deltas', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'true' } }],
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/approvals': {
        get: { summary: 'Pending tool-approval asks (claimed by this plugin; answer via POST /approvals/{id}/respond)', operationId: 'listApprovals', responses: { '200': { description: 'OK' } } },
      },
      '/approvals/{id}/respond': {
        post: {
          summary: 'Answer one pending approval (unanswered asks settle cancelled after 15 minutes)',
          operationId: 'respondApproval',
          parameters: [idParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['outcome'], properties: { outcome: { type: 'string', enum: ['allowed-once', 'rejected'] } } } } } },
          responses: { '200': { description: 'OK' }, '400': ref(''), '404': ref('') },
        },
      },
      '/sessions/{id}/skills': {
        get: { summary: 'User-invocable skills visible to this session', operationId: 'listSessionSkills', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': ref('') } },
      },
      '/skills': {
        get: { summary: 'Skill catalog (query cwd to include project-layer skills)', operationId: 'listSkills', parameters: [{ name: 'cwd', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
        post: {
          summary: 'Create a skill file (user layer by default, project layer with cwd)',
          operationId: 'createSkill',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'description', 'body'], properties: {
            name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
            description: { type: 'string' },
            body: { type: 'string', description: 'Markdown instruction body' },
            whenToUse: { type: 'string' },
            modelInvocable: { type: 'boolean', default: true },
            userInvocable: { type: 'boolean', default: true },
            layer: { type: 'string', enum: ['user', 'project'], default: 'user' },
            cwd: { type: 'string', description: 'Required when layer=project' },
          } } } } },
          responses: { '201': { description: 'Created' }, '400': ref(''), '409': ref('') },
        },
      },
      '/skills/{name}': {
        get: { summary: 'Full skill definition (content included)', operationId: 'getSkill', parameters: [nameParam, { name: 'cwd', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': ref('') } },
        patch: {
          summary: 'Update a skill (body, description, whenToUse, or invocation flags)',
          operationId: 'updateSkill',
          parameters: [nameParam, { name: 'cwd', in: 'query', schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
            description: { type: 'string' },
            body: { type: 'string' },
            whenToUse: { type: 'string' },
            modelInvocable: { type: 'boolean' },
            userInvocable: { type: 'boolean' },
          } } } } },
          responses: { '200': { description: 'OK' }, '404': ref(''), '409': ref('') },
        },
        delete: { summary: 'Delete a filesystem-layer skill', operationId: 'deleteSkill', parameters: [nameParam, { name: 'cwd', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': ref(''), '409': ref('') } },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { code: { type: 'string', examples: ['session/not-found'] }, message: { type: 'string' } }, required: ['code', 'message'] } },
          required: ['error'],
        },
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ bearerAuth: [] }],
  }
}

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
const refParam = { name: 'ref', in: 'path', required: true, schema: { type: 'string' } }
