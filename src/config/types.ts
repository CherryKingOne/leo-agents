/**
 * `.leo/config.json` 的结构（项目级）与 `~/.leo/config.json`（用户级）。项目配置覆盖用户配置。
 * 所有字段都可选。模型供应商由插件提供（leo plugin add provider / provider-deepseek），底座本身不内置任何厂商。
 */
import { z } from 'zod'

/**
 * `providers.<id>`：0.1.x 的模型供应商写法。底座不再解析它，原样交给模型供应商插件（leo-plugin 的 provider）读取，
 * 所以旧配置装上插件后照常生效。新写法见插件的 `provider.json`
 */
export const ProviderConfigSchema = z.record(z.string(), z.unknown())
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/** 插件条目：`"./.leo/plugins/x.js"`、`"leo-plugin-foo"`、`["leo-plugin-foo", { ...config }]` */
export const PluginEntrySchema = z.union([z.string(), z.tuple([z.string(), z.unknown()])])

export const LeoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** 默认模型：`providerId/modelId`。不写时用默认 provider 的默认模型（由模型供应商插件决定） */
    model: z.string().optional(),
    /** 0.1.x 写法的模型供应商配置，底座不解析，由模型供应商插件读取（见 ProviderConfigSchema） */
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
        /**
         * 思考模式与推理强度，如 `{ "enabled": true, "effort": "high" }`。不写由模型决定；
         * 每个模型支持的档位见 `leo models`。也可用 --thinking / --effort 或交互命令 /think、/effort 临时调整
         */
        reasoning: z
          .object({
            enabled: z.boolean().optional(),
            effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
          })
          .optional(),
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
