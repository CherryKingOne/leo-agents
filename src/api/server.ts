/**
 * `leo api`：常驻 leo 实例 + Python HTTP 服务。
 *
 * Node 进程持有 leo（插件常驻，例如 chat-channels 的长连接一直在线），
 * 启动 python/leo_api 作为子进程，双方通过子进程的 stdin/stdout 交换 JSON Lines（见 bridge.ts）。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ApiBridge, type BridgeHost, type BridgeMessage, type BridgeRequest } from './bridge.js'

export interface ApiServerOptions {
  host: string
  port: number
  /** 访问令牌；设置后请求需带 Authorization: Bearer <token> */
  token?: string
  /** Python 可执行文件，默认依次尝试 LEO_PYTHON、python3、python */
  python?: string
  log: (s: string) => void
}

/** 包内 Python 代码所在目录（dist/api → ../../python） */
export const PYTHON_DIR = fileURLToPath(new URL('../../python', import.meta.url))

export function findPython(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.LEO_PYTHON, 'python3', 'python'].filter((x): x is string => !!x)
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore' })
    if (r.status === 0) return bin
  }
  return undefined
}

/** 把桥接到一个子进程的 stdio 上；返回子进程退出的 Promise */
export function attachBridge(bridge: ApiBridge, child: ChildProcess): Promise<number> {
  const send = (m: BridgeMessage) => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(m)}\n`)
  }
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let req: BridgeRequest
    try {
      req = JSON.parse(line) as BridgeRequest
    } catch {
      return
    }
    if (req && req.id !== undefined && typeof req.method === 'string') void bridge.handle(req, send)
  })
  child.stdin?.on('error', () => {})
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))))
}

export async function runApiServer(host: BridgeHost, opts: ApiServerOptions): Promise<number> {
  const python = findPython(opts.python)
  if (!python) {
    opts.log('✗ 没找到 Python 3.9+：安装 Python，或用 --python / LEO_PYTHON 指定解释器')
    return 1
  }
  if (!existsSync(PYTHON_DIR)) {
    opts.log(`✗ 缺少 Python 服务代码：${PYTHON_DIR}`)
    return 1
  }
  const bridge = new ApiBridge(host)
  const env = {
    ...process.env,
    PYTHONPATH: [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    PYTHONUNBUFFERED: '1',
    ...(opts.token ? { LEO_API_TOKEN: opts.token } : {}),
  }
  const child = spawn(python, ['-m', 'leo_api', '--host', opts.host, '--port', String(opts.port)], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const exited = attachBridge(bridge, child)
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const code = await exited
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await bridge.dispose()
  return code
}
