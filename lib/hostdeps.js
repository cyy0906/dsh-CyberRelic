// lib/hostdeps.js —— 从宿主那棵树里取 `@deepseek-ai/dsh-tools` 的 defineTool
// ============================================================================
// 为什么不能直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
//   桌面版 profile（autoInstallPeers: false）不会把 optional peer 装进来，
//   插件顶层裸 import 失败 ⇒ 整条插件不激活，DSH 只留一句 warning。
//   （dsh-fish-memory 1.5.x 就是踩了这个坑之后加的同样的兜底。）
//
// 策略：先沿宿主树的几个常见位置找 dsh-tools，找得到就跟宿主用同一份；
//       找不到就用本地等价实现 —— parameters / output.schema 本来就是标准
//       JSON Schema，宿主的 defineTool 主要做 spec→schema 转换和校验，
//       这里补上同样的 object/additionalProperties 校验后原样返回。
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器） */
export function candidateRoots() {
  const out = []
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const name of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', name, 'node_modules', '@deepseek-ai'))
      }
    } catch {
      /* 没有就算了 */
    }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：桌面版有时会把这些包 hoist 到 profile 根上
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch {
    /* 没有就算了 */
  }

  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : dot?.import || dot?.default || pkg.module || pkg.main
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (error) {
      fails.push(`${error?.code || 'ERR'}:${root}`)
    }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/** 拿不到宿主的 dsh-tools 时的等价实现（补同样的 object/additionalProperties 校验） */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [key, value] of Object.entries(schema.properties || {})) check(value, `${where}.properties.${key}`)
    for (const [key, value] of Object.entries(schema.items || {})) check(value, `${where}.items.${key}`)
  }
  for (const [key, schema] of Object.entries(options.parameters || {})) check(schema, `parameters.${key}`)
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`)
  return options
}

/**
 * @returns {Promise<{defineTool: Function, notes: string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (message) => notes.push(message)

  let mod = await fromHostTree('dsh-tools', log)
  if (!mod) {
    try {
      mod = await import('@deepseek-ai/dsh-tools')
      log('dsh-tools：宿主树里没有，用自己依赖里那份')
    } catch (error) {
      log(`dsh-tools 拿不到（${error?.code || ''}）—— 用本地等价实现顶上`)
      mod = null
    }
  }
  const defineTool = mod?.defineTool || ((options) => localDefineTool(options, log))
  return { defineTool, notes }
}
