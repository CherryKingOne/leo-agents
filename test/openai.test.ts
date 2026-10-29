import { describe, expect, it } from 'vitest'
import { createLeo, defineTool, LeoError, OpenAICompatibleProvider, z } from '../src/index.js'

function sseResponse(chunks: unknown[], init: ResponseInit = {}) {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
  const enc = new TextEncoder().encode(body)
  // 故意切成小块，测试跨块解析
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < enc.length; i += 7) controller.enqueue(enc.slice(i, i + 7))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

describe('OpenAICompatibleProvider', () => {
  it('parses text, reasoning, tool calls and usage from SSE', async () => {
    const bodies: any[] = []
    const fetchMock = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return sseResponse([
        { choices: [{ delta: { reasoning_content: '想一想' } }] },
        { choices: [{ delta: { content: '好的' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather', arguments: '{"ci' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } } },
        '[DONE]',
      ])
    }) as unknown as typeof fetch
    const p = new OpenAICompatibleProvider({ id: 'ds', baseURL: 'https://example.test/v1/', apiKey: 'k', fetch: fetchMock })
    const events = []
    for await (const e of p.stream(
      { model: 'deepseek-chat', system: 'sys', messages: [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }], tools: [{ name: 'weather', description: 'w', parameters: { type: 'object' } }], maxOutputTokens: 100 },
      { signal: new AbortController().signal },
    ))
      events.push(e)
    expect(events.map((e) => e.type)).toEqual(['reasoning_delta', 'text_delta', 'tool_call_delta', 'tool_call_delta', 'usage', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' })
    expect(events[4]).toEqual({ type: 'usage', usage: { inputTokens: 50, outputTokens: 9, cachedInputTokens: 20 } })
    expect(bodies[0]).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'weather' } }],
    })
  })

  it('maps HTTP errors to LeoError codes', async () => {
    const make = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new OpenAICompatibleProvider({
        baseURL: 'https://x.test/v1',
        fetch: (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch,
      })
    const run = async (p: OpenAICompatibleProvider) => {
      try {
        for await (const _ of p.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      } catch (e) {
        return e as LeoError
      }
      throw new Error('expected failure')
    }
    const rl = await run(make(429, { error: { message: 'slow' } }, { 'retry-after': '2' }))
    expect(rl.code).toBe('rate_limit')
    expect(rl.retryAfterMs).toBe(2000)
    expect((await run(make(429, { error: { message: 'no money', code: 'insufficient_quota' } }))).code).toBe('auth')
    expect((await run(make(401, { error: { message: 'bad key' } }))).code).toBe('auth')
    expect((await run(make(503, { error: { message: 'busy' } }))).code).toBe('overloaded')
    expect((await run(make(400, { error: { message: "This model's maximum context length is 8192 tokens" } }))).code).toBe('context_overflow')
    expect((await run(make(400, { error: { message: 'bad param' } }))).code).toBe('invalid_request')
  })

  it('maps network failures and idle timeouts', async () => {
    const net = new OpenAICompatibleProvider({
      baseURL: 'https://x.test/v1',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(
      (async () => {
        for await (const _ of net.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'network' })

    const idle = new OpenAICompatibleProvider({
      baseURL: 'https://x.test/v1',
      idleTimeoutMs: 30,
      fetch: (async (_u: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
              init.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    await expect(
      (async () => {
        for await (const _ of idle.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('drives a full agent turn end-to-end against an OpenAI-compatible endpoint', async () => {
    let call = 0
    const requests: any[] = []
    const fetchMock = (async (_u: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      call++
      if (call === 1) {
        return sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
      }
      return sseResponse([{ choices: [{ delta: { content: '答案是 5' }, finish_reason: 'stop' }] }, '[DONE]'])
    }) as unknown as typeof fetch
    const leo = await createLeo({ logLevel: 'silent', providers: [new OpenAICompatibleProvider({ id: 'local', baseURL: 'http://x/v1', fetch: fetchMock })] })
    leo.ctx.get('tools').register(
      defineTool({ name: 'add', description: '加法', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }),
    )
    const r = await leo.createAgent({ model: 'local/qwen' }).run('2+3=?')
    expect(r.text).toBe('答案是 5')
    expect(requests[0].model).toBe('qwen')
    expect(requests[0].tools[0].function.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' } } })
    expect(requests[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '5' },
    ])
  })
})
