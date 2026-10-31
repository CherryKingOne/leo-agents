/** `leo models` / 交互命令 /models、/think、/effort 的公共部分 */
import { REASONING_EFFORTS, type LlmService, type ModelInfo, type ProviderModels, type ReasoningEffort, type ReasoningOptions } from '../llm/types.js'

/** 一个可选的模型（带 provider 前缀的引用 + 详情） */
export interface ModelChoice {
  ref: string
  provider: string
  info: ModelInfo
}

const tokens = (n: number) => (n >= 1024 * 1024 && n % (1024 * 1024) === 0 ? `${n / 1024 / 1024}M` : n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

/** 一行模型详情：展示名 · 上下文 · 最大输出 · 输入模态 · 思考档位 */
export function describeModel(m: ModelInfo): string {
  const parts: string[] = []
  if (m.name && m.name !== m.id) parts.push(m.name)
  parts.push(`上下文 ${tokens(m.contextWindow)}`)
  if (m.maxOutputTokens) parts.push(`最大输出 ${tokens(m.maxOutputTokens)}`)
  if (m.inputModalities?.length) parts.push(`输入 ${m.inputModalities.join('+')}`)
  const r = m.reasoning
  if (r?.supported) {
    const efforts = r.efforts?.length ? `，强度 ${r.efforts.map((e) => (e === r.defaultEffort ? `${e}*` : e)).join('/')}` : ''
    parts.push(`思考${r.defaultEnabled === false ? '（默认关）' : '（默认开）'}${efforts}`)
  } else if (r && !r.supported) parts.push('不支持思考')
  return parts.join(' · ')
}

/** 拉取所有 provider 的模型（实时获取失败时退回内置列表），按 provider 顺序编号 */
export async function collectModels(llm: LlmService, opts: { refresh?: boolean; timeoutMs?: number; provider?: string } = {}): Promise<{ groups: ProviderModels[]; choices: ModelChoice[] }> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000)
  const groups = await llm.models({ refresh: opts.refresh ?? true, signal, ...(opts.provider ? { provider: opts.provider } : {}) })
  const choices = groups.flatMap((g) => g.models.map((info) => ({ ref: `${g.provider.id}/${info.id}`, provider: g.provider.id, info })))
  return { groups, choices }
}

/** `on` / `off` 等写法 → boolean；无法识别返回 undefined */
export function parseSwitch(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined
  const s = v.toLowerCase()
  if (['on', 'true', '1', 'yes', 'enabled', 'enable', '开', '开启'].includes(s)) return true
  if (['off', 'false', '0', 'no', 'disabled', 'disable', '关', '关闭'].includes(s)) return false
  return undefined
}

export function parseEffort(v: string | undefined): ReasoningEffort | undefined {
  return REASONING_EFFORTS.includes(v?.toLowerCase() as ReasoningEffort) ? (v!.toLowerCase() as ReasoningEffort) : undefined
}

/** 开关思考：关闭时去掉强度；开启时去掉 `none` */
export function withThinking(r: ReasoningOptions, enabled: boolean): ReasoningOptions {
  if (!enabled) return { enabled: false }
  return r.effort && r.effort !== 'none' ? { enabled: true, effort: r.effort } : { enabled: true }
}

/** 设置强度：`none` 等于关闭思考，其余档位同时开启思考 */
export function withEffort(effort: ReasoningEffort): ReasoningOptions {
  return effort === 'none' ? { enabled: false } : { enabled: true, effort }
}

/** 当前思考设置的一句话描述 */
export function describeReasoning(r: ReasoningOptions | undefined, info?: ModelInfo): string {
  if (info?.reasoning && !info.reasoning.supported) return '不支持思考'
  if (r?.enabled === false || r?.effort === 'none') return '思考关'
  const effort = r?.effort ?? info?.reasoning?.defaultEffort
  const on = r?.enabled === true ? '思考开' : info?.reasoning?.defaultEnabled === false ? '思考关（默认）' : '思考开（默认）'
  return effort ? `${on} · 强度 ${effort}${r?.effort ? '' : '（默认）'}` : on
}
