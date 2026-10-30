# leo api：以服务方式运行 leo

`leo` 默认进入对话；`leo api` 则不进入对话，而是起一个常驻 HTTP 服务：

- Node 进程持有常驻的 leo 实例：配置、密钥、插件与 `leo` 完全一致，**插件一直在线**（例如 chat-channels 的 QQ / 飞书长连接）；
- 对外的 HTTP 服务由 Python 3.12 编写（`python/leo_api`，只用标准库），用 **uv** 管理环境，作为子进程启动；
- 两者通过子进程的 stdin/stdout 交换 JSON Lines（协议见 `src/api/bridge.ts`），不占额外端口。

```bash
leo api                                   # 默认 http://127.0.0.1:8765
leo api --port 9000 -y                    # -y：自动批准写文件/执行命令（API 模式没人审批，默认会拒绝）
leo api --host 0.0.0.0 --token s3cret     # 对外监听时务必设置令牌
leo api --python 3.12                     # 传给 uv run --python（默认 3.12）
```

## Python 环境（uv）

- 需要先安装 [uv](https://docs.astral.sh/uv/)：`curl -LsSf https://astral.sh/uv/install.sh | sh` 或 `brew install uv`；
- `python/pyproject.toml` 与 `.python-version` 锁定 Python 3.12（`uv.lock` 无第三方依赖）；
- `leo api` 实际执行 `uv run --project python/ --frozen --python 3.12 python -m leo_api`，虚拟环境放在 `~/.leo/api/.venv`（不写进安装目录），本机没有 3.12 时 uv 会自动下载；
- 自定义 uv 路径用 `LEO_UV`；没装 uv 时会退回本机的 Python 3.12（`python3.12` / `LEO_PYTHON`）并给出提示。

单独开发 Python 部分：`cd python && uv sync && uv run python -m leo_api --help`。

环境变量：`LEO_API_HOST`、`LEO_API_PORT`、`LEO_API_TOKEN`、`LEO_UV`、`LEO_PYTHON`。Ctrl+C 停止（Python 与 leo 一起退出）。

## 接口

设置了令牌时，除 `/health` 外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/v1/info` | 版本、默认模型、插件、工具、活跃会话 |
| GET | `/v1/models` | 提供方与默认模型 |
| GET | `/v1/tools` | 工具列表（JSON Schema，含插件注册的工具） |
| GET | `/v1/plugins` | 插件树与服务表 |
| GET | `/v1/sessions` | 会话列表 |
| GET | `/v1/sessions/{id}/messages` | 会话消息 |
| DELETE | `/v1/sessions/{id}` | 删除会话 |
| POST | `/v1/sessions/{id}/abort` | 取消会话当前任务 |
| POST | `/v1/chat` | 对话 |
| POST | `/v1/tools/{name}` | 直接调用工具（含插件工具） |
| POST | `/v1/chat/completions` | OpenAI 兼容对话 |

### 对话

```bash
curl -s localhost:8765/v1/chat -d '{"message": "你好"}'
# {"sessionId": "ses_...", "text": "...", "reason": "completed", "usage": {...}, "steps": 1}

# 续聊：带上 session_id
curl -s localhost:8765/v1/chat -d '{"message": "继续", "session_id": "ses_..."}'

# 流式（SSE）：stream: true 或 Accept: text/event-stream
curl -N localhost:8765/v1/chat -d '{"message": "写一首诗", "stream": true}'
# event: text_delta / tool_start / tool_result / ... / done
```

可选参数：`model`（如 `deepseek/deepseek-chat`）、`system_prompt`、`max_steps`。同一会话同一时间只能跑一个任务，忙时返回 409。

### 调用插件工具

```bash
curl -s localhost:8765/v1/tools/chat_channels -d '{}'
curl -s localhost:8765/v1/tools/chat_send -d '{"arguments": {"account": "qq", "chat_id": "<openid>", "text": "hi"}}'
```

有副作用的工具（如 `chat_send`、写文件、执行命令）走同一套审批策略：`tools.approval` 为 `ask` 时 API 模式没人审批会被拒绝，用 `leo api -y` 或把配置改成 `auto`。

### OpenAI 兼容

任何支持 OpenAI 接口的客户端都可以把 Base URL 设成 `http://127.0.0.1:8765/v1`。取最后一条 user 消息作为输入，system 消息作为 system prompt；
会话用请求体的 `user` 字段或 `X-Session-Id` 头指定（不指定就是新会话，响应里的 `session_id` 可用于续聊）；`model` 写 `leo` 使用默认模型。

### 错误

`{"error": {"code": "...", "message": "..."}}`：`invalid_params` 400、`unauthorized` 401、`not_found` / `tool_not_found` 404、`busy` 409、`no_model` 503。
