# Claude Code Agent API

把 Claude Code 的无头执行模式（`claude -p`）封装成 HTTP 任务服务：`POST` 下发任务后，
通过 SSE 实时接收**过程内容**（助手文本增量、工具调用、工具结果、stderr 等），并在最后
收到独立的**最终结果**事件。

服务基于 Node.js（Express 5），每个任务启动一个真实的 `claude -p` 子进程，没有模拟实现。

## 能力

- 任务异步下发：创建即返回 `202` 与 task id，按 id 查询状态与结果
- 流式输出：SSE 区分过程事件（`process`）与最终结果（`result`），支持断线重连与事件重放
- 并发与排队：`MAX_CONCURRENT_TASKS` 控制并发，超出进入 FIFO 队列，队列上限可配
- 明确错误语义：认证失败、限流、上游错误、超时、取消、进程异常各有独立错误码
- 持久化：任务元数据与事件落盘到 `STATE_DIR`，进程重启可恢复；重启前未结束的任务标记为失败
- 可观测：`/healthz`、`/readyz`、`/v1/info`，JSON 行日志
- 容器化：非 root 运行、内置 tini、健康检查、GHCR 自动发布

## 架构与目录

```
src/
├── server.js       # 进程入口：加载配置、启动 HTTP、信号处理与优雅关闭
├── config.js       # 环境变量解析与校验（缺必需项直接启动失败）
├── app.js          # Express 路由、Bearer 鉴权、SSE 端点
├── tasks.js        # 任务队列/并发控制/状态机/重启恢复
├── taskStore.js    # STATE_DIR 落盘：meta.json 原子写 + events.jsonl 追加
├── claude.js       # 启动 claude 子进程、参数拼装、NDJSON 解析、超时/取消
├── normalize.js    # CLI 事件归一化为 process/result/error
├── logger.js       # JSON 行日志
└── errors.js       # 错误类型与 HTTP 映射
test/               # Node 内置测试运行器的接口/持久化/配置测试
Dockerfile          # node:22-bookworm-slim + 固定版本 claude-code，非 root
docker-compose.yml  # 本地构建方式（build）
docker-compose.ghcr.yml  # 使用 GHCR 已发布镜像（image）
.github/workflows/docker.yml  # 推送 master 自动构建并发布镜像
```

请求处理链路：`app.js` 校验参数 → `tasks.js` 入队/调度 → `claude.js` 启动子进程并解析
NDJSON → `normalize.js` 转成 SSE 事件 → `tasks.js` 广播并写盘 → `taskStore.js` 落盘。

### Claude Code 调用方式

服务通过 stdin 下发提示词（避免 shell/argv 注入），参数包含
`--output-format stream-json --verbose`（`stream-json` 在 `-p` 模式下必须搭配 `--verbose`）、
`--no-session-persistence`、`--permission-mode`、可选的 `--model` / `--max-budget-usd` /
`--allowedTools` 等，并按需加 `--include-partial-messages` 获取增量。

CLI 的 stdout 是逐行 JSON（`system` / `assistant` / `user` / `stream_event` / `result`），
其中 `result` 是终止事件。认证失败时 CLI 退出码为 1 且 `result.is_error` 为真，服务同时
依据两者判定失败，避免只看退出码。

## 构建与部署

配置全部通过环境变量注入。运行时代码**只读进程环境变量**，不会隐式加载 `.env`。

### 方式一：本地构建（docker compose）

```bash
cd /Volumes/personal_folder/code/projects/agent-api
cp .env.example .env   # 仅供 compose 做 ${VAR} 插值，服务本身不读 .env
# 编辑 .env，填入 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL）
mkdir -p workspace state
docker compose up --build -d
docker compose logs -f agent-api
```

compose 使用 `environment:` 显式注入，不使用 `env_file`；也可以不建 `.env`，直接
`ANTHROPIC_API_KEY=... docker compose up --build -d`。

卷映射：

| 宿主路径（可覆盖） | 容器路径 | 说明 |
| --- | --- | --- |
| `./workspace`（`WORKSPACE_HOST_DIR`） | `/workspace` | 任务工作目录 |
| `./state`（`STATE_DIR_HOST`） | `/var/lib/agent-api` | 任务元数据与 SSE 事件 |

Linux 宿主如遇权限问题，执行 `sudo chown -R 10001:10001 state workspace`。

### 方式二：使用 GHCR 已发布镜像

```bash
cp .env.example .env   # 填入凭据
mkdir -p workspace state
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

默认镜像为 `ghcr.io/arbol-yws/agent-api:latest`，可用 `AGENT_API_IMAGE` 指定版本：

```bash
AGENT_API_IMAGE=ghcr.io/arbol-yws/agent-api:2611082045 \
  docker compose -f docker-compose.ghcr.yml up -d
```

仓库为私有仓库时，拉取前需登录 GHCR：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <你的 GitHub 用户名> --password-stdin
```

### 方式三：docker build / docker run

```bash
docker build -t claude-code-agent-api:local \
  --build-arg CLAUDE_CODE_VERSION=2.1.319 .

mkdir -p "$PWD/workspace" "$PWD/state"
docker run -d --name agent-api \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e MAX_CONCURRENT_TASKS=2 \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/state:/var/lib/agent-api" \
  claude-code-agent-api:local
```

所有配置都用 `-e` 注入；缺少必需凭据时容器以退出码 `1` 结束，`docker logs` 会列出缺失变量。

### 方式四：本地直接运行

```bash
npm ci
ANTHROPIC_API_KEY=... WORKSPACE_DIR=$PWD/workspace STATE_DIR=$PWD/state npm start
```

本地开发如果想用文件保存配置，显式指定 `ENV_FILE=/path/to/file`，不设置则不读任何文件。

### 镜像发布（GitHub Actions → GHCR）

[.github/workflows/docker.yml](.github/workflows/docker.yml) 在 push 到 `master` 或手动
`workflow_dispatch` 时构建并推送镜像：

- 镜像：`ghcr.io/arbol-yws/agent-api`
- 标签：
  - `latest` — 仅默认分支
  - `yyMMddHHmm` — 构建时间，固定按 `Asia/Shanghai` 生成，例如 `2611082045`
  - `sha-<短 sha>` — 对应提交，例如 `sha-0d5ca56`
- 登录：内置 `GITHUB_TOKEN`（`packages: write`），无需额外 secret
- 缓存：BuildKit + `type=gha` 缓存，增量复用构建层

同一分支的构建串行执行（`concurrency`，不中断进行中的推送）。同一分钟内重复构建会得到
相同的时间标签，后一次推送覆盖同名标签（registry 的标签推进是原子的，不会产生损坏镜像）；
需要精确区分某次提交时使用 `sha-<短 sha>` 标签。

## 环境变量

缺少必需配置时服务以退出码 `1` 退出，并在日志中列出缺失的变量名。

| 变量 | 必需 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` 🔑 | 三选一 * | 空 | Anthropic API Key |
| `ANTHROPIC_AUTH_TOKEN` 🔑 | 三选一 * | 空 | 网关/代理凭据，必须与 `ANTHROPIC_BASE_URL` 同时设置 |
| `ANTHROPIC_BASE_URL` 🔑 | 三选一 * | 空 | 自定义 API 网关地址 |
| `CLAUDE_CODE_USE_BEDROCK` 🔑 | 三选一 * | 空 | 设为 `1` 时使用 AWS Bedrock 凭据 |
| `CLAUDE_CODE_USE_VERTEX` 🔑 | 三选一 * | 空 | 设为 `1` 时使用 Google Vertex 凭据 |
| `SERVICE_API_KEY` 🔑 | 否 | 空 | 服务自身鉴权；设置后 `/v1` 需要 Bearer，对外暴露时建议必设 |
| `PORT` | 否 | `8080` | HTTP 监听端口 |
| `HOST` | 否 | `0.0.0.0` | HTTP 监听地址 |
| `WORKSPACE_DIR` | 否 | `/workspace` | 任务工作目录根；每任务 `cwd` 必须在其内 |
| `STATE_DIR` | 否 | `./state` | 任务元数据与 SSE 事件落盘目录（容器内为 `/var/lib/agent-api`） |
| `STATE_DIR_HOST` | 否 | `./state` | 仅 docker compose：宿主 state 目录 |
| `WORKSPACE_HOST_DIR` | 否 | `./workspace` | 仅 docker compose：宿主 workspace 目录 |
| `AGENT_API_PORT` | 否 | `8080` | 仅 docker compose：宿主暴露端口 |
| `AGENT_API_IMAGE` | 否 | `ghcr.io/arbol-yws/agent-api:latest` | 仅 `docker-compose.ghcr.yml`：使用的镜像 |
| `ENV_FILE` | 否 | 空 | 显式指定时才读取的 env 文件（本地开发便利，不覆盖已有环境变量） |
| `CLAUDE_BIN` | 否 | `claude` | CLI 可执行文件路径 |
| `CLAUDE_HOME` | 否 | `$HOME` | 传给子进程的 `HOME`（CLI 会写 `.claude`） |
| `CLAUDE_MODEL` | 否 | 空 | 默认模型（任务可用 `model` 覆盖） |
| `CLAUDE_PERMISSION_MODE` | 否 | `bypassPermissions` | 无人值守执行所需；可按需收紧 |
| `CLAUDE_INCLUDE_PARTIAL_MESSAGES` | 否 | `true` | 是否加 `--include-partial-messages` |
| `CLAUDE_BARE` | 否 | `false` | 是否加 `--bare`（跳过用户配置/插件等） |
| `CLAUDE_EXTRA_ARGS` | 否 | 空 | 额外 CLI 参数，按空格切分（不支持引号） |
| `CLAUDE_ENV_PASSTHROUGH` | 否 | 见下 | 允许透传给子进程的环境变量名（逗号分隔） |
| `CLAUDE_KILL_GRACE_MS` | 否 | `5000` | SIGTERM 到 SIGKILL 的宽限 |
| `CLAUDE_STARTUP_CHECK` | 否 | `true` | 启动时是否探测 `claude` 可执行文件 |
| `MAX_CONCURRENT_TASKS` | 否 | `2` | 同时运行的 CLI 进程数 |
| `MAX_QUEUE_SIZE` | 否 | `32` | 等待队列上限，超出返回 `queue_full` |
| `TASK_TIMEOUT_MS` | 否 | `600000` | 默认任务超时（从开始执行算起） |
| `MAX_TASK_TIMEOUT_MS` | 否 | `3600000` | 请求里 `timeout_ms` 的上限 |
| `MAX_EVENTS_PER_TASK` | 否 | `5000` | 每任务事件保留上限（超出仅保留实时推送） |
| `SSE_MAX_BUFFER_BYTES` | 否 | `8388608` | 事件重放缓冲字节上限 |
| `SSE_HEARTBEAT_MS` | 否 | `15000` | SSE 心跳间隔 |
| `TASK_TTL_MS` | 否 | `0` | 终态任务保留时长；`0` 表示不自动清理，清理会同时删除磁盘数据 |
| `BODY_LIMIT` | 否 | `512kb` | JSON 请求体上限 |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error`（JSON 行日志） |
| `TZ` | 否 | 系统默认 | 容器与日志时区（compose 默认 `Asia/Shanghai`） |

\* 凭据必须满足下列之一：`ANTHROPIC_API_KEY`；或 `ANTHROPIC_AUTH_TOKEN` +
`ANTHROPIC_BASE_URL`；或 `CLAUDE_CODE_USE_BEDROCK=1`；或 `CLAUDE_CODE_USE_VERTEX=1`。
🔑 表示涉及凭据，请用 secret 管理方式注入，不要写进镜像或提交到仓库。

`CLAUDE_ENV_PASSTHROUGH` 默认包含 `PATH`、`HOME`、`LANG`、`TZ`、`SHELL`、`ANTHROPIC_*`、
`AWS_*`、`CLAUDE_CODE_USE_BEDROCK/VERTEX`、代理变量等；`SERVICE_API_KEY`、`PORT` 等
**不会**透传给 Claude 子进程，避免凭据串用。

## 接口

所有业务接口以 `/v1` 开头。若设置了 `SERVICE_API_KEY`，需携带
`Authorization: Bearer <SERVICE_API_KEY>`；`/healthz`、`/readyz` 始终无需鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tasks` | 创建任务并立即返回 `202` |
| `GET` | `/v1/tasks/:id` | 查询状态与最终结果；`?include_events=1&from_seq=N` 可附带事件 |
| `GET` | `/v1/tasks/:id/stream` | SSE 流；支持 `from_seq` / `Last-Event-ID` 续传 |
| `POST` | `/v1/tasks/:id/cancel` | 取消排队或运行中的任务 |
| `GET` | `/v1/tasks?limit=N` | 列出最近任务 |
| `GET` | `/v1/info` | 运行统计与配置摘要（不含密钥） |
| `GET` | `/healthz` | 存活检查 |
| `GET` | `/readyz` | 就绪检查：claude 二进制 + 凭据；未就绪返回 503 |

### 创建任务

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/tasks \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "在当前目录创建一个 hello.txt，内容为 hello",
    "timeout_ms": 300000,
    "model": "claude-sonnet-5",
    "permission_mode": "bypassPermissions",
    "max_budget_usd": 1.0,
    "allowed_tools": ["Read", "Write", "Bash"],
    "cwd": "project-a"
  }'
```

响应（`202`）：

```json
{
  "task_id": "tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a",
  "status": "running",
  "queue_position": null,
  "status_url": "/v1/tasks/tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a",
  "stream_url": "/v1/tasks/tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a/stream"
}
```

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string，必填 | 任务描述，最长 100000 字符；通过 stdin 传给 CLI |
| `timeout_ms` | int | 任务超时（从开始执行算起），1000 ~ `MAX_TASK_TIMEOUT_MS` |
| `model` | string | `--model` 的值 |
| `permission_mode` | string | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `max_budget_usd` | number | 传给 `--max-budget-usd`，正数 |
| `system_prompt` | string | 替换系统提示词 |
| `allowed_tools` / `disallowed_tools` | string[] | 传给 `--allowedTools` / `--disallowedTools` |
| `cwd` | string | 相对 `WORKSPACE_DIR` 的子目录；禁止绝对路径和越界 |

### 流式调用

```bash
TASK_ID=tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a
curl -N -sS \
  -H 'accept: text/event-stream' \
  "http://127.0.0.1:8080/v1/tasks/${TASK_ID}/stream"
```

`-N` 关闭 curl 缓冲，事件实时打印。断线后按序号续传：

```bash
# 从第 5 条之后继续（或使用 Last-Event-ID: 5）
curl -N -sS "http://127.0.0.1:8080/v1/tasks/${TASK_ID}/stream?from_seq=5"
```

客户端断开默认**不会**取消任务；追加 `&cancel_on_disconnect=1` 可改为断开即取消。

### 查询状态 / 结果

```bash
curl -sS "http://127.0.0.1:8080/v1/tasks/${TASK_ID}"
```

```json
{
  "task_id": "tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a",
  "status": "succeeded",
  "created_at": "2026-11-08T10:21:17.082Z",
  "started_at": "2026-11-08T10:21:17.083Z",
  "finished_at": "2026-11-08T10:21:21.596Z",
  "cwd": "/workspace",
  "prompt": "...",
  "options": { "timeout_ms": 300000 },
  "queue_position": null,
  "result": {
    "text": "已在当前目录创建 hello.txt，内容为 hello。",
    "is_error": false,
    "subtype": "success",
    "session_id": "8c398fe0-0845-4943-8bc0-75ecaa42f09e",
    "total_cost_usd": 0.0123,
    "duration_ms": 4010,
    "num_turns": 3,
    "usage": { "...": "..." }
  },
  "error": null,
  "events_buffered": 24,
  "events_truncated": false,
  "last_seq": 24
}
```

`status` 取值：`queued`、`running`、`succeeded`、`failed`、`cancelled`、`timed_out`。

### 取消任务

```bash
curl -sS -X POST "http://127.0.0.1:8080/v1/tasks/${TASK_ID}/cancel"
```

### 携带服务鉴权

```bash
curl -sS -H "Authorization: Bearer ${SERVICE_API_KEY}" \
  "http://127.0.0.1:8080/v1/tasks/${TASK_ID}"
```

## SSE 事件协议

每个事件都带 `id`（单调序号）与 JSON `data`，`data` 中同时包含 `task_id` 和 `seq`。

| `event` | 含义 |
| --- | --- |
| `status` | 状态迁移：`queued` → `running` → 终态 |
| `process` | 过程内容，`data.kind` 区分类型 |
| `result` | 最终结果（仅一次，`data.final: true`） |
| `error` | 失败语义（`code` / `message` / `details`） |
| `end` | 流正常结束 |

`process` 的 `kind`：

| `kind` | 说明 |
| --- | --- |
| `system` (`subtype: init`) | 会话初始化：模型、工具、权限模式、CLI 版本 |
| `assistant_text` | 助手完整文本块 |
| `assistant_thinking` | 思考内容（如模型返回） |
| `delta` | 增量文本/思考块（`delta_type: text` / `thinking`；工具开始为 `tool_use_start`） |
| `tool_use` | 工具调用：`name`、`input`、`tool_use_id` |
| `tool_result` | 工具结果：`text`、`is_error` |
| `stderr` | CLI 的 stderr（已去 ANSI，便于排障） |
| `cli_error` | CLI 内部错误消息（如认证失败） |
| `hook` | 钩子生命周期事件（如存在） |
| `notice` | 服务提示，例如 `timeout`、`events_truncated` |
| `raw` / `stdout_unparsed` | 未识别事件或非 JSON 行（截断保存，保证不丢流） |

事件顺序示例：

```
event: status   {"status":"queued",...}
event: status   {"status":"running",...}
event: process  {"kind":"system","subtype":"init",...}
event: process  {"kind":"delta","delta_type":"text","text":"正在"}
event: process  {"kind":"tool_use","name":"Write",...}
event: process  {"kind":"tool_result","is_error":false,...}
event: result   {"final":true,"text":"...","is_error":false,...}
event: status   {"status":"succeeded",...}
event: end      {"status":"succeeded"}
```

失败时不会出现 `result`，而是 `error` + 终态 `status`：

```
event: error    {"code":"claude_auth_failed","message":"Failed to authenticate...","details":{"api_error_status":403}}
event: status   {"status":"failed","error_code":"claude_auth_failed"}
event: end      {"status":"failed"}
```

## 错误语义

HTTP 层错误统一返回 `{"error":{"code","message","details"}}`。

| `code` | HTTP | 场景 |
| --- | --- | --- |
| `invalid_request` | 400 | 字段缺失/类型或范围错误 |
| `invalid_json` | 400 | 请求体不是合法 JSON |
| `invalid_cwd` | 400 | `cwd` 为绝对路径、越界或不存在 |
| `unauthorized` | 401 | 缺少/错误的 `SERVICE_API_KEY` |
| `not_found` | 404 | 未知路由 |
| `task_not_found` | 404 | 任务 ID 不存在（或已被 TTL 清理） |
| `task_already_terminal` | 409 | 对已结束任务再次取消 |
| `payload_too_large` | 413 | 请求体超过 `BODY_LIMIT` |
| `queue_full` | 429 | 排队数达到 `MAX_QUEUE_SIZE` |
| `claude_auth_failed` | — | CLI 认证失败（401/403 或认证相关消息） |
| `claude_rate_limited` | — | 上游 429 |
| `claude_api_error` | — | 其他上游 HTTP 错误 |
| `claude_exit_nonzero` | — | CLI 非 0 退出且未产出 result |
| `claude_no_result` | — | CLI 正常退出但未产出 result |
| `claude_binary_not_found` | — | `CLAUDE_BIN` 不存在（ENOENT） |
| `claude_spawn_failed` | — | 子进程启动失败 |
| `timeout` | — | 超过 `timeout_ms`，进程被终止，状态 `timed_out` |
| `cancelled` | — | 客户端取消，状态 `cancelled` |
| `internal_error` | 500 | 服务内部异常 |
| `server_restarted` | — | 服务重启时任务仍在 `queued`/`running`，判定为失败 |

超时处理：先 `SIGTERM` 整个进程组，`CLAUDE_KILL_GRACE_MS` 后 `SIGKILL`，工具子进程一并回收。

## 数据持久化

任务元数据与 SSE 事件落盘到 `STATE_DIR`（默认 `./state`，容器内 `/var/lib/agent-api`）。

```
${STATE_DIR}/
└── tasks/
    └── tsk_<uuid>/
        ├── meta.json     # 元数据快照：状态、时间戳、result、error、last_seq
        └── events.jsonl  # SSE 事件，一行一个，按 seq 递增追加
```

- `meta.json` 采用「临时文件 + `fsync` + `rename`」原子替换，磁盘上始终是完整快照。
- `events.jsonl` 按行追加；启动加载时会把尾部未写完的行截断到最后一个换行符，只解析完整记录。
- 启动时按 `task_id` 重建内存任务表，并用磁盘上最后一条 `status`/`result`/`error` 事件
  校正状态（事件流已记录终态时以事件为准）。
- 重启前处于 `queued`/`running` 的任务会被标记为 `failed`，错误码 `server_restarted`，
  `error.details.previous_status` 记录原状态，并补写 `error` 与终态 `status` 事件。
- 已处于终态的任务原样恢复，可继续按 id 查询、按 `from_seq` 重放事件。

清理：

- `TASK_TTL_MS > 0` 时定期清理超期且无 SSE 订阅者的终态任务，同时删除内存与磁盘数据。
- `TASK_TTL_MS=0`（默认）不自动清理，可手工删除：`rm -rf state/tasks/tsk_<uuid>`。

## 并发、超时与连接语义

- 任务创建后进入 FIFO 队列；达到 `MAX_CONCURRENT_TASKS` 时状态为 `queued`，
  `queue_position` 给出排队位置。
- 超时从任务开始执行时计算，不包含排队时间。
- SSE 断线只解除订阅，任务继续执行；重连时用 `from_seq`（或 `Last-Event-ID`）补齐事件。
- 终态事件之后服务发送 `end` 并关闭 SSE，客户端不会无限挂起。

## 安全与运维

- 容器内默认 `bypassPermissions`，Claude 可自主执行工具；只在受控容器/网络中使用，
  并对 `workspace/` 采用最小权限挂载。
- 服务不写死密钥，凭据只从环境变量读取，且仅按白名单透传给子进程。
- 跨机器访问时务必设置 `SERVICE_API_KEY` 并置于 TLS 反向代理之后。
- 每次任务都是独立的 `claude -p` 进程并带 `--no-session-persistence`，不复用历史会话。
- 建议为容器设置 CPU/内存限制（如 `--cpus=2 --memory=4g`），避免并发任务耗尽资源。

## 开发与测试

```bash
npm ci
npm test
```

测试使用 Node 内置测试运行器，会启动真实的 `claude` 子进程；运行前请确保 `claude`
在 `PATH` 中。

## 常见问题

**启动即退出，日志提示 `Missing required environment variable(s)`**
没有提供可用凭据。按环境变量表设置 `ANTHROPIC_API_KEY`，或
`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`，或启用 Bedrock/Vertex。

**任务失败且错误码为 `claude_auth_failed`**
上游返回 401/403，通常是 Key 无效、过期或网关 token 不匹配。

**重启后任务变成 `failed` / `server_restarted`**
任务进程随服务重启消失，属于预期行为；可从 `events.jsonl` 查看重启前已产生的事件。

**查询任务返回 `task_not_found`**
任务不存在，或已超过 `TASK_TTL_MS` 被清理。

**拉取 GHCR 镜像提示未授权**
仓库为私有，先执行 `docker login ghcr.io`（token 需 `read:packages` 权限）。

**Linux 上容器无法写入 `state/` 或 `workspace/`**
宿主目录归属与容器内 uid `10001` 不一致，执行
`sudo chown -R 10001:10001 state workspace`。

**设置了 `.env` 但服务没读到**
服务不隐式加载 `.env`；该文件只用于 compose 的 `${VAR}` 插值。本地运行请导出环境变量，
或显式设置 `ENV_FILE`。
