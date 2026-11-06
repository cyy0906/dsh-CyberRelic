// lib/hostdeps.js —— 可选地从宿主树里拿到 `@deepseek-ai/dsh-tools`
// ============================================================================
// 背景：桌面版 profile 用 `autoInstallPeers: false`，不会替插件装 optional peer。
// 如果插件在顶层直接 `import '@deepseek-ai/dsh-tools'`，一旦宿主树里没有这个包，
// 整条插件都会激活失败（DSH 只留一行 warning）。所以这里做成"能拿到就用宿主那份，
// 拿不到就用等价实现"，绝不因为一个可选依赖把插件拖死。
//
// 拿的方式是走 Node 自己的模块解析（createRequire + 候选基准目录），
// 而不是手写死某一台机器的路径；这样 dsh 装在 AppData、/usr/local、还是自定义目录都能试到。
// ============================================================================
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const TOOLS_PACKAGE = '@deepseek-ai/dsh-tools'

function unique(list) {
  const out = []
  for (const item of list) {
    if (item && !out.includes(item)) out.push(item)
  }
  return out
}

/** 解析基准目录：从这些位置出发按 Node 规则找包（先近后远） */
function resolutionBases() {
  const bases = []

  if (process.env.DSH_HOST_MODULES) bases.push(process.env.DSH_HOST_MODULES)

  // 宿主进程自己所在的目录（桌面版通常就在 app 目录里）
  try {
    bases.push(dirname(process.execPath))
  } catch {
    /* ignore */
  }

  // dsh 家目录下的 profile 树：插件管理器把依赖装在这里
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      bases.push(join(dshHome, 'profiles', profile))
    }
  } catch {
    /* 没有 profiles 就跳过 */
  }

  // 全局 npm 的两条老路子
  const appdata = process.env.APPDATA
  if (appdata) bases.push(join(appdata, 'npm', 'node_modules'))
  bases.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')

  // 最后是插件自己（有些安装方式会把 peer 装到插件旁边）
  bases.push(process.cwd())
  return unique(bases)
}

/** 在某个基准目录下按 Node 规则解析包入口，返回 file:// URL */
function entryUrlFrom(base, name) {
  let requireFromBase
  try {
    requireFromBase = createRequire(join(base, '__dsh_resolve__.js'))
  } catch {
    return null
  }

  let pkgFile
  try {
    pkgFile = requireFromBase.resolve(`${name}/package.json`)
  } catch {
    return null
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const root = dirname(pkgFile)
    const dot = pkg.exports?.['.']
    const rel =
      typeof dot === 'string'
        ? dot
        : dot?.import || dot?.default || dot?.require || pkg.module || pkg.main || 'index.js'
    const entry = join(root, String(rel).replace(/^\.\//, ''))
    return existsSync(entry) ? pathToFileURL(entry).href : null
  } catch {
    return null
  }
}

async function importFromHost(name) {
  const tried = []
  for (const base of resolutionBases()) {
    const url = entryUrlFrom(base, name)
    if (!url) continue
    tried.push(base)
    try {
      return { module: await import(url), from: base }
    } catch {
      /* 这个位置坏了，继续试下一个 */
    }
  }
  return { module: null, from: null, tried }
}

/** 本地等价实现：宿主拿不到 dsh-tools 时，校验 schema 后原样返回工具定义 */
function makeLocalDefineTool() {
  const check = (value, where) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`工具定义里 ${where} 必须是对象`)
    }
    if (value.type === 'object' && value.additionalProperties === undefined) {
      throw new Error(`工具定义里 ${where} 是 object，但没有写 additionalProperties`)
    }
  }

  const walk = (schema, where) => {
    check(schema, where)
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, child] of Object.entries(schema.properties)) {
        walk(child, `${where}.properties.${key}`)
      }
    }
    if (schema.items) walk(schema.items, `${where}.items`)
  }

  return (options) => {
    if (options.parameters) {
      for (const [key, schema] of Object.entries(options.parameters)) {
        walk(schema, `parameters.${key}`)
      }
    }
    if (options.output?.schema) walk(options.output.schema, 'output.schema')
    return options
  }
}

let cached = null

/**
 * 取宿主依赖。返回 `{ defineTool, source, notes }`；
 * 永远不抛异常 —— 拿不到就用本地实现。
 */
export async function loadHostDeps() {
  if (cached) return cached

  const notes = []
  let defineTool = null
  let source = 'local'

  try {
    const { module, from } = await importFromHost(TOOLS_PACKAGE)
    if (module?.defineTool) {
      defineTool = module.defineTool
      source = `host:${from}`
    } else if (module?.default?.defineTool) {
      defineTool = module.default.defineTool
      source = `host:${from}`
    } else {
      notes.push(`${TOOLS_PACKAGE} 里没找到 defineTool，用本地实现`)
    }
  } catch (error) {
    notes.push(`宿主依赖解析失败：${error?.message || error}`)
  }

  if (!defineTool) defineTool = makeLocalDefineTool()

  cached = { defineTool, source, notes }
  return cached
}
