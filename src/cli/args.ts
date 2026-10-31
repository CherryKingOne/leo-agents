/** 零依赖参数解析 */
export interface CliArgs {
  command?: string
  positionals: string[]
  model?: string
  print: boolean
  yes: boolean
  continue: boolean
  session?: string
  cwd?: string
  apiKey?: string
  provider?: string
  json: boolean
  noTools: boolean
  project: boolean
  reasoning: boolean
  help: boolean
  version: boolean
  maxSteps?: number
  global: boolean
  npm: boolean
  registry?: string
  noInit: boolean
  initFrom?: string
  force: boolean
  /** plugin remove：全局和项目都卸载 */
  all: boolean
  /** plugin remove：连同初始化的配置文件一起删除 */
  purge: boolean
}

const COMMANDS = new Set(['run', 'chat', 'init', 'auth', 'models', 'doctor', 'plugin', 'plugins', 'help', 'version'])

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { positionals: [], print: false, yes: false, continue: false, json: false, noTools: false, project: false, reasoning: false, help: false, version: false, global: false, npm: false, noInit: false, force: false, all: false, purge: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    const val = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Missing value for ${t}`)
      return v
    }
    switch (t) {
      case '-m': case '--model': a.model = val(); break
      case '-p': case '--print': a.print = true; break
      case '-y': case '--yes': a.yes = true; break
      case '-c': case '--continue': a.continue = true; break
      case '-s': case '--session': a.session = val(); break
      case '--cwd': a.cwd = val(); break
      case '--api-key': a.apiKey = val(); break
      case '--provider': a.provider = val(); break
      case '--json': a.json = true; break
      case '--no-tools': a.noTools = true; break
      case '--project': case '--local': case '-l': a.project = true; break
      case '--reasoning': a.reasoning = true; break
      case '--max-steps': a.maxSteps = Number(val()); break
      case '-g': case '--global': a.global = true; break
      case '--npm': a.npm = true; break
      case '--registry': a.registry = val(); break
      case '--init': break // 兼容旧写法：现在默认就会初始化
      case '--no-init': a.noInit = true; break
      case '--init-from': a.initFrom = val(); break
      case '--force': a.force = true; break
      case '--all': a.all = true; break
      case '--purge': a.purge = true; break
      case '-h': case '--help': a.help = true; break
      case '-v': case '--version': a.version = true; break
      case '--': rest.push(...argv.slice(i + 1)); i = argv.length; break
      default:
        if (t.startsWith('-') && t.length > 1) throw new Error(`Unknown option: ${t}`)
        rest.push(t)
    }
  }
  if (rest[0] && COMMANDS.has(rest[0])) a.command = rest.shift()
  a.positionals = rest
  return a
}

export const HELP = `leo — 通用 Agent（leo-agents 底座自带的命令行）

用法
  leo                         交互式对话（在当前目录工作）
  leo "任务描述"               执行一个任务后进入交互
  leo -p "任务描述"            只执行一次就退出（适合脚本 / CI，可配合管道）
  cat log.txt | leo -p "分析这段日志"

命令
  leo init                    在当前目录创建 .leo/（配置模板、.gitignore 规则），可顺便保存密钥
  leo auth set <provider> [key] [--project]   保存密钥（默认 ~/.leo，--project 存到 ./.leo）
  leo auth list | remove <provider>
  leo models                  查看可用的提供方与默认模型
  leo doctor                  诊断：配置文件、密钥来源、插件、会话目录
  leo plugin list             查看已安装的插件（全局 / 当前项目）与官方插件仓库
  leo plugin add <id> [--project] [--no-init | --init-from <path>] [--npm]
                              安装插件。默认全局安装到 ~/.leo（所有项目可用）；--project 装到当前项目 .leo/。
                              插件带配置文件模板时自动初始化到对应 .leo/（已有文件保留），没有则跳过；
                              --no-init 不初始化，--init-from 用你提供的模板目录或文件。运行中的 leo 会自动热加载
  leo plugin init <id> [--project] [--init-from <path>] [--force]
                              给插件初始化配置文件（已存在的文件默认保留）
  leo plugin remove <id> [--project | --all] [--purge]
                              卸载插件（别名 rm / uninstall）。默认卸载全局安装；--project（--local / -l）卸载当前项目的；
                              --all 两处都卸载；--purge 连同安装时生成的配置文件一起删除（默认保留）

选项
  -m, --model <p/m>           指定模型，如 deepseek/deepseek-chat
  -y, --yes                   自动批准写文件 / 执行命令（等同 tools.approval = "auto"）
  -c, --continue              继续最近一次会话
  -s, --session <id>          继续指定会话
      --api-key <key>         本次运行使用的密钥（配合 --provider，默认作用于默认模型的提供方）
      --no-tools              不启用内置工具
      --json                  以 JSONL 输出事件流
      --reasoning             显示模型的思考过程
      --max-steps <n>         单次任务最多模型调用次数
      --cwd <dir>             工作目录
      --registry <url|path>   插件仓库地址（默认官方仓库，也可用 LEO_PLUGIN_REGISTRY）
  -l, --project, --local      leo plugin / leo auth 作用于当前项目的 .leo/（默认 ~/.leo）
  -h, --help / -v, --version

内置提供方：deepseek, openai, qwen, moonshot, zhipu, siliconflow, openrouter, ollama
（设置对应环境变量如 DEEPSEEK_API_KEY 即自动启用；其他 OpenAI 兼容端点在 .leo/config.json 中配置）

交互模式命令：/help /new /model <p/m> /models /plugins [reload] /session /exit`
