# 更新日志

## 未发布（feat/provider-plugin 分支，计划 0.2.0）

**破坏性变更：模型供应商插件化，底座不再内置任何模型厂商。**

- 移除 `PROVIDER_PRESETS`（DeepSeek / OpenAI / 通义 / Kimi / 智谱 / SiliconFlow / OpenRouter / Ollama 预设）、`OpenAICompatibleProvider`、`parseSSE`、`providerKinds` 服务、`openaiCompatible()` / `deepseek()` 等辅助函数，以及按密钥自动探测厂商。它们移到 leo-plugin 的 `provider`（注册层，自带通用 OpenAI 兼容协议）与 `provider-deepseek`（DeepSeek 子插件）
- 保留接缝：`llm` 服务、`LlmProvider` 接口、`llm/stream` 中间件、`providerPlugin()`（从 providers 目录移到 llm）、`MockProvider`
- `LlmProvider` 新增可选 `name`、`defaultModel`、`listModels()`、`status()`；`leo models` / `leo doctor` 显示插件注册的 provider、密钥来源和提供它的插件；不可用（如缺密钥）的 provider 不会被选为默认模型
- 新增服务 `leoConfig`（合并后的 `.leo/config.json`，只读）：供应商插件读取 `model` 与 0.1.x 的 `providers`，旧配置装上插件后照常生效。`providers` 的值底座不再校验
- `toLeoError` 识别插件抛的错误：带 `Symbol.for('leo.error')` 标记（导出为 `LEO_ERROR_MARK`）或 `name === 'LeoError'`、且 `code` 合法时保留 code / status / retryAfterMs（插件不能运行时 import leo-agents）。之前这类错误一律当 network 重试
- `LeoApp.model` / `LeoApp.providers` / `agentFactory.defaultModel` 改为每次读取时计算，供应商插件热加载后随之变化
- `leo init` 不再列内置厂商，只问密钥并提示安装 `provider` / `provider-deepseek`；没有模型时按“没装注册层”“没有驱动”“缺密钥”分别提示
- `.leo/config.json` 模板不再写 `providers`
- `credentials` 服务的类型声明移到 `config/create.ts`

## 0.1.2 — 2026-10-31

0.1.2 让 leo 能**常驻运行插件**：`leo serve` 后台在线、插件可按宿主配置创建 Agent、插件能给用户发提示，卸载时可清理插件写入的凭据。消息网关（gateway 0.2.x）及其 QQ / 飞书子插件依赖这些能力。

### 新增

- `leo plugin remove <id> --purge` 同时清理插件写进 `credentials.json` 的凭据：按插件清单 / registry 里的 `purge.credentials` 删除（`/` 结尾按前缀匹配），其他凭据保留。例如 gateway-qq 卸载后再装会重新扫码。
- 新增 `agentFactory` 服务：插件按宿主配置（默认模型、系统提示词、步数 / 预算 / 超时）创建 Agent。
- 新增 `leo serve`：后台常驻，只加载配置与插件并保持在线（网关等插件用它运行），Ctrl+C / SIGTERM 退出。
- 新增 `plugin/notice` 事件：插件给用户看的一行提示（如网关监听地址、渠道连接状态）。`leo serve` 与交互式 `leo` 打印为 `[插件名] 提示`；嵌入使用时通过 `createLeoFromConfig({ onNotice })` 接收，插件启动阶段发的提示也能收到。

## 0.1.1 — 2026-10-31

0.1.0 是“能跑起来的底座”：插件内核、通用 Agent Loop、OpenAI 兼容 Provider、`.leo` 配置和 `leo` 命令行。
0.1.1 在此基础上补齐**插件生态的最后一公里**：插件能一条命令装好、装好就有配置文件、装卸改都不用重启。

### 新增

**插件安装与管理（`leo plugin`）**

- `leo plugin list / add / remove / init`：从官方插件仓库（registry）安装预构建 bundle（sha256 校验、`leo` 版本范围检查），或用 `--npm` 安装 npm 包。
- **默认全局安装**到 `~/.leo`，所有项目可用；`--project` / `--local` / `-l` 安装到当前项目的 `.leo/`；`-g` 兼容保留。
- 全局与项目同时安装同一插件时**项目版本优先**，并继承全局配置项（项目未单独配置时）。
- **安装即初始化**：插件在 registry 中声明了配置模板（`init.files`）时，`add` 自动写入（如 mcp 的 `mcp-servers.json`、sub-agents 的 `agents/explorer.md`），已有文件不覆盖；`--no-init` 跳过，`--init-from <path>` 使用自定义模板，`leo plugin init <id> [--force]` 单独初始化；模板经 sha256 校验并限制只能写入 `.leo` 内。
- `leo plugin remove` 默认卸载全局；`--project` 只卸项目，`--all` 两处都卸，`--purge` 同时删除初始化生成的配置文件（默认保留）；另一作用域仍安装时给出提示。支持 bundle、`config.json` 插件项和 npm 包。
- 修改 `config.json` 的 `plugins` 数组时保留 JSONC 注释与格式。

**插件热加载**

- 运行中的 leo 监听 `~/.leo` 与项目 `.leo` 下的 `config.json`、`plugins/` 以及各插件声明的 `watch` 路径：安装、更新、删除、改配置、改数据文件都**无需重启**，新版本加载失败会自动回退到旧版本。
- 新增 `PluginDefinition.watch` 字段，插件可声明需要监听的数据文件或目录（如 `['mcp-servers.json']`、`['agents/']`）。
- 新增事件 `plugin/loaded`、`plugin/unloaded`、`plugin/failed`；新增 API `app.reloadPlugins()`、`app.loadedPlugins()`；`watchPlugins: false` 可关闭。
- 交互模式新增 `/plugins`、`/plugins reload`。
- 注：模型 / Provider 等宿主配置变更仍需重启。

**工具与 Agent**

- `Permission.sideEffect`：插件声明的新副作用类型（如 `mcp.call`）同样遵循 ask / auto / deny / `-y` 审批策略。
- 工具过滤在执行阶段强制生效：Agent 调用不在其 ToolFilter 内的工具会被拒绝（此前只是隐藏 schema）。
- `AgentOptions.label`：审批提示中显示是哪个 Agent 在请求。
- 工具进度约定 `{ type: 'progress', message }`，CLI 实时显示。
- `createLeoFromConfig` 提供 `leoPaths` 服务（cwd、项目根、`.leo`、`~/.leo`）；插件包可从 `.leo/`、项目根、`~/.leo` 的 node_modules 解析，支持纯 ESM 导出。

### 文档

- `docs/development-guide.md` 补充插件安装、配置模板、热加载与 `watch` 约定。
- 安装指南补充 `chmod +x` 步骤。

### 配套

- 官方插件仓库 leo-plugin 已同步：mcp 与 sub-agents 升级到 0.1.1（声明 `watch`、支持热卸载与重复加载），registry 带配置模板。

### 兼容性

- 相对 0.1.0 无破坏性变更，只新增能力。
- 测试 75 项通过，typecheck 与 build 通过。
