/**
 * 最小的 JSONC 编辑：只改 `.leo/config.json` 顶层的 `plugins` 数组，保留其余文本（注释、格式）不动。
 * 供 `leo plugin add / remove` 使用。
 */

interface Element {
  start: number
  end: number
  /** 字符串项，或 `["spec", {...}]` 的第一个字符串 */
  spec?: string
}

interface PluginsArray {
  open: number // '[' 的位置
  close: number // ']' 的位置
  elements: Element[]
}

/** 跳过空白与注释，返回下一个有效字符位置 */
function skip(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i]!
    if (/\s/.test(ch)) i++
    else if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl + 1
    } else if (text.startsWith('/*', i)) {
      const endc = text.indexOf('*/', i + 2)
      i = endc < 0 ? text.length : endc + 2
    } else break
  }
  return i
}

/** 读一个字符串字面量，返回结束位置（不含）与值 */
function readString(text: string, i: number): { end: number; value: string } {
  let j = i + 1
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
  const raw = text.slice(i, j + 1)
  return { end: j + 1, value: JSON.parse(raw) as string }
}

/** 跳过一个任意 JSON 值，返回结束位置 */
function skipValue(text: string, i: number): number {
  const ch = text[i]
  if (ch === '"') return readString(text, i).end
  if (ch === '{' || ch === '[') {
    const closeCh = ch === '{' ? '}' : ']'
    i = skip(text, i + 1)
    while (i < text.length && text[i] !== closeCh) {
      if (ch === '{') {
        i = readString(text, i).end
        i = skip(text, i)
        i = skip(text, i + 1) // ':'
      }
      i = skip(text, skipValue(text, i))
      if (text[i] === ',') i = skip(text, i + 1)
    }
    return i + 1
  }
  let j = i
  while (j < text.length && !/[\s,\]}/]/.test(text[j]!)) j++
  return j
}

function findPlugins(text: string): PluginsArray | undefined {
  let i = skip(text, 0)
  if (text[i] !== '{') throw new Error('config must be a JSON object')
  i = skip(text, i + 1)
  while (i < text.length && text[i] !== '}') {
    const key = readString(text, i)
    i = skip(text, key.end)
    i = skip(text, i + 1) // ':'
    if (key.value === 'plugins') {
      if (text[i] !== '[') throw new Error('"plugins" must be an array')
      const open = i
      const elements: Element[] = []
      i = skip(text, i + 1)
      while (text[i] !== ']') {
        const start = i
        let spec: string | undefined
        if (text[i] === '"') spec = readString(text, i).value
        else if (text[i] === '[') {
          const k = skip(text, i + 1)
          if (text[k] === '"') spec = readString(text, k).value
        }
        const end = skipValue(text, i)
        elements.push({ start, end, ...(spec !== undefined ? { spec } : {}) })
        i = skip(text, end)
        if (text[i] === ',') i = skip(text, i + 1)
        if (i >= text.length) throw new Error('unterminated "plugins" array')
      }
      return { open, close: i, elements }
    }
    i = skip(text, skipValue(text, i))
    if (text[i] === ',') i = skip(text, i + 1)
  }
  return undefined
}

/** 列出 plugins 数组中的 spec */
export function listPluginEntries(text: string): string[] {
  return (findPlugins(text)?.elements ?? []).flatMap((e) => (e.spec !== undefined ? [e.spec] : []))
}

/** 追加一项（已存在则原样返回） */
export function addPluginEntry(text: string, spec: string, config?: unknown): string {
  const entry = config === undefined ? JSON.stringify(spec) : JSON.stringify([spec, config])
  if (!text.trim()) return `{\n  "plugins": [${entry}]\n}\n`
  const arr = findPlugins(text)
  if (!arr) {
    const brace = skip(text, 0)
    const rest = skip(text, brace + 1)
    const sep = text[rest] === '}' ? '' : ','
    return `${text.slice(0, brace + 1)}\n  "plugins": [${entry}]${sep}${text.slice(brace + 1)}`
  }
  if (arr.elements.some((e) => e.spec === spec)) return text
  const last = arr.elements[arr.elements.length - 1]
  if (!last) return `${text.slice(0, arr.open + 1)}${entry}${text.slice(arr.open + 1)}`
  return `${text.slice(0, last.end)}, ${entry}${text.slice(last.end)}`
}

/** 删除 spec 对应的项（字符串或 `[spec, config]`），找不到则原样返回 */
export function removePluginEntry(text: string, spec: string): string {
  const arr = findPlugins(text)
  if (!arr) return text
  const idx = arr.elements.findIndex((e) => e.spec === spec)
  if (idx < 0) return text
  const el = arr.elements[idx]!
  const next = arr.elements[idx + 1]
  const prev = arr.elements[idx - 1]
  if (next) return text.slice(0, el.start) + text.slice(next.start)
  if (prev) return text.slice(0, prev.end) + text.slice(el.end)
  return text.slice(0, arr.open + 1) + text.slice(arr.close)
}
