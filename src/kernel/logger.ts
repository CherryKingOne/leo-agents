/**
 * 极简结构化日志接口。生产环境可通过 `createLeo({ logger })` 换成 pino 等实现，
 * 只要满足这四个方法即可。
 */
export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void
  info(obj: Record<string, unknown> | string, msg?: string): void
  warn(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown> | string, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

/** 默认日志：输出单行 JSON 到 stderr，便于被日志采集系统解析 */
export function createConsoleLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const write = (lvl: Exclude<LogLevel, 'silent'>, obj: Record<string, unknown> | string, msg?: string) => {
    if (ORDER[lvl] < ORDER[level]) return
    const payload = typeof obj === 'string' ? { msg: obj } : { ...obj, ...(msg ? { msg } : {}) }
    process.stderr.write(`${JSON.stringify({ level: lvl, time: new Date().toISOString(), ...bindings, ...payload }, errorReplacer)}\n`)
  }
  return {
    debug: (o, m) => write('debug', o, m),
    info: (o, m) => write('info', o, m),
    warn: (o, m) => write('warn', o, m),
    error: (o, m) => write('error', o, m),
    child: (b) => createConsoleLogger(level, { ...bindings, ...b }),
  }
}

function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return value
}
