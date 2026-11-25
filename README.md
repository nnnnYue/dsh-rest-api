# dsh-rest-api

[中文](./README.md) | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh web` 提供标准 RESTful API：模型配置、项目、会话（异步 / SSE 流式 / skill 调用）、工具调用审批与技能管理。

REST API 与官方 WebUI 运行在**同一个 dsh 进程、同一份数据**：REST 创建的项目 / 会话 / 消息会实时出现在 [http://127.0.0.1:3080](http://127.0.0.1:3080) 的 WebUI 中，反之亦然。

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
| **模型** `/models` | 实时 provider/model 目录 + 默认模型 |
| | 自定义 OpenAI 兼容 provider 增删改查（写入 settings，热生效，与 WebUI 设置页同步） |
| | API Key 凭证管理（`POST /credentials`，只回掩码） |
| **项目** `/projects` | 目录注册（按 canonical path 幂等）、改名、删除、会话台账 |
| **会话** `/projects/:id/sessions` | 创建会话（cwd 随项目目录）、列表、状态、改名 |
| | `POST /sessions/:id/messages` 异步发送（202）或 `wait=true` 同步等待 turn 结束 |
| | 消息文本支持 `/skill-name args` 调用会话可见的 user-invocable skill |
| | `POST /sessions/:id/cancel` 停止、`DELETE` 归档 |
| | `POST /sessions/:id/open` 把会话推到在线 WebUI 前台 |
| | `GET /sessions/:id/stream` **SSE**：持久事件回放 + 实时 assistant delta，`Last-Event-ID` 断点续传 |
| | `GET /sessions/:id/messages` 消息投影（user/assistant + text/reasoning/tool part 及工具运行态） |
| **全局流** `GET /stream` | 跨全部会话的 live-only SSE fan-out（负载带 `sessionId`） |
| **审批** `/approvals` | 工具调用审批：待决列表 + 应答（放行 / 拒绝） |
| **技能** `/skills` | 目录（含来源层 / 调用策略）、创建（user / project 层）、更新、开关自动调用、删除 |

错误统一为 `{"error": {"code": "...", "message": "..."}}`，code 沿用 dsh 的 `<domain>/<reason>` 风格（如 `session/not-found`）。机器可读的 OpenAPI 3.1 描述见 `GET /rest/v1/openapi.json`。

## 安装

### 方式一：安装为 profile 插件（推荐）

```sh
dsh plugin --profile web add dsh-rest-api   # npm 包 / tgz / 本地目录均可
dsh web
```

### 方式二：开发模式 --patch（免安装热载）

```sh
npm install && npm run build
# 编辑 dev.patch.yml 中的绝对路径后：
npx @deepseek-ai/dsh@next web --patch ./dev.patch.yml --port 3080 --no-open
```

> 需要 `web` profile（提供 webServer）。插件声明了 `webServer / sessionController / workspaceRegistry / llm / agentDefaultModel / credentials / skills / sessionSkillCatalog / settingsController / settings` 注入，缺失任一服务的 profile 下不会加载。

## 鉴权

- 配置 `apiKey` 后：所有请求需 `Authorization: Bearer <apiKey>`（`/health`、`/openapi.json` 除外）。
- 未配置时：**仅允许本机回环访问**（fail closed）。

推荐用环境变量注入 token：

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

# 2. 创建会话（该目录即会话 cwd）
curl -sX POST $B/projects/$PID/sessions -H 'content-type: application/json' \
  -d '{"title": "REST session"}'
SID=<session id>

# 3. 异步发消息（立即返回 202 + requestId）
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "总结这个仓库的包结构"}'

# 4. SSE 订阅（持久事件 + 实时增量，重连自动续传）
curl -sN $B/sessions/$SID/stream

# 5. 调用 skill（斜杠形式触发 user-invocable skill）
curl -sX POST $B/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"text": "/my-skill some args"}'

# 6. 停止当前 turn
curl -sX POST $B/sessions/$SID/cancel
```

完整的端到端脚本见 [`examples/demo.sh`](./examples/demo.sh)。

### SSE 事件模型

`GET /rest/v1/sessions/:id/stream?afterSeq=N&deltas=true`

- `event: session` — 持久会话事件（`{type, seq, time, data}`），SSE `id` = `seq`
- `event: delta` — 实时 assistant 流增量（`agent/assistant-stream` 帧：`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / …），瞬态帧不占 id
- 15s 心跳注释；断线重连带 `Last-Event-ID` 或 `?afterSeq=` 从断点续放，不丢事件
- 历史事件可用 `GET /sessions/:id/events?afterSeq=&limit=` 分页读取，或 `GET /sessions/:id/messages` 读投影后的消息视图

全局流 `GET /rest/v1/stream?deltas=true` 帧型与单会话流相同，但负载额外带 `sessionId`、覆盖**所有**会话，且为 live-only：不做回放、不支持 `Last-Event-ID` 续传；断线后由客户端经 REST 分页读对账。

### 会话推送到 WebUI 前台

```sh
curl -si -X POST $B/sessions/$SID/open
# => HTTP/1.1 202 Accepted
#    {"sessionId":"…","accepted":true,"delivered":true,"requestId":"…"}
```

- `202` 表"已投递、未确认切换"——真正的打开发生在浏览器里。
- `delivered` 表示推送瞬间是否存在至少一个订阅中的 WebUI 标签页；`false` = 当前没有在线标签页，请求已接受但不会有人看到。
- 多个标签页在线时全部收到并各自切换；推送为 live-only，不缓存、不补发。
- 实现依赖插件的 WebUI 客户端模块（`dsh.client` 注入）：模块订阅 `restApi/open-requests` 流并在每帧上调用 `uiWorkspace.openSession`。

### 工具调用审批

会话内的工具调用若触发 dsh 审批（`ask` 策略、沙箱升级等），请求会被本插件接管并挂起，直到 REST 客户端应答：

```sh
# 轮询待决审批（或订阅 /stream 观察 approval 事件）
curl -s $B/approvals
# => {"items":[{"id":"…","sessionId":"…","toolName":"bash","callId":"…","reason":"…","askedAt":1700000000000}]}

curl -sX POST $B/approvals/<id>/respond -H 'content-type: application/json' \
  -d '{"outcome": "allowed-once"}'   # 或 "rejected"
```

- 插件注册为审批 answerer 后**接管全部审批**：WebUI 弹窗等其他 answerer 不再收到 ask，REST 是唯一应答通道。
- 15 分钟无人应答自动按 `cancelled` 结算；工具调用被取消 / 中止时同样如此（fail closed）。

### 模型配置

```sh
# 存 API Key（引用名 = 环境变量名风格）
curl -sX POST $B/credentials -H 'content-type: application/json' \
  -d '{"ref": "MY_GATEWAY_KEY", "value": "sk-..."}'

# 注册自定义 OpenAI 兼容 provider（写入 settings，热生效）
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

### 技能管理

```sh
# 创建（默认 user 层 ~/.dsh/skills/<name>/SKILL.md；layer=project 需 cwd）
curl -sX POST $B/skills -H 'content-type: application/json' -d '{
  "name": "deploy-check",
  "description": "检查部署状态并汇总",
  "whenToUse": "用户询问部署状态时",
  "body": "# Deploy Check\n\n1. 读取 deploy 状态 ...",
  "layer": "user"
}'

# 关闭模型自动调用（保留用户手动 /deploy-check）
curl -sX PATCH $B/skills/deploy-check -H 'content-type: application/json' \
  -d '{"modelInvocable": false}'

# 会话可见的 user-invocable 技能目录
curl -sX $B/sessions/<sid>/skills
```

写文件后由 skill-filesystem 的 watcher 自动发现（`skills/change`），无需重启；bundled / runtime 来源的技能为只读（409）。

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
GET    /rest/v1/sessions/:id/stream (SSE)     GET    /rest/v1/stream (SSE, 全部会话)
GET    /rest/v1/approvals                     POST   /rest/v1/approvals/:id/respond
GET    /rest/v1/sessions/:id/skills           GET/POST /rest/v1/skills
GET/PATCH/DELETE /rest/v1/skills/:name[?cwd=]
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `null` | Bearer token；`null` = 仅本机回环 |
| `prefix` | `/rest/v1` | 路由前缀（绝对路径） |

## 设计说明

- 与 WebUI 同进程同步：全部会话 / 项目操作走 `sessionController` / `workspaceRegistry` 等官方进程内服务，WebUI 通过其自身的 observe 流自动刷新，无需额外事件桥。
- SSE 增量来自 `session/event`（持久）与 `agent/assistant-stream`（瞬态）的全局订阅（`{global: true}`，与 dsh 自身 session-controller 的做法一致）；订阅先于回放、水位去重，保证无缝衔接。
- 自定义 provider 通过 `settingsController.mutate` 写入 llm 网关插件的 volatile `providers` 配置（profile patch 持久化 + Loader 热更新），与 WebUI 设置页同一条写路径。
- 审批暴露为对 `approval/request` 瀑布事件的进程内 answerer：claim 后挂起等待 REST 应答；id 为插件自签（瀑布事件不带服务 id），审计仍由 harness 的 `approval/asked` / `approval/decided` durable 事件成对落盘。
- 消息投影（`GET /sessions/:id/messages`）是对 durable 事件的纯折叠：`tool/call` 无配对 `tool/result` 即 `running`，`tool/result.isError` / 事件级 `error` 即 `error`。
- 会话文件为单写者模型，插件只经官方 API 操作会话，绝不直接打开 JSONL / Zstd 日志。
- "打开会话"推送不经 `ctx.remote.$on` 转发事件（转发源全 Host 仅 `dsh-api-remotes` 可注册一个），而是插件自持 SRC Remote 流服务 `restApi/open-requests`：服务端经 Typert Gateway 的 SRC 反射自动暴露，WebUI 客户端模块手工挂载流 contribution 后订阅。

## 已知限制

- 依赖 npm 发布版 dsh（0.2.2-rc.x）验证；master 分支新增的 webServer `auth` 字段已兼容处理。
- 未挂项目的会话无法经 REST 归档（返回 409 并提示）。
- `wait=true` 的输出文本从持久事件流提取，超长输出可能被截断（`truncated` 标志在 state 中）。
- dsh 无消息删除语义，投影消息视图不含删除事件（compaction 的 `surfaceOp` replace 已处理）。

## License

MIT
