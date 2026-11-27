# dsh-rest-api

[中文](./README.md) | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A REST API for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)'s `dsh web`. It manages models, projects, sessions, tool approvals, and skills. The API and the web UI share one process and one data set. Projects, sessions, and messages created over REST appear live in the web UI at [http://127.0.0.1:3080](http://127.0.0.1:3080), and the other way around.

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
| **Models** `/models` | List the model catalog and the default model |
| | Manage custom OpenAI-compatible providers, synced with the web settings page and applied immediately |
| | Manage API keys, with masked responses |
| **Projects** `/projects` | Register directories, rename, delete, list sessions; duplicate registration is ignored |
| **Sessions** `/projects/:id/sessions` | Create, list, check status, rename, stop, archive; the project directory becomes the working directory |
| | Send messages asynchronously, or add `wait=true` to wait for the turn; set the model and effort |
| | Use `/skill-name args` to invoke a skill available to the session |
| | Open the session in the web UI, optionally on a panel, and wait for a browser receipt |
| | Stream saved events and live output over SSE, with resume after a disconnect |
| | Read the assembled message history, including text, reasoning, tool calls, and run state |
| **Global stream** `/stream` | One SSE connection for live events from all sessions |
| **Approvals** `/approvals` | List pending tool calls, allow or reject |
| **Skills** `/skills` | List, create, update, toggle auto-invocation, delete |

Errors are always `{"error": {"code": "...", "message": "..."}}`, with codes like `session/not-found`. The full API description is at `GET /rest/v1/openapi.json`.

## Install

### Option 1: install as a profile plugin

```sh
dsh plugin --profile web add dsh-rest-api
dsh web
```

### Option 2: dev mode

```sh
npm install && npm run build
# Edit the absolute paths in dev.patch.yml
npx @deepseek-ai/dsh@next web --patch ./dev.patch.yml --port 3080 --no-open
```

> Requires the `web` profile and dsh's built-in web server, session, workspace, model, credential, and skill services.

## Auth

- With `apiKey` set, requests need `Authorization: Bearer <apiKey>`. The exceptions are `/health`, `/openapi.json`, and the browser receipt endpoint, which uses a one-time key.
- Without `apiKey`, only local access is allowed.

Passing the token through an environment variable is convenient:

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

# 2. Create a session; the project directory is the working directory
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"title": "REST session"}'
SID=<session id>

# 3. Send a message asynchronously
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "Summarize the package structure of this repo"}'

# 4. Subscribe over SSE
curl -sN $B/sessions/$SID/stream

# 5. Invoke a skill
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "/my-skill some args"}'

# 6. Stop the current turn
curl -sX POST $B/sessions/$SID/cancel
```

A full end-to-end script is available at [`examples/demo.sh`](./examples/demo.sh).

### SSE events

`GET /rest/v1/sessions/:id/stream?afterSeq=N&deltas=true`

- `event: session`: a saved event; the SSE `id` is `seq`.
- `event: delta`: live assistant output without an id.
- A heartbeat is sent every 15 seconds. On reconnect, pass `Last-Event-ID` or `?afterSeq=` to resume.
- Read history with paginated `GET /sessions/:id/events`, or use `GET /sessions/:id/messages` for assembled messages.

The global stream `GET /rest/v1/stream` uses the same format, with a `sessionId` on each event. It covers all sessions and sends live events only. After a disconnect, the client catches up with paginated REST reads.

### Opening a session in the web UI

A web UI opened with `?dshTarget=<key>` responds only to requests for that target or `"*"`.

```sh
# Open on a specific panel; wait=true waits for the browser receipt
curl -si -X POST $B/sessions/$SID/open -H 'content-type: application/json' \
  -d '{"target":"panel-7f3a","wait":true}'
# => HTTP/1.1 200 OK
#    {"sessionId":"…","requestId":"…","mode":"targeted","target":"panel-7f3a","opened":true,"ackedBy":[…]}

# Broadcast to every panel
curl -sX POST $B/sessions/$SID/open -H 'content-type: application/json' -d '{"target":"*"}'

# With one panel online, target can be omitted; with several, it returns 409
curl -sX POST $B/sessions/$SID/open
```

- `202 + opened:false` means the request was accepted but not confirmed. `reason` is `no-client`, `timeout`, or `client-error`.
- Without a target, the response includes `delivered`, which only says a subscription existed at push time. Check `opened` or `ackedBy`, or query `GET /open-requests/:requestId`, for confirmation.
- After opening the session, the browser calls the receipt endpoint, which is checked with a one-time key.
- `openPolicy: broadcast` restores the old broadcast-to-all behavior. The default `auto` returns 409 when several panels are online and no target is given.
- Reload every web UI tab after upgrading the plugin.

### Tool approvals

When a tool call triggers a dsh approval, the plugin takes over the request and pauses it until a REST client responds:

```sh
# List pending approvals
curl -s $B/approvals
# => {"items":[{"id":"…","sessionId":"…","toolName":"bash","callId":"…","reason":"…","askedAt":1700000000000}]}

curl -sX POST $B/approvals/<id>/respond -H 'content-type: application/json' \
  -d '{"outcome": "allowed-once"}'   # or "rejected"
```

- The plugin handles all approvals; the web UI dialog and other responders no longer receive requests.
- An unanswered request is settled as `cancelled` after 15 minutes. The same happens when the tool call is cancelled or aborted.

### Model configuration

```sh
# Save an API key
curl -sX POST $B/credentials -H 'content-type: application/json' \
  -d '{"ref": "MY_GATEWAY_KEY", "value": "sk-..."}'

# Register a custom OpenAI-compatible provider
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

### Session-scoped model and reasoning effort

A session's model and reasoning effort belong to that session only. None of the calls below change the global default model.

```sh
# Set at creation
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"model": "deepseek-v4-pro", "reasoningEffort": "max"}'

# Change only the effort
# Or change the model; provider is inferred when omitted, and the same model on several providers returns 400
curl -sX PATCH $B/sessions/$SID -H 'content-type: application/json' -d '{"reasoningEffort": "low"}'
curl -sX PATCH $B/sessions/$SID -H 'content-type: application/json' \
  -d '{"provider": "deepseek-official", "model": "deepseek-flash"}'

# Read back the session selection
curl -s $B/sessions/$SID
```

- The fields are `{provider, model, reasoningEffort?}`. Omitted fields keep the session's current values.
- Changes take effect from the next model call, and a running session can be switched at any time.
- `GET /models` returns the reasoning efforts each model supports.
- Validation failures return 400: `model/not-found`, `model/ambiguous`, `model/reasoning-effort-unsupported`.
- Changing only `reasoningEffort` also pins the current default model to that session.

### Skill management

```sh
# Create a skill; it defaults to the user layer
curl -sX POST $B/skills -H 'content-type: application/json' -d '{
  "name": "deploy-check",
  "description": "Check deployment status and summarize",
  "whenToUse": "When the user asks about deployment status",
  "body": "# Deploy Check\n\n1. Read deploy status ...",
  "layer": "user"
}'

# Disable model auto-invocation; manual /deploy-check still works
curl -sX PATCH $B/skills/deploy-check -H 'content-type: application/json' \
  -d '{"modelInvocable": false}'

# List the skills a session can use
curl -sX $B/sessions/<sid>/skills
```

New files are discovered automatically, with no restart. Built-in and runtime skills are read-only, and edits return 409.

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
POST   /rest/v1/open-requests/:requestId/ack  GET    /rest/v1/open-requests/:requestId
GET    /rest/v1/sessions/:id/stream (SSE)     GET    /rest/v1/stream (SSE, all sessions)
GET    /rest/v1/approvals                     POST   /rest/v1/approvals/:id/respond
GET    /rest/v1/sessions/:id/skills           GET/POST /rest/v1/skills
GET/PATCH/DELETE /rest/v1/skills/:name[?cwd=]
```

## Configuration

| Field | Default | Description |
|---|---|---|
| `apiKey` | `null` | Bearer token; `null` means local access only |
| `prefix` | `/rest/v1` | Route prefix |
| `openPolicy` | `auto` | Behavior without a target: `auto` returns 409 with several panels; `broadcast` pushes to all panels |

## Design notes

- Every operation goes through dsh's own services, and the web UI refreshes automatically.
- Live events are subscribed before history is replayed, so a reconnect loses nothing.
- Custom providers are written through the same path as the web settings page.
- Approvals are handled by the plugin and end automatically on timeout or cancellation.
- The plugin only uses dsh's official interfaces and never reads or writes session files directly.

## Known limitations

- Verified on the npm release of dsh 0.2.2-rc.x.
- Sessions not attached to a project cannot be archived over REST and return 409.
- The output for `wait=true` comes from saved events and may be truncated when very long.
- The message list contains no deletion events because dsh has no message deletion.
- Panel targets only prevent UIs from taking over each other; they do not isolate data between users.
- Open requests are sent live only; retry after a `wait=true` timeout.

## License

MIT
