/**
 * 内置的 OpenAI 兼容提供方预设。只是“默认值”：baseURL、环境变量名、默认模型。
 * 在 `.leo/config.json` 的 `providers.<id>` 里可以覆盖任何字段，也可以添加不在列表中的提供方。
 *
 * 默认模型可能随厂商更新而变化，请以厂商文档为准，必要时在配置中指定 `model`。
 */
import type { ModelInfo } from '../llm/types.js'

export interface ProviderPreset {
  id: string
  name: string
  baseURL: string
  /** 回退读取的环境变量 */
  envKeys: string[]
  /** 未指定模型时使用 */
  defaultModel?: string
  models?: ModelInfo[]
  /** 本地服务不需要密钥（会发送占位 key） */
  keyless?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    envKeys: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', contextWindow: 128_000, maxOutputTokens: 8192 },
      { id: 'deepseek-reasoner', contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4o-mini',
    maxTokensField: 'max_completion_tokens',
  },
  qwen: {
    id: 'qwen',
    name: '通义千问（DashScope 兼容模式）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKeys: ['DASHSCOPE_API_KEY'],
    defaultModel: 'qwen-plus',
  },
  moonshot: { id: 'moonshot', name: 'Moonshot / Kimi', baseURL: 'https://api.moonshot.cn/v1', envKeys: ['MOONSHOT_API_KEY'] },
  zhipu: { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', envKeys: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'] },
  siliconflow: { id: 'siliconflow', name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', envKeys: ['SILICONFLOW_API_KEY'] },
  openrouter: { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'] },
  ollama: { id: 'ollama', name: 'Ollama（本地）', baseURL: 'http://localhost:11434/v1', envKeys: [], keyless: true },
}
