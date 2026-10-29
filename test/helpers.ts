import { createLeo, type CreateLeoOptions, MockProvider, type MockStep } from '../src/index.js'

/** 默认关闭内置提示词，便于断言 system；需要时传 prompts 覆盖 */
export async function setup(script: MockStep[], opts: CreateLeoOptions = {}) {
  const mock = new MockProvider({ script, models: [{ id: 'm', contextWindow: 32_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] })
  const leo = await createLeo({ logLevel: 'silent', providers: [mock], prompts: false, ...opts })
  return { leo, mock }
}
