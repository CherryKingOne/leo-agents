/**
 * 默认提示词插件：把 `prompts/*.md`（人设、工作方式、工具规范、安全底线、输出格式、运行环境）
 * 注册为 context 服务的 PromptSection。
 *
 * 覆盖方式（优先级从低到高）：
 *   内置 prompts/ 目录  <  options.dir 目录（同 id 覆盖、新 id 追加）  <  options.overrides（字符串替换正文 / false 禁用）
 * 变量取值优先级：agent.state  >  options.vars  >  内置变量
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssembleInput } from '../context/types.js'
import { definePlugin } from '../kernel/plugin.js'
import { parsePromptFile, type PromptTemplate, renderTemplate } from './template.js'

export interface PromptsOptions {
  /** 是否加载内置默认片段，默认 true；false 时只用 dir / templates */
  defaults?: boolean
  /** 额外的提示词目录：同 id 覆盖内置片段，新 id 追加 */
  dir?: string | string[]
  /** 代码方式追加/覆盖的模板 */
  templates?: PromptTemplate[]
  /** 按 id 覆盖：字符串替换正文（保留原 layer/priority），false 禁用该片段 */
  overrides?: Record<string, string | false>
  /** 模板变量，例如 { assistantName: '小智', organization: 'Acme', language: '简体中文' } */
  vars?: Record<string, unknown>
  /** 渲染 {{date}} 使用的时区，默认进程时区 */
  timezone?: string
  /** 测试 / 回放时固定时间 */
  now?: () => Date
}

/** 内置 prompts/ 目录（src 与 dist 下都位于包根目录的 prompts/） */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url))

/** 读取目录下所有带 frontmatter id 的 .md 模板（按文件名排序） */
export async function loadPromptDir(dir: string): Promise<PromptTemplate[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  const out: PromptTemplate[] = []
  for (const f of files) {
    const path = join(dir, f)
    const t = parsePromptFile(await readFile(path, 'utf8'), path)
    if (t) out.push(t)
  }
  return out
}

/** 合并模板来源并应用 overrides，返回最终生效的模板列表 */
export async function resolvePromptTemplates(opts: PromptsOptions = {}): Promise<PromptTemplate[]> {
  const byId = new Map<string, PromptTemplate>()
  const add = (list: PromptTemplate[]) => list.forEach((t) => byId.set(t.id, t))
  if (opts.defaults !== false) add(await loadPromptDir(DEFAULT_PROMPTS_DIR))
  for (const d of [opts.dir ?? []].flat()) add(await loadPromptDir(d))
  add(opts.templates ?? [])
  for (const [id, v] of Object.entries(opts.overrides ?? {})) {
    if (v === false) byId.delete(id)
    else {
      const base = byId.get(id)
      byId.set(id, base ? { ...base, body: v } : { id, layer: 'platform', body: v })
    }
  }
  return [...byId.values()]
}

function builtinVars(input: AssembleInput, opts: PromptsOptions): Record<string, unknown> {
  const timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = opts.now?.() ?? new Date()
  // en-CA 输出 YYYY-MM-DD
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return {
    assistantName: 'Leo',
    organization: '',
    language: '',
    date,
    timezone,
    model: input.model,
    agentId: input.agentId,
    sessionId: input.sessionId,
    tenantId: input.tenant?.tenantId ?? '',
  }
}

/** 默认提示词插件；`createLeo` 默认加载，`createLeo({ prompts: false })` 关闭 */
export const promptsPlugin = definePlugin<PromptsOptions | undefined>({
  name: 'leo:prompts',
  inject: ['context'],
  async apply(ctx, config) {
    const opts = config ?? {}
    const templates = await resolvePromptTemplates(opts)
    for (const t of templates) {
      await ctx.effect(() =>
        ctx.get('context').registerSection({
          id: t.id,
          layer: t.layer,
          ...(t.priority !== undefined ? { priority: t.priority } : {}),
          render: (input) => {
            if (t.when === 'tools' && !input.tools?.length) return undefined
            return renderTemplate(t.body, { ...builtinVars(input, opts), ...opts.vars, ...input.state })
          },
        }),
      )
    }
  },
})
