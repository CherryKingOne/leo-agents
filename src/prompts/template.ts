/**
 * 提示词模板：极简 frontmatter 解析 + `{{var}}` / `{{#var}}…{{/var}}` 渲染。
 * 刻意不引入 YAML / 模板引擎依赖，保持底座零额外依赖。
 */
import { LeoError } from '../errors.js'
import { LAYER_ORDER, type PromptLayer } from '../context/types.js'

/** 一个提示词模板（来自 .md 文件或代码） */
export interface PromptTemplate {
  id: string
  layer: PromptLayer
  /** 同层升序，默认 100 */
  priority?: number
  /** `tools`：仅当本次请求带工具时注入 */
  when?: 'tools'
  /** 模板正文 */
  body: string
  /** 来源文件（诊断用） */
  source?: string
}

/** 解析 `---\nkey: value\n---\n正文`；没有 frontmatter 或没有 id 返回 undefined */
export function parsePromptFile(text: string, source?: string): PromptTemplate | undefined {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*([\w.-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, '')
  }
  if (!meta.id) return undefined
  const layer = (meta.layer ?? 'platform') as PromptLayer
  if (!LAYER_ORDER.includes(layer)) {
    throw new LeoError('plugin_config_invalid', `Prompt "${meta.id}"${source ? ` (${source})` : ''}: unknown layer "${meta.layer}"`)
  }
  const t: PromptTemplate = { id: meta.id, layer, body: m[2]!.trim() }
  if (meta.priority !== undefined) {
    const n = Number(meta.priority)
    if (!Number.isFinite(n)) throw new LeoError('plugin_config_invalid', `Prompt "${meta.id}": priority must be a number`)
    t.priority = n
  }
  if (meta.when === 'tools') t.when = 'tools'
  if (source) t.source = source
  return t
}

/**
 * 渲染模板：
 * - `{{name}}` 替换为变量值，未定义为空串
 * - `{{#name}}…{{/name}}` 变量非空时保留内容，否则整体移除
 * 渲染后会把连续 3 个以上空行压成 2 个。
 */
export function renderTemplate(body: string, vars: Record<string, unknown>): string {
  const get = (k: string): string => {
    const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), vars)
    return v === undefined || v === null ? '' : String(v)
  }
  const sections = body.replace(/\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_, k: string, inner: string) => (get(k) ? inner : ''))
  return sections
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => get(k))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
