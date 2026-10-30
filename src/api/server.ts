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
  /** Python 解释器或版本：用 uv 时作为 uv --python 的值，否则作为可执行文件 */
  python?: string
  /** uv 管理的虚拟环境目录（UV_PROJECT_ENVIRONMENT），默认 ~/.leo/api/.venv */
  venvDir?: string
  log: (s: string) => void
}

export interface PythonLauncher {
  via: 'uv' | 'python'
  command: string
  /** 放在 leo_api 参数之前的参数 */
  args: string[]
  env: Record<string, string>
}

/** 包内 Python 代码所在目录（dist/api → ../../python） */
export const PYTHON_DIR = fileURLToPath(new URL('../../python', import.meta.url))

/** 要求的 Python 版本（与 python/pyproject.toml、.python-version 一致） */
export const PYTHON_VERSION = '3.12'

export function findUv(): string | undefined {
  for (const bin of [process.env.LEO_UV, 'uv'].filter((x): x is string => !!x)) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin
  }
  return undefined
}

/** 不用 uv 时的后备：找一个 Python 3.12 解释器 */
export function findPython(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.LEO_PYTHON, `python${PYTHON_VERSION}`, 'python3', 'python'].filter((x): x is string => !!x)
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)'], { stdio: 'ignore' })
    if (r.status === 0) return bin
  }
  return undefined
}

/**
 * 决定如何启动 Python 服务：优先 uv（uv run --project python/，按 pyproject 锁定 Python 3.12，
 * 虚拟环境放在 venvDir，缺 3.12 时由 uv 自动下载）；没有 uv 时退回本机的 Python 3.12。
 */
export function resolvePythonLauncher(opts: { python?: string; venvDir?: string } = {}): PythonLauncher | undefined {
  const pythonPath = [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  const base = { PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' }
  const uv = findUv()
  if (uv) {
    return {
      via: 'uv',
      command: uv,
      args: ['run', '--project', PYTHON_DIR, '--frozen', '--quiet', '--python', opts.python ?? PYTHON_VERSION, 'python', '-m', 'leo_api'],
      env: { ...base, ...(opts.venvDir ? { UV_PROJECT_ENVIRONMENT: opts.venvDir } : {}) },
    }
  }
  const python = findPython(opts.python)
  return python ? { via: 'python', command: python, args: ['-m', 'leo_api'], env: base } : undefined
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
  if (!existsSync(PYTHON_DIR)) {
    opts.log(`✗ 缺少 Python 服务代码：${PYTHON_DIR}`)
    return 1
  }
  const launcher = resolvePythonLauncher({ ...(opts.python ? { python: opts.python } : {}), ...(opts.venvDir ? { venvDir: opts.venvDir } : {}) })
  if (!launcher) {
    opts.log(`✗ 没找到 uv：leo api 用 uv 管理 Python ${PYTHON_VERSION} 环境。安装：curl -LsSf https://astral.sh/uv/install.sh | sh（或 brew install uv）`)
    return 1
  }
  if (launcher.via === 'python') opts.log(`⚠ 没找到 uv，直接使用本机 ${launcher.command}（建议安装 uv 管理 Python ${PYTHON_VERSION} 环境）`)
  const bridge = new ApiBridge(host)
  const env = { ...process.env, ...launcher.env, ...(opts.token ? { LEO_API_TOKEN: opts.token } : {}) }
  const child = spawn(launcher.command, [...launcher.args, '--host', opts.host, '--port', String(opts.port)], {
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
