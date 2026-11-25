# dsh-rest-api

[中文](./README.md) | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A standard RESTful API for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)'s `dsh web`: model configuration, projects, sessions (async / SSE streaming / skill invocation), tool-call approvals, and skill management.

The REST API runs in the **same dsh process and on the same data** as the official WebUI: projects / sessions / messages created over REST appear live in the WebUI at [http://127.0.0.1:3080](http://127.0.0.1:3080), and vice versa.

## Contents

- [Features](#features)
- [Install](#install)
- [Auth](#auth)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)
- [License](#license)

## Features

| Resource | Capabilities |
|---|---|
| **Models** `/models` | Live provider/model catalog + default model |
| | CRUD for custom OpenAI-compatible providers (written to settings, hot-reloaded, synced with the WebUI settings page) |
| | API key credential management (`POST /credentials`, responses are masked) |
| **Projects** `/projects` | Directory registration (idempotent by canonical path), rename, delete, session ledger |
| **Sessions** `/projects/:id/sessions` | Create (cwd = project directory), list, status, rename |
| | `POST /sessions/:id/messages` async send (202) or `wait=true` to block until the turn ends |
| | Message text accepts `/skill-name args` to invoke user-invocable skills visible to the session |
| | `POST /sessions/:id/cancel` to stop, `DELETE` to archive |
| | `POST /sessions/:id/open` pushes the session to the foreground of online WebUI tabs |
| | `GET /sessions/:id/stream` **SSE**: durable event replay + live assistant deltas, `Last-Event-ID` resumption |
| | `GET /sessions/:id/messages` message projection (user/assistant with text/reasoning/tool parts and tool run state) |
| **Global stream** `GET /stream` | Live-only SSE fan-out across all sessions (payloads carry `sessionId`) |
| **Approvals** `/approvals` | Tool-call approvals: pending list + respond (allow / reject) |
| **Skills** `/skills` | Catalog (source layer / invocation policy), create (user / project layer), update, toggle auto-invocation, delete |

Errors are uniformly `{"error": {"code": "...", "message": "..."}}`, with codes following dsh's `<domain>/<reason>` style (e.g. `session/not-found`). A machine-readable OpenAPI 3.1 description is served at `GET /rest/v1/openapi.json`.

## Install

### Option 1: install as a profile plugin (recommended)

```sh
dsh plugin --profile web add dsh-rest-api   # npm package / tgz / local directory all work
dsh web
```

### Option 2: dev mode via --patch (hot-load without installing)

```sh
npm install && npm run build
# After editing the absolute paths in dev.patch.yml:
npx @deepseek-ai/dsh@next web --patch ./dev.patch.yml --port 3080 --no-open
```

> Requires the `web` profile (provides webServer). The plugin declares injections for `webServer / sessionController / workspaceRegistry / llm / agentDefaultModel / credentials / skills / sessionSkillCatalog / settingsController / settings`; it will not load on a profile missing any of these services.

## Auth

- With `apiKey` configured: every request needs `Authorization: Bearer <apiKey>` (except `/health` and `/openapi.json`).
- Without it: **loopback-only access** (fail closed).

Injecting the token via an environment variable is recommended:

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
    - id: rest-api
      name: dsh-rest-api
      config:
        apiKey: !!js process.env.DSH_REST_API_KEY
```

```sh
DSH_REST_API_KEY=$(openssl rand -hex 32) dsh web
curl -H "Authorization: Bearer $DSH_REST_API_KEY" http://127.0.0.1:3080/rest/v1/models
```

## Quick start

```sh
B=http://127.0.0.1:3080/rest/v1

# 1. Register a project
curl -sX POST $B/projects -H 'content-type: application/json' \
  -d '{"path": "/repo/my-project", "title": "My Project"}'
PID=<project id>

# 2. Create a session (the project directory becomes the session cwd)
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"title": "REST session"}'
SID=<session id>

# 3. Send a message asynchronously (returns 202 + requestId immediately)
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "Summarize the package structure of this repo"}'

# 4. Subscribe via SSE (durable events + live deltas, auto-resume on reconnect)
curl -sN $B/sessions/$SID/stream

# 5. Invoke a skill (slash form triggers a user-invocable skill)
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "/my-skill some args"}'

# 6. Stop the current turn
curl -sX POST $B/sessions/$SID/cancel
```

A full end-to-end script is available at [`examples/demo.sh`](./examples/demo.sh).

### SSE event model

`GET /rest/v1/sessions/:id/stream?afterSeq=N&deltas=true`

- `event: session` — durable session events (`{type, seq, time, data}`); the SSE `id` is `seq`
- `event: delta` — live assistant stream deltas (`agent/assistant-stream` frames: `text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / …); transient frames carry no id
- 15s heartbeat comments; on reconnect, `Last-Event-ID` or `?afterSeq=` resumes from the last received event with no gaps
- History is also available via paginated `GET /sessions/:id/events?afterSeq=&limit=`, or as projected message views via `GET /sessions/:id/messages`

The global stream `GET /rest/v1/stream?deltas=true` uses the same frame types, but payloads additionally carry `sessionId`, it covers **all** sessions, and it is live-only: no replay, no `Last-Event-ID` resumption; after a disconnect the client reconciles via paginated REST reads.

### Pushing a session to the WebUI foreground

```sh
curl -si -X POST $B/sessions/$SID/open
# => HTTP/1.1 202 Accepted
#    {"sessionId":"…","accepted":true,"delivered":true,"requestId":"…"}
```

- `202` means "delivered, switch not confirmed" — the actual opening happens in the browser.
- `delivered` indicates whether at least one subscribed WebUI tab existed at push time; `false` = no tab is online, the request is accepted but nobody will see it.
- All online tabs receive the push and switch independently; pushes are live-only — no caching, no replay.
- Implementation relies on the plugin's WebUI client module (injected via `dsh.client`): the module subscribes to the `restApi/open-requests` stream and calls `uiWorkspace.openSession` on each frame.

### Tool-call approvals

When a tool call inside a session triggers a dsh approval (`ask` policy, sandbox escalation, etc.), the request is taken over and held by this plugin until a REST client responds:

```sh
# Poll pending approvals (or watch for approval events on /stream)
curl -s $B/approvals
# => {"items":[{"id":"…","sessionId":"…","toolName":"bash","callId":"…","reason":"…","askedAt":1700000000000}]}

curl -sX POST $B/approvals/<id>/respond -H 'content-type: application/json' \
  -d '{"outcome": "allowed-once"}'   # or "rejected"
```

- Once registered as the approval answerer, the plugin **takes over all approvals**: other answerers (such as the WebUI dialog) no longer receive asks — REST is the only response channel.
- Unanswered requests settle as `cancelled` after 15 minutes; the same applies when the tool call is cancelled / aborted (fail closed).

### Model configuration

```sh
# Store an API key (ref name = env-var-name style)
curl -sX POST $B/credentials -H 'content-type: application/json' \
  -d '{"ref": "MY_GATEWAY_KEY", "value": "sk-..."}'

# Register a custom OpenAI-compatible provider (written to settings, hot-reloaded)
curl -sX POST $B/models/providers -H 'content-type: application/json' -d '{
  "name": "my-gateway",
  "displayName": "My Gateway",
  "api": "openai-completions",
  "baseURL": "https://gateway.example.com/v1",
  "apiKeyEnv": "MY_GATEWAY_KEY",
  "models": [{"id": "my-model", "input": ["text"]}]
}'

# Switch the default model
curl -sX PUT $B/models/default -H 'content-type: application/json' \
  -d '{"provider": "my-gateway", "model": "my-model"}'
```

### Skill management

```sh
# Create (defaults to the user layer ~/.dsh/skills/<name>/SKILL.md; layer=project requires cwd)
curl -sX POST $B/skills -H 'content-type: application/json' -d '{
  "name": "deploy-check",
  "description": "Check deployment status and summarize",
  "whenToUse": "When the user asks about deployment status",
  "body": "# Deploy Check\n\n1. Read deploy status ...",
  "layer": "user"
}'

# Disable model auto-invocation (manual /deploy-check still works)
curl -sX PATCH $B/skills/deploy-check -H 'content-type: application/json' \
  -d '{"modelInvocable": false}'

# User-invocable skills visible to a session
curl -sX $B/sessions/<sid>/skills
```

New files are picked up automatically by the skill-filesystem watcher (`skills/change`) — no restart needed; skills from bundled / runtime sources are read-only (409).

## API reference

```text
GET    /rest/v1/health                        GET    /rest/v1/openapi.json
GET    /rest/v1/models                        GET/PUT /rest/v1/models/default
GET/POST /rest/v1/models/providers            GET/PATCH/DELETE /rest/v1/models/providers/:name
POST   /rest/v1/credentials                   GET/DELETE /rest/v1/credentials/:ref
GET/POST /rest/v1/projects                    GET/PATCH/DELETE /rest/v1/projects/:id
GET/POST /rest/v1/projects/:id/sessions       GET    /rest/v1/sessions
GET/PATCH /rest/v1/sessions/:id               DELETE /rest/v1/sessions/:id[?stopActivity=true]
GET    /rest/v1/sessions/:id/events           GET    /rest/v1/sessions/:id/messages
POST   /rest/v1/sessions/:id/messages         POST   /rest/v1/sessions/:id/cancel
POST   /rest/v1/sessions/:id/open
GET    /rest/v1/sessions/:id/stream (SSE)     GET    /rest/v1/stream (SSE, all sessions)
GET    /rest/v1/approvals                     POST   /rest/v1/approvals/:id/respond
GET    /rest/v1/sessions/:id/skills           GET/POST /rest/v1/skills
GET/PATCH/DELETE /rest/v1/skills/:name[?cwd=]
```

## Configuration

| Field | Default | Description |
|---|---|---|
| `apiKey` | `null` | Bearer token; `null` = loopback only |
| `prefix` | `/rest/v1` | Route prefix (absolute path) |

## Design notes

- Same-process sync with the WebUI: all session / project operations go through official in-process services such as `sessionController` / `workspaceRegistry`; the WebUI refreshes via its own observe streams — no extra event bridge.
- SSE deltas come from global subscriptions (`{global: true}`, matching dsh's own session-controller approach) to `session/event` (durable) and `agent/assistant-stream` (transient); the subscription is established before replay with watermark dedup, guaranteeing a seamless join.
- Custom providers are written via `settingsController.mutate` into the llm gateway plugin's volatile `providers` config (persisted in the profile patch + hot-reloaded by the Loader) — the same write path as the WebUI settings page.
- Approvals are exposed as an in-process answerer for `approval/request` waterfall events: claimed, then held until a REST response arrives; ids are plugin-signed (waterfall events carry no service id), while auditing still lands as paired durable `approval/asked` / `approval/decided` events.
- The message projection (`GET /sessions/:id/messages`) is a pure fold over durable events: a `tool/call` with no matching `tool/result` is `running`; `tool/result.isError` or an event-level `error` is `error`.
- Session files follow a single-writer model: the plugin only touches sessions through official APIs and never opens JSONL / Zstd logs directly.
- The "open session" push does not forward events via `ctx.remote.$on` (only one forward source per Host, owned by `dsh-api-remotes`); instead the plugin serves its own SRC Remote stream `restApi/open-requests`, auto-exposed server-side via Typert Gateway SRC reflection and subscribed manually by the WebUI client module's stream contribution.

## Known limitations

- Verified against the npm release of dsh (0.2.2-rc.x); the webServer `auth` field newly added on master is handled for compatibility.
- Sessions not attached to a project cannot be archived over REST (409 with a hint).
- Output text for `wait=true` is extracted from the durable event stream; very long output may be truncated (a `truncated` flag is present in state).
- dsh has no message-delete semantics, so projected message views contain no deletion events (compaction's `surfaceOp` replace is handled).

## License

MIT
