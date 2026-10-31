/**
 * `leo api` 的内部桥：常驻的 leo 实例（插件一直在线）通过 JSON Lines 协议对外提供能力。
 * Python HTTP 服务（python/leo_api）作为子进程，通过它的 stdin/stdout 与本桥通信：
 *
 *   请求  {"id": 1, "method": "chat", "params": {...}}
 *   事件  {"id": 1, "event": {...AgentEvent}}          （仅流式方法，如 chat）
 *   结果  {"id": 1, "result": {...}}
 *   错误  {"id": 1, "error": {"code": "...", "message": "..."}}
 *
 * 协议与传输无关：handle() 只依赖一个 emit 回调，便于测试与换传输。
 */
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LeoError } from '../errors.js'
import type { Leo } from '../leo.js'
import type { Agent, AgentEvent, AgentOptions } from '../loop/types.js'
import { textOf, type ToolCallBlock } from '../protocol/messages.js'

export interface BridgeHost {
  leo: Leo
  /** 默认模型（provider/model） */
  model?: string
  /** 按默认配置创建 Agent */
  createAgent(opts?: Partial<AgentOptions>): Agent
  /** 会话目录（JSONL 持久化时），用于列出会话 */
  sessionsDir?: string
  /** 额外信息（版本、工作目录等），原样放进 info */
  info?: Record<string, unknown>
  /** 提供方状态（leo models 的数据） */
  providers?: unknown[]
}

export interface BridgeRequest {
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export type BridgeMessage =
  | { id: string | number; event: AgentEvent }
  | { id: string | number; result: unknown }
  | { id: string | number; error: { code: string; message: string } }

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

export class ApiBridge {
  /** sessionId → 常驻 Agent（同一会话的多次请求复用，保证上下文连续） */
  private readonly agents = new Map<string, Agent>()

  constructor(private readonly host: BridgeHost) {}

  /** 处理一条请求；流式事件与最终结果都通过 emit 发出，永不抛出 */
  async handle(req: BridgeRequest, emit: (m: BridgeMessage) => void): Promise<void> {
    const { id } = req
    try {
      const result = await this.dispatch(req.method, req.params ?? {}, (event) => emit({ id, event }))
      emit({ id, result })
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : e instanceof LeoError ? e.code : 'internal'
      emit({ id, error: { code, message: (e as Error).message } })
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map((a) => a.dispose()))
    this.agents.clear()
  }

  private async dispatch(method: string, p: Record<string, unknown>, onEvent: (e: AgentEvent) => void): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { pong: true }
      case 'info':
        return this.info()
      case 'models':
        return { default: this.host.model ?? null, providers: this.host.providers ?? [] }
      case 'tools':
        return { tools: this.host.leo.ctx.get('tools').schemas() }
      case 'plugins':
        return this.host.leo.describe()
      case 'sessions.list':
        return { sessions: await this.listSessions() }
      case 'sessions.messages':
        return { sessionId: this.need(p, 'sessionId'), messages: await this.host.leo.ctx.get('sessions').messages(this.need(p, 'sessionId')) }
      case 'sessions.delete':
        return this.deleteSession(this.need(p, 'sessionId'))
      case 'abort':
        return this.abort(this.need(p, 'sessionId'))
      case 'chat':
        return this.chat(p, onEvent)
      case 'tools.call':
        return this.callTool(p)
      default:
        throw new BridgeError('unknown_method', `未知方法 ${method}`)
    }
  }

  private need(p: Record<string, unknown>, key: string): string {
    const v = str(p[key])
    if (!v) throw new BridgeError('invalid_params', `缺少参数 ${key}`)
    return v
  }

  private info() {
    return {
      ...this.host.info,
      model: this.host.model ?? null,
      plugins: this.host.leo.describe().plugins.map((x) => ({ name: x.name, state: x.state })),
      tools: this.host.leo.ctx.get('tools').list().map((t) => t.name),
      activeSessions: [...this.agents.entries()].map(([sessionId, a]) => ({ sessionId, status: a.status })),
    }
  }

  private async listSessions() {
    const dir = this.host.sessionsDir
    const active = new Set(this.agents.keys())
    const out: { sessionId: string; updatedAt?: string; active: boolean }[] = []
    if (dir) {
      const files = await readdir(dir).catch(() => [] as string[])
      for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
        const sessionId = f.replace(/\.jsonl$/, '')
        const s = await stat(join(dir, f)).catch(() => undefined)
        out.push({ sessionId, ...(s ? { updatedAt: s.mtime.toISOString() } : {}), active: active.has(sessionId) })
        active.delete(sessionId)
      }
    }
    for (const sessionId of active) out.push({ sessionId, active: true })
    return out.sort((a, b) => (b.updatedAt ?? '9').localeCompare(a.updatedAt ?? '9'))
  }

  private async deleteSession(sessionId: string) {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort('session deleted')
      await agent.dispose()
      this.agents.delete(sessionId)
    }
    await this.host.leo.ctx.get('sessions').delete(sessionId)
    return { sessionId, deleted: true }
  }

  private abort(sessionId: string) {
    const agent = this.agents.get(sessionId)
    const running = agent?.status === 'running'
    if (running) agent!.abort('aborted via api')
    return { sessionId, aborted: running }
  }

  private agentFor(p: Record<string, unknown>): Agent {
    const sessionId = str(p.sessionId)
    const model = str(p.model)
    const systemPrompt = str(p.systemPrompt)
    const existing = sessionId ? this.agents.get(sessionId) : undefined
    // 模型或 system prompt 变了就换一个 Agent（历史仍从会话存储读取）
    if (existing && (!model || existing.options.model === model) && (!systemPrompt || existing.options.systemPrompt === systemPrompt)) return existing
    if (existing) {
      if (existing.status === 'running') throw new BridgeError('busy', `会话 ${sessionId} 正在运行`)
      void existing.dispose()
    }
    if (!model && !this.host.model) throw new BridgeError('no_model', '还没有可用的模型：先运行 leo auth set <provider> 或配置 .leo/config.json')
    const agent = this.host.createAgent({
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      label: 'api',
    })
    this.agents.set(agent.sessionId, agent)
    return agent
  }

  private async chat(p: Record<string, unknown>, onEvent: (e: AgentEvent) => void) {
    const message = p.message
    if (!str(message) && !Array.isArray(message)) throw new BridgeError('invalid_params', '缺少参数 message')
    const agent = this.agentFor(p)
    if (agent.status === 'running') throw new BridgeError('busy', `会话 ${agent.sessionId} 正在运行，可先调用 abort`)
    const maxSteps = typeof p.maxSteps === 'number' && p.maxSteps > 0 ? p.maxSteps : undefined
    let text = ''
    let end: Extract<AgentEvent, { type: 'turn_end' }> | undefined
    for await (const ev of agent.prompt(message as string, maxSteps ? { maxSteps } : {})) {
      onEvent(ev)
      if (ev.type === 'message' && ev.message.role === 'assistant') {
        const t = textOf(ev.message.content)
        if (t) text = t
      }
      if (ev.type === 'turn_end') end = ev
    }
    return {
      sessionId: agent.sessionId,
      text,
      reason: end?.reason ?? 'error',
      usage: end?.usage,
      steps: end?.steps ?? 0,
      ...(end?.error ? { error: end.error } : {}),
    }
  }

  private async callTool(p: Record<string, unknown>) {
    const name = this.need(p, 'name')
    const tools = this.host.leo.ctx.get('tools')
    if (!tools.get(name)) throw new BridgeError('tool_not_found', `没有工具 ${name}`)
    const args = p.arguments ?? {}
    const call: ToolCallBlock = { type: 'tool_call', id: `api_${randomUUID()}`, name, arguments: args, rawArguments: JSON.stringify(args) }
    const ac = new AbortController()
    const [r] = await tools.executeBatch([call], {
      agentId: 'api',
      sessionId: str(p.sessionId) ?? 'api',
      turnId: `api_${randomUUID()}`,
      signal: ac.signal,
      ctx: this.host.leo.ctx,
    })
    if (!r) throw new BridgeError('internal', '工具没有返回结果')
    return { name: r.name, isError: r.isError, text: textOf(r.content), content: r.content, errorCode: r.errorCode, details: r.details, durationMs: r.durationMs }
  }
}
