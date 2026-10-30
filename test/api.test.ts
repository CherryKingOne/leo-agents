import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiBridge, type BridgeHost, type BridgeMessage } from '../src/api/bridge.js'
import { attachBridge, findPython, PYTHON_DIR } from '../src/api/server.js'
import { definePlugin } from '../src/index.js'
import { setup } from './helpers.js'

const echoPlugin = definePlugin({
  name: 'echo-plugin',
  apply(ctx) {
    ctx.effect(() =>
      ctx.get('tools').register({
        name: 'echo',
        description: 'echo back',
        parameters: z.object({ text: z.string() }),
        execute: ({ text }) => `echo:${text}`,
      }),
    )
  },
})

async function host(script: Parameters<typeof setup>[0]): Promise<BridgeHost & { dispose(): Promise<void> }> {
  const { leo } = await setup(script, { plugins: [echoPlugin] })
  return {
    leo,
    model: 'mock/m',
    createAgent: (o) => leo.createAgent({ model: 'mock/m', ...o }),
    info: { version: 'test' },
    dispose: () => leo.dispose(),
  }
}

function collect(bridge: ApiBridge, method: string, params: Record<string, unknown> = {}) {
  const out: BridgeMessage[] = []
  return bridge.handle({ id: 1, method, params }, (m) => out.push(m)).then(() => out)
}

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (disposers.length) await disposers.pop()!()
})

describe('ApiBridge', () => {
  it('chat 流式事件 + 结果，并按 sessionId 续聊', async () => {
    const h = await host([{ text: '你好' }, { text: '第二轮' }])
    disposers.push(h.dispose)
    const bridge = new ApiBridge(h)
    const out = await collect(bridge, 'chat', { message: 'hi' })
    expect(out.some((m) => 'event' in m && m.event.type === 'text_delta')).toBe(true)
    const last = out.at(-1) as { result: { sessionId: string; text: string; reason: string } }
    expect(last.result.text).toBe('你好')
    expect(last.result.reason).toBe('completed')
    const again = await collect(bridge, 'chat', { message: 'again', sessionId: last.result.sessionId })
    const r2 = again.at(-1) as { result: { sessionId: string; text: string } }
    expect(r2.result.sessionId).toBe(last.result.sessionId)
    const msgs = await collect(bridge, 'sessions.messages', { sessionId: last.result.sessionId })
    expect((msgs[0] as { result: { messages: unknown[] } }).result.messages.length).toBe(4)
    await bridge.dispose()
  })

  it('直接调用插件工具、错误码', async () => {
    const h = await host([])
    disposers.push(h.dispose)
    const bridge = new ApiBridge(h)
    const [r] = await collect(bridge, 'tools.call', { name: 'echo', arguments: { text: 'x' } })
    expect((r as { result: { text: string; isError: boolean } }).result).toMatchObject({ text: 'echo:x', isError: false })
    const [nf] = await collect(bridge, 'tools.call', { name: 'nope' })
    expect((nf as { error: { code: string } }).error.code).toBe('tool_not_found')
    const [bad] = await collect(bridge, 'chat', {})
    expect((bad as { error: { code: string } }).error.code).toBe('invalid_params')
    const [um] = await collect(bridge, 'whatever')
    expect((um as { error: { code: string } }).error.code).toBe('unknown_method')
    const [info] = await collect(bridge, 'info')
    expect((info as { result: { tools: string[] } }).result.tools).toContain('echo')
  })
})

const python = findPython()

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function waitHealthy(base: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('python server did not start')
}

describe.skipIf(!python)('Python HTTP 服务（端到端）', () => {
  it('chat / SSE / OpenAI 兼容 / 工具 / 令牌', async () => {
    const h = await host([{ text: '你好' }, { text: '流式回复' }, { text: 'openai 回复' }, { text: '流' }])
    disposers.push(h.dispose)
    const bridge = new ApiBridge(h)
    const port = await freePort()
    const child = spawn(python!, ['-m', 'leo_api', '--host', '127.0.0.1', '--port', String(port)], {
      env: { ...process.env, PYTHONPATH: PYTHON_DIR, PYTHONUNBUFFERED: '1', LEO_API_TOKEN: 't0k' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const exited = attachBridge(bridge, child)
    disposers.push(async () => {
      child.kill('SIGTERM')
      await exited
      await bridge.dispose()
    })
    const base = `http://127.0.0.1:${port}`
    await waitHealthy(base)
    const auth = { Authorization: 'Bearer t0k', 'Content-Type': 'application/json' }

    expect((await fetch(`${base}/v1/info`)).status).toBe(401)

    const chat = await fetch(`${base}/v1/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'hi' }) })
    const body = (await chat.json()) as { text: string; session_id?: string; sessionId: string }
    expect(body.text).toBe('你好')

    const sse = await fetch(`${base}/v1/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'hi', session_id: body.sessionId, stream: true }) })
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    const text = await sse.text()
    expect(text).toContain('event: text_delta')
    expect(text).toContain('event: done')
    expect(text).toContain(body.sessionId)

    const oa = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'leo', messages: [{ role: 'user', content: 'yo' }] }) })
    const oaBody = (await oa.json()) as { choices: { message: { content: string } }[] }
    expect(oaBody.choices[0]!.message.content).toBe('openai 回复')

    const oas = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...auth, 'X-Session-Id': body.sessionId }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'yo' }] }) })
    const oasText = await oas.text()
    expect(oasText).toContain('"content": "流"')
    expect(oasText.trim().endsWith('data: [DONE]')).toBe(true)

    const tool = await fetch(`${base}/v1/tools/echo`, { method: 'POST', headers: auth, body: JSON.stringify({ arguments: { text: 'p' } }) })
    expect(((await tool.json()) as { text: string }).text).toBe('echo:p')

    const busyErr = await fetch(`${base}/v1/chat`, { method: 'POST', headers: auth, body: '{}' })
    expect(busyErr.status).toBe(400)
    const nf = await fetch(`${base}/v1/nope`, { headers: auth })
    expect(nf.status).toBe(404)
    const sessions = (await (await fetch(`${base}/v1/sessions`, { headers: auth })).json()) as { sessions: { sessionId: string }[] }
    expect(sessions.sessions.map((s) => s.sessionId)).toContain(body.sessionId)
  }, 20_000)
})
