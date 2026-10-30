/**
 * 内置通用工具：让 Agent 开箱即可“干活”（读写文件、搜索、执行命令、抓取网页）。
 * 作为插件提供，可整体关闭、按名选择，或用同名工具覆盖。
 *
 * 安全：
 * - 文件工具限制在 workspace 内（allowOutsideWorkspace 可放开）；
 * - 有副作用的工具声明 permissions（fs.write / process.exec），由 `approvalPolicy` 插件决定 ask / auto / deny；
 * - 这些限制不是沙箱。生产环境请在容器 / 微 VM 中运行，或替换 bash 工具为沙箱实现。
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { definePlugin } from '../kernel/plugin.js'
import { defineTool, toolOutput } from './registry.js'
import type { ToolDefinition } from './types.js'

export interface BuiltinToolsOptions {
  /** 文件工具与 bash 的根目录，默认 process.cwd() */
  workspace?: string
  /** 只启用这些工具（默认全部） */
  tools?: string[]
  allowOutsideWorkspace?: boolean
  bashTimeoutMs?: number
}

export const BUILTIN_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'bash', 'web_fetch'] as const

const SKIP_DIRS = new Set(['.git', 'node_modules', '.leo', 'dist', '.next', '__pycache__', '.venv', 'venv'])
const MAX_READ_BYTES = 256 * 1024
const MAX_OUTPUT_CHARS = 30_000

function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n\n…[${text.length - max} characters omitted]…\n\n${text.slice(-half)}`
}

export function createBuiltinTools(opts: BuiltinToolsOptions = {}): ToolDefinition[] {
  const root = resolve(opts.workspace ?? process.cwd())
  const pathOf = (p: string) => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
    if (!opts.allowOutsideWorkspace && abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`Path is outside the workspace (${root}): ${p}`)
    }
    return abs
  }
  const rel = (abs: string) => relative(root, abs) || '.'

  const readFileTool = defineTool({
    name: 'read_file',
    description: 'Read a UTF-8 text file. Returns lines prefixed with line numbers. Use offset/limit (1-based lines) for large files.',
    parameters: z.object({
      path: z.string().describe('File path, relative to the workspace or absolute'),
      offset: z.number().int().positive().optional().describe('First line to read (1-based)'),
      limit: z.number().int().positive().optional().describe('Max lines to read, default 2000'),
    }),
    idempotent: true,
    async execute({ path, offset, limit }) {
      const abs = pathOf(path)
      const info = await stat(abs)
      if (info.isDirectory()) return toolOutput({ content: `${path} is a directory; use list_dir`, isError: true })
      const buf = await readFile(abs)
      if (buf.subarray(0, 8000).includes(0)) return toolOutput({ content: `${path} looks like a binary file`, isError: true })
      const lines = buf.subarray(0, MAX_READ_BYTES).toString('utf8').split('\n')
      const start = (offset ?? 1) - 1
      const slice = lines.slice(start, start + (limit ?? 2000))
      const body = slice.map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`).join('\n')
      const more = start + slice.length < lines.length || buf.length > MAX_READ_BYTES
      return more ? `${body}\n\n[file continues; ${lines.length} lines read so far, use offset to read more]` : body || '(empty file)'
    },
  })

  const writeFileTool = defineTool({
    name: 'write_file',
    description: 'Create or overwrite a text file with the given content. Parent directories are created automatically.',
    parameters: z.object({ path: z.string(), content: z.string() }),
    permissions: [{ kind: 'fs.write' }],
    executionMode: 'sequential',
    async execute({ path, content }) {
      const abs = pathOf(path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `Wrote ${Buffer.byteLength(content)} bytes to ${rel(abs)}`
    },
  })

  const editFileTool = defineTool({
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
    parameters: z.object({
      path: z.string(),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    permissions: [{ kind: 'fs.write' }],
    executionMode: 'sequential',
    async execute({ path, old_string, new_string, replace_all }) {
      const abs = pathOf(path)
      const text = await readFile(abs, 'utf8')
      const count = text.split(old_string).length - 1
      if (count === 0) return toolOutput({ content: `old_string not found in ${path}`, isError: true })
      if (count > 1 && !replace_all) {
        return toolOutput({ content: `old_string occurs ${count} times in ${path}; add more context or set replace_all`, isError: true })
      }
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string)
      await writeFile(abs, next, 'utf8')
      return `Edited ${rel(abs)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? 's' : ''})`
    },
  })

  const listDirTool = defineTool({
    name: 'list_dir',
    description: 'List files and directories (directories end with /). Skips .git, node_modules and similar.',
    parameters: z.object({
      path: z.string().optional().describe('Directory, default the workspace root'),
      depth: z.number().int().min(1).max(5).optional().describe('Recursion depth, default 2'),
    }),
    idempotent: true,
    async execute({ path, depth }) {
      const base = pathOf(path ?? '.')
      const out: string[] = []
      const walk = async (dir: string, d: number) => {
        if (out.length >= 500) return
        const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
        for (const e of entries) {
          if (out.length >= 500) return
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
          const p = join(dir, e.name)
          out.push(`${'  '.repeat((depth ?? 2) - d)}${e.name}${e.isDirectory() ? '/' : ''}`)
          if (e.isDirectory() && d > 1) await walk(p, d - 1)
        }
      }
      await walk(base, depth ?? 2)
      return out.length ? out.join('\n') + (out.length >= 500 ? '\n…(truncated)' : '') : '(empty directory)'
    },
  })

  const grepTool = defineTool({
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns path:line: text (max 200 matches).',
    parameters: z.object({
      pattern: z.string().describe('JavaScript regular expression'),
      path: z.string().optional().describe('File or directory, default the workspace root'),
      glob: z.string().optional().describe('Only files whose name ends with this suffix, e.g. ".ts"'),
      ignore_case: z.boolean().optional(),
    }),
    idempotent: true,
    async execute({ pattern, path, glob, ignore_case }, exec) {
      const re = new RegExp(pattern, ignore_case ? 'i' : '')
      const base = pathOf(path ?? '.')
      const out: string[] = []
      const visit = async (p: string) => {
        if (out.length >= 200 || exec.signal.aborted) return
        const info = await stat(p)
        if (info.isDirectory()) {
          for (const e of await readdir(p, { withFileTypes: true })) {
            if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
            await visit(join(p, e.name))
          }
          return
        }
        if ((glob && !p.endsWith(glob)) || info.size > 1024 * 1024) return
        const buf = await readFile(p)
        if (buf.subarray(0, 8000).includes(0)) return
        buf
          .toString('utf8')
          .split('\n')
          .forEach((line, i) => {
            if (out.length < 200 && re.test(line)) out.push(`${rel(p)}:${i + 1}: ${line.slice(0, 300)}`)
          })
      }
      await visit(base)
      return out.length ? out.join('\n') + (out.length >= 200 ? '\n…(more matches omitted)' : '') : 'No matches'
    },
  })

  const bashTool = defineTool({
    name: 'bash',
    description:
      'Run a shell command in the workspace directory and return its combined stdout/stderr and exit code. Avoid interactive commands.',
    parameters: z.object({
      command: z.string(),
      timeout_ms: z.number().int().positive().optional().describe('Default 120000'),
    }),
    permissions: [{ kind: 'process.exec' }],
    executionMode: 'sequential',
    timeoutMs: 30 * 60_000,
    execute({ command, timeout_ms }, exec) {
      return new Promise<ReturnType<typeof toolOutput>>((resolveP) => {
        const isWin = process.platform === 'win32'
        const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-lc', command], {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        let killedBy: string | undefined
        const onData = (b: Buffer) => {
          const s = b.toString('utf8')
          output += s
          if (output.length > MAX_OUTPUT_CHARS * 4) output = output.slice(-MAX_OUTPUT_CHARS * 2)
          exec.onUpdate(s)
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        const kill = (why: string) => {
          killedBy = why
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 2000).unref()
        }
        const timer = setTimeout(() => kill('timeout'), timeout_ms ?? opts.bashTimeoutMs ?? 120_000)
        const onAbort = () => kill('cancelled')
        exec.signal.addEventListener('abort', onAbort, { once: true })
        child.on('error', (err) => {
          clearTimeout(timer)
          resolveP(toolOutput({ content: `Failed to start shell: ${err.message}`, isError: true }))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          exec.signal.removeEventListener('abort', onAbort)
          const tail = killedBy ? `\n[command ${killedBy === 'timeout' ? 'timed out' : 'was cancelled'}]` : `\n[exit code ${code}]`
          resolveP(toolOutput({ content: clip(output.trimEnd()) + tail, isError: killedBy !== undefined || code !== 0 }))
        })
      })
    },
  })

  const webFetchTool = defineTool({
    name: 'web_fetch',
    description: 'Fetch a URL over HTTP(S) and return its text (HTML is converted to plain text).',
    parameters: z.object({
      url: z.string().url(),
      max_chars: z.number().int().positive().optional().describe('Default 20000'),
    }),
    permissions: [{ kind: 'net.fetch' }],
    idempotent: true,
    async execute({ url, max_chars }, exec) {
      if (!/^https?:\/\//i.test(url)) return toolOutput({ content: 'Only http(s) URLs are supported', isError: true })
      const res = await fetch(url, { signal: exec.signal, redirect: 'follow', headers: { 'user-agent': 'leo-agents/0.1' } })
      const type = res.headers.get('content-type') ?? ''
      let text = await res.text()
      if (type.includes('html')) text = htmlToText(text)
      const body = clip(text.trim(), max_chars ?? 20_000)
      return toolOutput({ content: `HTTP ${res.status} ${url}\n\n${body}`, isError: !res.ok })
    },
  })

  const all = [readFileTool, writeFileTool, editFileTool, listDirTool, grepTool, bashTool, webFetchTool] as ToolDefinition[]
  return opts.tools ? all.filter((t) => opts.tools!.includes(t.name)) : all
}

/** 极简 HTML → 文本 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
}

/** 内置工具插件 */
export const builtinToolsPlugin = definePlugin<BuiltinToolsOptions | undefined>({
  name: 'leo:builtin-tools',
  inject: ['tools'],
  async apply(ctx, config) {
    for (const tool of createBuiltinTools(config ?? {})) {
      await ctx.effect(() => ctx.get('tools').register(tool))
    }
  },
})

export type ApprovalMode = 'ask' | 'auto' | 'deny'

export interface ApprovalPolicyOptions {
  /** 有副作用工具的处理方式，默认 ask */
  mode?: ApprovalMode
  /** 视为有副作用的权限类型，默认 fs.write / process.exec */
  sideEffectKinds?: string[]
}

/**
 * 审批策略插件：声明了副作用权限的工具按 mode 处理；其余放行。
 * mode=ask 时需要有人提供 `approval` 服务（CLI 交互模式会提供），否则 fail closed。
 */
export const approvalPolicy = definePlugin<ApprovalPolicyOptions | undefined>({
  name: 'leo:approval-policy',
  apply(ctx, config) {
    const mode = config?.mode ?? 'ask'
    const kinds = new Set(config?.sideEffectKinds ?? ['fs.write', 'process.exec'])
    ctx.on('tools/pre-execute', (p, next) => {
      const risky = (p.tool.permissions ?? []).some((perm) => kinds.has(perm.kind))
      if (!risky || mode === 'auto') return next(p)
      if (mode === 'deny') return { action: 'deny', reason: `Tool "${p.tool.name}" is disabled by approval policy (deny)` }
      if (!ctx.maybe('approval')) {
        return {
          action: 'deny',
          reason: `Tool "${p.tool.name}" needs user approval, but no one can approve in this mode. Tell the user to rerun with -y (or set tools.approval to "auto").`,
        }
      }
      return { action: 'ask', reason: `${p.tool.name} has side effects` }
    })
  },
})
