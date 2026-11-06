// lib/util.js —— 跨平台小工具（全部 node 内置模块，零依赖）
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { isUtf8 } from 'node:buffer'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** ~ / ~/x / ~\x → 绝对路径；其它原样返回 */
export function expandHome(p, home = homedir()) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(home, s.slice(2))
  return s
}

/** 反斜杠统一成正斜杠 —— 快照里的 key 必须跨平台一致 */
export function toPosix(p) {
  return String(p).split(sep).join('/')
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function shortHash(text, n = 10) {
  return sha256(text).slice(0, n)
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function readJson(file, fallback = null) {
  const text = readText(file)
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 同目录 staging + fsync + rename，断电也不会留下半个文件 */
export function writeFileAtomicSync(target, text) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
}

export function writeJsonAtomicSync(target, value) {
  writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`)
}

export function mkdirp(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function exists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function fileStat(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

export function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** 只看前 8KB：有 NUL 或不是合法 UTF-8 就当二进制，不碰 */
export function looksLikeText(buf) {
  if (!buf || buf.length === 0) return true
  const truncated = buf.length > 8192
  let head = truncated ? buf.subarray(0, 8192) : buf
  // 8KB 截断可能正好把一个多字节汉字切成两半（比如 \xe4\xb8 只留下前两字节），
  // 那样 isUtf8() 会误判成二进制 —— 先退到完整的字符边界再判。
  if (truncated) head = head.subarray(0, completeUtf8End(head))
  if (head.includes(0)) return false
  return isUtf8(head)
}

function completeUtf8End(buf) {
  let end = buf.length
  let i = end - 1
  let back = 0
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) {
    i--
    back++
  }
  if (i < 0) return end
  const lead = buf[i]
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return i + need > end ? i : end
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', '.turbo', '.cache', '__pycache__'])

/**
 * 递归列出一棵目录树里的文本文件。
 * 返回 [{ abs, rel }]，rel 是相对 root 的 posix 路径。
 */
export function listTreeFiles(rootAbs, { skipDirs = SKIP_DIRS, maxFiles = 2000 } = {}) {
  const out = []
  if (!isDir(rootAbs)) return out
  const walk = (dir, relBase) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const rel = relBase ? posix.join(relBase, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.tmp') || entry.name.endsWith('.lock')) continue
        out.push({ abs: join(dir, entry.name), rel })
      }
    }
  }
  walk(rootAbs, '')
  return out
}

/** 把一个 key（~/.dsh/skills/a.md）按目标根还原成绝对路径；~/.dsh 跟随 DSH_HOME */
export function resolveKey(key, home = homedir()) {
  const s = String(key == null ? '' : key).trim()
  if (s === '~/.dsh') return resolve(dshHome())
  if (s.startsWith('~/.dsh/') || s.startsWith('~/.dsh\\')) return resolve(dshHome(), s.slice(7))
  return resolve(expandHome(s, home))
}

export function relUnder(abs, rootAbs) {
  const rel = relative(rootAbs, abs)
  if (!rel || rel.startsWith('..')) return null
  return toPosix(rel)
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** 稳定 JSON：对象键排序，保证同内容同哈希 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}
