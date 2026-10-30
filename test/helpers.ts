import { createLeo, type CreateLeoOptions, MockProvider, type MockStep } from '../src/index.js'

export async function setup(script: MockStep[], opts: CreateLeoOptions = {}) {
  const mock = new MockProvider({ script, models: [{ id: 'm', contextWindow: 32_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] })
  const leo = await createLeo({ logLevel: 'silent', providers: [mock], ...opts })
  return { leo, mock }
}
