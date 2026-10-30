import type { FinishReason, LlmStreamEvent } from '../llm/types.js'
import { type AgentMessage, type ContentBlock, newId, type Usage } from '../protocol/messages.js'

interface PartialCall {
  id?: string
  name?: string
  args: string
}

/** 把流式事件聚合成一条完整的 assistant 消息 */
export class StreamAccumulator {
  text = ''
  reasoning = ''
  reasoningSignature: string | undefined
  readonly calls = new Map<number, PartialCall>()
  usage: Partial<Usage> | undefined
  finishReason: FinishReason | undefined
  /** 是否已经向消费者输出过任何增量（用于决定是否发 retry 事件） */
  emitted = false

  push(ev: LlmStreamEvent) {
    switch (ev.type) {
      case 'text_delta':
        this.text += ev.text
        this.emitted = true
        break
      case 'reasoning_delta':
        this.reasoning += ev.text
        if (ev.signature) this.reasoningSignature = ev.signature
        this.emitted = true
        break
      case 'tool_call_delta': {
        const c = this.calls.get(ev.index) ?? { args: '' }
        if (ev.id) c.id = ev.id
        if (ev.name) c.name = (c.name ?? '') + (c.name && ev.name.startsWith(c.name) ? ev.name.slice(c.name.length) : ev.name)
        if (ev.argumentsDelta) c.args += ev.argumentsDelta
        this.calls.set(ev.index, c)
        this.emitted = true
        break
      }
      case 'usage':
        // usage 事件按“最后一次为准”处理（OpenAI 兼容端点在末尾给出累计值）
        this.usage = { ...this.usage, ...ev.usage }
        break
      case 'done':
        this.finishReason = ev.finishReason
        break
    }
  }

  /**
   * 生成 assistant 消息。
   * @param partial 流被中断时为 true：丢弃未完成的工具调用，只保留文本，并打上 meta.partial
   */
  toMessage(partial = false): AgentMessage {
    const content: ContentBlock[] = []
    if (this.reasoning) {
      content.push(this.reasoningSignature ? { type: 'reasoning', text: this.reasoning, signature: this.reasoningSignature } : { type: 'reasoning', text: this.reasoning })
    }
    if (this.text) content.push({ type: 'text', text: this.text })
    if (!partial) {
      for (const [, c] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!c.name) continue
        content.push({ type: 'tool_call', id: c.id ?? newId('call'), name: c.name, arguments: parseArgs(c.args), rawArguments: c.args })
      }
    }
    const msg: AgentMessage = { id: newId('msg'), role: 'assistant', content, createdAt: Date.now() }
    if (partial) msg.meta = { partial: true }
    return msg
  }
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
