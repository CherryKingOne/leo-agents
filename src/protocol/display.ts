/**
 * 展示块：给人看、不发给模型的内容（终端、聊天平台、Web 等前端各自渲染）。
 *
 * 工具通过 ToolOutput.display、插件命令通过 CommandResult.display 返回；
 * 前端不认识的类型应忽略，并优先使用 `fallback` / `alt` 文本。
 */
export interface DisplayText {
  type: 'text'
  text: string
}

/** 终端字符画：每个元素一行，可含 ANSI 颜色转义；不支持颜色的终端显示 fallback */
export interface DisplayAnsi {
  type: 'ansi'
  lines: string[]
  fallback?: string
}

/** 图片：http(s) / data URL，或本机文件路径（`file://` / 绝对路径） */
export interface DisplayImage {
  type: 'image'
  url: string
  alt?: string
  mimeType?: string
}

export type DisplayBlock = DisplayText | DisplayAnsi | DisplayImage

/** 宽松校验：插件运行时不 import leo-agents，传进来的是普通对象 */
export function isDisplayBlocks(v: unknown): v is DisplayBlock[] {
  return (
    Array.isArray(v) &&
    v.every(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        ((b.type === 'text' && typeof b.text === 'string') ||
          (b.type === 'ansi' && Array.isArray(b.lines)) ||
          (b.type === 'image' && typeof b.url === 'string')),
    )
  )
}
