/**
 * 解析 Server-Sent Events 流，逐个产出 `data:` 字段内容（多行 data 会用 \n 拼接）。
 * 兼容 \r\n 与 \n 换行；忽略注释行与 event/id/retry 字段。
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1))
        if (line === '') {
          if (data.length) {
            yield data.join('\n')
            data = []
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''))
    if (data.length) yield data.join('\n')
  } finally {
    reader.releaseLock()
    body.cancel().catch(() => {})
  }
}
