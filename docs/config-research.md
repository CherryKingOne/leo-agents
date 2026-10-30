# 配置与第三方接入调研：DeepSeek Harness 与 pi

> 2026-10-30 基于两个仓库的公开文档整理（`deepseek-ai/deepseek-harness` 的 docs/、packages/credentials、packages/llm；
> `earendil-works/pi` 的 packages/coding-agent/docs）。用于决定 leo-agents 的 `.leo` 配置方案。

## pi

| 方面 | 做法 |
|---|---|
| 目录 | 用户级 `~/.pi/agent/`（`PI_CODING_AGENT_DIR` 可改），项目级 `.pi/`。项目配置在用户“信任项目”后才加载 |
| 文件拆分 | `settings.json`（偏好、默认模型、默认工具、包列表）、`models.json`（自定义端点/模型/覆盖）、`auth.json`（API key 与 OAuth 凭据）、`mcp.json`、`SYSTEM.md` / `APPEND_SYSTEM.md`、`extensions/`、`skills/`、`prompts/` |
| 合并 | 项目设置覆盖用户设置；资源列表合并。`defaultTools` 支持 `+name` / `-name` 增量修改 |
| 密钥 | `/login` 交互保存到 `auth.json`，或环境变量（每个提供方一个，如 `DEEPSEEK_API_KEY`）。值支持 `$NAME` / `${NAME}` / `!command`，命令结果进程内缓存 |
| 密钥优先级 | 运行时 `--api-key` > `auth.json` > `models.json` 的 `apiKey` > 环境变量 / 云厂商默认凭据 |
| 兼容端点 | `models.json` 的 `providers.<id>`：`baseUrl`、`api`（openai-completions / anthropic / google…）、`apiKey`、`headers`、`models`；只写 `baseUrl` 即可把内置提供方转到代理 |
| 第三方提供方 | 扩展里 `pi.registerProvider()`：只改 baseUrl/headers、注册兼容端点、或实现完整 Provider（自定义认证、动态模型、私有协议、OAuth） |
| 开箱体验 | 安装即用：`pi` → `/login` → 直接下任务；内置 read / bash / edit / write 等工具，不逐条审批（官方建议用容器隔离） |

## DeepSeek Harness（dsh）

| 方面 | 做法 |
|---|---|
| 目录 | harness home `$DSH_HOME`（默认 `~/.dsh`），Cordis profile + `cordis.patch.yml` 分层：profile bundle → profile patch → home patch → `--patch` |
| 插件配置 | 每个插件导出 `Config` schema（schemastery），在 `cordis.yml` 的插件行写 `config:`；加载时校验并填默认值，非法配置“响亮地”失败；改配置触发插件热替换 |
| 密钥 | `credentials` seam：配置里只写凭据名（`apiKeyEnv: DEEPSEEK_API_KEY`），值放在 `credentials-local` 的 `~/.dsh/.credentials.yaml`（仅本用户可读）。查找顺序：存储文件 > 启动环境 > 项目 `.env` > home `.env`；`describe()` 只返回是否配置与来源，永不返回明文 |
| 模型接入 | 全部是插件：`dsh-llm-deepseek`、`dsh-llm-deepseek-api-key`、`dsh-llm-pi-ai`（复用 pi-ai 的多厂商目录）。自定义端点在 profile 中声明 `api`（openai-completions / openai-responses / anthropic-messages）、`baseURL`、`models`、`apiKeyEnv` |
| 第三方 | 插件市场 + bundle（`package.json` 的 `dsh` 字段）；Web UI 的“添加模型提供商”可选内置目录或自定义 API |
| 开箱体验 | `dsh` 启动 Web UI，在“设置 → 模型”填密钥即可用；有 headless / sdk / acp 等 profile |

## leo-agents 的取舍

| 决策 | 来源 | 说明 |
|---|---|---|
| `~/.leo/` + 项目 `.leo/` 两级目录 | pi | 结构直观，项目配置可提交、密钥与会话不提交 |
| `config.json` + `credentials.json` 分离 | pi + dsh | 配置可以进仓库，密钥单独存放、权限 600、`leo init` 自动加入 .gitignore |
| 密钥值 `$ENV` / `!command` / 字面值 | pi | 能直接对接 1Password、Keychain、vault |
| 统一凭据服务 `ctx.get('credentials')`，`describe()` 不返回明文 | dsh | 第三方提供方插件也走同一套来源与优先级 |
| 优先级 `--api-key` > 项目 > 用户 > 配置 > 环境变量 | pi | 与 pi 一致，额外区分项目/用户两级 |
| 配置用 zod 校验，非法即失败 | dsh | 不静默忽略拼错的字段值 |
| 模型接入改为插件 + 提供方类型注册表 `providerKinds` | dsh + pi | 配置写 `type`，插件提供实现；简单场景只写 `baseURL` |
| 自带 `leo` 命令行与内置工具 | pi | 不写代码就能跑通、干活；写文件/执行命令默认询问，比 pi 更保守 |
| 暂未做 | — | 项目信任机制、OAuth 登录、配置热重载、Anthropic/Google 原生协议、模型目录在线更新 |
