/**
 * `.leo/config.json` 的结构（项目级）与 `~/.leo/config.json`（用户级）。项目配置覆盖用户配置。
 * 所有字段都可选：不写配置文件也能运行（自动探测已配置密钥的提供方）。
 */
import { z } from 'zod'

const modelInfo = z.object({
  id: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  pricing: z
    .object({ inputPerMTok: z.number(), outputPerMTok: z.number(), cachedInputPerMTok: z.number().optional() })
    .optional(),
})

export const ProviderConfigSchema = z
  .object({
    /** 协议，目前内置 `openai-compatible`；其他值需由插件处理（见 `config/providerKinds`） */
    type: z.string().default('openai-compatible'),
    /** false 时不加载 */
    enabled: z.boolean().default(true),
    baseURL: z.string().optional(),
    /** 密钥：`$ENV_NAME` / `!command` / 字面值（不推荐把字面值提交到仓库，用 credentials.json） */
    apiKey: z.string().optional(),
    /** 回退环境变量名 */
    apiKeyEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** 模型元信息：字符串只声明 id（上下文窗口按默认值） */
    models: z.array(z.union([z.string(), modelInfo])).optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    sendReasoning: z.boolean().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
  })
  .passthrough()

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/** 插件条目：`"./.leo/plugins/x.js"`、`"leo-plugin-foo"`、`["leo-plugin-foo", { ...config }]` */
export const PluginEntrySchema = z.union([z.string(), z.tuple([z.string(), z.unknown()])])

export const LeoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** 默认模型：`providerId/modelId` */
    model: z.string().optional(),
    /** 提供方：key 为 provider id。内置预设（deepseek/openai/qwen/...）只需写需要覆盖的字段 */
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    /** 额外插件（按顺序加载）。相对路径相对于该配置文件所在的 .leo 目录的上级（项目根） */
    plugins: z.array(PluginEntrySchema).default([]),
    tools: z
      .object({
        /** 启用的内置工具；false 关闭全部。默认全部：read_file, write_file, edit_file, list_dir, grep, bash, web_fetch */
        builtin: z.union([z.array(z.string()), z.literal(false)]).optional(),
        /**
         * 有副作用的工具（写文件、执行命令）如何审批：
         * ask：交互式询问（非交互模式下拒绝）；auto：直接执行；deny：一律拒绝
         */
        approval: z.enum(['ask', 'auto', 'deny']).default('ask'),
        /** 工作目录（文件工具的根），默认项目根 / 当前目录 */
        workspace: z.string().optional(),
        /** 允许文件工具访问工作目录之外的路径，默认 false */
        allowOutsideWorkspace: z.boolean().default(false),
        /** bash 工具单次超时（毫秒），默认 120000 */
        bashTimeoutMs: z.number().int().positive().optional(),
      })
      .default({ approval: 'ask', allowOutsideWorkspace: false }),
    agent: z
      .object({
        /** 覆盖默认 system prompt */
        systemPrompt: z.string().optional(),
        /** 追加在默认 system prompt 之后 */
        appendSystemPrompt: z.string().optional(),
        maxSteps: z.number().int().positive().optional(),
        maxTurnTokens: z.number().int().positive().optional(),
        maxTurnCostUsd: z.number().positive().optional(),
        turnTimeoutMs: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        temperature: z.number().optional(),
      })
      .default({}),
    sessions: z.object({ dir: z.string().optional(), persist: z.boolean().default(true) }).default({ persist: true }),
    context: z
      .object({
        defaultContextWindow: z.number().int().positive().optional(),
        reserveOutputTokens: z.number().int().positive().optional(),
        softLimitRatio: z.number().positive().max(1).optional(),
        keepRecentTurns: z.number().int().nonnegative().optional(),
      })
      .default({}),
    logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  })
  .passthrough()

export type LeoConfig = z.infer<typeof LeoConfigSchema>
export type LeoConfigInput = z.input<typeof LeoConfigSchema>
