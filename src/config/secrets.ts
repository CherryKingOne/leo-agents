/**
 * 密钥解析与本地凭据存储。
 *
 * 配置里的密钥值支持三种写法（与 pi 的 models.json 一致）：
 *   - `"$NAME"` / `"${NAME}"`  读取环境变量
 *   - `"!command"`             执行命令取 stdout（对接 1Password / Keychain / vault 等），进程内缓存
 *   - 其他                     字面值（`$$` → `$`，`$!` → `!`）
 *
 * 凭据文件 `credentials.json`（项目 `.leo/` 与用户 `~/.leo/` 各一份）只存 `{ "<providerId>": "<key>" }`，
 * 写入时权限设为 0600，并且应加入 .gitignore。
 */
import { execSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LeoError } from '../errors.js'

const commandCache = new Map<string, string>()

/** 解析一个可能引用环境变量或命令的密钥值；解析结果为空返回 undefined */
export function resolveSecret(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim()
  if (!v) return undefined
  if (v.startsWith('$$')) return v.slice(1)
  if (v.startsWith('$!')) return v.slice(1)
  if (v.startsWith('!')) {
    const cmd = v.slice(1).trim()
    if (commandCache.has(cmd)) return commandCache.get(cmd)
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (out) commandCache.set(cmd, out)
      return out || undefined
    } catch (err) {
      throw new LeoError('auth', `Secret command failed: ${cmd}`, { cause: err })
    }
  }
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v)
  if (m) return env[m[1]!]?.trim() || undefined
  return v
}

/** 掩码显示：sk-abc…wxyz */
export function maskSecret(v: string | undefined): string {
  if (!v) return '(none)'
  if (v.length <= 8) return '****'
  return `${v.slice(0, 3)}…${v.slice(-4)}`
}

export type CredentialMap = Record<string, string>

export async function readCredentialFile(path: string): Promise<CredentialMap> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('must be a JSON object')
    const out: CredentialMap = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') out[k] = v
      else if (v && typeof v === 'object' && typeof (v as { apiKey?: unknown }).apiKey === 'string') out[k] = (v as { apiKey: string }).apiKey
    }
    return out
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new LeoError('plugin_config_invalid', `Invalid credentials file ${path}: ${(err as Error).message}`, { cause: err })
  }
}

/** 写入/删除一个凭据（value 为 undefined 表示删除），文件权限 0600 */
export async function writeCredential(path: string, providerId: string, value: string | undefined): Promise<void> {
  const data = await readCredentialFile(path)
  if (value === undefined) delete data[providerId]
  else data[providerId] = value
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/** 凭据来源，便于 `leo doctor` 诊断（永远不返回明文） */
export type CredentialSource = 'override' | 'project' | 'user' | 'config' | 'env'

export interface CredentialLookup {
  /** 提供方 id */
  id: string
  /** providers.<id>.apiKey 配置值（可为 $ENV / !cmd） */
  configured?: string
  /** 回退的环境变量名 */
  envKeys?: string[]
}

/**
 * `ctx.get('credentials')`：统一的密钥查找服务。所有 provider 插件（包括第三方）都应通过它取密钥，
 * 这样 CLI 的 `--api-key`、`.leo/credentials.json`、环境变量等来源对所有插件生效。
 *
 * 优先级：override（--api-key）> 项目 credentials.json > 用户 credentials.json > 配置 apiKey > 环境变量
 */
export interface CredentialService {
  get(lookup: CredentialLookup): string | undefined
  describe(lookup: CredentialLookup): { configured: boolean; source?: CredentialSource; masked: string }
}

export class DefaultCredentialService implements CredentialService {
  constructor(
    private readonly sources: { overrides?: CredentialMap; project?: CredentialMap; user?: CredentialMap },
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private find(l: CredentialLookup): { value: string; source: CredentialSource } | undefined {
    const tryVal = (raw: string | undefined, source: CredentialSource) => {
      const value = resolveSecret(raw, this.env)
      return value ? { value, source } : undefined
    }
    return (
      tryVal(this.sources.overrides?.[l.id], 'override') ??
      tryVal(this.sources.project?.[l.id], 'project') ??
      tryVal(this.sources.user?.[l.id], 'user') ??
      tryVal(l.configured, 'config') ??
      (l.envKeys ?? []).map((k) => tryVal(`$${k}`, 'env')).find(Boolean)
    )
  }

  get(l: CredentialLookup) {
    return this.find(l)?.value
  }

  describe(l: CredentialLookup) {
    const f = this.find(l)
    return f ? { configured: true, source: f.source, masked: maskSecret(f.value) } : { configured: false, masked: '(none)' }
  }
}
