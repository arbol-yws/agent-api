# Claude Code Agent API

把 Claude Code 的无头执行模式封装成 HTTP 任务服务：`POST` 下发任务后，通过 SSE 实时接收**过程内容**（助手文本增量、工具调用、工具结果、stderr 等），并在最后收到独立的**最终结果**事件。

服务基于 Node.js（Express 5），每个任务都启动一个真实的 `claude -p` 子进程，没有模拟实现。

## 已验证的 Claude Code 行为

在本机 Claude Code **2.1.236** 上实测确认（Docker 镜像固定安装 **2.1.319**，这些参数与输出格式一致）：

```bash
# 无头模式 + NDJSON 流式输出（stream-json 必须搭配 --verbose）
claude -p --output-format stream-json --verbose --no-session-persistence

# 提示词通过 stdin 传入，避免 shell/argv 注入
printf '%s\n' "你的任务" | claude -p --output-format stream-json --verbose

# 更细粒度的增量输出
claude -p --output-format stream-json --verbose --include-partial-messages
```

实测要点：

- `--output-format stream-json` **必须**同时给 `--verbose`，否则 CLI 直接报
  `Error: When using --print, --output-format=stream-json requires --verbose`。
- stdout 是逐行 JSON（NDJSON），主要事件：
  - `{"type":"system","subtype":"init",...}`：会话初始化（模型、工具、权限模式等）
  - `{"type":"assistant","message":{"content":[{"type":"text",...}]},...}`
  - `{"type":"user","message":{"content":[{"type":"tool_result",...}]},...}`
  - `{"type":"stream_event",...}`：配合 `--include-partial-messages` 的增量块
  - `{"type":"result","is_error":...,"result":"...","subtype":"success",...}`：**终止事件**
- 认证/接口失败时：CLI **退出码为 1**，且 result 事件里 `is_error: true`、带 `api_error_status`
  （例如 `403`）。因此本服务同时依据 result 事件与退出码判定失败，不能只看退出码。
- 提示词可直接从 stdin 读取；本服务均通过 stdin 下发。
- 其他可用参数：`--permission-mode`、`--model`、`--max-budget-usd`、
  `--allowedTools` / `--disallowedTools`、`--no-session-persistence`、`--bare`。

## 接口

所有业务接口以 `/v1` 开头。若设置了 `SERVICE_API_KEY`，需携带
`Authorization: Bearer <SERVICE_API_KEY>`；`/healthz`、`/readyz` 始终无需鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tasks` | 创建任务并立即返回 `202`；任务进入队列/开始执行 |
| `GET` | `/v1/tasks/:id` | 查询状态与最终结果；`?include_events=1&from_seq=N` 可附带事件 |
| `GET` | `/v1/tasks/:id/stream` | SSE 流；支持断线重连（`from_seq` / `Last-Event-ID`） |
| `POST` | `/v1/tasks/:id/cancel` | 取消排队或运行中的任务 |
| `GET` | `/v1/tasks?limit=N` | 列出最近任务 |
| `GET` | `/v1/info` | 运行统计与配置摘要（不含密钥） |
| `GET` | `/healthz` | 存活检查（进程可响应即 200） |
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
| `model` | string | `--model` 的值，例如 `claude-sonnet-5` |
| `permission_mode` | string | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `max_budget_usd` | number | 传给 `--max-budget-usd`，正数 |
| `system_prompt` | string | 替换系统提示词（`--system-prompt`） |
| `allowed_tools` / `disallowed_tools` | string[] | 传给 `--allowedTools` / `--disallowedTools` |
| `cwd` | string | 相对 `WORKSPACE_DIR` 的子目录；禁止绝对路径和越界 |

### 流式调用（curl）

```bash
TASK_ID=tsk_80023eb2-c250-40f3-9ef0-ef1f7b8b142a
curl -N -sS \
  -H 'accept: text/event-stream' \
  "http://127.0.0.1:8080/v1/tasks/${TASK_ID}/stream"
```

`-N` 关闭 curl 缓冲，事件会边产生边打印。断线后可用事件序号续传：

```bash
# 从第 5 条之后继续（或使用 Last-Event-ID: 5）
curl -N -sS "http://127.0.0.1:8080/v1/tasks/${TASK_ID}/stream?from_seq=5"
```

客户端断开默认**不会**取消任务；如希望断开即取消，追加 `&cancel_on_disconnect=1`。

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
| `process` | **过程内容**，`data.kind` 区分类型（见下表） |
| `result` | **最终结果**（仅一次，`data.final: true`） |
| `error` | 失败语义（`code` / `message` / `details`） |
| `end` | 流正常结束（客户端可据此关闭连接） |

`process` 事件的 `kind`：

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

失败时 `result` 不会出现，而是 `error` + 终态 `status`：

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
| `server_restarted` | — | 服务重启时该任务仍处于 `queued`/`running`，已被判定失败 |

超时处理：先 `SIGTERM` 整个进程组，`CLAUDE_KILL_GRACE_MS` 后 `SIGKILL`，确保工具子进程一并回收。

## 数据持久化

任务元数据与 SSE 事件都落盘到 `STATE_DIR`（默认 `./state`，容器内为 `/var/lib/agent-api`），
进程重启不会丢任务。

目录结构（每个任务一个目录）：

```
${STATE_DIR}/
└── tasks/
    └── tsk_<uuid>/
        ├── meta.json     # 元数据快照：状态、时间戳、result、error、last_seq
        └── events.jsonl  # SSE 事件，一行一个，按 seq 递增追加
```

写入的崩溃安全措施：

- `meta.json` 采用「临时文件 + `fsync` + `rename`」原子替换，任何时刻磁盘上都是一份完整快照，
  不会出现半截元数据。
- `events.jsonl` 只按行追加（每行自带 `seq`）。启动加载时若发现文件尾部有写了一半的行
  （进程在 `write` 中途被杀），会把它截断到最后一个换行符，只解析完整行，因此不会解析到
  半条记录。
- 事件与元数据在启动时按 `task_id` 重建内存任务表，并以磁盘上最后一条 `status`/`result`/
  `error` 事件校正状态（例如元数据还停留在 `running`、但事件流已记录终态时以事件为准）。

重启语义：

- 服务启动时扫描 `STATE_DIR/tasks`，把所有任务重新载入。
- 重启前处于 `queued` 或 `running` 的任务，其 `claude` 子进程已随进程消失，会被标记为
  `failed`，错误码 `server_restarted`，`error.details.previous_status` 记录原状态；
  同时补写一条 `error` 与终态 `status` 事件，因此重连 SSE 仍能拿到完整结果。
- 已处于终态（`succeeded` / `failed` / `cancelled` / `timed_out`）的任务原样恢复，可继续
  按 task id 查询、按 `from_seq` 重放事件。

清理：

- 设置 `TASK_TTL_MS > 0` 后，服务会定期清理超过该时长且无 SSE 订阅者的终态任务，
  **同时删除内存条目与磁盘上的任务目录**，避免文件无限增长。
- `TASK_TTL_MS=0`（默认）表示不自动清理，此时需要手工清理：
  `rm -rf state/tasks/tsk_<uuid>`（或整目录 `rm -rf state/tasks/*`，建议在服务停止时执行）。
- 任务目录按 uuid 命名，删除单个目录即可精准清理某个任务。

## 构建与启动

### 方式一：docker compose（推荐）

```bash
cd /Volumes/personal_folder/code/projects/agent-api
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL）
mkdir -p workspace state
docker compose up --build -d
docker compose logs -f agent-api
```

`docker-compose.yml` 的两个卷：

| 宿主路径（可覆盖） | 容器路径 | 说明 |
| --- | --- | --- |
| `./workspace`（`WORKSPACE_HOST_DIR`） | `/workspace` | Claude 任务的工作目录 |
| `./state`（`STATE_DIR_HOST`） | `/var/lib/agent-api` | 任务元数据与 SSE 事件，容器重建后仍在 |

Linux 宿主如果遇到 `state/` 权限问题，执行 `sudo chown -R 10001:10001 state`。

### 方式二：docker build / run

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

镜像说明：

- 基础镜像 `node:22-bookworm-slim`，全局安装固定版本 `@anthropic-ai/claude-code@2.1.319`。
- 以非 root 用户 `agent`（uid/gid `10001`）运行；`HOME=/home/agent`。
- 内置 `tini` 作为 PID 1 并负责转发信号与回收僵尸进程；**不要**再加 `--init`
  （会与内置 tini 重复初始化）。
- Docker `HEALTHCHECK` 轮询 `/healthz`，容器状态显示 `healthy`。
- 宿主 `workspace/` 目录会被挂载到容器 `/workspace`。Linux 宿主如遇写入权限问题，
  执行 `sudo chown -R 10001:10001 workspace`。
- 镜像内已创建 `/var/lib/agent-api` 并 `chown` 给 `agent`，对应 `STATE_DIR`；挂载宿主
  `state/` 后即可持久化任务数据（容器删除重建不丢）。

### 方式三：本地直接运行

```bash
npm ci
ANTHROPIC_API_KEY=... WORKSPACE_DIR=$PWD/workspace STATE_DIR=$PWD/state npm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | 空 | Anthropic API Key；与下面两项二选一 |
| `ANTHROPIC_AUTH_TOKEN` | 空 | 网关/代理凭据，需配合 `ANTHROPIC_BASE_URL` |
| `ANTHROPIC_BASE_URL` | 空 | 自定义 API 网关地址 |
| `CLAUDE_CODE_USE_BEDROCK` / `..._VERTEX` | 空 | 使用云厂商凭据时设为 `1` |
| `SERVICE_API_KEY` | 空 | 设置后 `/v1` 需要 Bearer 鉴权；建议对外暴露时必设 |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `WORKSPACE_DIR` | `/workspace` | 任务工作目录根；每任务 `cwd` 必须在其内 |
| `STATE_DIR` | `./state` | 任务元数据与 SSE 事件落盘目录（容器内为 `/var/lib/agent-api`） |
| `STATE_DIR_HOST` | `./state` | 仅 docker compose 生效：宿主 state 目录映射到容器 `/var/lib/agent-api` |
| `CLAUDE_HOME` | `$HOME` | 传给子进程的 `HOME`（CLI 会写 `.claude`） |
| `CLAUDE_BIN` | `claude` | CLI 可执行文件路径 |
| `CLAUDE_MODEL` | 空 | 默认模型（任务可用 `model` 覆盖） |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | 容器内无人值守执行所需；可按需收紧 |
| `CLAUDE_INCLUDE_PARTIAL_MESSAGES` | `true` | 是否加 `--include-partial-messages` |
| `CLAUDE_BARE` | `false` | 是否加 `--bare`（跳过用户配置/插件等） |
| `CLAUDE_EXTRA_ARGS` | 空 | 额外 CLI 参数，按空格切分（不支持引号） |
| `CLAUDE_ENV_PASSTHROUGH` | 见下 | 允许透传给子进程的环境变量名（逗号分隔） |
| `CLAUDE_KILL_GRACE_MS` | `5000` | SIGTERM 到 SIGKILL 的宽限 |
| `MAX_CONCURRENT_TASKS` | `2` | 同时运行的 CLI 进程数 |
| `MAX_QUEUE_SIZE` | `32` | 等待队列上限，超出返回 `queue_full` |
| `TASK_TIMEOUT_MS` | `600000` | 默认任务超时（从开始执行算起） |
| `MAX_TASK_TIMEOUT_MS` | `3600000` | 请求里 `timeout_ms` 的上限 |
| `MAX_EVENTS_PER_TASK` | `5000` | 每任务事件保留上限（超出仅保留实时推送） |
| `SSE_MAX_BUFFER_BYTES` | `8388608` | 事件重放缓冲字节上限 |
| `SSE_HEARTBEAT_MS` | `15000` | SSE 心跳间隔 |
| `TASK_TTL_MS` | `0` | 终态任务保留时长；`0` 表示不自动清理。清理会同时删除内存与磁盘数据 |
| `BODY_LIMIT` | `512kb` | JSON 请求体上限 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`（JSON 行日志） |

`CLAUDE_ENV_PASSTHROUGH` 默认包含 `PATH`、`HOME`、`LANG`、`TZ`、`SHELL`、
`ANTHROPIC_*`、`AWS_*`、`CLAUDE_CODE_USE_BEDROCK/VERTEX`、代理变量等。
`SERVICE_API_KEY`、`PORT` 等**不会**透传给 Claude 子进程，避免凭据串用。

## 并发、超时与连接语义

- 任务创建后进入 FIFO 队列；运行数达到 `MAX_CONCURRENT_TASKS` 时状态为 `queued`，
  `queue_position` 给出排队位置。
- 超时从任务**开始执行**时计算，不包含排队时间。
- SSE 断线只解除订阅，任务继续执行；重连时用 `from_seq`（或 `Last-Event-ID`）补齐事件。
  需要断开即取消时用 `cancel_on_disconnect=1`。
- 终态事件之后服务会发送 `end` 并关闭 SSE，客户端不会无限挂起。
- 任务状态与事件保存在内存中，同时逐条落盘到 `STATE_DIR`；进程重启后自动从磁盘重建，
  重启前未结束的任务会被标记为 `failed`（`server_restarted`）。详见「数据持久化」。
- `TASK_TTL_MS` 控制终态任务的保留时长，清理时内存与磁盘一并删除。

## 安全与运维

- 容器内默认 `bypassPermissions`，Claude 可自主执行工具。请只在受控容器/网络中使用，
  并对 `workspace/` 采用最小权限挂载。
- 服务不写死任何密钥；凭据只从环境变量读取，且不会透传给子进程之外的地方。
- 若服务需要跨机器访问，务必设置 `SERVICE_API_KEY` 并置于 TLS 反向代理之后。
- 每次任务都是独立的 `claude -p` 进程，并带 `--no-session-persistence`，
  不会复用/污染历史会话。
- 建议为容器设置 CPU/内存限制（例如 `--cpus=2 --memory=4g`），避免并发任务耗尽资源。

## 本地测试

测试直接调用真实的 `claude` 二进制（使用一个无效 API Key 验证认证失败的完整链路），
覆盖健康检查、参数校验、SSE、断线重放、并发排队、取消、超时、队列上限，以及
持久化相关的三项验证：重启后任务与事件仍可查询/重放、`running` 任务被标记
`server_restarted`、TTL 到期后内存与磁盘同步删除。

```bash
npm ci
npm test
```

要求：本机已安装 `claude`，且能访问 Anthropic API（失败会快速返回，不会挂起）。

## 验证范围

- 无头参数、NDJSON 事件结构、`--verbose` 强制要求、stdin 传参、退出码与
  `is_error` 组合语义：已在 Claude Code 2.1.236 上实测。
- 容器内 2.1.319 的 `/healthz`、`/readyz`、创建任务、SSE 过程事件与错误终态：
  已实际构建并运行验证。
- 文件持久化（`STATE_DIR` 落盘、重启恢复、`server_restarted` 标记、TTL 磁盘清理）：
  已在本地测试中实测通过（12/12）。
- 成功执行（`succeeded`）路径需要真实有效的凭据才能端到端跑通；本环境未配置有效
  凭据，因此验证覆盖到「真实调用 → 认证失败 → 明确错误语义」为止。配置真实 Key 后
  无需改代码即可跑通成功路径。
