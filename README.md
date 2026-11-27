# dsh-rest-api

[中文](./README.md) | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh web` 提供 REST API，可以管理模型、项目、会话、工具审批和技能。API 与网页端同进程、同数据。通过 REST 创建的项目、会话和消息会实时出现在 [http://127.0.0.1:3080](http://127.0.0.1:3080) 的网页中，反之亦然。

## 目录

- [功能](#功能)
- [安装](#安装)
- [鉴权](#鉴权)
- [快速上手](#快速上手)
- [API 一览](#api-一览)
- [配置项](#配置项)
- [设计说明](#设计说明)
- [已知限制](#已知限制)
- [License](#license)

## 功能

| 资源 | 能力 |
|---|---|
| **模型** `/models` | 查看模型目录和默认模型 |
| | 管理自定义 OpenAI 兼容服务商，与网页设置页同步并立即生效 |
| | 管理 API Key，只返回掩码 |
| **项目** `/projects` | 注册目录、改名、删除、查看会话；同一目录重复注册不会重复创建 |
| **会话** `/projects/:id/sessions` | 创建、列表、查看状态、改名、停止、归档，工作目录为项目目录 |
| | 异步发送消息，或加 `wait=true` 等本轮结束；可指定模型与思考等级 |
| | 用 `/技能名 参数` 调用会话可用的技能 |
| | 在网页中打开会话，可指定面板并等待浏览器回执 |
| | SSE 推送历史事件和实时输出，断线可续传 |
| | 查看整理后的消息记录，包括文本、推理、工具调用和运行状态 |
| **全局事件流** `/stream` | 用一个 SSE 连接订阅所有会话的实时事件 |
| **审批** `/approvals` | 查看待处理的工具调用，放行或拒绝 |
| **技能** `/skills` | 查看、创建、修改、开关自动调用、删除 |

错误统一返回 `{"error": {"code": "...", "message": "..."}}`，code 形如 `session/not-found`。完整接口见 `GET /rest/v1/openapi.json`。

## 安装

### 方式一：安装为 profile 插件

```sh
dsh plugin --profile web add dsh-rest-api
dsh web
```

### 方式二：开发模式

```sh
npm install && npm run build
# 修改 dev.patch.yml 里的绝对路径
npx @deepseek-ai/dsh@next web --patch ./dev.patch.yml --port 3080 --no-open
```

> 需要 `web` profile，且 dsh 提供 Web 服务、会话、工作区、模型、凭证和技能等内置服务。

## 鉴权

- 配置 `apiKey` 后，请求需带 `Authorization: Bearer <apiKey>`。`/health`、`/openapi.json` 和浏览器回执接口除外，回执接口用一次性 key 校验。
- 未配置时只允许本机访问。

用环境变量传入 token：

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

## 快速上手

```sh
B=http://127.0.0.1:3080/rest/v1

# 1. 注册项目
curl -sX POST $B/projects -H 'content-type: application/json' \
  -d '{"path": "/repo/my-project", "title": "My Project"}'
PID=<project id>

# 2. 创建会话，工作目录为项目目录
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"title": "REST session"}'
SID=<session id>

# 3. 异步发消息
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "总结这个仓库的包结构"}'

# 4. 订阅 SSE
curl -sN $B/sessions/$SID/stream

# 5. 调用技能
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "/my-skill some args"}'

# 6. 停止本轮
curl -sX POST $B/sessions/$SID/cancel
```

完整的端到端脚本见 [`examples/demo.sh`](./examples/demo.sh)。

### SSE 事件

`GET /rest/v1/sessions/:id/stream?afterSeq=N&deltas=true`

- `event: session`：已保存的事件，SSE 的 `id` 就是 `seq`。
- `event: delta`：实时助手输出，不占 id。
- 每 15 秒发送心跳，重连时带 `Last-Event-ID` 或 `?afterSeq=` 即可续传。
- 历史事件用 `GET /sessions/:id/events` 分页读取，或用 `GET /sessions/:id/messages` 查看整理后的消息。

全局流 `GET /rest/v1/stream` 格式相同，每个事件多一个 `sessionId`，覆盖所有会话，只推实时事件。断线后用 REST 分页补齐。

### 在网页中打开会话

网页以 `?dshTarget=<key>` 打开时，只响应目标匹配或 `"*"` 的请求。

```sh
# 指定面板，wait=true 等待浏览器回执
curl -si -X POST $B/sessions/$SID/open -H 'content-type: application/json' \
  -d '{"target":"panel-7f3a","wait":true}'
# => HTTP/1.1 200 OK
#    {"sessionId":"…","requestId":"…","mode":"targeted","target":"panel-7f3a","opened":true,"ackedBy":[…]}

# 广播到所有面板
curl -sX POST $B/sessions/$SID/open -H 'content-type: application/json' -d '{"target":"*"}'

# 单面板时可省略 target，多面板时返回 409
curl -sX POST $B/sessions/$SID/open
```

- `202 + opened:false` 表示请求已接受但未确认，`reason` 为 `no-client`、`timeout` 或 `client-error`。
- 未指定 target 时返回 `delivered`，只表示推送时存在订阅。确认结果看 `opened`、`ackedBy`，或查询 `GET /open-requests/:requestId`。
- 浏览器打开会话后调用回执接口，该接口用一次性 key 校验。
- `openPolicy: broadcast` 恢复全局广播的旧行为，默认 `auto` 在多面板且无 target 时返回 409。
- 升级插件后刷新所有网页标签页。

### 工具调用审批

工具调用触发 dsh 审批时，本插件会接管请求并暂停，等 REST 客户端应答：

```sh
# 查看待处理的审批
curl -s $B/approvals
# => {"items":[{"id":"…","sessionId":"…","toolName":"bash","callId":"…","reason":"…","askedAt":1700000000000}]}

curl -sX POST $B/approvals/<id>/respond -H 'content-type: application/json' \
  -d '{"outcome": "allowed-once"}'   # 或 "rejected"
```

- 插件接管所有审批，网页弹窗等其他应答方不再收到请求。
- 15 分钟无人应答自动按 `cancelled` 处理，工具调用被取消或中止时也一样。

### 模型配置

```sh
# 保存 API Key
curl -sX POST $B/credentials -H 'content-type: application/json' \
  -d '{"ref": "MY_GATEWAY_KEY", "value": "sk-..."}'

# 注册自定义 OpenAI 兼容服务商
curl -sX POST $B/models/providers -H 'content-type: application/json' -d '{
  "name": "my-gateway",
  "displayName": "My Gateway",
  "api": "openai-completions",
  "baseURL": "https://gateway.example.com/v1",
  "apiKeyEnv": "MY_GATEWAY_KEY",
  "models": [{"id": "my-model", "input": ["text"]}]
}'

# 切换默认模型
curl -sX PUT $B/models/default -H 'content-type: application/json' \
  -d '{"provider": "my-gateway", "model": "my-model"}'
```

### 会话级模型与思考等级

会话的模型和思考等级只属于该会话，下面的操作不会改动全局默认模型。

```sh
# 创建时指定
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"model": "deepseek-v4-pro", "reasoningEffort": "max"}'

# 只改思考等级
# 或改模型，省略 provider 时自动推断，多个服务商有同名模型则返回 400
curl -sX PATCH $B/sessions/$SID -H 'content-type: application/json' -d '{"reasoningEffort": "low"}'
curl -sX PATCH $B/sessions/$SID -H 'content-type: application/json' \
  -d '{"provider": "deepseek-official", "model": "deepseek-flash"}'

# 读回这个会话的选择
curl -s $B/sessions/$SID
```

- 字段为 `{provider, model, reasoningEffort?}`，未填的字段沿用会话当前值。
- 从下一次模型调用开始生效，运行中的会话也能切换。
- `GET /models` 返回每个模型支持的思考等级。
- 校验失败返回 400：`model/not-found`、`model/ambiguous`、`model/reasoning-effort-unsupported`。
- 只改 `reasoningEffort` 会把当时的默认模型一起固定到该会话。

### 技能管理

```sh
# 创建技能，默认写入 user 层
curl -sX POST $B/skills -H 'content-type: application/json' -d '{
  "name": "deploy-check",
  "description": "检查部署状态并汇总",
  "whenToUse": "用户询问部署状态时",
  "body": "# Deploy Check\n\n1. 读取 deploy 状态 ...",
  "layer": "user"
}'

# 关闭模型自动调用，手动 /deploy-check 仍然可用
curl -sX PATCH $B/skills/deploy-check -H 'content-type: application/json' \
  -d '{"modelInvocable": false}'

# 查看会话可用的技能
curl -sX $B/sessions/<sid>/skills
```

新文件会自动发现，无需重启。内置和运行时技能只读，修改返回 409。

## API 一览

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
GET    /rest/v1/sessions/:id/stream (SSE)     GET    /rest/v1/stream (SSE, 全部会话)
GET    /rest/v1/approvals                     POST   /rest/v1/approvals/:id/respond
GET    /rest/v1/sessions/:id/skills           GET/POST /rest/v1/skills
GET/PATCH/DELETE /rest/v1/skills/:name[?cwd=]
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `null` | Bearer token；`null` 表示只允许本机访问 |
| `prefix` | `/rest/v1` | 路由前缀 |
| `openPolicy` | `auto` | 无 target 时的行为：`auto` 多面板返回 409；`broadcast` 广播到所有面板 |

## 设计说明

- 所有操作都走 dsh 自带服务，网页端自动刷新。
- 先订阅实时事件再补历史，重连不会漏。
- 自定义服务商与网页设置页走同一条写入路径。
- 审批由插件接管，超时或调用取消时自动结束。
- 插件只通过 dsh 官方接口操作会话，不直接读写会话文件。

## 已知限制

- 在 npm 发布版 dsh 0.2.2-rc.x 上验证。
- 未挂到项目的会话不能通过 REST 归档，返回 409。
- `wait=true` 的输出来自保存的事件，超长时可能截断。
- 消息列表不包含删除事件，因为 dsh 没有删除消息的功能。
- 面板 target 只防止多个界面互相抢占，不隔离用户数据。
- 打开会话的推送只实时发送，`wait=true` 超时后请重试。

## License

MIT
