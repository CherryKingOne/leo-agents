import { createInterface, type Interface } from 'node:readline/promises'
import type { Writable } from 'node:stream'

const useColor = (s: { isTTY?: boolean }) => Boolean(s.isTTY) && !process.env.NO_COLOR
const wrap = (code: number, close: number) => (t: string, stream: { isTTY?: boolean } = process.stderr) =>
  useColor(stream) ? `\x1b[${code}m${t}\x1b[${close}m` : t
export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  gray: wrap(90, 39),
}

export function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 读取一行隐藏输入（密钥） */
export async function askSecret(rl: Interface, question: string): Promise<string> {
  const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void; output: Writable }
  const orig = anyRl._writeToOutput
  let muted = false
  anyRl._writeToOutput = (s: string) => {
    if (!muted) anyRl.output.write(s)
    else if (s.includes('\n')) anyRl.output.write('\n')
  }
  const p = rl.question(question)
  muted = true
  try {
    return (await p).trim()
  } finally {
    anyRl._writeToOutput = orig
  }
}

export function makeRl(): Interface {
  return createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) })
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
